import { beforeAll, describe, expect, it } from 'vitest';
import * as timetable from '../src/modules/timetable.js';
import * as cover from '../src/modules/cover.js';
import * as generator from '../src/modules/generator.js';
import * as notify from '../src/modules/notify.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { makeWorld, rejects, BELL, type World } from './helpers.js';
import { daysFromToday } from '../src/lib/dates.js';

let w: World;
let t2: Actor; let t3: Actor;
const day = (n: number) => daysFromToday(n);
/** The next date (from tomorrow) that falls on an ISO weekday. */
const next = (wd: number) => { for (let i = 1; i < 15; i++) if (timetable.isoWeekday(day(i)) === wd) return day(i); throw new Error(); };
const teacher = async (name: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, 'TEACHER', 'TGT', 'nes.wnc.ncs_a') returning id`, [name])).id);
const allWeek = (subject: string, teacherId: string, periods: number[]) =>
  [1, 2, 3, 4, 5].flatMap((d) => periods.map((p) => ({ weekday: d, period: p, subjectCode: subject, teacherId })));

beforeAll(async () => {
  w = await makeWorld();
  t2 = await teacher('Teacher Bravo');
  t3 = await teacher('Teacher Charlie');
  // VIII-A: Teacher Alpha takes maths in P2 every day; Teacher Bravo English in P3.
  await timetable.publish(w.db, w.principalA, w.sectionsA.VIII[0], '2026-04-01', [...allWeek('MAT', w.teacherA.id, [2]), ...allWeek('ENG', t2.id, [3])]);
});

describe('school timings', () => {
  it('times every lesson from the bell, and shows breaks in the day', async () => {
    const d = await timetable.dayForSection(w.db, w.principalA, w.sectionsA.VIII[0], next(1));
    expect(d.rows.map((r) => r.label)).toEqual(BELL.map((b) => b[1]));
    const p2 = d.rows.find((r) => r.period === 2)!;
    expect([p2.starts, p2.ends, p2.subject]).toEqual(['08:40', '09:20', 'Mathematics']);
    await rejects(timetable.publish(w.db, w.principalA, w.sectionsA.VIII[1], '2026-04-01', [{ weekday: 1, period: 9, subjectCode: 'MAT' }]), /no period 9/);
  });

  it('moves class timetables onto new timings from a date, and leaves other classes alone', async () => {
    const from = day(7);
    const timings = (end8: string, shift = 0) => [1, 2, 3, 4, 5].flatMap((d) => BELL.map(([kind, label, p, a, z]) => ({
      weekday: d, kind, label, periodNo: p, starts: timetable.fromMin(timetable.toMin(a) + shift), ends: p === 8 ? end8 : timetable.fromMin(timetable.toMin(z) + shift) })));
    // Starting VIII 20 minutes earlier would put Teacher Alpha in VIII-A and X-B at once: refused, nothing changes.
    await rejects(timetable.publishBell(w.db, w.principalA, w.schoolA, { name: 'Early start', classCodes: ['VIII'], from, slots: timings('13:40', -20) }), /two classes at once/);
    // A longer last period clashes with nothing.
    const r = await timetable.publishBell(w.db, w.principalA, w.schoolA, { name: 'Winter timings', classCodes: ['VIII'], from, slots: timings('14:10') });
    expect(r.timetablesUpdated).toBe(1);
    const after = await timetable.forSection(w.db, w.principalA, w.sectionsA.VIII[0], from) as unknown as { bell: { name: string; slots: { period_no: number; ends: string }[] } };
    expect(after.bell.name).toBe('Winter timings');
    expect(after.bell.slots.find((s) => s.period_no === 8)!.ends).toBe('14:10');
    expect((await timetable.bellFor(w.db, w.schoolA, 'VIII', day(1)))!.name).toBe('Main timings');
    expect((await timetable.bellFor(w.db, w.schoolA, 'X', from))!.name).toBe('Main timings');
    await rejects(timetable.publishBell(w.db, w.principalA, w.schoolA, { name: 'Old', classCodes: ['X'], from: '2026-01-01', slots: timings('14:00') }), /not in the past/);
    await rejects(timetable.publishBell(w.db, w.teacherA, w.schoolA, { name: 'Mine', classCodes: ['X'], from, slots: timings('14:00') }), /access|duty/);
    await rejects(timetable.publishBell(w.db, w.principalA, w.schoolA, { name: 'Clash', classCodes: ['X'], from,
      slots: [{ weekday: 1, kind: 'PERIOD', label: 'P1', periodNo: 1, starts: '08:00', ends: '08:40' }, { weekday: 1, kind: 'BREAK', label: 'Break', periodNo: null, starts: '08:30', ends: '08:45' }] }), /overlaps/);
    await rejects(w.db.query(`update bell_slot set ends = '09:00' where schedule_id = (select id from bell_schedule where name = 'Main timings' limit 1)`), /cannot be edited/);
  });
});

describe('special days', () => {
  it('cancels periods for an event, and shows a holiday as no classes', async () => {
    const tue = next(2);
    await cover.addDayPlan(w.db, w.principalA, { schoolId: w.schoolA, date: tue, classCodes: ['VIII'], kind: 'EVENT', title: 'Annual Day rehearsal', cancelledPeriods: [2, 3] });
    const d = await timetable.dayForSection(w.db, w.principalA, w.sectionsA.VIII[0], tue);
    expect(d.rows.find((r) => r.period === 2)!.cancelled).toBe('Annual Day rehearsal');
    expect(d.rows.find((r) => r.period === 1)!.cancelled).toBeNull();
    await rejects(cover.addDayPlan(w.db, w.principalA, { schoolId: w.schoolA, date: tue, classCodes: null, kind: 'NO_CLASSES', title: 'Clash' }), /already have/);
    const wed = next(3);
    await w.db.query(`insert into calendar_event (unit_id, title, kind, period, created_by) values ($1, 'Founders Day', 'HOLIDAY', daterange($2::date, ($2::date + 1)), $3)`, [w.schoolA, wed, w.principalA.id]);
    expect((await timetable.dayForSection(w.db, w.principalA, w.sectionsA.VIII[0], wed)).closed).toBe('Founders Day');
  });

  it('runs a short day on its own timings', async () => {
    const thu = next(4);
    await cover.addDayPlan(w.db, w.principalA, { schoolId: w.schoolA, date: thu, classCodes: ['VIII'], kind: 'SHORT_DAY', title: 'Half day for PTM',
      shortDay: { firstStart: '08:00', minutes: 30, periods: 4, breakAfter: 2, breakMinutes: 10 } });
    const d = await timetable.dayForSection(w.db, w.principalA, w.sectionsA.VIII[0], thu);
    expect(d.rows.map((r) => `${r.period}@${r.starts}`)).toEqual(['1@08:00', '2@08:30', '3@09:10', '4@09:40']);
  });
});

describe('cover for absent teachers', () => {
  it('lists the absent teacher’s lessons and fills them with free teachers, fairly', async () => {
    const mon = next(1);
    await cover.markAbsent(w.db, w.principalA, { schoolId: w.schoolA, teacherId: w.teacherA.id, from: mon, to: mon, reason: 'Medical leave' });
    const b = await cover.board(w.db, w.principalA, w.schoolA, mon);
    const labels = b.needs.map((n) => `${n.label} P${n.period}`).sort();
    expect(labels).toEqual(['VIII-A P2', 'X-B P1']);
    // Teacher Bravo teaches VIII-A (English, P3) so ranks above Teacher Charlie for VIII-A P2.
    const need = b.needs.find((n) => n.label === 'VIII-A')!;
    expect(need.suggestions[0].name).toBe('Teacher Bravo');
    const r = await cover.autoAssign(w.db, w.principalA, w.schoolA, mon);
    expect(r.assigned).toHaveLength(2);
    expect(r.uncovered).toHaveLength(0);
    const after = await cover.board(w.db, w.principalA, w.schoolA, mon);
    expect(after.uncovered).toBe(0);
    expect((await notify.mine(w.db, t2)).items.some((n) => n.kind === 'PROXY')).toBe(true);
    // The parent-facing day shows the cover teacher.
    const d = await timetable.dayForSection(w.db, w.principalA, w.sectionsA.VIII[0], mon);
    expect(d.rows.find((x) => x.period === 2)!.cover?.teacher).toBeTruthy();
  });

  it('never gives a teacher two classes at once, nor cover while absent', async () => {
    const mon = next(1);
    const b = await cover.board(w.db, w.principalA, w.schoolA, mon);
    const p1 = b.needs.find((n) => n.label === 'X-B')!;
    const busy = p1.cover!.substitute_id!;
    await rejects(w.db.query(`insert into substitution (on_date, section_id, period_no, starts, ends, kind, substitute_id, assigned_by) values ($1, $2, 5, '08:00', '08:40', 'PROXY', $3, $4)`,
      [mon, w.sectionsA.VIII[1], busy, w.principalA.id]), /already has a proxy/);
    await rejects(cover.assign(w.db, w.principalA, { schoolId: w.schoolA, date: mon, sectionId: w.sectionsA.VIII[0], period: 2, kind: 'PROXY', substituteId: w.teacherA.id }), /not free/);
  });

  it('respects the daily limit and leaves the rest for the coordinator', async () => {
    const thu = next(4);   // the short day: Teacher Bravo's English is period 3
    await cover.saveSettings(w.db, w.principalA, w.schoolA, { max_proxy_day: 0, max_proxy_week: 6, max_periods_day: 7 });
    await cover.markAbsent(w.db, w.principalA, { schoolId: w.schoolA, teacherId: t2.id, from: thu, to: thu, reason: 'Course' });
    const r = await cover.autoAssign(w.db, w.principalA, w.schoolA, thu);
    expect(r.assigned).toHaveLength(0);
    expect(r.uncovered).toEqual([{ section: 'VIII-A', period: 3, subject: 'English' }]);
    await cover.saveSettings(w.db, w.principalA, w.schoolA, { max_proxy_day: 2, max_proxy_week: 6, max_periods_day: 7 });
  });
});

describe('timetable generator', () => {
  it('places every lesson without clashes and publishes them together', async () => {
    const from = day(10);
    const subj = [['MAT', w.teacherA.id, 7], ['ENG', t2.id, 6], ['SCI', t3.id, 6], ['HIN', null, 5], ['SST', null, 5], ['CS', null, 3], ['PE', null, 2]] as const;
    for (const sec of [w.sectionsA.VIII[0], w.sectionsA.VIII[1]]) {
      await generator.saveLoad(w.db, w.principalA, sec, subj.map(([s, t, n]) => ({ subjectCode: s, teacherId: t, periodsPerWeek: n, maxPerDay: 2 })));
    }
    const p = await generator.generate(w.db, w.principalA, w.schoolA, { sectionIds: [w.sectionsA.VIII[0], w.sectionsA.VIII[1]], from });
    expect(p.complete).toBe(true);
    for (const s of p.sections) expect(s.slots).toHaveLength(34);
    await generator.publishProposal(w.db, w.principalA, w.schoolA, { from, sections: p.sections.map((s) => ({ sectionId: s.sectionId, slots: s.slots })) });
    const clash = await w.db.query(
      `select x.teacher_id, x.weekday, x.period from timetable t join timetable_slot x on x.timetable_id = t.id
        where t.valid @> $1::date and x.teacher_id is not null group by 1, 2, 3 having count(*) > 1`, [from]);
    expect(clash).toHaveLength(0);
    await generator.saveLoad(w.db, w.principalA, w.sectionsA.X[0], [{ subjectCode: 'MAT', teacherId: null, periodsPerWeek: 6, maxPerDay: 1 }]);
    await rejects(generator.generate(w.db, w.principalA, w.schoolA, { sectionIds: [w.sectionsA.X[0]], from }), /at most 1 a day over 5 days/);
    await generator.saveLoad(w.db, w.principalA, w.sectionsA.X[0], ['MAT', 'ENG', 'SCI', 'HIN'].map((c) => ({ subjectCode: c, teacherId: null, periodsPerWeek: 12, maxPerDay: 3 })));
    await rejects(generator.generate(w.db, w.principalA, w.schoolA, { sectionIds: [w.sectionsA.X[0]], from }), /needs 48 periods/);
  });
});
