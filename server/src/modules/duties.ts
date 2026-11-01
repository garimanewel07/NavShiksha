import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { localToday } from '../lib/dates.js';

/**
 * Duties: responsibilities a staff member holds at a school beyond their role, for a period.
 * A teacher who is timetable coordinator can manage cover and timings without being given the
 * principal's powers. Permissions throughout the ERP check duties through this module.
 */
export const DUTIES: Record<string, { label: string; gives: string }> = {
  TIMETABLE_COORDINATOR: { label: 'Timetable coordinator', gives: 'Timetables, school timings, special days and cover for absent teachers' },
  EXAM_INCHARGE: { label: 'Exam in-charge', gives: 'Exams and papers, marks progress, locking marks' },
  ADMISSION_INCHARGE: { label: 'Admission in-charge', gives: 'Applications, document checks and seat offers' },
  WEBSITE_EDITOR: { label: 'Website editor', gives: 'Editing the school website (the principal publishes)' },
  ATTENDANCE_OFFICER: { label: 'Attendance officer', gives: 'Attendance for every class, and approving late corrections' },
  HOUSE_MASTER: { label: 'House master', gives: 'House activities and points' },
  TRANSPORT_INCHARGE: { label: 'Transport in-charge', gives: 'Routes, buses and transport attendance' },
  LIBRARIAN: { label: 'Librarian', gives: 'Library catalogue, issue and return' },
  COUNSELLOR: { label: 'Counsellor', gives: 'Counselling records' },
  STAFF_RECORDS: { label: 'Staff records (office superintendent)', gives: 'Service book, posts, staff attendance and leave records' },
  RECRUITMENT_INCHARGE: { label: 'Recruitment in-charge', gives: 'Vacancies, screening applications, interviews and messages to candidates (the principal publishes and selects)' },
  NURSE: { label: 'School nurse', gives: 'The infirmary register, children’s health records, check-ups and immunisations' },
  GATE_SECURITY: { label: 'Gate security', gives: 'Visitors, badges, gate passes and checking who collects a child' },
  STORE_KEEPER: { label: 'Store keeper', gives: 'Stock, issues, purchase orders, goods received and the asset register' },
  ALUMNI_COORDINATOR: { label: 'Alumni coordinator', gives: 'Verifying alumni, the alumni directory, reunions and newsletters' },
  SAFETY_OFFICER: { label: 'Safety officer', gives: 'Following up incidents (including confidential ones) and safety drills' },
};
export type DutyCode = keyof typeof DUTIES;

const today = () => localToday();

export async function has(db: Db, userId: string, schoolId: string, code: string, on = today()) {
  return !!(await db.maybeOne('select 1 from duty where user_id = $1 and school_id = $2 and code = $3 and valid @> $4::date', [userId, schoolId, code, on]));
}

/** School leadership, or a staff member holding the duty at this school. */
export async function assertLeaderOrDuty(db: Db, actor: Actor, schoolId: string, code: DutyCode) {
  await assertUnitInScope(db, actor, schoolId);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return;
  if (await has(db, actor.id, schoolId, code)) return;
  throw forbidden(`This needs the ${DUTIES[code].label} duty.`);
}

export async function mine(db: Db, userId: string) {
  return db.query<{ school_id: string; code: string }>(`select school_id, code from duty where user_id = $1 and valid @> current_date`, [userId]);
}

export async function list(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select d.id, d.code, d.user_id, u.name, u.designation, lower(d.valid)::text as from, upper(d.valid)::text as to, a.name as assigned_by
       from duty d join app_user u on u.id = d.user_id join app_user a on a.id = d.assigned_by
      where d.school_id = $1 and (upper(d.valid) is null or upper(d.valid) > current_date) order by d.code, u.name`, [schoolId]);
}

export async function staff(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(`select u.id, u.name, u.designation, u.role from app_user u join org_unit o on o.id = $1
                    where u.active and u.role <> 'PARENT' and u.scope_path <@ o.path and u.role in ('TEACHER', 'ACCOUNTANT', 'SCHOOL_ADMIN', 'STAFF') order by u.name`, [schoolId]);
}

export async function assign(db: Db, actor: Actor, schoolId: string, input: { userId: string; code: string; from: string; to?: string | null }) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  if (!DUTIES[input.code]) throw invalid('Unknown duty.');
  if (input.to && input.to <= input.from) throw invalid('The duty must end after it starts.');
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into duty (school_id, user_id, code, valid, assigned_by) values ($1, $2, $3, daterange($4::date, $5::date), $6) returning id`,
    [schoolId, input.userId, input.code, input.from, input.to ?? null, actor.id]), { actor: actor.label });
  return r;
}

/** Ends a duty from a date (the person keeps it until the day before). */
export async function end(db: Db, actor: Actor, id: string, on: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  const d = await db.maybeOne<{ school_id: string; from: string }>('select school_id, lower(valid)::text as from from duty where id = $1', [id]);
  if (!d) throw notFound('Duty');
  await assertUnitInScope(db, actor, d.school_id);
  if (on <= d.from) throw invalid('Choose a date after the duty started.');
  await db.tx((t) => t.query('update duty set valid = daterange(lower(valid), $2::date) where id = $1', [id, on]), { actor: actor.label });
  return { ok: true };
}
