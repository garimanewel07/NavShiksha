import type { Db } from '../db/client.js';
import { forbidden } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';

/** The Muster: strength, categories, class-wise split, posting movement, seat pressure. All live. */
export async function muster(db: Db, actor: Actor, year: string) {
  await assertCan(db, actor, 'overview.view');
  const scope = actor.scopePath;
  const active = `from enrolment e join org_unit o on o.id = e.school_id
                  where o.path <@ $1::ltree and e.academic_year = $2 and e.status in ('ACTIVE', 'PROVISIONAL')`;
  const totals = await db.one<{ students: number; schools: number; provisional: number; tc_overdue: number }>(
    `select count(*)::int as students, count(distinct e.school_id)::int as schools,
            count(*) filter (where e.status = 'PROVISIONAL')::int as provisional,
            count(*) filter (where e.status = 'PROVISIONAL' and e.tc_due_date < current_date)::int as tc_overdue ${active}`, [scope, year]);
  const byCategory = await db.query<{ code: string; n: number }>(
    `select e.admission_category as code, count(*)::int as n ${active} group by 1 order by 1`, [scope, year]);
  const byClass = await db.query<{ class_code: string; name: string; ordinal: number; code: string; n: number }>(
    `select e.class_code, cl.name, cl.ordinal, e.admission_category as code, count(*)::int as n ${active.replace('from enrolment e', 'from enrolment e join class_level cl on cl.code = e.class_code')}
     group by 1, 2, 3, 4 order by cl.ordinal`, [scope, year]);
  const movement = await db.one<{ cat1_in: number; cat1_out: number; transfers: number; left_nes: number }>(
    `select count(*) filter (where n.admission_category = '1')::int as cat1_in,
            count(*) filter (where p.admission_category = '1')::int as cat1_out,
            count(*)::int as transfers,
            (select count(*)::int from enrolment w join org_unit wo on wo.id = w.school_id
              where wo.path <@ $1::ltree and w.academic_year = $2 and w.status = 'WITHDRAWN') as left_nes
       from enrolment p join enrolment n on n.id = p.transferred_to
       join org_unit po on po.id = p.school_id join org_unit no on no.id = n.school_id
      where (po.path <@ $1::ltree or no.path <@ $1::ltree) and p.academic_year = $2`, [scope, year]);
  const flows = await db.query<{ from_school: string; to_school: string; n: number }>(
    `select po.name as from_school, no.name as to_school, count(*)::int as n
       from enrolment p join enrolment n on n.id = p.transferred_to
       join org_unit po on po.id = p.school_id join org_unit no on no.id = n.school_id
      where (po.path <@ $1::ltree or no.path <@ $1::ltree) and p.academic_year = $2
      group by 1, 2 order by 3 desc limit 14`, [scope, year]);
  const seats = await db.query<{ school: string; campus: string; class_code: string; capacity: number; filled: number }>(
    `select o.name as school, c.name as campus, s.class_code, sum(s.capacity)::int as capacity,
            (select count(*) from enrolment e where e.campus_id = c.id and e.class_code = s.class_code and e.academic_year = $2
               and e.status in ('ACTIVE', 'PROVISIONAL'))::int as filled
       from section s join org_unit c on c.id = s.campus_id join org_unit o on o.id = c.parent_id
      where o.path <@ $1::ltree and s.academic_year = $2
      group by o.name, c.id, c.name, s.class_code`, [scope, year]);
  const full = seats.filter((s) => s.filled >= s.capacity);
  const bySchool = new Map<string, { school: string; full: string[]; free: number }>();
  for (const s of seats) {
    const b = bySchool.get(s.school) ?? { school: s.school, full: [], free: 0 };
    b.free += Math.max(0, s.capacity - s.filled);
    if (s.filled >= s.capacity) b.full.push(s.class_code);
    bySchool.set(s.school, b);
  }
  const cat1 = byCategory.find((c) => c.code === '1')?.n ?? 0;
  const highlights = [
    movement.transfers > 0
      ? { tone: 'strength', text: `${movement.cat1_in} Cat 1 children joined and ${movement.cat1_out} left on postings this year.`, link: 'See movement' }
      : { tone: 'strength', text: `${cat1.toLocaleString('en-IN')} Cat 1 children are on the rolls.`, link: 'See categories' },
    full.length
      ? { tone: 'action', text: `${full[0].school} has no free seats in Class ${full[0].class_code}${full.length > 1 ? ` and ${full.length - 1} more classes across schools` : ''}.`, link: 'Plan seats' }
      : { tone: 'strength', text: 'Every class has free seats.', link: 'See seats' },
    totals.tc_overdue
      ? { tone: 'watch', text: `${totals.tc_overdue} provisional admissions are past their TC due date.`, link: 'Follow up' }
      : { tone: 'watch', text: `${totals.provisional} admissions are provisional, awaiting the original TC.`, link: 'Follow up' },
  ];
  return { year, totals: { ...totals, cat1 }, byCategory, byClass, movement, flows, seatPressure: [...bySchool.values()].sort((a, b) => a.free - b.free), highlights };
}
