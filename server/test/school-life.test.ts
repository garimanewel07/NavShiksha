import { beforeAll, describe, expect, it } from 'vitest';
import * as homework from '../src/modules/homework.js';
import * as notices from '../src/modules/notices.js';
import * as notify from '../src/modules/notify.js';
import * as leave from '../src/modules/leave.js';
import * as timetable from '../src/modules/timetable.js';
import * as attendance from '../src/modules/attendance.js';
import * as studentApp from '../src/modules/studentApp.js';
import { loadActor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';
import { localToday, daysFromToday } from '../src/lib/dates.js';

let w: World;
let fx: Awaited<ReturnType<typeof family>>;   // child in X-A (Teacher Alpha's class)
let fb: Awaited<ReturnType<typeof family>>;   // child in VIII-A
const today = localToday();
const plus = (d: number) => daysFromToday(d);

beforeAll(async () => {
  w = await makeWorld();
  fx = await family(w, { classCode: 'X', section: 0 });
  fb = await family(w, { classCode: 'VIII', section: 0 });
});

describe('homework', () => {
  it('reaches every parent in the section and nobody else', async () => {
    const r = await homework.create(w.db, w.teacherA, { sectionId: w.sectionsA.X[0], subjectCode: 'MAT', title: 'Exercise 4.2', details: 'Questions 1–10', dueOn: plus(2) });
    expect(r.notified).toBeGreaterThanOrEqual(1);
    expect((await notify.mine(w.db, fx.parent)).items.some((n) => n.kind === 'HOMEWORK')).toBe(true);
    expect((await notify.mine(w.db, fb.parent)).items.some((n) => n.kind === 'HOMEWORK')).toBe(false);
    expect((await homework.forStudent(w.db, fx.parent, fx.studentId)).map((h) => h.title)).toContain('Exercise 4.2');
  });

  it('lets a teacher set homework only for sections they teach', async () => {
    await homework.create(w.db, w.teacherA, { sectionId: w.sectionsA.X[1], subjectCode: 'MAT', title: 'Revision sheet', dueOn: plus(1) });
    await rejects(homework.create(w.db, w.teacherA, { sectionId: w.sectionsA.VIII[0], subjectCode: 'MAT', title: 'Not my class', dueOn: plus(1) }), /do not teach/);
  });

  it('can be ticked done by the parent, but never edited — only withdrawn', async () => {
    const [h] = await homework.forStudent(w.db, fx.parent, fx.studentId) as { id: string }[];
    await homework.setDone(w.db, fx.parent, h.id, fx.studentId, true);
    expect((await homework.forStudent(w.db, fx.parent, fx.studentId) as { id: string; done: boolean }[]).find((x) => x.id === h.id)?.done).toBe(true);
    await rejects(homework.setDone(w.db, fb.parent, h.id, fx.studentId, true), /access|duty/);
    await rejects(w.db.query(`update homework set title = 'changed' where id = $1`, [h.id]), /cannot be edited/);
    await homework.withdraw(w.db, w.teacherA, h.id);
    expect((await homework.forStudent(w.db, fx.parent, fx.studentId) as { id: string }[]).some((x) => x.id === h.id)).toBe(false);
    await rejects(w.db.query(`update homework set withdrawn_at = now() where id = $1`, [h.id]), /already been withdrawn/);
  });
});

describe('notices and notifications', () => {
  it('sends an NES notice to every school, and a class notice only to that class', async () => {
    const nesUnit = (await w.db.one<{ id: string }>(`select id from org_unit where code = 'NES'`)).id;
    await notices.create(w.db, w.admin, { unitId: nesUnit, title: 'Republic Day holiday', body: 'All NES schools closed on 26 January.', kind: 'CIRCULAR', audience: 'ALL' });
    await notices.create(w.db, w.principalA, { unitId: w.schoolA, title: 'Class X pre-boards', body: 'From 8 December.', kind: 'NOTICE', audience: 'PARENTS', classCodes: ['X'] });
    const x = (await notices.forStudent(w.db, fx.parent, fx.studentId)).map((n) => n.title);
    const viii = (await notices.forStudent(w.db, fb.parent, fb.studentId)).map((n) => n.title);
    expect(x).toEqual(expect.arrayContaining(['Republic Day holiday', 'Class X pre-boards']));
    expect(viii).toContain('Republic Day holiday');
    expect(viii).not.toContain('Class X pre-boards');
  });

  it('refuses a notice from outside the issuer’s scope, and edits after publishing', async () => {
    await rejects(notices.create(w.db, w.principalA, { unitId: w.schoolB, title: 'Wrong school', body: 'x', kind: 'NOTICE', audience: 'ALL' }), /outside your access/);
    const n = await w.db.one<{ id: string }>(`select id from notice limit 1`);
    await rejects(w.db.query(`update notice set body = 'edited' where id = $1`, [n.id]), /cannot be edited/);
  });

  it('lets people mark only their own notifications read, and only read_at can change', async () => {
    const before = await notify.mine(w.db, fx.parent);
    expect(before.unread).toBeGreaterThan(0);
    await notify.markRead(w.db, fb.parent, 'all');
    expect((await notify.mine(w.db, fx.parent)).unread).toBe(before.unread);
    await notify.markRead(w.db, fx.parent, 'all');
    expect((await notify.mine(w.db, fx.parent)).unread).toBe(0);
    await rejects(w.db.query(`update notification set title = 'x' where user_id = $1`, [fx.parent.id]), /only read_at/);
  });
});

describe('leave', () => {
  it('runs from parent request to class-teacher approval to attendance', async () => {
    const { id } = await leave.apply(w.db, fx.parent, { studentId: fx.studentId, from: today, to: plus(1), reason: 'Fever' });
    await rejects(leave.apply(w.db, fx.parent, { studentId: fx.studentId, from: plus(1), to: plus(2), reason: 'Overlap' }), /overlaps/);
    const other = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('Teacher Two', 'TEACHER', 'TGT', 'nes.wnc.ncs_a') returning id`)).id);
    await rejects(leave.decide(w.db, other, id, true), /do not teach|class teacher/);
    await leave.decide(w.db, w.teacherA, id, true, 'Get well soon');
    expect((await notify.mine(w.db, fx.parent)).items[0].title).toBe('Leave approved');
    await attendance.mark(w.db, w.teacherA, w.sectionsA.X[0], today, []);
    const roster = await attendance.roster(w.db, w.teacherA, w.sectionsA.X[0], today) as unknown as { students: { student_id: string; status: string }[] };
    expect(roster.students.find((s) => s.student_id === fx.studentId)?.status).toBe('L');
    await rejects(w.db.query(`update leave_request set status = 'PENDING' where id = $1`, [id]), /cannot move/);
  });
});

describe('timetable', () => {
  it('keeps history and refuses a teacher in two classes at once', async () => {
    const slots = [{ weekday: 2, period: 1, subjectCode: 'ENG', teacherId: w.teacherA.id }];
    await timetable.publish(w.db, w.principalA, w.sectionsA.VIII[0], '2026-04-01', slots);
    await rejects(timetable.publish(w.db, w.principalA, w.sectionsA.VIII[1], '2026-04-01', slots), /already has class VIII-A/);
    await timetable.publish(w.db, w.principalA, w.sectionsA.VIII[0], '2026-11-01', [{ ...slots[0], subjectCode: 'SCI' }]);
    const before = await timetable.forSection(w.db, w.principalA, w.sectionsA.VIII[0], '2026-10-15') as unknown as { slots: { subject_code: string }[] };
    const after = await timetable.forSection(w.db, w.principalA, w.sectionsA.VIII[0], '2026-11-15') as unknown as { slots: { subject_code: string }[] };
    expect(before.slots[0].subject_code).toBe('ENG');
    expect(after.slots[0].subject_code).toBe('SCI');
    await rejects(timetable.publish(w.db, w.teacherA, w.sectionsA.VIII[0], '2026-12-01', slots), /access|duty/);
  });
});

describe('parent app overview', () => {
  it('gives the child’s day without the admission category', async () => {
    const o = await studentApp.overview(w.db, fx.parent, fx.studentId);
    expect(o.student).toMatchObject({ class_code: 'X', section: 'A', class_teacher: 'Teacher Alpha' });
    expect(JSON.stringify(o)).not.toMatch(/admission_category|category_snapshot/);
    await rejects(studentApp.overview(w.db, fb.parent, fx.studentId), /access|duty/);
  });
});
