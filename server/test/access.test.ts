import { beforeAll, describe, expect, it } from 'vitest';
import * as students from '../src/modules/students.js';
import * as studentApp from '../src/modules/studentApp.js';
import * as payments from '../src/modules/payments.js';
import * as admissions from '../src/modules/admissions.js';
import * as dashboard from '../src/modules/dashboard.js';
import * as attendance from '../src/modules/attendance.js';
import * as settings from '../src/modules/settings.js';
import * as duties from '../src/modules/duties.js';
import * as classTeachers from '../src/modules/classTeachers.js';
import * as cover from '../src/modules/cover.js';
import * as leave from '../src/modules/leave.js';
import * as generator from '../src/modules/generator.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';
import { daysFromToday } from '../src/lib/dates.js';

let w: World;
let accountant: Actor; let command: Actor; let pgt: Actor; let co: Actor;
let xb: Awaited<ReturnType<typeof family>>;     // a child in X-B: Teacher Alpha teaches them maths
let xa: Awaited<ReturnType<typeof family>>;     // a child in X-A: Teacher Alpha is their class teacher
const day = (n: number) => daysFromToday(n);
const user = async (name: string, role: string, scope: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3::ltree) returning id`, [name, role, scope])).id);

beforeAll(async () => {
  w = await makeWorld();
  accountant = await user('Accountant Alpha', 'ACCOUNTANT', 'nes.wnc.ncs_a');
  command = await user('Command Officer', 'COMMAND_OFFICER', 'nes.wnc');
  pgt = await user('PGT Physics', 'TEACHER', 'nes.wnc.ncs_a');
  co = await user('Co Teacher', 'TEACHER', 'nes.wnc.ncs_a');
  xb = await family(w, { classCode: 'X', section: 1 });
  xa = await family(w, { classCode: 'X', section: 0 });
});

describe('what each person sees of a child', () => {
  it('a subject teacher sees the class and attendance, never fees, categories or family contacts', async () => {
    const p = await students.profile(w.db, w.teacherA, xb.studentId);
    expect(p.grants.sort()).toEqual(['academics', 'attendance', 'profile']);
    expect(p.dues).toBeNull();
    expect(p.feeStatus).toBeNull();
    expect(p.feeBand).toBeNull();
    expect(p.enrolments[0]).not.toHaveProperty('admission_category');
    expect(p.guardians[0]).not.toHaveProperty('phone');
    expect(p.guardians[0]).not.toHaveProperty('rank_code');
    const o = await studentApp.overview(w.db, w.teacherA, xb.studentId);
    expect(o.fees).toBeNull();
    await rejects(studentApp.guardians(w.db, w.teacherA, xb.studentId), /phone numbers/);
    await rejects(payments.collections(w.db, w.teacherA, w.schoolA), /not part of your role/);
    await rejects(payments.createOrder(w.db, w.teacherA, { studentId: xb.studentId, items: [], method: 'UPI', idempotencyKey: 'teacher-try-1' }), /Fee dues/);
    await rejects(admissions.listApplications(w.db, w.teacherA, w.schoolA), /not part of your role/);
    await rejects(dashboard.muster(w.db, w.teacherA, '2026-27'), /not part of your role/);
    const found = await students.search(w.db, w.teacherA, 'Child', w.schoolA) as { admission_category: string | null }[];
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => s.admission_category === null)).toBe(true);
  });

  it('a teacher with no link to the child sees only name and class', async () => {
    const p = await students.profile(w.db, pgt, xb.studentId);
    expect(p.grants).toEqual(['profile']);
    expect(p.attendance).toBeNull();
  });

  it('the class teacher sees contacts, health and attendance; fee status only if the school allows', async () => {
    const p = await students.profile(w.db, w.teacherA, xa.studentId);
    expect(p.grants).toEqual(expect.arrayContaining(['contact', 'health', 'attendance', 'leave']));
    expect(p.guardians[0]).toHaveProperty('phone');
    expect(p.feeStatus).toBeNull();
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'privacy.class_teacher_fee_status', value: true, from: day(0) });
    const q = await students.profile(w.db, w.teacherA, xa.studentId);
    expect(q.feeStatus).toMatch(/OVERDUE|CLEAR/);
    expect(q.dues).toBeNull();
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'privacy.class_teacher_fee_status', value: false, from: day(0) });
  });

  it('the accountant sees fees and fee bands but not health or attendance; the Command sees categories but not fees', async () => {
    const a = await students.profile(w.db, accountant, xb.studentId);
    expect(a.dues).not.toBeNull();
    expect(a.enrolments[0]).toHaveProperty('admission_category');
    expect(a.attendance).toBeNull();
    expect(a.student.blood_group).toBeNull();
    const c = await students.profile(w.db, command, xb.studentId);
    expect(c.dues).toBeNull();
    expect(c.enrolments[0]).toHaveProperty('admission_category');
    expect(c.guardians[0]).not.toHaveProperty('phone');
  });

  it('parents see their child’s fees but never the category', async () => {
    const p = await students.profile(w.db, xb.parent, xb.studentId);
    expect(p.dues).not.toBeNull();
    expect(p.enrolments[0]).not.toHaveProperty('admission_category');
    expect(p.feeBand).toBeNull();
  });

  it('a duty adds exactly what it needs: the admission in-charge sees categories and applications', async () => {
    await rejects(admissions.listApplications(w.db, pgt, w.schoolA), /not part of your role/);
    await duties.assign(w.db, w.principalA, w.schoolA, { userId: pgt.id, code: 'ADMISSION_INCHARGE', from: day(0) });
    const incharge = await loadActor(w.db, pgt.id);
    await admissions.listApplications(w.db, incharge, w.schoolA);
    const p = await students.profile(w.db, incharge, xb.studentId);
    expect(p.enrolments[0]).toHaveProperty('admission_category');
    expect(p.dues).toBeNull();
  });
});

describe('class teachers', () => {
  it('one class teacher per class and one class per teacher, with history', async () => {
    const xbSec = w.sectionsA.X[1];
    await rejects(classTeachers.assign(w.db, w.teacherA, { sectionId: xbSec, userId: co.id, kind: 'CLASS', from: day(0) }), /access/);
    await rejects(classTeachers.assign(w.db, w.principalA, { sectionId: xbSec, userId: w.teacherA.id, kind: 'CLASS', from: day(0) }), /class teacher of X-A. Move them/);
    await classTeachers.assign(w.db, w.principalA, { sectionId: xbSec, userId: pgt.id, kind: 'CLASS', from: day(0) });
    await classTeachers.assign(w.db, w.principalA, { sectionId: xbSec, userId: co.id, kind: 'CLASS', from: day(5) });
    expect((await classTeachers.of(w.db, xbSec, day(1))).classTeacherId).toBe(pgt.id);
    expect((await classTeachers.of(w.db, xbSec, day(6))).classTeacherId).toBe(co.id);
    await rejects(classTeachers.assign(w.db, w.principalA, { sectionId: xbSec, userId: co.id, kind: 'CO', from: day(6) }), /both class teacher and co-class teacher/);
    await rejects(w.db.query(`delete from class_teacher where user_id = $1`, [pgt.id]), /cannot be deleted/);
    const f = await family(w);
    await rejects(w.db.query(`insert into class_teacher (section_id, user_id, kind, valid, assigned_by) values ($1, $2, 'CO', daterange(current_date, '2027-01-01'), $2)`, [xbSec, f.parent.id]), /must be a teacher/);
    const board = await classTeachers.board(w.db, w.principalA, w.schoolA, '2026-27', day(1));
    const row = board.sections.find((s) => s.label === 'X-B')!;
    expect(row.classTeacher?.name).toBe('PGT Physics');
    expect(row.warnings.join(' ')).toMatch(/does not teach this class/);
    expect(row.upcoming.map((u) => u.name)).toEqual(['Co Teacher']);
  });

  it('the roll is the class teacher’s; the co-class teacher acts when the class teacher is away', async () => {
    const xaSec = w.sectionsA.X[0];
    await classTeachers.assign(w.db, w.principalA, { sectionId: xaSec, userId: co.id, kind: 'CO', from: day(0) });
    // Teacher Alpha teaches X-B but is not its class teacher, so cannot take its roll.
    await rejects(attendance.roster(w.db, w.teacherA, w.sectionsA.X[1], day(0)), /taken by its class teacher/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.taken_by', value: 'ANY_TEACHER', from: day(0) });
    await attendance.roster(w.db, w.teacherA, w.sectionsA.X[1], day(0));
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.taken_by', value: 'CLASS_TEACHER', from: day(0) });
    await attendance.roster(w.db, co, xaSec, day(0));
    // Leave goes to the class teacher; while Teacher Alpha is away, to the co-class teacher.
    const l = await leave.apply(w.db, xa.parent, { studentId: xa.studentId, from: day(3), to: day(3), reason: 'Dentist' });
    await rejects(leave.decide(w.db, co, l.id, true), /class teacher/);
    const r = await cover.markAbsent(w.db, w.principalA, { schoolId: w.schoolA, teacherId: w.teacherA.id, from: day(0), to: day(0), reason: 'Training' });
    expect(r.actingClassTeacher).toEqual(['X-A']);
    expect((await classTeachers.of(w.db, xaSec)).actingId).toBe(co.id);
    expect((await leave.decide(w.db, co, l.id, true)).status).toBe('APPROVED');
    const b = await cover.board(w.db, w.principalA, w.schoolA, day(0));
    expect(b.classTeacherCover).toEqual([{ sectionId: xaSec, label: 'X-A', classTeacher: 'Teacher Alpha', acting: 'Co Teacher' }]);
    await cover.withdrawAbsence(w.db, w.principalA, r.id);
  });

  it('the generator gives the class teacher Period 1 with their class every day', async () => {
    const xaSec = w.sectionsA.X[0];
    await generator.saveLoad(w.db, w.principalA, xaSec, [
      { subjectCode: 'MAT', teacherId: w.teacherA.id, periodsPerWeek: 6, maxPerDay: 2 }, { subjectCode: 'ENG', teacherId: pgt.id, periodsPerWeek: 6, maxPerDay: 2 },
      { subjectCode: 'SCI', teacherId: co.id, periodsPerWeek: 6, maxPerDay: 2 }, { subjectCode: 'HIN', teacherId: null, periodsPerWeek: 5, maxPerDay: 1 }]);
    const p = await generator.generate(w.db, w.principalA, w.schoolA, { sectionIds: [xaSec], from: day(14) });
    expect(p.complete).toBe(true);
    // Teacher Alpha already teaches X-B in Period 1 on Mondays, so X-A gets them on the other four days, with a note.
    const first = p.sections[0].slots.filter((s) => s.period === 1);
    expect(first).toHaveLength(5);
    expect(first.filter((s) => s.teacherId === w.teacherA.id).map((s) => s.weekday)).toEqual([2, 3, 4, 5]);
    expect(p.notes.join(' ')).toMatch(/X-A: the class teacher is busy elsewhere in Period 1/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'timetable.class_teacher_period', value: 'NONE', from: day(0) });
    const q = await generator.generate(w.db, w.principalA, w.schoolA, { sectionIds: [xaSec], from: day(14) });
    expect(q.sections[0].slots.filter((s) => s.period === 1).every((s) => s.teacherId === w.teacherA.id)).toBe(false);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'timetable.class_teacher_period', value: 'FIRST', from: day(0) });
  });
});
