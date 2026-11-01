import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/client.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { fmtDate } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';
import * as messages from './messages.js';
import * as notify from './notify.js';

/**
 * Alumni of Navy Children Schools. A former pupil registers with their school (email and mobile
 * confirmed by codes). If the school's own records show them (same name and date of birth, and they
 * have left), they are verified at once; otherwise the alumni coordinator checks them. Verified
 * alumni who agree are listed in their school's directory, and receive the school's newsletters and
 * reunion invitations (by email), with replies counted.
 */

const sandbox = () => process.env.NODE_ENV !== 'production' && process.env.NES_DEMO_LOGIN !== 'off';
const normal = (d: string) => (d.includes('@') ? d.trim().toLowerCase() : `+91${d.replace(/\D/g, '').slice(-10)}`);
const hashCode = (dest: string, code: string) => createHash('sha256').update(`${process.env.NES_DATA_KEY ?? 'dev'}:${dest}:${code}`).digest('hex');

/** Schools to choose from when registering (every Navy Children School and Kindergarten). */
export async function schools(db: Db) {
  return db.query(`select id, name from org_unit where kind = 'school' and active order by name`);
}

export async function requestCode(db: Db, input: { destination: string; purpose: 'ALUMNI_REGISTER' | 'ALUMNI_LOGIN' }) {
  const dest = normal(input.destination);
  if (dest.includes('@') ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest) : !/^\+91[6-9]\d{9}$/.test(dest)) throw invalid('Give a valid email address or 10-digit mobile number.');
  const recent = await db.one<{ n: number }>(`select count(*)::int as n from candidate_otp where destination = $1 and created_at > now() - interval '15 minutes'`, [dest]);
  if (recent.n >= 3) throw new AppError(429, 'slow_down', 'Too many codes asked for. Please wait a few minutes.');
  const known = await db.maybeOne(dest.includes('@') ? 'select 1 from alumnus where lower(email) = $1' : 'select 1 from alumnus where mobile = $1', [dest]);
  if (input.purpose === 'ALUMNI_LOGIN' && !known) throw notFound('An alumni registration with this email or mobile');
  const code = String(randomInt(100000, 1000000));
  await db.tx(async (t) => {
    await t.query(`insert into candidate_otp (destination, purpose, code_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`, [dest, input.purpose, hashCode(dest, code)]);
    await messages.queue(t, { template: dest.includes('@') ? 'OTP_EMAIL' : 'OTP_SMS', to: dest, vars: { code }, context: 'ALUMNI' });
  }, { actor: 'alumni' });
  return { sent: true, ...(sandbox() ? { sandboxCode: code } : {}) };
}

async function checkCode(t: Db, destination: string, purpose: string, code: string) {
  const dest = normal(destination);
  const o = await t.maybeOne<{ id: number; code_hash: string; attempts: number }>(
    `select id, code_hash, attempts from candidate_otp where destination = $1 and purpose = $2 and used_at is null and expires_at > now() order by id desc limit 1`, [dest, purpose]);
  if (!o) throw invalid('The code has expired. Ask for a new one.');
  if (o.attempts >= 5) throw invalid('Too many wrong tries. Ask for a new code.');
  if (o.code_hash !== hashCode(dest, code.trim())) { await t.query('update candidate_otp set attempts = attempts + 1 where id = $1', [o.id]); throw invalid('That code is not right.'); }
  await t.query('update candidate_otp set used_at = now() where id = $1', [o.id]);
  return dest;
}

const session = async (t: Db, userId: string) => {
  const token = randomBytes(24).toString('base64url');
  await t.query(`insert into app_session (token, user_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [token, userId]);
  return token;
};

export interface AlumniInput { schoolId: string; name: string; email: string; mobile: string; dob?: string | null; leftYear: number; lastClass?: string; city?: string; occupation?: string; organisation?: string; inDirectory?: boolean; emailCode: string; mobileCode: string }

/** Registers a former pupil. A match in the school's records (same name and date of birth, left the school) verifies them at once. */
export async function register(db: Db, input: AlumniInput) {
  const school = await db.maybeOne<{ name: string }>(`select name from org_unit where id = $1 and kind = 'school'`, [input.schoolId]);
  if (!school) throw invalid('Choose your school.');
  if (input.leftYear > new Date().getFullYear()) throw invalid('Give the year you left the school.');
  return db.tx(async (t) => {
    const email = await checkCode(t, input.email, 'ALUMNI_REGISTER', input.emailCode);
    const mobile = await checkCode(t, input.mobile, 'ALUMNI_REGISTER', input.mobileCode);
    if (await t.maybeOne('select 1 from alumnus where school_id = $1 and lower(email) = $2', [input.schoolId, email])) throw conflict('registered', 'You are already registered with this school. Sign in instead.');
    const match = input.dob ? await t.maybeOne<{ id: string }>(
      `select s.id from student s join enrolment e on e.student_id = s.id where e.school_id = $1 and lower(s.name) = lower($2) and s.dob = $3::date and e.status in ('COMPLETED', 'WITHDRAWN', 'TRANSFERRED_OUT')
        and not exists (select 1 from enrolment x where x.student_id = s.id and upper_inf(x.period)) limit 1`, [input.schoolId, input.name.trim(), input.dob]) : null;
    const a = await t.one<{ id: string; number: string }>(
      `insert into alumnus (school_id, student_id, name, email, mobile, dob, left_year, last_class, city, occupation, organisation, in_directory, status, verified_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, case when $2::uuid is not null then now() end, $14) returning id, number`,
      [input.schoolId, match?.id ?? null, input.name.trim(), email, mobile, input.dob ?? null, input.leftYear, input.lastClass?.trim() || null, input.city?.trim() || null, input.occupation?.trim() || null,
       input.organisation?.trim() || null, !!input.inDirectory, match ? 'VERIFIED' : 'PENDING', match ? 'Matched to the school’s records' : null]);
    const u = await t.one<{ id: string }>(`insert into app_user (name, role, designation, alumnus_id, email) values ($1, 'ALUMNUS', $2, $3, $4) returning id`, [input.name.trim(), `Alumnus, ${school.name}`, a.id, email]);
    if (!match) {
      const coord = await t.query<{ id: string }>(`select user_id as id from duty where school_id = $1 and code = 'ALUMNI_COORDINATOR' and valid @> current_date
                                                  union select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [input.schoolId]);
      await notify.toUsers(t, coord.map((c) => c.id), { kind: 'ALUMNI', title: `${input.name.trim()} registered as an alumnus`, body: `Left in ${input.leftYear}; to be checked.`, link: '/alumni-desk' });
    }
    return { token: await session(t, u.id), number: a.number, verified: !!match };
  }, { actor: 'alumni' });
}

export async function login(db: Db, input: { destination: string; code: string }) {
  return db.tx(async (t) => {
    const dest = await checkCode(t, input.destination, 'ALUMNI_LOGIN', input.code);
    const u = await t.one<{ id: string }>(`select u.id from app_user u join alumnus a on a.id = u.alumnus_id where ${dest.includes('@') ? 'lower(a.email) = $1' : 'a.mobile = $1'} order by a.created_at limit 1`, [dest]);
    return { token: await session(t, u.id) };
  }, { actor: 'alumni' });
}

async function me(db: Db, actor: Actor) {
  if (actor.role !== 'ALUMNUS') throw forbidden('Sign in as an alumnus.');
  return db.one<{ id: string; school_id: string; status: string; left_year: number }>('select a.id, a.school_id, a.status, a.left_year from app_user u join alumnus a on a.id = u.alumnus_id where u.id = $1', [actor.id]);
}

export async function profile(db: Db, actor: Actor) {
  const m = await me(db, actor);
  return db.one(`select a.number, a.name, a.email, a.mobile, a.dob::text, a.left_year, a.last_class, a.city, a.occupation, a.organisation, a.in_directory, a.status, o.name as school
                   from alumnus a join org_unit o on o.id = a.school_id where a.id = $1`, [m.id]);
}

export async function updateProfile(db: Db, actor: Actor, input: { city?: string; occupation?: string; organisation?: string; inDirectory?: boolean }) {
  const m = await me(db, actor);
  await db.tx((t) => t.query(`update alumnus set city = coalesce($2, city), occupation = coalesce($3, occupation), organisation = coalesce($4, organisation), in_directory = coalesce($5, in_directory) where id = $1`,
    [m.id, input.city?.trim() ?? null, input.occupation?.trim() ?? null, input.organisation?.trim() ?? null, input.inDirectory ?? null]), { actor: actor.label });
  return profile(db, actor);
}

/** Verified alumni of the same school who agreed to be listed (contact details are never shown). */
export async function directory(db: Db, actor: Actor, q: { year?: number; search?: string }) {
  const m = await me(db, actor);
  if (m.status !== 'VERIFIED') throw forbidden('The directory opens once the school has verified you.');
  return db.query(`select name, left_year, last_class, city, occupation, organisation from alumnus where school_id = $1 and status = 'VERIFIED' and in_directory
                    and ($2::int is null or left_year = $2) and ($3::text is null or name ilike '%' || $3 || '%' or organisation ilike '%' || $3 || '%' or city ilike '%' || $3 || '%') order by left_year desc, name limit 500`,
    [m.school_id, q.year ?? null, q.search?.trim() || null]);
}

export async function myEvents(db: Db, actor: Actor) {
  const m = await me(db, actor);
  if (m.status !== 'VERIFIED') return [];
  return db.query(`select e.id, e.title, e.kind, e.on_date::text, e.venue, e.body, e.sent_at, r.answer, r.guests from alumni_event e left join alumni_rsvp r on r.event_id = e.id and r.alumnus_id = $2
                    where e.school_id = $1 and e.sent_at is not null and (cardinality(e.batches) = 0 or $3 = any(e.batches)) order by coalesce(e.on_date, e.created_at::date) desc`, [m.school_id, m.id, m.left_year]);
}

export async function rsvp(db: Db, actor: Actor, eventId: string, input: { answer: 'YES' | 'NO' | 'MAYBE'; guests?: number }) {
  const m = await me(db, actor);
  const e = await db.maybeOne<{ school_id: string; kind: string; on_date: string | null }>('select school_id, kind, on_date::text from alumni_event where id = $1 and sent_at is not null', [eventId]);
  if (!e || e.school_id !== m.school_id) throw notFound('Event');
  if (e.kind === 'NEWSLETTER') throw invalid('A newsletter needs no reply.');
  await db.tx((t) => t.query(`insert into alumni_rsvp (event_id, alumnus_id, answer, guests) values ($1,$2,$3,$4) on conflict (event_id, alumnus_id) do update set answer = excluded.answer, guests = excluded.guests, at = now()`,
    [eventId, m.id, input.answer, input.guests ?? 0]), { actor: actor.label });
  return { ok: true };
}

// ── The school ────────────────────────────────────────────────────────────────────────────

export async function list(db: Db, actor: Actor, schoolId: string, q: { status?: string; year?: number; search?: string }) {
  await assertCan(db, actor, 'alumni.manage', schoolId);
  return db.query(
    `select a.id, a.number, a.name, a.email, a.mobile, a.dob::text, a.left_year, a.last_class, a.city, a.occupation, a.organisation, a.in_directory, a.status, a.note, a.created_at, s.nes_id as matched_record, v.name as verified_by
       from alumnus a left join student s on s.id = a.student_id left join app_user v on v.id = a.verified_by
      where a.school_id = $1 and ($2::text is null or a.status = $2) and ($3::int is null or a.left_year = $3) and ($4::text is null or a.name ilike '%' || $4 || '%' or a.email ilike '%' || $4 || '%')
      order by case a.status when 'PENDING' then 0 else 1 end, a.left_year desc, a.name limit 1000`, [schoolId, q.status || null, q.year ?? null, q.search?.trim() || null]);
}

/** Former pupils in the school's records whose name is like the alumnus's (for the coordinator to match). */
export async function candidates(db: Db, actor: Actor, alumnusId: string) {
  const a = await db.maybeOne<{ school_id: string; name: string }>('select school_id, name from alumnus where id = $1', [alumnusId]);
  if (!a) throw notFound('Alumnus');
  await assertCan(db, actor, 'alumni.manage', a.school_id);
  const first = a.name.split(/\s+/)[0];
  return db.query(`select distinct s.id, s.name, s.dob::text, s.nes_id, max(e.class_code) as last_class, max(upper(e.period))::text as left_on from student s join enrolment e on e.student_id = s.id
                    where e.school_id = $1 and not upper_inf(e.period) and s.name ilike '%' || $2 || '%' group by s.id, s.name, s.dob, s.nes_id order by s.name limit 20`, [a.school_id, first]);
}

export async function verify(db: Db, actor: Actor, alumnusId: string, input: { approve: boolean; studentId?: string | null; note?: string }) {
  const a = await db.maybeOne<{ school_id: string; status: string; name: string; email: string }>('select school_id, status, name, email from alumnus where id = $1', [alumnusId]);
  if (!a) throw notFound('Alumnus');
  await assertCan(db, actor, 'alumni.manage', a.school_id);
  if (a.status !== 'PENDING') throw conflict('decided', 'Already decided.');
  if (!input.approve && !input.note?.trim()) throw invalid('Give the reason.');
  if (input.studentId && !(await db.maybeOne('select 1 from enrolment where student_id = $1 and school_id = $2', [input.studentId, a.school_id]))) throw invalid('That record is not of this school.');
  await db.tx(async (t) => {
    await t.query(`update alumnus set status = $2, student_id = coalesce($3, student_id), verified_by = $4, verified_at = now(), note = $5 where id = $1`, [alumnusId, input.approve ? 'VERIFIED' : 'REJECTED', input.studentId ?? null, actor.id, input.note?.trim() || null]);
    await messages.queue(t, { template: 'ALUMNI_STATUS_EMAIL', to: a.email, vars: { name: a.name, status: input.approve ? 'verified' : 'not verified', note: input.note?.trim() ?? '' }, context: 'ALUMNI', refType: 'alumnus', refId: alumnusId, schoolId: a.school_id });
  }, { actor: actor.label });
  return { status: input.approve ? 'VERIFIED' : 'REJECTED' };
}

export async function events(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'alumni.manage', schoolId);
  return db.query(`select e.id, e.title, e.kind, e.on_date::text, e.venue, e.body, e.batches, e.sent_at, e.created_at,
                          (select jsonb_object_agg(answer, n) from (select answer, sum(1 + guests)::int as n from alumni_rsvp r where r.event_id = e.id group by answer) x) as replies
                     from alumni_event e where e.school_id = $1 order by e.created_at desc`, [schoolId]);
}

/** A reunion, talk or newsletter, sent by email to the verified alumni of the chosen batches (or all). */
export async function sendEvent(db: Db, actor: Actor, schoolId: string, input: { title: string; kind: 'REUNION' | 'NEWSLETTER' | 'TALK' | 'OTHER'; onDate?: string | null; venue?: string; body: string; batches?: number[] }) {
  await assertCan(db, actor, 'alumni.manage', schoolId);
  if (input.body.trim().length < 10) throw invalid('Write the message.');
  return db.tx(async (t) => {
    const e = await t.one<{ id: string }>(`insert into alumni_event (school_id, title, kind, on_date, venue, body, batches, sent_at, created_by) values ($1,$2,$3,$4,$5,$6,$7, now(), $8) returning id`,
      [schoolId, input.title.trim(), input.kind, input.onDate ?? null, input.venue?.trim() || null, input.body.trim(), input.batches ?? [], actor.id]);
    const to = await t.query<{ name: string; email: string }>(`select name, email from alumnus where school_id = $1 and status = 'VERIFIED' and ($2::smallint[] = '{}' or left_year = any($2))`, [schoolId, input.batches ?? []]);
    const school = (await t.one<{ name: string }>('select name from org_unit where id = $1', [schoolId])).name;
    const n = await messages.queueMany(t, to.map((a) => ({ template: 'ALUMNI_EVENT_EMAIL', to: a.email, vars: { name: a.name, title: input.title.trim(), school, when: input.onDate ? `${fmtDate(input.onDate)}${input.venue ? `, ${input.venue}` : ''}\n\n` : '', body: input.body.trim() } })),
      { context: 'ALUMNI', refType: 'alumni_event', schoolId, createdBy: actor.id });
    return { id: e.id, sent: n };
  }, { actor: actor.label });
}
