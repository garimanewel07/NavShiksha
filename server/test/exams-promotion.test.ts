import { beforeAll, describe, expect, it } from 'vitest';
import * as exams from '../src/modules/exams.js';
import * as promotion from '../src/modules/promotion.js';
import * as academics from '../src/modules/academics.js';
import * as settings from '../src/modules/settings.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';

/**
 * Exams, the rest, and promotion: seating with classes mixed and invigilators who do not teach the
 * paper; moderation with every change kept; board data from the records; the CBSE result file; and
 * the whole school moved on to next year, with Class XI streams by merit and choice.
 */

let w: World;
let assessmentId: string, teacher2: Actor, teacher3: Actor;
type Fam = Awaited<ReturnType<typeof family>>;
const xKids: Fam[] = [], viiiKids: Fam[] = [];

async function teacher(name: string) {
  return loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, 'TEACHER', $1, 'nes.wnc.ncs_a') returning id`, [name])).id);
}

beforeAll(async () => {
  w = await makeWorld();
  for (let i = 0; i < 4; i++) xKids.push(await family(w, { classCode: 'X' }));
  for (let i = 0; i < 2; i++) viiiKids.push(await family(w, { classCode: 'VIII' }));
  await w.db.query(`update student set name = 'Child ' || substr(id::text, 1, 4) where id = any($1::uuid[])`, [[...xKids, ...viiiKids].map((k) => k.studentId)]);
  teacher2 = await teacher('Teacher Two'); teacher3 = await teacher('Teacher Three');
  await w.db.query(`insert into teaching_load (section_id, subject_code, teacher_id, periods_per_week) values ($1, 'MAT', $2, 6), ($1, 'ENG', $3, 6), ($4, 'ENG', $5, 6)`, [w.sectionsA.X[0], w.teacherA.id, teacher2.id, w.sectionsA.VIII[0], teacher3.id]);
  for (const [sec, subj, t, wd] of [[w.sectionsA.X[0], 'MAT', w.teacherA.id, 2], [w.sectionsA.VIII[0], 'ENG', teacher3.id, 3]] as const) {
    const tt = await w.db.one<{ id: string }>(`insert into timetable (section_id, valid, created_by) values ($1, daterange('2026-04-01', null), $2) returning id`, [sec, t]);
    await w.db.query(`insert into timetable_slot (timetable_id, weekday, period, starts, ends, subject_code, teacher_id) values ($1, $2, 2, '08:40', '09:20', $3, $4)`, [tt.id, wd, subj, t]);
  }
  assessmentId = (await w.db.one<{ id: string }>(`insert into assessment (school_id, academic_year, code, name, kind, status, created_by) values ($1, '2026-27', 'HY', 'Half-Yearly', 'TERM', 'OPEN', $2) returning id`, [w.schoolA, w.principalA.id])).id;
  await w.db.query(`insert into assessment_paper (assessment_id, class_code, subject_code, max_marks, exam_date) values ($1, 'X', 'MAT', 80, '2026-11-02'), ($1, 'VIII', 'ENG', 80, '2026-11-02')`, [assessmentId]);
});

describe('seating and invigilation', () => {
  it('needs enough exam seats, mixes the classes, and never sends a paper’s own teacher to invigilate it', async () => {
    const r1 = await exams.saveRoom(w.db, w.principalA, w.schoolA, { campusId: w.campusA, name: 'Room 101', kind: 'CLASSROOM', capacity: 40, examSeats: 3 });
    await rejects(exams.plan(w.db, w.principalA, assessmentId, '2026-11-02', 'MORNING'), /seat 3/);
    await exams.saveRoom(w.db, w.principalA, w.schoolA, { campusId: w.campusA, name: 'Room 102', kind: 'CLASSROOM', capacity: 40, examSeats: 30 });
    const p = await exams.plan(w.db, w.principalA, assessmentId, '2026-11-02', 'MORNING');
    expect(p).toMatchObject({ seated: 6, rooms: 2 });
    const s = await exams.seating(w.db, w.principalA, assessmentId, '2026-11-02', 'MORNING');
    const first = s.rooms.find((r) => r.room_id === r1.id)!.seats as { class: string }[];
    expect(first[0].class.slice(0, 1)).not.toBe(first[1].class.slice(0, 1));            // neighbours sit different papers
    const inv = s.rooms.flatMap((r) => r.invigilators);
    expect(inv).not.toContain('Teacher Alpha');                                          // teaches X Mathematics
    expect(inv).not.toContain('Teacher Three');                                          // teaches VIII English, written that morning
    expect(inv).toEqual(['Teacher Two']);                                                // the only teacher free of both papers…
    expect(p.shortOfInvigilators).toBe(1);                                               // …so the plan says one more is needed
    expect((await exams.myDuties(w.db, teacher2)).length).toBe(1);
    expect((await exams.seatingPdf(w.db, w.principalA, assessmentId, '2026-11-02', 'MORNING')).data.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('moderation', () => {
  it('locks the teacher out once submitted, keeps every moderated change with its reason, and gates locking', async () => {
    const sec = w.sectionsA.X[0];
    const roll = (await academics.sheet(w.db, w.teacherA, assessmentId, sec, 'MAT')).students as { enrolment_id: string }[];
    await academics.saveMarks(w.db, w.teacherA, assessmentId, sec, 'MAT', roll.map((r, i) => ({ enrolmentId: r.enrolment_id, marks: 40 + i * 5, absent: false })));
    await rejects(exams.submitSheet(w.db, teacher3, assessmentId, sec, 'MAT'), /subject teacher/);
    await exams.submitSheet(w.db, w.teacherA, assessmentId, sec, 'MAT');
    await rejects(academics.saveMarks(w.db, w.teacherA, assessmentId, sec, 'MAT', [{ enrolmentId: roll[0].enrolment_id, marks: 80, absent: false }]), /submitted for moderation/);
    expect((await exams.toModerate(w.db, w.principalA, w.schoolA) as { subject_code: string }[])[0].subject_code).toBe('MAT');
    await rejects(exams.moderate(w.db, w.principalA, assessmentId, sec, 'MAT', { accept: true, changes: [{ enrolmentId: roll[0].enrolment_id, marks: 44, reason: 'x' }] }), /reason/);
    const m = await exams.moderate(w.db, w.principalA, assessmentId, sec, 'MAT', { accept: true, changes: [{ enrolmentId: roll[0].enrolment_id, marks: 44, reason: 'Q7 was marked out of 3, not 4' }] });
    expect(m).toMatchObject({ status: 'MODERATED', changed: 1 });
    expect((await exams.moderationLog(w.db, w.principalA, assessmentId))[0]).toMatchObject({ from_marks: 40, to_marks: 44 });
    // With moderation required, the assessment cannot lock while a sheet is unmoderated.
    const society = (await w.db.one<{ id: string }>(`select id from org_unit where kind = 'society'`)).id;
    await settings.set(w.db, w.admin, society, { key: 'exams.moderation_required', value: true, from: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) });
    const viii = w.sectionsA.VIII[0];
    const r2 = (await academics.sheet(w.db, teacher3, assessmentId, viii, 'ENG')).students as { enrolment_id: string }[];
    await academics.saveMarks(w.db, teacher3, assessmentId, viii, 'ENG', r2.map((r) => ({ enrolmentId: r.enrolment_id, marks: 20, absent: false })));
    await rejects(academics.lock(w.db, w.principalA, assessmentId), /not been moderated/);
  });
});

describe('the board', () => {
  it('builds registration data from the records with what is missing, and loads and analyses the result file', async () => {
    const rows = await exams.boardData(w.db, w.principalA, w.schoolA, 'X');
    expect(rows[0].father_name).toBe('Parent Test');                                     // from the guardian record, not typed again
    expect(rows[0].missing).toEqual(expect.arrayContaining(['mother’s name', 'APAAR ID', 'registration no.']));
    expect(rows[0].codes).toEqual(['184', '041']);                                       // English and Mathematics, the subjects X-A is taught
    const csv = exams.boardCsv(rows);
    expect(csv.split('\r\n')[0]).toMatch(/^Admission no,Section,Name/);
    const adm = await w.db.query<{ admission_no: string }>(`select admission_no from enrolment where id = any($1::uuid[]) order by admission_no`, [xKids.map((k) => k.enrolmentId)]);
    const set = await exams.setBoardNumbers(w.db, w.principalA, w.schoolA, adm.map((a, i) => ({ admissionNo: a.admission_no, rollNo: `2610${i + 1}`, regNo: `R${i}` })).concat([{ admissionNo: 'NOPE', rollNo: '1', regNo: '1' }]));
    expect(set).toMatchObject({ updated: 4, unknown: ['NOPE'] });
    const file = ['Roll,Name,S1,M1,G1,S2,M2,G2,S3,M3,G3,S4,M4,G4,S5,M5,G5,S6,M6,G6,Result',
      '26101,Any Name,184,88,A2,041,95,A1,086,90,A1,087,85,A2,085,70,B1,402,99,A1,PASS',
      '26102,Other Name,184,40,D,041,28,E,086,45,D,087,50,C2,085,38,D,402,60,C1,COMP'].join('\n');
    const imp = await exams.importBoardResults(w.db, w.principalA, w.schoolA, { year: 2026, classCode: 'X', content: file });
    expect(imp).toMatchObject({ rows: 2, matched: 2, format: 'CSV' });
    const top = await w.db.one<{ best5: number; percentage: number }>(`select best5::float, percentage::float from board_result where roll_no = '26101'`);
    expect(top).toEqual({ best5: 88 + 99 + 95 + 90 + 85, percentage: (88 + 99 + 95 + 90 + 85) / 5 });   // English and the best four others
    const an = await exams.boardAnalysis(w.db, w.principalA, w.schoolA, 2026, 'X');
    expect(an).toMatchObject({ candidates: 2, passed: 1, passPct: 50 });
    expect(an.compartment[0].roll_no).toBe('26102');
  });
});

describe('promotion to the next year', () => {
  it('works out each child’s decision, allots Class XI streams by merit and choice, and moves the school on', async () => {
    await rejects(promotion.prepare(w.db, w.principalA, w.schoolA), /not opened 2027-28/);
    await promotion.openYear(w.db, w.admin, '2027-28');
    // One VIII child scored 25% in the annual exam: held back (no detention below Class VIII).
    const annual = (await w.db.one<{ id: string }>(`insert into assessment (school_id, academic_year, code, name, kind, status, published_at, created_by) values ($1, '2026-27', 'AN', 'Annual', 'ANNUAL', 'PUBLISHED', now(), $2) returning id`, [w.schoolA, w.principalA.id])).id;
    for (const [k, pct] of [[viiiKids[0], 25], [viiiKids[1], 72]] as const) await w.db.query(`insert into result (assessment_id, enrolment_id, section_id, class_code, obtained, max_total, percentage, grade, rank_class, subjects) values ($1,$2,$3,'VIII',$4,100,$4,'C',1,'[]')`, [annual, k.enrolmentId, w.sectionsA.VIII[0], pct]);
    const first = await promotion.prepare(w.db, w.principalA, w.schoolA);
    expect(first.lines).toBe(6);
    // Next year's Class XI sections get streams; the families choose; the list is prepared again.
    await w.db.query(`insert into section (campus_id, academic_year, class_code, name, capacity) values ($1, '2027-28', 'XI', 'B', 30)`, [w.campusA]);
    const xi = await w.db.query<{ id: string; name: string }>(`select s.id, s.name from section s where s.academic_year = '2027-28' and s.class_code = 'XI' order by s.name`);
    expect(xi.map((s) => s.name)).toEqual(['A', 'B']);
    await w.db.query(`update section set capacity = 1 where id = $1`, [xi[0].id]);
    await promotion.setStream(w.db, w.principalA, xi[0].id, 'SCIENCE_PCM');
    await promotion.setStream(w.db, w.principalA, xi[1].id, 'COMMERCE');
    const byRoll = (roll: string) => xKids.find((k) => k.enrolmentId === byRollId.get(roll));
    const byRollId = new Map((await w.db.query<{ roll_no: string; enrolment_id: string }>(`select roll_no, enrolment_id from board_result`)).map((r) => [r.roll_no, r.enrolment_id]));
    const top = byRoll('26101')!, comp = byRoll('26102')!;
    const others = xKids.filter((k) => k !== top && k !== comp);
    await promotion.chooseStreams(w.db, top.parent, top.studentId, ['SCIENCE_PCM', 'COMMERCE']);                 // 93.4% on the board
    await promotion.chooseStreams(w.db, comp.parent, comp.studentId, ['SCIENCE_PCM', 'COMMERCE']);               // compartment
    await rejects(promotion.chooseStreams(w.db, viiiKids[0].parent, viiiKids[0].studentId, ['COMMERCE']), /Class X/);
    await promotion.prepare(w.db, w.principalA, w.schoolA);
    const v = await promotion.view(w.db, w.principalA, w.schoolA);
    const line = (enr: string) => (v.lines as any[]).find((l) => l.enrolment_id === enr);
    expect(line(viiiKids[0].enrolmentId)).toMatchObject({ decision: 'DETAIN', to_class: 'VIII' });
    expect(line(viiiKids[1].enrolmentId)).toMatchObject({ decision: 'PROMOTE', to_class: 'IX' });
    expect(line(top.enrolmentId)).toMatchObject({ decision: 'PROMOTE', to_class: 'XI', stream: 'SCIENCE_PCM' });   // merit first
    expect(line(comp.enrolmentId)).toMatchObject({ to_class: 'XI', stream: 'COMMERCE' });                         // science full: second choice
    // Two X children chose nothing: the principal picks their section (and one leaves the school).
    const x2 = others[0].enrolmentId, x3 = others[1].enrolmentId;
    await rejects(promotion.apply(w.db, w.principalA, first.runId, '2027-03-20'), /no section/);
    await promotion.setLine(w.db, w.principalA, first.runId, x2, { decision: 'PROMOTE', toSection: xi[1].id });
    await rejects(promotion.setLine(w.db, w.principalA, first.runId, x3, { decision: 'LEAVE' }), /reason/);
    await promotion.setLine(w.db, w.principalA, first.runId, x3, { decision: 'LEAVE', reason: 'Father posted to Port Blair; TC asked for' });
    await rejects(promotion.apply(w.db, w.principalA, first.runId, '2026-12-01'), /from 2027-02-15/);
    const r = await promotion.apply(w.db, w.principalA, first.runId, '2027-03-20');
    expect(r).toMatchObject({ applied: 6, promoted: 4, detained: 1 });
    const now = await w.db.one<{ class_code: string; academic_year: string; roll_no: number }>('select class_code, academic_year, roll_no from enrolment where id = $1', [top.enrolmentId]);
    expect(now).toEqual({ class_code: 'XI', academic_year: '2027-28', roll_no: 1 });
    expect(await promotion.history(w.db, top.enrolmentId)).toEqual([expect.objectContaining({ academic_year: '2026-27', class_code: 'X', outcome: 'PROMOTED' })]);
    expect((await w.db.one<{ status: string }>('select status from enrolment where id = $1', [x3])).status).toBe('WITHDRAWN');
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from notification where kind = 'RESULT' and title like 'Next year:%'`)).n).toBe(6);
    await rejects(promotion.prepare(w.db, w.principalA, w.schoolA), /already been applied/);
  });
});
