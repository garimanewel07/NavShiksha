import type { Db } from '../db/client.js';
import { forbidden, invalid } from '../lib/errors.js';
import { addDays, currentYear, localToday } from '../lib/dates.js';
import { reportPdf } from '../lib/reportPdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import * as inspections from './inspections.js';
import * as notify from './notify.js';

/**
 * Hierarchy insights: every school's figures side by side, rolled up NES → Command → school, each
 * compared with the network average, with early-warning flags that surface by themselves (late
 * on attendance, fees, payroll, results, inspections or decisions) and how well each school uses
 * NavShiksha. NES sees the network, a Command its schools, a principal their own school against
 * the network average (without other schools' names). The monthly MIS pack is the same, as a PDF.
 */

export interface SchoolFigures {
  id: string; name: string; command: string; commandId: string | null;
  students: number; attendance: number | null; rollCoverage: number | null; feesDue: number; feesPaid: number; collection: number | null;
  pi: number | null; piYear: string | null; posts: number; filled: number; vacancies: number; staffActive: number | null;
  payrollLastMonth: string | null; inspection: number | null; inspectedOn: string | null; openFindings: number; overdueFindings: number;
  reportsPending: number; flags: { level: 'red' | 'amber'; text: string }[];
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** The figures for every school under a unit, read live. */
async function figures(db: Db, scopePath: string): Promise<SchoolFigures[]> {
  const year = currentYear(), today = localToday(), from30 = addDays(today, -30), from14 = addDays(today, -14), from7 = addDays(today, -7);
  const lastMonth = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  const rows = await db.query<any>(
    `select s.id, s.name, c.name as command, c.id as command_id,
            (select count(*)::int from enrolment e where e.school_id = s.id and e.academic_year = $2 and e.status in ('ACTIVE', 'PROVISIONAL')) as students,
            (select round(100.0 * count(*) filter (where m.status = 'P') / nullif(count(*), 0), 1)::float
               from attendance_mark m join attendance_session a on a.id = m.session_id join section x on x.id = a.section_id join org_unit cp on cp.id = x.campus_id
              where cp.parent_id = s.id and a.on_date >= $3::date) as attendance,
            (select count(*)::int from attendance_session a join section x on x.id = a.section_id join org_unit cp on cp.id = x.campus_id where cp.parent_id = s.id and a.on_date >= $4::date) as sessions,
            (select count(distinct a.on_date)::int from attendance_session a join section x on x.id = a.section_id join org_unit cp on cp.id = x.campus_id where cp.parent_id = s.id and a.on_date >= $4::date) as roll_days,
            (select count(*)::int from section x join org_unit cp on cp.id = x.campus_id where cp.parent_id = s.id and x.academic_year = $2
               and exists (select 1 from enrolment e where e.section_id = x.id and e.status in ('ACTIVE', 'PROVISIONAL'))) as sections,
            (select coalesce(sum(d.net_paise), 0)::bigint from fee_demand d join enrolment e on e.id = d.enrolment_id join fee_installment i on i.plan_id = d.plan_id and i.code = d.installment_code
              where e.school_id = s.id and e.academic_year = $2 and i.due_date <= $6::date) as fees_due,
            (select coalesce(sum(pa.amount_paise), 0)::bigint from payment_allocation pa join fee_demand d on d.id = pa.demand_id join enrolment e on e.id = d.enrolment_id
               join fee_installment i on i.plan_id = d.plan_id and i.code = d.installment_code
              where e.school_id = s.id and e.academic_year = $2 and i.due_date <= $6::date) as fees_paid,
            -- Imported earlier years carry the PI without student counts: those are averaged plainly.
            (select p.academic_year from pi_snapshot p where p.school_id = s.id order by p.academic_year desc limit 1) as pi_year,
            (select round(coalesce(sum(p.pi * p.students) filter (where p.students > 0) / nullif(sum(p.students) filter (where p.students > 0), 0), avg(p.pi)), 1)::float from pi_snapshot p
              where p.school_id = s.id and p.academic_year = (select max(academic_year) from pi_snapshot q where q.school_id = s.id)) as pi,
            (select count(*)::int from post p where p.school_id = s.id and p.sanctioned @> $6::date) as posts,
            (select count(*)::int from post p where p.school_id = s.id and p.sanctioned @> $6::date and exists (select 1 from appointment a where a.post_id = p.id and a.valid @> $6::date)) as filled,
            (select count(*)::int from app_user u where u.active and u.scope_path = s.path and u.role in ('SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF')) as staff,
            (select count(distinct d.user_id)::int from sign_in_day d join app_user u on u.id = d.user_id where u.scope_path = s.path and u.role in ('SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF') and d.on_date >= $5::date) as staff_seen,
            (select r.status from payroll_run r where r.school_id = s.id and r.kind = 'REGULAR' and r.month = $7::date order by r.created_at desc limit 1) as payroll,
            (select count(*)::int from decision_school ds join decision d on d.id = ds.decision_id
              where ds.school_id = s.id and ds.reported_at is null and d.status in ('DECIDED', 'IN_PROGRESS', 'IMPLEMENTED') and d.decided_at < now() - interval '14 days') as reports_pending
       from org_unit s left join org_unit c on c.kind = 'command' and s.path <@ c.path
      where s.kind = 'school' and s.active and s.path <@ $1::ltree order by c.name nulls first, s.name`,
    [scopePath, year, from30, from14, from7, today, lastMonth]);
  const insp = new Map((await inspections.latestBySchool(db, scopePath)).map((x) => [x.school_id, x]));
  const dayOfMonth = Number(today.slice(8, 10));
  return rows.map((r) => {
    const i = insp.get(r.id);
    const f: SchoolFigures = {
      id: r.id, name: r.name, command: r.command ?? 'NES', commandId: r.command_id, students: r.students, attendance: r.attendance,
      rollCoverage: r.sections && r.roll_days ? Math.min(100, pct(r.sessions, r.sections * r.roll_days)!) : null,
      feesDue: Number(r.fees_due), feesPaid: Number(r.fees_paid), collection: pct(Number(r.fees_paid), Number(r.fees_due)),
      pi: r.pi, piYear: r.pi_year, posts: r.posts, filled: r.filled, vacancies: Math.max(0, r.posts - r.filled), staffActive: pct(r.staff_seen, r.staff),
      payrollLastMonth: r.payroll, inspection: i?.score ?? null, inspectedOn: i?.on ?? null, openFindings: i?.open_findings ?? 0, overdueFindings: i?.overdue_findings ?? 0,
      reportsPending: r.reports_pending, flags: [],
    };
    const flag = (level: 'red' | 'amber', text: string) => f.flags.push({ level, text });
    if (f.attendance !== null && f.attendance < 85) flag(f.attendance < 75 ? 'red' : 'amber', `Attendance ${f.attendance}% in the last 30 days`);
    if (f.students && f.rollCoverage !== null && f.rollCoverage < 90) flag(f.rollCoverage < 70 ? 'red' : 'amber', `Roll taken for ${f.rollCoverage}% of classes`);
    if (f.students && f.rollCoverage === null) flag('red', 'No attendance marked in two weeks');
    if (f.collection !== null && f.collection < 85) flag(f.collection < 70 ? 'red' : 'amber', `${f.collection}% of fees due collected`);
    if (dayOfMonth > 7 && f.students && !['LOCKED', 'PAID'].includes(f.payrollLastMonth ?? '')) flag('amber', `Last month’s payroll ${f.payrollLastMonth ? `still ${f.payrollLastMonth.toLowerCase()}` : 'not started'}`);
    if (f.posts && f.vacancies / f.posts > 0.1) flag('amber', `${f.vacancies} of ${f.posts} posts vacant`);
    if (f.staffActive !== null && f.staffActive < 60) flag('amber', `Only ${f.staffActive}% of staff used NavShiksha this week`);
    if (f.overdueFindings) flag('red', `${f.overdueFindings} inspection finding(s) overdue`);
    if (f.reportsPending) flag('amber', `${f.reportsPending} decision(s) without an action-taken report`);
    return f;
  });
}

/** Averages over a set of schools (students weigh attendance and PI; money weighs collection). */
function average(list: SchoolFigures[]) {
  const mean = (xs: (number | null)[], ws?: number[]) => {
    let s = 0, w = 0;
    xs.forEach((x, i) => { if (x !== null && x !== undefined) { const k = ws ? ws[i] : 1; s += x * k; w += k; } });
    return w ? Math.round((s / w) * 10) / 10 : null;
  };
  const students = list.map((s) => s.students || 0);
  const due = list.reduce((a, s) => a + s.feesDue, 0), paid = list.reduce((a, s) => a + s.feesPaid, 0);
  return {
    schools: list.length, students: students.reduce((a, b) => a + b, 0),
    attendance: mean(list.map((s) => s.attendance), students), rollCoverage: mean(list.map((s) => s.rollCoverage)), collection: pct(paid, due), feesDue: due, feesPaid: paid,
    pi: mean(list.map((s) => s.pi), students), posts: list.reduce((a, s) => a + s.posts, 0), vacancies: list.reduce((a, s) => a + s.vacancies, 0),
    staffActive: mean(list.map((s) => s.staffActive)), inspection: mean(list.map((s) => s.inspection)),
    openFindings: list.reduce((a, s) => a + s.openFindings, 0), flagged: list.filter((s) => s.flags.some((f) => f.level === 'red')).length,
  };
}

/**
 * The insights for the person: NES the network (by Command, then schools), a Command its schools,
 * a principal their school beside the network average. `unitId` drills down to a Command.
 */
export async function overview(db: Db, actor: Actor, unitId?: string) {
  if (!actor.scopePath || !['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(actor.role)) throw forbidden('Insights are for NES, the Commands and principals.');
  const network = (await db.one<{ path: string }>(`select path::text from org_unit where kind = 'society' order by nlevel(path) limit 1`)).path;
  const all = await figures(db, network);
  const avg = average(all);
  if (actor.role === 'SCHOOL_ADMIN') {
    const own = await db.query<{ id: string }>(`select id from org_unit where kind = 'school' and path <@ $1::ltree`, [actor.scopePath]);
    const ids = new Set(own.map((o) => o.id));
    // Other schools are shown only as the network average and where this school stands among them.
    return { level: 'school', network: avg, schools: all.filter((s) => ids.has(s.id)).map((s) => ({ ...s, rank: rankOf(all, s) })), commands: [] };
  }
  let scope = actor.scopePath;
  if (unitId) { await assertUnitInScope(db, actor, unitId); scope = (await db.one<{ path: string }>('select path::text from org_unit where id = $1', [unitId])).path; }
  const own = await figures(db, scope);
  const byCommand = new Map<string, SchoolFigures[]>();
  for (const s of own) byCommand.set(s.commandId ?? '', [...(byCommand.get(s.commandId ?? '') ?? []), s]);
  return {
    level: actor.role === 'NES_ADMIN' && !unitId ? 'network' : 'command', network: avg, scope: average(own),
    commands: [...byCommand.entries()].map(([id, list]) => ({ id: id || null, name: list[0].command, ...average(list) })),
    schools: own,
  };
}

/** Where a school stands among all schools on each figure ("4th of 12"), without naming the others. */
function rankOf(all: SchoolFigures[], s: SchoolFigures) {
  const place = (get: (x: SchoolFigures) => number | null) => {
    const v = get(s); if (v === null) return null;
    const vals = all.map(get).filter((x): x is number => x !== null);
    return { place: vals.filter((x) => x > v).length + 1, of: vals.length };
  };
  return { attendance: place((x) => x.attendance), collection: place((x) => x.collection), pi: place((x) => x.pi), inspection: place((x) => x.inspection), rollCoverage: place((x) => x.rollCoverage) };
}

export async function misPack(db: Db, actor: Actor, unitId?: string) {
  const o: any = await overview(db, actor, unitId);
  if (o.level === 'school') throw invalid('The MIS pack is for NES and the Commands.');
  const month = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const n = (x: number | null, suffix = '%') => (x === null || x === undefined ? '—' : `${x}${suffix}`);
  const lakh = (p: number) => `Rs ${(p / 1e7).toFixed(2)} lakh`;
  return reportPdf(`MIS pack · ${month}`, o.level === 'network' ? 'Navy Children Schools and Navy Kindergartens, all Commands' : o.commands[0]?.name ?? '', (r) => {
    const s = o.scope;
    r.heading('At a glance');
    r.pairs([['Schools', String(s.schools)], ['Students', s.students.toLocaleString('en-IN')], ['Attendance (30 days)', n(s.attendance)], ['Roll taken', n(s.rollCoverage)],
      ['Fees collected of due', `${n(s.collection)} (${lakh(s.feesPaid)} of ${lakh(s.feesDue)})`], ['Performance Index', n(s.pi, '')],
      ['Posts vacant', `${s.vacancies} of ${s.posts}`], ['Staff using NavShiksha (7 days)', n(s.staffActive)], ['Latest inspection score', n(s.inspection)], ['Schools with red flags', String(s.flagged)]]);
    if (o.level === 'network') {
      r.heading('By Command');
      r.table([{ label: 'Command', width: 30 }, { label: 'Schools', width: 10, align: 'right' }, { label: 'Students', width: 12, align: 'right' }, { label: 'Attendance', width: 13, align: 'right' },
        { label: 'Fees', width: 11, align: 'right' }, { label: 'PI', width: 9, align: 'right' }, { label: 'Vacant', width: 10, align: 'right' }, { label: 'Red flags', width: 11, align: 'right' }],
        o.commands.map((c: any) => [c.name, String(c.schools), c.students.toLocaleString('en-IN'), n(c.attendance), n(c.collection), n(c.pi, ''), String(c.vacancies), String(c.flagged)]));
    }
    r.heading('Schools');
    r.table([{ label: 'School', width: 34 }, { label: 'Students', width: 11, align: 'right' }, { label: 'Attend.', width: 10, align: 'right' }, { label: 'Roll', width: 9, align: 'right' },
      { label: 'Fees', width: 9, align: 'right' }, { label: 'PI', width: 8, align: 'right' }, { label: 'Vacant', width: 9, align: 'right' }, { label: 'Inspection', width: 11, align: 'right' }],
      o.schools.map((x: SchoolFigures) => [x.name, x.students.toLocaleString('en-IN'), n(x.attendance), n(x.rollCoverage), n(x.collection), n(x.pi, ''), `${x.vacancies}/${x.posts}`, n(x.inspection)]));
    const flagged = o.schools.filter((x: SchoolFigures) => x.flags.length);
    r.heading('Early warnings');
    if (!flagged.length) r.para('No school is flagged this month.');
    else r.table([{ label: 'School', width: 34 }, { label: 'What needs attention', width: 80 }], flagged.map((x: SchoolFigures) => [x.name, x.flags.map((f) => `${f.level === 'red' ? '■' : '□'} ${f.text}`).join('\n')]));
    r.para('Attendance and roll over the last 30 and 14 days; fees are of instalments already due this year; PI is the latest year reported; vacancies are sanctioned posts with nobody appointed.', { muted: true, size: 8 });
  });
}

/** On the first of each month: tells NES and every Command that their MIS pack is ready. */
export async function monthly(db: Db) {
  const today = localToday();
  if (today.slice(8, 10) !== '01') return 0;
  const already = await db.maybeOne(`select 1 from notification where kind = 'GOVERNANCE' and title like 'MIS pack%' and created_at::date = current_date limit 1`);
  if (already) return 0;
  const users = await db.query<{ id: string }>(`select id from app_user where active and role in ('NES_ADMIN', 'COMMAND_OFFICER')`);
  const month = new Date(`${addDays(today, -1)}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return db.tx((t) => notify.toUsers(t, users.map((u) => u.id), { kind: 'GOVERNANCE', title: `MIS pack for ${month} is ready`, body: 'Figures for every school, with early warnings.', link: '/insights' }), { actor: 'NavShiksha MIS' });
}
