import type { Db } from '../db/client.js';
import { invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertStudentAccess } from './access.js';
import { currentEnrolment } from './sections.js';
import * as notify from './notify.js';
import * as approvals from './approvals.js';
import * as settings from './settings.js';
import { localToday } from '../lib/dates.js';

/**
 * Student leave. A parent applies; the request goes through the school's approval chain for
 * student leave (by default the class teacher, and the principal too for 4 days or more).
 * Leave longer than the school's limit needs a medical certificate before it can be approved.
 * Overlapping leave is refused by the database; approved leave becomes L in attendance.
 */

approvals.register('student_leave', {
  link: '/leave',
  async context(db, refId) {
    const r = await db.one<{ school_id: string; section_id: string | null }>(
      'select e.school_id, e.section_id from leave_request l join enrolment e on e.id = l.enrolment_id where l.id = $1', [refId]);
    return { schoolId: r.school_id, sectionId: r.section_id };
  },
  async beforeApprove(db, refId) {
    const l = await db.one<{ school_id: string; days: number }>(
      `select e.school_id, (upper(l.period) - lower(l.period))::int as days from leave_request l join enrolment e on e.id = l.enrolment_id where l.id = $1`, [refId]);
    const limit = await settings.get<number>(db, l.school_id, 'leave.certificate_after_days');
    if (l.days > limit) {
      const cert = await db.maybeOne(`select 1 from attachment where ref_kind = 'leave' and ref_id = $1 and removed_at is null`, [refId]);
      if (!cert) throw invalid(`Leave longer than ${limit} days needs a medical certificate. Ask the parent to upload it in the app.`);
    }
  },
  async onApproved(t, refId, actor, note) { await close(t, refId, actor, note, true); },
  async onRejected(t, refId, actor, note) { await close(t, refId, actor, note, false); },
});

async function close(t: Db, id: string, actor: Actor, note: string, approve: boolean) {
  const l = await t.one<{ student_id: string; from: string; to: string }>(
    `update leave_request set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1
     returning student_id, lower(period)::text as from, (upper(period) - 1)::text as to`, [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note || null]);
  await notify.toParentsOf(t, [l.student_id], { kind: 'LEAVE', title: approve ? 'Leave approved' : 'Leave not approved', body: `${notify.fmtRange(l.from, l.to)}${note ? ` · ${note}` : ''}`, link: '/leave' });
}

export async function apply(db: Db, actor: Actor, input: { studentId: string; from: string; to: string; reason: string }) {
  requireRole(actor, 'PARENT');
  await assertStudentAccess(db, actor, input.studentId, 'leave');
  if (input.to < input.from) throw invalid('The last day is before the first day.');
  const today = localToday();
  if (input.to < today) throw invalid('Leave cannot be applied for days that have passed.');
  const e = await currentEnrolment(db, input.studentId);
  return db.tx(async (t) => {
    const r = await t.one<{ id: string; days: number }>(
      `insert into leave_request (student_id, enrolment_id, period, reason, applied_by) values ($1, $2, daterange($3::date, ($4::date + 1)), $5, $6)
       returning id, (upper(period) - lower(period))::int as days`,
      [input.studentId, e.id, input.from, input.to, input.reason.trim(), actor.id]);
    const child = await t.one<{ name: string }>('select name from student where id = $1', [input.studentId]);
    const limit = await settings.get<number>(t, e.school_id, 'leave.certificate_after_days');
    const flow = await approvals.start(t, { kind: 'student_leave', schoolId: e.school_id, refId: r.id, title: `Leave: ${child.name}`,
      summary: `${notify.fmtRange(input.from, input.to)} · ${input.reason.trim().slice(0, 100)}`, facts: { days: r.days }, requestedBy: actor.id });
    return { id: r.id, steps: flow.steps.map((s) => s.label), certificateNeeded: r.days > limit };
  }, { actor: actor.label });
}

export async function cancel(db: Db, actor: Actor, id: string) {
  requireRole(actor, 'PARENT');
  const l = await db.maybeOne<{ student_id: string }>('select student_id from leave_request where id = $1', [id]);
  if (!l) throw notFound('Leave request');
  await assertStudentAccess(db, actor, l.student_id, 'leave');
  await db.tx(async (t) => {
    await t.query(`update leave_request set status = 'CANCELLED' where id = $1`, [id]);
    await approvals.cancel(t, 'student_leave', id);
  }, { actor: actor.label });
  return { ok: true };
}

/** Decides the current approval step for this leave. */
export async function decide(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  const r = await approvals.forRef(db, 'student_leave', id);
  if (!r) throw notFound('Leave request');
  return approvals.decide(db, actor, r.id, approve, note ?? '');
}

const SELECT = `select l.id, l.student_id, s.name as student_name, e.admission_no, e.class_code, sec.name as section,
                       lower(l.period)::text as from, (upper(l.period) - 1)::text as to, (upper(l.period) - lower(l.period))::int as days,
                       l.reason, l.status, l.applied_at, l.decision_note, d.name as decided_by_name, l.decided_at,
                       ar.id as approval_id, ar.steps as approval_steps, ar.current_step as approval_step,
                       coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'type', a.content_type)) from attachment a
                                  where a.ref_kind = 'leave' and a.ref_id = l.id and a.removed_at is null), '[]') as attachments
                  from leave_request l join student s on s.id = l.student_id join enrolment e on e.id = l.enrolment_id
                  left join section sec on sec.id = e.section_id left join app_user d on d.id = l.decided_by
                  left join approval_request ar on ar.kind = 'student_leave' and ar.ref_id = l.id`;

export async function forStudent(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'leave');
  return db.query(`${SELECT} where l.student_id = $1 order by lower(l.period) desc limit 50`, [studentId]);
}

/** Requests a teacher or principal should see: a teacher's own class, or the whole school. */
export async function forStaff(db: Db, actor: Actor, schoolId?: string) {
  requireRole(actor, 'TEACHER', 'SCHOOL_ADMIN', 'NES_ADMIN');
  if (actor.role === 'TEACHER') {
    return db.query(`${SELECT} where exists (select 1 from class_teacher ct where ct.section_id = sec.id and ct.user_id = $1 and ct.valid @> current_date) order by (l.status = 'PENDING') desc, lower(l.period) desc limit 100`, [actor.id]);
  }
  if (!schoolId) throw invalid('Choose a school.');
  await assertUnitInScope(db, actor, schoolId);
  return db.query(`${SELECT} where e.school_id = $1 order by (l.status = 'PENDING') desc, lower(l.period) desc limit 200`, [schoolId]);
}
