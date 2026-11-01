import type { Db } from '../db/client.js';
import { forbidden } from '../lib/errors.js';
import type { Actor, Role } from './auth.js';
import * as settings from './settings.js';

/**
 * Who may see and do what. Two kinds of rule, both kept here as data:
 *
 *  1. School-wide permissions (fees, admissions, analysis…), given by role or by a duty held at
 *     that school. A teacher is never given the fee desk because they work at the school.
 *  2. What parts of one child's record a person may see. This depends on the person's relationship
 *     to the child: the child's own parent, the class teacher, a teacher who teaches the class,
 *     a duty (admission in-charge, counsellor…), or a role that sees everyone (principal, NES).
 *
 * Every endpoint that returns a child's data asks for the part it needs ("fees", "contact"…), and
 * every record screen strips the parts the person may not see. docs/ACCESS.md is the human version.
 */

export type Grant = 'profile' | 'contact' | 'service' | 'category' | 'fees' | 'fee_status' | 'health' | 'attendance' | 'academics' | 'leave' | 'documents';

export const GRANTS: Record<Grant, string> = {
  profile: 'Name, class, section, house and photo',
  contact: 'Parents’ phone numbers, email and address',
  service: 'Parent’s service, rank and posting',
  category: 'Admission category and fee band',
  fees: 'Fee dues, payments and receipts',
  fee_status: 'Whether fees are overdue (no amounts)',
  health: 'Blood group, allergies and medical notes',
  attendance: 'Attendance',
  academics: 'Marks, results and report cards',
  leave: 'Leave requests',
  documents: 'Certificates and documents',
};
const ALL = Object.keys(GRANTS) as Grant[];

/** What a role sees of every child it can reach (before any relationship). */
export const ROLE_GRANTS: Record<Role, Grant[]> = {
  NES_ADMIN: ALL,
  SCHOOL_ADMIN: ALL,
  COMMAND_OFFICER: ['profile', 'service', 'category', 'attendance', 'academics'],
  ACCOUNTANT: ['profile', 'contact', 'service', 'category', 'fees', 'fee_status'],
  TEACHER: ['profile'],
  STAFF: [],                                  // office and support staff see no child's record
  SUPPORT: [], DEVELOPER: [], CANDIDATE: [], ALUMNUS: [],  // the helpdesk, the developer, job applicants and alumni: no school data at all
  PARENT: ['profile', 'contact', 'service', 'fees', 'fee_status', 'health', 'attendance', 'academics', 'leave', 'documents'],
};
/** Extra for the class teacher and co-class teacher of the child's class. */
export const CLASS_TEACHER_GRANTS: Grant[] = ['contact', 'health', 'attendance', 'academics', 'leave', 'documents'];
/** Extra for a teacher who teaches the child's class. */
export const SUBJECT_TEACHER_GRANTS: Grant[] = ['attendance', 'academics'];
/** Extra for staff holding a duty at the child's school. */
export const DUTY_GRANTS: Record<string, Grant[]> = {
  ADMISSION_INCHARGE: ['contact', 'service', 'category', 'documents'],
  ATTENDANCE_OFFICER: ['contact', 'attendance', 'leave'],
  COUNSELLOR: ['contact', 'health', 'attendance', 'academics'],
  EXAM_INCHARGE: ['academics'],
  TRANSPORT_INCHARGE: ['contact'],
  NURSE: ['contact', 'health'],
};

/** School-wide permissions. */
export const PERMISSIONS = {
  'overview.view': { label: 'Network and school dashboards', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'] },
  'fees.view': { label: 'Fee plans, dues and defaulters', roles: ['NES_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'payments.view': { label: 'Collections and receipts', roles: ['NES_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'payments.collect': { label: 'Take a payment at the counter', roles: ['SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'admissions.view': { label: 'Applications and seats', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'], duties: ['ADMISSION_INCHARGE'] },
  'admissions.manage': { label: 'Process applications', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['ADMISSION_INCHARGE'] },
  'categories.view': { label: 'Admission categories and fee bands', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT'], duties: ['ADMISSION_INCHARGE'] },
  'students.export': { label: 'Download the student list', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['ADMISSION_INCHARGE'] },
  'attendance.register': { label: 'Attendance registers for every class', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'], duties: ['ATTENDANCE_OFFICER'] },
  'results.analysis': { label: 'Result analysis across classes and schools', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'], duties: ['EXAM_INCHARGE'] },
  'class_teachers.manage': { label: 'Allot class teachers', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'] },
  'audit.view': { label: 'Audit log', roles: ['NES_ADMIN'] },
  'library.manage': { label: 'The library: catalogue, issue and return, labels', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['LIBRARIAN'] },
  'cards.print': { label: 'Student and staff ID cards, photos', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['ADMISSION_INCHARGE'] },
  'certificates.prepare': { label: 'Preparing certificates', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['ADMISSION_INCHARGE'] },
  'printers.manage': { label: 'Printers and their calibration', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['LIBRARIAN', 'ADMISSION_INCHARGE'] },
  'staff.view': { label: 'Staff records and posts', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT'], duties: ['STAFF_RECORDS'] },
  'staff.manage': { label: 'Keeping the service book, posts and staff attendance', roles: ['SCHOOL_ADMIN'], duties: ['STAFF_RECORDS'] },
  'pay.view': { label: 'Salaries and pay structures', roles: ['SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'pay.prepare': { label: 'Preparing pay structures and payroll', roles: ['SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'pay.approve': { label: 'Approving pay structures and payroll', roles: ['SCHOOL_ADMIN'] },
  'pay.overview': { label: 'Salary cost and payroll status across schools', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'] },
  'transport.view': { label: 'Transport: routes, buses and children on them', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT'], duties: ['TRANSPORT_INCHARGE'] },
  'transport.manage': { label: 'Running the school transport', roles: ['SCHOOL_ADMIN'], duties: ['TRANSPORT_INCHARGE'] },
  'recruitment.view': { label: 'Recruitment: vacancies and applications', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'], duties: ['RECRUITMENT_INCHARGE'] },
  'recruitment.manage': { label: 'Running recruitment', roles: ['SCHOOL_ADMIN'], duties: ['RECRUITMENT_INCHARGE'] },
  'cwt.manage': { label: 'The Common Written Test (NES)', roles: ['NES_ADMIN'] },
  'cwt.setter': { label: 'Setting CWT question papers', roles: ['SCHOOL_ADMIN'], duties: ['EXAM_INCHARGE'] },
  'cwt.centre': { label: 'Running a CWT centre', roles: ['SCHOOL_ADMIN'], duties: ['RECRUITMENT_INCHARGE'] },
  'accounts.view': { label: 'Books of account and bank reconciliation', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'accounts.reconcile': { label: 'Importing bank statements and reconciling', roles: ['SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'statutory.manage': { label: 'Statutory rates (PF, ESI, professional tax, income tax)', roles: ['NES_ADMIN'] },
  'health.manage': { label: 'The infirmary, health records and check-ups', roles: ['SCHOOL_ADMIN'], duties: ['NURSE'] },
  'safety.manage': { label: 'Following up incidents and recording safety drills', roles: ['SCHOOL_ADMIN'], duties: ['SAFETY_OFFICER'] },
  'gate.manage': { label: 'The gate: visitors, gate passes and pickups', roles: ['SCHOOL_ADMIN'], duties: ['GATE_SECURITY'] },
  'stores.view': { label: 'Stores, stock and the asset register', roles: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT'], duties: ['STORE_KEEPER'] },
  'stores.manage': { label: 'Running the store: items, issues, orders, receipts and assets', roles: ['SCHOOL_ADMIN'], duties: ['STORE_KEEPER'] },
  'stores.pay': { label: 'Paying suppliers and depreciation', roles: ['SCHOOL_ADMIN', 'ACCOUNTANT'] },
  'alumni.manage': { label: 'Alumni: verification, directory and events', roles: ['NES_ADMIN', 'SCHOOL_ADMIN'], duties: ['ALUMNI_COORDINATOR'] },
} satisfies Record<string, { label: string; roles: Role[]; duties?: string[] }>;
export type Permission = keyof typeof PERMISSIONS;

/**
 * Everything the person may do, so the screens show only that (the server still checks each request):
 * permissions from the role hold everywhere in their scope; those from a duty only at that school.
 */
export function permissionsOf(actor: Actor) {
  const roles: Permission[] = [];
  const duties: Partial<Record<Permission, string[]>> = {};
  if (!actor.scopePath) return { roles, duties };
  for (const [k, p] of Object.entries(PERMISSIONS) as [Permission, { roles: Role[]; duties?: string[] }][]) {
    if (p.roles.includes(actor.role)) { roles.push(k); continue; }
    const at = [...new Set(actor.duties.filter((d) => p.duties?.includes(d.code)).map((d) => d.schoolId))];
    if (at.length) duties[k] = at;
  }
  return { roles, duties };
}

async function schoolOf(db: Db, unitId: string) {
  return (await db.maybeOne<{ id: string }>(`select s.id from org_unit u join org_unit s on s.kind = 'school' and u.path <@ s.path where u.id = $1`, [unitId]))?.id ?? null;
}

/** Whether the person has a school-wide permission, at a unit (school, campus) or in general. */
export async function can(db: Db, actor: Actor, perm: Permission, unitId?: string | null) {
  const p: { roles: Role[]; duties?: string[] } = PERMISSIONS[perm];
  if (!actor.scopePath) return false;
  if (unitId) {
    if (!/^[0-9a-f-]{36}$/i.test(unitId)) return false;
    if (!(await db.maybeOne('select 1 from org_unit where id = $1 and path <@ $2::ltree', [unitId, actor.scopePath]))) return false;
  }
  if (p.roles.includes(actor.role)) return true;
  if (!p.duties?.length) return false;
  const school = unitId ? await schoolOf(db, unitId) : null;
  return actor.duties.some((d) => p.duties!.includes(d.code) && (!unitId || d.schoolId === school));
}

export async function assertCan(db: Db, actor: Actor, perm: Permission, unitId?: string | null) {
  if (await can(db, actor, perm, unitId)) return;
  if (unitId && !/^[0-9a-f-]{36}$/i.test(unitId)) throw forbidden('Choose a school.');
  if (unitId && actor.scopePath && !(await db.maybeOne('select 1 from org_unit where id = $1 and path <@ $2::ltree', [unitId, actor.scopePath]))) {
    throw forbidden('This school is outside your access.');
  }
  throw forbidden(`${PERMISSIONS[perm].label} are not part of your role.`);
}

/** Schools where the person holds one of these duties today. */
export const dutySchools = (actor: Actor, codes: string[]) => actor.duties.filter((d) => codes.includes(d.code)).map((d) => d.schoolId);

/** The parts of one child's record this person may see. Throws if they may see nothing. */
export async function studentGrants(db: Db, actor: Actor, studentId: string): Promise<Set<Grant>> {
  if (!/^[0-9a-f-]{36}$/i.test(studentId)) throw forbidden();
  if (actor.role === 'PARENT') {
    const ok = await db.maybeOne('select 1 from student_guardian where student_id = $1 and guardian_id = $2', [studentId, actor.guardianId]);
    if (!ok) throw forbidden();
    return new Set(ROLE_GRANTS.PARENT);
  }
  if (!actor.scopePath) throw forbidden();
  const enr = await db.query<{ school_id: string; section_id: string | null; current: boolean }>(
    `select e.school_id, e.section_id, (e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)) as current
       from enrolment e join org_unit o on o.id = e.school_id where e.student_id = $1 and o.path <@ $2::ltree order by lower(e.period) desc`, [studentId, actor.scopePath]);
  if (!enr.length) throw forbidden('This student is outside your access.');
  const g = new Set<Grant>(ROLE_GRANTS[actor.role] ?? []);
  // Relationships count only for the child's current class and school.
  const cur = enr.find((e) => e.current);
  if (cur) {
    for (const d of actor.duties) if (d.schoolId === cur.school_id) for (const x of DUTY_GRANTS[d.code] ?? []) g.add(x);
    if (actor.role === 'TEACHER' && cur.section_id) {
      const rel = await db.one<{ ct: boolean; teaches: boolean }>(
        `select exists (select 1 from class_teacher where section_id = $1 and user_id = $2 and valid @> current_date) as ct,
                exists (select 1 from timetable t join timetable_slot x on x.timetable_id = t.id where t.section_id = $1 and t.valid @> current_date and x.teacher_id = $2) as teaches`,
        [cur.section_id, actor.id]);
      if (rel.ct) {
        for (const x of CLASS_TEACHER_GRANTS) g.add(x);
        if (await settings.get<boolean>(db, cur.school_id, 'privacy.class_teacher_fee_status')) g.add('fee_status');
      }
      if (rel.teaches) for (const x of SUBJECT_TEACHER_GRANTS) g.add(x);
    }
  }
  if (g.has('fees')) g.add('fee_status');
  return g;
}

/**
 * The check every child-data endpoint makes: that the person may see this part of this child's
 * record. Parents reach only their own children; staff only children in their part of NES, and
 * only the parts their role and relationship allow.
 */
export async function assertStudentAccess(db: Db, actor: Actor, studentId: string, need: Grant = 'profile') {
  const g = await studentGrants(db, actor, studentId);
  if (!g.has(need)) throw forbidden(`${GRANTS[need]} for this child are not shown to your role.`);
  return g;
}

/** Strictly a parent of this child. Anyone else, staff included, is refused. */
export async function assertGuardianOf(db: Db, actor: Actor, studentId: string) {
  if (actor.role !== 'PARENT') throw forbidden();
  await studentGrants(db, actor, studentId);
}
