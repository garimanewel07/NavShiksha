import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import { embedImage, fmtDate, newDocument, Sheet } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, assertGuardianOf, can } from './access.js';
import * as messages from './messages.js';
import * as notify from './notify.js';

/**
 * The gate. Visitors: staff expect a visitor (who gets an entry code by SMS) or the guard records a
 * walk-in; the host is told; a badge is printed; the visitor is signed out. Collecting a child
 * early: the parent names who may collect their child (with a photo and a QR card), asks for a
 * gate pass, the class teacher approves, and the guard checks the person against the photo and
 * lets the child go; the parent is told the moment the child leaves.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const today = () => localToday();
const hash = (s: string) => createHash('sha256').update(`${process.env.NES_DATA_KEY ?? 'dev'}:gate:${s}`).digest('hex');
const sandbox = () => process.env.NODE_ENV !== 'production' && process.env.NES_DEMO_LOGIN !== 'off';
const phone91 = (p?: string | null) => (p ? `+91${p.replace(/\D/g, '').slice(-10)}` : null);
const image = (b64?: string | null) => {
  if (!b64) return null;
  const d = Buffer.from(b64, 'base64');
  const h = d.subarray(0, 4).toString('hex');
  if (!(h.startsWith('ffd8') || h === '89504e47')) throw invalid('The photo must be a JPG or PNG.');
  if (d.length > 1024 * 1024) throw invalid('The photo is at most 1 MB.');
  return { data: d, type: h === '89504e47' ? 'image/png' : 'image/jpeg' };
};
const guard = (db: Db, actor: Actor, schoolId: string) => assertCan(db, actor, 'gate.manage', schoolId);

// ── Visitors ──────────────────────────────────────────────────────────────────────────────

/** A member of staff expects a visitor: the visitor gets a six-digit entry code by SMS. */
export async function expect(db: Db, actor: Actor, schoolId: string, input: { name: string; phone: string; purpose: string; organisation?: string; on: string }) {
  await assertUnitInScope(db, actor, schoolId);
  if (['PARENT', 'CANDIDATE', 'ALUMNUS', 'SUPPORT', 'DEVELOPER'].includes(actor.role)) throw forbidden();
  if (input.on < today()) throw invalid('Choose today or a later date.');
  const mobile = phone91(input.phone);
  if (!mobile || !/^\+91[6-9]\d{9}$/.test(mobile)) throw invalid('Give the visitor’s 10-digit mobile number.');
  const code = String(randomInt(100000, 1000000));
  return db.tx(async (t) => {
    const v = await t.one<{ id: string; number: string }>(
      `insert into visitor (school_id, name, phone, purpose, organisation, host_user_id, expected_on, code_hash, status, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,'EXPECTED',$6) returning id, number`,
      [schoolId, input.name.trim(), mobile, input.purpose.trim(), input.organisation?.trim() || null, actor.id, input.on, hash(code)]);
    const school = await t.one<{ name: string }>('select name from org_unit where id = $1', [schoolId]);
    await messages.queue(t, { template: 'VISITOR_CODE_SMS', to: mobile, vars: { school: school.name, date: fmtDate(input.on), code, host: actor.name }, context: 'GATE', refType: 'visitor', refId: v.number, schoolId });
    return { ...v, ...(sandbox() ? { sandboxCode: code } : {}) };
  }, { actor: actor.label });
}

async function tellHost(t: Db, v: { host_user_id: string | null; name: string; purpose: string; number: string }) {
  if (v.host_user_id) await notify.toUsers(t, [v.host_user_id], { kind: 'GATE', title: `${v.name} is at the gate`, body: `${v.purpose} · badge ${v.number}`, link: '/gate' });
}

/** The guard lets in an expected visitor by their code. */
export async function checkInByCode(db: Db, actor: Actor, schoolId: string, code: string, input: { idKind?: string; idLast4?: string; vehicleNo?: string; photoBase64?: string | null } = {}) {
  await guard(db, actor, schoolId);
  const v = await db.maybeOne<{ id: string; host_user_id: string | null; name: string; purpose: string; number: string; expected_on: string }>(
    `select id, host_user_id, name, purpose, number, expected_on::text from visitor where school_id = $1 and status = 'EXPECTED' and code_hash = $2`, [schoolId, hash(code.trim())]);
  if (!v) throw notFound('A visitor with that code');
  if (v.expected_on !== today()) throw conflict('date', `This visitor is expected on ${fmtDate(v.expected_on)}.`);
  const photo = image(input.photoBase64);
  await db.tx(async (t) => {
    await t.query(`update visitor set status = 'IN', in_at = now(), badge_no = number, id_kind = $2, id_last4 = $3, vehicle_no = $4, photo = coalesce($5, photo) where id = $1`,
      [v.id, input.idKind ?? null, input.idLast4 ?? null, input.vehicleNo ?? null, photo?.data ?? null]);
    await tellHost(t, v);
  }, { actor: actor.label });
  return { id: v.id, number: v.number, name: v.name };
}

/** The guard records a visitor who was not expected; the person they came to see is told. */
export async function walkIn(db: Db, actor: Actor, schoolId: string, input: { name: string; phone?: string; purpose: string; organisation?: string; hostUserId?: string | null; idKind?: string; idLast4?: string; vehicleNo?: string; photoBase64?: string | null }) {
  await guard(db, actor, schoolId);
  if (input.hostUserId) {
    const h = await db.maybeOne(`select 1 from app_user u join org_unit o on o.id = $2 where u.id = $1 and u.scope_path <@ o.path`, [input.hostUserId, schoolId]);
    if (!h) throw invalid('Choose a member of this school’s staff.');
  }
  const photo = image(input.photoBase64);
  return db.tx(async (t) => {
    const v = await t.one<{ id: string; number: string }>(
      `insert into visitor (school_id, name, phone, purpose, organisation, host_user_id, id_kind, id_last4, vehicle_no, photo, status, in_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IN', now(), $11) returning id, number`,
      [schoolId, input.name.trim(), phone91(input.phone), input.purpose.trim(), input.organisation?.trim() || null, input.hostUserId ?? null, input.idKind ?? null, input.idLast4 ?? null, input.vehicleNo ?? null, photo?.data ?? null, actor.id]);
    await t.query('update visitor set badge_no = number where id = $1', [v.id]);
    await tellHost(t, { host_user_id: input.hostUserId ?? null, name: input.name.trim(), purpose: input.purpose.trim(), number: v.number });
    return v;
  }, { actor: actor.label });
}

export async function checkOut(db: Db, actor: Actor, id: string) {
  const v = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from visitor where id = $1', [id]);
  if (!v) throw notFound('Visitor');
  await guard(db, actor, v.school_id);
  if (v.status !== 'IN') throw conflict('state', 'This visitor is not inside.');
  await db.tx((t) => t.query(`update visitor set status = 'OUT', out_at = now() where id = $1`, [id]), { actor: actor.label });
  return { status: 'OUT' };
}

export async function turnAway(db: Db, actor: Actor, id: string, note: string) {
  const v = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from visitor where id = $1', [id]);
  if (!v) throw notFound('Visitor');
  if (v.status === 'EXPECTED' && !(await can(db, actor, 'gate.manage', v.school_id))) {
    // The host can cancel a visit they arranged.
    const own = await db.maybeOne('select 1 from visitor where id = $1 and host_user_id = $2', [id, actor.id]);
    if (!own) throw forbidden();
  } else await guard(db, actor, v.school_id);
  await db.tx((t) => t.query(`update visitor set status = $2, note = $3 where id = $1`, [id, v.status === 'EXPECTED' ? 'CANCELLED' : 'TURNED_AWAY', note.trim() || null]), { actor: actor.label });
  return { ok: true };
}

/** The gate register for a day: who is inside, who is expected, who has left. */
export async function register(db: Db, actor: Actor, schoolId: string, on = today()) {
  const isGuard = await can(db, actor, 'gate.manage', schoolId);
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select v.id, v.number, v.name, v.phone, v.purpose, v.organisation, v.status, v.in_at, v.out_at, v.expected_on::text, v.vehicle_no, v.id_kind, v.id_last4, h.name as host, v.photo is not null as has_photo
       from visitor v left join app_user h on h.id = v.host_user_id
      where v.school_id = $1 and (v.expected_on = $2::date or (v.in_at at time zone 'Asia/Kolkata')::date = $2::date or (v.status = 'IN')) and ($3 or v.host_user_id = $4)
      order by case v.status when 'IN' then 0 when 'EXPECTED' then 1 else 2 end, coalesce(v.in_at, v.created_at) desc`, [schoolId, on, isGuard, actor.id]);
}

export async function badge(db: Db, actor: Actor, id: string) {
  const v = await db.maybeOne<{ school_id: string; number: string; name: string; purpose: string; organisation: string | null; host: string | null; in_at: string | null; photo: Buffer | null; school: string }>(
    `select v.school_id, v.number, v.name, v.purpose, v.organisation, h.name as host, v.in_at, v.photo, o.name as school from visitor v left join app_user h on h.id = v.host_user_id join org_unit o on o.id = v.school_id where v.id = $1`, [id]);
  if (!v) throw notFound('Visitor');
  await guard(db, actor, v.school_id);
  const { doc, fonts: f } = await newDocument(`Visitor ${v.number}`);
  const s = new Sheet(doc, 86, 54, f);
  s.rect(0, 0, 86, 9, { fill: [0.06, 0.18, 0.36] });
  s.text('VISITOR', 4, 2, { size: 10, font: f.bold, colour: [1, 1, 1] });
  s.text(v.school, 26, 2.6, { size: 6, colour: [1, 1, 1], maxWidth: 58, align: 'right' });
  const img = await embedImage(doc, v.photo, null);
  if (img) s.image(img, 4, 12, 20, 25); else s.rect(4, 12, 20, 25, { stroke: [0.7, 0.7, 0.7] });
  s.text(v.name, 27, 12, { size: 10, font: f.bold, maxWidth: 55 });
  s.text(v.organisation ?? '', 27, 18, { size: 7, maxWidth: 55 });
  s.text(`To meet: ${v.host ?? '—'}`, 27, 23, { size: 7, maxWidth: 55 });
  s.text(v.purpose, 27, 28, { size: 7, maxWidth: 55 });
  s.text(`${v.number} · ${v.in_at ? new Date(v.in_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''}`, 4, 41, { size: 7, font: f.mono });
  s.qr(v.number, 68, 37, 15);
  s.text('Return this badge at the gate', 4, 47, { size: 6 });
  return { name: `${v.number}.pdf`, data: Buffer.from(await doc.save()) };
}

export async function visitorPhoto(db: Db, actor: Actor, id: string) {
  const v = await db.maybeOne<{ school_id: string; photo: Buffer | null }>('select school_id, photo from visitor where id = $1', [id]);
  if (!v?.photo) throw notFound('Photo');
  await guard(db, actor, v.school_id);
  return v.photo;
}

// ── Who may collect a child ───────────────────────────────────────────────────────────────

export async function pickups(db: Db, actor: Actor, studentId: string) {
  if (actor.role === 'PARENT') await assertGuardianOf(db, actor, studentId);
  else {
    const e = await db.maybeOne<{ school_id: string }>('select school_id from enrolment where student_id = $1 and upper_inf(period)', [studentId]);
    if (!e) throw notFound('Student');
    await guard(db, actor, e.school_id);
  }
  return db.query(`select p.id, p.name, p.relation, p.phone, p.active, p.added_at, p.photo is not null as has_photo, u.name as added_by from authorised_pickup p join app_user u on u.id = p.added_by where p.student_id = $1 order by p.active desc, p.name`, [studentId]);
}

/** The parent names someone who may collect their child (a driver, a grandparent), with a photo. */
export async function addPickup(db: Db, actor: Actor, studentId: string, input: { name: string; relation: string; phone?: string; photoBase64?: string | null }) {
  await assertGuardianOf(db, actor, studentId);
  const photo = image(input.photoBase64);
  if (!photo) throw invalid('Add a clear photo of the person; the guard checks it at the gate.');
  return db.tx((t) => t.one<{ id: string }>(`insert into authorised_pickup (student_id, name, relation, phone, photo, photo_type, token, added_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [studentId, input.name.trim(), input.relation.trim(), phone91(input.phone), photo.data, photo.type, `PU${randomBytes(9).toString('base64url')}`, actor.id]), { actor: actor.label });
}

export async function removePickup(db: Db, actor: Actor, id: string) {
  const p = await db.maybeOne<{ student_id: string }>('select student_id from authorised_pickup where id = $1', [id]);
  if (!p) throw notFound('Person');
  await assertGuardianOf(db, actor, p.student_id);
  await db.tx((t) => t.query('update authorised_pickup set active = false where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

/** The pickup card the parent gives to the person: photo, the child, and a QR the guard scans. */
export async function pickupCard(db: Db, actor: Actor, id: string) {
  const p = await db.maybeOne<{ student_id: string; name: string; relation: string; token: string; photo: Buffer; photo_type: string; child: string; school: string; active: boolean }>(
    `select p.student_id, p.name, p.relation, p.token, p.photo, p.photo_type, s.name as child, o.name as school, p.active from authorised_pickup p join student s on s.id = p.student_id
       join enrolment e on e.student_id = s.id and upper_inf(e.period) join org_unit o on o.id = e.school_id where p.id = $1`, [id]);
  if (!p) throw notFound('Person');
  await assertGuardianOf(db, actor, p.student_id);
  if (!p.active) throw conflict('inactive', 'This person can no longer collect the child.');
  const { doc, fonts: f } = await newDocument(`Pickup card · ${p.child}`);
  const s = new Sheet(doc, 86, 54, f);
  s.rect(0, 0, 86, 9, { fill: [0.06, 0.18, 0.36] });
  s.text('AUTHORISED TO COLLECT', 4, 2.4, { size: 8, font: f.bold, colour: [1, 1, 1] });
  const img = await embedImage(doc, p.photo, p.photo_type);
  if (img) s.image(img, 4, 12, 20, 25);
  s.text(p.name, 27, 12, { size: 10, font: f.bold, maxWidth: 37 });
  s.text(p.relation, 27, 18, { size: 7.5, maxWidth: 37 });
  s.text(`Child: ${p.child}`, 27, 24, { size: 7.5, maxWidth: 37 });
  s.text(p.school, 27, 30, { size: 6, maxWidth: 37 });
  s.qr(p.token, 66, 12, 17);
  s.text('Show this card at the school gate with a gate pass.', 4, 44, { size: 6, maxWidth: 78 });
  return { name: `pickup-card-${p.name.replace(/\W+/g, '-')}.pdf`, data: Buffer.from(await doc.save()) };
}

export async function pickupPhoto(db: Db, actor: Actor, id: string) {
  const p = await db.maybeOne<{ student_id: string; photo: Buffer; photo_type: string; school_id: string }>(
    `select p.student_id, p.photo, p.photo_type, e.school_id from authorised_pickup p join enrolment e on e.student_id = p.student_id and upper_inf(e.period) where p.id = $1`, [id]);
  if (!p) throw notFound('Photo');
  if (actor.role === 'PARENT') await assertGuardianOf(db, actor, p.student_id); else await guard(db, actor, p.school_id);
  return { data: p.photo, type: p.photo_type };
}

// ── Gate passes ───────────────────────────────────────────────────────────────────────────

async function classTeachersOf(t: Db, studentId: string) {
  return t.query<{ id: string }>(`select ct.user_id as id from enrolment e join class_teacher ct on ct.section_id = e.section_id and ct.valid @> current_date where e.student_id = $1 and upper_inf(e.period)`, [studentId]);
}

/** The parent asks for their child to leave early, and says who will collect them. */
export async function requestPass(db: Db, actor: Actor, studentId: string, input: { on: string; leaveAt: string; reason: string; pickupId?: string | null }) {
  await assertGuardianOf(db, actor, studentId);
  if (input.on < today()) throw invalid('Choose today or a later date.');
  if (input.pickupId) {
    const p = await db.maybeOne<{ student_id: string; active: boolean }>('select student_id, active from authorised_pickup where id = $1', [input.pickupId]);
    if (!p || p.student_id !== studentId || !p.active) throw invalid('Choose one of the people you have named for this child.');
  }
  const e = await db.one<{ school_id: string; name: string }>(`select e.school_id, s.name from enrolment e join student s on s.id = e.student_id where e.student_id = $1 and upper_inf(e.period)`, [studentId]);
  return db.tx(async (t) => {
    const g = await t.one<{ id: string; number: string }>(`insert into gate_pass (school_id, student_id, on_date, leave_at, reason, pickup_id, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, number`,
      [e.school_id, studentId, input.on, input.leaveAt, input.reason.trim(), input.pickupId ?? null, actor.id]);
    await notify.toUsers(t, (await classTeachersOf(t, studentId)).map((c) => c.id), { kind: 'GATE', title: `Gate pass: ${e.name}`, body: `To leave at ${input.leaveAt} on ${fmtDate(input.on)}: ${input.reason.trim()}`, link: '/gate-passes' });
    return g;
  }, { actor: actor.label });
}

/** Gate passes waiting for this teacher (the class teacher or co-class teacher), or all of the school's for the principal. */
export async function passesToDecide(db: Db, actor: Actor, schoolId?: string) {
  return db.query(
    `select g.id, g.number, g.on_date::text, g.leave_at::text, g.reason, g.status, s.name as student, e.class_code || '-' || sec.name as class, p.name as pickup, p.relation, r.name as requested_by
       from gate_pass g join student s on s.id = g.student_id join enrolment e on e.student_id = s.id and upper_inf(e.period) left join section sec on sec.id = e.section_id
       left join authorised_pickup p on p.id = g.pickup_id join app_user r on r.id = g.requested_by
      where g.status = 'REQUESTED' and g.on_date >= current_date
        and (exists (select 1 from class_teacher ct where ct.section_id = e.section_id and ct.user_id = $1 and ct.valid @> current_date)
             or ($2::uuid is not null and g.school_id = $2 and $3))
      order by g.on_date, g.leave_at`, [actor.id, schoolId ?? null, actor.role === 'SCHOOL_ADMIN']);
}

export async function decidePass(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  const g = await db.maybeOne<{ school_id: string; student_id: string; status: string; requested_by: string; number: string; leave_at: string; on_date: string; student: string }>(
    `select g.school_id, g.student_id, g.status, g.requested_by, g.number, g.leave_at::text, g.on_date::text, s.name as student from gate_pass g join student s on s.id = g.student_id where g.id = $1`, [id]);
  if (!g) throw notFound('Gate pass');
  const ct = (await classTeachersOf(db, g.student_id)).some((c) => c.id === actor.id);
  if (!ct && !(actor.role === 'SCHOOL_ADMIN' && (await can(db, actor, 'overview.view', g.school_id)))) throw forbidden('The class teacher or the principal decides gate passes.');
  if (g.status !== 'REQUESTED') throw conflict('decided', 'Already decided.');
  if (!approve && !note?.trim()) throw invalid('Give the reason.');
  await db.tx(async (t) => {
    await t.query(`update gate_pass set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note?.trim() || null]);
    await notify.toUsers(t, [g.requested_by], { kind: 'GATE', title: `Gate pass ${approve ? 'approved' : 'not approved'}: ${g.student.split(' ')[0]}`, body: approve ? `${g.number}: at the gate at ${g.leave_at.slice(0, 5)} on ${fmtDate(g.on_date)}. The guard checks the person collecting against the photo.` : note!.trim(), link: '/gate-pass' }, g.student_id);
  }, { actor: actor.label });
  return { status: approve ? 'APPROVED' : 'REJECTED' };
}

/** The guard's list for today: approved passes, with who may collect each child. */
export async function passesToday(db: Db, actor: Actor, schoolId: string) {
  await guard(db, actor, schoolId);
  return db.query(
    `select g.id, g.number, g.leave_at::text, g.reason, g.status, g.left_at, s.id as student_id, s.name as student, e.class_code || '-' || sec.name as class,
            g.pickup_id, p.name as pickup, p.relation, coalesce(r.name, '') as parent
       from gate_pass g join student s on s.id = g.student_id join enrolment e on e.student_id = s.id and upper_inf(e.period) left join section sec on sec.id = e.section_id
       left join authorised_pickup p on p.id = g.pickup_id left join app_user r on r.id = g.requested_by
      where g.school_id = $1 and g.on_date = current_date and g.status in ('APPROVED', 'LEFT') order by g.leave_at`, [schoolId]);
}

/**
 * The guard scans the pickup card (or types the gate pass number): NavShiksha shows the child and
 * the person's photo, and only a pass approved for today with that person matches.
 */
export async function verify(db: Db, actor: Actor, schoolId: string, code: string) {
  await guard(db, actor, schoolId);
  const c = code.trim();
  const rows = await db.query<{ id: string; number: string; student: string; class: string; pickup: string | null; relation: string | null; pickup_id: string | null; status: string; leave_at: string }>(
    `select g.id, g.number, s.name as student, e.class_code || '-' || coalesce(sec.name, '') as class, p.name as pickup, p.relation, g.pickup_id, g.status, g.leave_at::text
       from gate_pass g join student s on s.id = g.student_id join enrolment e on e.student_id = s.id and upper_inf(e.period) left join section sec on sec.id = e.section_id
       left join authorised_pickup p on p.id = g.pickup_id
      where g.school_id = $1 and g.on_date = current_date and g.status in ('APPROVED', 'LEFT') and (g.number = upper($2) or (p.token = $2 and p.active))`, [schoolId, c]);
  if (!rows.length) {
    const known = await db.maybeOne<{ name: string; child: string }>(`select p.name, s.name as child from authorised_pickup p join student s on s.id = p.student_id where p.token = $1 and p.active`, [c]);
    throw notFound(known ? `An approved gate pass today for ${known.child} with ${known.name}` : 'A gate pass or pickup card with that code');
  }
  return rows;
}

export async function letGo(db: Db, actor: Actor, id: string) {
  const g = await db.maybeOne<{ school_id: string; student_id: string; status: string; on_date: string; pickup: string | null; requested_by: string; student: string }>(
    `select g.school_id, g.student_id, g.status, g.on_date::text, p.name as pickup, g.requested_by, s.name as student from gate_pass g join student s on s.id = g.student_id left join authorised_pickup p on p.id = g.pickup_id where g.id = $1`, [id]);
  if (!g) throw notFound('Gate pass');
  await guard(db, actor, g.school_id);
  if (g.status !== 'APPROVED') throw conflict('state', g.status === 'LEFT' ? 'This child has already left.' : 'This gate pass is not approved.');
  if (g.on_date !== today()) throw conflict('date', 'This gate pass is for another day.');
  await db.tx(async (t) => {
    await t.query(`update gate_pass set status = 'LEFT', verified_by = $2, left_at = now() where id = $1`, [id, actor.id]);
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    await notify.toParentsOf(t, [g.student_id], { kind: 'GATE', title: `${g.student.split(' ')[0]} has left school`, body: `At ${time}, with ${g.pickup ?? 'the parent who asked'}.`, link: '/gate-pass' });
  }, { actor: actor.label });
  return { status: 'LEFT' };
}

export async function myPasses(db: Db, actor: Actor, studentId: string) {
  await assertGuardianOf(db, actor, studentId);
  return db.query(`select g.id, g.number, g.on_date::text, g.leave_at::text, g.reason, g.status, g.decision_note, g.left_at, p.name as pickup from gate_pass g left join authorised_pickup p on p.id = g.pickup_id
                    where g.student_id = $1 order by g.on_date desc, g.leave_at desc limit 30`, [studentId]);
}

export async function cancelPass(db: Db, actor: Actor, id: string) {
  const g = await db.maybeOne<{ student_id: string; status: string }>('select student_id, status from gate_pass where id = $1', [id]);
  if (!g) throw notFound('Gate pass');
  await assertGuardianOf(db, actor, g.student_id);
  if (!['REQUESTED', 'APPROVED'].includes(g.status)) throw conflict('state', 'This gate pass can no longer be cancelled.');
  await db.tx((t) => t.query(`update gate_pass set status = 'CANCELLED' where id = $1`, [id]), { actor: actor.label });
  return { status: 'CANCELLED' };
}

export const isUuid = (s: string) => UUID.test(s);
