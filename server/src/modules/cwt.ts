import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import { open as unseal, openBytes, seal, sealBytes } from '../lib/secret.js';
import { encryptedZip, zipPassword } from '../lib/zip.js';
import { embedImage, fmtDate, newDocument, Sheet } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import { assertCan, can } from './access.js';
import * as messages from './messages.js';
import * as notify from './notify.js';
import { recomputeMerit } from './recruitment.js';

/**
 * The Common Written Test, run by NES for every school that needs one.
 *
 *  1. NES opens a cycle (date, time, last dates). Schools send each vacancy that needs a written
 *     test to it; vacancies for the same post and subject share one paper.
 *  2. For each paper NES asks three or four schools that already have teachers in that post (and
 *     are not themselves testing for it) for a question paper and answer key. NavShiksha suggests
 *     them; NES can send all the requests in one step.
 *  3. Setter schools upload; the files are encrypted at rest and only the NES CWT cell opens them.
 *     NES reviews and selects one per paper.
 *  4. NES gives roll numbers to the candidates each school has called for the test; admit cards go
 *     to them by email and SMS.
 *  5. The day before (at the release time), each centre gets its papers in one AES-256 zip with
 *     attendance sheets; the password goes separately by SMS to the principal. Every download is
 *     recorded. After the test, the answer keys follow the same way for marking.
 *  6. Centres enter marks; they flow into each application's merit.
 */

const PUBLIC_URL = () => process.env.PUBLIC_URL ?? 'http://localhost:5173';
const UUID = /^[0-9a-f-]{36}$/i;
const FILE_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
const NAVY: [number, number, number] = [0.06, 0.18, 0.36], GREY: [number, number, number] = [0.4, 0.4, 0.45];

const startOf = (c: { exam_date: string; starts_at: string }) => new Date(`${c.exam_date}T${c.starts_at.slice(0, 5)}:00+05:30`);
const endOf = (c: { exam_date: string; starts_at: string; duration_min: number }) => new Date(startOf(c).getTime() + c.duration_min * 60_000);

type Cycle = { id: string; code: string; title: string; exam_date: string; starts_at: string; duration_min: number; requirements_by: string; papers_due: string; release_at: string; status: string; released_at: string | null; keys_released_at: string | null };
async function loadCycle(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('CWT');
  const c = await db.maybeOne<Cycle>(`select id, code, title, exam_date::text, starts_at::text, duration_min, requirements_by::text, papers_due::text, release_at, status, released_at, keys_released_at from cwt_cycle where id = $1`, [id]);
  if (!c) throw notFound('CWT');
  return c;
}

/** Principals of a school (and holders of the given duties there), with their phone and email. */
async function headsOf(t: Db, schoolId: string, duties: string[] = []) {
  return t.query<{ id: string; name: string; phone: string | null; email: string | null; role: string }>(
    `select distinct u.id, u.name, u.phone, u.email, u.role from app_user u join org_unit o on o.id = $1
      where u.active and ((u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path)
         or exists (select 1 from duty d where d.user_id = u.id and d.school_id = o.id and d.code = any($2::text[]) and d.valid @> current_date))`, [schoolId, duties]);
}
const nesCell = (t: Db) => t.query<{ id: string }>(`select id from app_user where active and role = 'NES_ADMIN'`);

// ── Cycles and requirements ───────────────────────────────────────────────────────────────

export async function createCycle(db: Db, actor: Actor, input: { title: string; examDate: string; startsAt?: string; durationMin?: number; requirementsBy: string; papersDue: string; releaseAt?: string }) {
  await assertCan(db, actor, 'cwt.manage');
  if (input.examDate <= localToday()) throw invalid('Choose a test date after today.');
  const year = input.examDate.slice(0, 4);
  const n = (await db.one<{ n: number }>(`select count(*)::int + 1 as n from cwt_cycle where code like $1`, [`CWT-${year}-%`])).n;
  const starts = input.startsAt ?? '10:00';
  // The day before, at the same time as the test, unless NES chooses otherwise.
  const release = input.releaseAt ?? new Date(new Date(`${input.examDate}T${starts}:00+05:30`).getTime() - 24 * 3600_000).toISOString();
  return db.tx((t) => t.one<{ id: string; code: string }>(
    `insert into cwt_cycle (code, title, exam_date, starts_at, duration_min, requirements_by, papers_due, release_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, code`,
    [`CWT-${year}-${n}`, input.title.trim(), input.examDate, starts, input.durationMin ?? 150, input.requirementsBy, input.papersDue, release, actor.id]), { actor: actor.label });
}

/** Cycles a school can send requirements to, or NES's list of all of them. */
export async function cycles(db: Db, actor: Actor) {
  return db.query(
    `select c.id, c.code, c.title, c.exam_date::text, c.starts_at::text, c.duration_min, c.requirements_by::text, c.papers_due::text, c.release_at, c.status,
            (select count(*) from cwt_requirement r where r.cycle_id = c.id and r.status = 'SENT')::int as requirements,
            (select count(*) from cwt_paper p where p.cycle_id = c.id)::int as papers
       from cwt_cycle c where c.status <> 'CANCELLED' or $1 order by c.exam_date desc`, [actor.role === 'NES_ADMIN']);
}

/** A school sends a vacancy's written-test requirement to NES. */
export async function sendRequirement(db: Db, actor: Actor, cycleId: string, vacancyId: string) {
  const c = await loadCycle(db, cycleId);
  const v = await db.maybeOne<{ school_id: string; post_type: string; subject_code: string | null; cwt: boolean; status: string; title: string; school: string }>(
    `select v.school_id, v.post_type, v.subject_code, v.cwt, v.status, v.title, o.name as school from vacancy v join org_unit o on o.id = v.school_id where v.id = $1`, [vacancyId]);
  if (!v) throw notFound('Vacancy');
  await assertCan(db, actor, 'recruitment.manage', v.school_id);
  if (!v.cwt) throw invalid('This vacancy does not have a written test. Turn on “Common Written Test” for it first.');
  if (c.status !== 'OPEN' || c.requirements_by < localToday()) throw conflict('closed', `Requirements for ${c.code} closed on ${fmtDate(c.requirements_by)}.`);
  if (['CANCELLED', 'DRAFT'].includes(v.status)) throw conflict('state', 'Publish the vacancy first.');
  const code = v.subject_code ? `${v.post_type}-${v.subject_code}` : v.post_type;
  return db.tx(async (t) => {
    const p = await t.one<{ id: string }>(`insert into cwt_paper (cycle_id, code, post_type, subject_code) values ($1, $2, $3, $4) on conflict (cycle_id, code) do update set code = excluded.code returning id`,
      [cycleId, code, v.post_type, v.subject_code]);
    const r = await t.maybeOne<{ id: string; status: string }>('select id, status from cwt_requirement where vacancy_id = $1', [vacancyId]);
    if (r?.status === 'SENT') throw conflict('sent', 'This requirement has already been sent.');
    if (r) await t.query(`update cwt_requirement set status = 'SENT', cycle_id = $2, paper_id = $3, sent_by = $4, sent_at = now() where id = $1`, [r.id, cycleId, p.id, actor.id]);
    else await t.query(`insert into cwt_requirement (cycle_id, paper_id, vacancy_id, school_id, sent_by) values ($1,$2,$3,$4,$5)`, [cycleId, p.id, vacancyId, v.school_id, actor.id]);
    await t.query(`insert into cwt_centre (cycle_id, school_id) values ($1, $2) on conflict do nothing`, [cycleId, v.school_id]);
    await notify.toUsers(t, (await nesCell(t)).map((u) => u.id), { kind: 'RECRUITMENT', title: `${c.code}: ${v.school} needs a ${code} paper`, body: v.title, link: `/cwt/${cycleId}` });
    return { paperCode: code };
  }, { actor: actor.label });
}

export async function withdrawRequirement(db: Db, actor: Actor, vacancyId: string) {
  const r = await db.maybeOne<{ id: string; school_id: string; cycle_id: string }>('select id, school_id, cycle_id from cwt_requirement where vacancy_id = $1 and status = $2', [vacancyId, 'SENT']);
  if (!r) throw notFound('Requirement');
  await assertCan(db, actor, 'recruitment.manage', r.school_id);
  if ((await loadCycle(db, r.cycle_id)).released_at) throw conflict('released', 'The papers have already gone to the centres.');
  await db.tx((t) => t.query(`update cwt_requirement set status = 'WITHDRAWN' where id = $1`, [r.id]), { actor: actor.label });
  return { ok: true };
}

/** NES's view of a cycle: every paper, the schools that need it, setter requests and their state. */
export async function cycle(db: Db, actor: Actor, id: string) {
  await assertCan(db, actor, 'cwt.manage');
  const c = await loadCycle(db, id);
  const papers = await db.query<{ id: string; code: string; selected_request_id: string | null }>(
    `select p.id, p.code, p.post_type, pt.name as post, p.subject_code, s.name as subject, p.max_marks, p.selected_request_id,
            coalesce((select jsonb_agg(jsonb_build_object('school', o.name, 'schoolId', o.id, 'vacancy', v.title, 'vacancyId', v.id,
                        'candidates', (select count(*) from job_application a where a.vacancy_id = v.id and a.status = 'CWT')) order by o.name)
               from cwt_requirement r join vacancy v on v.id = r.vacancy_id join org_unit o on o.id = r.school_id where r.paper_id = p.id and r.status = 'SENT'), '[]') as needed_by,
            coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'school', o.name, 'status', q.status, 'dueOn', q.due_on, 'submittedAt', q.submitted_at,
                        'questionName', q.question_name, 'keyName', q.key_name, 'note', q.setter_note, 'score', q.review_score, 'reviewNote', q.review_note) order by q.requested_at)
               from cwt_paper_request q join org_unit o on o.id = q.school_id where q.paper_id = p.id and q.status <> 'CANCELLED'), '[]') as requests,
            (select count(*) from job_application a where a.cwt_paper_id = p.id and a.cwt_roll_no is not null)::int as roll_numbers
       from cwt_paper p join post_type pt on pt.code = p.post_type left join subject s on s.code = p.subject_code where p.cycle_id = $1 order by p.code`, [id]);
  const centres = await db.query(
    `select ce.id, o.name as school, ce.school_id, ce.candidates, ce.released_at, ce.keys_released_at, ce.marks_submitted_at,
            (select count(*) from cwt_download d where d.centre_id = ce.id and d.kind = 'PAPERS')::int as downloads
       from cwt_centre ce join org_unit o on o.id = ce.school_id where ce.cycle_id = $1 and exists (select 1 from cwt_requirement r where r.cycle_id = ce.cycle_id and r.school_id = ce.school_id and r.status = 'SENT') order by o.name`, [id]);
  const blockers = [
    ...papers.filter((p) => !p.selected_request_id).map((p) => `No paper selected for ${p.code}`),
    ...((await db.one<{ n: number }>(`select count(*)::int as n from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT' where r.cycle_id = $1 and a.status = 'CWT' and a.cwt_roll_no is null`, [id])).n
      ? ['Some candidates called for the test have no roll number yet'] : []),
  ];
  return { ...c, startsAtIso: startOf(c).toISOString(), endsAtIso: endOf(c).toISOString(), papers, centres, blockers };
}

// ── Setters ───────────────────────────────────────────────────────────────────────────────

/**
 * Schools that can set a paper: those with the most teachers serving in that post and subject today,
 * leaving out any school testing candidates on the same paper in this cycle.
 */
export async function suggestSetters(db: Db, actor: Actor, paperId: string) {
  await assertCan(db, actor, 'cwt.manage');
  const p = await db.maybeOne<{ cycle_id: string; post_type: string; subject_code: string | null }>('select cycle_id, post_type, subject_code from cwt_paper where id = $1', [paperId]);
  if (!p) throw notFound('Paper');
  return db.query<{ school_id: string; school: string; command: string; teachers: number; requested: boolean; sets_other_papers: number }>(
    `select o.id as school_id, o.name as school, cmd.name as command, count(distinct a.user_id)::int as teachers,
            exists (select 1 from cwt_paper_request q where q.paper_id = $1 and q.school_id = o.id and q.status <> 'CANCELLED') as requested,
            (select count(*) from cwt_paper_request q join cwt_paper p2 on p2.id = q.paper_id where p2.cycle_id = $2 and q.school_id = o.id and q.status in ('REQUESTED', 'SUBMITTED', 'SELECTED'))::int as sets_other_papers
       from post po join appointment a on a.post_id = po.id and a.valid @> current_date join org_unit o on o.id = po.school_id left join org_unit cmd on cmd.id = o.parent_id
      where po.post_type = $3 and ($4::text is null or po.subject_code = $4) and o.active
        and not exists (select 1 from cwt_requirement r where r.paper_id = $1 and r.school_id = o.id and r.status = 'SENT')
      group by o.id, o.name, cmd.name order by teachers desc, sets_other_papers, o.name limit 12`, [paperId, p.cycle_id, p.post_type, p.subject_code]);
}

/** Asks schools for a paper and key (each principal and exam in-charge is told in NavShiksha and by email). */
export async function requestPapers(db: Db, actor: Actor, paperId: string, input: { schoolIds: string[]; dueOn?: string }) {
  await assertCan(db, actor, 'cwt.manage');
  const p = await db.maybeOne<{ cycle_id: string; code: string }>('select cycle_id, code from cwt_paper where id = $1', [paperId]);
  if (!p) throw notFound('Paper');
  const c = await loadCycle(db, p.cycle_id);
  if (c.released_at) throw conflict('released', 'The papers have already been released.');
  const due = input.dueOn ?? c.papers_due;
  if (due < localToday() || due >= c.exam_date) throw invalid('The due date must be from today and before the test.');
  const allowed = new Set((await suggestSetters(db, actor, paperId)).map((s) => s.school_id));
  const bad = input.schoolIds.filter((s) => !allowed.has(s));
  if (bad.length) throw invalid('Ask only schools that have teachers in this post and are not testing on this paper.');
  return db.tx(async (t) => {
    let n = 0;
    for (const s of input.schoolIds) {
      const r = await t.maybeOne<{ id: string }>(`insert into cwt_paper_request (paper_id, school_id, due_on, requested_by) values ($1,$2,$3,$4)
                 on conflict (paper_id, school_id) do update set status = 'REQUESTED', due_on = excluded.due_on where cwt_paper_request.status in ('CANCELLED', 'DECLINED') returning id`, [paperId, s, due, actor.id]);
      if (!r) continue;
      n++;
      const heads = await headsOf(t, s, ['EXAM_INCHARGE']);
      await notify.toUsers(t, heads.map((h) => h.id), { kind: 'RECRUITMENT', title: `NES requests a CWT paper: ${p.code}`, body: `Question paper and answer key by ${fmtDate(due)}.`, link: '/cwt-setter' });
      await messages.queueMany(t, heads.map((h) => ({ template: 'CWT_PAPER_REQUEST_EMAIL', to: h.email, vars: { cycle: c.code, paper: p.code, due: fmtDate(due) }, refId: c.code })), { context: 'CWT', refType: 'cwt_paper_request', schoolId: s, createdBy: actor.id });
    }
    if (c.status === 'OPEN' && c.requirements_by < localToday()) await t.query(`update cwt_cycle set status = 'PAPERS' where id = $1`, [c.id]);
    return { requested: n };
  }, { actor: actor.label });
}

/** One step for the whole cycle: every paper without enough requests is asked of the suggested schools (up to `per`). */
export async function requestAll(db: Db, actor: Actor, cycleId: string, per = 3) {
  const c = await cycle(db, actor, cycleId);
  const out: Record<string, number> = {};
  for (const p of c.papers as unknown as { id: string; code: string; requests: { status: string }[] }[]) {
    const live = p.requests.filter((r) => ['REQUESTED', 'SUBMITTED', 'SELECTED'].includes(r.status)).length;
    if (live >= per) continue;
    // Prefer schools not already setting another paper in this cycle.
    const s = (await suggestSetters(db, actor, p.id)).filter((x) => !x.requested).sort((a, b) => a.sets_other_papers - b.sets_other_papers || b.teachers - a.teachers).slice(0, per - live);
    out[p.code] = s.length ? (await requestPapers(db, actor, p.id, { schoolIds: s.map((x) => x.school_id) })).requested : 0;
  }
  return out;
}

/** The setter school's inbox: what NES has asked of it (not which schools will use the paper). */
export async function setterRequests(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'cwt.setter', schoolId);
  return db.query(
    `select q.id, q.status, q.due_on::text, q.question_name, q.key_name, q.submitted_at, q.setter_note, p.code as paper, pt.name as post, s.name as subject, p.max_marks, c.code as cycle, c.title, c.exam_date::text, c.duration_min
       from cwt_paper_request q join cwt_paper p on p.id = q.paper_id join cwt_cycle c on c.id = p.cycle_id join post_type pt on pt.code = p.post_type left join subject s on s.code = p.subject_code
      where q.school_id = $1 and q.status <> 'CANCELLED' order by c.exam_date desc, p.code`, [schoolId]);
}

async function loadRequest(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Request');
  const q = await db.maybeOne<{ id: string; school_id: string; status: string; due_on: string; paper_id: string; cycle_id: string; code: string }>(
    `select q.id, q.school_id, q.status, q.due_on::text, q.paper_id, p.cycle_id, p.code from cwt_paper_request q join cwt_paper p on p.id = q.paper_id where q.id = $1`, [id]);
  if (!q) throw notFound('Request');
  return q;
}

const fileOf = (f: { name: string; contentType: string; dataBase64: string }) => {
  const data = Buffer.from(f.dataBase64, 'base64');
  if (!FILE_TYPES[f.contentType]) throw invalid('Upload a PDF or Word (.docx) file.');
  if (!data.length || data.length > 15 * 1024 * 1024) throw invalid('Each file is at most 15 MB.');
  const head = data.subarray(0, 4).toString('hex');
  if (!(head === '25504446' || head === '504b0304')) throw invalid('The file does not look like a PDF or Word document.');
  return { name: f.name.replace(/[^\w .()-]/g, '_').slice(0, 100), type: f.contentType, sha: createHash('sha256').update(data).digest('hex'), sealed: sealBytes(data) };
};

/** The setter school uploads its question paper and answer key (they can replace them until the due date). */
export async function submitPaper(db: Db, actor: Actor, requestId: string, input: { question: { name: string; contentType: string; dataBase64: string }; key: { name: string; contentType: string; dataBase64: string }; note?: string }) {
  const q = await loadRequest(db, requestId);
  await assertCan(db, actor, 'cwt.setter', q.school_id);
  if (!['REQUESTED', 'SUBMITTED'].includes(q.status)) throw conflict('state', 'This request is closed.');
  if (q.due_on < localToday()) throw conflict('late', 'The due date has passed. Ask the NES CWT cell to extend it.');
  const qf = fileOf(input.question), kf = fileOf(input.key);
  await db.tx(async (t) => {
    await t.query(`update cwt_paper_request set status = 'SUBMITTED', question_name = $2, question_type = $3, question_sha = $4, question_sealed = $5, key_name = $6, key_type = $7, key_sha = $8, key_sealed = $9,
                   setter_note = $10, submitted_by = $11, submitted_at = now() where id = $1`, [requestId, qf.name, qf.type, qf.sha, qf.sealed, kf.name, kf.type, kf.sha, kf.sealed, input.note?.trim() || null, actor.id]);
    await notify.toUsers(t, (await nesCell(t)).map((u) => u.id), { kind: 'RECRUITMENT', title: `${q.code}: a question paper has been submitted`, link: `/cwt/${q.cycle_id}` });
  }, { actor: actor.label });
  return { status: 'SUBMITTED' };
}

export async function declineRequest(db: Db, actor: Actor, requestId: string, note: string) {
  const q = await loadRequest(db, requestId);
  await assertCan(db, actor, 'cwt.setter', q.school_id);
  if (q.status !== 'REQUESTED') throw conflict('state', 'Only an open request can be declined.');
  await db.tx(async (t) => {
    await t.query(`update cwt_paper_request set status = 'DECLINED', setter_note = $2 where id = $1`, [requestId, note.trim()]);
    await notify.toUsers(t, (await nesCell(t)).map((u) => u.id), { kind: 'RECRUITMENT', title: `${q.code}: a school declined to set the paper`, body: note.trim(), link: `/cwt/${q.cycle_id}` });
  }, { actor: actor.label });
  return { status: 'DECLINED' };
}

/** NES opens a submitted paper or key to review it (recorded). */
export async function reviewFile(db: Db, actor: Actor, requestId: string, which: 'question' | 'key', fromIp?: string) {
  await assertCan(db, actor, 'cwt.manage');
  const q = await db.maybeOne<{ cycle_id: string; name: string; type: string; sealed: Buffer }>(
    `select p.cycle_id, q.${which}_name as name, q.${which}_type as type, q.${which}_sealed as sealed from cwt_paper_request q join cwt_paper p on p.id = q.paper_id where q.id = $1`, [requestId]);
  if (!q?.sealed) throw notFound('File');
  await db.tx((t) => t.query(`insert into cwt_download (cycle_id, request_id, kind, user_id, from_ip) values ($1, $2, 'REVIEW', $3, $4)`, [q.cycle_id, requestId, actor.id, fromIp ?? null]), { actor: actor.label });
  return { name: q.name, type: q.type, data: openBytes(q.sealed) };
}

export async function scoreRequest(db: Db, actor: Actor, requestId: string, input: { score: number; note?: string }) {
  await assertCan(db, actor, 'cwt.manage');
  const q = await loadRequest(db, requestId);
  if (!['SUBMITTED', 'SELECTED', 'NOT_SELECTED'].includes(q.status)) throw conflict('state', 'Nothing has been submitted yet.');
  await db.tx((t) => t.query('update cwt_paper_request set review_score = $2, review_note = $3 where id = $1', [requestId, input.score, input.note?.trim() || null]), { actor: actor.label });
  return { ok: true };
}

/** NES chooses the paper to be used; the other setters are thanked. */
export async function selectPaper(db: Db, actor: Actor, requestId: string, maxMarks?: number) {
  await assertCan(db, actor, 'cwt.manage');
  const q = await loadRequest(db, requestId);
  if (!['SUBMITTED', 'NOT_SELECTED', 'SELECTED'].includes(q.status)) throw conflict('state', 'Choose a submitted paper.');
  if ((await loadCycle(db, q.cycle_id)).released_at) throw conflict('released', 'The papers have already gone to the centres.');
  await db.tx(async (t) => {
    await t.query(`update cwt_paper_request set status = 'NOT_SELECTED' where paper_id = $1 and id <> $2 and status in ('SUBMITTED', 'SELECTED')`, [q.paper_id, requestId]);
    await t.query(`update cwt_paper_request set status = 'SELECTED' where id = $1`, [requestId]);
    await t.query(`update cwt_paper set selected_request_id = $2, max_marks = coalesce($3, max_marks) where id = $1`, [q.paper_id, requestId, maxMarks ?? null]);
  }, { actor: actor.label });
  return { selected: requestId };
}

// ── Roll numbers and admit cards ──────────────────────────────────────────────────────────

/**
 * Gives roll numbers to every candidate the schools have called for the test (status CWT), in
 * school and name order, and sends each an admit card by email and SMS.
 */
export async function assignRollNumbers(db: Db, actor: Actor, cycleId: string) {
  await assertCan(db, actor, 'cwt.manage');
  const c = await loadCycle(db, cycleId);
  if (c.released_at) throw conflict('released', 'The papers have already been released.');
  return db.tx(async (t) => {
    const papers = await t.query<{ id: string; code: string }>('select id, code from cwt_paper where cycle_id = $1 order by code', [cycleId]);
    let n = 0;
    for (const p of papers) {
      const last = (await t.one<{ n: number }>(`select coalesce(max(split_part(cwt_roll_no, '/', 3)::int), 0)::int as n from job_application where cwt_paper_id = $1 and cwt_roll_no is not null`, [p.id])).n;
      const given = await t.query<{ id: string; number: string; name: string; email: string; mobile: string; roll: string; school: string; school_id: string }>(
        `with todo as (select a.id, row_number() over (order by o.code, a.snapshot->>'name', a.number) as k from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT' and r.paper_id = $1
                         join org_unit o on o.id = r.school_id where a.status = 'CWT' and a.cwt_roll_no is null)
         update job_application a set cwt_paper_id = $1, cwt_roll_no = $2 || '/' || $3 || '/' || lpad((todo.k + $4)::text, 5, '0') from todo where a.id = todo.id
         returning a.id, a.number, a.snapshot->>'name' as name, a.snapshot->>'email' as email, a.snapshot->>'mobile' as mobile, a.cwt_roll_no as roll,
                   (select o.name from vacancy v join org_unit o on o.id = v.school_id where v.id = a.vacancy_id) as school, (select v.school_id from vacancy v where v.id = a.vacancy_id) as school_id`,
        [p.id, c.code, p.code, last]);
      n += given.length;
      await messages.queueMany(t, given.flatMap((g) => {
        const vars = { name: g.name, cycle: c.code, rollNo: g.roll, centre: g.school, date: fmtDate(c.exam_date), time: c.starts_at.slice(0, 5), link: `${PUBLIC_URL()}/careers/my` };
        return [{ template: 'ADMIT_CARD_EMAIL', to: g.email, vars, refId: g.number }, { template: 'ADMIT_CARD_SMS', to: g.mobile, vars, refId: g.number }];
      }), { context: 'CWT', refType: 'job_application', createdBy: actor.id });
    }
    await t.query(`update cwt_centre ce set candidates = (select count(*) from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT'
                    where r.cycle_id = ce.cycle_id and r.school_id = ce.school_id and a.cwt_roll_no is not null and a.status not in ('WITHDRAWN', 'REJECTED'))::int where ce.cycle_id = $1`, [cycleId]);
    return { assigned: n };
  }, { actor: actor.label });
}

/** The candidate's admit card (once they have a roll number). */
export async function admitCard(db: Db, actor: Actor, applicationId: string) {
  if (!UUID.test(applicationId)) throw notFound('Admit card');
  const a = await db.maybeOne<{ candidate_id: string; roll: string | null; snapshot: { name: string; candidate_no: string; dob: string; category: string; father_name: string | null; documents: { id: string; kind: string }[] };
    number: string; post: string; paper: string; cycle_id: string; school: string; school_id: string; vacancy_school: string }>(
    `select a.candidate_id, a.cwt_roll_no as roll, a.snapshot, a.number, v.title as post, p.code as paper, p.cycle_id, o.name as school, o.id as school_id, v.school_id as vacancy_school
       from job_application a join vacancy v on v.id = a.vacancy_id join org_unit o on o.id = v.school_id left join cwt_paper p on p.id = a.cwt_paper_id where a.id = $1`, [applicationId]);
  if (!a || (actor.candidateId !== a.candidate_id && !(await can(db, actor, 'recruitment.view', a.vacancy_school)))) throw notFound('Admit card');
  if (!a.roll) throw conflict('not_yet', 'The admit card is issued when NES gives roll numbers.');
  const c = await loadCycle(db, a.cycle_id);
  const addr = (await db.one<{ address: string | null }>(`select coalesce(o.address, (select x.address from org_unit x where x.parent_id = o.id and x.kind = 'campus' order by x.code limit 1)) as address from org_unit o where o.id = $1`, [a.school_id])).address;
  const docs = await db.query<{ kind: string; data: Buffer; content_type: string }>(`select kind, data, content_type from candidate_document where candidate_id = $1 and kind in ('PHOTO', 'SIGNATURE')`, [a.candidate_id]);
  const { doc, fonts: f } = await newDocument(`Admit card ${a.roll}`);
  const s = new Sheet(doc, 210, 148, f);
  const L = 12, W = 186;
  s.rect(L - 2, 8, W + 4, 132, { stroke: NAVY, width: 0.6 });
  s.text('NAVY EDUCATION SOCIETY', L, 12, { size: 13, font: f.serifBold, colour: NAVY, maxWidth: W, align: 'centre' });
  s.text(`Common Written Test ${c.code} · ADMIT CARD`, L, 19, { size: 10, font: f.bold, maxWidth: W, align: 'centre' });
  s.rect(L, 26, W, 0.4, { fill: NAVY });
  const rows: [string, string][] = [['Roll number', a.roll], ['Name', a.snapshot.name], ['Father’s name', a.snapshot.father_name ?? '—'], ['Date of birth', fmtDate(a.snapshot.dob)],
    ['Candidate no.', a.snapshot.candidate_no], ['Application', `${a.number} · ${a.post}`], ['Paper', a.paper], ['Centre', `${a.school}${addr ? `, ${addr}` : ''}`],
    ['Date and time', `${fmtDate(c.exam_date)}, ${c.starts_at.slice(0, 5)} (${c.duration_min} minutes). Report by ${new Date(startOf(c).getTime() - 30 * 60_000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.`]];
  rows.forEach(([k, v], i) => { s.text(k, L, 31 + i * 7.2, { size: 7.5, colour: GREY }); s.text(v, L + 32, 31 + i * 7.2, { size: i === 0 ? 11 : 9.5, font: i < 2 ? f.bold : f.regular, maxWidth: 118 }); });
  const photo = docs.find((d) => d.kind === 'PHOTO'), sign = docs.find((d) => d.kind === 'SIGNATURE');
  s.rect(L + 152, 30, 32, 40, { stroke: GREY });
  const pi = await embedImage(doc, photo?.data, photo?.content_type);
  if (pi) s.image(pi, L + 153, 31, 30, 38);
  s.rect(L + 152, 73, 32, 12, { stroke: GREY });
  const si = await embedImage(doc, sign?.data, sign?.content_type);
  if (si) s.image(si, L + 153, 74, 30, 10);
  s.text('Candidate’s signature', L + 152, 86, { size: 6.5, colour: GREY, maxWidth: 32, align: 'centre' });
  const notes = ['Bring this admit card and an original photo ID (Aadhaar, PAN, passport, driving licence or voter ID).', 'No phones, smart watches, calculators or notes in the hall.',
    'Entry closes at the start time. Sign the attendance sheet in front of the invigilator.', 'Candidature is provisional and subject to verification of every document.'];
  s.text('Instructions', L, 99, { size: 8.5, font: f.bold, colour: NAVY });
  notes.forEach((n, i) => s.text(`${i + 1}. ${n}`, L, 104 + i * 5, { size: 7.8, maxWidth: W }));
  s.text('Invigilator’s signature ____________________', L + 110, 130, { size: 8 });
  return { name: `admit-card-${a.roll.replace(/\//g, '-')}.pdf`, data: Buffer.from(await doc.save()) };
}

// ── Release: papers the day before, keys after the test ───────────────────────────────────

type Centre = { id: string; school_id: string; school: string };
async function centresOf(t: Db, cycleId: string) {
  return t.query<Centre>(`select ce.id, ce.school_id, o.name as school from cwt_centre ce join org_unit o on o.id = ce.school_id
                           where ce.cycle_id = $1 and exists (select 1 from cwt_requirement r where r.cycle_id = ce.cycle_id and r.school_id = ce.school_id and r.status = 'SENT') order by o.name`, [cycleId]);
}

async function centreFiles(t: Db, c: Cycle, centre: Centre, which: 'question' | 'key') {
  const papers = await t.query<{ id: string; code: string; max_marks: number; name: string; type: string; sealed: Buffer }>(
    `select distinct p.id, p.code, p.max_marks, q.${which}_name as name, q.${which}_type as type, q.${which}_sealed as sealed
       from cwt_requirement r join cwt_paper p on p.id = r.paper_id join cwt_paper_request q on q.id = p.selected_request_id
      where r.cycle_id = $1 and r.school_id = $2 and r.status = 'SENT' order by p.code`, [c.id, centre.school_id]);
  const files = [];
  let readme = `${c.title} (${c.code})\nCentre: ${centre.school}\nDate: ${fmtDate(c.exam_date)}, ${c.starts_at.slice(0, 5)}, ${c.duration_min} minutes\n\n`;
  for (const p of papers) {
    const ext = FILE_TYPES[p.type] ?? 'pdf';
    files.push({ name: `${p.code}/${which === 'question' ? 'Question paper' : 'Answer key'} ${p.code}.${ext}`, data: openBytes(p.sealed) });
    if (which === 'question') {
      const cand = await t.query<{ roll: string; name: string; number: string }>(
        `select a.cwt_roll_no as roll, a.snapshot->>'name' as name, a.number from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT'
          where r.cycle_id = $1 and r.school_id = $2 and a.cwt_paper_id = $3 and a.cwt_roll_no is not null and a.status not in ('WITHDRAWN', 'REJECTED') order by a.cwt_roll_no`, [c.id, centre.school_id, p.id]);
      const q = (x: string) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
      files.push({ name: `${p.code}/Attendance ${p.code}.csv`, data: Buffer.from(['Roll number,Name,Application,Present (Y/N),Signature,Answer booklet no.', ...cand.map((x) => [x.roll, q(x.name), x.number, '', '', ''].join(','))].join('\r\n') + '\r\n') });
      readme += `${p.code}: ${cand.length} candidates, maximum marks ${p.max_marks}. Print one copy per candidate plus two spare.\n`;
    } else readme += `${p.code}: answer key for marking. Enter marks in NavShiksha → CWT, out of ${p.max_marks}.\n`;
  }
  readme += which === 'question'
    ? '\nKeep the printed papers sealed until the start time. Do not copy or forward this file. Every download is recorded.\n'
    : '\nThe answer keys are confidential until the results are declared.\n';
  files.push({ name: 'READ ME.txt', data: Buffer.from(readme) });
  return files;
}

/** Builds each centre's protected file and sends the password to its principal by SMS (the file itself is downloaded in NavShiksha). */
async function releaseKind(t: Db, c: Cycle, which: 'question' | 'key', by: string | null) {
  let n = 0;
  for (const centre of await centresOf(t, c.id)) {
    const password = zipPassword();
    const zip = encryptedZip(await centreFiles(t, c, centre, which), password);
    if (which === 'question') await t.query(`update cwt_centre set papers_zip = $2, papers_password = $3, papers_sha = $4, released_at = now() where id = $1`, [centre.id, zip, seal(password), createHash('sha256').update(zip).digest('hex')]);
    else await t.query(`update cwt_centre set keys_zip = $2, keys_password = $3, keys_released_at = now() where id = $1`, [centre.id, zip, seal(password)]);
    const heads = (await headsOf(t, centre.school_id)).filter((h) => h.role === 'SCHOOL_ADMIN');
    await messages.queueMany(t, heads.flatMap((h) => [
      { template: 'CWT_PASSWORD_SMS', to: h.phone, vars: { cycle: `${c.code}${which === 'key' ? ' answer keys' : ''}`, centre: centre.school, password }, refId: c.code },
      { template: 'CWT_RELEASED_EMAIL', to: h.email, vars: { cycle: `${c.code}${which === 'key' ? ' (answer keys)' : ''}`, centre: centre.school, date: fmtDate(c.exam_date) }, refId: c.code },
    ]), { context: 'CWT', refType: 'cwt_centre', schoolId: centre.school_id, createdBy: by });
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'RECRUITMENT', title: which === 'question' ? `${c.code}: question papers ready to download` : `${c.code}: answer keys ready for marking`,
      body: 'The password has been sent to your mobile by SMS.', link: '/cwt-centre' });
    if (!heads.some((h) => h.phone)) await notify.toUsers(t, (await nesCell(t)).map((u) => u.id), { kind: 'RECRUITMENT', title: `${c.code}: ${centre.school} has no principal’s mobile for the password`, link: `/cwt/${c.id}` });
    n++;
  }
  return n;
}

/** Releases the question papers now (NES), if everything is in place; normally done by the clock. */
export async function release(db: Db, actor: Actor | null, cycleId: string, now = new Date()) {
  if (actor) await assertCan(db, actor, 'cwt.manage');
  const c = await loadCycle(db, cycleId);
  if (c.released_at) throw conflict('released', 'Already released.');
  if (!['OPEN', 'PAPERS'].includes(c.status)) throw conflict('state', 'This test is not waiting for release.');
  if (now.getTime() < new Date(c.release_at).getTime() - 12 * 3600_000) throw conflict('early', `Papers are released from ${new Date(c.release_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (at most 12 hours earlier by NES).`);
  const cy = actor ? await cycle(db, actor, cycleId) : null;
  const blockers = cy?.blockers ?? (await db.query<{ code: string }>(`select code from cwt_paper where cycle_id = $1 and selected_request_id is null`, [cycleId])).map((p) => `No paper selected for ${p.code}`);
  if (blockers.length) throw conflict('not_ready', blockers.join('; '));
  return db.tx(async (t) => {
    const n = await releaseKind(t, c, 'question', actor?.id ?? null);
    await t.query(`update cwt_cycle set status = 'RELEASED', released_at = now() where id = $1`, [cycleId]);
    return { centres: n };
  }, { actor: actor?.label ?? 'cwt-clock' });
}

/** Runs every minute: releases papers that are due, and answer keys once a test has ended. */
export async function releaseDue(db: Db, now = new Date()) {
  const due = await db.query<{ id: string; code: string }>(`select id, code from cwt_cycle where status in ('OPEN', 'PAPERS') and released_at is null and release_at <= $1`, [now.toISOString()]);
  const out: string[] = [];
  for (const c of due) {
    try { await release(db, null, c.id, now); out.push(`${c.code}: papers`); }
    catch (e) {
      // Not ready at release time: tell the NES cell (once an hour at most).
      const recent = await db.maybeOne(`select 1 from notification where kind = 'RECRUITMENT' and title like $1 and created_at > now() - interval '1 hour'`, [`${c.code}: papers not released%`]);
      if (!recent) await db.tx(async (t) => notify.toUsers(t, (await nesCell(t)).map((u) => u.id), { kind: 'RECRUITMENT', title: `${c.code}: papers not released`, body: (e as Error).message, link: `/cwt/${c.id}` }), { actor: 'cwt-clock' });
    }
  }
  const ended = await db.query<Cycle>(`select id, code, title, exam_date::text, starts_at::text, duration_min, requirements_by::text, papers_due::text, release_at, status, released_at, keys_released_at
                                         from cwt_cycle where status = 'RELEASED' and keys_released_at is null`);
  for (const c of ended.filter((x) => endOf(x) <= now)) {
    await db.tx(async (t) => { await releaseKind(t, c, 'key', null); await t.query(`update cwt_cycle set status = 'HELD', keys_released_at = now() where id = $1`, [c.id]); }, { actor: 'cwt-clock' });
    out.push(`${c.code}: keys`);
  }
  return out;
}

// ── The centre ────────────────────────────────────────────────────────────────────────────

export async function centreView(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'cwt.centre', schoolId);
  return db.query(
    `select c.id as cycle_id, c.code, c.title, c.exam_date::text, c.starts_at::text, c.duration_min, c.status, c.release_at, ce.candidates, ce.released_at, ce.keys_released_at, ce.marks_submitted_at,
            coalesce((select jsonb_agg(jsonb_build_object('code', p.code, 'maxMarks', p.max_marks, 'vacancy', v.title, 'candidates',
                        (select count(*) from job_application a where a.vacancy_id = v.id and a.cwt_roll_no is not null)::int,
                        'marked', (select count(*) from job_application a where a.vacancy_id = v.id and a.cwt_roll_no is not null and (a.cwt_raw is not null or a.cwt_absent))::int) order by p.code)
               from cwt_requirement r join cwt_paper p on p.id = r.paper_id join vacancy v on v.id = r.vacancy_id where r.cycle_id = c.id and r.school_id = ce.school_id and r.status = 'SENT'), '[]') as papers
       from cwt_centre ce join cwt_cycle c on c.id = ce.cycle_id where ce.school_id = $1 and exists (select 1 from cwt_requirement r where r.cycle_id = c.id and r.school_id = ce.school_id and r.status = 'SENT')
      order by c.exam_date desc`, [schoolId]);
}

/** The centre downloads its protected file (recorded). The password is never shown here. */
export async function centreDownload(db: Db, actor: Actor, schoolId: string, cycleId: string, kind: 'PAPERS' | 'KEYS', fromIp?: string) {
  await assertCan(db, actor, 'cwt.centre', schoolId);
  const ce = await db.maybeOne<{ id: string; papers_zip: Buffer | null; keys_zip: Buffer | null; code: string }>(
    `select ce.id, ce.papers_zip, ce.keys_zip, c.code from cwt_centre ce join cwt_cycle c on c.id = ce.cycle_id where ce.cycle_id = $1 and ce.school_id = $2`, [cycleId, schoolId]);
  const zip = kind === 'PAPERS' ? ce?.papers_zip : ce?.keys_zip;
  if (!ce || !zip) throw notFound(kind === 'PAPERS' ? 'Question papers (not released yet)' : 'Answer keys (released after the test)');
  await db.tx((t) => t.query(`insert into cwt_download (cycle_id, centre_id, kind, user_id, from_ip) values ($1, $2, $3, $4, $5)`, [cycleId, ce.id, kind, actor.id, fromIp ?? null]), { actor: actor.label });
  return { name: `${ce.code} ${kind === 'PAPERS' ? 'question papers' : 'answer keys'}.zip`, data: Buffer.from(zip) };
}

/** The password again, by SMS to the principal only (recorded; at most three times). */
export async function resendPassword(db: Db, actor: Actor, schoolId: string, cycleId: string, kind: 'PAPERS' | 'KEYS') {
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('Only the principal can ask for the password again.');
  await assertCan(db, actor, 'cwt.centre', schoolId);
  const ce = await db.maybeOne<{ id: string; pw: string | null; code: string; school: string }>(
    `select ce.id, ${kind === 'PAPERS' ? 'ce.papers_password' : 'ce.keys_password'} as pw, c.code, o.name as school from cwt_centre ce join cwt_cycle c on c.id = ce.cycle_id join org_unit o on o.id = ce.school_id where ce.cycle_id = $1 and ce.school_id = $2`, [cycleId, schoolId]);
  if (!ce?.pw) throw notFound('Password (not released yet)');
  const sent = (await db.one<{ n: number }>(`select count(*)::int as n from cwt_download where centre_id = $1 and kind = 'PASSWORD_RESENT'`, [ce.id])).n;
  if (sent >= 3) throw conflict('limit', 'The password has been sent three times. Ask the NES CWT cell.');
  const phone = (await db.one<{ phone: string | null }>('select phone from app_user where id = $1', [actor.id])).phone;
  if (!phone) throw invalid('Your mobile number is not in NavShiksha. Ask the NES CWT cell.');
  await db.tx(async (t) => {
    await t.query(`insert into cwt_download (cycle_id, centre_id, kind, user_id) values ($1, $2, 'PASSWORD_RESENT', $3)`, [cycleId, ce.id, actor.id]);
    await messages.queue(t, { template: 'CWT_PASSWORD_SMS', to: phone, vars: { cycle: `${ce.code}${kind === 'KEYS' ? ' answer keys' : ''}`, centre: ce.school, password: unseal(ce.pw!) }, context: 'CWT', refType: 'cwt_centre', refId: ce.code, schoolId, createdBy: actor.id });
  }, { actor: actor.label });
  return { sentTo: `•••••${phone.slice(-4)}` };
}

/** The centre's candidates, for marks entry. */
export async function centreCandidates(db: Db, actor: Actor, schoolId: string, cycleId: string) {
  await assertCan(db, actor, 'cwt.centre', schoolId);
  return db.query(
    `select a.id, a.cwt_roll_no as roll, a.snapshot->>'name' as name, a.number, p.code as paper, p.max_marks, a.cwt_raw::float as raw, a.cwt_absent as absent, a.status
       from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT' join cwt_paper p on p.id = a.cwt_paper_id
      where r.cycle_id = $1 and r.school_id = $2 and a.cwt_roll_no is not null order by a.cwt_roll_no`, [cycleId, schoolId]);
}

/**
 * Marks by roll number (typed in or from the marking spreadsheet). They become the written-test
 * score out of 100 on each application, and merit is worked out again.
 */
export async function enterMarks(db: Db, actor: Actor, schoolId: string, cycleId: string, rows: { roll: string; marks?: number | null; absent?: boolean }[], now = new Date()) {
  await assertCan(db, actor, 'cwt.centre', schoolId);
  const c = await loadCycle(db, cycleId);
  if (endOf(c) > now) throw conflict('early', 'Marks are entered after the test.');
  const mine = new Map((await centreCandidates(db, actor, schoolId, cycleId) as { id: string; roll: string; max_marks: number }[]).map((x) => [x.roll, x]));
  const bad = rows.filter((r) => !mine.has(r.roll.trim())).map((r) => r.roll);
  if (bad.length) throw invalid(`Not candidates at your centre: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`);
  for (const r of rows) { const m = mine.get(r.roll.trim())!; if (!r.absent && (r.marks === undefined || r.marks === null || r.marks < 0 || r.marks > m.max_marks)) throw invalid(`${r.roll}: marks must be between 0 and ${m.max_marks}, or mark absent.`); }
  return db.tx(async (t) => {
    await t.query(
      `update job_application a set cwt_raw = case when x.absent then null else x.marks end, cwt_absent = x.absent,
              cwt_marks = case when x.absent then 0 else round(x.marks * 100.0 / p.max_marks, 2) end
         from jsonb_to_recordset($1::jsonb) as x(roll text, marks numeric, absent boolean), cwt_paper p where a.cwt_roll_no = x.roll and p.id = a.cwt_paper_id`,
      [JSON.stringify(rows.map((r) => ({ roll: r.roll.trim(), marks: r.absent ? null : r.marks, absent: !!r.absent })))]);
    const vac = await t.query<{ vacancy_id: string }>(`select distinct vacancy_id from cwt_requirement where cycle_id = $1 and school_id = $2 and status = 'SENT'`, [cycleId, schoolId]);
    for (const v of vac) await recomputeMerit(t, v.vacancy_id);
    const left = (await t.one<{ n: number }>(`select count(*)::int as n from job_application a join cwt_requirement r on r.vacancy_id = a.vacancy_id and r.status = 'SENT'
                                              where r.cycle_id = $1 and r.school_id = $2 and a.cwt_roll_no is not null and a.cwt_raw is null and not a.cwt_absent`, [cycleId, schoolId])).n;
    if (!left) await t.query(`update cwt_centre set marks_submitted_at = coalesce(marks_submitted_at, now()) where cycle_id = $1 and school_id = $2`, [cycleId, schoolId]);
    if (!left && !(await t.maybeOne(`select 1 from cwt_centre ce where ce.cycle_id = $1 and ce.marks_submitted_at is null and exists (select 1 from cwt_requirement r where r.cycle_id = ce.cycle_id and r.school_id = ce.school_id and r.status = 'SENT')`, [cycleId])))
      await t.query(`update cwt_cycle set status = 'RESULTS' where id = $1 and status = 'HELD'`, [cycleId]);
    return { saved: rows.length, remaining: left };
  }, { actor: actor.label });
}

/** Who downloaded what, and when. */
export async function downloads(db: Db, actor: Actor, cycleId: string) {
  await assertCan(db, actor, 'cwt.manage');
  return db.query(`select d.kind, d.at, d.from_ip, u.name as by, o.name as school from cwt_download d join app_user u on u.id = d.user_id left join cwt_centre ce on ce.id = d.centre_id left join org_unit o on o.id = ce.school_id
                    where d.cycle_id = $1 order by d.at desc limit 500`, [cycleId]);
}
