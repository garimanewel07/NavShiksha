import type { Db } from '../db/client.js';
import { forbidden, invalid } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan } from './access.js';
import {
  BOARD_GRADES, boardGrade, counted, COUNTED, INTERNAL_GRADES, internalGrade, NOT_SCHOLASTIC, perStudent, pi, streamFrom, streamOfSection, type Stream,
} from '../reference/piPolicy.js';

/**
 * The Performance Index as the NES policy letter lays it down, from the marks and CBSE results
 * already in NavShiksha: a school's PI sheet (the same columns as the NES workbook: grade counts,
 * ΣNi check, PI and topper per class and stream), the HQ consolidation across schools, and the
 * figures each year freezes so later years compare against what was reported.
 */

export const CLASS_KEYS = ['VI', 'VII', 'VIII', 'IX', 'X', 'XI-SCIENCE', 'XI-COMMERCE', 'XI-HUMANITIES', 'XII-SCIENCE', 'XII-COMMERCE', 'XII-HUMANITIES'];
export const keyLabel = (k: string) => k.replace(/-(\w)(\w+)$/, (_, a, b) => ` (${a}${b.toLowerCase()})`);
const classOf = (k: string) => k.split('-')[0];
/** The CBSE year for an academic year: 2025-26 results are declared in 2026. */
export const boardYear = (year: string) => Number(year.slice(0, 4)) + 1;

const ENGLISH = ['ENG', '101', '184', '301', '001'];
const HINDI = ['HIN', '002', '085'];
const kindOf = (s: { code: string }) => (ENGLISH.includes(s.code) ? 'ENGLISH' : HINDI.includes(s.code) ? 'HINDI' : null);

interface Student { name: string; category: string | null; subjects: { code: string; name: string; marks: number | null; max: number; pct: number | null; grade: string }[] }
interface Bucket { schoolId: string; school: string; command: string | null; classKey: string; students: Student[] }

export interface PiRow {
  schoolId: string; school: string; command: string | null; classKey: string; label: string; scale: 7 | 8; students: number; counts: Record<string, number>;
  sumNi: number; sumWNi: number; expected: number; check: string; pi: number | null; counted: string;
  topper: { name: string; category: string | null; total: number; max: number; pct: number } | null; source: 'LIVE' | 'SYSTEM' | 'IMPORTED';
}
export interface SubjectRow { schoolId: string; classCode: string; subject: string; entries: number; average: number; counts: Record<string, number>; scale: 7 | 8 }

/** Everyone's marks for the year, gathered per school and class (stream for XI and XII). */
async function gather(db: Db, scopePath: string, year: string, code: string, schoolId: string | null) {
  const buckets = new Map<string, Bucket>();
  const put = (schoolIdX: string, school: string, command: string | null, classKey: string, s: Student) => {
    const k = `${schoolIdX}|${classKey}`;
    if (!buckets.has(k)) buckets.set(k, { schoolId: schoolIdX, school, command, classKey, students: [] });
    buckets.get(k)!.students.push(s);
  };
  const command = `(select c.name from org_unit c where c.kind = 'command' and o.path <@ c.path limit 1)`;
  // VI–IX and XI: the published Common Final Examination (Annual by default).
  const internal = await db.query<{ school_id: string; school: string; command: string | null; class_code: string; stream: string | null; category: string | null; name: string;
    subjects: { code: string; name: string; marks: number | null; max: number; pct: number | null; absent: boolean }[] }>(
    `select a.school_id, o.name as school, ${command} as command, r.class_code, sec.stream, e.admission_category as category, st.name, r.subjects
       from result r join assessment a on a.id = r.assessment_id join org_unit o on o.id = a.school_id
       join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id left join section sec on sec.id = r.section_id
      where o.path <@ $1::ltree and a.academic_year = $2 and a.code = $3 and a.status = 'PUBLISHED' and r.class_code in ('VI', 'VII', 'VIII', 'IX', 'XI')
        and ($4::uuid is null or a.school_id = $4)`, [scopePath, year, code, schoolId]);
  for (const r of internal) {
    const subjects = r.subjects.filter((s) => !(['VI', 'VII', 'VIII'].includes(r.class_code) && NOT_SCHOLASTIC.includes(s.code)))
      .map((s) => ({ code: s.code, name: s.name, marks: s.absent ? null : s.marks, max: s.max, pct: s.absent || s.marks == null ? null : (s.marks / s.max) * 100, grade: '' }));
    subjects.forEach((s) => { s.grade = internalGrade(s.pct); });
    const key = r.class_code === 'XI' ? `XI-${streamOfSection(r.stream) ?? streamFrom(subjects.map((s) => s.code))}` : r.class_code;
    put(r.school_id, r.school, r.command, key, { name: r.name, category: r.category, subjects });
  }
  // X and XII: the CBSE result as CBSE graded it.
  const board = await db.query<{ school_id: string; school: string; command: string | null; class_code: string; stream: string | null; category: string | null; name: string;
    subjects: { code: string; name: string; marks: number | null; grade: string }[] }>(
    `select b.school_id, o.name as school, ${command} as command, b.class_code, b.stream, e.admission_category as category, b.name, b.subjects
       from board_result b join org_unit o on o.id = b.school_id left join enrolment e on e.id = b.enrolment_id
      where o.path <@ $1::ltree and b.year = $2 and b.result not in ('ABST', 'ABSENT') and ($3::uuid is null or b.school_id = $3)`, [scopePath, boardYear(year), schoolId]);
  for (const r of board) {
    const subjects = r.subjects.map((s) => ({ code: s.code, name: s.name, marks: s.marks, max: 100, pct: s.marks, grade: boardGrade(s.grade) ?? 'E' }));
    const key = r.class_code === 'XII' ? `XII-${(r.stream as Stream | null) ?? streamFrom(subjects.map((s) => s.code))}` : r.class_code;
    put(r.school_id, r.school, r.command, key, { name: r.name, category: r.category, subjects });
  }
  return [...buckets.values()];
}

function compute(b: Bucket): { row: PiRow; subjects: SubjectRow[] } {
  const cls = classOf(b.classKey), scale: 7 | 8 = cls === 'X' || cls === 'XII' ? 8 : 7;
  const counts: Record<string, number> = Object.fromEntries((scale === 7 ? INTERNAL_GRADES : BOARD_GRADES).map((g) => [g, 0]));
  let topper: PiRow['topper'] = null;
  const bySubject = new Map<string, { entries: number; sum: number; counts: Record<string, number> }>();
  for (const st of b.students) {
    const mine = counted(cls, st.subjects, kindOf);
    for (const s of mine) counts[s.grade] = (counts[s.grade] ?? 0) + 1;
    const total = mine.reduce((t, s) => t + (s.marks ?? 0), 0), max = mine.reduce((t, s) => t + s.max, 0);
    if (max && (!topper || total / max > topper.pct)) topper = { name: st.name, category: st.category, total, max, pct: total / max };
    for (const s of st.subjects) {
      const x = bySubject.get(s.name) ?? { entries: 0, sum: 0, counts: {} };
      x.entries++; x.sum += s.pct ?? 0; x.counts[s.grade] = (x.counts[s.grade] ?? 0) + 1;
      bySubject.set(s.name, x);
    }
  }
  const p = pi(counts, scale), expected = b.students.length * perStudent(cls);
  return {
    row: { schoolId: b.schoolId, school: b.school, command: b.command, classKey: b.classKey, label: keyLabel(b.classKey), scale, students: b.students.length, counts,
      sumNi: p.sumNi, sumWNi: p.sumWNi, expected, check: p.sumNi === expected ? 'OK' : `ΣNi ${p.sumNi}, expected ${expected}`, pi: p.pi, counted: COUNTED[cls], topper, source: 'LIVE' },
    subjects: [...bySubject.entries()].map(([subject, x]) => ({ schoolId: b.schoolId, classCode: cls, subject, entries: x.entries, average: Math.round((x.sum / x.entries) * 10) / 10, counts: x.counts, scale })),
  };
}

const order = (a: PiRow, b: PiRow) => a.school.localeCompare(b.school) || CLASS_KEYS.indexOf(a.classKey) - CLASS_KEYS.indexOf(b.classKey);

/**
 * PI rows for every school in scope for a year: the frozen figures where a school has reported
 * (or NES loaded them), otherwise worked out now from the marks and CBSE results.
 */
export async function rows(db: Db, scopePath: string, year: string, code = 'ANNUAL', schoolId: string | null = null) {
  const live = (await gather(db, scopePath, year, code, schoolId)).map(compute);
  const frozen = await db.query<{ school_id: string; school: string; command: string | null; class_key: string; scale: 7 | 8; students: number; sum_ni: number; sum_wni: number; pi: number | null; counts: Record<string, number>; topper: PiRow['topper']; source: 'SYSTEM' | 'IMPORTED' }>(
    `select p.school_id, o.name as school, (select c.name from org_unit c where c.kind = 'command' and o.path <@ c.path limit 1) as command,
            p.class_key, p.scale, p.students, p.sum_ni, p.sum_wni, p.pi::float as pi, p.counts, p.topper, p.source
       from pi_snapshot p join org_unit o on o.id = p.school_id where o.path <@ $1::ltree and p.academic_year = $2 and ($3::uuid is null or p.school_id = $3)`, [scopePath, year, schoolId]);
  // A school that has reported shows its reported figures; a class it has no frozen figure for
  // (for example CBSE results loaded after NES imported the year) is worked out from the records.
  const reported = new Set(frozen.filter((f) => f.source === 'SYSTEM').map((f) => f.school_id));
  const frozenKeys = new Set(frozen.map((f) => `${f.school_id}|${f.class_key}`));
  const out: PiRow[] = live.filter((l) => !reported.has(l.row.schoolId) && !frozenKeys.has(`${l.row.schoolId}|${l.row.classKey}`)).map((l) => l.row);
  for (const f of frozen) {
    out.push({ schoolId: f.school_id, school: f.school, command: f.command, classKey: f.class_key, label: keyLabel(f.class_key), scale: f.scale, students: f.students, counts: f.counts,
      sumNi: f.sum_ni, sumWNi: f.sum_wni, expected: f.students * perStudent(classOf(f.class_key)), check: f.source === 'IMPORTED' ? 'Imported' : 'OK', pi: f.pi,
      counted: COUNTED[classOf(f.class_key)], topper: f.topper, source: f.source });
  }
  return { rows: out.sort(order), subjects: live.flatMap((l) => l.subjects) };
}

/** A school's PI sheet: Part A (VI–IX, XI), Part B (X, XII) and the summary, as in the NES workbook. */
export async function schoolSheet(db: Db, actor: Actor, schoolId: string, year: string, code = 'ANNUAL') {
  await assertCan(db, actor, 'results.analysis', schoolId);
  const s = await db.one<{ name: string; path: string }>('select name, path::text from org_unit where id = $1', [schoolId]);
  const r = await rows(db, s.path, year, code, schoolId);
  const frozen = await db.maybeOne<{ at: string; by: string }>(
    `select max(p.frozen_at) as at, (array_agg(u.name order by p.frozen_at desc))[1] as by from pi_snapshot p join app_user u on u.id = p.frozen_by
      where p.school_id = $1 and p.academic_year = $2 and p.source = 'SYSTEM' having count(*) > 0`, [schoolId, year]);
  return { school: s.name, year, code, boardYear: boardYear(year), partA: r.rows.filter((x) => x.scale === 7), partB: r.rows.filter((x) => x.scale === 8), subjects: r.subjects, frozen };
}

/**
 * The school reports its PI to NES: the figures are frozen for the year and become what later
 * years are compared with. Reporting again replaces them.
 */
export async function freeze(db: Db, actor: Actor, schoolId: string, year: string, code = 'ANNUAL') {
  await assertCan(db, actor, 'results.analysis', schoolId);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('The principal reports the PI to NES.');
  const sheet = await schoolSheet(db, actor, schoolId, year, code);
  const live = [...sheet.partA, ...sheet.partB].filter((r) => r.source === 'LIVE' || r.source === 'SYSTEM');
  if (!live.length) throw invalid('There are no published results or CBSE results for this year yet.');
  const bad = live.filter((r) => r.source === 'LIVE' && r.check !== 'OK');
  return db.tx(async (t) => {
    await t.query(`delete from pi_snapshot where school_id = $1 and academic_year = $2`, [schoolId, year]);
    for (const r of live) await t.query(
      `insert into pi_snapshot (school_id, academic_year, class_key, scale, students, sum_ni, sum_wni, pi, counts, topper, source, frozen_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SYSTEM',$11)`,
      [schoolId, year, r.classKey, r.scale, r.students, r.sumNi, r.sumWNi, r.pi, JSON.stringify(r.counts), r.topper ? JSON.stringify(r.topper) : null, actor.id]);
    return { classes: live.length, warnings: bad.map((r) => `${r.label}: ${r.check}`) };
  }, { actor: actor.label });
}

/** Lets a school recompute live (for example after a corrected CBSE file): NES or the principal. */
export async function unfreeze(db: Db, actor: Actor, schoolId: string, year: string) {
  await assertCan(db, actor, 'results.analysis', schoolId);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden();
  await db.tx((t) => t.query(`delete from pi_snapshot where school_id = $1 and academic_year = $2 and source = 'SYSTEM'`, [schoolId, year]), { actor: actor.label });
  return { ok: true };
}

/** The HQ consolidation: schools × classes and streams, with average, highest, lowest and the best school. */
export async function consolidation(db: Db, actor: Actor, year: string, code = 'ANNUAL') {
  // Across schools is for NES (the whole network) and Commands (their own schools); a school sees its own sheet.
  if (actor.role !== 'NES_ADMIN' && actor.role !== 'COMMAND_OFFICER') throw forbidden('Comparisons across schools are for NES and the Commands. Your school’s figures are on its PI sheet.');
  await assertCan(db, actor, 'results.analysis');
  const r = await rows(db, actor.scopePath!, year, code);
  const schools = await db.query<{ id: string; name: string; code: string }>(
    `select id, name, code from org_unit where kind = 'school' and active and path <@ $1::ltree order by name`, [actor.scopePath]);
  const matrix = schools.map((s) => ({ schoolId: s.id, school: s.name, code: s.code, pi: Object.fromEntries(r.rows.filter((x) => x.schoolId === s.id).map((x) => [x.classKey, x.pi])) as Record<string, number | null> }));
  const stats = Object.fromEntries(CLASS_KEYS.map((k) => {
    const vals = matrix.map((m) => ({ s: m.school, v: m.pi[k] })).filter((x) => x.v != null) as { s: string; v: number }[];
    const best = vals.sort((a, b) => b.v - a.v)[0];
    return [k, vals.length ? { average: Math.round((vals.reduce((t, x) => t + x.v, 0) / vals.length) * 100) / 100, highest: best.v, lowest: vals[vals.length - 1].v, best: best.s, reporting: vals.length } : null];
  }));
  return { year, classKeys: CLASS_KEYS, labels: Object.fromEntries(CLASS_KEYS.map((k) => [k, keyLabel(k)])), matrix, stats };
}

/**
 * NES loads earlier years from its consolidation sheets (CSV: school code or name, then a PI per
 * class column headed VI … XII (Humanities)), so comparisons work from the first year.
 */
export async function importHistory(db: Db, actor: Actor, year: string, csv: string) {
  if (actor.role !== 'NES_ADMIN') throw forbidden('Only NES loads earlier years’ figures.');
  if (!/^\d{4}-\d{2}$/.test(year)) throw invalid('Give the year as 2024-25.');
  const lines = csv.split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))).filter((l) => l.some(Boolean));
  const hi = lines.findIndex((l) => l.some((c) => /^VI$/i.test(c)));
  if (hi < 0) throw invalid('No header row with the class columns (VI, VII, … XII (Humanities)) was found.');
  const head = lines[hi].map((h) => h.toUpperCase().replace(/\s+/g, ' '));
  const colFor = (k: string) => head.indexOf(keyLabel(k).toUpperCase());
  const schools = await db.query<{ id: string; name: string; code: string }>(`select id, name, code from org_unit where kind = 'school'`);
  const nameCol = head.findIndex((h) => /SCHOOL/.test(h));
  const unknown: string[] = [];
  let saved = 0;
  await db.tx(async (t) => {
    for (const l of lines.slice(hi + 1)) {
      const label = l[nameCol >= 0 ? nameCol : 0];
      if (!label || /^(AVERAGE|HIGHEST|LOWEST|SCHOOL WITH)/i.test(label)) continue;
      const s = schools.find((x) => x.code.toLowerCase() === label.toLowerCase() || x.name.toLowerCase() === label.toLowerCase());
      if (!s) { unknown.push(label); continue; }
      for (const k of CLASS_KEYS) {
        const c = colFor(k); const v = c >= 0 ? Number(l[c]) : NaN;
        if (!l[c] || Number.isNaN(v)) continue;
        if (v < 0 || v > 100) throw invalid(`${label}, ${keyLabel(k)}: a PI must be between 0 and 100.`);
        await t.query(
          `insert into pi_snapshot (school_id, academic_year, class_key, scale, students, sum_ni, sum_wni, pi, source, frozen_by) values ($1,$2,$3,$4,0,0,0,$5,'IMPORTED',$6)
           on conflict (school_id, academic_year, class_key) do update set pi = excluded.pi, source = 'IMPORTED', frozen_by = excluded.frozen_by, frozen_at = now()
           where pi_snapshot.source = 'IMPORTED'`, [s.id, year, k, k.startsWith('X') && (k === 'X' || k.startsWith('XII')) ? 8 : 7, v, actor.id]);
        saved++;
      }
    }
  }, { actor: actor.label });
  return { saved, unknown };
}

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** The school's sheet as CSV, laid out like the NES workbook (opens in Excel). */
export function sheetCsv(s: Awaited<ReturnType<typeof schoolSheet>>) {
  const out: string[][] = [[s.school], [`Performance Index ${s.year} (CBSE ${s.boardYear})`], []];
  for (const [title, part, grades] of [['PART A – CLASSES VI to IX & XI (÷ 7)', s.partA, INTERNAL_GRADES], ['PART B – CLASSES X & XII (÷ 8)', s.partB, BOARD_GRADES]] as const) {
    out.push([title]);
    out.push(['Ser', 'Class / Stream', 'Name of the Topper', 'Admission Category of Topper', 'Total Marks Scored by Topper', 'Max Marks', 'Overall % of Topper', ...grades, 'Total (ΣNi)', 'No. of Students', 'Subjects Counted', 'Expected ΣNi', 'Check', 'Σ(Wi × Ni)', 'PI']);
    part.forEach((r, i) => out.push([String(i + 1), r.label, r.topper?.name ?? '', r.topper?.category ? `Cat - ${r.topper.category}` : '', String(r.topper?.total ?? ''), String(r.topper?.max ?? ''),
      r.topper ? `${(r.topper.pct * 100).toFixed(2)}%` : '', ...grades.map((g) => String(r.counts[g] ?? 0)), String(r.sumNi), String(r.students), r.counted, String(r.expected), r.check, String(r.sumWNi), r.pi == null ? '' : r.pi.toFixed(2)]));
    out.push([]);
  }
  return out.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

export function consolidationCsv(c: Awaited<ReturnType<typeof consolidation>>) {
  const out: string[][] = [[`CONSOLIDATED PERFORMANCE INDEX – ALL SCHOOLS ${c.year}`], ['VI–IX & XI: PI on 7-point scale (÷7). X & XII: CBSE relative grades (÷8).'], [],
    ['Ser', 'Name of School', ...CLASS_KEYS.map(keyLabel)]];
  c.matrix.forEach((m, i) => out.push([String(i + 1), m.school, ...CLASS_KEYS.map((k) => (m.pi[k] == null ? '' : m.pi[k]!.toFixed(2)))]));
  for (const [label, f] of [['Average PI', 'average'], ['Highest PI', 'highest'], ['Lowest PI', 'lowest'], ['School with highest PI', 'best']] as const)
    out.push(['', label, ...CLASS_KEYS.map((k) => { const x = c.stats[k]; return x ? String(f === 'best' ? x.best : (x[f] as number).toFixed(2)) : ''; })]);
  return out.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

/** Used by the school's own screens: is this school in the actor's reach? */
export async function assertSchool(db: Db, actor: Actor, schoolId: string) { await assertUnitInScope(db, actor, schoolId); }
