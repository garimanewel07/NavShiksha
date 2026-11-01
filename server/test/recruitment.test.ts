import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as recruitment from '../src/modules/recruitment.js';
import * as staff from '../src/modules/staff.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { trialBalance } from '../src/modules/ledger.js';
import { makeWorld, rejects, type World } from './helpers.js';

/**
 * Recruitment: a candidate registers once and applies year after year; only eligible candidates
 * can apply; schools sort and act on a lakh of applications; every stage is sent by email and SMS;
 * a selected candidate becomes a staff member without anything typed again.
 */

let w: World;
let app: ReturnType<typeof buildApp>;
let vacancyId: string;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/** Registers through the public API, as the careers page does. */
async function registerCandidate(name: string, email: string, mobile: string, dob: string, gender: 'F' | 'M' = 'F') {
  const e = await call(null, 'POST', '/public/careers/otp', { destination: email, purpose: 'REGISTER' });
  const m = await call(null, 'POST', '/public/careers/otp', { destination: mobile, purpose: 'REGISTER' });
  expect(e.json.sandboxCode).toMatch(/^\d{6}$/);
  const r = await call(null, 'POST', '/public/careers/register', { name, email, mobile, dob, gender, emailCode: e.json.sandboxCode, mobileCode: m.json.sandboxCode });
  expect(r.status).toBe(201);
  const me = await call(r.json.token, 'GET', '/me');
  return { token: r.json.token as string, actor: await loadActor(w.db, me.json.id), candidateNo: r.json.candidateNo as string };
}

async function fullProfile(token: string, opts: { pgPct: number; ctet?: boolean }) {
  await call(token, 'PUT', '/candidate/profile', { category: 'GEN', city: 'Mumbai', state: 'Maharashtra', pincode: '400005', address: '12 Colaba Causeway', fatherName: 'R. Nair' });
  await call(token, 'PUT', '/candidate/qualifications', {
    education: [{ level: 'SR_SECONDARY', degree: 'Class XII (CBSE)', subjects: ['Physics', 'Chemistry', 'Mathematics'], year: 2012, percentage: 88 },
      { level: 'GRADUATION', degree: 'B.Sc. Mathematics', subjects: ['MAT', 'Physics'], year: 2015, percentage: 72 },
      { level: 'POST_GRADUATION', degree: 'M.Sc. Mathematics', subjects: ['MAT'], year: 2017, percentage: opts.pgPct },
      { level: 'BED', degree: 'B.Ed.', subjects: ['MAT'], year: 2018, percentage: 80 }],
    tests: opts.ctet ? [{ kind: 'CTET', paper: 'II', year: 2019, score: 104, qualified: true }] : [],
    experience: [{ organisation: 'Kendriya Vidyalaya Colaba', post: 'TGT Maths (contract)', fromDate: '2019-06-01', toDate: '2024-03-31', teaching: true, cbse: true }],
  });
  for (const kind of ['PHOTO', 'SIGNATURE']) expect((await call(token, 'POST', '/candidate/documents', { kind, name: `${kind.toLowerCase()}.jpg`, contentType: 'image/jpeg', dataBase64: JPEG })).status).toBe(201);
  // Applying needs the thumb impression, photo ID and a certificate for every qualification and test.
  const check = async () => (await call(token, 'GET', `/candidate/vacancies/${vacancyId}/check`)).json.missingDocuments as string[];
  expect(await check()).toEqual(expect.arrayContaining(['thumb impression', 'B.Ed. certificate or mark sheet']));
  expect((await call(token, 'POST', '/candidate/documents', { kind: 'THUMB', name: 'thumb.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 x').toString('base64') })).status).toBe(422);
  for (const [kind, refKey] of [['THUMB'], ['ID_PROOF'], ['EDUCATION', 'SR_SECONDARY'], ['EDUCATION', 'GRADUATION'], ['EDUCATION', 'POST_GRADUATION'], ['EDUCATION', 'BED'], ...(opts.ctet ? [['TEST', 'CTET']] : [])])
    expect((await call(token, 'POST', '/candidate/documents', { kind, refKey, name: `${kind.toLowerCase()}.jpg`, contentType: 'image/jpeg', dataBase64: JPEG })).status).toBe(201);
  expect(await check()).toEqual([]);
}

beforeAll(async () => {
  w = await makeWorld();
  app = buildApp(w.db);
  await w.db.query(`update org_unit set city = 'Mumbai' where id = $1`, [w.schoolA]);
});

describe('a candidate registers once', () => {
  it('verifies email and mobile with codes, refuses a second registration, and signs in with a code later', async () => {
    const c = await registerCandidate('Meera Nair', 'meera@example.in', '9820011223', '1994-05-10');
    expect(c.candidateNo).toMatch(/^NES-CN-\d+$/);
    expect(c.actor.role).toBe('CANDIDATE');
    const again = await call(null, 'POST', '/public/careers/otp', { destination: 'Meera@Example.in', purpose: 'REGISTER' });
    expect(again.status).toBe(409);
    // A wrong code counts against the code; the right one signs in.
    const o = await call(null, 'POST', '/public/careers/otp', { destination: '98200 11223', purpose: 'LOGIN' });
    expect(o.json.to).toBe('•••••1223');
    expect((await call(null, 'POST', '/public/careers/login', { destination: '9820011223', code: o.json.sandboxCode === '111111' ? '222222' : '111111' })).status).toBe(422);
    const ok = await call(null, 'POST', '/public/careers/login', { destination: '9820011223', code: o.json.sandboxCode });
    expect(ok.json.token).toBeTruthy();
    // The OTP and welcome messages were queued; the code itself is never stored.
    const msgs = await w.db.query<{ template_code: string }>(`select template_code from outbound_message where to_address in ('meera@example.in', '+919820011223') order by id`);
    expect(msgs.map((m) => m.template_code)).toEqual(expect.arrayContaining(['OTP_EMAIL', 'OTP_SMS', 'CANDIDATE_REGISTERED_EMAIL']));
    expect(JSON.stringify(await w.db.query('select code_hash from candidate_otp'))).not.toContain(o.json.sandboxCode);
  });

  it('keeps candidates away from every school screen', async () => {
    const c = await call((await call(null, 'POST', '/public/careers/login', { destination: '9820011223', code: (await call(null, 'POST', '/public/careers/otp', { destination: '9820011223', purpose: 'LOGIN' })).json.sandboxCode })).json.token, 'GET', `/schools/${w.schoolA}/vacancies`);
    expect(c.status).toBe(403);
  });
});

describe('a school posts a vacancy', () => {
  it('starts from the sanctioned post with NES norms for eligibility; only the principal publishes', async () => {
    await staff.addPost(w.db, w.principalA, w.schoolA, { postType: 'PGT', subjectCode: 'MAT', payLevel: 8, from: '2026-04-01', orderRef: 'NES/EST/9' });
    const post = (await staff.posts(w.db, w.principalA, w.schoolA) as unknown as { id: string; post_type: string; holder: string | null }[]).find((p) => p.post_type === 'PGT' && !p.holder)!;
    const v = await recruitment.createVacancy(w.db, w.principalA, w.schoolA, { postId: post.id, postType: 'PGT', employment: 'CONTRACT', opensOn: '2026-10-01', closesOn: '2026-11-30', ageAsOn: '2026-11-30',
      fees: { GEN: 50000, OBC: 50000, EWS: 50000, SC: 0, ST: 0, PWD: 0, ESM: 0, WOMEN: 25000 }, questions: [{ id: 'q1', label: 'Can you teach Class XII Applied Mathematics?', type: 'YESNO', required: true }] });
    vacancyId = v.id;
    expect(v.code).toBe(`NCS-A/2026/001`);
    const row = await w.db.one<{ title: string; pay_text: string; eligibility: recruitment.Rules }>('select title, pay_text, eligibility from vacancy where id = $1', [v.id]);
    expect(row.title).toBe('Post Graduate Teacher (Mathematics)');
    expect(row.pay_text).toBe('Pay level 8');
    expect(row.eligibility.education![0]).toMatchObject({ levels: ['POST_GRADUATION'], subjects: ['MAT'], minPct: 50 });
    // Not on the careers page until published.
    expect((await call(null, 'GET', '/public/careers')).json).toHaveLength(0);
    await rejects(recruitment.publishVacancy(w.db, w.teacherA, v.id), /principal publishes/);
    await recruitment.publishVacancy(w.db, w.principalA, v.id);
    const list = (await call(null, 'GET', '/public/careers')).json;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ school: 'NCS Alpha', city: 'Mumbai', post: 'Post Graduate Teacher' });
    const detail = (await call(null, 'GET', `/public/careers/${v.id}`)).json;
    expect(detail.rules).toEqual(expect.arrayContaining(['Post-graduation in the subject, 50%', 'B.Ed.']));
    // Published: only the closing date moves (later) and the description is clarified.
    await rejects(recruitment.updateVacancy(w.db, w.principalA, v.id, { fees: { GEN: 1 } }), /closing date extended/);
    await rejects(recruitment.updateVacancy(w.db, w.principalA, v.id, { closesOn: '2026-11-01' }), /only move later/);
  });
});

describe('applying', () => {
  let meera: string, appId: string;
  it('shows each rule and refuses an ineligible candidate', async () => {
    const low = await registerCandidate('Ravi Kulkarni', 'ravi@example.in', '9820044556', '1992-01-20', 'M');
    await fullProfile(low.token, { pgPct: 48 });
    const chk = (await call(low.token, 'GET', `/candidate/vacancies/${vacancyId}/check`)).json;
    expect(chk.eligible).toBe(false);
    expect(chk.checks.find((c: { label: string }) => c.label.startsWith('Post-graduation')).detail).toMatch(/48%, needs 50%/);
    const r = await call(low.token, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: true, answers: { q1: 'Yes' } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/do not meet/);
  });

  it('takes an eligible application with the declaration, a copy of the profile and the fee for her category', async () => {
    const c = await call(null, 'POST', '/public/careers/otp', { destination: 'meera@example.in', purpose: 'LOGIN' });
    meera = (await call(null, 'POST', '/public/careers/login', { destination: 'meera@example.in', code: c.json.sandboxCode })).json.token;
    expect((await call(meera, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: true, answers: { q1: 'Yes' } })).json.error.message).toMatch(/do not meet|photo|Upload/);
    await fullProfile(meera, { pgPct: 68 });
    const chk = (await call(meera, 'GET', `/candidate/vacancies/${vacancyId}/check`)).json;
    expect(chk.eligible).toBe(true);
    expect(chk.fee).toBe(25000);                                                       // the women's fee is lower
    expect((await call(meera, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: false, answers: { q1: 'Yes' } })).status).toBe(422);
    expect((await call(meera, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: true })).json.error.message).toMatch(/Answer/);
    const a = await call(meera, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: true, answers: { q1: 'Yes' } });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ status: 'FEE_DUE', fee: 25000 });
    appId = a.json.id;
    const row = await w.db.one<{ qual_pct: number; experience_months: number; age_years: number; snapshot: { name: string }; declared_at: string }>(
      'select qual_pct::float, experience_months, age_years::float, snapshot, declared_at from job_application where id = $1', [appId]);
    expect(row).toMatchObject({ qual_pct: 68, experience_months: 58, age_years: 32 });
    expect(row.snapshot.name).toBe('Meera Nair');
    expect(row.declared_at).toBeTruthy();
    expect((await call(meera, 'POST', `/candidate/vacancies/${vacancyId}/apply`, { declaration: true, answers: { q1: 'Yes' } })).status).toBe(409);
  });

  it('takes the fee to the school’s books with a receipt, and tells her', async () => {
    const order = (await call(meera, 'POST', `/candidate/applications/${appId}/pay`)).json;
    const p = await call(meera, 'POST', `/candidate/payments/${order.id}/sandbox`, { outcome: 'success' });
    expect(p.json.status).toBe('SUBMITTED');
    const tb = await trialBalance(w.db, w.schoolA);
    expect(tb.find((r) => r.code === '4170')).toMatchObject({ credit: 25000 });
    const msgs = await w.db.query<{ template_code: string }>(`select template_code from outbound_message where ref_id = (select number from job_application where id = $1)`, [appId]);
    expect(msgs.map((m) => m.template_code).sort()).toEqual(['APPLICATION_SUBMITTED_EMAIL', 'APPLICATION_SUBMITTED_SMS', 'FEE_RECEIVED_SMS']);
  });

  it('keeps the profile for next year: a new vacancy needs only the declaration and fee', async () => {
    const v2 = await recruitment.createVacancy(w.db, w.principalA, w.schoolA, { postType: 'TGT', subjectCode: 'MAT', employment: 'GUEST', opensOn: '2026-10-15', closesOn: '2026-12-15', fees: { GEN: 0 } });
    await recruitment.publishVacancy(w.db, w.principalA, v2.id);
    // A TGT needs CTET Paper II: the check says so, she adds it to her profile once, and applies.
    expect((await call(meera, 'POST', `/candidate/vacancies/${v2.id}/apply`, { declaration: true })).json.error.message).toMatch(/CTET Paper II/);
    const p = (await call(meera, 'GET', '/candidate/profile')).json;
    await call(meera, 'PUT', '/candidate/qualifications', { tests: [{ kind: 'CTET', paper: 'II', year: 2019, score: 104 }] });
    expect((await call(meera, 'POST', `/candidate/vacancies/${v2.id}/apply`, { declaration: true })).json.error.message).toMatch(/CTET certificate/);
    await call(meera, 'POST', '/candidate/documents', { kind: 'TEST', refKey: 'CTET', name: 'ctet.jpg', contentType: 'image/jpeg', dataBase64: JPEG });
    const a = await call(meera, 'POST', `/candidate/vacancies/${v2.id}/apply`, { declaration: true });
    expect(a.json).toMatchObject({ status: 'SUBMITTED', fee: 0 });
    expect((await call(meera, 'GET', '/candidate/profile')).json.education).toHaveLength(p.education.length);   // nothing else re-entered
  });
});

describe('screening a lakh of applications', () => {
  let big: string;
  beforeAll(async () => {
    const v = await recruitment.createVacancy(w.db, w.principalA, w.schoolA, { postType: 'PRT', employment: 'CONTRACT', positions: 20, opensOn: '2026-10-01', closesOn: '2026-12-31', fees: { GEN: 0 } });
    big = v.id;
    await w.db.query(`update vacancy set status = 'PUBLISHED' where id = $1`, [big]);
    await w.db.query(`insert into candidate (email, mobile, name, dob, gender, category)
      select 'c' || g || '@example.in', '+91' || (7000000000 + g)::text, 'Candidate ' || g, date '1990-01-01' + (g % 3000), case when g % 3 = 0 then 'M' else 'F' end,
             (array['GEN','OBC','SC','ST','EWS'])[1 + g % 5] from generate_series(1, 100000) g`);
    await w.db.query(`insert into job_application (vacancy_id, candidate_id, snapshot, eligibility, category, gender, age_years, qual_pct, test_score, experience_months, city, search, fee_status, status, declared_at)
      select $1, c.id, jsonb_build_object('name', c.name, 'email', c.email, 'mobile', c.mobile), '[]', c.category, c.gender, 25 + (row_number() over () % 10), 50 + (row_number() over () % 50),
             60 + (row_number() over () % 90), (row_number() over () % 120)::int, (array['Mumbai','Pune','Kochi','Vizag'])[1 + (row_number() over ())::int % 4], lower(c.name || ' ' || c.email), 'NOT_REQUIRED', 'SUBMITTED', now()
        from candidate c where c.email like 'c%@example.in'`, [big]);
  }, 120_000);

  it('filters, sorts and pages on the server quickly', async () => {
    const t0 = Date.now();
    const r = await recruitment.applications(w.db, w.principalA, big, { category: ['OBC'], minQualPct: 90, city: 'Pune' }, 'qual', 1, 50);
    const took = Date.now() - t0;
    expect(r.total).toBeGreaterThan(500);
    expect(r.rows).toHaveLength(50);
    expect((r.rows as { qual_pct: number }[]).every((x, i, a) => i === 0 || a[i - 1].qual_pct >= x.qual_pct)).toBe(true);
    expect(took).toBeLessThan(5000);
    const all = await recruitment.applications(w.db, w.principalA, big, {}, 'merit', 2000, 50);
    expect(all.total).toBe(100000);
    const s = await recruitment.stats(w.db, w.principalA, big);
    expect(s.status.SUBMITTED).toBe(100000);
    // The recruitment in-charge can screen; an ordinary teacher cannot.
    await rejects(recruitment.applications(w.db, w.teacherA, big, {}), /not part of your role/);
  });

  it('shortlists a whole filtered set at once and sends each one an email and SMS', async () => {
    const t0 = Date.now();
    const r = await recruitment.bulkAction(w.db, w.principalA, big, { filter: { minQualPct: 98, minTestScore: 140 }, action: 'SHORTLISTED', note: 'Top marks and CTET' });
    expect(r.changed).toBeGreaterThan(50);
    expect(r.messaged).toBe(r.changed * 2);
    expect(Date.now() - t0).toBeLessThan(20000);
    const ev = await w.db.one<{ n: number }>(`select count(*)::int as n from job_application_event e join job_application a on a.id = e.application_id where a.vacancy_id = $1 and e.to_status = 'SHORTLISTED'`, [big]);
    expect(ev.n).toBe(r.changed);
    // Doing it again changes nothing (they are no longer SUBMITTED).
    expect((await recruitment.bulkAction(w.db, w.principalA, big, { filter: { minQualPct: 98, minTestScore: 140, status: ['SUBMITTED'] }, action: 'SHORTLISTED' })).changed).toBe(0);
    // Only the principal makes the final selection.
    await rejects(recruitment.bulkAction(w.db, w.teacherA, big, { filter: {}, action: 'SELECTED' }), /principal|not part of your role/);
  }, 60_000);

  it('sends the school’s own message to one or a filtered set, and exports the list', async () => {
    const one = (await recruitment.applications(w.db, w.principalA, big, { status: ['SHORTLISTED'] }, 'merit', 1, 10)).rows[0] as { id: string };
    const m = await recruitment.sendMessage(w.db, w.principalA, big, { filter: { ids: [one.id] }, subject: 'Document check', message: 'Please bring your originals on Monday.', channels: ['EMAIL', 'SMS'] });
    expect(m).toMatchObject({ candidates: 1, messages: 2 });
    const csv = await recruitment.exportCsv(w.db, w.principalA, big, { status: ['SHORTLISTED'] });
    expect(csv.split('\r\n')[0]).toMatch(/^number,name,mobile/);
    expect(csv.split('\r\n').length).toBeGreaterThan(50);
  });
});

describe('interviews, selection and joining', () => {
  it('schedules interview slots in merit order, takes marks, and works out merit by the vacancy’s weights', async () => {
    const r = await recruitment.scheduleRound(w.db, w.principalA, vacancyId, { kind: 'INTERVIEW', title: 'Interview and demonstration class', date: '2026-12-05', start: '09:00', slotMinutes: 20, venue: 'NCS Alpha, Conference room', filter: { status: ['SUBMITTED'] } });
    expect(r.invited).toBe(1);
    const a = await w.db.one<{ id: string; status: string }>(`select id, status from job_application where vacancy_id = $1`, [vacancyId]);
    expect(a.status).toBe('INTERVIEW');
    const slot = await w.db.one<{ id: string; t: string }>(`select id, to_char(starts_at at time zone 'Asia/Kolkata', 'HH24:MI') as t from interview_slot where application_id = $1`, [a.id]);
    expect(slot.t).toBe('09:00');
    expect((await w.db.query(`select 1 from outbound_message where template_code in ('INTERVIEW_EMAIL', 'INTERVIEW_SMS') and body like '%Conference room%'`)).length).toBe(2);
    await recruitment.markSlot(w.db, w.principalA, slot.id, { status: 'ATTENDED', marks: 80 });
    const m = await w.db.one<{ merit: number }>('select merit::float from job_application where id = $1', [a.id]);
    expect(m.merit).toBeCloseTo((80 * 70 + 68 * 30) / 100, 3);                         // no written test: interview 70, academic 30
  });

  it('appoints the selected candidate: the staff record is made from the application', async () => {
    const a = await w.db.one<{ id: string }>(`select id from job_application where vacancy_id = $1`, [vacancyId]);
    await rejects(recruitment.appoint(w.db, w.principalA, a.id, { joinedService: '2026-12-15', orderRef: 'NCS-A/EST/101' }), /Only a selected/);
    await recruitment.bulkAction(w.db, w.principalA, vacancyId, { filter: { ids: [a.id] }, action: 'SELECTED' });
    const r = await recruitment.appoint(w.db, w.principalA, a.id, { joinedService: '2026-12-15', orderRef: 'NCS-A/EST/101' });
    const u = await w.db.one<{ name: string; phone: string; email: string; role: string }>('select name, phone, email, role from app_user where id = $1', [r.userId]);
    expect(u).toMatchObject({ name: 'Meera Nair', phone: '+919820011223', email: 'meera@example.in', role: 'TEACHER' });
    const e = await w.db.one<{ dob: string; employment: string; contract_until: string }>('select dob::text, employment, contract_until::text from employee where user_id = $1', [r.userId]);
    expect(e).toMatchObject({ dob: '1994-05-10', employment: 'CONTRACT', contract_until: '2027-12-14' });
    expect((await w.db.query(`select 1 from appointment a join vacancy v on v.post_id = a.post_id where a.user_id = $1 and v.id = $2`, [r.userId, vacancyId])).length).toBe(1);
    expect((await w.db.one<{ status: string }>('select status from vacancy where id = $1', [vacancyId])).status).toBe('FILLED');
    const my = (await call((await call(null, 'POST', '/public/careers/login', { destination: 'meera@example.in', code: (await call(null, 'POST', '/public/careers/otp', { destination: 'meera@example.in', purpose: 'LOGIN' })).json.sandboxCode })).json.token, 'GET', '/candidate/applications')).json;
    expect(my.find((x: { vacancy_id: string }) => x.vacancy_id === vacancyId).status).toBe('APPOINTED');
  });
});

describe('documents', () => {
  it('lets the candidate and the schools she applied to read them, and nobody else', async () => {
    const d = await w.db.one<{ id: string; candidate_id: string }>(`select d.id, d.candidate_id from candidate_document d join candidate c on c.id = d.candidate_id where c.email = 'meera@example.in' limit 1`);
    const principalB = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('Principal Bravo', 'SCHOOL_ADMIN', 'Principal', 'nes.enc.ncs_b') returning id`)).id);
    expect((await recruitment.document(w.db, w.principalA, d.id)).content_type).toBe('image/jpeg');
    await rejects(recruitment.document(w.db, principalB as Actor, d.id), /access/i);
  });
});
