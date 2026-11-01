import type { Db } from '../db/client.js';
import { invalid } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { sectionInfo } from './sections.js';
import { assertTimetableManager, bellFor, toMin, writeTimetables, timeLessons, DAYS } from './timetable.js';
import { settings } from './cover.js';
import * as settingsMod from './settings.js';
import { refreshDesignation } from './staff.js';

/**
 * Teaching load and the timetable generator. The school says how many periods a week each class
 * has in each subject and who teaches it; the generator places every lesson so that no teacher is
 * in two rooms at once, no subject crowds one day, and no teacher is overloaded on any day.
 * The result is a proposal: the coordinator reviews it and publishes it from a date.
 */

export interface LoadRow { subjectCode: string; teacherId: string | null; periodsPerWeek: number; maxPerDay: number }

export async function loads(db: Db, actor: Actor, schoolId: string, year: string) {
  await assertTimetableManager(db, actor, schoolId);
  const sections = await db.query<{ id: string; class_code: string; label: string }>(
    `select s.id, s.class_code, s.class_code || '-' || s.name as label from section s join org_unit c on c.id = s.campus_id join class_level cl on cl.code = s.class_code
      where c.parent_id = $1 and s.academic_year = $2 order by cl.ordinal, s.name`, [schoolId, year]);
  const rows = await db.query<{ section_id: string; subject_code: string; subject: string; teacher_id: string | null; teacher: string | null; periods_per_week: number; max_per_day: number }>(
    `select l.section_id, l.subject_code, sj.name as subject, l.teacher_id, u.name as teacher, l.periods_per_week, l.max_per_day
       from teaching_load l join subject sj on sj.code = l.subject_code left join app_user u on u.id = l.teacher_id
       join section s on s.id = l.section_id join org_unit c on c.id = s.campus_id where c.parent_id = $1 order by sj.name`, [schoolId]);
  return sections.map((s) => ({ ...s, load: rows.filter((r) => r.section_id === s.id), total: rows.filter((r) => r.section_id === s.id).reduce((n, r) => n + r.periods_per_week, 0) }));
}

export async function saveLoad(db: Db, actor: Actor, sectionId: string, rows: LoadRow[]) {
  const s = await sectionInfo(db, sectionId);
  await assertTimetableManager(db, actor, s.school_id);
  const subjects = rows.map((r) => r.subjectCode);
  if (new Set(subjects).size !== subjects.length) throw invalid('A subject appears twice.');
  await db.tx(async (t) => {
    const before = await t.query<{ teacher_id: string }>('select distinct teacher_id from teaching_load where section_id = $1 and teacher_id is not null', [sectionId]);
    await t.query('delete from teaching_load where section_id = $1', [sectionId]);
    for (const r of rows) await t.query(`insert into teaching_load (section_id, subject_code, teacher_id, periods_per_week, max_per_day) values ($1, $2, $3, $4, $5)`,
      [sectionId, r.subjectCode, r.teacherId, r.periodsPerWeek, r.maxPerDay]);
    // Each teacher's designation follows the subject they teach most.
    for (const id of new Set([...before.map((b) => b.teacher_id), ...rows.map((r) => r.teacherId).filter(Boolean) as string[]])) await refreshDesignation(t, id);
  }, { actor: actor.label });
  return { saved: rows.length };
}

/** A starting load worked out from the class's current timetable. */
export async function loadFromTimetable(db: Db, actor: Actor, sectionId: string, on: string) {
  const s = await sectionInfo(db, sectionId);
  await assertTimetableManager(db, actor, s.school_id);
  return db.query(
    `select x.subject_code as "subjectCode", mode() within group (order by x.teacher_id) as "teacherId", count(*)::int as "periodsPerWeek", 2 as "maxPerDay"
       from timetable t join timetable_slot x on x.timetable_id = t.id where t.section_id = $1 and t.valid @> $2::date group by x.subject_code order by 1`, [sectionId, on]);
}

// ── The solver ────────────────────────────────────────────────────────────────────────────

function rng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Cell { weekday: number; period: number; starts: string; ends: string }
interface Unit { section: string; subject: string; teacher: string | null; maxPerDay: number; pin?: { weekday: number; period: number } }
interface Placed { weekday: number; period: number; subjectCode: string; teacherId: string | null }

/**
 * Places lessons greedily, hardest first (busiest teachers, fullest classes), choosing for each
 * the free period that spreads the subject across the week and evens out the teacher's days.
 * Many randomised attempts run; the one with the fewest unplaced lessons, then the best spread, wins.
 */
function solve(cells: Map<string, Cell[]>, units: Unit[], fixedBusy: Map<string, Cell[]>, maxPeriodsDay: number, attempts: number) {
  const teacherLoad = new Map<string, number>();
  for (const u of units) if (u.teacher) teacherLoad.set(u.teacher, (teacherLoad.get(u.teacher) ?? 0) + 1);
  const sectionLoad = new Map<string, number>();
  for (const u of units) sectionLoad.set(u.section, (sectionLoad.get(u.section) ?? 0) + 1);
  let best: { placed: Map<string, Placed[]>; unplaced: Unit[]; penalty: number; pinMissed: Unit[] } | null = null;
  for (let a = 0; a < attempts; a++) {
    const r = rng(1009 + a * 7919);
    // Pinned lessons (the class teacher's first period) go first, then the hardest to place.
    const order = units.map((u) => ({ u, k: (u.pin ? 1e6 : 0) + (u.teacher ? teacherLoad.get(u.teacher)! : 0) * 3 + sectionLoad.get(u.section)! + r() * 4 })).sort((x, y) => y.k - x.k).map((x) => x.u);
    const taken = new Map<string, Set<string>>();                 // section -> "day:period"
    const tBusy = new Map<string, Cell[]>();                      // teacher -> cells (times)
    for (const [t, list] of fixedBusy) tBusy.set(t, [...list]);
    const subjDay = new Map<string, number>();                    // section|subject|day -> count
    const placed = new Map<string, Placed[]>();
    const unplaced: Unit[] = [];
    let penalty = 0;
    const pinMissed: Unit[] = [];
    for (const u of order) {
      const fits = (c: Cell) => {
        if (taken.get(u.section)?.has(`${c.weekday}:${c.period}`)) return false;
        if ((subjDay.get(`${u.section}|${u.subject}|${c.weekday}`) ?? 0) >= u.maxPerDay) return false;
        if (u.teacher) {
          const busy = tBusy.get(u.teacher) ?? [];
          if (busy.some((b) => b.weekday === c.weekday && toMin(b.starts) < toMin(c.ends) && toMin(c.starts) < toMin(b.ends))) return false;
          if (busy.filter((b) => b.weekday === c.weekday).length >= maxPeriodsDay) return false;
        }
        return true;
      };
      const all = (cells.get(u.section) ?? []).filter(fits);
      const pinned = u.pin ? all.filter((c) => c.weekday === u.pin!.weekday && c.period === u.pin!.period) : [];
      if (u.pin && !pinned.length) pinMissed.push(u);
      const options = pinned.length ? pinned : all;
      if (!options.length) { unplaced.push(u); continue; }
      let pick = options[0];
      let pickScore = Infinity;
      for (const c of options) {
        const same = subjDay.get(`${u.section}|${u.subject}|${c.weekday}`) ?? 0;
        const tDay = u.teacher ? (tBusy.get(u.teacher) ?? []).filter((b) => b.weekday === c.weekday).length : 0;
        const adjacent = (placed.get(u.section) ?? []).some((p) => p.weekday === c.weekday && p.subjectCode === u.subject && Math.abs(p.period - c.period) === 1);
        const score = same * 10 + tDay * 2 + (adjacent ? 3 : 0) + c.period * 0.05 + r() * 1.5;
        if (score < pickScore) { pickScore = score; pick = c; }
      }
      penalty += pickScore;
      (taken.get(u.section) ?? taken.set(u.section, new Set()).get(u.section)!).add(`${pick.weekday}:${pick.period}`);
      if (u.teacher) (tBusy.get(u.teacher) ?? tBusy.set(u.teacher, []).get(u.teacher)!).push(pick);
      subjDay.set(`${u.section}|${u.subject}|${pick.weekday}`, (subjDay.get(`${u.section}|${u.subject}|${pick.weekday}`) ?? 0) + 1);
      (placed.get(u.section) ?? placed.set(u.section, []).get(u.section)!).push({ weekday: pick.weekday, period: pick.period, subjectCode: u.subject, teacherId: u.teacher });
    }
    penalty += pinMissed.length * 50;
    if (!best || unplaced.length < best.unplaced.length || (unplaced.length === best.unplaced.length && penalty < best.penalty)) best = { placed, unplaced, penalty, pinMissed };
    if (best.unplaced.length === 0 && a >= 20) break;
  }
  return best!;
}

/** Proposes timetables for some classes from a date. Nothing is saved until the coordinator publishes. */
export async function generate(db: Db, actor: Actor, schoolId: string, input: { sectionIds: string[]; from: string; attempts?: number }) {
  await assertTimetableManager(db, actor, schoolId);
  if (!input.sectionIds.length) throw invalid('Choose at least one class.');
  const cells = new Map<string, Cell[]>();
  const units: Unit[] = [];
  const labels = new Map<string, string>();
  const capacity: { section: string; label: string; periods: number; load: number }[] = [];
  const notes: string[] = [];
  const ctPeriod = await settingsMod.get<string>(db, schoolId, 'timetable.class_teacher_period', input.from);
  for (const id of input.sectionIds) {
    const s = await sectionInfo(db, id);
    if (s.school_id !== schoolId) throw invalid('All classes must be in this school.');
    labels.set(id, s.label);
    const bell = await bellFor(db, schoolId, s.class_code, input.from);
    if (!bell) throw invalid(`${s.label} has no school timings on ${input.from}. Set the timings first.`);
    const c = bell.slots.filter((b) => b.kind === 'PERIOD' && b.weekday <= 5).map((b) => ({ weekday: b.weekday, period: b.period_no!, starts: b.starts, ends: b.ends }));
    cells.set(id, c);
    const load = await db.query<{ subject_code: string; teacher_id: string | null; periods_per_week: number; max_per_day: number }>(
      'select subject_code, teacher_id, periods_per_week, max_per_day from teaching_load where section_id = $1', [id]);
    if (!load.length) throw invalid(`${s.label} has no teaching load yet. Enter subjects and periods first.`);
    const days = new Set(c.map((x) => x.weekday)).size;
    for (const l of load) {
      if (l.periods_per_week > l.max_per_day * days) {
        const name = (await db.one<{ name: string }>('select name from subject where code = $1', [l.subject_code])).name;
        throw invalid(`${s.label}: ${name} has ${l.periods_per_week} periods a week but at most ${l.max_per_day} a day over ${days} days. Raise the daily limit or reduce the periods.`);
      }
    }
    const total = load.reduce((n, l) => n + l.periods_per_week, 0);
    capacity.push({ section: id, label: s.label, periods: c.length, load: total });
    if (total > c.length) throw invalid(`${s.label} needs ${total} periods a week but its timings have only ${c.length}.`);
    const mine: Unit[] = [];
    for (const l of load) for (let i = 0; i < l.periods_per_week; i++) mine.push({ section: id, subject: l.subject_code, teacher: l.teacher_id, maxPerDay: l.max_per_day });
    // The class teacher takes Period 1 with their own class each day, if the school wants it.
    if (ctPeriod === 'FIRST' && s.class_teacher_id) {
      const weekdays = [...new Set(c.filter((x) => x.period === 1).map((x) => x.weekday))].sort();
      const theirs = mine.filter((u) => u.teacher === s.class_teacher_id);
      // Spread across their subjects in this class, one lesson per day.
      const bySubject = new Map<string, Unit[]>();
      for (const u of theirs) (bySubject.get(u.subject) ?? bySubject.set(u.subject, []).get(u.subject)!).push(u);
      const queue: Unit[] = [];
      for (let more = true; more;) { more = false; for (const list of bySubject.values()) { const u = list.shift(); if (u) { queue.push(u); more = true; } } }
      weekdays.forEach((d, i) => { if (queue[i]) queue[i].pin = { weekday: d, period: 1 }; });
      if (!theirs.length) notes.push(`${s.label}: the class teacher has no lessons with the class, so Period 1 could not be given to them.`);
      else if (theirs.length < weekdays.length) notes.push(`${s.label}: the class teacher has only ${theirs.length} periods a week with the class, so they take Period 1 on ${theirs.length} of ${weekdays.length} days.`);
    }
    units.push(...mine);
  }
  // Teachers' lessons in classes that are not being regenerated stay where they are.
  const fixed = await db.query<{ teacher_id: string; weekday: number; period: number; starts: string; ends: string }>(
    `select x.teacher_id, x.weekday, x.period, to_char(x.starts, 'HH24:MI') as starts, to_char(x.ends, 'HH24:MI') as ends
       from timetable t join timetable_slot x on x.timetable_id = t.id join section s on s.id = t.section_id join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and t.valid @> $2::date and x.teacher_id is not null and not (t.section_id = any($3::uuid[]))`, [schoolId, input.from, input.sectionIds]);
  const fixedBusy = new Map<string, Cell[]>();
  for (const f of fixed) (fixedBusy.get(f.teacher_id) ?? fixedBusy.set(f.teacher_id, []).get(f.teacher_id)!).push(f);
  const limits = await settings(db, schoolId);
  const result = solve(cells, units, fixedBusy, limits.max_periods_day, Math.min(Math.max(input.attempts ?? 60, 1), 200));
  const subjects = new Map((await db.query<{ code: string; name: string }>('select code, name from subject')).map((s) => [s.code, s.name]));
  const teachers = new Map((await db.query<{ id: string; name: string }>(`select id, name from app_user where role = 'TEACHER'`)).map((t) => [t.id, t.name]));
  return {
    from: input.from,
    complete: result.unplaced.length === 0,
    sections: input.sectionIds.map((id) => ({
      sectionId: id, label: labels.get(id)!,
      slots: (result.placed.get(id) ?? []).sort((a, b) => a.weekday - b.weekday || a.period - b.period)
        .map((p) => ({ ...p, subject: subjects.get(p.subjectCode), teacher: p.teacherId ? teachers.get(p.teacherId) : null })),
      unplaced: result.unplaced.filter((u) => u.section === id).map((u) => ({ subjectCode: u.subject, subject: subjects.get(u.subject), teacher: u.teacher ? teachers.get(u.teacher) : null })),
    })),
    capacity,
    notes: [...notes, ...[...new Set(result.pinMissed.map((u) => labels.get(u.section)))].map((l) => `${l}: the class teacher is busy elsewhere in Period 1 on some days, so another lesson was placed there.`)],
    classTeachers: Object.fromEntries(await Promise.all(input.sectionIds.map(async (id) => [id, (await sectionInfo(db, id)).class_teacher_id] as const))),
    note: result.unplaced.length ? `${result.unplaced.length} lessons could not be placed. Reduce periods, add a teacher, or raise the daily limit.` : 'Every lesson placed without clashes.',
  };
}

/** Publishes a reviewed proposal for several classes in one transaction, from a date. */
export async function publishProposal(db: Db, actor: Actor, schoolId: string, input: { from: string; sections: { sectionId: string; slots: { weekday: number; period: number; subjectCode: string; teacherId: string | null }[] }[] }) {
  await assertTimetableManager(db, actor, schoolId);
  const entries: Parameters<typeof writeTimetables>[2] = [];
  for (const s of input.sections) {
    const info = await sectionInfo(db, s.sectionId);
    if (info.school_id !== schoolId) throw invalid('All classes must be in this school.');
    entries.push({ sectionId: s.sectionId, from: input.from, slots: await timeLessons(db, schoolId, info.class_code, input.from, s.slots) });
  }
  return db.tx(async (t) => {
    await writeTimetables(t, actor.id, entries);
    return { published: entries.length, days: DAYS.slice(1, 6) };
  }, { actor: actor.label });
}
