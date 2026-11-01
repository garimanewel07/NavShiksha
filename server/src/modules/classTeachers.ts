import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { sectionInfo } from './sections.js';
import * as notify from './notify.js';
import { localToday } from '../lib/dates.js';
import { refreshDesignation } from './staff.js';

/**
 * Class teachers. The principal allots one class teacher (and optionally a co-class teacher) to
 * each class, from a date. The class teacher takes the roll, approves leave first, sees the
 * family's contact details, writes report remarks and gets the class's first period. When the
 * class teacher is away, the co-class teacher acts for them automatically for those days.
 */

const today = () => localToday();
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

/** The class teacher on a date, and the co-class teacher, and who is acting if the class teacher is away. */
export async function of(db: Db, sectionId: string, on = today()) {
  const r = await db.one<{ class_id: string | null; co_id: string | null; class_away: boolean }>(
    `select class_teacher_of($1, $2::date) as class_id, class_teacher_of($1, $2::date, 'CO') as co_id,
            exists (select 1 from teacher_absence a where a.teacher_id = class_teacher_of($1, $2::date) and a.withdrawn_at is null and a.period @> $2::date and a.periods is null) as class_away`,
    [sectionId, on]);
  const acting = r.class_id && !r.class_away ? r.class_id : (r.co_id ?? null);
  return { classTeacherId: r.class_id, coClassTeacherId: r.co_id, classTeacherAway: r.class_away, actingId: acting };
}

/** Is this person the class teacher (or the co-class teacher) of the section on a date? */
export async function roleIn(db: Db, userId: string, sectionId: string, on = today()): Promise<'CLASS' | 'CO' | null> {
  const r = await db.maybeOne<{ kind: 'CLASS' | 'CO' }>('select kind from class_teacher where section_id = $1 and user_id = $2 and valid @> $3::date', [sectionId, userId, on]);
  return r?.kind ?? null;
}

/** Sections where this teacher is class or co-class teacher today. */
export async function mine(db: Db, userId: string, on = today()) {
  return db.query<{ section_id: string; kind: 'CLASS' | 'CO'; label: string; school_id: string }>(
    `select x.section_id, x.kind, s.class_code || '-' || s.name as label, c.parent_id as school_id
       from class_teacher x join section s on s.id = x.section_id join org_unit c on c.id = s.campus_id
      where x.user_id = $1 and x.valid @> $2::date order by x.kind`, [userId, on]);
}

/**
 * The allotment board: every class with its class and co-class teacher, how many periods each
 * has with the class, and anything that needs attention; and every teacher with what they hold.
 */
export async function board(db: Db, actor: Actor, schoolId: string, year: string, on = today()) {
  await assertUnitInScope(db, actor, schoolId);
  const sections = await db.query<{ id: string; label: string; class_code: string; strength: number; class_id: string | null; class_name: string | null; class_from: string | null; class_row: string | null;
    co_id: string | null; co_name: string | null; co_row: string | null }>(
    `select s.id, s.class_code || '-' || s.name as label, s.class_code,
            (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL'))::int as strength,
            ct.user_id as class_id, cu.name as class_name, lower(ct.valid)::text as class_from, ct.id as class_row,
            co.user_id as co_id, ou.name as co_name, co.id as co_row
       from section s join org_unit c on c.id = s.campus_id join class_level cl on cl.code = s.class_code
       left join class_teacher ct on ct.section_id = s.id and ct.kind = 'CLASS' and ct.valid @> $3::date left join app_user cu on cu.id = ct.user_id
       left join class_teacher co on co.section_id = s.id and co.kind = 'CO' and co.valid @> $3::date left join app_user ou on ou.id = co.user_id
      where c.parent_id = $1 and s.academic_year = $2 order by cl.ordinal, s.name`, [schoolId, year, on]);
  // Periods a week each teacher has with each class (current timetable, or the teaching load).
  const periods = await db.query<{ section_id: string; teacher_id: string; n: number; subjects: string }>(
    `select section_id, teacher_id, sum(n)::int as n, string_agg(distinct subject, ', ') as subjects from (
       select t.section_id, x.teacher_id, count(*) as n, sj.name as subject from timetable t join timetable_slot x on x.timetable_id = t.id join subject sj on sj.code = x.subject_code
        where t.valid @> $1::date and x.teacher_id is not null group by 1, 2, 4
       union all
       select l.section_id, l.teacher_id, l.periods_per_week, sj.name from teaching_load l join subject sj on sj.code = l.subject_code
        where l.teacher_id is not null and not exists (select 1 from timetable t where t.section_id = l.section_id and t.valid @> $1::date)) z
      group by 1, 2`, [on]);
  const with_ = (sec: string, teacher: string | null) => (teacher ? periods.find((p) => p.section_id === sec && p.teacher_id === teacher) : undefined);
  const upcoming = await db.query<{ section_id: string; kind: string; name: string; from: string }>(
    `select x.section_id, x.kind, u.name, lower(x.valid)::text as from from class_teacher x join app_user u on u.id = x.user_id
      join section s on s.id = x.section_id join org_unit c on c.id = s.campus_id where c.parent_id = $1 and lower(x.valid) > $2::date`, [schoolId, on]);
  const teachers = await db.query<{ id: string; name: string; designation: string | null }>(
    `select u.id, u.name, u.designation from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'TEACHER' and u.scope_path <@ o.path order by u.name`, [schoolId]);
  const holds = (id: string) => sections.flatMap((s) => (s.class_id === id ? [{ label: s.label, kind: 'CLASS' }] : s.co_id === id ? [{ label: s.label, kind: 'CO' }] : []));
  return {
    on,
    sections: sections.map((s) => {
      const p = with_(s.id, s.class_id);
      const warnings: string[] = [];
      if (!s.class_id) warnings.push('No class teacher.');
      else if (!p) warnings.push(`${s.class_name} does not teach this class. A class teacher should have at least one subject with the class.`);
      return {
        id: s.id, label: s.label, classCode: s.class_code, strength: s.strength,
        classTeacher: s.class_id ? { id: s.class_id, row: s.class_row, name: s.class_name, from: s.class_from, periods: p?.n ?? 0, subjects: p?.subjects ?? null } : null,
        coClassTeacher: s.co_id ? { id: s.co_id, row: s.co_row, name: s.co_name, periods: with_(s.id, s.co_id)?.n ?? 0, subjects: with_(s.id, s.co_id)?.subjects ?? null } : null,
        upcoming: upcoming.filter((u) => u.section_id === s.id),
        teachers: periods.filter((x) => x.section_id === s.id).map((x) => ({ id: x.teacher_id, periods: x.n, subjects: x.subjects })),
        warnings,
      };
    }),
    teachers: teachers.map((t) => ({ ...t, holds: holds(t.id), periodsPerWeek: periods.filter((p) => p.teacher_id === t.id).reduce((n, p) => n + p.n, 0) })),
  };
}

/**
 * Allots a class teacher or co-class teacher from a date. The previous holder's assignment ends
 * the day before. If the teacher is already class teacher of another class, `move` ends that one
 * too; otherwise the principal is asked first.
 */
export async function assign(db: Db, actor: Actor, input: { sectionId: string; userId: string; kind: 'CLASS' | 'CO'; from: string; move?: boolean }) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  const s = await sectionInfo(db, input.sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  if (input.from < today()) throw invalid('Choose today or a later date. Past class teachers stay as they were.');
  const teacher = await db.maybeOne<{ name: string }>(`select u.name from app_user u join org_unit o on o.id = $2 where u.id = $1 and u.active and u.role = 'TEACHER' and u.scope_path <@ o.path`, [input.userId, s.school_id]);
  if (!teacher) throw invalid('Choose a teacher of this school.');
  const other = await db.maybeOne<{ id: string; label: string; section_id: string }>(
    `select x.id, s.class_code || '-' || s.name as label, x.section_id from class_teacher x join section s on s.id = x.section_id
      where x.user_id = $1 and x.valid @> $2::date and x.section_id <> $3 and x.kind = 'CLASS'`, [input.userId, input.from, input.sectionId]);
  if (input.kind === 'CLASS' && other && !input.move) {
    throw conflict('holds_other', `${teacher.name} is class teacher of ${other.label}. Move them to ${s.label}? ${other.label} will then need a new class teacher.`, { otherSection: other.label });
  }
  const both = await db.maybeOne(`select 1 from class_teacher where section_id = $1 and user_id = $2 and kind <> $3 and (upper(valid) is null or upper(valid) > $4::date)`, [input.sectionId, input.userId, input.kind, input.from]);
  if (both) throw invalid(`${teacher.name} is already the ${input.kind === 'CO' ? 'class teacher' : 'co-class teacher'} of ${s.label}. One person cannot be both class teacher and co-class teacher of a class.`);
  return db.tx(async (t) => {
    const close = async (where: string, params: unknown[]) => {
      // Not started yet: remove. Started: end the day before the new one begins.
      await t.query(`delete from class_teacher where ${where} and lower(valid) >= $${params.length + 1}::date`, [...params, input.from]);
      await t.query(`update class_teacher set valid = daterange(lower(valid), $${params.length + 1}::date) where ${where} and valid @> $${params.length + 1}::date`, [...params, input.from]);
    };
    await close(`section_id = $1 and kind = $2`, [input.sectionId, input.kind]);
    if (input.kind === 'CLASS' && other) await close(`id = $1`, [other.id]);
    const yearEnd = await t.maybeOne<{ upper: string | null }>(`select upper(y.period)::text as upper from section s join academic_year y on y.code = s.academic_year where s.id = $1`, [input.sectionId]);
    const r = await t.one<{ id: string }>(
      `insert into class_teacher (section_id, user_id, kind, valid, assigned_by) values ($1, $2, $3, daterange($4::date, $5::date), $6) returning id`,
      [input.sectionId, input.userId, input.kind, input.from, yearEnd?.upper ?? null, actor.id]);
    const role = input.kind === 'CLASS' ? 'class teacher' : 'co-class teacher';
    await refreshDesignation(t, input.userId);
    await notify.toUsers(t, [input.userId], { kind: 'NOTICE', title: `You are ${role} of ${s.label}`, body: `From ${notify.fmt(input.from)}.${other && input.move ? ` You are no longer class teacher of ${other.label}.` : ''}`, link: '/' });
    return { id: r.id, moved: other && input.move ? other.label : null };
  }, { actor: actor.label });
}

/** Ends an assignment from a date (the day before `on` is its last day). */
export async function end(db: Db, actor: Actor, id: string, on: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  const x = await db.maybeOne<{ section_id: string; from: string; user_id: string }>('select section_id, user_id, lower(valid)::text as from from class_teacher where id = $1', [id]);
  if (!x) throw notFound('Class teacher assignment');
  const s = await sectionInfo(db, x.section_id);
  await assertUnitInScope(db, actor, s.school_id);
  if (on < today()) throw invalid('Choose today or a later date.');
  await db.tx(async (t) => {
    if (x.from >= on) await t.query('delete from class_teacher where id = $1', [id]);
    else await t.query('update class_teacher set valid = daterange(lower(valid), $2::date) where id = $1', [id, on]);
    await refreshDesignation(t, x.user_id);
  }, { actor: actor.label });
  return { ended: dayBefore(on) };
}

/** A teacher's own class-teacher roles, for their day screen. */
export async function forTeacher(db: Db, actor: Actor) {
  if (actor.role !== 'TEACHER') throw forbidden();
  const list = await mine(db, actor.id);
  const out = [];
  for (const m of list) {
    const o = await of(db, m.section_id);
    out.push({ ...m, acting: o.actingId === actor.id, classTeacherAway: m.kind === 'CO' && o.classTeacherAway });
  }
  return out;
}
