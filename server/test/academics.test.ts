import { beforeAll, describe, expect, it } from 'vitest';
import * as academics from '../src/modules/academics.js';
import * as awards from '../src/modules/awards.js';
import * as studentApp from '../src/modules/studentApp.js';
import * as reportCards from '../src/modules/reportCards.js';
import { PDFDocument } from 'pdf-lib';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';

let w: World;
let kids: Awaited<ReturnType<typeof family>>[];   // three children in X-A
let other: Awaited<ReturnType<typeof family>>;    // a child at school B
let principalB: Actor;
let hy = '';

const user = async (name: string, role: string, scope: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3::ltree) returning id`, [name, role, scope])).id);

beforeAll(async () => {
  w = await makeWorld();
  kids = [await family(w, { classCode: 'X', section: 0 }), await family(w, { classCode: 'X', section: 0 }), await family(w, { classCode: 'X', section: 0 })];
  other = await family(w, { classCode: 'X', section: 0 });
  await w.db.query(`update enrolment set school_id = $1, campus_id = $2, section_id = (select id from section where campus_id = $2 and class_code = 'X' and name = 'A') where student_id = $3`,
    [w.schoolB, w.campusB, other.studentId]);
  principalB = await user('Principal Bravo', 'SCHOOL_ADMIN', 'nes.enc.ncs_b');
  // Teacher Alpha teaches maths to X-A (their own class) as well as X-B.
  const tt = await w.db.one<{ id: string }>(`insert into timetable (section_id, valid, created_by) values ($1, daterange('2026-04-01', null), $2) returning id`, [w.sectionsA.X[0], w.teacherA.id]);
  await w.db.query(`insert into timetable_slot (timetable_id, weekday, period, starts, ends, subject_code, teacher_id) values ($1, 2, 2, '08:40', '09:20', 'MAT', $2)`, [tt.id, w.teacherA.id]);
});

const fill = async (actor: Actor, sectionId: string, subject: string, scores: (number | null)[]) => {
  const sheet = await academics.sheet(w.db, actor, hy, sectionId, subject) as unknown as { students: { enrolment_id: string }[] };
  return academics.saveMarks(w.db, actor, hy, sectionId, subject,
    sheet.students.map((s, i) => ({ enrolmentId: s.enrolment_id, marks: scores[i % scores.length], absent: scores[i % scores.length] === null })));
};

describe('assessments and marks', () => {
  it('creates an exam from the NES plan with papers for every class', async () => {
    const r = await academics.createFromPlan(w.db, w.principalA, w.schoolA, YEAR, 'HY');
    hy = r.id;
    const papers = await academics.papers(w.db, w.principalA, hy) as { class_code: string; subject_code: string; max_marks: number }[];
    expect(papers.filter((p) => p.class_code === 'X').map((p) => p.subject_code).sort()).toEqual(['CS', 'ENG', 'HIN', 'MAT', 'SCI', 'SST']);
    expect(papers[0].max_marks).toBe(80);
    await rejects(academics.createFromPlan(w.db, w.principalA, w.schoolA, YEAR, 'HY'), /already exists/);
  });

  it('accepts marks only while open, never above the maximum, and only from those who teach', async () => {
    await rejects(fill(w.principalA, w.sectionsA.X[0], 'MAT', [50]), /draft/);
    await academics.open(w.db, w.principalA, hy);
    await rejects(fill(w.teacherA, w.sectionsA.X[0], 'MAT', [81]), /above the maximum/);
    await fill(w.teacherA, w.sectionsA.X[0], 'MAT', [72, 64, null]);     // teaches maths to X-A
    await rejects(academics.sheet(w.db, w.teacherA, hy, w.sectionsA.X[0], 'ENG'), /do not teach/);   // class teacher, but not of English
    await rejects(fill(w.teacherA, w.sectionsA.VIII[0], 'MAT', [40]), /do not teach/);
    await rejects(academics.sheet(w.db, w.teacherA, hy, w.sectionsA.X[1], 'ENG'), /do not teach/);
    await academics.sheet(w.db, w.teacherA, hy, w.sectionsA.X[1], 'MAT');   // teaches X-B maths on the timetable
  });

  it('refuses to lock with marks missing, and needs a reason to reopen', async () => {
    await rejects(academics.lock(w.db, w.principalA, hy), /missing/);
    for (const s of ['ENG', 'HIN', 'SCI', 'SST', 'CS']) await fill(w.principalA, w.sectionsA.X[0], s, [70, 55, 40]);
    // VIII-A, VIII-B and X-B have nobody enrolled in this test world, so X-A completes the exam.
    await academics.lock(w.db, w.principalA, hy);
    await rejects(fill(w.teacherA, w.sectionsA.X[0], 'MAT', [80]), /locked/);
    await rejects(academics.reopen(w.db, w.teacherA, hy, 'typo in marks'), /access|duty/);
    await academics.reopen(w.db, w.principalA, hy, 'Correct a totalling error in maths');
    await fill(w.teacherA, w.sectionsA.X[0], 'MAT', [76, 64, null]);
    await academics.lock(w.db, w.principalA, hy);
    const reopened = await w.db.one<{ n: number }>('select count(*)::int as n from assessment_reopen where assessment_id = $1', [hy]);
    expect(reopened.n).toBe(1);
  });

  it('publishes permanent results with grades and ranks, and tells parents', async () => {
    const r = await academics.publish(w.db, w.principalA, hy);
    expect(r.results).toBe(3);
    const res = await academics.sectionResults(w.db, w.principalA, hy, w.sectionsA.X[0]) as { rank_section: number; percentage: number; grade: string }[];
    expect(res[0].rank_section).toBe(1);
    expect(res[0].percentage).toBeCloseTo(((76 + 70 * 5) / 480) * 100, 1);
    expect(res[0].grade).toBe('A2');
    await rejects(w.db.query('update result set percentage = 99 where assessment_id = $1', [hy]), /permanent|cannot/);
    await rejects(w.db.query(`update assessment set name = 'x' where id = $1`, [hy]), /published result cannot be changed/);
    await rejects(w.db.query(`delete from mark where assessment_id = $1`, [hy]), /published/);
    const mine = await academics.forStudent(w.db, kids[0].parent, kids[0].studentId);
    expect(mine.results).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/admission_category/);
  });

  it('computes the Performance Index and compares schools for NES', async () => {
    const a = await academics.analysis(w.db, w.principalA, hy) as { overall: { pi: number; students: number } };
    expect(a.overall.students).toBe(3);
    expect(a.overall.pi).toBeGreaterThan(0);
    const across = await academics.acrossSchools(w.db, w.admin, YEAR, "HY") as unknown as { schools: { school: string; pi: number | null }[]; toppers: { name: string }[] };
    expect(across.schools.map((s) => s.school)).toContain('NCS Alpha');
    expect(across.toppers.length).toBeGreaterThan(0);
  });
});

describe('report cards, the date sheet and the class teacher’s list', () => {
  it('prints a class’s report cards from published results only, for the class teacher, the principal and the parent', async () => {
    const pdf = await reportCards.forSection(w.db, w.teacherA, hy, w.sectionsA.X[0]);           // Teacher Alpha is class teacher of X-A
    expect(pdf.count).toBe(3);
    expect((await PDFDocument.load(pdf.pdf)).getPageCount()).toBe(12);                         // cover, All About Me, results, attendance and remarks
    if (process.env.HPC_OUT) (await import('node:fs')).writeFileSync(`${process.env.HPC_OUT}/x-hy.pdf`, pdf.pdf);
    expect((await reportCards.forSection(w.db, w.principalA, hy, w.sectionsA.X[0])).count).toBe(3);
    const stranger = await user('Teacher Other', 'TEACHER', 'nes.wnc.ncs_a');
    await rejects(reportCards.forSection(w.db, stranger, hy, w.sectionsA.X[0]), /class teacher, the exam in-charge or the principal/);
    await rejects(reportCards.forSection(w.db, principalB, hy, w.sectionsA.X[0]), /outside your access/);
    const one = await reportCards.forStudent(w.db, kids[0].parent, kids[0].studentId, hy);
    expect((await PDFDocument.load(one.pdf)).getPageCount()).toBe(4);
    await rejects(reportCards.forStudent(w.db, other.parent, kids[0].studentId, hy), /access|duty/);
  });

  it('lists the NES plan, a child’s date sheet and the class teacher’s report cards to fill', async () => {
    const plan = await academics.planFor(w.db, w.principalA, w.schoolA, YEAR);
    expect(plan.find((p) => p.code === 'HY')?.created).toBe(true);
    expect(plan.find((p) => p.code === 'PT2')?.created).toBe(false);
    const pt2 = await academics.createFromPlan(w.db, w.principalA, w.schoolA, YEAR, 'PT2');
    await rejects(reportCards.forSection(w.db, w.principalA, pt2.id, w.sectionsA.X[0]), /Publish the results first/);
    await academics.setPaper(w.db, w.principalA, pt2.id, { classCode: 'X', subjectCode: 'MAT', maxMarks: 40, examDate: '2026-12-01' });
    const sheet = await academics.examSchedule(w.db, kids[0].parent, kids[0].studentId) as { code: string; subject: string; date: string | null }[];
    expect(sheet.find((x) => x.subject === 'Mathematics')).toMatchObject({ code: 'PT2', date: '2026-12-01' });
    expect(sheet.every((x) => x.code === 'PT2')).toBe(true);                               // published exams are not on the date sheet
    await academics.open(w.db, w.principalA, pt2.id);
    const cards = await academics.myCards(w.db, w.teacherA) as { assessment: string; section: string; strength: number }[];
    expect(cards.map((c) => c.assessment)).toEqual(expect.arrayContaining(['Periodic Test 2', 'Half-Yearly Examination']));
  });
});

describe('access to a child’s records', () => {
  it('keeps staff to their own schools and parents to their own children', async () => {
    await rejects(academics.forStudent(w.db, principalB, kids[0].studentId), /outside your access/);
    await rejects(studentApp.overview(w.db, w.teacherA, other.studentId), /outside your access/);
    await rejects(academics.forStudent(w.db, other.parent, kids[0].studentId), /access|duty/);
    expect((await academics.forStudent(w.db, w.principalA, kids[0].studentId)).results).toHaveLength(1);
  });
});

describe('NES awards', () => {
  it('runs nomination → approval by someone else → payment posted to the ledger', async () => {
    const s = await awards.createScheme(w.db, w.admin, { code: 'MERIT_X', name: 'NES Merit Award, Class X', kind: 'STUDENT', amountPaise: 1_100_000, from: '2026-04-01' });
    await rejects(awards.createScheme(w.db, w.principalA, { code: 'MINE', name: 'Self award', kind: 'STUDENT', amountPaise: 1, from: '2026-04-01' }), /access|duty/);
    const n = await awards.nominate(w.db, w.principalA, { schemeId: s.id, schoolId: w.schoolA, year: YEAR, studentId: kids[0].studentId, citation: 'First in Class X in the Half-Yearly examination.' });
    await rejects(awards.nominate(w.db, w.principalA, { schemeId: s.id, schoolId: w.schoolA, year: YEAR, studentId: kids[0].studentId, citation: 'Nominated a second time by mistake.' }), /already exists/);
    await rejects(awards.nominate(w.db, w.principalA, { schemeId: s.id, schoolId: w.schoolA, year: YEAR, teacherId: w.teacherA.id, citation: 'A teacher for a student award.' }), /for a student/);
    await rejects(awards.pay(w.db, w.admin, n.id, 'NEFT-001'), /Only approved/);
    await rejects(awards.decide(w.db, w.principalA, n.id, true), /access|duty/);
    await awards.decide(w.db, w.admin, n.id, true, 'Well deserved');
    await awards.pay(w.db, w.finance, n.id, 'NEFT-2026-0001');
    await rejects(awards.pay(w.db, w.finance, n.id, 'NEFT-2026-0002'), /Only approved/);
    const j = await w.db.query<{ account_code: string; debit_paise: string; credit_paise: string }>(
      `select l.account_code, l.debit_paise, l.credit_paise from journal j join journal_line l on l.journal_id = j.id where j.source_type = 'award' and j.source_id = $1 order by l.account_code`, [n.id]);
    expect(j.map((x) => [x.account_code, Number(x.debit_paise), Number(x.credit_paise)])).toEqual([['1100', 0, 1_100_000], ['5200', 1_100_000, 0]]);
    expect((await awards.forStudent(w.db, kids[0].studentId))[0].status).toBe('PAID');
  });

  it('refuses an officer approving their own nomination', async () => {
    const t = await awards.createScheme(w.db, w.admin, { code: 'OTA', name: 'Outstanding Teacher Award', kind: 'TEACHER', amountPaise: 2_500_000, from: '2026-04-01' });
    const n = await awards.nominate(w.db, w.admin, { schemeId: t.id, schoolId: w.schoolA, year: YEAR, teacherId: w.teacherA.id, citation: 'Outstanding results and mentoring in mathematics.' });
    await rejects(awards.decide(w.db, w.admin, n.id, true), /different officer/);
    await rejects(w.db.tx((t) => t.query(`update award_nomination set status = 'APPROVED', decided_by = nominated_by, decided_at = now() where id = $1`, [n.id])), /check/);
    await awards.decide(w.db, w.finance, n.id, true);
  });
});
