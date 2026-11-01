import { beforeAll, describe, expect, it } from 'vitest';
import * as admissions from '../src/modules/admissions.js';
import * as students from '../src/modules/students.js';
import * as messaging from '../src/modules/messaging.js';
import * as attendance from '../src/modules/attendance.js';
import { recordMerger } from '../src/modules/org.js';
import { family, movedEarlier, makeWorld, nextPhone, rejects, YEAR, type World } from './helpers.js';
import { localToday } from '../src/lib/dates.js';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const apply = (cls: string, service: Record<string, unknown>) => admissions.submitApplication(w.db, w.principalA, {
  campusId: w.campusA, academicYear: YEAR, classCode: cls, child: { name: 'New Child', dob: '2013-01-01', gender: 'M' },
  guardian: { name: 'New Parent', phone: nextPhone() }, relationship: 'FATHER', service: service as never,
});

async function verifyAll(id: string) {
  const d = await admissions.applicationDetail(w.db, w.principalA, id);
  for (const doc of d.documents as { doc_type: string }[]) await admissions.verifyDocument(w.db, w.principalA, id, doc.doc_type, 'VERIFIED');
}

describe('admissions', () => {
  it('fills a class, then refuses non-Cat 1 and admits Cat 1 only with a reason', async () => {
    for (let i = 0; i < 4; i++) await family(w, { classCode: 'VIII', section: i % 2 });   // VIII capacity is 2 + 2
    const other = await apply('VIII', { service: 'CIVILIAN', status: 'NONE' });
    await verifyAll(other.id);
    await rejects(admissions.offerSeat(w.db, w.principalA, other.id), /is full/);
    const cat1 = await apply('VIII', { service: 'NAVY', status: 'SERVING', rankCode: 'N_PO', postedInStation: true });
    expect(cat1.admissionCategory.code).toBe('1');
    await verifyAll(cat1.id);
    await rejects(admissions.offerSeat(w.db, w.principalA, cat1.id), /give a reason/);
    const o = await admissions.offerSeat(w.db, w.principalA, cat1.id, 'Cat 1 child of serving sailor posted in station');
    expect(o.overCapacity).toBe(true);
    const a = await admissions.admit(w.db, w.principalA, cat1.id, { provisional: true, tcDueDate: '2026-12-31' });
    expect(a.nesId).toMatch(/^NES-\d+$/);
    expect(a.provisional).toBe(true);
    await admissions.confirmProvisional(w.db, w.principalA, cat1.id);
  });

  it('enforces allowed status moves in the database', async () => {
    const app = await apply('X', { service: 'CIVILIAN', status: 'NONE' });
    await rejects(w.db.query(`update application set status = 'ADMITTED' where id = $1`, [app.id]), /cannot move|check/);
  });

  it('keeps staff inside their own school', async () => {
    await rejects(admissions.seatMatrix(w.db, w.principalA, w.campusB, YEAR), /outside your access/);
  });
});

describe('students and transfers', () => {
  it('transfers on posting without overlap, keeping the NES ID', async () => {
    const f = await family(w, { classCode: 'X' });
    const before = await w.db.one<{ nes_id: string }>('select nes_id from student where id = $1', [f.studentId]);
    const t = await movedEarlier(w, f.studentId, w.campusB, '2026-08-01');
    expect(t.admissionNo).toMatch(/^NCS-B\//);
    const rows = await w.db.query<{ status: string; school_id: string }>('select status, school_id from enrolment where student_id = $1 order by lower(period)', [f.studentId]);
    expect(rows.map((r) => r.status)).toEqual(['TRANSFERRED_OUT', 'ACTIVE']);
    expect((await w.db.one<{ nes_id: string }>('select nes_id from student where id = $1', [f.studentId])).nes_id).toBe(before.nes_id);
    await rejects(w.db.query(`insert into enrolment (student_id, school_id, campus_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
       values ($1, $2, $3, $4, 'X', 'dup-1', 'ACTIVE', daterange('2026-09-01', null), '1', '{}')`, [f.studentId, w.schoolA, w.campusA, YEAR]), /exclusion|conflicting/);
  });

  it('records a merger: campuses move, history stays', async () => {
    const tree = await w.db.one<{ path: string }>('select path::text from org_unit where id = $1', [w.campusB]);
    await recordMerger(w.db, w.admin, { mergedSchoolId: w.schoolB, survivingSchoolId: w.schoolA, effectiveDate: '2026-09-01' });
    const moved = await w.db.one<{ path: string; parent_id: string }>('select path::text, parent_id from org_unit where id = $1', [w.campusB]);
    expect(moved.parent_id).toBe(w.schoolA);
    expect(moved.path).not.toBe(tree.path);
    expect((await w.db.one<{ active: boolean }>('select active from org_unit where id = $1', [w.schoolB])).active).toBe(false);
  });
});

describe('messages and attendance', () => {
  it('labels every reply with the child, class, section and admission number', async () => {
    const f = await family(w, { classCode: 'X', section: 1 });
    const th = await messaging.createThread(w.db, w.teacherA, { sectionId: w.sectionsA.X[1], subject: 'Trip', body: 'Will your child come?', replyMode: 'REQUIRED', options: ['Yes', 'No'] });
    await rejects(messaging.reply(w.db, f.parent, th.threadId, { choice: 'Yes' }), /which child/);
    await rejects(messaging.reply(w.db, f.parent, th.threadId, { choice: 'Maybe', studentId: f.studentId }), /not one of the choices/);
    await messaging.reply(w.db, f.parent, th.threadId, { choice: 'Yes', body: 'See you', studentId: f.studentId });
    const t = await messaging.thread(w.db, w.teacherA, th.threadId);
    const r = (t.messages as Record<string, unknown>[]).find((m) => m.choice === 'Yes')!;
    expect(r.student_name).toBe('Child Test');
    expect(r.class_code).toBe('X');
    expect(r.section).toBe('B');
    expect(r.admission_no).toBeTruthy();
    expect(r.relationship).toBe('FATHER');
    const resp = await messaging.responses(w.db, w.teacherA, th.threadId);
    expect(resp.length).toBeGreaterThan(0);
  });

  it('locks attendance after the day it was taken', async () => {
    const f = await family(w, { classCode: 'X' });
    const today = localToday();
    const res = await attendance.mark(w.db, w.teacherA, w.sectionsA.X[0], today, [{ enrolmentId: f.enrolmentId, status: 'A' }]);
    expect((res as { absent: number }).absent).toBe(1);
    const s = await w.db.one<{ id: string }>(`insert into attendance_session (section_id, on_date, marked_by) values ($1, current_date - 3, $2) returning id`, [w.sectionsA.X[0], w.teacherA.id]);
    await w.db.query(`insert into attendance_mark values ($1, $2, 'P')`, [s.id, f.enrolmentId]);
    await rejects(w.db.query(`update attendance_mark set status = 'A' where session_id = $1`, [s.id]), /locked/);
  });

  it("shows the principal the whole school's roll for the day", async () => {
    const f = await family(w, { classCode: 'X' });
    const today = localToday();
    await attendance.mark(w.db, w.teacherA, w.sectionsA.X[0], today, [{ enrolmentId: f.enrolmentId, status: 'A' }]);
    const d = await attendance.schoolDay(w.db, w.principalA, w.schoolA, today);
    expect(d.marked).toBeGreaterThanOrEqual(1);
    expect(d.sections).toBeGreaterThanOrEqual(d.marked);
    expect(d.absent).toBeGreaterThanOrEqual(1);
    expect((await attendance.schoolDay(w.db, w.principalA, w.schoolA, '2026-11-01')).noSchool).toBe(true);   // a Sunday
    await rejects(attendance.schoolDay(w.db, w.teacherA, w.schoolA, today), /do not have access/);
    await rejects(attendance.schoolDay(w.db, w.principalA, w.schoolB, today), /outside your access/);
  });

  it('narrows the student list by class, section and status', async () => {
    await family(w, { classCode: 'X' });
    const x = await students.search(w.db, w.principalA, '', w.schoolA, { classCode: 'X' }) as { class_code: string }[];
    expect(x.length).toBeGreaterThan(0);
    expect(x.every((s) => s.class_code === 'X')).toBe(true);
    expect(await students.search(w.db, w.principalA, '', w.schoolA, { classCode: 'X', section: 'Z' })).toHaveLength(0);
    const active = await students.search(w.db, w.principalA, '', w.schoolA, { status: 'ACTIVE' }) as { status: string }[];
    expect(active.every((s) => s.status === 'ACTIVE')).toBe(true);
  });
});

describe('audit trail', () => {
  it('chains every change so tampering is detectable', async () => {
    const rows = await w.db.query<{ prev_hash: string | null; hash: string }>('select prev_hash, hash from audit_log order by id');
    expect(rows.length).toBeGreaterThan(10);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
  });
});

describe('category privacy', () => {
  it('shows the admission category to the school but never to the parent', async () => {
    const f = await family(w);
    const school = await students.profile(w.db, w.principalA, f.studentId);
    expect(school.enrolments[0].admission_category).toBe('1');
    const parent = await students.profile(w.db, f.parent, f.studentId);
    expect(JSON.stringify(parent)).not.toMatch(/admission_category|category_snapshot/);
    expect(parent.feeBand).toBeNull();
  });
});

describe('the admission form is the only place a family is entered', () => {
  it('carries every detail into the child and family records, links both parents, and gives each a sign-in', async () => {
    const mum = nextPhone(), dad = nextPhone();
    const app = await admissions.submitApplication(w.db, w.principalA, {
      campusId: w.campusA, academicYear: YEAR, classCode: 'X',
      child: { name: 'Ira Nair', dob: '2011-05-09', gender: 'F', bloodGroup: 'A+', apaarId: '123456789012', pen: '20231234567' },
      guardian: { name: 'Lt Cdr Vikram Nair', phone: dad }, relationship: 'FATHER',
      service: { service: 'NAVY', status: 'SERVING', rankCode: 'N_LCDR', postedInStation: true } as never,
      address: 'Flat 12, Sagar Apartments, Navy Nagar', previousSchool: 'Kendriya Vidyalaya, Kochi',
      otherParent: { name: 'Dr Meera Nair', phone: mum, relationship: 'MOTHER' },
    });
    await verifyAll(app.id);
    await admissions.offerSeat(w.db, w.principalA, app.id, 'Posted in station');
    const a = await admissions.admit(w.db, w.principalA, app.id, {});
    const s = await w.db.one<{ blood_group: string; apaar_id: string; pen: string; previous_school: string }>('select blood_group, apaar_id, pen, previous_school from student where id = $1', [a.studentId]);
    expect(s).toEqual({ blood_group: 'A+', apaar_id: '123456789012', pen: '20231234567', previous_school: 'Kendriya Vidyalaya, Kochi' });
    const parents = await w.db.query<{ relationship: string; address: string; signs_in: boolean }>(
      `select sg.relationship, g.address, exists (select 1 from app_user u where u.guardian_id = g.id and u.role = 'PARENT') as signs_in
         from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = $1 order by sg.is_primary desc`, [a.studentId]);
    expect(parents).toEqual([{ relationship: 'FATHER', address: 'Flat 12, Sagar Apartments, Navy Nagar', signs_in: true }, { relationship: 'MOTHER', address: 'Flat 12, Sagar Apartments, Navy Nagar', signs_in: true }]);
    // The TC reads the same records: both parents' names, without anyone typing them again.
    const p = await students.profile(w.db, w.principalA, a.studentId) as unknown as { guardians: { name: string; address?: string }[] };
    expect(p.guardians.map((g) => g.name)).toEqual(['Lt Cdr Vikram Nair', 'Dr Meera Nair']);
    // One correction, everywhere.
    await students.updateDetails(w.db, w.principalA, a.studentId, { bloodGroup: 'AB+' });
    expect((await w.db.one<{ b: string }>('select blood_group as b from student where id = $1', [a.studentId])).b).toBe('AB+');
    await rejects(students.updateDetails(w.db, w.teacherA, a.studentId, { bloodGroup: 'O+' }), /school office/);
  });
});
