import type { Db } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertStudentAccess } from './access.js';
import { currentEnrolment } from './sections.js';
import { dues } from './fees.js';
import * as notices from './notices.js';
import { dayView } from './timetable.js';
import { localToday, daysFromToday } from '../lib/dates.js';

/**
 * Everything the parent app's home screen needs about one child, in one call. Admission
 * categories and fee bands are internal to NES and the school and are never included.
 */
export async function overview(db: Db, actor: Actor, studentId: string) {
  const g = await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  const today = localToday();
  const student = await db.maybeOne(
    `select s.id, s.nes_id, s.name, s.dob::text, s.gender, s.blood_group, s.pen, s.apaar_id,
            en.admission_no, en.class_code, cl.name as class_name, sec.name as section, en.status, lower(en.period)::text as joined,
            o.name as school, o.code as school_code, c.name as campus, c.address as campus_address,
            h.name as house, h.colour as house_colour, ct.name as class_teacher, st.slug as site_slug
       from student s join enrolment en on en.id = $2
       join class_level cl on cl.code = en.class_code join org_unit o on o.id = en.school_id join org_unit c on c.id = en.campus_id
       left join section sec on sec.id = en.section_id left join app_user ct on ct.id = class_teacher_of(sec.id)
       left join house h on h.id = en.house_id left join site st on st.school_id = en.school_id
      where s.id = $1`, [studentId, e.id]);
  if (!student) throw notFound('Student');

  const attendanceToday = await db.maybeOne<{ status: string }>(
    `select m.status from attendance_mark m join attendance_session a on a.id = m.session_id where m.enrolment_id = $1 and a.on_date = $2`, [e.id, today]);
  const attendanceYear = await db.one<{ present: number; marked: number }>(
    `select count(*) filter (where m.status = 'P')::int as present, count(*)::int as marked
       from attendance_mark m join attendance_session a on a.id = m.session_id join enrolment x on x.id = m.enrolment_id
      where x.student_id = $1 and a.on_date >= coalesce((select lower(period) from academic_year where period @> current_date), current_date - 365)`, [studentId]);

  const homework = e.section_id ? await db.query<{ id: string; subject: string; title: string; due_on: string }>(
    `select h.id, sj.name as subject, h.title, h.due_on::text from homework h join subject sj on sj.code = h.subject_code
      where h.section_id = $1 and h.withdrawn_at is null and h.due_on >= $2::date
        and not exists (select 1 from homework_done d where d.homework_id = h.id and d.student_id = $3)
      order by h.due_on, h.created_at limit 20`, [e.section_id, today, studentId]) : [];

  // The child's actual day (breaks, special days, cover). On a Sunday or holiday, the next school day.
  let classDay = today;
  let view = e.section_id ? await dayView(db, e.section_id, today) : null;
  const closedToday = view?.closed ?? null;
  for (let i = 1; view?.closed && i <= 21; i++) {
    classDay = new Date(Date.parse(`${today}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
    view = await dayView(db, e.section_id!, classDay);
  }
  const todayClasses = view && !view.closed ? view.rows : [];

  const horizon = daysFromToday(75);
  const events = (await notices.eventsForSchool(db, e.school_id, today, horizon)).slice(0, 4);
  const latestNotices = (await notices.forStudent(db, actor, studentId)).slice(0, 3);
  const owed = (await dues(db, studentId)) as { due_paise: number; due_date: string; installment_code: string; label: string }[];
  const due = owed.filter((d) => d.due_paise > 0);
  const { unread } = await db.one<{ unread: number }>('select count(*)::int as unread from notification where user_id = $1 and read_at is null', [actor.id]);
  const pendingLeave = await db.one<{ n: number }>(`select count(*)::int as n from leave_request where student_id = $1 and status = 'PENDING'`, [studentId]);

  if (!g.has('health')) (student as { blood_group?: unknown }).blood_group = null;
  return {
    grants: [...g],
    student,
    today: { date: today, attendance: g.has('attendance') ? attendanceToday?.status ?? null : null, closedToday, classDay, plan: view?.plan ?? null, classes: todayClasses },
    attendance: g.has('attendance') ? attendanceYear : null,
    homework: { pending: homework.length, next: homework.slice(0, 3) },
    events,
    notices: latestNotices,
    fees: !g.has('fee_status') ? null : !g.has('fees') ? { overdue: due.some((d) => d.due_date < today), duePaise: null, next: null } : { duePaise: due.reduce((s, d) => s + d.due_paise, 0), next: due[0] ? { installment: due[0].installment_code, label: due[0].label, dueDate: due[0].due_date } : null },
    unread,
    pendingLeave: g.has('leave') ? pendingLeave.n : null,
  };
}

export async function guardians(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'contact');
  return db.query(
    `select g.name, g.phone, g.email, sg.relationship, sg.is_primary from student_guardian sg join guardian g on g.id = sg.guardian_id
      where sg.student_id = $1 order by sg.is_primary desc, g.name`, [studentId]);
}
