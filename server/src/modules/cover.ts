import type { Db } from '../db/client.js';
import { invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { sectionInfo } from './sections.js';
import { assertTimetableManager, bellFor, isoWeekday, toMin, fromMin, DAYS } from './timetable.js';
import * as notify from './notify.js';
import * as appSettings from './settings.js';
import { localToday } from '../lib/dates.js';

/**
 * Cover for absent teachers. The school marks a teacher absent; every lesson they would have
 * taught that day becomes a "need". For each need the system ranks free teachers by how well
 * they fit (same subject, same class) and how much cover they have already done, and can fill
 * the whole day in one action within the school's fairness limits.
 */

const today = () => localToday();

interface Lesson { section_id: string; label: string; class_code: string; period: number; starts: string; ends: string; subject_code: string; subject: string; teacher_id: string | null; teacher: string | null }
interface Absence { id: string; teacher_id: string; teacher: string; periods: number[] | null; reason: string; from: string; to: string }
interface Sub { section_id: string; period_no: number; kind: string; substitute_id: string | null; substitute: string | null; merged_with: string | null; merged_label: string | null; starts: string; ends: string; auto: boolean }

export interface Settings { max_proxy_day: number; max_proxy_week: number; max_periods_day: number }

/** Cover limits come from Settings (NES default, overridable by the Command or school). */
export async function settings(db: Db, schoolId: string): Promise<Settings> {
  return {
    max_proxy_day: await appSettings.get<number>(db, schoolId, 'timetable.max_proxy_day'),
    max_proxy_week: await appSettings.get<number>(db, schoolId, 'timetable.max_proxy_week'),
    max_periods_day: await appSettings.get<number>(db, schoolId, 'timetable.max_periods_day'),
  };
}

/** Saves the school's cover limits as school settings from today. Principals only (settings belong to leadership). */
export async function saveSettings(db: Db, actor: Actor, schoolId: string, s: Settings) {
  for (const k of ['max_proxy_day', 'max_proxy_week', 'max_periods_day'] as const) {
    await appSettings.set(db, actor, schoolId, { key: `timetable.${k}`, value: s[k], from: today(), note: 'Changed from the cover screen' });
  }
  return s;
}

/** Everything about one school day: who teaches what and when, who is absent, what is covered. */
async function schoolDay(db: Db, schoolId: string, date: string) {
  const weekday = isoWeekday(date);
  const holiday = await db.maybeOne<{ title: string }>(
    `select ev.title from calendar_event ev join org_unit o on o.id = ev.unit_id join org_unit sch on sch.id = $1
      where o.path @> sch.path and ev.kind in ('HOLIDAY', 'VACATION') and ev.period @> $2::date limit 1`, [schoolId, date]);
  const plans = await db.query<{ class_codes: string[] | null; kind: string; title: string; cancelled_periods: number[]; alt_slots: { period_no: number; starts: string; ends: string }[] | null }>(
    `select class_codes, kind, title, cancelled_periods, alt_slots from day_plan where school_id = $1 and on_date = $2 and withdrawn_at is null`, [schoolId, date]);
  const raw = weekday === 7 || holiday ? [] : await db.query<Lesson>(
    `select s.id as section_id, s.class_code || '-' || s.name as label, s.class_code, x.period, to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends,
            x.subject_code, sj.name as subject, x.teacher_id, u.name as teacher
       from timetable t join timetable_slot x on x.timetable_id = t.id join section s on s.id = t.section_id join org_unit c on c.id = s.campus_id
       join subject sj on sj.code = x.subject_code left join app_user u on u.id = x.teacher_id join class_level cl on cl.code = s.class_code
      where c.parent_id = $1 and t.valid @> $2::date and x.weekday = $3 order by x.starts, cl.ordinal, s.name`, [schoolId, date, weekday]);
  // Apply special days: cancelled periods disappear (their teachers are free); short days retime.
  const lessons: Lesson[] = [];
  for (const l of raw) {
    const plan = plans.find((p) => p.class_codes === null || p.class_codes.includes(l.class_code));
    if (plan && (plan.kind === 'NO_CLASSES' || plan.cancelled_periods.includes(l.period))) continue;
    const alt = plan?.alt_slots?.find((a) => a.period_no === l.period);
    if (plan?.alt_slots && !alt) continue;
    lessons.push(alt ? { ...l, starts: alt.starts, ends: alt.ends } : l);
  }
  const absences = await db.query<Absence>(
    `select a.id, a.teacher_id, u.name as teacher, a.periods, a.reason, lower(a.period)::text as from, (upper(a.period) - 1)::text as to
       from teacher_absence a join app_user u on u.id = a.teacher_id
      where a.school_id = $1 and a.withdrawn_at is null and a.period @> $2::date order by u.name`, [schoolId, date]);
  const subs = await db.query<Sub>(
    `select x.section_id, x.period_no, x.kind, x.substitute_id, u.name as substitute, x.merged_with, ms.class_code || '-' || ms.name as merged_label,
            to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends, x.auto
       from substitution x join section s on s.id = x.section_id join org_unit c on c.id = s.campus_id
       left join app_user u on u.id = x.substitute_id left join section ms on ms.id = x.merged_with
      where c.parent_id = $1 and x.on_date = $2`, [schoolId, date]);
  const teachers = await db.query<{ id: string; name: string; designation: string | null }>(
    `select u.id, u.name, u.designation from app_user u join org_unit o on o.id = $1
      where u.active and u.role = 'TEACHER' and u.scope_path <@ o.path order by u.name`, [schoolId]);
  const monday = new Date(Date.parse(`${date}T00:00:00Z`) - (weekday - 1) * 864e5).toISOString().slice(0, 10);
  const weekCounts = await db.query<{ substitute_id: string; n: number }>(
    `select x.substitute_id, count(*)::int as n from substitution x join section s on s.id = x.section_id join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and x.on_date between $2::date and ($2::date + 6) and x.substitute_id is not null group by 1`, [schoolId, monday]);
  const classTeachers = await db.query<{ section_id: string; label: string; kind: 'CLASS' | 'CO'; user_id: string; name: string }>(
    `select x.section_id, s.class_code || '-' || s.name as label, x.kind, x.user_id, u.name from class_teacher x join section s on s.id = x.section_id
       join org_unit c on c.id = s.campus_id join app_user u on u.id = x.user_id where c.parent_id = $1 and x.valid @> $2::date`, [schoolId, date]);
  return { weekday, holiday: holiday?.title ?? null, plans, lessons, absences, subs, teachers, classTeachers, weekCounts: new Map(weekCounts.map((w) => [w.substitute_id, w.n])) };
}

const absentAt = (abs: Absence[], teacherId: string, period: number) => abs.some((a) => a.teacher_id === teacherId && (a.periods === null || a.periods.includes(period)));
const overlaps = (a: { starts: string; ends: string }, b: { starts: string; ends: string }) => toMin(a.starts) < toMin(b.ends) && toMin(b.starts) < toMin(a.ends);

export interface Need extends Lesson { cover: Sub | null }

function needsOf(day: Awaited<ReturnType<typeof schoolDay>>): Need[] {
  return day.lessons
    .filter((l) => l.teacher_id && absentAt(day.absences, l.teacher_id, l.period))
    .map((l) => ({ ...l, cover: day.subs.find((s) => s.section_id === l.section_id && s.period_no === l.period) ?? null }));
}

interface Candidate { id: string; name: string; score: number; reasons: string[]; periodsToday: number; proxiesToday: number; proxiesWeek: number; withinLimits: boolean }

/** Free teachers for one need, best first, with the reasons shown to the coordinator. */
function rank(day: Awaited<ReturnType<typeof schoolDay>>, need: Lesson, limits: Settings, extra: Map<string, { day: number; week: number; busy: { starts: string; ends: string }[] }> = new Map()): Candidate[] {
  const out: Candidate[] = [];
  for (const t of day.teachers) {
    if (t.id === need.teacher_id || absentAt(day.absences, t.id, need.period)) continue;
    const own = day.lessons.filter((l) => l.teacher_id === t.id);
    const covering = day.subs.filter((s) => s.substitute_id === t.id && !(s.section_id === need.section_id && s.period_no === need.period));
    const ex = extra.get(t.id);
    const busy = [...own, ...covering, ...(ex?.busy ?? [])];
    if (busy.some((b) => overlaps(b, need))) continue;
    const proxiesToday = covering.length + (ex?.day ?? 0);
    const proxiesWeek = (day.weekCounts.get(t.id) ?? 0) + (ex?.week ?? 0);
    const periodsToday = own.length + proxiesToday;
    const sameSubjectClass = own.some((l) => l.section_id === need.section_id && l.subject_code === need.subject_code) ||
      day.lessons.some((l) => l.teacher_id === t.id && l.section_id === need.section_id && l.subject_code === need.subject_code);
    const teachesClass = day.lessons.some((l) => l.teacher_id === t.id && l.section_id === need.section_id);
    const teachesSubject = day.lessons.some((l) => l.teacher_id === t.id && l.subject_code === need.subject_code);
    const reasons: string[] = [];
    let score = 0;
    if (sameSubjectClass) { score += 60; reasons.push(`Teaches ${need.subject} to ${need.label}`); }
    else if (teachesSubject) { score += 30; reasons.push(`Teaches ${need.subject}`); }
    if (teachesClass && !sameSubjectClass) { score += 25; reasons.push(`Knows ${need.label}`); }
    if (day.classTeachers.some((c) => c.section_id === need.section_id && c.user_id === t.id)) { score += 40; reasons.push(`${day.classTeachers.find((c) => c.section_id === need.section_id && c.user_id === t.id)!.kind === 'CO' ? 'Co-class' : 'Class'} teacher of ${need.label}`); }
    score -= proxiesWeek * 8 + proxiesToday * 10 + periodsToday * 3;
    reasons.push(`${periodsToday} period${periodsToday === 1 ? '' : 's'} today`, `${proxiesWeek} cover this week`);
    const withinLimits = proxiesToday < limits.max_proxy_day && proxiesWeek < limits.max_proxy_week && periodsToday < limits.max_periods_day;
    out.push({ id: t.id, name: t.name, score: withinLimits ? score : score - 1000, reasons, periodsToday, proxiesToday, proxiesWeek, withinLimits });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** The cover board for a day: absences, every lesson that needs cover, and suggestions. */
export async function board(db: Db, actor: Actor, schoolId: string, date: string) {
  await assertTimetableManager(db, actor, schoolId);
  const day = await schoolDay(db, schoolId, date);
  const limits = await settings(db, schoolId);
  const needs = needsOf(day).map((n) => ({ ...n, suggestions: n.cover ? [] : rank(day, n, limits).slice(0, 6) }));
  const plans = day.plans.map((p) => ({ title: p.title, kind: p.kind, classes: p.class_codes }));
  // An absent class teacher's class-teacher work (roll, leave approvals) passes to the co-class teacher.
  const classTeacherCover = day.absences.filter((a) => a.periods === null).flatMap((a) => day.classTeachers.filter((c) => c.kind === 'CLASS' && c.user_id === a.teacher_id).map((c) => {
    const co = day.classTeachers.find((x) => x.section_id === c.section_id && x.kind === 'CO');
    return { sectionId: c.section_id, label: c.label, classTeacher: c.name, acting: co && !absentAt(day.absences, co.user_id, 1) ? co.name : null };
  }));
  return { date, weekday: DAYS[day.weekday], holiday: day.holiday, plans, absences: day.absences, needs, limits, classTeacherCover,
    covered: needs.filter((n) => n.cover).length, uncovered: needs.filter((n) => !n.cover).length };
}

export async function candidates(db: Db, actor: Actor, schoolId: string, date: string, sectionId: string, period: number) {
  await assertTimetableManager(db, actor, schoolId);
  const day = await schoolDay(db, schoolId, date);
  const need = day.lessons.find((l) => l.section_id === sectionId && l.period === period);
  if (!need) throw notFound('Lesson');
  return rank(day, need, await settings(db, schoolId));
}

export async function markAbsent(db: Db, actor: Actor, input: { schoolId: string; teacherId: string; from: string; to: string; periods?: number[] | null; reason: string }) {
  await assertTimetableManager(db, actor, input.schoolId);
  if (input.to < input.from) throw invalid('The last day is before the first day.');
  const t = await db.maybeOne(`select 1 from app_user u join org_unit o on o.id = $2 where u.id = $1 and u.role = 'TEACHER' and u.scope_path <@ o.path`, [input.teacherId, input.schoolId]);
  if (!t) throw invalid('This teacher is not at this school.');
  return db.tx(async (tx) => {
    const r = await tx.one<{ id: string }>(
      `insert into teacher_absence (school_id, teacher_id, period, periods, reason, recorded_by) values ($1, $2, daterange($3::date, ($4::date + 1)), $5, $6, $7) returning id`,
      [input.schoolId, input.teacherId, input.from, input.to, input.periods?.length ? input.periods : null, input.reason.trim(), actor.id]);
    // Cover this teacher had been given on those days is released, so it shows as a need again.
    const released = await tx.query(
      `delete from substitution where substitute_id = $1 and on_date between $2::date and $3::date
         and ($4::smallint[] is null or period_no = any($4)) returning on_date`, [input.teacherId, input.from, input.to, input.periods?.length ? input.periods : null]);
    // A class teacher away for whole days: the co-class teacher takes the roll and approvals meanwhile.
    const acting = input.periods?.length ? [] : await tx.query<{ co: string; label: string }>(
      `select co.user_id as co, s.class_code || '-' || s.name as label from class_teacher ct join class_teacher co on co.section_id = ct.section_id and co.kind = 'CO' and co.valid @> $2::date
         join section s on s.id = ct.section_id where ct.user_id = $1 and ct.kind = 'CLASS' and ct.valid @> $2::date`, [input.teacherId, input.from]);
    for (const a of acting) {
      await notify.toUsers(tx, [a.co], { kind: 'PROXY', title: `You are acting class teacher of ${a.label}`, body: `${notify.fmtRange(input.from, input.to)}: take the roll and handle leave requests while the class teacher is away.`, link: '/attendance' });
    }
    return { id: r.id, coverReleased: released.length, actingClassTeacher: acting.map((a) => a.label) };
  }, { actor: actor.label });
}

export async function withdrawAbsence(db: Db, actor: Actor, id: string) {
  const a = await db.maybeOne<{ school_id: string; teacher_id: string; from: string; to: string }>(
    `select school_id, teacher_id, lower(period)::text as from, (upper(period) - 1)::text as to from teacher_absence where id = $1`, [id]);
  if (!a) throw notFound('Absence');
  await assertTimetableManager(db, actor, a.school_id);
  return db.tx(async (t) => {
    await t.query('update teacher_absence set withdrawn_at = now() where id = $1', [id]);
    // Cover arranged for this teacher's lessons is no longer needed.
    const removed = await t.query(`delete from substitution where absent_teacher_id = $1 and on_date between $2::date and $3::date and on_date >= current_date returning 1`, [a.teacher_id, a.from, a.to]);
    return { coverRemoved: removed.length };
  }, { actor: actor.label });
}

export interface AssignInput { schoolId: string; date: string; sectionId: string; period: number; kind: 'PROXY' | 'MERGE' | 'STUDY'; substituteId?: string; mergedWith?: string; note?: string }

async function writeCover(t: Db, actor: Actor, need: Lesson, input: AssignInput, auto: boolean) {
  await t.query(
    `insert into substitution (on_date, section_id, period_no, starts, ends, subject_code, absent_teacher_id, kind, substitute_id, merged_with, auto, assigned_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (on_date, section_id, period_no) do update set kind = excluded.kind, substitute_id = excluded.substitute_id, merged_with = excluded.merged_with,
       auto = excluded.auto, assigned_by = excluded.assigned_by, assigned_at = now(), starts = excluded.starts, ends = excluded.ends`,
    [input.date, need.section_id, need.period, need.starts, need.ends, need.subject_code, need.teacher_id, input.kind,
     input.kind === 'PROXY' ? input.substituteId : null, input.kind === 'MERGE' ? input.mergedWith : null, auto, actor.id]);
  if (input.kind === 'PROXY' && input.substituteId) {
    await notify.toUsers(t, [input.substituteId], { kind: 'PROXY', title: `Cover: ${need.label} ${need.subject}`,
      body: `${notify.fmt(input.date)} · period ${need.period}, ${need.starts}–${need.ends}${need.teacher ? ` · for ${need.teacher}` : ''}`, link: '/' });
  }
}

/** Arranges cover for one lesson: a proxy teacher, merging with another class, or supervised study. */
export async function assign(db: Db, actor: Actor, input: AssignInput) {
  await assertTimetableManager(db, actor, input.schoolId);
  if (input.date < today()) throw invalid('Cover can be arranged for today or later.');
  const day = await schoolDay(db, input.schoolId, input.date);
  const need = day.lessons.find((l) => l.section_id === input.sectionId && l.period === input.period);
  if (!need) throw notFound('Lesson');
  if (input.kind === 'PROXY') {
    if (!input.substituteId) throw invalid('Choose the teacher who will cover.');
    const free = rank(day, need, await settings(db, input.schoolId)).find((c) => c.id === input.substituteId);
    if (!free) throw invalid('That teacher is not free at this time.');
  }
  if (input.kind === 'MERGE') {
    if (!input.mergedWith) throw invalid('Choose the class to merge with.');
    const other = day.lessons.find((l) => l.section_id === input.mergedWith && overlaps(l, need));
    if (!other) throw invalid('The other class has no lesson at this time.');
  }
  await db.tx((t) => writeCover(t, actor, need, input, false), { actor: actor.label });
  return { ok: true };
}

export async function unassign(db: Db, actor: Actor, schoolId: string, date: string, sectionId: string, period: number) {
  await assertTimetableManager(db, actor, schoolId);
  if (date < today()) throw invalid('Past cover cannot be removed; it is part of the register.');
  const s = await sectionInfo(db, sectionId);
  if (s.school_id !== schoolId) throw notFound('Class');
  await db.tx((t) => t.query('delete from substitution where on_date = $1 and section_id = $2 and period_no = $3', [date, sectionId, period]), { actor: actor.label });
  return { ok: true };
}

/**
 * Fills every uncovered lesson of the day with the best free teacher, earliest first, keeping each
 * teacher within the school's limits. Lessons nobody can take are left for the coordinator.
 */
export async function autoAssign(db: Db, actor: Actor, schoolId: string, date: string) {
  await assertTimetableManager(db, actor, schoolId);
  if (date < today()) throw invalid('Cover can be arranged for today or later.');
  const day = await schoolDay(db, schoolId, date);
  const limits = await settings(db, schoolId);
  const open = needsOf(day).filter((n) => !n.cover).sort((a, b) => toMin(a.starts) - toMin(b.starts));
  const extra = new Map<string, { day: number; week: number; busy: { starts: string; ends: string }[] }>();
  const assigned: { section: string; period: number; teacher: string }[] = [];
  const left: { section: string; period: number; subject: string }[] = [];
  await db.tx(async (t) => {
    for (const n of open) {
      const best = rank(day, n, limits, extra).find((c) => c.withinLimits);
      if (!best) { left.push({ section: n.label, period: n.period, subject: n.subject }); continue; }
      await writeCover(t, actor, n, { schoolId, date, sectionId: n.section_id, period: n.period, kind: 'PROXY', substituteId: best.id }, true);
      const e = extra.get(best.id) ?? { day: 0, week: 0, busy: [] };
      e.day++; e.week++; e.busy.push({ starts: n.starts, ends: n.ends });
      extra.set(best.id, e);
      assigned.push({ section: n.label, period: n.period, teacher: best.name });
    }
  }, { actor: actor.label });
  return { assigned, uncovered: left };
}

/** A teacher's own day: their lessons, cover they are taking, and whether they are marked absent. */
export async function teacherDay(db: Db, actor: Actor, date: string) {
  if (!actor.scopePath) return { date, rows: [], absent: false };
  const school = await db.maybeOne<{ id: string }>(`select id from org_unit where kind = 'school' and path @> $1::ltree order by nlevel(path) desc limit 1`, [actor.scopePath]);
  if (!school) return { date, rows: [], absent: false };
  const day = await schoolDay(db, school.id, date);
  const own = day.lessons.filter((l) => l.teacher_id === actor.id).map((l) => {
    const cover = day.subs.find((s) => s.section_id === l.section_id && s.period_no === l.period);
    return { kind: 'LESSON', ...l, coveredBy: cover ? cover.substitute ?? (cover.kind === 'MERGE' ? `merged with ${cover.merged_label}` : 'supervised study') : null };
  });
  const proxies = day.subs.filter((s) => s.substitute_id === actor.id).map((s) => {
    const l = day.lessons.find((x) => x.section_id === s.section_id && x.period === s.period_no);
    return { kind: 'COVER', section_id: s.section_id, label: l?.label ?? '', period: s.period_no, starts: s.starts, ends: s.ends, subject: l?.subject ?? '', teacher: l?.teacher ?? null };
  });
  const absent = day.absences.some((a) => a.teacher_id === actor.id);
  // Class teacher work: their own class, or a class whose class teacher is away today (co-class teacher).
  const roles = day.classTeachers.filter((c) => c.user_id === actor.id).map((c) => {
    const ct = day.classTeachers.find((x) => x.section_id === c.section_id && x.kind === 'CLASS');
    const acting = c.kind === 'CLASS' || (!!ct && day.absences.some((a) => a.teacher_id === ct.user_id && a.periods === null)) || !ct;
    return { sectionId: c.section_id, label: c.label, kind: c.kind, acting, classTeacher: ct?.name ?? null };
  });
  const ctRows: { kind: string; section_id: string; label: string; starts: string; ends: string; subject: string; slot: string }[] = [];
  if (!day.holiday && day.weekday !== 7) {
    for (const r of roles.filter((x) => x.acting)) {
      const sec = await db.one<{ class_code: string }>('select class_code from section where id = $1', [r.sectionId]);
      const bell = await bellFor(db, school.id, sec.class_code, date);
      for (const b of bell?.slots.filter((x) => x.kind === 'CLASS_TEACHER' && x.weekday === day.weekday) ?? []) {
        ctRows.push({ kind: 'CLASS_TEACHER', section_id: r.sectionId, label: r.label, starts: b.starts, ends: b.ends, subject: b.label, slot: b.label });
      }
    }
  }
  return { date, weekday: DAYS[day.weekday], holiday: day.holiday, plans: day.plans.map((p) => ({ title: p.title, kind: p.kind })), absent, classTeacherOf: roles,
    rows: [...ctRows, ...own, ...proxies].sort((a, b) => toMin(a.starts) - toMin(b.starts)) };
}

// ── Special days ──────────────────────────────────────────────────────────────────────────

export interface DayPlanInput {
  schoolId: string; date: string; classCodes: string[] | null; kind: 'EVENT' | 'EXAM' | 'SHORT_DAY' | 'NO_CLASSES'; title: string;
  cancelledPeriods?: number[]; shortDay?: { firstStart: string; minutes: number; periods: number; breakAfter: number; breakMinutes: number }; notifyParents?: boolean;
}

/** Plans a special day: cancel some periods, a short day on different timings, or no classes. */
export async function addDayPlan(db: Db, actor: Actor, input: DayPlanInput) {
  await assertTimetableManager(db, actor, input.schoolId);
  if (input.date < today()) throw invalid('Special days can be planned for today or later.');
  let cancelled = [...new Set(input.cancelledPeriods ?? [])].sort((a, b) => a - b);
  let alt: { period_no: number; starts: string; ends: string }[] | null = null;
  if (input.kind === 'NO_CLASSES') cancelled = Array.from({ length: 12 }, (_, i) => i + 1);
  if ((input.kind === 'EVENT' || input.kind === 'EXAM') && cancelled.length === 0) throw invalid('Choose the periods the event replaces.');
  if (input.kind === 'SHORT_DAY') {
    const sd = input.shortDay;
    if (!sd || sd.minutes < 15 || sd.periods < 1 || sd.periods > 12) throw invalid('Give the first period time, minutes per period and number of periods.');
    alt = [];
    let m = toMin(sd.firstStart);
    for (let p = 1; p <= sd.periods; p++) {
      alt.push({ period_no: p, starts: fromMin(m), ends: fromMin(m + sd.minutes) });
      m += sd.minutes + (p === sd.breakAfter ? sd.breakMinutes : 0);
    }
  }
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into day_plan (school_id, on_date, class_codes, kind, title, cancelled_periods, alt_slots, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [input.schoolId, input.date, input.classCodes?.length ? input.classCodes : null, input.kind, input.title.trim(), cancelled, alt ? JSON.stringify(alt) : null, actor.id]);
    // Cover already arranged for lessons that no longer happen is removed.
    await t.query(
      `delete from substitution x using section s, org_unit c where x.section_id = s.id and c.id = s.campus_id and c.parent_id = $1 and x.on_date = $2
         and ($3::text[] is null or s.class_code = any($3)) and (x.period_no = any($4::smallint[]) or x.period_no > $5)`,
      [input.schoolId, input.date, input.classCodes?.length ? input.classCodes : null, cancelled, alt ? alt.length : 99]);
    let notified = 0;
    if (input.notifyParents) {
      const kids = await t.query<{ student_id: string }>(
        `select e.student_id from enrolment e where e.school_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) and ($2::text[] is null or e.class_code = any($2))`,
        [input.schoolId, input.classCodes?.length ? input.classCodes : null]);
      const what = input.kind === 'NO_CLASSES' ? 'No regular classes' : input.kind === 'SHORT_DAY' ? `Short day: classes end at ${alt![alt!.length - 1].ends}` : `Periods ${cancelled.join(', ')} replaced`;
      notified = await notify.toParentsOf(t, kids.map((k) => k.student_id), { kind: 'EVENT', title: input.title.trim(), body: `${notify.fmt(input.date)} · ${what}`, link: '/timetable' });
    }
    return { id: r.id, notified };
  }, { actor: actor.label });
}

export async function dayPlans(db: Db, actor: Actor, schoolId: string, from: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select d.id, d.on_date::text, d.class_codes, d.kind, d.title, d.cancelled_periods, d.alt_slots, u.name as created_by, d.withdrawn_at
       from day_plan d join app_user u on u.id = d.created_by where d.school_id = $1 and d.on_date >= $2::date order by d.on_date`, [schoolId, from]);
}

export async function withdrawDayPlan(db: Db, actor: Actor, id: string) {
  const d = await db.maybeOne<{ school_id: string }>('select school_id from day_plan where id = $1', [id]);
  if (!d) throw notFound('Special day');
  await assertTimetableManager(db, actor, d.school_id);
  await db.tx((t) => t.query('update day_plan set withdrawn_at = now() where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

/** The proxy register: cover taken and lessons missed, per teacher, for a month. */
export async function register(db: Db, actor: Actor, schoolId: string, month: string) {
  await assertTimetableManager(db, actor, schoolId);
  return db.query(
    `with t as (select u.id, u.name from app_user u join org_unit o on o.id = $1 where u.role = 'TEACHER' and u.active and u.scope_path <@ o.path),
          taken as (select x.substitute_id as id, count(*)::int as n from substitution x where x.on_date >= $2::date and x.on_date < ($2::date + interval '1 month') and x.substitute_id is not null group by 1),
          missed as (select x.absent_teacher_id as id, count(*)::int as n from substitution x where x.on_date >= $2::date and x.on_date < ($2::date + interval '1 month') group by 1),
          days as (select a.teacher_id as id, count(*)::int as n from teacher_absence a cross join generate_series($2::date, ($2::date + interval '1 month' - interval '1 day')::date, '1 day') d
                    where a.withdrawn_at is null and a.period @> d::date and extract(isodow from d) < 7 group by 1)
     select t.id, t.name, coalesce(taken.n, 0) as cover_taken, coalesce(missed.n, 0) as lessons_covered_for_them, coalesce(days.n, 0) as days_absent
       from t left join taken using (id) left join missed using (id) left join days using (id)
      order by cover_taken desc, t.name`, [schoolId, `${month}-01`]);
}
