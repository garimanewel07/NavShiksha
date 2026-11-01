import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import * as charges from '../src/modules/charges.js';
import * as leave from '../src/modules/leave.js';
import * as certificates from '../src/modules/certificates.js';
import * as library from '../src/modules/library.js';
import * as duties from '../src/modules/duties.js';
import * as settings from '../src/modules/settings.js';
import * as transfers from '../src/modules/transfers.js';
import { profile } from '../src/modules/students.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { localToday, daysFromToday } from '../src/lib/dates.js';

let w: World;
let accountantA: Actor, accountantB: Actor, principalB: Actor, librarian: Actor;
type Fam = Awaited<ReturnType<typeof family>>;
const today = localToday();
const plus = (n: number) => daysFromToday(n);

const user = async (name: string, role: string, scope: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3) returning id`, [name, role, scope])).id);
const pay = async (f: Fam, bill: string) => {
  const o = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `pay-${bill}-${f.studentId}`, items: [{ enrolmentId: f.enrolmentId, bill }] }) as { id: string };
  return payments.sandboxPay(w.db, f.parent, o.id, 'success');
};
const owed = async (enrolmentId: string, bill: string) =>
  w.db.one<{ owed: number; paid: number }>(`select coalesce(sum(owed_paise), 0)::int as owed, coalesce(sum(paid_paise), 0)::int as paid from fee_due where enrolment_id = $1 and bill = $2`, [enrolmentId, bill]);
const balanced = async () => {
  const r = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
  expect(r.d).toBe(r.c);
};
const raiseAll = async (schoolId: string) => { for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) await fees.generateDemands(w.db, w.finance, schoolId, YEAR, q); };
type Incoming = { id: string; sections: { id: string; label: string; free: number; capacity: number }[] };
const seatAt = async (requestId: string) => ((await transfers.incomingRequests(w.db, principalB, w.schoolB)) as unknown as Incoming[]).find((x) => x.id === requestId)!.sections;
/** School A asks school B, B accepts into a section with room, A issues the TC: the child moves the day after leaving. */
const moveToB = async (f: Fam, joiningOn: string, reason: string) => {
  const req = await transfers.requestTransfer(w.db, w.principalA, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn, reason });
  const seat = (await seatAt(req.id)).find((x) => x.free > 0)!;
  await transfers.decide(w.db, principalB, req.id, { decision: 'ACCEPT', sectionId: seat.id });
  const tc = await certificates.prepare(w.db, w.principalA, { studentId: f.studentId, kind: 'TC', leavingDate: new Date(Date.parse(joiningOn) - 864e5).toISOString().slice(0, 10), reason });
  const issued = await certificates.submit(w.db, w.principalA, tc.id) as { status: string; serial: string };
  const done = await w.db.one<{ new_enrolment_id: string; status: string; section: string }>(
    `select r.new_enrolment_id, r.status, s.class_code || '-' || s.name as section from transfer_request r join section s on s.id = r.section_id where r.id = $1`, [req.id]);
  return { ...done, requestId: req.id, serial: issued.serial, seat };
};

beforeAll(async () => {
  w = await makeWorld();
  accountantA = await user('Accountant Alpha', 'ACCOUNTANT', 'nes.wnc.ncs_a');
  accountantB = await user('Accountant Bravo', 'ACCOUNTANT', 'nes.enc.ncs_b');
  principalB = await user('Principal Bravo', 'SCHOOL_ADMIN', 'nes.enc.ncs_b');
  librarian = await user('Librarian Lata', 'TEACHER', 'nes.wnc.ncs_a');
  await duties.assign(w.db, w.principalA, w.schoolA, { userId: librarian.id, code: 'LIBRARIAN', from: today });
  librarian = await loadActor(w.db, librarian.id);
});

describe('moving to another NES school on posting, mid-quarter', () => {
  let f: Fam, r: Awaited<ReturnType<typeof moveToB>>, q4: number, trip: string, cbse: string, cbseB: string, tripB: string;
  it('keeps the current quarter at the old school, reverses and refunds later ones there, and moves no money between schools', async () => {
    f = await family(w, { classCode: 'X' });
    await raiseAll(w.schoolA);
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) await pay(f, q);
    q4 = (await owed(f.enrolmentId, 'Q4')).owed;
    // A trip still to come, paid; and the CBSE registration, already sent to the board.
    trip = (await charges.draft(w.db, accountantA, { schoolId: w.schoolA, year: YEAR, head: 'TRIP', title: 'Trip to the planetarium', amountPaise: 80000, mode: 'OPTIONAL',
      classCodes: ['X'], dueOn: plus(20), respondBy: plus(14), refundableUntil: plus(16) })).id;
    await charges.approve(w.db, w.principalA, trip);
    await charges.respond(w.db, f.parent, trip, f.studentId, true);
    await pay(f, `C:${trip}`);
    cbse = (await charges.draft(w.db, accountantA, { schoolId: w.schoolA, year: YEAR, head: 'CBSE', title: 'CBSE registration, Class X', amountPaise: 150000, mode: 'COMPULSORY', classCodes: ['X'], dueOn: plus(20) })).id;
    await charges.approve(w.db, w.principalA, cbse);
    await pay(f, `C:${cbse}`);
    await charges.payout(w.db, accountantA, cbse, { amountPaise: 150000, paidOn: today, payee: 'CBSE', reference: 'CBSE-CHALLAN-0001' });
    // At the new school: its own CBSE registration and a trip for Class X are open.
    cbseB = (await charges.draft(w.db, accountantB, { schoolId: w.schoolB, year: YEAR, head: 'CBSE', title: 'CBSE registration, Class X', amountPaise: 150000, mode: 'COMPULSORY', classCodes: ['X'], dueOn: plus(25) })).id;
    await charges.approve(w.db, principalB, cbseB);
    tripB = (await charges.draft(w.db, accountantB, { schoolId: w.schoolB, year: YEAR, head: 'TRIP', title: 'Visit to the naval dockyard', amountPaise: 50000, mode: 'OPTIONAL', classCodes: ['X'], dueOn: plus(30), respondBy: plus(25) })).id;
    await charges.approve(w.db, principalB, tripB);
    await leave.apply(w.db, f.parent, { studentId: f.studentId, from: plus(12), to: plus(13), reason: 'Family function' });
    await certificates.request(w.db, f.parent, { studentId: f.studentId, kind: 'BONAFIDE', purpose: 'Bank account' });

    r = await moveToB(f, plus(10), 'Father posted to Visakhapatnam');
    expect(r).toMatchObject({ status: 'COMPLETED', section: r.seat.label });
    const part = async (charge: string) => (await w.db.one<{ status: string; note: string }>(`select p.status, p.note from fee_charge_participant p join enrolment e on e.id = p.enrolment_id where p.charge_id = $1 and e.student_id = $2`, [charge, f.studentId]));
    expect(await part(trip)).toMatchObject({ status: 'EXCUSED' });                       // trip still to come: released
    expect(await part(cbse)).toMatchObject({ status: 'IN' });                            // already sent to CBSE: stands
    expect(await part(tripB)).toMatchObject({ status: 'AWAITING' });                     // asked at the new school
    expect(await part(cbseB)).toMatchObject({ status: 'EXCUSED', note: 'Already paid at NCS Alpha' });
    expect((await w.db.one<{ status: string }>(`select status from leave_request where student_id = $1`, [f.studentId])).status).toBe('CANCELLED');
    expect((await w.db.one<{ status: string }>(`select status from certificate where student_id = $1 and kind = 'BONAFIDE'`, [f.studentId])).status).toBe('REJECTED');
    // The old school keeps Q3 (the quarter in progress); Q4 and the trip are reversed and refunded by it.
    expect(await owed(f.enrolmentId, 'Q3')).toMatchObject({ paid: (await owed(f.enrolmentId, 'Q3')).owed });
    expect((await owed(f.enrolmentId, 'Q4')).owed).toBe(0);
    const refunds = await w.db.query<{ amount: number; status: string; school_id: string }>(`select amount_paise::int as amount, status, school_id from fee_refund where enrolment_id = $1 order by amount_paise`, [f.enrolmentId]);
    expect(refunds.map((x) => x.amount).reduce((a, b) => a + b, 0)).toBe(q4 + 80000);
    expect(refunds.every((x) => x.status === 'APPROVED' && x.school_id === w.schoolA)).toBe(true);
    // Nothing is paid in at the new school on the family's behalf.
    expect((await w.db.one<{ n: number }>('select count(*)::int as n from payment where school_id = $1', [w.schoolB])).n).toBe(0);
    const n = await w.db.one<{ body: string }>(`select body from notification where user_id = $1 and title like '%now belongs to NCS Bravo' order by created_at desc limit 1`, [f.parent.id]);
    expect(n.body).toMatch(/Fees are paid at NCS Alpha up to December 2026; NCS Bravo charges from the next quarter\..*refunded by NCS Alpha/);
    await balanced();
  });

  it('charges at the new school only from the next quarter, and shows what was paid at the old one', async () => {
    const q3 = await fees.generateDemands(w.db, w.finance, w.schoolB, YEAR, 'Q3');
    expect(q3.created).toBe(0);
    const q4b = await fees.generateDemands(w.db, w.finance, w.schoolB, YEAR, 'Q4');
    expect(q4b.created).toBe(1);
    const due = (await fees.dues(w.db, f.studentId)).filter((d) => d.enrolment_id === r.new_enrolment_id && d.bill === 'Q4');
    expect(due.reduce((s, d) => s + d.due_paise, 0)).toBeGreaterThan(0);
    const p = await profile(w.db, principalB, f.studentId) as unknown as { payments: { school: string; amount_paise: number }[] };
    expect(p.payments.filter((x) => x.school === 'NCS Alpha').length).toBe(6);
    const inc = await transfers.incoming(w.db, principalB, w.schoolB) as { student_id: string; from_school: string; paid_before_paise: number; reason: string }[];
    expect(inc.find((x) => x.student_id === f.studentId)).toMatchObject({ from_school: 'NCS Alpha', reason: 'Father posted to Visakhapatnam' });
    await rejects(transfers.placeInSection(w.db, accountantA, r.new_enrolment_id, (await w.db.one<{ id: string }>(`select id from section where campus_id = $1 and class_code = 'X' and name = 'B'`, [w.campusB])).id), /principal or the office/);
    const other = (await w.db.one<{ id: string }>(`select id from section where campus_id = $1 and class_code = 'X' and name = 'B'`, [w.campusB])).id;
    const moved = await transfers.placeInSection(w.db, principalB, r.new_enrolment_id, other);
    expect(moved.rollNo).toBeGreaterThan(0);
    await balanced();
  });
});

describe('asking another school for a seat', () => {
  it('lists only Navy Children Schools and Navy Kindergartens that teach the class; parents see availability, not numbers', async () => {
    const nkg = (await w.db.one<{ id: string }>(`insert into org_unit (kind, code, name, parent_id, school_type) values ('school', 'NKG-C', 'Navy Kindergarten Charlie', (select parent_id from org_unit where id = $1), 'NKG') returning id`, [w.schoolA])).id;
    const nkgCampus = (await w.db.one<{ id: string }>(`insert into org_unit (kind, code, name, parent_id, address) values ('campus', 'NKG-C-1', 'Charlie Main', $1, 'Charlie Road') returning id`, [nkg])).id;
    await w.db.query(`insert into section (campus_id, academic_year, class_code, name, capacity) values ($1, $2, 'BV1', 'A', 25)`, [nkgCampus, YEAR]);
    const f = await family(w, { classCode: 'X' });
    const staff = await transfers.destinations(w.db, w.principalA, f.studentId);
    expect(staff.schools.map((s) => s.name)).toEqual(['NCS Bravo']);                    // the NKG does not teach Class X
    expect(staff.schools[0]).toMatchObject({ type: 'NCS', available: true, capacity: 60, free: expect.any(Number) });
    const parent = await transfers.destinations(w.db, f.parent, f.studentId);
    expect(parent.schools[0]).not.toHaveProperty('free');
    await rejects(transfers.destinations(w.db, w.teacherA, f.studentId), /parent or by the school office/);
    await rejects(transfers.requestTransfer(w.db, w.principalA, { studentId: f.studentId, toSchoolId: nkg, joiningOn: plus(5), reason: 'Posting' }), /teaches Class X/);
  });

  it('nothing moves until the new school accepts; seats are checked; a waiting list and declining are possible', async () => {
    const f = await family(w, { classCode: 'X' });
    const req = await transfers.requestTransfer(w.db, f.parent, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn: plus(15), reason: 'Mother posted to Visakhapatnam' });
    await rejects(transfers.requestTransfer(w.db, f.parent, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn: plus(15), reason: 'Again' }), /already open/);
    const told = await w.db.one<{ n: number }>(`select count(*)::int as n from notification where user_id = $1 and kind = 'TRANSFER'`, [principalB.id]);
    expect(told.n).toBeGreaterThan(0);
    // Only the new school's principal or admission in-charge answers; never the old school.
    await rejects(transfers.decide(w.db, w.principalA, req.id, { decision: 'ACCEPT', sectionId: (await seatAt(req.id))[0].id }), /outside your access/);
    // A full section cannot take the child; the waiting list can.
    const xa = (await seatAt(req.id)).find((x) => x.label === 'X-B')!;                 // the child moved earlier sits here
    await w.db.query('update section set capacity = (select count(*) from enrolment e where e.section_id = section.id and upper_inf(e.period)) where id = $1', [xa.id]);
    await rejects(transfers.decide(w.db, principalB, req.id, { decision: 'ACCEPT', sectionId: xa.id }), /is full/);
    expect(await transfers.decide(w.db, principalB, req.id, { decision: 'WAITLIST', note: 'A seat is expected in November' })).toMatchObject({ status: 'WAITLISTED' });
    await w.db.query('update section set capacity = 30 where id = $1', [xa.id]);
    expect(await transfers.decide(w.db, principalB, req.id, { decision: 'ACCEPT', sectionId: xa.id })).toMatchObject({ status: 'ACCEPTED', section: 'X-B' });
    // The accepted seat is held: it counts against the section until the child arrives.
    expect((await seatAt(req.id)).find((x) => x.id === xa.id)).toMatchObject({ free: 30 - (await w.db.one<{ n: number }>('select count(*)::int as n from enrolment where section_id = $1 and upper_inf(period)', [xa.id])).n - 1 });
    // Withdrawn by the parent: the seat is freed and the TC can be for leaving NES again.
    await transfers.cancelRequest(w.db, f.parent, req.id, 'Posting cancelled');
    expect(await transfers.openRequest(w.db, f.studentId)).toBeNull();
    // Declining needs a reason the parent can read.
    const again = await transfers.requestTransfer(w.db, w.principalA, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn: plus(20), reason: 'Posting' });
    await rejects(transfers.decide(w.db, principalB, again.id, { decision: 'DECLINE' }), /Give the reason/);
    await transfers.decide(w.db, principalB, again.id, { decision: 'DECLINE', note: 'Class X is full for this year' });
    const n = await w.db.one<{ body: string }>(`select body from notification where user_id = $1 and title like '%cannot take%' order by created_at desc limit 1`, [f.parent.id]);
    expect(n.body).toBe('Class X is full for this year');
    await rejects(w.db.query(`update transfer_request set status = 'ACCEPTED' where id = $1`, [again.id]), /closed/);
  });

  it('a parent asking for a TC to another Navy school asks that school at the same time', async () => {
    const f = await family(w, { classCode: 'X' });
    await certificates.request(w.db, f.parent, { studentId: f.studentId, kind: 'TC', purpose: 'Admission at NCS Bravo', leavingDate: plus(9), reason: 'Father posted', destinationSchoolId: w.schoolB });
    expect(await transfers.openRequest(w.db, f.studentId)).toMatchObject({ status: 'PENDING', to_name: 'NCS Bravo' });
    const mine = await transfers.requestsForStudent(w.db, f.parent, f.studentId) as { joining_on: string; to_school: string }[];
    expect(mine[0]).toMatchObject({ joining_on: plus(10), to_school: 'NCS Bravo' });
  });
});

describe('new admissions during the year', () => {
  it('bills a child who joins in July for April to June as well (from the start of the year)', async () => {
    const f = await family(w, { classCode: 'X', start: '2026-07-10' });
    expect(await w.db.tx((t) => fees.billJoiner(t, f.enrolmentId), { actor: "test" })).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect((await owed(f.enrolmentId, 'Q1')).owed).toBeGreaterThan(0);
    const lines = async () => (await w.db.one<{ n: number }>(`select count(*)::int as n from fee_demand where enrolment_id = $1`, [f.enrolmentId])).n;
    const before = await lines();
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    expect(await lines()).toBe(before);                                                 // raised once only
  });

  it('can be set to charge from the quarter of joining instead', async () => {
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'fees.new_admission_from', value: 'JOINING_QUARTER', from: today });
    const f = await family(w, { classCode: 'X', start: '2026-07-10' });
    expect(await w.db.tx((t) => fees.billJoiner(t, f.enrolmentId), { actor: "test" })).toEqual(['Q2', 'Q3', 'Q4']);
  });
});

describe('transfer certificates', () => {
  it('to another NES school: issued without waiting for later quarters, and the child moves the next day', async () => {
    const f = await family(w, { classCode: 'X' });
    await raiseAll(w.schoolA);
    for (const q of ['Q1', 'Q2', 'Q3']) await pay(f, q);           // Q4 raised but not paid
    const req = await transfers.requestTransfer(w.db, w.principalA, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn: plus(6), reason: 'Father posted to Visakhapatnam' });
    const t = await certificates.prepare(w.db, w.principalA, { studentId: f.studentId, kind: 'TC', leavingDate: plus(5), reason: 'Father posted to Visakhapatnam' });
    expect(t.data).toMatchObject({ destination: 'NCS Bravo', remarks: 'Transferred to NCS Bravo (Navy Education Society)', transferRequestId: req.id });
    // Not before NCS Bravo gives a seat.
    await rejects(certificates.submit(w.db, w.principalA, t.id), /NCS Bravo has not accepted the child yet \(waiting for its decision\)/);
    await transfers.decide(w.db, principalB, req.id, { decision: 'ACCEPT', sectionId: (await seatAt(req.id))[0].id });
    const issued = await certificates.submit(w.db, w.principalA, t.id) as { status: string; serial: string };
    expect(issued.status).toBe('ISSUED');
    const old = await w.db.one<{ status: string; to: string }>('select status, upper(period)::text as to from enrolment where id = $1', [f.enrolmentId]);
    expect(old).toEqual({ status: 'TRANSFERRED_OUT', to: plus(6) });
    const ne = await w.db.one<{ school_id: string; tc: string; from: string }>(`select school_id, category_snapshot->>'tc' as tc, lower(period)::text as from from enrolment where student_id = $1 and upper_inf(period)`, [f.studentId]);
    expect(ne).toEqual({ school_id: w.schoolB, tc: issued.serial, from: plus(6) });
    expect((await owed(f.enrolmentId, 'Q4')).owed).toBe(0);
    const cea = await certificates.prepare(w.db, principalB, { studentId: f.studentId, kind: 'CEA' });
    expect(cea.data).toMatchObject({ s1School: 'NCS Alpha', s2School: 'NCS Bravo' });
    await balanced();
  });

  it('out of NES: later quarters are reversed and what was paid for them is refunded', async () => {
    const f = await family(w, { classCode: 'X' });
    await raiseAll(w.schoolA);
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) await pay(f, q);
    const q4 = (await owed(f.enrolmentId, 'Q4')).owed;
    const t = await certificates.prepare(w.db, w.principalA, { studentId: f.studentId, kind: 'TC', leavingDate: plus(5), reason: 'Moving abroad' });
    await certificates.submit(w.db, w.principalA, t.id);
    expect((await w.db.one<{ status: string }>('select status from enrolment where id = $1', [f.enrolmentId])).status).toBe('WITHDRAWN');
    expect((await owed(f.enrolmentId, 'Q4')).owed).toBe(0);
    expect((await w.db.one<{ s: number }>(`select coalesce(sum(amount_paise), 0)::int as s from fee_refund where enrolment_id = $1 and status = 'APPROVED'`, [f.enrolmentId])).s).toBe(q4);
    await balanced();
  });

  it('holds a move while a library book is out', async () => {
    const f = await family(w, { classCode: 'X' });
    const adm = (await w.db.one<{ admission_no: string }>('select admission_no from enrolment where id = $1', [f.enrolmentId])).admission_no;
    const b = await library.addBook(w.db, librarian, w.schoolA, { title: 'Malgudi Days', copies: 1 });
    await library.issue(w.db, librarian, w.schoolA, { borrower: adm, barcodes: [b.copies[0].barcode] });
    const req = await transfers.requestTransfer(w.db, w.principalA, { studentId: f.studentId, toSchoolId: w.schoolB, joiningOn: plus(3), reason: 'Posting' });
    await transfers.decide(w.db, principalB, req.id, { decision: 'ACCEPT', sectionId: (await seatAt(req.id))[0].id });
    const t = await certificates.prepare(w.db, w.principalA, { studentId: f.studentId, kind: 'TC', leavingDate: plus(2), reason: 'Posting' });
    await rejects(certificates.submit(w.db, w.principalA, t.id), /library book is not returned \("Malgudi Days"\)/);
  });

  it('downloads every TC in one PDF with a register in front, or as a spreadsheet, by year, class and dates', async () => {
    const tcs = { kind: 'TC' as const };
    expect(await certificates.archive(w.db, w.principalA, w.schoolA, tcs, 'COUNT', 'https://erp.nes.test')).toMatchObject({ count: 3 });
    const on = (await w.db.one<{ d: string }>('select current_date::text as d')).d;          // the issue date as the database sees it
    expect(await certificates.archive(w.db, w.principalA, w.schoolA, { ...tcs, year: YEAR, classCode: 'X', from: on, to: on }, 'COUNT', 'x')).toMatchObject({ count: 3 });
    expect(await certificates.archive(w.db, w.principalA, w.schoolA, { ...tcs, classCode: 'VIII' }, 'COUNT', 'x')).toMatchObject({ count: 0 });
    expect(await certificates.archive(w.db, w.principalA, w.schoolA, { ...tcs, to: plus(-30) }, 'COUNT', 'x')).toMatchObject({ count: 0 });
    const pdf = await certificates.archive(w.db, w.principalA, w.schoolA, tcs, 'PDF', 'https://erp.nes.test') as { pdf: Buffer; count: number };
    expect((await PDFDocument.load(pdf.pdf)).getPageCount()).toBe(1 + 3);
    const csv = await certificates.archive(w.db, w.principalA, w.schoolA, {}, 'CSV', 'x') as { csv: string };
    expect(csv.csv.split('\r\n').filter(Boolean).length).toBe(1 + 3);
    expect(csv.csv).toMatch(/^Serial no,Certificate,Issued on/);
    await rejects(certificates.archive(w.db, principalB, w.schoolA, tcs, 'PDF', 'x'), /outside your access/);
    // Downloads do not count as printed copies.
    expect((await w.db.one<{ n: number }>(`select coalesce(sum(copies_printed), 0)::int as n from certificate where kind = 'TC'`)).n).toBe(0);
  });
});
