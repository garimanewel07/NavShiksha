import { beforeAll, describe, expect, it } from 'vitest';
import * as academics from '../src/modules/academics.js';
import * as exams from '../src/modules/exams.js';
import * as pi from '../src/modules/pi.js';
import * as analytics from '../src/modules/analytics.js';
import { parseCbseResult } from '../src/lib/cbseResult.js';
import { counted, internalGrade, pi as piOf } from '../src/reference/piPolicy.js';
import { loadActor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';

/**
 * The Performance Index exactly as the NES policy letter and its worked example lay it down; the
 * CBSE result file read and published; the HQ consolidation; and earlier years for comparison.
 */

let w: World;
type Fam = Awaited<ReturnType<typeof family>>;
const viii: Fam[] = [], x: Fam[] = [];

// A CBSE Class X result file in the layout CBSE sends schools (names made up).
const TXT = `
                      CENTRAL BOARD OF SECONDARY EDUCATION
                  SECONDARY SCHOOL EXAMINATION (CLASS X) 2027
SCHOOL : 12345    NCS ALPHA                                                     PAGE : 1
------------------------------------------------------------------------------------------
ROLL NO  SEX  CANDIDATE NAME                    SUB1  SUB2  SUB3  SUB4  SUB5  SUB6  RESULT
------------------------------------------------------------------------------------------
26101001 F    ANYA SEN                           184   085   041   086   087   402   PASS
                                                 088 A2 070 B1 095 A1 090 A1 085 A2 099 A1   A A A
26101002 M    RAVI KUMAR                         184   085   041   086   087   402   COMP
                                                 040 D2 038 D2 028 E  045 D1 050 C2 060 C1
26101003 M    TEJ SINGH                          184   002   041   086   087         PASS
                                                 081 B1 077B1  066 C1 071 B2 069 C1
\f
TOTAL CANDIDATES :     3      PASS :     2
`;

beforeAll(async () => {
  w = await makeWorld();
  for (let i = 0; i < 2; i++) viii.push(await family(w, { classCode: 'VIII' }));
  for (let i = 0; i < 3; i++) x.push(await family(w, { classCode: 'X' }));
  const names = ['Anya Sen', 'Ravi Kumar', 'Tej Singh'];
  for (const [i, k] of x.entries()) {
    await w.db.query(`update student set name = $2 where id = $1`, [k.studentId, names[i]]);
    if (i < 2) await w.db.query(`update enrolment set board_roll_no = $2 where id = $1`, [k.enrolmentId, `2610100${i + 1}`]);
  }
});

describe('the policy', () => {
  it('reproduces the NES worked examples', () => {
    // The board year follows the academic year: 2026-27 results are CBSE 2027. Class VI of the sample workbook: 8545 ÷ 1512 → 80.74; Class X of the policy: 80.85.
    expect(piOf({ A1: 656, A2: 307, B1: 218, B2: 144, C1: 105, C2: 50, D: 30, E: 2 }, 7)).toEqual({ sumNi: 1512, sumWNi: 8545, pi: 80.74 });
    expect(piOf({ A1: 271, A2: 131, B1: 105, B2: 82, C1: 66, C2: 30, D1: 6, D2: 4, E: 0 }, 8).pi).toBe(80.85);
    expect(['A1', 'A2', 'D', 'E'].map((g, i) => internalGrade([91, 90.4, 33, 32.4][i]))).toEqual(['A1', 'A2', 'D', 'E']);
  });

  it('counts Hindi and English and the best three in IX, English and the best four in XI', () => {
    const s = (code: string, pct: number) => ({ code, pct });
    const k = (t: { code: string }) => (t.code === 'ENG' ? 'ENGLISH' : t.code === 'HIN' ? 'HINDI' : null);
    const six = [s('ENG', 40), s('HIN', 35), s('MAT', 90), s('SCI', 80), s('SST', 70), s('CS', 95)];
    expect(counted('IX', six, k).map((t) => t.code)).toEqual(['ENG', 'HIN', 'CS', 'MAT', 'SCI']);
    expect(counted('XI', six, k).map((t) => t.code)).toEqual(['ENG', 'CS', 'MAT', 'SCI', 'SST']);
    expect(counted('VII', six, k)).toHaveLength(6);
  });
});

describe('the CBSE result file', () => {
  it('reads each candidate’s subjects, marks, grades and result, whatever the spacing', () => {
    const r = parseCbseResult(TXT);
    expect(r.rows.map((c) => [c.roll, c.gender, c.name, c.result])).toEqual([
      ['26101001', 'F', 'ANYA SEN', 'PASS'], ['26101002', 'M', 'RAVI KUMAR', 'COMP'], ['26101003', 'M', 'TEJ SINGH', 'PASS']]);
    expect(r.rows[0].subjects[5]).toEqual({ code: '402', marks: 99, grade: 'A1', absent: false });
    expect(r.rows[1].subjects[2]).toMatchObject({ code: '041', marks: 28, grade: 'E' });
    expect(r.rows[2].subjects.map((s) => s.grade)).toEqual(['B1', 'B1', 'C1', 'B2', 'C1']);     // "077B1" written together
    expect(r.skipped).toEqual([]);
  });

  it('shows a preview first, keeps the file, matches by roll number or name, and reaches parents only when published', async () => {
    const preview = await exams.importBoardResults(w.db, w.principalA, w.schoolA, { year: 2027, classCode: 'X', content: TXT, fileName: 'X_result.txt', dryRun: true });
    expect(preview).toMatchObject({ format: 'CBSE_TXT', rows: 3, matched: 3, passed: 2 });
    expect((await w.db.one<{ n: number }>('select count(*)::int as n from board_result')).n).toBe(0);
    await exams.importBoardResults(w.db, w.principalA, w.schoolA, { year: 2027, classCode: 'X', content: TXT, fileName: 'X_result.txt' });
    expect((await exams.boardUploads(w.db, w.principalA, w.schoolA))[0]).toMatchObject({ file_name: 'X_result.txt', rows: 3, matched: 3, published: 0 });
    expect(await exams.boardResultFor(w.db, x[0].studentId)).toEqual([]);
    const pub = await exams.publishBoardResults(w.db, w.principalA, w.schoolA, 2027, 'X');
    expect(pub).toEqual({ published: 3, parentsTold: 3 });
    expect((await exams.boardResultFor(w.db, x[0].studentId) as { percentage: number }[])[0].percentage).toBe((88 + 99 + 95 + 90 + 85) / 5);
    await rejects(exams.publishBoardResults(w.db, w.principalA, w.schoolA, 2027, 'X'), /no unpublished/);
  });
});

describe('the supplementary examination', () => {
  it('updates the main result for the subjects taken again, in the layout CBSE uses (flag column)', async () => {
    // Same layout as a real CBSE supplementary file: flag C (compartment) before the sex column.
    const supp = [
      'DATE:- 12-08-2027    CENTRAL BOARD OF SECONDARY EDUCATION - SECONDARY SCHOOL EXAMINATION (COMPARTMENT)-2027      REGION: PUNE         PAGE:-       1',
      'ROLL    F S NAME OF CANDIDATE',
      'SCHOOL : - 12345   NCS ALPHA',
      '26101002 C M RAVI KUMAR                                         041                                                          XXXX',
      '                                                                 045  C2',
    ].join('\n');
    const pre = await exams.importBoardResults(w.db, w.principalA, w.schoolA, { year: 2027, classCode: 'X', content: supp, dryRun: true }) as { supplementary: boolean; updates: number; preview: { changes: unknown[]; result: string }[] };
    expect(pre).toMatchObject({ supplementary: true, updates: 1 });
    expect(pre.preview[0].changes).toEqual([{ code: '041', from: '28 E', to: '45 C2' }]);
    expect(pre.preview[0].result).toBe('PASS');                                          // every subject now 33 or more
    await exams.importBoardResults(w.db, w.principalA, w.schoolA, { year: 2027, classCode: 'X', content: supp });
    const r = await w.db.one<{ result: string; n: number }>(`select result, jsonb_array_length(subjects)::int as n from board_result where roll_no = '26101002'`);
    expect(r).toEqual({ result: 'PASS', n: 6 });                                         // the other five subjects kept
    const told = await w.db.one<{ n: number }>(`select count(*)::int as n from notification where title like '%supplementary%'`);
    expect(told.n).toBeGreaterThan(0);                                                   // published earlier, so the family is told
  });
});

describe('the PI sheet', () => {
  it('works out VIII from the annual exam (scholastic subjects only) and X from the CBSE grades', async () => {
    const a = (await w.db.one<{ id: string }>(`insert into assessment (school_id, academic_year, code, name, kind, status, created_by) values ($1, '2026-27', 'ANNUAL', 'Annual Examination', 'ANNUAL', 'OPEN', $2) returning id`, [w.schoolA, w.principalA.id])).id;
    const subjects = ['ENG', 'HIN', 'SAN', 'MAT', 'SCI', 'SST', 'CS'];
    for (const s of subjects) await w.db.query(`insert into assessment_paper (assessment_id, class_code, subject_code, max_marks) values ($1, 'VIII', $2, 80)`, [a, s]);
    const marks = [[76, 70, 64, 80, 60, 50, 80], [30, 40, 45, 26, 70, 60, 10]];
    for (const [i, k] of viii.entries()) for (const [j, s] of subjects.entries())
      await w.db.query(`insert into mark (assessment_id, enrolment_id, subject_code, marks, entered_by) values ($1, $2, $3, $4, $5)`, [a, k.enrolmentId, s, marks[i][j], w.principalA.id]);
    await academics.lock(w.db, w.principalA, a);
    await academics.publish(w.db, w.principalA, a);
    const sheet = await pi.schoolSheet(w.db, w.principalA, w.schoolA, '2026-27');
    const r8 = sheet.partA.find((r) => r.classKey === 'VIII')!;
    // 95, 87.5, 80, 100, 75, 62.5 → A1 A2 B1 A1 B1 B2; 37.5, 50, 56.25, 32.5, 87.5, 75 → D C2 C1 E A2 B1 (CS left out).
    expect(r8).toMatchObject({ students: 2, sumNi: 12, expected: 12, check: 'OK', counts: { A1: 2, A2: 2, B1: 3, B2: 1, C1: 1, C2: 1, D: 1, E: 1 } });
    expect(r8.pi).toBe(Math.round(((2 * 7 + 2 * 6 + 3 * 5 + 4 + 3 + 2 + 1) / 12) * 100 / 7 * 100) / 100);
    expect(r8.topper).toMatchObject({ total: 76 + 70 + 64 + 80 + 60 + 50, max: 480 });
    const r10 = sheet.partB.find((r) => r.classKey === 'X')!;
    expect(r10).toMatchObject({ students: 3, scale: 8, sumNi: 15, check: 'OK' });
    expect(r10.topper?.name).toBe('ANYA SEN');
    expect(pi.sheetCsv(sheet)).toMatch(/PART B – CLASSES X & XII/);
  });

  it('is reported to NES, consolidated across schools, and compared with earlier years loaded by NES', async () => {
    await rejects(pi.freeze(w.db, w.teacherA, w.schoolA, '2026-27'), /not part of your role|principal/);
    const f = await pi.freeze(w.db, w.principalA, w.schoolA, '2026-27');
    expect(f.classes).toBe(2);
    const c = await pi.consolidation(w.db, w.admin, '2026-27');
    const alpha = c.matrix.find((m) => m.school === 'NCS Alpha')!;
    expect(alpha.pi.X).toBeGreaterThan(0);
    expect(c.stats.VIII).toMatchObject({ reporting: 1, best: 'NCS Alpha' });
    expect(pi.consolidationCsv(c)).toMatch(/School with highest PI/);
    await w.db.query(`insert into academic_year (code, period) values ('2025-26', daterange('2025-04-01', '2026-04-01'))`);
    const h = await pi.importHistory(w.db, w.admin, '2025-26', 'Ser,Name of School,VI,VII,VIII,IX,X,XI (Science)\n1,NCS-A,,,78.5,,79.1,\n2,Nowhere School,1,2,3,4,5,6');
    expect(h).toEqual({ saved: 2, unknown: ['Nowhere School'] });
    const d = await analytics.results(w.db, w.admin, { years: ['2026-27', '2025-26'], code: 'ANNUAL' });
    const viii25 = d.pi.find((p) => p.year === '2025-26' && p.classKey === 'VIII')!;
    expect(viii25).toMatchObject({ pi: 78.5, source: 'IMPORTED' });
    expect(d.pi.filter((p) => p.year === '2026-27').map((p) => p.classKey).sort()).toEqual(['VIII', 'X']);
    expect(d.board[0]).toMatchObject({ classCode: 'X', candidates: 3, passed: 3 });                 // Ravi passed after the compartment exam
  });

  it('shows a school only its own figures, a Command only its schools, and NES the whole network', async () => {
    const user = async (role: string, scope: string) => loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3::ltree) returning id`, [`${role} ${scope}`, role, scope])).id);
    const principalB = await user('SCHOOL_ADMIN', 'nes.enc.ncs_b');
    const wnc = await user('COMMAND_OFFICER', 'nes.wnc');
    const enc = await user('COMMAND_OFFICER', 'nes.enc');
    await rejects(pi.schoolSheet(w.db, principalB, w.schoolA, '2026-27'), /outside your access/);       // another school's sheet
    await rejects(pi.consolidation(w.db, w.principalA, '2026-27'), /NES and the Commands/);              // no network view for a school
    await rejects(analytics.results(w.db, w.principalA, { years: ['2026-27'], code: 'ANNUAL' }), /NES and the Commands/);
    const own = await analytics.results(w.db, wnc, { years: ['2026-27'], code: 'ANNUAL' });
    expect(own.schools.map((s) => s.name)).toEqual(['NCS Alpha']);                                      // Alpha is in WNC
    expect(new Set(own.pi.map((p) => p.schoolId))).toEqual(new Set([w.schoolA]));
    const other = await analytics.results(w.db, enc, { years: ['2026-27'], code: 'ANNUAL' });
    expect(other.schools.map((s) => s.name)).toEqual(['NCS Bravo']);
    expect(other.pi.some((p) => p.schoolId === w.schoolA)).toBe(false);                                // ENC never sees Alpha
    const nes = await analytics.results(w.db, w.admin, { years: ['2026-27'], code: 'ANNUAL' });
    expect(nes.schools.map((s) => s.name).sort()).toEqual(['NCS Alpha', 'NCS Bravo']);
    await rejects(pi.schoolSheet(w.db, enc, w.schoolA, '2026-27'), /outside your access/);
  });
});
