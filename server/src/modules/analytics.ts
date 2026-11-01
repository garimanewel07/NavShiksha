import type { Db } from '../db/client.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';
import { forbidden } from '../lib/errors.js';
import { boardYear, CLASS_KEYS, keyLabel, rows as piRows } from './pi.js';

/**
 * The NES results dashboard's data: for each year asked (the latest five by default), every
 * school's Performance Index by class and stream, subject averages and grade spreads, and the CBSE
 * results; with the schools and Commands for slicing. The screen filters and compares it, so one
 * request serves every view.
 */
export async function results(db: Db, actor: Actor, o: { years: string[]; code: string }) {
  // NES sees the whole network and a Command its own schools (by scope); schools use their PI sheet.
  if (actor.role !== 'NES_ADMIN' && actor.role !== 'COMMAND_OFFICER') throw forbidden('The results dashboard is for NES and the Commands.');
  await assertCan(db, actor, 'results.analysis');
  const known = (await db.query<{ y: string }>(
    `select y from (select code as y from academic_year union select academic_year from pi_snapshot) x where y <= (select max(code) from academic_year) order by y desc limit 6`)).map((r) => r.y);
  const years = (o.years.length ? o.years : known.slice(0, 5)).filter((y) => /^\d{4}-\d{2}$/.test(y)).slice(0, 8);
  const schools = await db.query<{ id: string; name: string; code: string; type: string; command: string | null }>(
    `select o.id, o.name, o.code, o.school_type as type, (select c.name from org_unit c where c.kind = 'command' and o.path <@ c.path limit 1) as command
       from org_unit o where o.kind = 'school' and o.active and o.path <@ $1::ltree order by o.name`, [actor.scopePath]);
  const pi = [], subjects = [], board = [];
  for (const y of years) {
    const r = await piRows(db, actor.scopePath!, y, o.code);
    pi.push(...r.rows.map((x) => ({ year: y, schoolId: x.schoolId, classKey: x.classKey, scale: x.scale, students: x.students, counts: x.counts, pi: x.pi, sumNi: x.sumNi, sumWNi: x.sumWNi,
      topper: x.topper ? { name: x.topper.name, pct: Math.round(x.topper.pct * 1000) / 10 } : null, source: x.source })));
    subjects.push(...r.subjects.map((x) => ({ year: y, ...x })));
    board.push(...(await db.query(
      `select $2::text as year, b.school_id as "schoolId", b.class_code as "classCode", count(*)::int as candidates, count(*) filter (where b.result = 'PASS')::int as passed,
              round(avg(b.percentage), 1)::float as average, count(*) filter (where b.percentage >= 90)::int as above90, count(*) filter (where b.percentage >= 95)::int as above95,
              max(b.percentage)::float as highest
         from board_result b join org_unit o on o.id = b.school_id where o.path <@ $1::ltree and b.year = $3 group by b.school_id, b.class_code`, [actor.scopePath, y, boardYear(y)])));
  }
  return { years, known, code: o.code, classKeys: CLASS_KEYS, labels: Object.fromEntries(CLASS_KEYS.map((k) => [k, keyLabel(k)])), schools, pi, subjects, board };
}
