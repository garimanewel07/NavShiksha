import type { Db } from '../db/client.js';
import { invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertStudentAccess } from './access.js';
import { currentEnrolment, sectionInfo } from './sections.js';
import * as duties from './duties.js';
import { localToday } from '../lib/dates.js';

/**
 * Timetables. A school's timings live in bell schedules (periods, assembly, breaks, lunch) per
 * class group and weekday, versioned by date. A class timetable says which subject and teacher
 * take each period; its times always come from the bell schedule in force, so changing the
 * timings republishes every affected class timetable automatically.
 */

export const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const isoWeekday = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const today = () => localToday();

export interface BellSlot { weekday: number; seq: number; kind: string; label: string; period_no: number | null; starts: string; ends: string }
export interface Bell { id: string; name: string; class_codes: string[]; from: string; to: string | null; slots: BellSlot[] }
export interface LessonInput { weekday: number; period: number; subjectCode: string; teacherId?: string | null; room?: string | null }

/** Who may manage timetables, timings, special days and cover. Duties (timetable coordinator) plug in here. */
export async function assertTimetableManager(db: Db, actor: Actor, schoolId: string) {
  await duties.assertLeaderOrDuty(db, actor, schoolId, 'TIMETABLE_COORDINATOR');
}

async function bellSlots(db: Db, scheduleId: string) {
  return db.query<BellSlot>(
    `select weekday, seq, kind, label, period_no, to_char(starts, 'HH24:MI') as starts, to_char(ends, 'HH24:MI') as ends
       from bell_slot where schedule_id = $1 order by weekday, starts`, [scheduleId]);
}

/** The bell schedule a class follows on a date. */
export async function bellFor(db: Db, schoolId: string, classCode: string, on: string): Promise<Bell | null> {
  const b = await db.maybeOne<{ id: string; name: string; class_codes: string[]; from: string; to: string | null }>(
    `select id, name, class_codes, lower(valid)::text as from, upper(valid)::text as to from bell_schedule
      where school_id = $1 and $2 = any(class_codes) and valid @> $3::date`, [schoolId, classCode, on]);
  return b ? { ...b, slots: await bellSlots(db, b.id) } : null;
}

/** Every bell schedule in force on a date or starting later. */
export async function bells(db: Db, actor: Actor, schoolId: string, on = today()) {
  await assertUnitInScope(db, actor, schoolId);
  const rows = await db.query<{ id: string; name: string; class_codes: string[]; from: string; to: string | null }>(
    `select id, name, class_codes, lower(valid)::text as from, upper(valid)::text as to from bell_schedule
      where school_id = $1 and (upper(valid) is null or upper(valid) > $2::date) order by lower(valid), name`, [schoolId, on]);
  return Promise.all(rows.map(async (b) => ({ ...b, slots: await bellSlots(db, b.id) })));
}

export interface BellInput { name: string; classCodes: string[]; from: string; slots: { weekday: number; kind: string; label: string; periodNo?: number | null; starts: string; ends: string }[] }

/**
 * Publishes school timings for some classes from a date. Older timings for those classes end the
 * day before (classes not in this schedule keep theirs), and every affected class timetable is
 * republished on the new times in the same transaction.
 */
export async function publishBell(db: Db, actor: Actor, schoolId: string, input: BellInput) {
  await assertTimetableManager(db, actor, schoolId);
  if (input.from < today()) throw invalid('New timings can start today or later, not in the past.');
  const classes = [...new Set(input.classCodes)];
  if (!classes.length) throw invalid('Choose at least one class.');
  const byDay = new Map<number, BellInput['slots']>();
  for (const s of input.slots) {
    if (toMin(s.ends) <= toMin(s.starts)) throw invalid(`${DAYS[s.weekday]}: “${s.label}” ends before it starts.`);
    if ((s.kind === 'PERIOD') !== (s.periodNo != null)) throw invalid(`${DAYS[s.weekday]}: every period needs a number, and only periods have one.`);
    byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s]);
  }
  for (const [d, list] of byDay) {
    const sorted = [...list].sort((a, b) => toMin(a.starts) - toMin(b.starts));
    for (let i = 1; i < sorted.length; i++) {
      if (toMin(sorted[i].starts) < toMin(sorted[i - 1].ends)) throw invalid(`${DAYS[d]}: “${sorted[i].label}” overlaps “${sorted[i - 1].label}”.`);
    }
    const nums = sorted.filter((s) => s.periodNo != null).map((s) => s.periodNo);
    if (new Set(nums).size !== nums.length) throw invalid(`${DAYS[d]}: a period number is used twice.`);
  }
  return db.tx(async (t) => {
    const existing = await t.query<{ id: string; name: string; class_codes: string[]; lo: string; hi: string | null }>(
      `select id, name, class_codes, lower(valid)::text as lo, upper(valid)::text as hi from bell_schedule
        where school_id = $1 and class_codes && $2::text[] and (upper(valid) is null or upper(valid) > $3::date)`, [schoolId, classes, input.from]);
    for (const e of existing) {
      const remaining = e.class_codes.filter((c) => !classes.includes(c));
      const slots = await bellSlots(t, e.id);
      let contFrom: string;
      let contTo: string | null = e.hi;
      if (e.lo < input.from) {
        await t.query('update bell_schedule set valid = daterange(lower(valid), $2::date) where id = $1', [e.id, input.from]);
        contFrom = input.from;
      } else {
        if (e.lo <= today()) throw invalid(`“${e.name}” already starts on ${e.lo}. Choose a later date for the new timings.`);
        await t.query('delete from bell_slot where schedule_id = $1', [e.id]);
        await t.query('delete from bell_schedule where id = $1', [e.id]);
        contFrom = e.lo;
      }
      if (remaining.length) {
        // Classes that are not being changed carry on with their existing timings.
        const c = await t.one<{ id: string }>(
          `insert into bell_schedule (school_id, name, class_codes, valid, created_by) values ($1, $2, $3, daterange($4::date, $5::date), $6) returning id`,
          [schoolId, e.name, remaining, contFrom, contTo, actor.id]);
        for (const s of slots) await t.query(`insert into bell_slot (schedule_id, weekday, seq, kind, label, period_no, starts, ends) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.id, s.weekday, s.seq, s.kind, s.label, s.period_no, s.starts, s.ends]);
      }
    }
    const b = await t.one<{ id: string }>(
      `insert into bell_schedule (school_id, name, class_codes, valid, created_by) values ($1, $2, $3, daterange($4::date, null), $5) returning id`,
      [schoolId, input.name.trim(), classes, input.from, actor.id]);
    for (const [d, list] of byDay) {
      const sorted = [...list].sort((a, z) => toMin(a.starts) - toMin(z.starts));
      for (const [i, s] of sorted.entries()) {
        await t.query(`insert into bell_slot (schedule_id, weekday, seq, kind, label, period_no, starts, ends) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [b.id, d, i + 1, s.kind, s.label.trim(), s.periodNo ?? null, s.starts, s.ends]);
      }
    }
    try {
      const result = await republishOnNewTimings(t, actor.id, schoolId, classes, input.from);
      return { id: b.id, ...result };
    } catch (e) {
      const m = (e as Error).message.match(/already has class (\S+) at that time/);
      if (m) throw invalid(`With these timings a teacher would be in two classes at once (one of them ${m[1]}). Adjust the timings, or change the timetable first.`);
      throw e;
    }
  }, { actor: actor.label });
}

/** Moves every class timetable of these classes onto the timings in force from a date. */
async function republishOnNewTimings(t: Db, actorId: string, schoolId: string, classes: string[], from: string) {
  const sections = await t.query<{ id: string; class_code: string; label: string }>(
    `select s.id, s.class_code, s.class_code || '-' || s.name as label from section s join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and s.class_code = any($2::text[])
        and exists (select 1 from timetable tt where tt.section_id = s.id and tt.valid @> $3::date)`, [schoolId, classes, from]);
  const entries: TimedEntry[] = [];
  const dropped: string[] = [];
  for (const s of sections) {
    const tt = await t.one<{ id: string }>('select id from timetable where section_id = $1 and valid @> $2::date', [s.id, from]);
    const lessons = await t.query<{ weekday: number; period: number; subject_code: string; teacher_id: string | null; room: string | null }>(
      'select weekday, period, subject_code, teacher_id, room from timetable_slot where timetable_id = $1', [tt.id]);
    const bell = await bellFor(t, schoolId, s.class_code, from);
    if (!bell) continue;
    const timed = [];
    for (const l of lessons) {
      const slot = bell.slots.find((b) => b.weekday === l.weekday && b.period_no === l.period);
      if (!slot) { dropped.push(`${s.label} ${DAYS[l.weekday]} P${l.period}`); continue; }
      timed.push({ weekday: l.weekday, period: l.period, starts: slot.starts, ends: slot.ends, subjectCode: l.subject_code, teacherId: l.teacher_id, room: l.room });
    }
    entries.push({ sectionId: s.id, from, slots: timed });
  }
  await writeTimetables(t, actorId, entries);
  return { timetablesUpdated: entries.length, droppedPeriods: dropped };
}

export interface TimedEntry { sectionId: string; from: string; slots: { weekday: number; period: number; starts: string; ends: string; subjectCode: string; teacherId?: string | null; room?: string | null }[] }

/**
 * Writes several class timetables from a date in one go. All old versions are closed first, so
 * the teacher-clash check compares the new timetables with each other and with untouched classes.
 */
export async function writeTimetables(t: Db, actorId: string, entries: TimedEntry[]) {
  const ids: string[] = [];
  for (const e of entries) {
    const later = await t.maybeOne('select 1 from timetable where section_id = $1 and lower(valid) > $2::date limit 1', [e.sectionId, e.from]);
    if (later) {
      const s = await sectionInfo(t, e.sectionId);
      throw invalid(`${s.label} already has a timetable starting after ${e.from}.`);
    }
    const existing = await t.maybeOne<{ id: string; from: string }>(
      `select id, lower(valid)::text as from from timetable where section_id = $1 and valid @> $2::date`, [e.sectionId, e.from]);
    if (existing && existing.from === e.from) {
      await t.query('delete from timetable_slot where timetable_id = $1', [existing.id]);
      ids.push(existing.id);
    } else {
      if (existing) await t.query(`update timetable set valid = daterange(lower(valid), $2::date) where id = $1`, [existing.id, e.from]);
      ids.push('');
    }
  }
  for (const [i, e] of entries.entries()) {
    const id = ids[i] || (await t.one<{ id: string }>(`insert into timetable (section_id, valid, created_by) values ($1, daterange($2::date, null), $3) returning id`, [e.sectionId, e.from, actorId])).id;
    for (const x of e.slots) {
      await t.query(`insert into timetable_slot (timetable_id, weekday, period, starts, ends, subject_code, teacher_id, room) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, x.weekday, x.period, x.starts, x.ends, x.subjectCode, x.teacherId ?? null, x.room ?? null]);
    }
  }
  return ids;
}

/** Times a class's lessons from the bell schedule in force; refuses periods the timings do not have. */
export async function timeLessons(db: Db, schoolId: string, classCode: string, from: string, lessons: LessonInput[]) {
  const bell = await bellFor(db, schoolId, classCode, from);
  if (!bell) throw invalid(`Class ${classCode} has no school timings on ${from}. Set the timings first.`);
  const seen = new Set<string>();
  return lessons.map((l) => {
    const k = `${l.weekday}:${l.period}`;
    if (seen.has(k)) throw invalid(`${DAYS[l.weekday]}, period ${l.period} appears twice.`);
    seen.add(k);
    const slot = bell.slots.find((b) => b.weekday === l.weekday && b.period_no === l.period);
    if (!slot) throw invalid(`There is no period ${l.period} on ${DAYS[l.weekday]} in “${bell.name}”.`);
    return { ...l, starts: slot.starts, ends: slot.ends };
  });
}

/** Publishes one class's timetable from a date, on the school timings. */
export async function publish(db: Db, actor: Actor, sectionId: string, from: string, lessons: LessonInput[]) {
  const s = await sectionInfo(db, sectionId);
  await assertTimetableManager(db, actor, s.school_id);
  const timed = await timeLessons(db, s.school_id, s.class_code, from, lessons);
  return db.tx(async (t) => {
    const [id] = await writeTimetables(t, actor.id, [{ sectionId, from, slots: timed }]);
    return { id, slots: timed.length };
  }, { actor: actor.label });
}

// ── Reading timetables ────────────────────────────────────────────────────────────────────

const SLOTS = `select x.weekday, x.period, to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends,
                      x.subject_code, sj.name as subject, x.teacher_id, u.name as teacher, x.room
                 from timetable_slot x join subject sj on sj.code = x.subject_code left join app_user u on u.id = x.teacher_id`;

async function week(db: Db, sectionId: string, on: string) {
  const s = await sectionInfo(db, sectionId);
  const t = await db.maybeOne<{ id: string; from: string }>(
    `select id, lower(valid)::text as from from timetable where section_id = $1 and valid @> $2::date`, [sectionId, on]);
  const bell = await bellFor(db, s.school_id, s.class_code, on);
  return {
    section: s.label, sectionId, from: t?.from ?? null,
    bell: bell ? { name: bell.name, slots: bell.slots } : null,
    slots: t ? await db.query(`${SLOTS} where x.timetable_id = $1 order by x.weekday, x.period`, [t.id]) : [],
  };
}

export async function forSection(db: Db, actor: Actor, sectionId: string, on: string) {
  const s = await sectionInfo(db, sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  const ct = await db.one<{ class_teacher: string | null; co_class_teacher: string | null }>(
    `select (select name from app_user where id = class_teacher_of($1, $2::date)) as class_teacher, (select name from app_user where id = class_teacher_of($1, $2::date, 'CO')) as co_class_teacher`, [sectionId, on]);
  return { ...(await week(db, sectionId, on)), classTeacherId: s.class_teacher_id, ...ct };
}

export async function forStudent(db: Db, actor: Actor, studentId: string, on: string) {
  await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  if (!e.section_id) return { section: null, from: null, bell: null, slots: [] };
  return week(db, e.section_id, on);
}

/** A teacher's own week across every section they teach. */
export async function forTeacher(db: Db, actor: Actor, on: string) {
  return db.query(
    `select x.weekday, x.period, to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends,
            x.subject_code, sj.name as subject, x.room, s.class_code || '-' || s.name as section, s.id as section_id
       from timetable_slot x join subject sj on sj.code = x.subject_code
       join timetable t on t.id = x.timetable_id join section s on s.id = t.section_id
      where x.teacher_id = $1 and t.valid @> $2::date order by x.weekday, x.starts`, [actor.id, on]);
}

export interface DayRow { kind: string; label: string; starts: string; ends: string; period: number | null; subject: string | null; subject_code: string | null;
  teacher: string | null; teacher_id: string | null; cancelled: string | null; cover: { kind: string; teacher: string | null; merged_with: string | null } | null }

/**
 * One class's actual day: the bell (with breaks), its lessons, any special day (cancelled periods
 * or short-day timings), holidays from the calendar, and cover for absent teachers.
 */
export async function dayView(db: Db, sectionId: string, date: string) {
  const s = await sectionInfo(db, sectionId);
  const weekday = isoWeekday(date);
  const holiday = await db.maybeOne<{ title: string }>(
    `select ev.title from calendar_event ev join org_unit o on o.id = ev.unit_id join org_unit sch on sch.id = $1
      where o.path @> sch.path and ev.kind in ('HOLIDAY', 'VACATION') and ev.period @> $2::date limit 1`, [s.school_id, date]);
  const base = { date, weekday, section: s.label };
  if (weekday === 7) return { ...base, closed: 'Sunday', plan: null, rows: [] as DayRow[] };
  if (holiday) return { ...base, closed: holiday.title, plan: null, rows: [] as DayRow[] };
  const plan = await db.maybeOne<{ title: string; kind: string; cancelled_periods: number[]; alt_slots: { period_no: number; starts: string; ends: string }[] | null }>(
    `select title, kind, cancelled_periods, alt_slots from day_plan
      where school_id = $1 and on_date = $2 and withdrawn_at is null and (class_codes is null or $3 = any(class_codes)) limit 1`, [s.school_id, date, s.class_code]);
  const tt = await db.maybeOne<{ id: string }>('select id from timetable where section_id = $1 and valid @> $2::date', [sectionId, date]);
  const lessons = tt ? await db.query<{ period: number; subject: string; subject_code: string; teacher: string | null; teacher_id: string | null; starts: string; ends: string }>(
    `select x.period, sj.name as subject, x.subject_code, u.name as teacher, x.teacher_id, to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends
       from timetable_slot x join subject sj on sj.code = x.subject_code left join app_user u on u.id = x.teacher_id
      where x.timetable_id = $1 and x.weekday = $2`, [tt.id, weekday]) : [];
  const subs = await db.query<{ period_no: number; kind: string; teacher: string | null; merged_with: string | null }>(
    `select x.period_no, x.kind, u.name as teacher, ms.class_code || '-' || ms.name as merged_with from substitution x
       left join app_user u on u.id = x.substitute_id left join section ms on ms.id = x.merged_with
      where x.on_date = $1 and x.section_id = $2`, [date, sectionId]);
  const bell = await bellFor(db, s.school_id, s.class_code, date);
  const frame: { kind: string; label: string; period: number | null; starts: string; ends: string }[] = plan?.alt_slots
    ? plan.alt_slots.map((a) => ({ kind: 'PERIOD', label: `Period ${a.period_no}`, period: a.period_no, starts: a.starts, ends: a.ends }))
    : bell ? bell.slots.filter((b) => b.weekday === weekday).map((b) => ({ kind: b.kind, label: b.label, period: b.period_no, starts: b.starts, ends: b.ends }))
    : lessons.map((l) => ({ kind: 'PERIOD', label: `Period ${l.period}`, period: l.period, starts: l.starts, ends: l.ends }));
  const cancelledAll = plan?.kind === 'NO_CLASSES';
  const rows: DayRow[] = frame.sort((a, b) => toMin(a.starts) - toMin(b.starts)).map((f) => {
    const l = f.period != null ? lessons.find((x) => x.period === f.period) : undefined;
    const cancelled = f.kind === 'PERIOD' && plan && (cancelledAll || plan.cancelled_periods.includes(f.period!)) ? plan.title : null;
    const sub = f.period != null ? subs.find((x) => x.period_no === f.period) : undefined;
    return { kind: f.kind, label: f.label, starts: f.starts, ends: f.ends, period: f.period, subject: l?.subject ?? null, subject_code: l?.subject_code ?? null,
      teacher: l?.teacher ?? null, teacher_id: l?.teacher_id ?? null, cancelled, cover: sub && !cancelled ? { kind: sub.kind, teacher: sub.teacher, merged_with: sub.merged_with } : null };
  });
  return { ...base, closed: null, plan: plan ? { title: plan.title, kind: plan.kind } : null, rows };
}

export async function dayForStudent(db: Db, actor: Actor, studentId: string, date: string) {
  await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  if (!e.section_id) throw notFound('Class');
  return dayView(db, e.section_id, date);
}

export async function dayForSection(db: Db, actor: Actor, sectionId: string, date: string) {
  const s = await sectionInfo(db, sectionId);
  await assertUnitInScope(db, actor, s.school_id);
  return dayView(db, sectionId, date);
}

export async function teachers(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select u.id, u.name, u.designation from app_user u join org_unit o on o.id = $1
      where u.active and u.role = 'TEACHER' and u.scope_path <@ o.path order by u.name`, [schoolId]);
}
