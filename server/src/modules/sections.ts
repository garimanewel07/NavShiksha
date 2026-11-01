import type { Db } from '../db/client.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';

export interface SectionInfo { id: string; school_id: string; campus_id: string; class_code: string; name: string; label: string; class_teacher_id: string | null; co_class_teacher_id: string | null }

export async function sectionInfo(db: Db, sectionId: string): Promise<SectionInfo> {
  if (!/^[0-9a-f-]{36}$/i.test(sectionId)) throw notFound('Section');
  const s = await db.maybeOne<SectionInfo>(
    `select s.id, c.parent_id as school_id, s.campus_id, s.class_code, s.name, s.class_code || '-' || s.name as label,
            class_teacher_of(s.id) as class_teacher_id, class_teacher_of(s.id, current_date, 'CO') as co_class_teacher_id
       from section s join org_unit c on c.id = s.campus_id where s.id = $1`, [sectionId]);
  if (!s) throw notFound('Section');
  return s;
}

/**
 * Who may teach-side act on a section (attendance, homework, leave): the school's leadership in
 * scope, or a teacher who is its class teacher or has a period with it in the current timetable.
 */
export async function assertTeaches(db: Db, actor: Actor, sectionId: string) {
  const s = await sectionInfo(db, sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return s;
  if (actor.role !== 'TEACHER') throw forbidden();
  if (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id) return s;
  const teaches = await db.maybeOne(
    `select 1 from timetable t join timetable_slot x on x.timetable_id = t.id
      where t.section_id = $1 and t.valid @> current_date and x.teacher_id = $2 limit 1`, [sectionId, actor.id]);
  if (!teaches) throw forbidden('You do not teach this section.');
  return s;
}

/** Sections the person works with: a teacher's own sections, or every section for school leaders. */
export async function mySections(db: Db, actor: Actor) {
  const own = actor.role === 'TEACHER';
  return db.query(
    `select s.id, s.class_code, cl.name as class_name, s.name, s.academic_year, c.name as campus, o.name as school, o.id as school_id,
            (class_teacher_of(s.id) = $2) as is_class_teacher, (class_teacher_of(s.id, current_date, 'CO') = $2) as is_co_class_teacher,
            (select u.name from app_user u where u.id = class_teacher_of(s.id)) as class_teacher,
            exists (select 1 from timetable t where t.section_id = s.id and t.valid @> current_date) as has_timetable,
            (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL'))::int as strength
       from section s join org_unit c on c.id = s.campus_id join org_unit o on o.id = c.parent_id join class_level cl on cl.code = s.class_code
      where c.path <@ $1::ltree
        and (not $3 or exists (select 1 from class_teacher ct where ct.section_id = s.id and ct.user_id = $2 and ct.valid @> current_date) or exists (
              select 1 from timetable t join timetable_slot x on x.timetable_id = t.id
               where t.section_id = s.id and t.valid @> current_date and x.teacher_id = $2))
      order by (class_teacher_of(s.id) = $2) is true desc, o.name, cl.ordinal, s.name limit 300`, [actor.scopePath, actor.id, own]);
}

export interface CurrentEnrolment { id: string; school_id: string; campus_id: string; section_id: string | null; class_code: string }

export async function currentEnrolment(db: Db, studentId: string): Promise<CurrentEnrolment> {
  const e = await db.maybeOne<CurrentEnrolment>(
    `select id, school_id, campus_id, section_id, class_code from enrolment
      where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [studentId]);
  if (!e) throw notFound('Current enrolment');
  return e;
}

/**
 * Gives roll numbers in alphabetical order to children in a section who have none. Existing
 * numbers are kept, so a child joining mid-year gets the next free number.
 */
export async function assignRollNumbers(db: Db, actor: Actor, sectionId: string) {
  const s = await sectionInfo(db, sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  const allowed = actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN' || actor.id === s.class_teacher_id || actor.id === s.co_class_teacher_id
    || actor.duties.some((d) => d.code === 'ADMISSION_INCHARGE' && d.schoolId === s.school_id);
  if (!allowed) throw forbidden('Roll numbers are given by the class teacher or the office.');
  return db.tx(async (t) => {
    const kids = await t.query<{ id: string; roll_no: number | null }>(
      `select e.id, e.roll_no from enrolment e join student st on st.id = e.student_id where e.section_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') order by st.name`, [sectionId]);
    let next = Math.max(0, ...kids.map((k) => k.roll_no ?? 0));
    let given = 0;
    for (const k of kids.filter((x) => x.roll_no === null)) { await t.query('update enrolment set roll_no = $2 where id = $1', [k.id, ++next]); given++; }
    return { given, total: kids.length };
  }, { actor: actor.label });
}
