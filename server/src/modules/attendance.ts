import type { Db } from '../db/client.js';
import { forbidden, invalid } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertTeaches, mySections as sectionsFor, sectionInfo } from './sections.js';
import * as duties from './duties.js';
import * as settings from './settings.js';
import * as approvals from './approvals.js';
import * as notify from './notify.js';
import { localToday } from '../lib/dates.js';
import { holidays } from './staffLeave.js';

/** The person's sections, each marked with whether they may take its roll today. */
export async function mySections(db: Db, actor: Actor) {
  const list = await sectionsFor(db, actor) as ({ id: string; school_id: string; is_class_teacher: boolean; is_co_class_teacher: boolean } & Record<string, unknown>)[];
  // Matches canTakeRoll: leadership, the school's attendance officer, or (below) the class's teachers.
  if (actor.role !== 'TEACHER') return list.map((s) => ({ ...s, can_take_roll: actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN'
    || actor.duties.some((d) => d.code === 'ATTENDANCE_OFFICER' && d.schoolId === s.school_id) }));
  const covering = new Set((await db.query<{ section_id: string }>('select section_id from substitution where on_date = current_date and substitute_id = $1', [actor.id])).map((r) => r.section_id));
  const rule = new Map<string, string>();
  const out = [];
  for (const s of list) {
    if (!rule.has(s.school_id)) rule.set(s.school_id, await settings.get<string>(db, s.school_id, 'attendance.taken_by'));
    const officer = actor.duties.some((d) => d.code === 'ATTENDANCE_OFFICER' && d.schoolId === s.school_id);
    out.push({ ...s, can_take_roll: s.is_class_teacher || s.is_co_class_teacher || covering.has(s.id) || officer || rule.get(s.school_id) === 'ANY_TEACHER' });
  }
  return out;
}

/**
 * Who takes the daily roll: the class teacher; the co-class teacher; a teacher covering the class
 * today; the school's attendance officer; or the principal. A school can widen this to any
 * teacher of the class (setting "Who takes the daily roll").
 */
async function canTakeRoll(db: Db, actor: Actor, sectionId: string) {
  const s = await sectionInfo(db, sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return s;
  if (await duties.has(db, actor.id, s.school_id, 'ATTENDANCE_OFFICER')) return s;
  if (actor.role !== 'TEACHER') throw forbidden();
  if (actor.id === s.class_teacher_id || actor.id === s.co_class_teacher_id) return s;
  if (await db.maybeOne('select 1 from substitution where section_id = $1 and on_date = current_date and substitute_id = $2', [sectionId, actor.id])) return s;
  if (await settings.get<string>(db, s.school_id, 'attendance.taken_by') === 'ANY_TEACHER') return assertTeaches(db, actor, sectionId);
  throw forbidden(`The roll for ${s.label} is taken by its class teacher${s.co_class_teacher_id ? ' or co-class teacher' : ''}.`);
}

const today = () => localToday();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export async function roster(db: Db, actor: Actor, sectionId: string, on: string) {
  const sec = await canTakeRoll(db, actor, sectionId);
  const session = await db.maybeOne<{ id: string; marked_at: string }>('select id, marked_at from attendance_session where section_id = $1 and on_date = $2', [sectionId, on]);
  const students = await db.query(
    `select e.id as enrolment_id, s.id as student_id, s.name, e.admission_no, m.status,
            exists (select 1 from leave_request l where l.student_id = s.id and l.status = 'APPROVED' and l.period @> $2::date) as on_leave
       from enrolment e join student s on s.id = e.student_id
       left join attendance_mark m on m.enrolment_id = e.id and m.session_id = $3
      where e.section_id = $1 and e.period @> $2::date order by s.name`, [sectionId, on, session?.id ?? null]);
  const window = await settings.get<number>(db, sec.school_id, 'attendance.correction_days');
  const age = daysBetween(on, today());
  const pending = session ? await db.maybeOne<{ id: string }>(
    `select id from approval_request where kind = 'attendance_correction' and status = 'PENDING' and payload->>'sessionId' = $1`, [session.id]) : null;
  return { sectionId, on, markedAt: session?.marked_at ?? null, windowDays: window,
    // Within the window the roll can be changed directly; after it, changes go for approval.
    needsApproval: !!session && age > window, correctionPending: !!pending, locked: false, students };
}

/** A school's roll for one day, for the principal's home: classes with the roll taken, and present, absent and on leave among them.
 *  On a Sunday or a school holiday no roll is expected (`noSchool`), so nothing is shown as missing. */
export async function schoolDay(db: Db, actor: Actor, schoolId: string, on: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN', 'COMMAND_OFFICER');
  await assertUnitInScope(db, actor, schoolId);
  const noSchool = new Date(`${on}T00:00:00Z`).getUTCDay() === 0 || (await holidays(db, schoolId, on, on)).has(on);
  const roll = await db.one<{ on: string; sections: number; marked: number; present: number; absent: number; leave: number }>(
    `select $2::text as on, count(distinct x.id)::int as sections, count(distinct a.id)::int as marked,
            count(m.enrolment_id) filter (where m.status = 'P')::int as present,
            count(m.enrolment_id) filter (where m.status = 'A')::int as absent,
            count(m.enrolment_id) filter (where m.status = 'L')::int as leave
       from section x join org_unit cp on cp.id = x.campus_id
       left join attendance_session a on a.section_id = x.id and a.on_date = $2::date
       left join attendance_mark m on m.session_id = a.id
      where cp.parent_id = $1 and exists (select 1 from enrolment e where e.section_id = x.id and e.period @> $2::date)`, [schoolId, on]);
  return { ...roll, noSchool };
}

approvals.register('attendance_correction', {
  link: '/attendance',
  async context(db, refId) {
    const r = await db.one<{ school_id: string; section_id: string }>(
      `select school_id, payload->>'sectionId' as section_id from approval_request where kind = 'attendance_correction' and ref_id = $1`, [refId]);
    return { schoolId: r.school_id, sectionId: r.section_id };
  },
  async onApproved(t, refId, actor) {
    const r = await t.one<{ payload: { sectionId: string; on: string; absent: { enrolmentId: string; status: 'A' | 'L' }[] } }>(
      `select payload from approval_request where kind = 'attendance_correction' and ref_id = $1`, [refId]);
    await t.query(`select set_config('app.attendance_correction', 'allowed', true)`);
    await writeRoll(t, actor, r.payload.sectionId, r.payload.on, r.payload.absent, false);
  },
  async onRejected() { /* the roll stays as it was */ },
});

async function writeRoll(t: Db, actor: Actor, sectionId: string, on: string, absent: { enrolmentId: string; status: 'A' | 'L' }[], alertParents: boolean) {
  const s = await t.one<{ id: string }>(
    `insert into attendance_session (section_id, on_date, marked_by) values ($1, $2, $3)
     on conflict (section_id, on_date) do update set marked_at = now(), marked_by = excluded.marked_by returning id`, [sectionId, on, actor.id]);
  const roll = await t.query<{ id: string; student_id: string; on_leave: boolean }>(
    `select e.id, e.student_id,
            exists (select 1 from leave_request l where l.student_id = e.student_id and l.status = 'APPROVED' and l.period @> $2::date) as on_leave
       from enrolment e where e.section_id = $1 and e.period @> $2::date`, [sectionId, on]);
  const map = new Map(absent.map((a) => [a.enrolmentId, a.status]));
  const newlyAbsent: string[] = [];
  let present = 0, absentCount = 0, leave = 0;
  for (const e of roll) {
    const status = map.get(e.id) ?? (e.on_leave ? 'L' : 'P');
    if (status === 'P') present++; else if (status === 'A') absentCount++; else leave++;
    const prev = await t.maybeOne<{ status: string }>('select status from attendance_mark where session_id = $1 and enrolment_id = $2', [s.id, e.id]);
    if (prev?.status === status) continue;
    await t.query(`insert into attendance_mark (session_id, enrolment_id, status) values ($1, $2, $3)
                   on conflict (session_id, enrolment_id) do update set status = excluded.status`, [s.id, e.id, status]);
    if (status === 'A') newlyAbsent.push(e.student_id);
  }
  if (alertParents) for (const sid of newlyAbsent) {
    await notify.toParentsOf(t, [sid], { kind: 'ATTENDANCE', title: on === today() ? 'Marked absent today' : 'Marked absent', body: `Marked absent on ${notify.fmt(on)}. If this is wrong, please message the class teacher.`, link: '/attendance' });
  }
  return { present, absent: absentCount, leave };
}

/**
 * Saves a day's attendance for a section. Anyone not listed is present, except children on
 * approved leave, who are marked L. A roll taken earlier can be corrected directly within the
 * school's correction window; after that the correction goes for approval (principal by default).
 * The database itself refuses any change to past attendance outside these two routes.
 */
export async function mark(db: Db, actor: Actor, sectionId: string, on: string, absent: { enrolmentId: string; status: 'A' | 'L' }[]) {
  requireRole(actor, 'TEACHER', 'SCHOOL_ADMIN', 'NES_ADMIN');
  const sec = await canTakeRoll(db, actor, sectionId);
  if (on > today()) throw invalid('Attendance cannot be marked for a future date.');
  const session = await db.maybeOne<{ id: string }>('select id from attendance_session where section_id = $1 and on_date = $2', [sectionId, on]);
  const age = daysBetween(on, today());
  const window = await settings.get<number>(db, sec.school_id, 'attendance.correction_days');
  if (session && age > window) {
    return db.tx(async (t) => {
      const flow = await approvals.start(t, { kind: 'attendance_correction', schoolId: sec.school_id, refId: crypto.randomUUID(),
        title: `Attendance correction: ${sec.label}, ${notify.fmt(on)}`, summary: `${absent.filter((a) => a.status === 'A').length} absent, ${absent.filter((a) => a.status === 'L').length} on leave after correction`,
        facts: { days: age }, requestedBy: actor.id, payload: { sessionId: session.id, sectionId, on, absent } });
      return { pendingApproval: true, approver: flow.steps[0].label };
    }, { actor: actor.label });
  }
  return db.tx(async (t) => {
    if (on < today()) await t.query(`select set_config('app.attendance_correction', 'allowed', true)`);
    return writeRoll(t, actor, sectionId, on, absent, true);
  }, { actor: actor.label });
}

/** A child's attendance for a month, for the parent app calendar. */
export async function forStudentMonth(db: Db, studentId: string, month: string) {
  const days = await db.query<{ on_date: string; status: string }>(
    `select a.on_date::text, m.status from attendance_mark m
       join attendance_session a on a.id = m.session_id join enrolment e on e.id = m.enrolment_id
      where e.student_id = $1 and a.on_date >= $2::date and a.on_date < ($2::date + interval '1 month') order by a.on_date`, [studentId, `${month}-01`]);
  const year = await db.one<{ present: number; marked: number }>(
    `select count(*) filter (where m.status = 'P')::int as present, count(*)::int as marked
       from attendance_mark m join attendance_session a on a.id = m.session_id join enrolment e on e.id = m.enrolment_id
      where e.student_id = $1 and a.on_date >= coalesce((select lower(period) from academic_year where period @> current_date), current_date - 365)`, [studentId]);
  return { month, days, year };
}
