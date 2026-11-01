import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as cwt from '../src/modules/cwt.js';
import * as recruitment from '../src/modules/recruitment.js';
import * as staff from '../src/modules/staff.js';
import * as messages from '../src/modules/messages.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { makeWorld, rejects, type World } from './helpers.js';

/**
 * The Common Written Test: requirements from schools, papers from other schools that have teachers
 * in the post, NES's choice, roll numbers and admit cards, papers to each centre the day before in
 * a password-protected file with the password by SMS, keys after the test, marks into merit.
 */

let w: World;
let schoolC: string, principalB: Actor, principalC: Actor;
let cycleId: string, vacancyId: string, paperId: string;
const PDF = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const up = (name: string, text: string) => ({ name, contentType: 'application/pdf', dataBase64: PDF(text).toString('base64') });

async function teachers(principal: Actor, schoolId: string, n: number) {
  await staff.addPost(w.db, principal, schoolId, { postType: 'TGT', subjectCode: 'MAT', payLevel: 7, from: '2026-04-01', orderRef: 'NES/EST/1', count: n });
  const posts = (await staff.posts(w.db, principal, schoolId) as unknown as { id: string; post_type: string; holder: string | null }[]).filter((p) => p.post_type === 'TGT' && !p.holder);
  for (const [i, p] of posts.entries()) await staff.enrol(w.db, principal, schoolId, { name: `Maths Teacher ${schoolId.slice(0, 4)}${i}`, category: 'TEACHING', employment: 'PERMANENT', joinedService: '2026-04-01', orderRef: `EST/${i}`, postId: p.id });
}

beforeAll(async () => {
  w = await makeWorld();
  const wnc = (await w.db.one<{ parent_id: string }>('select parent_id from org_unit where id = $1', [w.schoolA])).parent_id;
  schoolC = (await w.db.one<{ id: string }>(`insert into org_unit (kind, code, name, parent_id, school_type) values ('school', 'NCS-C', 'NCS Charlie', $1, 'NCS') returning id`, [wnc])).id;
  await w.db.query(`insert into org_unit (kind, code, name, parent_id, address) values ('campus', 'NCS-C-1', 'Charlie Main', $1, 'Charlie Road')`, [schoolC]);
  const mk = async (name: string, scope: string, phone: string) => loadActor(w.db, (await w.db.one<{ id: string }>(
    `insert into app_user (name, role, designation, scope_path, phone, email) values ($1, 'SCHOOL_ADMIN', 'Principal', $2, $3, $4) returning id`, [name, scope, phone, `${name.split(' ')[1].toLowerCase()}@ncs.example`])).id);
  principalB = await mk('Principal Bravo', 'nes.enc.ncs_b', '+919811100002');
  principalC = await mk('Principal Charlie', 'nes.wnc.ncs_c', '+919811100003');
  await w.db.query(`update app_user set phone = '+919811100001', email = 'alpha@ncs.example' where id = $1`, [w.principalA.id]);
  await teachers(principalB, w.schoolB, 3);
  await teachers(principalC, schoolC, 1);
  await teachers(w.principalA, w.schoolA, 2);                                      // Alpha has teachers too, but is testing on this paper
  // Alpha's TGT Maths vacancy with a written test, and 40 applicants called for it.
  const v = await recruitment.createVacancy(w.db, w.principalA, w.schoolA, { postType: 'TGT', subjectCode: 'MAT', employment: 'CONTRACT', positions: 2, opensOn: '2026-10-01', closesOn: '2026-10-31', cwt: true, fees: { GEN: 0 } });
  vacancyId = v.id;
  await recruitment.publishVacancy(w.db, w.principalA, v.id);
  await w.db.query(`insert into candidate (email, mobile, name, dob, gender) select 'k' || g || '@example.in', '+91' || (8100000000 + g)::text, 'Applicant ' || lpad(g::text, 2, '0'), '1995-01-01', 'F' from generate_series(1, 40) g`);
  await w.db.query(`insert into job_application (vacancy_id, candidate_id, snapshot, eligibility, category, gender, age_years, qual_pct, search, fee_status, status, declared_at)
    select $1, c.id, jsonb_build_object('name', c.name, 'email', c.email, 'mobile', c.mobile, 'candidate_no', c.candidate_no, 'dob', '1995-01-01'), '[]', 'GEN', 'F', 31, 60 + (row_number() over (order by c.name))::int % 30, lower(c.name), 'NOT_REQUIRED', 'SUBMITTED', now()
      from candidate c where c.email like 'k%@example.in'`, [v.id]);
  await recruitment.bulkAction(w.db, w.principalA, v.id, { filter: {}, action: 'CWT' });
}, 60_000);

describe('requirements', () => {
  it('NES opens a cycle and a school sends its vacancy; vacancies for the same post share a paper', async () => {
    await rejects(cwt.createCycle(w.db, w.principalA, { title: 'CWT November 2026', examDate: '2026-11-22', requirementsBy: '2026-10-25', papersDue: '2026-11-10' }), /not part of your role/);
    const c = await cwt.createCycle(w.db, w.admin, { title: 'CWT November 2026', examDate: '2026-11-22', requirementsBy: '2026-10-25', papersDue: '2026-11-10' });
    cycleId = c.id;
    expect(c.code).toBe('CWT-2026-1');
    const r = await cwt.sendRequirement(w.db, w.principalA, cycleId, vacancyId);
    expect(r.paperCode).toBe('TGT-MAT');
    await rejects(cwt.sendRequirement(w.db, w.principalA, cycleId, vacancyId), /already been sent/);
    const view = await cwt.cycle(w.db, w.admin, cycleId);
    expect(view.papers).toHaveLength(1);
    paperId = (view.papers[0] as { id: string }).id;
    expect((view.papers[0] as unknown as { needed_by: { school: string; candidates: number }[] }).needed_by).toEqual([expect.objectContaining({ school: 'NCS Alpha', candidates: 40 })]);
    expect(view.blockers).toContain('No paper selected for TGT-MAT');
  });
});

describe('question papers from other schools', () => {
  let reqB: string, reqC: string;
  it('suggests schools with teachers in that post, never one testing on the paper, and asks them all in one step', async () => {
    const s = await cwt.suggestSetters(w.db, w.admin, paperId);
    expect(s.map((x) => [x.school, x.teachers])).toEqual([['NCS Bravo', 3], ['NCS Charlie', 1]]);
    await rejects(cwt.requestPapers(w.db, w.admin, paperId, { schoolIds: [w.schoolA] }), /not testing on this paper/);
    const r = await cwt.requestAll(w.db, w.admin, cycleId, 3);
    expect(r).toEqual({ 'TGT-MAT': 2 });
    const emails = await w.db.query<{ to_address: string }>(`select to_address from outbound_message where template_code = 'CWT_PAPER_REQUEST_EMAIL' order by to_address`);
    expect(emails.map((e) => e.to_address)).toEqual(['bravo@ncs.example', 'charlie@ncs.example']);
    const inbox = await cwt.setterRequests(w.db, principalB, w.schoolB) as { id: string; paper: string }[];
    expect(inbox).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toMatch(/Alpha/);                                  // setters are not told who will use the paper
    reqB = inbox[0].id;
    reqC = (await cwt.setterRequests(w.db, principalC, schoolC) as { id: string }[])[0].id;
    await rejects(cwt.setterRequests(w.db, principalB, schoolC), /outside your access/);
  });

  it('keeps uploads encrypted; NES reviews them (recorded) and selects the best', async () => {
    await rejects(cwt.submitPaper(w.db, principalB, reqB, { question: { name: 'q.exe', contentType: 'application/x-msdownload', dataBase64: 'TVqQ' }, key: up('k.pdf', 'k') }), /PDF or Word/);
    await cwt.submitPaper(w.db, principalB, reqB, { question: up('TGT Maths paper.pdf', 'Bravo question paper'), key: up('Key.pdf', 'Bravo answer key'), note: 'Two sets of 75 questions' });
    await cwt.submitPaper(w.db, principalC, reqC, { question: up('Paper C.pdf', 'Charlie question paper'), key: up('Key C.pdf', 'Charlie answer key') });
    const raw = await w.db.one<{ question_sealed: Buffer }>('select question_sealed from cwt_paper_request where id = $1', [reqB]);
    expect(Buffer.from(raw.question_sealed).toString('latin1')).not.toContain('Bravo question paper');
    await rejects(cwt.reviewFile(w.db, principalB, reqC, 'question'), /not part of your role/);
    const f = await cwt.reviewFile(w.db, w.admin, reqB, 'question', '10.0.0.5');
    expect(f.data.toString()).toContain('Bravo question paper');
    await cwt.scoreRequest(w.db, w.admin, reqB, { score: 5, note: 'Balanced; covers the syllabus' });
    await cwt.scoreRequest(w.db, w.admin, reqC, { score: 3 });
    await cwt.selectPaper(w.db, w.admin, reqB, 150);
    const st = await w.db.query<{ status: string }>(`select status from cwt_paper_request where paper_id = $1 order by status`, [paperId]);
    expect(st.map((x) => x.status)).toEqual(['NOT_SELECTED', 'SELECTED']);
    expect((await cwt.downloads(w.db, w.admin, cycleId) as { kind: string }[]).map((d) => d.kind)).toEqual(['REVIEW']);
  });
});

describe('roll numbers and admit cards', () => {
  it('numbers the called candidates and sends each an admit card', async () => {
    const r = await cwt.assignRollNumbers(w.db, w.admin, cycleId);
    expect(r.assigned).toBe(40);
    expect((await cwt.assignRollNumbers(w.db, w.admin, cycleId)).assigned).toBe(0);    // only once
    const first = await w.db.one<{ id: string; cwt_roll_no: string }>(`select id, cwt_roll_no from job_application where vacancy_id = $1 order by cwt_roll_no limit 1`, [vacancyId]);
    expect(first.cwt_roll_no).toBe('CWT-2026-1/TGT-MAT/00001');
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from outbound_message where template_code in ('ADMIT_CARD_EMAIL', 'ADMIT_CARD_SMS')`)).n).toBe(80);
    const pdf = await cwt.admitCard(w.db, w.principalA, first.id);
    expect(pdf.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await cwt.cycle(w.db, w.admin, cycleId)).blockers).toEqual([]);
  });
});

describe('release', () => {
  it('waits for the release time, then gives each centre a protected file and sends the password only by SMS', async () => {
    await rejects(cwt.release(w.db, w.admin, cycleId, new Date('2026-11-01T10:00:00+05:30')), /released from/);
    expect(await cwt.releaseDue(w.db, new Date('2026-11-21T09:59:00+05:30'))).toEqual([]);
    expect(await cwt.releaseDue(w.db, new Date('2026-11-21T10:00:00+05:30'))).toEqual(['CWT-2026-1: papers']);
    const sms = await w.db.one<{ to_address: string; body: string }>(`select to_address, body from outbound_message where template_code = 'CWT_PASSWORD_SMS'`);
    expect(sms.to_address).toBe('+919811100001');                                        // Alpha's principal only
    const password = sms.body.match(/is (\S+)\. Do not/)![1];
    expect((await w.db.query(`select 1 from outbound_message where template_code = 'CWT_RELEASED_EMAIL' and body like $1`, [`%${password}%`])).length).toBe(0);   // never by email
    await rejects(cwt.centreDownload(w.db, principalB, w.schoolB, cycleId, 'PAPERS'), /not released yet/);
    await rejects(cwt.centreDownload(w.db, w.teacherA, w.schoolA, cycleId, 'PAPERS'), /not part of your role/);
    const z = await cwt.centreDownload(w.db, w.principalA, w.schoolA, cycleId, 'PAPERS', '10.1.1.1');
    // The file opens with the password (the same AES-256 zip 7-Zip and WinRAR read) and holds the paper and the attendance sheet.
    const dir = mkdtempSync(join(tmpdir(), 'cwt-'));
    writeFileSync(join(dir, 'p.zip'), z.data);
    expect(() => execFileSync('bsdtar', ['-xf', join(dir, 'p.zip'), '--passphrase', 'wrong-password', '-C', dir], { stdio: 'pipe' })).toThrow();
    execFileSync('bsdtar', ['-xf', join(dir, 'p.zip'), '--passphrase', password, '-C', dir]);
    expect(readFileSync(join(dir, 'TGT-MAT', 'Question paper TGT-MAT.pdf'), 'utf8')).toContain('Bravo question paper');
    const att = readFileSync(join(dir, 'TGT-MAT', 'Attendance TGT-MAT.csv'), 'utf8').trim().split('\r\n');
    expect(att).toHaveLength(41);
    expect(att[1]).toMatch(/^CWT-2026-1\/TGT-MAT\/00001,Applicant/);
    expect(readFileSync(join(dir, 'READ ME.txt'), 'utf8')).toMatch(/40 candidates, maximum marks 150/);
    // Requirements and paper choices are frozen once released.
    await rejects(cwt.withdrawRequirement(w.db, w.principalA, vacancyId), /already gone/);
    await rejects(cwt.selectPaper(w.db, w.admin, (await w.db.one<{ id: string }>(`select id from cwt_paper_request where status = 'NOT_SELECTED'`)).id), /already gone/);
    // The principal can have the password sent again, to their own mobile; each time is recorded.
    expect((await cwt.resendPassword(w.db, w.principalA, w.schoolA, cycleId, 'PAPERS')).sentTo).toBe('•••••0001');
    const log = (await cwt.downloads(w.db, w.admin, cycleId) as { kind: string; school: string | null }[]).map((d) => d.kind);
    expect(log).toEqual(['PASSWORD_RESENT', 'PAPERS', 'REVIEW']);
  });

  it('never shows the password in the email and SMS log, and wipes it once sent', async () => {
    const log = await messages.log(w.db, w.admin, { context: 'CWT' }) as { template_code: string; body: string }[];
    const pw = log.filter((m) => m.template_code === 'CWT_PASSWORD_SMS');
    expect(pw.length).toBeGreaterThan(0);
    expect(pw.every((m) => m.body.startsWith('[hidden'))).toBe(true);
    await messages.dispatch(w.db, 5000);
    const stored = await w.db.query<{ body: string }>(`select body from outbound_message where template_code = 'CWT_PASSWORD_SMS'`);
    expect(stored.every((m) => m.body.startsWith('[hidden'))).toBe(true);
    // The centre can still have it sent again: it is kept sealed, apart from the message.
    expect((await cwt.resendPassword(w.db, w.principalA, w.schoolA, cycleId, 'PAPERS')).sentTo).toBe('•••••0001');
  });

  it('sends the answer keys after the test, then takes marks into merit', async () => {
    expect(await cwt.releaseDue(w.db, new Date('2026-11-22T12:00:00+05:30'))).toEqual([]);    // still in the hall
    expect(await cwt.releaseDue(w.db, new Date('2026-11-22T12:31:00+05:30'))).toEqual(['CWT-2026-1: keys']);
    expect((await cwt.centreDownload(w.db, w.principalA, w.schoolA, cycleId, 'KEYS')).data.length).toBeGreaterThan(100);
    const list = await cwt.centreCandidates(w.db, w.principalA, w.schoolA, cycleId) as { roll: string }[];
    await rejects(cwt.enterMarks(w.db, w.principalA, w.schoolA, cycleId, [{ roll: list[0].roll, marks: 151 }], new Date('2026-11-23')), /between 0 and 150/);
    await rejects(cwt.enterMarks(w.db, w.principalA, w.schoolA, cycleId, [{ roll: 'CWT-2026-1/TGT-MAT/99999', marks: 10 }], new Date('2026-11-23')), /Not candidates/);
    const r = await cwt.enterMarks(w.db, w.principalA, w.schoolA, cycleId, list.map((x, i) => (i === 39 ? { roll: x.roll, absent: true } : { roll: x.roll, marks: 60 + i * 2 })), new Date('2026-11-23'));
    expect(r.remaining).toBe(0);
    const top = (await recruitment.applications(w.db, w.principalA, vacancyId, { status: ['CWT'] }, 'cwt', 1, 10)).rows[0] as { cwt_marks: number; merit: number };
    expect(top.cwt_marks).toBeCloseTo((60 + 38 * 2) * 100 / 150, 2);
    expect(top.merit).toBeGreaterThan(0);
    expect((await w.db.one<{ status: string }>('select status from cwt_cycle where id = $1', [cycleId])).status).toBe('RESULTS');
    // The school then takes the top scorers to interview with the usual filter.
    expect((await recruitment.bulkAction(w.db, w.principalA, vacancyId, { filter: { minCwtMarks: 80 }, action: 'INTERVIEW' })).changed).toBeGreaterThan(0);
  });
});
