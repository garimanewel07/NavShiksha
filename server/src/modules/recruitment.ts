import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/client.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import { last4, seal } from '../lib/secret.js';
import type { Actor } from './auth.js';
import { assertCan, can } from './access.js';
import { post, signed } from './ledger.js';
import * as messages from './messages.js';
import * as notify from './notify.js';

/**
 * Recruitment for every Navy Children School and Navy Kindergarten.
 *
 * A candidate registers once (verified by codes sent to their email and mobile) and keeps one
 * profile for life: education, CTET/TET, experience, documents. To apply for any school's vacancy
 * they only check that they are eligible (the system shows each rule and why), confirm the
 * declaration, and pay that school's fee. The application keeps a copy of the profile as it was.
 *
 * Schools filter and sort applications on indexed columns (a lakh of them is fine), act on one or
 * on a whole filtered set at once, and every stage tells the candidate by email and SMS.
 */

const PUBLIC_URL = () => process.env.PUBLIC_URL ?? 'http://localhost:5173';
const UUID = /^[0-9a-f-]{36}$/i;
const sandbox = () => process.env.NODE_ENV !== 'production' && process.env.NES_DEMO_LOGIN !== 'off';
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;

export const CATEGORIES: Record<string, string> = { GEN: 'General', OBC: 'OBC (non-creamy layer)', SC: 'SC', ST: 'ST', EWS: 'EWS' };
export const LEVELS: Record<string, string> = {
  SECONDARY: 'Class X', SR_SECONDARY: 'Class XII', DIPLOMA: 'Diploma', GRADUATION: 'Graduation', POST_GRADUATION: 'Post-graduation', BED: 'B.Ed.', DELED: 'D.El.Ed.',
  NTT: 'Nursery teacher training / ECCE', MED: 'M.Ed.', MPHIL: 'M.Phil.', PHD: 'Ph.D.', OTHER: 'Other',
};

// ── Eligibility ───────────────────────────────────────────────────────────────────────────

export interface Rules {
  education?: { levels: string[]; subjects?: string[]; minPct?: number; label?: string }[];   // all of these, each met by any listed level
  tests?: { kind: string; paper?: string }[];                                                  // any one of these
  age?: { min?: number; max?: number; relax?: Partial<Record<'OBC' | 'SC' | 'ST' | 'PWD' | 'ESM' | 'WOMEN', number>> };
  experienceMonths?: number;
  gender?: 'F' | 'M' | null;
  minPctRelaxReserved?: number;                                                                // percentage points off for SC/ST/PWD
}
export interface Profile {
  dob: string; gender: string; category: string; pwd: boolean; ex_serviceman: boolean;
  education: { level: string; degree: string; subjects: string[]; percentage: number | null; status: string }[];
  tests: { kind: string; paper: string; score: number | null; qualified: boolean; valid_until: string | null }[];
  experience: { from_date: string; to_date: string | null; teaching: boolean }[];
}

/** NES / CBSE norms by post: the starting rules a school's vacancy gets (and may change). */
export function templateFor(postType: string, subject?: string | null): Rules {
  const s = subject ? [subject] : undefined;
  const relax = { OBC: 3, SC: 5, ST: 5, PWD: 10, ESM: 5 };
  switch (postType) {
    case 'PGT': return { education: [{ levels: ['POST_GRADUATION'], subjects: s, minPct: 50, label: 'Post-graduation in the subject, 50%' }, { levels: ['BED'], label: 'B.Ed.' }], age: { max: 40, relax }, minPctRelaxReserved: 5 };
    case 'TGT': return { education: [{ levels: ['GRADUATION', 'POST_GRADUATION'], subjects: s, minPct: 50, label: 'Graduation in the subject, 50%' }, { levels: ['BED'], label: 'B.Ed.' }], tests: [{ kind: 'CTET', paper: 'II' }, { kind: 'STET', paper: 'II' }], age: { max: 35, relax }, minPctRelaxReserved: 5 };
    case 'PRT': return { education: [{ levels: ['SR_SECONDARY'], minPct: 50, label: 'Class XII, 50%' }, { levels: ['DELED', 'BED'], label: 'D.El.Ed. or B.Ed.' }], tests: [{ kind: 'CTET', paper: 'I' }, { kind: 'STET', paper: 'I' }], age: { max: 30, relax }, minPctRelaxReserved: 5 };
    case 'BALVATIKA': return { education: [{ levels: ['SR_SECONDARY'], minPct: 45, label: 'Class XII, 45%' }, { levels: ['NTT', 'DIPLOMA', 'DELED'], label: 'Nursery teacher training (ECCE) diploma' }], age: { max: 30, relax } };
    case 'PRINCIPAL': case 'VICE_PRINCIPAL': return { education: [{ levels: ['POST_GRADUATION'], minPct: 50, label: 'Post-graduation, 50%' }, { levels: ['BED'], label: 'B.Ed.' }], experienceMonths: postType === 'PRINCIPAL' ? 120 : 96, age: { min: 35, max: 55 } };
    case 'COUNSELLOR': return { education: [{ levels: ['POST_GRADUATION', 'GRADUATION'], subjects: ['Psychology'], label: 'Psychology (graduate or post-graduate)' }], age: { max: 40, relax } };
    case 'LIBRARIAN': return { education: [{ levels: ['GRADUATION', 'POST_GRADUATION'], subjects: ['Library Science'], label: 'Library science' }], age: { max: 35, relax } };
    default: return { education: [{ levels: ['GRADUATION', 'POST_GRADUATION', 'SR_SECONDARY'], label: 'Class XII or graduation' }], age: { max: 40, relax } };
  }
}

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const yearsOn = (dob: string, on: string) => { const a = new Date(`${dob}T00:00:00Z`), b = new Date(`${on}T00:00:00Z`); let y = b.getUTCFullYear() - a.getUTCFullYear(); if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) y--; return y; };
/** Whole months from the first day to the last day, both counted (1 June to 31 March is ten months). */
const monthsBetween = (a: string, b: string) => { const e = addDays(b, 1); return Math.max(0, (Number(e.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(e.slice(5, 7)) - Number(a.slice(5, 7)) - (Number(e.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0)); };
const subjectMatch = (have: string[], want: string[]) => want.some((w) => have.some((h) => h.toLowerCase() === w.toLowerCase() || h.toLowerCase().includes(w.toLowerCase())));

/**
 * Checks a profile against a vacancy's rules on its "age as on" date. Returns every rule with
 * whether it is met and why, and the figures schools sort by.
 */
export function evaluate(rules: Rules, p: Profile, asOn: string, subjectNames: Record<string, string> = {}) {
  const checks: { ok: boolean; label: string; detail: string }[] = [];
  const reserved = ['SC', 'ST'].includes(p.category) || p.pwd;
  let qualPct: number | null = null;
  for (const [i, r] of (rules.education ?? []).entries()) {
    const min = (r.minPct ?? 0) - (reserved ? rules.minPctRelaxReserved ?? 0 : 0);
    const want = (r.subjects ?? []).flatMap((s) => [s, subjectNames[s] ?? s]);
    const fit = p.education.filter((e) => r.levels.includes(e.level) && e.status === 'PASSED' && (!want.length || subjectMatch(e.subjects.concat(e.degree), want)));
    const best = fit.sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
    const ok = !!best && (min <= 0 || (best.percentage ?? 0) >= min);
    if (i === 0 && best) qualPct = best.percentage;
    const label = r.label ?? `${r.levels.map((l) => LEVELS[l] ?? l).join(' or ')}${want.length ? ` in ${r.subjects!.map((s) => subjectNames[s] ?? s).join('/')}` : ''}${r.minPct ? `, ${r.minPct}%` : ''}`;
    checks.push({ ok, label, detail: !best ? 'Not in your profile (passed)' : ok ? `${best.degree}${best.percentage !== null ? `, ${best.percentage}%` : ''}` : `${best.degree}: ${best.percentage ?? '?'}%, needs ${min}%${reserved && rules.minPctRelaxReserved ? ' (after relaxation)' : ''}` });
  }
  let testScore: number | null = null;
  if (rules.tests?.length) {
    const fit = p.tests.filter((t) => t.qualified && rules.tests!.some((r) => r.kind === t.kind && (!r.paper || t.paper.toUpperCase() === r.paper.toUpperCase())) && (!t.valid_until || t.valid_until >= asOn));
    testScore = fit.reduce<number | null>((m, t) => (t.score !== null && (m === null || t.score > m) ? t.score : m), null);
    checks.push({ ok: fit.length > 0, label: rules.tests.map((t) => `${t.kind}${t.paper ? ` Paper ${t.paper}` : ''}`).join(' or '), detail: fit.length ? `${fit[0].kind} ${fit[0].paper} qualified` : 'Not in your profile (qualified and valid)' });
  }
  const age = yearsOn(p.dob, asOn);
  if (rules.age) {
    const rl = rules.age.relax ?? {};
    const relax = (p.category in rl ? rl[p.category as 'OBC'] ?? 0 : 0) + (p.pwd ? rl.PWD ?? 0 : 0) + (p.ex_serviceman ? rl.ESM ?? 0 : 0) + (p.gender === 'F' ? rl.WOMEN ?? 0 : 0);
    const max = rules.age.max !== undefined ? rules.age.max + relax : undefined;
    const ok = (rules.age.min === undefined || age >= rules.age.min) && (max === undefined || age <= max);
    checks.push({ ok, label: `Age${rules.age.min !== undefined ? ` at least ${rules.age.min}` : ''}${max !== undefined ? ` at most ${max}${relax ? ` (${rules.age.max} + ${relax} relaxation)` : ''}` : ''} on ${longDate(asOn)}`, detail: `${age} years` });
  }
  const today = localToday();
  const expMonths = p.experience.filter((x) => x.teaching).reduce((s, x) => s + monthsBetween(x.from_date, x.to_date ?? today), 0);
  if (rules.experienceMonths) checks.push({ ok: expMonths >= rules.experienceMonths, label: `Teaching experience of ${Math.round(rules.experienceMonths / 12)} years`, detail: `${Math.floor(expMonths / 12)} years ${expMonths % 12} months` });
  if (rules.gender) checks.push({ ok: p.gender === rules.gender, label: rules.gender === 'F' ? 'Women candidates' : 'Men candidates', detail: p.gender === 'F' ? 'Woman' : 'Man' });
  const pg = p.education.filter((e) => e.level === 'POST_GRADUATION' && e.status === 'PASSED').reduce<number | null>((m, e) => (e.percentage !== null && (m === null || e.percentage > m) ? e.percentage : m), null);
  const bed = p.education.filter((e) => e.level === 'BED' && e.status === 'PASSED').reduce<number | null>((m, e) => (e.percentage !== null && (m === null || e.percentage > m) ? e.percentage : m), null);
  return { eligible: checks.every((c) => c.ok), checks, keys: { qual_pct: qualPct, pg_pct: pg, bed_pct: bed, test_score: testScore, experience_months: expMonths, age_years: age } };
}

// ── Candidate accounts: one-time codes, registration, sign-in ────────────────────────────

const normal = (d: string) => (d.includes('@') ? d.trim().toLowerCase() : `+91${d.replace(/\D/g, '').slice(-10)}`);
const hashCode = (dest: string, code: string) => createHash('sha256').update(`${process.env.NES_DATA_KEY ?? 'dev'}:${dest}:${code}`).digest('hex');

/** Sends a six-digit code by SMS or email (at most three in fifteen minutes to one address). */
export async function requestOtp(db: Db, input: { destination: string; purpose: 'REGISTER' | 'LOGIN' }) {
  const dest = normal(input.destination);
  if (dest.includes('@') ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest) : !/^\+91[6-9]\d{9}$/.test(dest)) throw invalid('Give a valid email address or 10-digit mobile number.');
  const recent = await db.one<{ n: number }>(`select count(*)::int as n from candidate_otp where destination = $1 and created_at > now() - interval '15 minutes'`, [dest]);
  if (recent.n >= 3) throw new AppError(429, 'slow_down', 'Too many codes asked for. Please wait a few minutes.');
  if (input.purpose === 'LOGIN' && !(await db.maybeOne(dest.includes('@') ? 'select 1 from candidate where lower(email) = $1' : 'select 1 from candidate where mobile = $1', [dest]))) throw notFound('A registration with this email or mobile');
  if (input.purpose === 'REGISTER' && (await db.maybeOne(dest.includes('@') ? 'select 1 from candidate where lower(email) = $1' : 'select 1 from candidate where mobile = $1', [dest]))) throw conflict('registered', 'This is already registered. Sign in instead.');
  const code = String(randomInt(100000, 1000000));
  await db.tx(async (t) => {
    await t.query(`insert into candidate_otp (destination, purpose, code_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`, [dest, input.purpose, hashCode(dest, code)]);
    await messages.queue(t, { template: dest.includes('@') ? 'OTP_EMAIL' : 'OTP_SMS', to: dest, vars: { code }, context: 'ACCOUNT' });
  }, { actor: 'careers' });
  // Until real SMS and email are connected, the code is shown on the test system only.
  return { sent: true, to: dest.includes('@') ? dest.replace(/^(.).*(@.*)$/, '$1•••$2') : `•••••${dest.slice(-4)}`, ...(sandbox() ? { sandboxCode: code } : {}) };
}

async function checkOtp(t: Db, destination: string, purpose: string, code: string) {
  const dest = normal(destination);
  const o = await t.maybeOne<{ id: number; code_hash: string; attempts: number }>(
    `select id, code_hash, attempts from candidate_otp where destination = $1 and purpose = $2 and used_at is null and expires_at > now() order by id desc limit 1`, [dest, purpose]);
  if (!o) throw invalid('The code has expired. Ask for a new one.');
  if (o.attempts >= 5) throw invalid('Too many wrong tries. Ask for a new code.');
  if (o.code_hash !== hashCode(dest, code.trim())) { await t.query('update candidate_otp set attempts = attempts + 1 where id = $1', [o.id]); throw invalid('That code is not right.'); }
  await t.query('update candidate_otp set used_at = now() where id = $1', [o.id]);
  return dest;
}

async function session(t: Db, userId: string) {
  const token = randomBytes(24).toString('base64url');
  await t.query(`insert into app_session (token, user_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [token, userId]);
  return token;
}

/** Registers a candidate once, with both email and mobile verified. */
export async function register(db: Db, input: { name: string; email: string; mobile: string; dob: string; gender: 'F' | 'M' | 'X'; category?: string; emailCode: string; mobileCode: string }) {
  if (yearsOn(input.dob, localToday()) < 18) throw invalid('Candidates must be at least 18 years old.');
  return db.tx(async (t) => {
    const email = await checkOtp(t, input.email, 'REGISTER', input.emailCode);
    const mobile = await checkOtp(t, input.mobile, 'REGISTER', input.mobileCode);
    const c = await t.one<{ id: string; candidate_no: string }>(
      `insert into candidate (email, mobile, name, dob, gender, category, email_verified_at, mobile_verified_at) values ($1, $2, $3, $4, $5, $6, now(), now()) returning id, candidate_no`,
      [email, mobile, input.name.trim(), input.dob, input.gender, input.category ?? 'GEN']);
    const u = await t.one<{ id: string }>(`insert into app_user (name, role, designation, candidate_id, email, phone) values ($1, 'CANDIDATE', 'Candidate', $2, $3, null) returning id`, [input.name.trim(), c.id, email]);
    await messages.queue(t, { template: 'CANDIDATE_REGISTERED_EMAIL', to: email, vars: { name: input.name.trim(), candidateNo: c.candidate_no }, context: 'RECRUITMENT' });
    return { token: await session(t, u.id), candidateNo: c.candidate_no };
  }, { actor: 'careers' });
}

/** Signs in with a code sent to the registered email or mobile. */
export async function login(db: Db, input: { destination: string; code: string }) {
  return db.tx(async (t) => {
    const dest = await checkOtp(t, input.destination, 'LOGIN', input.code);
    const u = await t.one<{ id: string }>(`select u.id from app_user u join candidate c on c.id = u.candidate_id where ${dest.includes('@') ? 'lower(c.email) = $1' : 'c.mobile = $1'}`, [dest]);
    return { token: await session(t, u.id) };
  }, { actor: 'careers' });
}

// ── The profile (kept for life) ───────────────────────────────────────────────────────────

const me = (a: Actor) => { if (a.role !== 'CANDIDATE' || !a.candidateId) throw forbidden('Sign in as a candidate.'); return a.candidateId; };

async function profileOf(db: Db, candidateId: string) {
  const c = await db.one<Record<string, unknown> & { candidate_no: string; navy_relation: string; dob: string; gender: string; category: string; pwd: boolean; ex_serviceman: boolean; name: string; email: string; mobile: string; city: string | null }>(
    `select id, candidate_no, email, mobile, name, father_name, mother_name, spouse_name, dob::text, gender, category, pwd, pwd_type, ex_serviceman, navy_relation, nationality, address, city, state, pincode, aadhaar_last4, version, updated_at from candidate where id = $1`, [candidateId]);
  const education = await db.query<Profile['education'][number] & { id: string }>(`select id, level, degree, subjects, institution, year, percentage::float, status from candidate_education where candidate_id = $1 order by year nulls last`, [candidateId]);
  const tests = await db.query<Profile['tests'][number] & { id: string }>(`select id, kind, paper, year, score::float, qualified, valid_until::text from candidate_test where candidate_id = $1 order by year`, [candidateId]);
  const experience = await db.query<Profile['experience'][number] & { id: string }>(`select id, organisation, post, subject, from_date::text, to_date::text, teaching, cbse from candidate_experience where candidate_id = $1 order by from_date`, [candidateId]);
  const documents = await db.query<{ id: string; kind: string; name: string }>(`select id, kind, ref_key, name, content_type, size, uploaded_at from candidate_document where candidate_id = $1 order by uploaded_at`, [candidateId]);
  return { ...c, education, tests, experience, documents };
}

export async function myProfile(db: Db, actor: Actor) { return profileOf(db, me(actor)); }

export async function updateProfile(db: Db, actor: Actor, input: Partial<{ name: string; fatherName: string; motherName: string; spouseName: string; dob: string; gender: 'F' | 'M' | 'X'; category: string; pwd: boolean; pwdType: string | null;
  exServiceman: boolean; navyRelation: string; nationality: string; address: string; city: string; state: string; pincode: string; aadhaar: string }>) {
  const id = me(actor);
  if (input.dob && yearsOn(input.dob, localToday()) < 18) throw invalid('Candidates must be at least 18 years old.');
  if (input.aadhaar && !/^[2-9]\d{11}$/.test(input.aadhaar.replace(/\s/g, ''))) throw invalid('An Aadhaar number has 12 digits.');
  const set = (v: unknown) => v !== undefined;
  const a = input.aadhaar?.replace(/\s/g, '');
  await db.tx((t) => t.query(
    `update candidate set name = coalesce($2, name), father_name = case when $3 then $4 else father_name end, mother_name = case when $5 then $6 else mother_name end, spouse_name = case when $7 then $8 else spouse_name end,
            dob = coalesce($9::date, dob), gender = coalesce($10, gender), category = coalesce($11, category), pwd = coalesce($12, pwd), pwd_type = case when $13 then $14 else pwd_type end,
            ex_serviceman = coalesce($15, ex_serviceman), navy_relation = coalesce($16, navy_relation), nationality = coalesce($17, nationality), address = case when $18 then $19 else address end,
            city = case when $20 then $21 else city end, state = case when $22 then $23 else state end, pincode = case when $24 then $25 else pincode end,
            aadhaar_last4 = coalesce($26, aadhaar_last4), aadhaar_cipher = coalesce($27, aadhaar_cipher), updated_at = now() where id = $1`,
    [id, input.name?.trim() || null, set(input.fatherName), input.fatherName?.trim() || null, set(input.motherName), input.motherName?.trim() || null, set(input.spouseName), input.spouseName?.trim() || null,
     input.dob ?? null, input.gender ?? null, input.category ?? null, input.pwd ?? null, set(input.pwdType), input.pwdType ?? null, input.exServiceman ?? null, input.navyRelation ?? null, input.nationality ?? null,
     set(input.address), input.address?.trim() || null, set(input.city), input.city?.trim() || null, set(input.state), input.state?.trim() || null, set(input.pincode), input.pincode?.trim() || null,
     a ? last4(a) : null, a ? seal(a) : null]), { actor: actor.label });
  return profileOf(db, id);
}

/** Education, tests and experience are saved as whole lists (the profile screen sends them as shown). */
export async function setQualifications(db: Db, actor: Actor, input: { education?: { level: string; degree: string; subjects: string[]; institution?: string; year?: number; percentage?: number | null; status?: 'PASSED' | 'APPEARING' }[];
  tests?: { kind: string; paper?: string; year?: number; score?: number | null; qualified?: boolean; validUntil?: string | null }[];
  experience?: { organisation: string; post: string; subject?: string; fromDate: string; toDate?: string | null; teaching?: boolean; cbse?: boolean }[] }) {
  const id = me(actor);
  await db.tx(async (t) => {
    if (input.education) {
      await t.query('delete from candidate_education where candidate_id = $1', [id]);
      for (const e of input.education) await t.query(`insert into candidate_education (candidate_id, level, degree, subjects, institution, year, percentage, status) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, e.level, e.degree.trim(), e.subjects.map((s) => s.trim()).filter(Boolean), e.institution?.trim() ?? null, e.year ?? null, e.percentage ?? null, e.status ?? 'PASSED']);
    }
    if (input.tests) {
      await t.query('delete from candidate_test where candidate_id = $1', [id]);
      for (const x of input.tests) await t.query(`insert into candidate_test (candidate_id, kind, paper, year, score, qualified, valid_until) values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, x.kind, x.paper?.trim() ?? '', x.year ?? null, x.score ?? null, x.qualified ?? true, x.validUntil ?? null]);
    }
    if (input.experience) {
      await t.query('delete from candidate_experience where candidate_id = $1', [id]);
      for (const x of input.experience) await t.query(`insert into candidate_experience (candidate_id, organisation, post, subject, from_date, to_date, teaching, cbse) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, x.organisation.trim(), x.post.trim(), x.subject?.trim() ?? null, x.fromDate, x.toDate ?? null, x.teaching ?? true, x.cbse ?? false]);
    }
    await t.query('update candidate set updated_at = now() where id = $1', [id]);
  }, { actor: actor.label });
  return profileOf(db, id);
}

/** Documents that are one of a kind (a new upload replaces the old one). Images only, for printing on forms and ID. */
const SINGLE = ['PHOTO', 'SIGNATURE', 'THUMB', 'ID_PROOF', 'CATEGORY', 'PWD', 'ESM'];
const IMAGE_ONLY = ['PHOTO', 'SIGNATURE', 'THUMB'];

/**
 * What a candidate must upload before applying: photo, signature, thumb impression and photo ID;
 * a certificate for every qualification and test in the profile; and the certificate for any
 * category, disability or ex-serviceman status claimed.
 */
export function requiredDocuments(p: { category: string; pwd: boolean; ex_serviceman: boolean; education: { level: string; degree: string; status?: string }[]; tests: { kind: string }[]; documents: { kind: string; ref_key?: string | null }[] }) {
  const has = (kind: string, ref?: string) => p.documents.some((d) => d.kind === kind && (!ref || d.ref_key === ref));
  const need: { kind: string; ref?: string; label: string }[] = [
    { kind: 'PHOTO', label: 'photograph' }, { kind: 'SIGNATURE', label: 'signature' }, { kind: 'THUMB', label: 'thumb impression' }, { kind: 'ID_PROOF', label: 'photo ID (Aadhaar, passport, voter ID or driving licence)' }];
  for (const e of p.education) if (e.status !== 'APPEARING') need.push({ kind: 'EDUCATION', ref: e.level, label: `${e.degree || e.level.toLowerCase()} certificate or mark sheet` });
  for (const t of p.tests) need.push({ kind: 'TEST', ref: t.kind, label: `${t.kind} certificate` });
  if (!['GEN', 'UR'].includes(p.category)) need.push({ kind: 'CATEGORY', label: `${p.category} certificate` });
  if (p.pwd) need.push({ kind: 'PWD', label: 'disability certificate' });
  if (p.ex_serviceman) need.push({ kind: 'ESM', label: 'ex-serviceman discharge book or certificate' });
  return need.filter((n) => !has(n.kind, n.ref));
}

export async function uploadDocument(db: Db, actor: Actor, input: { kind: string; name: string; contentType: string; dataBase64: string; refKey?: string }) {
  const id = me(actor);
  if (IMAGE_ONLY.includes(input.kind) && input.contentType === 'application/pdf') throw invalid('Upload the photograph, signature and thumb impression as a JPG or PNG image.');
  if (['EDUCATION', 'TEST'].includes(input.kind) && !input.refKey) throw invalid('Say which qualification this certificate is for.');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (!data.length || data.length > 2 * 1024 * 1024) throw invalid('Each document is at most 2 MB.');
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(input.contentType)) throw invalid('Upload a JPG, PNG or PDF.');
  const head = data.subarray(0, 4).toString('hex');
  if (!(head.startsWith('ffd8') || head === '89504e47' || head === '25504446')) throw invalid('The file does not look like a JPG, PNG or PDF.');
  return db.tx(async (t) => {
    if (SINGLE.includes(input.kind)) await t.query('delete from candidate_document where candidate_id = $1 and kind = $2', [id, input.kind]);
    return t.one<{ id: string }>(`insert into candidate_document (candidate_id, kind, ref_key, name, content_type, size, sha256, data) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [id, input.kind, input.refKey ?? null, input.name.slice(0, 120), input.contentType, data.length, createHash('sha256').update(data).digest('hex'), data]);
  }, { actor: actor.label });
}

export async function deleteDocument(db: Db, actor: Actor, docId: string) {
  const id = me(actor);
  if (await db.maybeOne(`select 1 from job_application where candidate_id = $1 and snapshot->'documents' @> $2::jsonb and status not in ('WITHDRAWN', 'REJECTED', 'NOT_SELECTED')`, [id, JSON.stringify([{ id: docId }])])) throw conflict('in_use', 'This document is part of an application in progress.');
  await db.tx((t) => t.query('delete from candidate_document where id = $1 and candidate_id = $2', [docId, id]), { actor: actor.label });
  return { ok: true };
}

/** A document: the candidate's own, or for staff of a school the candidate applied to. */
export async function document(db: Db, actor: Actor, docId: string) {
  if (!UUID.test(docId)) throw notFound('Document');
  const d = await db.maybeOne<{ candidate_id: string; name: string; content_type: string; data: Buffer }>('select candidate_id, name, content_type, data from candidate_document where id = $1', [docId]);
  if (!d) throw notFound('Document');
  if (actor.candidateId !== d.candidate_id) {
    const v = await db.query<{ school_id: string }>(`select v.school_id from job_application a join vacancy v on v.id = a.vacancy_id where a.candidate_id = $1`, [d.candidate_id]);
    let ok = false;
    for (const x of v) if (await can(db, actor, 'recruitment.view', x.school_id)) ok = true;
    if (!ok) throw forbidden();
  }
  return d;
}

// ── Vacancies ─────────────────────────────────────────────────────────────────────────────

export interface VacancyInput { postId?: string | null; postType: string; subjectCode?: string | null; title?: string; employment: string; positions?: number; payText?: string; description?: string;
  eligibility?: Rules; fees?: Record<string, number | null>; questions?: { id: string; label: string; type: 'YESNO' | 'TEXT' | 'CHOICE'; options?: string[]; required?: boolean }[];
  weights?: { cwt: number; interview: number; academic: number }; declaration?: string; opensOn: string; closesOn: string; ageAsOn?: string; cwt?: boolean; interview?: boolean }

const DECLARATION = 'I declare that all the information given in this application, and in the documents I have uploaded, is true, complete and correct to the best of my knowledge and belief. I understand that if any of it is found false or incorrect at any stage, my candidature or appointment may be cancelled without notice, and that the school may verify my documents and antecedents. I have read the eligibility conditions and meet them.';

/**
 * A vacancy, started from the school's vacant sanctioned post when there is one (post type,
 * subject, pay level and employment come from it), with eligibility from NES norms for the post.
 */
export async function createVacancy(db: Db, actor: Actor, schoolId: string, input: VacancyInput) {
  await assertCan(db, actor, 'recruitment.manage', schoolId);
  let { postType, subjectCode } = input;
  let pay = input.payText ?? '';
  if (input.postId) {
    const p = await db.maybeOne<{ school_id: string; post_type: string; subject_code: string | null; pay_level: number | null }>('select school_id, post_type, subject_code, pay_level from post where id = $1', [input.postId]);
    if (!p || p.school_id !== schoolId) throw invalid('Choose one of this school’s posts.');
    postType = p.post_type; subjectCode = p.subject_code ?? subjectCode;
    if (!pay && p.pay_level) pay = `Pay level ${p.pay_level}`;
  }
  const school = await db.one<{ code: string; name: string }>('select code, name from org_unit where id = $1', [schoolId]);
  const pt = await db.one<{ name: string }>('select name from post_type where code = $1', [postType]);
  const subj = subjectCode ? (await db.maybeOne<{ name: string }>('select name from subject where code = $1', [subjectCode]))?.name : null;
  const seq = (await db.one<{ n: number }>(`select count(*)::int + 1 as n from vacancy where school_id = $1 and extract(year from created_at) = extract(year from now())`, [schoolId])).n;
  const code = `${school.code}/${localToday().slice(0, 4)}/${String(seq).padStart(3, '0')}`;
  const fees = input.fees ?? { GEN: 50000, OBC: 50000, EWS: 50000, SC: 0, ST: 0, PWD: 0, ESM: 0, WOMEN: null };
  return db.tx((t) => t.one<{ id: string; code: string }>(
    `insert into vacancy (school_id, code, post_id, post_type, subject_code, title, employment, positions, pay_text, description, eligibility, fees, questions, weights, declaration, opens_on, closes_on, age_as_on, cwt, interview, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id, code`,
    [schoolId, code, input.postId ?? null, postType, subjectCode ?? null, input.title?.trim() || `${pt.name}${subj ? ` (${subj})` : ''}`, input.employment, input.positions ?? 1, pay, input.description ?? '',
     JSON.stringify(input.eligibility ?? templateFor(postType, subjectCode)), JSON.stringify(fees), JSON.stringify(input.questions ?? []), JSON.stringify(input.weights ?? { cwt: input.cwt ? 60 : 0, interview: input.cwt ? 30 : 70, academic: input.cwt ? 10 : 30 }),
     input.declaration ?? DECLARATION, input.opensOn, input.closesOn, input.ageAsOn ?? input.closesOn, !!input.cwt, input.interview ?? true, actor.id]), { actor: actor.label });
}

async function loadVacancy(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Vacancy');
  const v = await db.maybeOne<{ id: string; school_id: string; code: string; title: string; status: string; post_type: string; subject_code: string | null; employment: string; post_id: string | null;
    eligibility: Rules; fees: Record<string, number | null>; questions: { id: string; label: string; required?: boolean }[]; weights: { cwt: number; interview: number; academic: number };
    declaration: string; opens_on: string; closes_on: string; age_as_on: string; cwt: boolean; school: string }>(
    `select v.id, v.school_id, v.code, v.title, v.status, v.post_type, v.subject_code, v.employment, v.post_id, v.eligibility, v.fees, v.questions, v.weights, v.declaration,
            v.opens_on::text, v.closes_on::text, v.age_as_on::text, v.cwt, o.name as school from vacancy v join org_unit o on o.id = v.school_id where v.id = $1`, [id]);
  if (!v) throw notFound('Vacancy');
  return v;
}

export async function updateVacancy(db: Db, actor: Actor, id: string, input: Partial<VacancyInput>) {
  const v = await loadVacancy(db, id);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (v.status === 'PUBLISHED') {
    // Once published, only the closing date can move later (for everyone) and the description be clarified.
    if (Object.keys(input).some((k) => !['closesOn', 'description'].includes(k))) throw conflict('published', 'A published vacancy can only have its closing date extended or its description clarified.');
    if (input.closesOn && input.closesOn < v.closes_on) throw invalid('The closing date can only move later.');
  } else if (v.status !== 'DRAFT') throw conflict('closed', 'This vacancy is closed.');
  const set = (k: keyof VacancyInput) => input[k] !== undefined;
  await db.tx((t) => t.query(
    `update vacancy set title = coalesce($2, title), positions = coalesce($3, positions), pay_text = coalesce($4, pay_text), description = coalesce($5, description), eligibility = coalesce($6, eligibility),
            fees = coalesce($7, fees), questions = coalesce($8, questions), weights = coalesce($9, weights), opens_on = coalesce($10, opens_on), closes_on = coalesce($11, closes_on), age_as_on = coalesce($12, age_as_on),
            cwt = coalesce($13, cwt), interview = coalesce($14, interview), employment = coalesce($15, employment) where id = $1`,
    [id, input.title ?? null, input.positions ?? null, input.payText ?? null, input.description ?? null, set('eligibility') ? JSON.stringify(input.eligibility) : null, set('fees') ? JSON.stringify(input.fees) : null,
     set('questions') ? JSON.stringify(input.questions) : null, set('weights') ? JSON.stringify(input.weights) : null, input.opensOn ?? null, input.closesOn ?? null, input.ageAsOn ?? null, input.cwt ?? null, input.interview ?? null, input.employment ?? null]),
  { actor: actor.label });
  return loadVacancy(db, id);
}

/** The principal publishes; the vacancy appears on the careers page of NavShiksha and the school website. */
export async function publishVacancy(db: Db, actor: Actor, id: string) {
  const v = await loadVacancy(db, id);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('The principal publishes a vacancy.');
  await assertCan(db, actor, 'recruitment.manage', v.school_id).catch(() => { if (actor.role !== 'NES_ADMIN') throw forbidden(); });
  if (v.status !== 'DRAFT') throw conflict('state', 'Only a draft is published.');
  if (v.closes_on < localToday()) throw invalid('The closing date has passed.');
  await db.tx((t) => t.query(`update vacancy set status = 'PUBLISHED', published_by = $2, published_at = now() where id = $1`, [id, actor.id]), { actor: actor.label });
  return { status: 'PUBLISHED' };
}

export async function setVacancyStatus(db: Db, actor: Actor, id: string, status: 'CLOSED' | 'CANCELLED' | 'FILLED') {
  const v = await loadVacancy(db, id);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  await db.tx((t) => t.query(`update vacancy set status = $2 where id = $1`, [id, status]), { actor: actor.label });
  return { status };
}

export async function schoolVacancies(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'recruitment.view', schoolId);
  return db.query(
    `select v.id, v.code, v.title, v.status, v.employment, v.positions, v.opens_on::text, v.closes_on::text, v.cwt, v.post_type, v.subject_code,
            (select jsonb_object_agg(status, n) from (select status, count(*)::int as n from job_application a where a.vacancy_id = v.id group by status) x) as counts,
            (select count(*) from job_application a where a.vacancy_id = v.id)::int as applications
       from vacancy v where v.school_id = $1 order by v.created_at desc`, [schoolId]);
}

/** Open vacancies at every Navy school, for the public careers page. */
export async function openVacancies(db: Db, q: { schoolId?: string; postType?: string; subject?: string; search?: string; page?: number }) {
  const today = localToday();
  return db.query(
    `select v.id, v.code, v.title, v.post_type, pt.name as post, v.subject_code, s.name as subject, v.employment, v.positions, v.pay_text, v.opens_on::text, v.closes_on::text, v.cwt,
            o.name as school, o.city, v.fees
       from vacancy v join org_unit o on o.id = v.school_id join post_type pt on pt.code = v.post_type left join subject s on s.code = v.subject_code
      where v.status = 'PUBLISHED' and v.opens_on <= $1 and v.closes_on >= $1 and ($2::uuid is null or v.school_id = $2) and ($3::text is null or v.post_type = $3) and ($4::text is null or v.subject_code = $4)
        and ($5::text is null or v.title ilike '%' || $5 || '%' or o.name ilike '%' || $5 || '%')
      order by v.closes_on, v.title limit 100 offset $6`, [today, q.schoolId ?? null, q.postType ?? null, q.subject ?? null, q.search ?? null, ((q.page ?? 1) - 1) * 100]);
}

export async function vacancy(db: Db, id: string) {
  const v = await loadVacancy(db, id);
  if (!['PUBLISHED', 'CLOSED', 'FILLED'].includes(v.status)) throw notFound('Vacancy');
  const subjects = await db.query<{ code: string; name: string }>('select code, name from subject');
  const names = Object.fromEntries(subjects.map((s) => [s.code, s.name]));
  const describe = evaluate(v.eligibility, { dob: '2000-01-01', gender: 'X', category: 'GEN', pwd: false, ex_serviceman: false, education: [], tests: [], experience: [] }, v.age_as_on, names).checks.map((c) => c.label);
  return { ...v, rules: describe, open: v.status === 'PUBLISHED' && v.opens_on <= localToday() && v.closes_on >= localToday() };
}

// ── Applying ──────────────────────────────────────────────────────────────────────────────

const feeFor = (fees: Record<string, number | null>, p: { category: string; pwd: boolean; ex_serviceman: boolean; gender: string }) => {
  const options = [fees[p.category] ?? fees.GEN ?? 0];
  if (p.pwd && fees.PWD !== undefined && fees.PWD !== null) options.push(fees.PWD);
  if (p.ex_serviceman && fees.ESM !== undefined && fees.ESM !== null) options.push(fees.ESM);
  if (p.gender === 'F' && fees.WOMEN !== undefined && fees.WOMEN !== null) options.push(fees.WOMEN);
  return Math.max(0, Math.min(...options));
};

/** Before applying: every rule, whether it is met, and the fee this candidate would pay. */
export async function checkEligibility(db: Db, actor: Actor, vacancyId: string) {
  const id = me(actor);
  const v = await loadVacancy(db, vacancyId);
  const p = await profileOf(db, id);
  const names = Object.fromEntries((await db.query<{ code: string; name: string }>('select code, name from subject')).map((s) => [s.code, s.name]));
  const r = evaluate(v.eligibility, p as unknown as Profile, v.age_as_on, names);
  const missingDocs = requiredDocuments(p as never).map((d) => d.label);
  const applied = await db.maybeOne<{ number: string; status: string }>('select number, status from job_application where vacancy_id = $1 and candidate_id = $2', [vacancyId, id]);
  return { eligible: r.eligible, checks: r.checks, fee: feeFor(v.fees, p), missingDocuments: missingDocs, questions: v.questions, declaration: v.declaration, applied };
}

/**
 * Applies: only an eligible candidate, while the vacancy is open, with photo and signature,
 * having answered the vacancy's questions and confirmed the declaration. A copy of the profile is
 * kept with the application. With a fee, the application waits for payment.
 */
export async function apply(db: Db, actor: Actor, vacancyId: string, input: { answers?: Record<string, string>; declaration: boolean; from?: string }) {
  const id = me(actor);
  const v = await loadVacancy(db, vacancyId);
  const today = localToday();
  if (v.status !== 'PUBLISHED' || v.opens_on > today || v.closes_on < today) throw conflict('closed', 'This vacancy is not open for applications.');
  if (!input.declaration) throw invalid('Confirm the declaration to apply.');
  const e = await checkEligibility(db, actor, vacancyId);
  if (e.applied) throw conflict('applied', `You have already applied (${e.applied.number}).`);
  if (!e.eligible) throw invalid(`You do not meet: ${e.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}.`);
  if (e.missingDocuments.length) throw invalid(`Upload these to your profile first: ${e.missingDocuments.join('; ')}.`);
  for (const q of v.questions) if (q.required && !input.answers?.[q.id]?.trim()) throw invalid(`Answer: ${q.label}`);
  const p = await profileOf(db, id);
  const names = Object.fromEntries((await db.query<{ code: string; name: string }>('select code, name from subject')).map((s) => [s.code, s.name]));
  const r = evaluate(v.eligibility, p as unknown as Profile, v.age_as_on, names);
  const fee = e.fee;
  return db.tx(async (t) => {
    const a = await t.one<{ id: string; number: string }>(
      `insert into job_application (vacancy_id, candidate_id, snapshot, answers, eligibility, category, gender, pwd, ex_serviceman, navy_relation, age_years, qual_pct, pg_pct, bed_pct, test_score, experience_months, city, search,
                                    fee_paise, fee_status, status, declared_at, declared_from)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now(), $22) returning id, number`,
      [vacancyId, id, JSON.stringify(p), JSON.stringify(input.answers ?? {}), JSON.stringify(r.checks), p.category, p.gender, p.pwd, p.ex_serviceman, p.navy_relation, r.keys.age_years, r.keys.qual_pct, r.keys.pg_pct, r.keys.bed_pct,
       r.keys.test_score, r.keys.experience_months, p.city, `${p.name} ${p.candidate_no} ${p.email} ${p.mobile}`.toLowerCase(), fee, fee ? 'DUE' : 'NOT_REQUIRED', fee ? 'FEE_DUE' : 'SUBMITTED', input.from ?? null]);
    await t.query(`insert into job_application_event (application_id, to_status, by_user, note) values ($1, $2, $3, 'Applied')`, [a.id, fee ? 'FEE_DUE' : 'SUBMITTED', actor.id]);
    if (!fee) await sendReceived(t, a.id);
    return { id: a.id, number: a.number, fee, status: fee ? 'FEE_DUE' : 'SUBMITTED' };
  }, { actor: actor.label });
}

async function appVars(t: Db, applicationId: string) {
  return t.one<{ id: string; number: string; name: string; email: string; mobile: string; post: string; school: string; school_id: string; vacancy_id: string; fee_paise: number; receipt_no: string | null }>(
    `select a.id, a.number, c.name, c.email, c.mobile, v.title as post, o.name as school, v.school_id, v.id as vacancy_id, a.fee_paise::float as fee_paise, a.receipt_no
       from job_application a join candidate c on c.id = a.candidate_id join vacancy v on v.id = a.vacancy_id join org_unit o on o.id = v.school_id where a.id = $1`, [applicationId]);
}

async function sendReceived(t: Db, applicationId: string) {
  const a = await appVars(t, applicationId);
  await messages.queuePair(t, 'APPLICATION_SUBMITTED', { email: a.email, mobile: a.mobile }, { vars: { name: a.name, applicationNo: a.number, post: a.post, school: a.school,
    feeLine: a.fee_paise ? ` with the fee of ${rupees(a.fee_paise)} (receipt ${a.receipt_no})` : '', link: `${PUBLIC_URL()}/careers/my` }, context: 'RECRUITMENT', refType: 'job_application', refId: a.number, schoolId: a.school_id });
}

/** The fee, to the school's account through the payment gateway (sandbox until go-live). */
export async function payFee(db: Db, actor: Actor, applicationId: string) {
  const id = me(actor);
  const a = await db.maybeOne<{ fee_paise: number; fee_status: string; candidate_id: string; status: string }>('select fee_paise::float as fee_paise, fee_status, candidate_id, status from job_application where id = $1', [applicationId]);
  if (!a || a.candidate_id !== id) throw notFound('Application');
  if (a.fee_status !== 'DUE') throw conflict('paid', 'Nothing is due on this application.');
  return db.tx((t) => t.one<{ id: string; amount_paise: number; gateway_order_id: string }>(
    `insert into job_payment (application_id, amount_paise, gateway_order_id) values ($1, $2, $3) returning id, amount_paise::float as amount_paise, gateway_order_id`,
    [applicationId, a.fee_paise, `sbx_job_${randomBytes(8).toString('hex')}`]), { actor: actor.label });
}

/** The gateway confirms (here, the sandbox): receipt, the school's books, and the candidate is told. */
export async function capturePayment(db: Db, actor: Actor, paymentId: string, outcome: 'success' | 'failure') {
  const id = me(actor);
  const p = await db.maybeOne<{ application_id: string; amount_paise: number; status: string; candidate_id: string }>(
    `select p.application_id, p.amount_paise::float as amount_paise, p.status, a.candidate_id from job_payment p join job_application a on a.id = p.application_id where p.id = $1`, [paymentId]);
  if (!p || p.candidate_id !== id) throw notFound('Payment');
  if (p.status !== 'CREATED') throw conflict('done', 'This payment is already complete.');
  if (outcome === 'failure') { await db.tx((t) => t.query(`update job_payment set status = 'FAILED' where id = $1`, [paymentId]), { actor: actor.label }); return { status: 'FAILED' }; }
  const { nextReceiptNo } = await import('./payments.js');
  return db.tx(async (t) => {
    const a = await appVars(t, p.application_id);
    const receipt = await nextReceiptNo(t, a.school_id, new Date());
    await t.query(`update job_payment set status = 'CAPTURED', captured_at = now(), receipt_no = $2 where id = $1`, [paymentId, receipt]);
    await t.query(`update job_application set fee_status = 'PAID', paid_at = now(), receipt_no = $2, status = 'SUBMITTED', status_changed_at = now() where id = $1`, [p.application_id, receipt]);
    await t.query(`insert into job_application_event (application_id, from_status, to_status, note, by_user) values ($1, 'FEE_DUE', 'SUBMITTED', $2, $3)`, [p.application_id, `Fee paid, receipt ${receipt}`, actor.id]);
    await post(t, { schoolId: a.school_id, narration: `Application fee ${a.number} (receipt ${receipt})`, sourceType: 'job_payment', sourceId: paymentId, lines: [signed('1150', p.amount_paise, 'debit'), signed('4170', p.amount_paise, 'credit')] });
    await messages.queue(t, { template: 'FEE_RECEIVED_SMS', to: a.mobile, vars: { amount: (p.amount_paise / 100).toFixed(0), applicationNo: a.number, receiptNo: receipt }, context: 'RECRUITMENT', refType: 'job_application', refId: a.number, schoolId: a.school_id });
    await sendReceived(t, p.application_id);
    return { status: 'SUBMITTED', receiptNo: receipt };
  }, { actor: actor.label });
}

export async function myApplications(db: Db, actor: Actor) {
  const id = me(actor);
  return db.query(
    `select a.id, a.number, a.status, a.fee_paise::float as fee_paise, a.fee_status, a.receipt_no, a.created_at, a.cwt_roll_no, a.cwt_marks::float, v.id as vacancy_id, v.title as post, v.code, o.name as school, v.closes_on::text,
            coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', r.title, 'kind', r.kind, 'startsAt', s.starts_at, 'venue', r.venue, 'bring', r.bring, 'status', s.status) order by s.starts_at)
               from interview_slot s join interview_round r on r.id = s.round_id where s.application_id = a.id), '[]') as interviews,
            (select jsonb_agg(jsonb_build_object('to', e.to_status, 'at', e.at) order by e.id) from job_application_event e where e.application_id = a.id) as history
       from job_application a join vacancy v on v.id = a.vacancy_id join org_unit o on o.id = v.school_id where a.candidate_id = $1 order by a.created_at desc`, [id]);
}

export async function withdraw(db: Db, actor: Actor, applicationId: string) {
  const id = me(actor);
  const a = await db.maybeOne<{ candidate_id: string; status: string }>('select candidate_id, status from job_application where id = $1', [applicationId]);
  if (!a || a.candidate_id !== id) throw notFound('Application');
  if (['SELECTED', 'APPOINTED', 'REJECTED', 'NOT_SELECTED', 'WITHDRAWN'].includes(a.status)) throw conflict('state', 'This application can no longer be withdrawn.');
  await db.tx(async (t) => {
    await t.query(`update job_application set status = 'WITHDRAWN', status_changed_at = now() where id = $1`, [applicationId]);
    await t.query(`insert into job_application_event (application_id, from_status, to_status, by_user, note) values ($1, $2, 'WITHDRAWN', $3, 'Withdrawn by the candidate')`, [applicationId, a.status, actor.id]);
  }, { actor: actor.label });
  return { status: 'WITHDRAWN' };
}

export async function confirmInterview(db: Db, actor: Actor, slotId: string) {
  const id = me(actor);
  const s = await db.maybeOne<{ candidate_id: string; status: string }>('select a.candidate_id, s.status from interview_slot s join job_application a on a.id = s.application_id where s.id = $1', [slotId]);
  if (!s || s.candidate_id !== id) throw notFound('Interview');
  if (s.status !== 'INVITED') throw conflict('state', 'Already answered.');
  await db.tx((t) => t.query(`update interview_slot set status = 'CONFIRMED' where id = $1`, [slotId]), { actor: actor.label });
  return { status: 'CONFIRMED' };
}

// ── Screening (the school) ────────────────────────────────────────────────────────────────

export interface Filter { status?: string[]; category?: string[]; gender?: string; pwd?: boolean; exServiceman?: boolean; navyRelation?: string[]; minQualPct?: number; minTestScore?: number;
  minExperienceMonths?: number; maxAge?: number; minAge?: number; city?: string; search?: string; tag?: string; feePaid?: boolean; ids?: string[]; hasCwtMarks?: boolean; minCwtMarks?: number }
const SORTS: Record<string, string> = {
  merit: 'a.merit desc nulls last, a.qual_pct desc nulls last', qual: 'a.qual_pct desc nulls last', test: 'a.test_score desc nulls last', experience: 'a.experience_months desc', age: 'a.age_years',
  applied: 'a.created_at', newest: 'a.created_at desc', cwt: 'a.cwt_marks desc nulls last', interview: 'a.interview_marks desc nulls last', name: `a.snapshot->>'name'`,
};

/** The filter as SQL over job_application a, with its parameters (shared by the list, bulk actions, messages and export). */
function where(vacancyId: string, f: Filter) {
  const p: unknown[] = [vacancyId];
  const c: string[] = ['a.vacancy_id = $1'];
  const add = (sql: string, v: unknown) => { p.push(v); c.push(sql.replace('?', `$${p.length}`)); };
  if (f.ids?.length) add('a.id = any(?::uuid[])', f.ids);
  if (f.status?.length) add('a.status = any(?::text[])', f.status); else c.push(`a.status not in ('WITHDRAWN', 'FEE_DUE')`);
  if (f.category?.length) add('a.category = any(?::text[])', f.category);
  if (f.gender) add('a.gender = ?', f.gender);
  if (f.pwd !== undefined) add('a.pwd = ?', f.pwd);
  if (f.exServiceman !== undefined) add('a.ex_serviceman = ?', f.exServiceman);
  if (f.navyRelation?.length) add('a.navy_relation = any(?::text[])', f.navyRelation);
  if (f.minQualPct !== undefined) add('a.qual_pct >= ?', f.minQualPct);
  if (f.minTestScore !== undefined) add('a.test_score >= ?', f.minTestScore);
  if (f.minExperienceMonths !== undefined) add('a.experience_months >= ?', f.minExperienceMonths);
  if (f.maxAge !== undefined) add('a.age_years <= ?', f.maxAge);
  if (f.minAge !== undefined) add('a.age_years >= ?', f.minAge);
  if (f.city) add('lower(a.city) = lower(?)', f.city);
  if (f.search) add(`a.search like '%' || lower(?) || '%'`, f.search.trim());
  if (f.tag) add('? = any(a.tags)', f.tag);
  if (f.feePaid !== undefined) add(f.feePaid ? `a.fee_status in ('PAID', 'NOT_REQUIRED') and true = ?` : `a.fee_status = 'DUE' and true = ?`, true);
  if (f.hasCwtMarks !== undefined) add(f.hasCwtMarks ? 'a.cwt_marks is not null and true = ?' : 'a.cwt_marks is null and true = ?', true);
  if (f.minCwtMarks !== undefined) add('a.cwt_marks >= ?', f.minCwtMarks);
  return { sql: c.join(' and '), params: p };
}

/** Applications for a vacancy, filtered and sorted on the server, a page at a time, with counts. */
export async function applications(db: Db, actor: Actor, vacancyId: string, f: Filter, sort = 'merit', page = 1, size = 50) {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.view', v.school_id);
  const w = where(vacancyId, f);
  const order = SORTS[sort] ?? SORTS.merit;
  const n = Math.min(Math.max(size, 10), 200);
  const rows = await db.query(
    `select a.id, a.number, a.snapshot->>'name' as name, a.snapshot->>'mobile' as mobile, a.snapshot->>'email' as email, a.category, a.gender, a.pwd, a.ex_serviceman, a.navy_relation, a.age_years::float, a.qual_pct::float,
            a.pg_pct::float, a.bed_pct::float, a.test_score::float, a.experience_months, a.city, a.status, a.fee_status, a.cwt_roll_no, a.cwt_marks::float, a.interview_marks::float, a.merit::float, a.tags, a.created_at
       from job_application a where ${w.sql} order by ${order}, a.number limit ${n} offset ${(Math.max(page, 1) - 1) * n}`, w.params);
  const total = (await db.one<{ n: number }>(`select count(*)::int as n from job_application a where ${w.sql}`, w.params)).n;
  const sent = !!(await db.maybeOne(`select 1 from cwt_requirement where vacancy_id = $1 and status = 'SENT'`, [vacancyId]));
  return { rows, total, page, size: n, vacancy: { id: v.id, schoolId: v.school_id, code: v.code, title: v.title, status: v.status, cwt: v.cwt, school: v.school, sentToCwt: sent } };
}

export async function stats(db: Db, actor: Actor, vacancyId: string) {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.view', v.school_id);
  const by = async (col: string) => Object.fromEntries((await db.query<{ k: string; n: number }>(`select ${col}::text as k, count(*)::int as n from job_application where vacancy_id = $1 group by 1`, [vacancyId])).map((r) => [r.k, r.n]));
  return { status: await by('status'), category: await by('category'), gender: await by('gender'), fee: await by('fee_status') };
}

export async function application(db: Db, actor: Actor, id: string) {
  if (!UUID.test(id)) throw notFound('Application');
  const a = await db.maybeOne<{ vacancy_id: string }>('select vacancy_id from job_application where id = $1', [id]);
  if (!a) throw notFound('Application');
  const v = await loadVacancy(db, a.vacancy_id);
  await assertCan(db, actor, 'recruitment.view', v.school_id);
  const row = await db.one('select * from job_application where id = $1', [id]);
  const history = await db.query(`select e.from_status, e.to_status, e.note, e.at, u.name as by from job_application_event e left join app_user u on u.id = e.by_user where e.application_id = $1 order by e.id`, [id]);
  const interviews = await db.query(`select s.id, r.title, r.kind, s.starts_at, s.status, s.marks::float, s.note from interview_slot s join interview_round r on r.id = s.round_id where s.application_id = $1 order by s.starts_at`, [id]);
  return { ...row, history, interviews, vacancy: v };
}

const NEXT: Record<string, string[]> = {
  SUBMITTED: ['SHORTLISTED', 'REJECTED', 'WAITLISTED', 'CWT', 'INTERVIEW'], SHORTLISTED: ['CWT', 'INTERVIEW', 'SELECTED', 'WAITLISTED', 'REJECTED'],
  CWT: ['INTERVIEW', 'SELECTED', 'WAITLISTED', 'NOT_SELECTED', 'REJECTED'], INTERVIEW: ['SELECTED', 'WAITLISTED', 'NOT_SELECTED', 'REJECTED'],
  WAITLISTED: ['SELECTED', 'NOT_SELECTED', 'INTERVIEW'], SELECTED: ['NOT_SELECTED'],
};
const STAGE: Record<string, { title: string; short: string; message: string }> = {
  SHORTLISTED: { title: 'Shortlisted', short: 'Shortlisted', message: 'You have been shortlisted for this post. The school will send you the next step.' },
  CWT: { title: 'Called for the Common Written Test', short: 'Called for CWT', message: 'You are called for the Common Written Test. Your admit card with the roll number, centre and time will be sent to you.' },
  INTERVIEW: { title: 'Called for interview', short: 'Called for interview', message: 'You are called for interview. The date, time and venue are sent separately.' },
  SELECTED: { title: 'Selected', short: 'Selected', message: 'Congratulations: you have been selected. The school will contact you about the offer and joining.' },
  WAITLISTED: { title: 'On the waiting list', short: 'Waiting list', message: 'You are on the waiting list for this post. You will be told if a place becomes available.' },
  REJECTED: { title: 'Not taken forward', short: 'Not taken forward', message: 'Thank you for applying. Your application has not been taken forward for this post.' },
  NOT_SELECTED: { title: 'Not selected', short: 'Not selected', message: 'Thank you for taking part in the selection. You have not been selected for this post this time.' },
};

/** Moves applications on, and tells each candidate by email and SMS (in one statement per step, for any number). */
export async function bulkAction(db: Db, actor: Actor, vacancyId: string, input: { filter: Filter; action: string; note?: string; notify?: boolean; tag?: string }) {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (['SELECTED', 'NOT_SELECTED'].includes(input.action) && actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal makes the final selection.');
  const w = where(vacancyId, input.filter);
  return db.tx(async (t) => {
    if (input.action === 'TAG') {
      if (!input.tag?.trim()) throw invalid('Give the tag.');
      const r = await t.query(`update job_application a set tags = array_append(tags, $${w.params.length + 1}) where ${w.sql} and not ($${w.params.length + 1} = any(tags)) returning a.id`, [...w.params, input.tag.trim()]);
      return { changed: r.length };
    }
    const from = Object.entries(NEXT).filter(([, to]) => to.includes(input.action)).map(([f]) => f);
    if (!from.length) throw invalid('Unknown action.');
    const moved = await t.query<{ id: string; old: string }>(
      `update job_application a set status = $${w.params.length + 1}, status_changed_at = now() from (select id, status as old from job_application a where ${w.sql} and a.status = any($${w.params.length + 2}::text[]) for update) x
        where a.id = x.id returning a.id, x.old`, [...w.params, input.action, from]);
    if (!moved.length) return { changed: 0, skipped: (await t.one<{ n: number }>(`select count(*)::int as n from job_application a where ${w.sql}`, w.params)).n };
    const ids = moved.map((m) => m.id);
    await t.query(`insert into job_application_event (application_id, from_status, to_status, note, by_user) select x.id, x.old, $2, $3, $4 from jsonb_to_recordset($1::jsonb) as x(id uuid, old text)`,
      [JSON.stringify(moved), input.action, input.note?.trim() || null, actor.id]);
    let messaged = 0;
    if (input.notify !== false && STAGE[input.action]) messaged = await stageMessages(t, ids, input.action, actor.id, v.school_id);
    return { changed: moved.length, messaged };
  }, { actor: actor.label });
}

/** The stage email and SMS to many candidates. */
async function stageMessages(t: Db, ids: string[], stage: string, by: string, schoolId: string) {
  const s = STAGE[stage];
  const batch = await t.one<{ id: string }>(`insert into outbound_batch (school_id, context, label, total, created_by) values ($1, 'RECRUITMENT', $2, $3, $4) returning id`, [schoolId, s.title, ids.length, by]);
  let n = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await t.query<{ number: string; name: string; email: string; mobile: string; post: string; school: string }>(
      `select a.number, a.snapshot->>'name' as name, a.snapshot->>'email' as email, a.snapshot->>'mobile' as mobile, v.title as post, o.name as school
         from job_application a join vacancy v on v.id = a.vacancy_id join org_unit o on o.id = v.school_id where a.id = any($1::uuid[])`, [ids.slice(i, i + 5000)]);
    n += await messages.queueMany(t, rows.flatMap((r) => {
      const vars = { name: r.name, post: r.post, school: r.school, stage: s.title, stageShort: s.short, message: s.message, applicationNo: r.number, link: `${PUBLIC_URL()}/careers/my` };
      return [{ template: 'STAGE_EMAIL', to: r.email, vars, refId: r.number }, { template: 'STAGE_SMS', to: r.mobile, vars, refId: r.number }];
    }), { context: 'RECRUITMENT', refType: 'job_application', schoolId, batchId: batch.id, createdBy: by });
  }
  return n;
}

/** The school's own message to one candidate or a whole filtered set (email, SMS, or both). */
export async function sendMessage(db: Db, actor: Actor, vacancyId: string, input: { filter: Filter; subject: string; message: string; channels: ('EMAIL' | 'SMS')[] }) {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (input.message.trim().length < 5) throw invalid('Write the message.');
  const w = where(vacancyId, input.filter);
  return db.tx(async (t) => {
    const rows = await t.query<{ number: string; name: string; email: string; mobile: string }>(`select a.number, a.snapshot->>'name' as name, a.snapshot->>'email' as email, a.snapshot->>'mobile' as mobile from job_application a where ${w.sql}`, w.params);
    const batch = await t.one<{ id: string }>(`insert into outbound_batch (school_id, context, label, filter, total, created_by) values ($1, 'RECRUITMENT', $2, $3, $4, $5) returning id`,
      [v.school_id, input.subject.slice(0, 120), JSON.stringify(input.filter), rows.length, actor.id]);
    const vars = (r: { name: string }) => ({ name: r.name, subject: input.subject.trim(), message: input.message.trim(), sender: v.school });
    const n = await messages.queueMany(t, rows.flatMap((r) => [
      ...(input.channels.includes('EMAIL') ? [{ template: 'CUSTOM_EMAIL', to: r.email, vars: vars(r), refId: r.number }] : []),
      ...(input.channels.includes('SMS') ? [{ template: 'CUSTOM_SMS', to: r.mobile, vars: vars(r), refId: r.number }] : []),
    ]), { context: 'RECRUITMENT', refType: 'job_application', schoolId: v.school_id, batchId: batch.id, createdBy: actor.id });
    return { candidates: rows.length, messages: n, batchId: batch.id };
  }, { actor: actor.label });
}

/**
 * An interview (or demonstration class, or document check) for the filtered applicants, in merit
 * order: each gets a time slot, their status moves to INTERVIEW, and they are told by email and SMS.
 */
export async function scheduleRound(db: Db, actor: Actor, vacancyId: string, input: { kind: 'INTERVIEW' | 'DEMO' | 'DOCUMENTS'; title: string; date: string; start: string; slotMinutes: number; perSlot?: number; venue: string; bring?: string; filter: Filter }) {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (input.date < localToday()) throw invalid('Choose a date from today.');
  const w = where(vacancyId, input.filter);
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into interview_round (vacancy_id, kind, title, on_date, venue, bring, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [vacancyId, input.kind, input.title.trim(), input.date, input.venue.trim(), input.bring?.trim() ?? '', actor.id]);
    const list = await t.query<{ id: string; status: string; number: string; name: string; email: string; mobile: string }>(
      `select a.id, a.status, a.number, a.snapshot->>'name' as name, a.snapshot->>'email' as email, a.snapshot->>'mobile' as mobile from job_application a
        where ${w.sql} and a.status in ('SUBMITTED', 'SHORTLISTED', 'CWT', 'WAITLISTED', 'INTERVIEW') order by ${SORTS.merit}`, w.params);
    const per = Math.max(1, input.perSlot ?? 1);
    const [h, m] = input.start.split(':').map(Number);
    for (const [i, a] of list.entries()) {
      const mins = h * 60 + m + Math.floor(i / per) * input.slotMinutes;
      const time = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      await t.query(`insert into interview_slot (round_id, application_id, starts_at) values ($1, $2, ($3 || ' ' || $4 || ':00+05:30')::timestamptz)`, [r.id, a.id, input.date, time]);
      if (input.kind === 'INTERVIEW' && a.status !== 'INTERVIEW') {
        await t.query(`update job_application set status = 'INTERVIEW', status_changed_at = now() where id = $1`, [a.id]);
        await t.query(`insert into job_application_event (application_id, from_status, to_status, note, by_user) values ($1, $2, 'INTERVIEW', $3, $4)`, [a.id, a.status, input.title, actor.id]);
      }
      await messages.queuePair(t, 'INTERVIEW', { email: a.email, mobile: a.mobile }, { vars: { name: a.name, round: input.title, post: v.title, school: v.school, date: input.date, time, venue: input.venue, bring: input.bring ?? 'Original certificates and a photo ID', link: `${PUBLIC_URL()}/careers/my` },
        context: 'RECRUITMENT', refType: 'job_application', refId: a.number, schoolId: v.school_id });
    }
    return { roundId: r.id, invited: list.length };
  }, { actor: actor.label });
}

export async function markSlot(db: Db, actor: Actor, slotId: string, input: { status: 'ATTENDED' | 'ABSENT'; marks?: number | null; note?: string }) {
  const s = await db.maybeOne<{ application_id: string; vacancy_id: string; kind: string }>(
    `select s.application_id, r.vacancy_id, r.kind from interview_slot s join interview_round r on r.id = s.round_id where s.id = $1`, [slotId]);
  if (!s) throw notFound('Interview');
  const v = await loadVacancy(db, s.vacancy_id);
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (input.marks !== undefined && input.marks !== null && (input.marks < 0 || input.marks > 100)) throw invalid('Marks are out of 100.');
  await db.tx(async (t) => {
    await t.query(`update interview_slot set status = $2, marks = $3, note = $4 where id = $1`, [slotId, input.status, input.marks ?? null, input.note ?? null]);
    if (s.kind !== 'DOCUMENTS' && input.marks !== undefined) await t.query(`update job_application set interview_marks = $2 where id = $1`, [s.application_id, input.marks]);
    await recomputeMerit(t, s.vacancy_id, s.application_id);
  }, { actor: actor.label });
  return { ok: true };
}

/** Merit: the vacancy's weights over the written test, the interview and the qualifying marks (each out of 100). */
export async function recomputeMerit(t: Db, vacancyId: string, onlyId?: string) {
  await t.query(
    `update job_application a set merit = round(((coalesce(a.cwt_marks, 0) * (v.weights->>'cwt')::numeric + coalesce(a.interview_marks, 0) * (v.weights->>'interview')::numeric
                                   + coalesce(a.qual_pct, 0) * (v.weights->>'academic')::numeric) / 100)::numeric, 3)
       from vacancy v where v.id = a.vacancy_id and a.vacancy_id = $1 and ($2::uuid is null or a.id = $2)`, [vacancyId, onlyId ?? null]);
}

/** Every application matching the filter, as a spreadsheet. */
export async function exportCsv(db: Db, actor: Actor, vacancyId: string, f: Filter, sort = 'merit') {
  const v = await loadVacancy(db, vacancyId);
  await assertCan(db, actor, 'recruitment.view', v.school_id);
  const w = where(vacancyId, f);
  const rows = await db.query<Record<string, unknown>>(
    `select a.number, a.snapshot->>'name' as name, a.snapshot->>'mobile' as mobile, a.snapshot->>'email' as email, a.category, a.gender, a.age_years, a.qual_pct, a.pg_pct, a.bed_pct, a.test_score, a.experience_months,
            a.city, a.status, a.fee_status, a.cwt_roll_no, a.cwt_marks, a.interview_marks, a.merit, a.created_at::date as applied_on from job_application a where ${w.sql} order by ${SORTS[sort] ?? SORTS.merit}`, w.params);
  const cols = ['number', 'name', 'mobile', 'email', 'category', 'gender', 'age_years', 'qual_pct', 'pg_pct', 'bed_pct', 'test_score', 'experience_months', 'city', 'status', 'fee_status', 'cwt_roll_no', 'cwt_marks', 'interview_marks', 'merit', 'applied_on'];
  const cell = (x: unknown) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/**
 * A selected candidate joins: their staff record is made from the application (name, mobile,
 * email, date of birth, gender), against the vacancy's post, with the vacancy's employment. Nothing
 * is typed again; the rest of the staff record follows from there.
 */
export async function appoint(db: Db, actor: Actor, applicationId: string, input: { joinedService: string; orderRef: string; contractUntil?: string | null }) {
  const a = await db.maybeOne<{ vacancy_id: string; status: string; snapshot: { name: string; mobile: string; email: string; dob: string; gender: 'F' | 'M' | 'X' } }>('select vacancy_id, status, snapshot from job_application where id = $1', [applicationId]);
  if (!a) throw notFound('Application');
  if (a.status !== 'SELECTED') throw conflict('state', 'Only a selected candidate is appointed.');
  const v = await loadVacancy(db, a.vacancy_id);
  const staff = await import('./staff.js');
  const teaching = (await db.one<{ category: string }>('select category from post_type where code = $1', [v.post_type])).category === 'TEACHING';
  const r = await staff.enrol(db, actor, v.school_id, { name: a.snapshot.name, phone: a.snapshot.mobile, email: a.snapshot.email, dob: a.snapshot.dob, gender: a.snapshot.gender, category: teaching ? 'TEACHING' : 'NON_TEACHING',
    employment: v.employment, joinedService: input.joinedService, contractUntil: input.contractUntil ?? (['CONTRACT', 'TEMPORARY'].includes(v.employment) ? addDays(input.joinedService, 364) : null),
    orderRef: input.orderRef, postId: v.post_id });
  await db.tx(async (t) => {
    await t.query(`update job_application set status = 'APPOINTED', appointed_user_id = $2, status_changed_at = now() where id = $1`, [applicationId, r.userId]);
    await t.query(`insert into job_application_event (application_id, from_status, to_status, note, by_user) values ($1, 'SELECTED', 'APPOINTED', $2, $3)`, [applicationId, `Staff record ${r.nesStaffId}`, actor.id]);
    const filled = await t.one<{ n: number; p: number }>(`select count(*) filter (where status = 'APPOINTED')::int as n, (select positions from vacancy where id = $1)::int as p from job_application where vacancy_id = $1`, [a.vacancy_id]);
    if (filled.n >= filled.p) await t.query(`update vacancy set status = 'FILLED' where id = $1`, [a.vacancy_id]);
    const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [v.school_id]);
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'RECRUITMENT', title: `${a.snapshot.name} joins as ${v.title}`, body: `Staff record ${r.nesStaffId} made from the application.`, link: `/staff/${r.userId}` });
  }, { actor: actor.label });
  return r;
}
