import { beforeAll, describe, expect, it } from 'vitest';
import * as settings from '../src/modules/settings.js';
import * as duties from '../src/modules/duties.js';
import * as approvals from '../src/modules/approvals.js';
import * as leave from '../src/modules/leave.js';
import * as attendance from '../src/modules/attendance.js';
import * as attachments from '../src/modules/attachments.js';
import * as homework from '../src/modules/homework.js';
import * as cover from '../src/modules/cover.js';
import * as dataio from '../src/modules/dataio.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { daysFromToday } from '../src/lib/dates.js';

let w: World;
let cmd: Actor; let t2: Actor;
const day = (n: number) => daysFromToday(n);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const unit = async (code: string) => (await w.db.one<{ id: string }>('select id from org_unit where code = $1', [code])).id;

beforeAll(async () => {
  w = await makeWorld();
  cmd = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('WNC Officer', 'COMMAND_OFFICER', 'CEO', 'nes.wnc') returning id`)).id);
  t2 = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('Teacher Two', 'TEACHER', 'TGT', 'nes.wnc.ncs_a') returning id`)).id);
});

describe('settings inherited from NES to Command to school', () => {
  it('uses the nearest value, and a lock from above wins', async () => {
    const key = 'attendance.correction_days';
    expect(await settings.get(w.db, w.schoolA, key)).toBe(2);
    await settings.set(w.db, w.admin, await unit('NES'), { key, value: 5, from: day(0) });
    expect(await settings.get(w.db, w.schoolA, key)).toBe(5);
    await settings.set(w.db, cmd, await unit('WNC'), { key, value: 3, from: day(0) });
    expect(await settings.get(w.db, w.schoolA, key)).toBe(3);
    expect(await settings.get(w.db, w.schoolB, key)).toBe(5);       // ENC school follows NES
    await settings.set(w.db, w.principalA, w.schoolA, { key, value: 1, from: day(0) });
    expect(await settings.get(w.db, w.schoolA, key)).toBe(1);
    await settings.set(w.db, w.admin, await unit('NES'), { key: 'attendance.min_percent', value: 75, from: day(0), locked: true });
    await rejects(settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.min_percent', value: 60, from: day(0) }), /fixed this setting/);
  });

  it('checks values, dates and who may set them, and keeps history', async () => {
    await rejects(settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.correction_days', value: 99, from: day(0) }), /At most 30/);
    await rejects(settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.correction_days', value: 2, from: '2026-01-01' }), /today or a later date/);
    await rejects(settings.set(w.db, w.principalA, await unit('WNC'), { key: 'attendance.correction_days', value: 2, from: day(0) }), /outside your access|cannot change/);
    await rejects(settings.set(w.db, w.principalA, w.schoolA, { key: 'approval.student_leave', value: [{ who: 'PRINCIPAL', label: 'Principal', when: { gte: ['days', 2] } }], from: day(0) }), /always apply/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.correction_days', value: 4, from: day(3) });
    expect(await settings.get(w.db, w.schoolA, 'attendance.correction_days')).toBe(1);
    expect(await settings.get(w.db, w.schoolA, 'attendance.correction_days', day(3))).toBe(4);
    expect((await settings.history(w.db, w.principalA, w.schoolA, 'attendance.correction_days')).length).toBe(2);
    await rejects(w.db.query(`update setting_value set value = '9' where key = 'attendance.correction_days'`), /cannot be edited/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'attendance.correction_days', value: 2, from: day(0) });
  });
});

describe('duties', () => {
  it('gives a teacher exactly the powers of the duty, for its dates', async () => {
    const mark = () => cover.markAbsent(w.db, t2, { schoolId: w.schoolA, teacherId: w.teacherA.id, from: day(1), to: day(1), reason: 'Training' });
    await rejects(mark(), /Timetable coordinator duty/);
    const d = await duties.assign(w.db, w.principalA, w.schoolA, { userId: t2.id, code: 'TIMETABLE_COORDINATOR', from: day(0) });
    expect((await loadActor(w.db, t2.id)).duties).toEqual([{ schoolId: w.schoolA, code: 'TIMETABLE_COORDINATOR' }]);
    await mark();
    await rejects(settings.set(w.db, t2, w.schoolA, { key: 'timetable.max_proxy_day', value: 3, from: day(0) }), /cannot change settings/);
    await duties.end(w.db, w.principalA, d.id, day(1));
    expect(await duties.has(w.db, t2.id, w.schoolA, 'TIMETABLE_COORDINATOR', day(1))).toBe(false);
    await rejects(duties.assign(w.db, w.teacherA, w.schoolA, { userId: t2.id, code: 'EXAM_INCHARGE', from: day(0) }), /access/);
    const f = await family(w);
    await rejects(w.db.query(`insert into duty (school_id, user_id, code, valid, assigned_by) values ($1, $2, 'LIBRARIAN', daterange(current_date, null), $3)`, [w.schoolA, f.parent.id, w.principalA.id]), /only be given to staff/);
  });
});

describe('approval chains', () => {
  it('sends long leave to the class teacher, then the principal, and needs a certificate', async () => {
    const f = await family(w, { classCode: 'X', section: 0 });
    const r = await leave.apply(w.db, f.parent, { studentId: f.studentId, from: day(2), to: day(6), reason: 'Chickenpox' });
    expect(r.steps).toEqual(['Class teacher', 'Principal']);
    expect(r.certificateNeeded).toBe(true);
    // The chain is frozen on the request: changing the setting now does not change it.
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'approval.student_leave', value: [{ who: 'PRINCIPAL', label: 'Principal' }], from: day(0) });
    await rejects(leave.decide(w.db, w.principalA, r.id, true), /class teacher/);
    await rejects(leave.decide(w.db, w.teacherA, r.id, true), /medical certificate/);
    await attachments.upload(w.db, f.parent, { refKind: 'leave', refId: r.id, name: 'certificate.pdf', dataBase64: PDF });
    expect((await leave.decide(w.db, w.teacherA, r.id, true)).status).toBe('PENDING');
    expect((await approvals.inbox(w.db, w.principalA)).map((x) => x.title)).toContain('Leave: Child Test');
    expect((await leave.decide(w.db, w.principalA, r.id, true, 'Get well soon')).status).toBe('APPROVED');
    const row = (await leave.forStudent(w.db, f.parent, f.studentId))[0] as { status: string };
    expect(row.status).toBe('APPROVED');
    await rejects(leave.decide(w.db, w.principalA, r.id, true), /already been decided/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'approval.student_leave', value: [{ who: 'CLASS_TEACHER', label: 'Class teacher' }, { who: 'PRINCIPAL', label: 'Principal', when: { gte: ['days', 4] } }], from: day(0) });
  });

  it('never lets someone approve their own request or decide two steps', async () => {
    const f = await family(w, { classCode: 'X', section: 0 });
    const l = await leave.apply(w.db, f.parent, { studentId: f.studentId, from: day(8), to: day(12), reason: 'Family function' });
    const req = (await approvals.forRef(w.db, 'student_leave', l.id))!;
    await rejects(w.db.query(`insert into approval_decision (request_id, step_no, decision, decided_by) values ($1, 1, 'APPROVE', $2)`, [req.id, f.parent.id]), /own request/);
    await w.db.query(`insert into approval_decision (request_id, step_no, decision, decided_by) values ($1, 1, 'APPROVE', $2)`, [req.id, w.teacherA.id]);
    await rejects(w.db.query(`insert into approval_decision (request_id, step_no, decision, decided_by) values ($1, 2, 'APPROVE', $2)`, [req.id, w.teacherA.id]), /only one step/);
  });
});

describe('attendance corrections', () => {
  it('allows corrections inside the window, and sends older ones for approval', async () => {
    const f = await family(w, { classCode: 'X', section: 0 });
    const sec = w.sectionsA.X[0];
    const recent = day(-1); const old = day(-5);
    await attendance.mark(w.db, w.teacherA, sec, recent, []);
    await attendance.mark(w.db, w.teacherA, sec, old, []);
    const r1 = await attendance.mark(w.db, w.teacherA, sec, recent, [{ enrolmentId: f.enrolmentId, status: 'A' }]);
    expect(r1).toMatchObject({ absent: 1 });
    const r2 = await attendance.mark(w.db, w.teacherA, sec, old, [{ enrolmentId: f.enrolmentId, status: 'L' }]);
    expect(r2).toMatchObject({ pendingApproval: true, approver: 'Principal' });
    const st = async () => (await w.db.one<{ status: string }>(`select m.status from attendance_mark m join attendance_session s on s.id = m.session_id where s.section_id = $1 and s.on_date = $2 and m.enrolment_id = $3`, [sec, old, f.enrolmentId])).status;
    expect(await st()).toBe('P');
    const req = (await approvals.inbox(w.db, w.principalA)).find((x) => x.kind === 'attendance_correction')!;
    await approvals.decide(w.db, w.principalA, req.id, true);
    expect(await st()).toBe('L');
    await rejects(w.db.query(`update attendance_mark set status = 'P' where enrolment_id = $1`, [f.enrolmentId]), /locked/);
  });
});

describe('attachments', () => {
  it('follows the record: teachers attach to their homework, only that class’s parents can open it', async () => {
    const f = await family(w, { classCode: 'X', section: 0 });
    const other = await family(w, { classCode: 'VIII', section: 0 });
    const h = await homework.create(w.db, w.teacherA, { sectionId: w.sectionsA.X[0], subjectCode: 'MAT', title: 'Worksheet 7', dueOn: day(2) });
    const a = await attachments.upload(w.db, w.teacherA, { refKind: 'homework', refId: h.id, name: 'worksheet.pdf', dataBase64: PDF });
    await rejects(attachments.upload(w.db, w.teacherA, { refKind: 'homework', refId: h.id, name: 'evil.pdf', dataBase64: Buffer.from('<script>').toString('base64') }), /Only PDF/);
    await rejects(attachments.upload(w.db, f.parent, { refKind: 'homework', refId: h.id, name: 'x.pdf', dataBase64: PDF }), /access|teach/);
    expect((await attachments.download(w.db, f.parent, a.id)).content_type).toBe('application/pdf');
    await rejects(attachments.download(w.db, other.parent, a.id), /access/);
    const list = await homework.forStudent(w.db, f.parent, f.studentId) as { title: string; attachments: { name: string }[] }[];
    expect(list.find((x) => x.title === 'Worksheet 7')!.attachments[0].name).toBe('worksheet.pdf');
  });
});

describe('spreadsheet import and export', () => {
  const head = 'name,dob,gender,class,section,campus,parent_name,relationship,phone,service,service_status,rank,posted_in_station,admission_no,joined';
  it('checks every row first, and imports all or nothing', async () => {
    const bad = `${head}\nRiya Rao,2012-05-04,F,X,A,Alpha Main,Cdr Arun Rao,FATHER,9811100001,NAVY,SERVING,N_CDR,yes,OLD/0001,2026-04-01\nNo Date,,M,X,Z,Alpha Main,Mr X,FATHER,123,ARMY,SERVING,,no,,`;
    const p = await dataio.previewStudents(w.db, w.principalA, w.schoolA, YEAR, bad);
    expect(p.valid).toBe(1);
    expect(p.rows[1].errors.join(' ')).toMatch(/Date of birth.*no class X-Z.*10-digit/);
    await rejects(dataio.importStudents(w.db, w.principalA, w.schoolA, YEAR, bad), /nothing was imported/);
    const good = `${head}\nRiya Rao,2012-05-04,F,X,A,Alpha Main,Cdr Arun Rao,FATHER,9811100001,NAVY,SERVING,N_CDR,yes,OLD/0001,2026-04-01\nKabir Rao,14/02/2016,M,VIII,B,Alpha Main,Cdr Arun Rao,FATHER,+91 98111 00001,NAVY,SERVING,N_CDR,yes,,`;
    const r = await dataio.importStudents(w.db, w.principalA, w.schoolA, YEAR, good);
    expect(r).toEqual({ students: 2, newFamilies: 1 });
    const kids = await w.db.query<{ admission_category: string; admission_no: string }>(
      `select e.admission_category, e.admission_no from enrolment e join student s on s.id = e.student_id where s.name like '% Rao' order by s.name`);
    expect(kids.map((k) => k.admission_category)).toEqual(['1', '1']);
    expect(kids[1].admission_no).toBe('OLD/0001');
    expect(await w.db.one(`select count(*)::int as n from app_user u join guardian g on g.id = u.guardian_id where g.phone = '+919811100001'`)).toEqual({ n: 1 });
  });

  it('exports Excel-safe files', async () => {
    const out = await dataio.exportStudents(w.db, w.principalA, w.schoolA);
    expect(out.startsWith('﻿Admission no,')).toBe(true);
    expect(out).toContain('Riya Rao');
    expect(dataio.toCsv(['a'], [['=HYPERLINK("x")']])).toContain(`"'=HYPERLINK(""x"")"`);
    expect(dataio.parseCsv('a,"b,c","d""e"\r\n1,2,3')).toEqual([['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  });
});
