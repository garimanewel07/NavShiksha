import { beforeAll, describe, expect, it } from 'vitest';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import * as charges from '../src/modules/charges.js';
import * as refunds from '../src/modules/refunds.js';
import * as approvals from '../src/modules/approvals.js';
import * as settings from '../src/modules/settings.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { localToday, daysFromToday } from '../src/lib/dates.js';

let w: World;
let accountant: Actor;
const ON = '2026-10-16';           // "today" for the revision tests: Q1 and Q2 are overdue, Q3 is due on 25 Oct
const now = localToday();
const plus = (n: number) => daysFromToday(n);
type Fam = Awaited<ReturnType<typeof family>>;

beforeAll(async () => {
  w = await makeWorld();
  accountant = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('Accountant Alpha', 'ACCOUNTANT', 'Accountant', 'nes.wnc.ncs_a') returning id`)).id);
});

const pay = async (f: Fam, bill: string) => {
  const o = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `pay-${bill}-${f.studentId}-${Math.random()}`, items: [{ enrolmentId: f.enrolmentId, bill }] }) as { id: string };
  return payments.sandboxPay(w.db, f.parent, o.id, 'success');
};
const due = async (f: Fam, bill: string, head = 'TUITION') => (await fees.dues(w.db, f.studentId)).find((d) => d.bill === bill && d.head_code === head);
const balanced = async () => {
  const r = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
  expect(r.d).toBe(r.c);
};
const revise = async (input: Parameters<typeof fees.draftRevision>[3]) => {
  const d = await fees.draftRevision(w.db, w.finance, w.planA, input);
  return { draft: d, preview: await fees.previewRevision(w.db, d.versionId, ON), approved: await fees.approveRevision(w.db, w.admin, d.versionId, ON) };
};

describe('a fee rise decided in October, from 1 April', () => {
  let f: Fam;
  it('bills the difference on past quarters as arrears due with the next instalment, not as overdue', async () => {
    f = await family(w, { rank: 'N_PO', classCode: 'X' });
    for (const q of ['Q1', 'Q2', 'Q3']) await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, q);
    await pay(f, 'Q1');
    await rejects(fees.draftRevision(w.db, w.finance, w.planA, { effectiveFrom: '2026-04-01', policy: 'DIFFERENCE_ON_PAID', note: 'x', changes: [{ classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amountPaise: 900000 }] }), /reason/);
    const r = await revise({ effectiveFrom: '2026-04-01', policy: 'DIFFERENCE_ON_PAID', note: 'NES order 14/2026: tuition revised for 2026–27', arrears: { mode: 'WITH_NEXT' },
      changes: [{ classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amountPaise: 900000 }] });
    expect(r.preview.arrearsSchedule).toEqual([{ billKey: 'REV2', dueOn: '2026-10-25' }]);
    expect(r.preview.untouchedInstallments).toEqual([]);
    // Q1 was paid and Q2 is overdue: ₹1,440 each becomes arrears. Q3 is not due yet, so it is simply re-priced.
    const arrears = (await due(f, 'REV2'))!;
    expect(arrears).toMatchObject({ kind: 'ARREARS', owed_paise: 288000, due_date: '2026-10-25', label: 'Arrears: fee revision from 1 Apr 2026', detail: 'NES order 14/2026: tuition revised for 2026–27' });
    expect((await due(f, 'Q2'))!.owed_paise).toBe(756000);
    expect((await due(f, 'Q3'))!.owed_paise).toBe(900000);
    // The old rates stay on record, replaced from their first day.
    const versions = await w.db.query<{ version: number; status: string }>('select version, status from fee_plan_version where plan_id = $1 order by version', [w.planA]);
    expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(['1:SUPERSEDED', '2:PUBLISHED']);
    const n = await w.db.one<{ title: string; body: string }>(`select title, body from notification where user_id = $1 and kind = 'FEES' order by created_at desc limit 1`, [f.parent.id]);
    expect(n.title).toBe('Fees revised from 1 Apr 2026');
    expect(n.body).toMatch(/Arrears of ₹2,880 .* due by 25 Oct/);
    await pay(f, 'REV2');
    expect((await due(f, 'REV2'))!.due_paise).toBe(0);
    await balanced();
  });

  it('can spread arrears over the instalments still to come', async () => {
    const r = await revise({ effectiveFrom: '2026-07-01', policy: 'DIFFERENCE_ON_PAID', note: 'Second revision from the July quarter', arrears: { mode: 'SPREAD' },
      changes: [{ classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amountPaise: 1000000 }] });
    expect(r.preview.arrearsSchedule).toEqual([{ billKey: 'REV3-1', dueOn: '2026-10-25' }, { billKey: 'REV3-2', dueOn: '2027-01-25' }]);
    expect(r.preview.untouchedInstallments).toEqual(['Q1']);
    expect((await due(f, 'REV3-1'))).toMatchObject({ owed_paise: 50000, due_date: '2026-10-25' });
    expect((await due(f, 'REV3-2'))).toMatchObject({ owed_paise: 50000, due_date: '2027-01-25', label: 'Arrears: fee revision from 1 Jul 2026 (part 2)' });
    expect((await due(f, 'Q3'))!.owed_paise).toBe(1000000);
    await balanced();
  });

  it('turns a reduction on paid quarters into credit, and uses it for the family’s other dues', async () => {
    await revise({ effectiveFrom: '2026-04-01', policy: 'DIFFERENCE_ON_PAID', note: 'Reduced on review by NES', arrears: { mode: 'ON_DATE', due: '2026-11-15' },
      changes: [{ classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amountPaise: 700000 }] });
    // Q1 had ₹9,000 paid against a new price of ₹7,000: ₹2,000 credit, used for overdue Q2.
    // Q2 itself drops by ₹3,000 (from ₹10,000), and Q3 to ₹7,000.
    const q2 = (await due(f, 'Q2'))!;
    expect(q2.owed_paise).toBe(756000 - 300000 - 200000);
    expect((await due(f, 'Q3'))!.owed_paise).toBe(700000);
    expect(await due(f, 'REV4')).toBeUndefined();
    expect(await refunds.creditsFor(w.db, f.studentId)).toEqual([]);
    await balanced();
  });
});

describe('a compulsory charge: CBSE registration', () => {
  let a: Fam, b: Fam, c: Fam, viii: Fam, cbse = '';
  it('charges every child in the classes once the principal approves, and nobody else', async () => {
    a = await family(w, { classCode: 'X', section: 0 }); b = await family(w, { classCode: 'X', section: 0 }); c = await family(w, { classCode: 'X', section: 1 }); viii = await family(w, { classCode: 'VIII' });
    await rejects(charges.draft(w.db, w.teacherA, { schoolId: w.schoolA, year: YEAR, head: 'CBSE', title: 'CBSE registration', amountPaise: 150000, mode: 'COMPULSORY', classCodes: ['X'], dueOn: plus(20) }), /not part of your role|accountant or the principal/);
    cbse = (await charges.draft(w.db, accountant, { schoolId: w.schoolA, year: YEAR, head: 'CBSE', title: 'CBSE registration, Class X', details: 'Board registration for 2027 examinations', amountPaise: 150000, mode: 'COMPULSORY', classCodes: ['X'], dueOn: plus(20) })).id;
    expect(await due(a, `C:${cbse}`, 'CBSE')).toBeUndefined();               // nothing billed while it is a draft
    await rejects(charges.approve(w.db, accountant, cbse), /approved by the principal/);
    const r = await charges.approve(w.db, w.principalA, cbse);
    expect(r.added).toBeGreaterThanOrEqual(4);
    expect(await due(a, `C:${cbse}`, 'CBSE')).toMatchObject({ kind: 'CHARGE', owed_paise: 150000, label: 'CBSE registration, Class X', due_date: plus(20) });
    expect(await due(viii, `C:${cbse}`, 'CBSE')).toBeUndefined();
    await rejects(w.db.query(`update fee_charge set amount_paise = 1 where id = $1`, [cbse]), /cannot change once a charge is open/);
  });

  it('lets the principal excuse a child with a reason, and holds CBSE money as payable, not income', async () => {
    await rejects(charges.excuse(w.db, accountant, cbse, b.studentId, 'Exempted by CBSE'), /Only the principal/);
    await charges.excuse(w.db, w.principalA, cbse, b.studentId, 'Exempted by CBSE as a divyang candidate');
    expect(await due(b, `C:${cbse}`, 'CBSE')).toBeUndefined();
    await pay(a, `C:${cbse}`);
    expect((await due(a, `C:${cbse}`, 'CBSE'))!.due_paise).toBe(0);
    await charges.payout(w.db, accountant, cbse, { amountPaise: 150000, paidOn: now, payee: 'CBSE', reference: 'CBSE-CHALLAN-0042' });
    const d = await charges.detail(w.db, accountant, cbse) as any;
    expect(d.collectedPaise).toBe(150000);
    expect(d.paidOutPaise).toBe(150000);
    expect(d.people.find((p: any) => p.studentId === b.studentId).status).toBe('EXCUSED');
    const income = await w.db.one<{ n: number }>(`select count(*)::int as n from journal_line where account_code like '4%' and student_id = $1`, [a.studentId]);
    expect(income.n).toBe(0);
    // Children who join the class later are added on refresh.
    const late = await family(w, { classCode: 'X', section: 1 });
    expect((await charges.refresh(w.db, accountant, cbse)).added).toBe(1);
    expect((await due(late, `C:${cbse}`, 'CBSE'))!.owed_paise).toBe(150000);
    void c;
    await balanced();
  });
});

describe('an optional charge: a trip only some children go on', () => {
  let x: Fam[] = [], trip = '';
  it('charges only those whose parents say yes; seats fill, then a waiting list', async () => {
    x = [await family(w, { classCode: 'X', section: 0 }), await family(w, { classCode: 'X', section: 0 }), await family(w, { classCode: 'X', section: 0 }), await family(w, { classCode: 'X', section: 0 })];
    trip = (await charges.draft(w.db, accountant, { schoolId: w.schoolA, year: YEAR, head: 'TRIP', title: 'Science trip to Nehru Science Centre', amountPaise: 120000, mode: 'OPTIONAL',
      classCodes: ['X'], sectionIds: [w.sectionsA.X[0]], dueOn: plus(20), respondBy: plus(14), capacity: 2, refundableUntil: plus(16), inChargeId: w.teacherA.id })).id;
    await charges.approve(w.db, w.principalA, trip);
    expect(await due(x[0], `C:${trip}`, 'TRIP')).toBeUndefined();               // asked, not charged
    expect((await charges.respond(w.db, x[0].parent, trip, x[0].studentId, true)).status).toBe('IN');
    expect((await charges.respond(w.db, x[1].parent, trip, x[1].studentId, false)).status).toBe('DECLINED');
    expect((await charges.respond(w.db, w.teacherA, trip, x[2].studentId, true, 'Paper slip')).status).toBe('IN');   // the teacher in charge records a slip
    expect((await charges.respond(w.db, x[3].parent, trip, x[3].studentId, true)).status).toBe('WAITLIST');
    expect((await due(x[0], `C:${trip}`, 'TRIP'))!.owed_paise).toBe(120000);
    expect(await due(x[1], `C:${trip}`, 'TRIP')).toBeUndefined();
    await rejects(charges.respond(w.db, x[1].parent, trip, x[0].studentId, true), /access|outside/);
    const own = await charges.forStudent(w.db, x[3].parent, x[3].studentId);
    expect(own[0]).toMatchObject({ my_status: 'WAITLIST', seatsLeft: 0, canReply: true });
  });

  it('a child withdrawn before the refund date is not charged; the next on the list gets the place', async () => {
    await pay(x[0], `C:${trip}`);
    const r = await charges.respond(w.db, x[0].parent, trip, x[0].studentId, false);
    expect(r).toMatchObject({ status: 'WITHDRAWN', refunded: true });
    expect((await due(x[3], `C:${trip}`, 'TRIP'))!.owed_paise).toBe(120000);   // moved up
    // ₹1,200 paid, nothing owed now: a credit. With no other dues it waits; the office refunds it on request.
    expect(await refunds.creditsFor(w.db, x[0].studentId)).toMatchObject([{ bill: `C:${trip}`, credit_paise: 120000 }]);
    const req = await refunds.request(w.db, accountant, { enrolmentId: x[0].enrolmentId, bill: `C:${trip}`, reason: 'Parent asked for the money back' });
    await rejects(refunds.pay(w.db, accountant, req.id, { method: 'BANK_TRANSFER', reference: 'UTR123456' }), /waiting for approval/);
    const inbox = await approvals.inbox(w.db, w.principalA);
    await approvals.decide(w.db, w.principalA, inbox.find((i) => i.kind === 'fee_refund')!.id, true);
    expect(await refunds.pay(w.db, accountant, req.id, { method: 'BANK_TRANSFER', reference: 'UTR123456' })).toMatchObject({ status: 'PAID', amountPaise: 120000 });
    expect(await refunds.creditsFor(w.db, x[0].studentId)).toEqual([]);
    await rejects(refunds.request(w.db, accountant, { enrolmentId: x[0].enrolmentId, bill: `C:${trip}`, reason: 'Twice' }), /no credit/);
    await balanced();
  });

  it('shows the teacher in charge who is going and who has paid, but no amounts', async () => {
    const d = await charges.detail(w.db, w.teacherA, trip) as any;
    const row = d.people.find((p: any) => p.studentId === x[2].studentId);
    expect(row).toMatchObject({ status: 'IN', paid: 'UNPAID' });
    expect(row).not.toHaveProperty('owedPaise');
    expect(d).not.toHaveProperty('collectedPaise');
  });

  it('keeps every line consistent with the child’s status', async () => {
    await rejects(w.db.tx((t) => t.query(`update fee_charge_participant set status = 'IN' where charge_id = $1 and enrolment_id = $2`, [trip, x[1].enrolmentId])), /do not match/);
    await rejects(w.db.query(`update fee_charge_participant set status = 'AWAITING' where charge_id = $1 and enrolment_id = $2`, [trip, x[2].enrolmentId]), /cannot go from in to awaiting/);
  });

  it('cancelling the trip reverses every charge and pays back everyone who paid', async () => {
    await pay(x[2], `C:${trip}`);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'fees.credit_use', value: 'REFUND', from: now });
    const r = await charges.cancel(w.db, w.principalA, trip, 'Science Centre closed for repairs');
    expect(r.paidBack).toBe(1);
    expect(await due(x[3], `C:${trip}`, 'TRIP')).toBeUndefined();
    const list = await refunds.list(w.db, accountant, w.schoolA) as { student: string; status: string; amount_paise: number; charge: string }[];
    const auto = list.find((l) => l.status === 'APPROVED')!;
    expect(auto).toMatchObject({ amount_paise: 120000, charge: 'Science trip to Nehru Science Centre' });
    await rejects(charges.respond(w.db, x[1].parent, trip, x[1].studentId, true), /closed/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'fees.credit_use', value: 'ADJUST', from: now });
    await balanced();
  });

  it('uses a credit for the family’s school fees when the school prefers that', async () => {
    const f = await family(w, { classCode: 'X', section: 0, rank: 'N_PO' });
    const ev = (await charges.draft(w.db, accountant, { schoolId: w.schoolA, year: YEAR, head: 'EVENT', title: 'Annual day costume', amountPaise: 50000, mode: 'OPTIONAL',
      classCodes: ['X'], dueOn: plus(10), respondBy: plus(5) })).id;
    await charges.approve(w.db, w.principalA, ev);
    await charges.respond(w.db, f.parent, ev, f.studentId, true);
    await pay(f, `C:${ev}`);
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q3');
    const q3 = (await due(f, 'Q3'))!.owed_paise;
    await charges.respond(w.db, f.parent, ev, f.studentId, false);
    expect((await due(f, 'Q3'))!.owed_paise).toBe(q3 - 50000);                 // ₹500 credit taken off Q3
    expect(await refunds.creditsFor(w.db, f.studentId)).toEqual([]);
    await balanced();
  });
});
