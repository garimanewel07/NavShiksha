import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as staff from '../src/modules/staff.js';
import * as staffLeave from '../src/modules/staffLeave.js';
import * as payroll from '../src/modules/payroll.js';
import * as settings from '../src/modules/settings.js';
import * as timetable from '../src/modules/timetable.js';
import * as accounts from '../src/modules/accounts.js';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import { last4, seal } from '../src/lib/secret.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { addDays, localToday } from '../src/lib/dates.js';

/**
 * Staff and payroll (R4). Each school sets up its own pay: a regular structure on a pay scale,
 * consolidated pay for contract teachers, per-period pay for guest teachers, daily wages for
 * support staff. The accountant prepares, the principal approves; locked months never change.
 */

let w: World;
let acct: Actor, command: Actor, principalB: Actor;
const T = localToday();
const cur = T.slice(0, 8) + '01';
const prev = addDays(cur, -1).slice(0, 8) + '01';
const prevEnd = addDays(cur, -1);
const dim = Number(prevEnd.slice(8, 10));
const FROM = '2026-04-01';

const user = async (name: string, role: string, scope: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3) returning id`, [name, role, scope])).id);
const balanced = async () => {
  const r = await w.db.one<{ d: string; c: string }>('select coalesce(sum(debit_paise), 0)::text as d, coalesce(sum(credit_paise), 0)::text as c from journal_line');
  expect(r.d).toBe(r.c);
};
/** A salary account verified long ago (past the waiting period), as the seed has it. */
const bank = (userId: string, account: string) => w.db.query(
  `insert into employee_bank (user_id, account_last4, account_cipher, ifsc, bank_name, holder_name, status, requested_by, requested_at, verified_by, verified_at)
   select $1, $2, $3, 'SBIN0001234', 'State Bank of India', u.name, 'VERIFIED', $4, '2026-04-01', $5, '2026-04-02' from app_user u where u.id = $1`,
  [userId, last4(account), seal(account), acct.id, w.principalA.id]);
/** Proposed by the accountant, approved by the principal. */
const component = async (structureId: string, c: Partial<staff.ComponentInput> & { code: string; calc: staff.ComponentInput['calc'] }) => {
  const r = await staff.proposeComponent(w.db, acct, structureId, { name: c.code, kind: 'EARNING', taxable: true, pfWage: false, prorate: true, ordinal: 1, from: FROM, ...c });
  return staff.decideComponent(w.db, w.principalA, r.id, true);
};
const runOf = (id: string) => payroll.run(w.db, acct, id) as unknown as Promise<{ status: string; issues: payroll.Issue[]; totals: Record<string, number>;
  slips: { user_id: string; name: string; gross: number; deductions: number; net: number; employer: number; lop_days: number; lines: { code: string; kind: string; amount: number; basis: string; for_month: string | null }[] }[] }>;
const lineOf = async (runId: string, userId: string, code: string) => (await runOf(runId)).slips.find((s) => s.user_id === userId)?.lines.find((l) => l.code === code);

/** New regime as written in the law (for checking the engine's figure independently). */
const newRegimeTax = (income: number) => {
  const slabs = [[0, 0], [400000, 5], [800000, 10], [1200000, 15], [1600000, 20], [2000000, 25], [2400000, 30]];
  let tax = 0;
  slabs.forEach(([from, rate], i) => { const top = slabs[i + 1]?.[0] ?? Infinity; if (income > from) tax += ((Math.min(income, top) - from) * rate) / 100; });
  if (income <= 1200000) tax = Math.max(0, tax - 60000);
  return Math.round(tax * 1.04);
};

let regular: string, contract: string, guest: string, daily: string, scale: string;
let meera: string, rohit: string, gita: string, ramu: string, lal: string;
let prevRun: string;

beforeAll(async () => {
  w = await makeWorld();
  acct = await user('Accountant Alpha', 'ACCOUNTANT', 'nes.wnc.ncs_a');
  command = await user('Command Education Officer', 'COMMAND_OFFICER', 'nes.wnc');
  principalB = await user('Principal Bravo', 'SCHOOL_ADMIN', 'nes.enc.ncs_b');
  await settings.set(w.db, w.principalA, w.schoolA, { key: 'payroll.pt_state', value: 'MH', from: T });
});

describe('each school sets up its own pay', () => {
  it('keeps several structures of its own, each component proposed by one person and approved by another', async () => {
    regular = (await staff.createStructure(w.db, acct, w.schoolA, { name: 'Regular staff', pf: 'CEILING', esi: true, pt: true, tds: true })).id;
    await component(regular, { code: 'BASIC', name: 'Basic pay', calc: 'BASE', pfWage: true, ordinal: 1 });
    // A percentage needs what it is a percentage of, approved first.
    await rejects(staff.proposeComponent(w.db, acct, regular, { code: 'NPA', name: 'Allowance', kind: 'EARNING', calc: 'PERCENT', percent: 10, ofCodes: ['GRADE'], taxable: true, pfWage: false, prorate: true, ordinal: 9, from: FROM }), /no approved GRADE/);
    await component(regular, { code: 'DA', name: 'Dearness allowance', calc: 'PERCENT', percent: 50, ofCodes: ['BASIC'], pfWage: true, ordinal: 2 });
    await component(regular, { code: 'HRA', name: 'House rent allowance', calc: 'PERCENT', percent: 9, ofCodes: ['BASIC'], ordinal: 3 });
    await component(regular, { code: 'TA', name: 'Transport allowance', calc: 'FLAT', amountPaise: 360000, ordinal: 4 });
    // The proposer cannot approve their own change; the accountant cannot approve at all.
    const p = await staff.proposeComponent(w.db, w.principalA, regular, { code: 'WASH', name: 'Washing allowance', kind: 'EARNING', calc: 'FLAT', amountPaise: 10000, taxable: true, pfWage: false, prorate: true, ordinal: 5, from: FROM });
    await rejects(staff.decideComponent(w.db, w.principalA, p.id, true), /someone other/);
    await rejects(staff.decideComponent(w.db, acct, p.id, true), /not part of your role/);
    await staff.decideComponent(w.db, w.principalA, p.id, false).catch(() => null);

    contract = (await staff.createStructure(w.db, acct, w.schoolA, { name: 'Contract teachers', pf: 'NONE', esi: false, pt: true, tds: true })).id;
    await component(contract, { code: 'CONSOLIDATED', name: 'Consolidated pay', calc: 'BASE' });
    guest = (await staff.createStructure(w.db, acct, w.schoolA, { name: 'Guest teachers per period', pf: 'NONE', esi: false, pt: true, tds: true })).id;
    await component(guest, { code: 'PERIODS', name: 'Periods taught', calc: 'PER_UNIT', unit: 'PERIODS', amountPaise: 40000, prorate: false });
    daily = (await staff.createStructure(w.db, acct, w.schoolA, { name: 'Support staff daily wage', pf: 'CEILING', esi: true, pt: true, tds: false })).id;
    await component(daily, { code: 'WAGES', name: 'Daily wages', calc: 'PER_UNIT', unit: 'DAYS_PRESENT', amountPaise: 70000, pfWage: true, prorate: false });

    scale = (await staff.addScale(w.db, acct, w.schoolA, { name: 'Level 7', stepsPaise: [4490000, 4620000, 4760000, 4900000], incrementMonth: 7, from: FROM })).id;
    await rejects(staff.approveScale(w.db, acct, scale), /not part of your role/);
    await staff.approveScale(w.db, w.principalA, scale);
    const s = await staff.structures(w.db, acct, w.schoolA) as unknown as { structures: { name: string; components: { code: string; status: string }[] }[] };
    expect(s.structures.map((x) => x.name)).toEqual(expect.arrayContaining(['Regular staff', 'Contract teachers', 'Guest teachers per period', 'Support staff daily wage']));
    expect(s.structures.find((x) => x.name === 'Regular staff')!.components.filter((c) => c.status === 'APPROVED').map((c) => c.code)).toEqual(['BASIC', 'DA', 'HRA', 'TA']);
  });

  it('takes on permanent, contract, guest and daily-wage staff, each with an NES staff ID', async () => {
    await rejects(staff.enrol(w.db, acct, w.schoolA, { name: 'X Y Z', category: 'TEACHING', employment: 'PERMANENT', joinedService: FROM, orderRef: 'O/1' }), /not part of your role/);
    await rejects(staff.enrol(w.db, w.principalA, w.schoolA, { name: 'Rohit Contract', category: 'TEACHING', employment: 'CONTRACT', joinedService: FROM, orderRef: 'O/2' }), /contract or temporary term ends/);
    const e = (name: string, employment: string, category: 'TEACHING' | 'NON_TEACHING', joinedService: string, extra: Record<string, string> = {}) =>
      staff.enrol(w.db, w.principalA, w.schoolA, { name, category, employment, joinedService, orderRef: `NCS-A/EST/${name}`, gender: 'F', ...extra });
    const m = await e('Meera Iyer', 'PERMANENT', 'TEACHING', '2015-07-01');
    expect(m.nesStaffId).toMatch(/^NES-ST-\d{6}$/);
    meera = m.userId;
    rohit = (await e('Rohit Kulkarni', 'CONTRACT', 'TEACHING', FROM, { contractUntil: '2027-03-31' })).userId;
    gita = (await e('Gita Guest', 'GUEST', 'TEACHING', FROM)).userId;
    ramu = (await e('Ramu Shinde', 'DAILY_WAGE', 'NON_TEACHING', FROM)).userId;
    lal = (await e('Lal Bahadur', 'PERMANENT', 'NON_TEACHING', '2018-06-01')).userId;
    expect((await loadActor(w.db, ramu)).role).toBe('STAFF');

    // Pay comes from this school's own structures only.
    await staff.setPay(w.db, acct, meera, { structureId: regular, from: FROM, scaleId: scale, step: 1, orderRef: 'PF/1' });
    await staff.setPay(w.db, acct, rohit, { structureId: contract, from: FROM, basePaise: 25000000, orderRef: 'PF/2' });
    await staff.setPay(w.db, acct, gita, { structureId: guest, from: FROM, orderRef: 'PF/3' });
    await staff.setPay(w.db, acct, ramu, { structureId: daily, from: FROM, orderRef: 'PF/4' });
    await staff.setPay(w.db, acct, lal, { structureId: regular, from: FROM, basePaise: 3000000, orderRef: 'PF/5' });
    for (const [u, a] of [[meera, '123456789012'], [rohit, '223456789012'], [ramu, '323456789012'], [lal, '423456789012']] as const) await bank(u, a);

    const dir = await staff.directory(w.db, acct, w.schoolA) as unknown as { name: string; employment: string; structure: string }[];
    expect(dir.find((d) => d.name === 'Rohit Kulkarni')).toMatchObject({ employment: 'CONTRACT', structure: 'Contract teachers' });
    const book = await staff.profile(w.db, w.principalA, meera) as unknown as { service: { kind: string }[] };
    expect(book.service.map((x) => x.kind)).toEqual(expect.arrayContaining(['JOINED', 'PAY_FIXED']));
  });

  it('keeps PAN and bank numbers encrypted, and records every time someone sees one in full', async () => {
    const r = await staff.setIdentity(w.db, acct, meera, { pan: 'ABCDE1234F' });
    expect(r.pan).not.toContain('ABCDE');
    const raw = await w.db.one<{ pan_cipher: string; pan_last4: string }>('select pan_cipher, pan_last4 from employee where user_id = $1', [meera]);
    expect(raw.pan_cipher).not.toContain('ABCDE1234F');
    expect(raw.pan_last4).toBe('234F');
    await rejects(staff.revealIdentity(w.db, w.teacherA, meera, 'PAN', 'Form 16'), /not part of your role|outside/);
    expect((await staff.revealIdentity(w.db, acct, meera, 'PAN', 'Form 16 for the year')).value).toBe('ABCDE1234F');
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from pii_view where user_id = $1 and field = 'PAN'`, [meera])).n).toBe(1);
  });

  it('has a bank change verified by a second person, and tells the staff member', async () => {
    const b = await staff.requestBank(w.db, acct, gita, { account: '523456789012', ifsc: 'sbin0001234', bankName: 'State Bank of India', holderName: 'Gita Guest' });
    await rejects(staff.verifyBank(w.db, acct, b.id, true), /someone other/);
    await staff.verifyBank(w.db, w.principalA, b.id, true);
    const n = await w.db.one<{ n: number }>(`select count(*)::int as n from notification where user_id = $1 and kind = 'PAY'`, [gita]);
    expect(n.n).toBeGreaterThanOrEqual(2);
  });
});

describe('a month’s payroll', () => {
  it('works everyone out with the reasons, and refuses submission while a problem remains', async () => {
    // Ramu worked 20 days; Meera was absent one day without leave.
    for (let d = 1; d <= 20; d++) await staffLeave.mark(w.db, w.principalA, w.schoolA, `${prev.slice(0, 8)}${String(d).padStart(2, '0')}`, [{ userId: ramu, status: 'P' }]);
    await staffLeave.mark(w.db, w.principalA, w.schoolA, `${prev.slice(0, 8)}10`, [{ userId: meera, status: 'A' }]);
    await rejects(payroll.createRun(w.db, w.teacherA, w.schoolA, prev), /not part of your role/);
    await rejects(payroll.createRun(w.db, w.admin, w.schoolA, prev), /not part of your role/);     // NES handles no school's money
    const r = await payroll.createRun(w.db, acct, w.schoolA, prev);
    prevRun = r.id;
    await rejects(payroll.createRun(w.db, acct, w.schoolA, prev), /already exists/);
    // No periods are entered for Gita yet, so she has nothing to be paid.
    expect(r.issues.filter((i) => i.level === 'ERROR')).toEqual([]);
    expect(r.issues.some((i) => i.name === 'Gita Guest' && /No periods/.test(i.message))).toBe(true);
  });

  it('pays the guest teacher by the period once the periods are entered', async () => {
    await payroll.setInputs(w.db, acct, w.schoolA, prev, [{ userId: gita, unit: 'PERIODS', quantity: 40 }]);
    // Her new account was verified today: too recent to pay last month's salary into.
    const blocked = await payroll.recompute(w.db, acct, prevRun);
    expect(blocked.issues.filter((i) => i.level === 'ERROR').map((i) => i.name)).toEqual(['Gita Guest']);
    await rejects(payroll.submit(w.db, acct, prevRun), /must be fixed first/);
    await w.db.query(`insert into employee_bank (user_id, account_last4, account_cipher, ifsc, bank_name, holder_name, status, requested_by, requested_at, verified_by, verified_at)
      values ($1, '9012', $2, 'SBIN0001234', 'SBI', 'Gita Guest', 'VERIFIED', $3, '2026-04-01', $4, '2026-04-02')`, [gita, seal('623456789012'), acct.id, w.principalA.id]);
    const again = await payroll.recompute(w.db, acct, prevRun);
    expect(again.issues.filter((i) => i.level === 'ERROR')).toEqual([]);
    const p = await lineOf(prevRun, gita, 'PERIODS');
    expect(p).toMatchObject({ amount: 1600000 });
    expect(p!.basis).toContain('40 periods');
    expect(await lineOf(prevRun, gita, 'PF')).toBeUndefined();                       // the structure says no PF
    expect((await lineOf(prevRun, gita, 'PT'))?.amount).toBe(20000);                 // Maharashtra, above ₹10,000
  });

  it('works out the regular teacher: scale step, DA and HRA on basic, loss of pay, PF on the ceiling', async () => {
    const run = await runOf(prevRun);
    const m = run.slips.find((s) => s.user_id === meera)!;
    const get = (c: string) => m.lines.find((l) => l.code === c)!;
    expect(get('BASIC').amount).toBe(4490000);
    expect(get('DA').amount).toBe(2245000);
    expect(get('HRA').amount).toBe(404100);
    expect(get('TA').amount).toBe(360000);
    const earned = 4490000 + 2245000 + 404100 + 360000;
    expect(get('LOP').amount).toBe(Math.round(earned / dim));
    expect(m.gross).toBe(earned - get('LOP').amount);
    // PF wages (basic + DA) are above the ceiling, so PF is 12% of the ceiling.
    const pf = await w.db.one<{ inputs: { wages: number; base: number } }>(`select inputs from payroll_line where run_id = $1 and user_id = $2 and code = 'PF'`, [prevRun, meera]);
    expect(pf.inputs.base).toBeLessThan(pf.inputs.wages);
    expect(get('PF').amount).toBe(Math.round((pf.inputs.base * 12) / 100 / 100) * 100);
    expect(get('ER_EPS').amount + get('ER_EPF').amount).toBe(get('PF').amount);
    expect(m.lines.find((l) => l.code === 'ESI')).toBeUndefined();                    // above the ESI ceiling
    expect(get('TDS').amount).toBe(0);                                                 // within the rebate
    expect(m.net).toBe(m.gross - m.deductions);
  });

  it('pays daily wages for days present, with PF and ESI', async () => {
    const r = (await runOf(prevRun)).slips.find((s) => s.user_id === ramu)!;
    const get = (c: string) => r.lines.find((l) => l.code === c)!;
    expect(get('WAGES').amount).toBe(1400000);
    expect(get('PF').amount).toBe(168000);
    expect(get('ESI').amount).toBe(10500);
    expect(get('ER_ESI').amount).toBe(45500);
    expect(get('PT').amount).toBe(20000);
    expect(r.lines.find((l) => l.code === 'TDS')).toBeUndefined();
  });

  it('deducts income tax on the year’s projected pay for a well-paid contract teacher', async () => {
    const t = await w.db.one<{ amount: number; inputs: { projected: number; annual: number; monthsLeft: number } }>(
      `select amount_paise::int as amount, inputs from payroll_line where run_id = $1 and user_id = $2 and code = 'TDS'`, [prevRun, rohit]);
    const months = t.inputs.monthsLeft + 1;
    expect(t.inputs.projected).toBe(25000000 * months - 7500000);
    expect(t.inputs.annual).toBe(newRegimeTax(t.inputs.projected / 100) * 100);
    expect(t.amount).toBe(Math.round(t.inputs.annual / months / 100) * 100);
    expect(t.amount).toBeGreaterThan(0);
    expect(await lineOf(prevRun, rohit, 'PF')).toBeUndefined();
  });

  it('goes to the principal, who may send it back; approval locks it and posts a balanced journal', async () => {
    await payroll.submit(w.db, acct, prevRun);
    await rejects(payroll.approve(w.db, acct, prevRun), /not part of your role/);
    await payroll.sendBack(w.db, w.principalA, prevRun, 'Check Gita’s periods');
    expect((await runOf(prevRun)).status).toBe('DRAFT');
    await payroll.submit(w.db, acct, prevRun);
    await rejects(payroll.approve(w.db, principalB, prevRun), /outside your access/);
    const a = await payroll.approve(w.db, w.principalA, prevRun);
    expect(a.status).toBe('LOCKED');
    await balanced();
    const j = await w.db.one<{ d5300: number; c2500: number }>(
      `select coalesce(sum(l.debit_paise) filter (where l.account_code = '5300'), 0)::float as d5300, coalesce(sum(l.credit_paise) filter (where l.account_code = '2500'), 0)::float as c2500
         from journal_line l join journal j on j.id = l.journal_id where j.source_type = 'payroll_run' and j.source_id = $1`, [prevRun]);
    const run = await runOf(prevRun);
    expect(j.c2500).toBe(run.totals.net);
    expect(j.d5300).toBe(run.totals.gross);
    // Locked means locked: lines, slips, attendance and inputs for the month.
    await rejects(w.db.query(`update payroll_line set amount_paise = amount_paise + 100 where run_id = $1`, [prevRun]), /cannot change/);
    await rejects(w.db.query(`delete from payroll_run where id = $1`, [prevRun]), /only a draft/);
    await rejects(staffLeave.mark(w.db, w.principalA, w.schoolA, `${prev.slice(0, 8)}11`, [{ userId: meera, status: 'P' }]), /locked/);
    await rejects(payroll.setInputs(w.db, acct, w.schoolA, prev, [{ userId: gita, unit: 'PERIODS', quantity: 50 }]), /past draft/);
    const told = await w.db.one<{ n: number }>(`select count(*)::int as n from notification where user_id = $1 and title like 'Payslip:%'`, [meera]);
    expect(told.n).toBe(1);
  });

  it('makes the bank file from decrypted accounts, recording each, and then records the payment', async () => {
    const before = (await w.db.one<{ n: number }>(`select count(*)::int as n from pii_view where field = 'BANK_ACCOUNT'`)).n;
    const f = await payroll.bankFile(w.db, acct, prevRun);
    expect(f.csv).toContain('123456789012');
    expect(f.csv).toContain('SBIN0001234');
    expect(f.count).toBe(5);
    expect(Math.round(f.total)).toBe((await runOf(prevRun)).totals.net);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from pii_view where field = 'BANK_ACCOUNT'`)).n).toBe(before + 5);
    expect((await w.db.one<{ sha: string }>('select bank_file_sha as sha from payroll_run where id = $1', [prevRun])).sha).toBe(f.sha);
    await rejects(payroll.markPaid(w.db, acct, prevRun, 'x'), /reference/);
    await payroll.markPaid(w.db, acct, prevRun, 'UTR2026001234');
    expect((await runOf(prevRun)).status).toBe('PAID');
    await balanced();
  });

  it('gives payslips: to the person in the app, and all of them as one PDF for the office', async () => {
    const me = await loadActor(w.db, meera);
    const mine = await payroll.myPay(w.db, me) as unknown as { slips: { run_id: string; net: number }[]; ytd: { pf: number } };
    expect(mine.slips.map((s) => s.run_id)).toEqual([prevRun]);
    expect(mine.ytd.pf).toBeGreaterThan(0);
    await rejects(payroll.slip(w.db, me, prevRun, rohit), /not part of your role|outside/);
    const one = await PDFDocument.load(await payroll.slipPdf(w.db, me, prevRun, meera));
    expect(one.getPageCount()).toBe(1);
    const all = await PDFDocument.load(await payroll.slipsPdf(w.db, acct, prevRun));
    expect(all.getPageCount()).toBe(3);                                               // five payslips, two to a sheet
    const st = await payroll.statutorySummary(w.db, acct, prevRun) as unknown as { totals: Record<string, number> };
    expect(st.totals.ESI).toBe(10500);
    const ecr = await payroll.pfEcr(w.db, acct, prevRun);
    expect(ecr.members).toBe(3);                                                       // Meera, Ramu, Lal
    expect(ecr.missingUan).toHaveLength(3);
    await payroll.recordChallan(w.db, acct, w.schoolA, { kind: 'ESI', period: prev, amountPaise: st.totals.ESI + st.totals.ER_ESI, reference: 'ESIC-CH-001', paidOn: T });
    await balanced();
  });
});

describe('changes after a month is locked', () => {
  let arrearsRun: string;
  it('pays arrears for a back-dated DA rise in a supplementary run, month by month', async () => {
    const p = await staff.proposeComponent(w.db, acct, regular, { code: 'DA', name: 'Dearness allowance', kind: 'EARNING', calc: 'PERCENT', percent: 55, ofCodes: ['BASIC'], taxable: true, pfWage: true, prorate: true, ordinal: 2, from: prev });
    const d = await staff.decideComponent(w.db, w.principalA, p.id, true);
    expect(d.arrearsFrom).toBe(prev);
    const a = await payroll.arrears(w.db, acct, w.schoolA, prev);
    arrearsRun = a.id;
    expect(a.months).toEqual([prev]);
    const da = await lineOf(arrearsRun, meera, 'DA');
    expect(da).toMatchObject({ amount: 224500, for_month: prev });
    expect(da!.basis).toContain('paid');
    expect(await lineOf(arrearsRun, ramu, 'DA')).toBeUndefined();                    // no DA on daily wages
    await payroll.submit(w.db, acct, arrearsRun);
    await payroll.approve(w.db, w.principalA, arrearsRun);
    await balanced();
  });

  it('recovers a festival advance in instalments, sanctioned by someone other than who entered it', async () => {
    const l = await staff.proposeLoan(w.db, acct, meera, { kind: 'FESTIVAL', principalPaise: 1000000, instalmentPaise: 250000, firstMonth: cur });
    await rejects(staff.decideLoan(w.db, acct, l.id, true), /not part of your role/);
    await staff.decideLoan(w.db, w.principalA, l.id, true);
    const ll = await staff.proposeLoan(w.db, acct, lal, { kind: 'SALARY_ADVANCE', principalPaise: 500000, instalmentPaise: 100000, firstMonth: cur });
    await staff.decideLoan(w.db, w.principalA, ll.id, true);
  });

  it('settles a leaver: pay to the last day, gratuity after five years, earned leave, and the whole advance', async () => {
    await w.db.query(`insert into staff_leave_ledger (user_id, leave_code, on_date, days, reason, entered_by) values ($1, 'EL', '2026-01-01', 120, 'Balance brought forward', $2)`, [lal, w.principalA.id]);
    await rejects(payroll.finalSettlement(w.db, acct, lal), /has left first/);
    const last = addDays(cur, 4);
    await staff.addEvent(w.db, w.principalA, lal, { kind: 'SEPARATION', onDate: last, summary: 'Retired on superannuation', orderRef: 'NCS-A/EST/RET/1', reason: 'Retired' });
    // This year's earned leave was credited when Lal was put on the staff record, on top of the balance brought forward.
    const el = (await staffLeave.balances(w.db, lal)).find((b) => b.code === 'EL')!.balance;
    expect(el).toBeGreaterThan(120);
    const f = await payroll.finalSettlement(w.db, acct, lal);
    const get = (c: string) => lineOf(f.id, lal, c);
    // Basic ₹30,000 + DA 55% = ₹46,500; 8 years (8 years 4 months) of service.
    expect((await get('GRATUITY'))?.amount).toBe(Math.round((4650000 * 15 * 8) / 26));
    expect((await get('LEAVE_ENCASH'))?.amount).toBe(Math.round((4650000 * el) / 30));
    expect((await get('LOAN'))?.amount).toBe(500000);
    expect((await get('BASIC'))?.amount).toBe(Math.round((3000000 * 5) / Number(addDays(addDays(cur, 32).slice(0, 8) + '01', -1).slice(8, 10))));
    await rejects(payroll.finalSettlement(w.db, acct, lal), /already exists/);
    await payroll.submit(w.db, acct, f.id);
    await payroll.approve(w.db, w.principalA, f.id);
    await balanced();
  });

  it('this month: the new DA, the advance instalment, and no one who has left', async () => {
    const r = await payroll.createRun(w.db, acct, w.schoolA, cur);
    const run = await runOf(r.id);
    expect(run.slips.map((s) => s.name).sort()).toEqual(['Gita Guest', 'Meera Iyer', 'Ramu Shinde', 'Rohit Kulkarni']);
    expect((await lineOf(r.id, meera, 'DA'))?.amount).toBe(Math.round(4490000 * 0.55));
    expect((await lineOf(r.id, meera, 'LOAN'))?.amount).toBe(250000);
    // Payslips are not shown to staff before approval.
    await rejects(payroll.slip(w.db, await loadActor(w.db, meera), r.id, meera), /once the payroll is approved/);
    // A draft can be discarded and made again.
    await payroll.discard(w.db, acct, r.id);
    await payroll.createRun(w.db, acct, w.schoolA, cur);
  });
});

describe('staff leave', () => {
  it('credits the year, and the principal sanctions leave that comes off the balance', async () => {
    await staffLeave.creditYear(w.db, w.principalA, w.schoolA, Number(T.slice(0, 4)));
    const me = await loadActor(w.db, meera);
    const before = (await staffLeave.balances(w.db, meera)).find((b) => b.code === 'EL')!.balance;
    const day = addDays(T, 30);
    const r = await staffLeave.apply(w.db, me, { leaveCode: 'EL', from: day, to: addDays(day, 1), reason: 'Family function' }) as { id: string };
    await rejects(staffLeave.decide(w.db, acct, r.id, true), /not part of your role|sanctioned by the principal/);
    await staffLeave.decide(w.db, w.principalA, r.id, true);
    expect((await staffLeave.balances(w.db, meera)).find((b) => b.code === 'EL')!.balance).toBe(before - 2);
    await rejects(staffLeave.apply(w.db, me, { leaveCode: 'EL', from: day, to: day, reason: 'Again' }), /already leave/);
  });
});

describe('who sees pay', () => {
  it('keeps salaries from teachers and other schools, and gives NES and the Command the picture across schools', async () => {
    await rejects(payroll.runs(w.db, w.teacherA, w.schoolA), /not part of your role/);
    await rejects(payroll.runs(w.db, principalB, w.schoolA), /outside your access/);
    await rejects(payroll.overview(w.db, acct), /not part of your role/);
    const o = await payroll.overview(w.db, command) as unknown as { school: string; staff: number; by_employment: Record<string, number>; last_run: { status: string } | null; salary_cost_fy: number }[];
    const a = o.find((x) => x.school === 'NCS Alpha')!;
    expect(a.staff).toBe(4);
    expect(a.by_employment).toMatchObject({ PERMANENT: 1, CONTRACT: 1, GUEST: 1, DAILY_WAGE: 1 });
    expect(a.salary_cost_fy).toBeGreaterThan(0);
    expect(o.some((x) => x.school === 'NCS Bravo')).toBe(false);                     // another Command's school
    const nes = await payroll.overview(w.db, w.admin) as unknown as { school: string }[];
    expect(nes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a teacher is entered once, and every module follows', () => {
  it('one form gives the sign-in, post, classes taught, class, pay, bank, leave, chat and ID card; leaving hands it all back', async () => {
    const X = w.sectionsA.X;
    // A timetable in force with Science lessons that have no teacher yet.
    await timetable.publish(w.db, w.principalA, X[0], '2026-04-01', [1, 2, 3, 4, 5].map((d) => ({ weekday: d, period: 4, subjectCode: 'SCI' })));
    await staff.addPost(w.db, w.principalA, w.schoolA, { postType: 'TGT', subjectCode: 'SCI', payLevel: 7, from: FROM, orderRef: 'NES/EST/1' });
    const post = (await staff.posts(w.db, w.principalA, w.schoolA) as unknown as { id: string; post_type: string; holder: string | null }[]).find((p) => p.post_type === 'TGT' && !p.holder)!;
    const r = await staff.enrol(w.db, w.principalA, w.schoolA, {
      name: 'Anita Deshpande', category: 'TEACHING', employment: 'PERMANENT', gender: 'F', joinedService: FROM, orderRef: 'NCS-A/EST/77',
      phone: '98201 55443', email: 'anita@example.in', dob: '1990-02-14', bloodGroup: 'B+', emergencyContact: 'Husband, 98201 55444',
      postId: post.id, teaches: [{ sectionId: X[0], subjectCode: 'SCI', periodsPerWeek: 6 }], classTeacherOf: { sectionId: X[1], kind: 'CLASS' },
      pay: { structureId: regular, scaleId: scale, step: 2 }, bank: { account: '723456789012', ifsc: 'SBIN0001234', bankName: 'State Bank of India' },
      identity: { pan: 'AAAPD1234K', uan: '100200300400' },
    });
    const id = r.userId;
    const me = await loadActor(w.db, id);
    expect(me.role).toBe('TEACHER');
    expect(me.designation).toBe('TGT Science, class teacher X-B');                     // worked out, never typed
    expect((await w.db.one<{ phone: string }>('select phone from app_user where id = $1', [id])).phone).toBe('+919820155443');
    // The timetable's empty Science lessons are hers; her marks sheets and cover follow the timetable.
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from timetable_slot where teacher_id = $1`, [id])).n).toBe(5);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from teaching_load where teacher_id = $1`, [id])).n).toBe(1);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from employee_pay where user_id = $1`, [id])).n).toBe(1);
    expect((await w.db.one<{ status: string }>(`select status from employee_bank where user_id = $1`, [id])).status).toBe('PENDING');   // a second person verifies
    expect((await staffLeave.balances(w.db, id)).find((b) => b.code === 'CL')!.balance).toBeGreaterThan(0);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from chat_member m join chat_conversation c on c.id = m.conversation_id where m.user_id = $1 and c.auto = 'SCHOOL_STAFF'`, [id])).n).toBe(1);
    // The ID card reads the same record.
    const card = (await w.db.one<{ blood_group: string; employee_no: string; joined_on: string }>(`select blood_group, employee_no, joined_on::text from staff_profile where user_id = $1`, [id]));
    expect(card).toMatchObject({ blood_group: 'B+', employee_no: r.nesStaffId, joined_on: FROM });
    expect(r.missing).toEqual(['Photo (for the ID card)']);
    // A correction made once shows everywhere.
    await staff.updateDetails(w.db, w.principalA, id, { bloodGroup: 'O+' });
    expect((await w.db.one<{ b: string }>('select blood_group as b from staff_profile where user_id = $1', [id])).b).toBe('O+');

    // She leaves: the class, the classes taught and the duties are handed back; her sign-in keeps only her payslips.
    const ev = await staff.addEvent(w.db, w.principalA, id, { kind: 'SEPARATION', onDate: addDays(T, -1), summary: 'Resigned', orderRef: 'NCS-A/EST/78', reason: 'Resigned' });
    expect(ev.handedOver).toMatchObject({ classTeacher: 1, classesTaught: 1, weeklyLessons: 5 });
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from teaching_load where teacher_id = $1`, [id])).n).toBe(0);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from teacher_absence where teacher_id = $1 and withdrawn_at is null`, [id])).n).toBe(1);   // lessons covered until re-published
    const after = await loadActor(w.db, id);
    expect(after.role).toBe('STAFF');
    await rejects(staffLeave.mark(w.db, after, w.schoolA, T, []), /not part of your role/);
  });
});

describe('the books: bank reconciliation, reports, Form 16 and the TDS return', () => {
  it('matches the bank statement to entries already in the books, and posts only what the bank alone shows', async () => {
    // An online fee payment waiting in the gateway's clearing account.
    const f = await family(w, { classCode: 'VIII' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    const o = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `acct-${f.studentId}`, items: [{ enrolmentId: f.enrolmentId, bill: 'Q1' }] }) as { id: string };
    await payments.sandboxPay(w.db, f.parent, o.id, 'success');
    const clearing = (await w.db.one<{ b: number }>(`select sum(l.debit_paise - l.credit_paise)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = '1150'`, [w.schoolA])).b;
    expect(clearing).toBeGreaterThan(0);
    const open = await w.db.query<{ narration: string; amount: number }>(
      `select j.narration, sum(l.debit_paise - l.credit_paise)::float as amount from journal j join journal_line l on l.journal_id = j.id and l.account_code = '1100' where j.school_id = $1 group by j.id order by j.created_at`, [w.schoolA]);
    expect(open.length).toBeGreaterThanOrEqual(2);                   // salaries paid to the bank, the ESI challan
    const d = T.split('-').reverse().join('/');
    let bal = 0;
    const row = (narr: string, ref: string, amt: number) => { bal += amt; return `${d},"${narr}",${ref},${amt < 0 ? (-amt / 100).toFixed(2) : ''},${amt > 0 ? (amt / 100).toFixed(2) : ''},${(bal / 100).toFixed(2)}`; };
    const ref = (n: string) => /\(([A-Z0-9/-]{6,})\)/.exec(n)?.[1] ?? '';
    const csv = ['Txn Date,Narration,Ref No./Cheque No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      row('BY TRANSFER FROM SCHOOL FUND A/C', 'OPEN0001', 500000000),
      ...open.map((j) => row(`NEFT ${ref(j.narration)} ${j.narration.slice(0, 20)}`, ref(j.narration), j.amount)),
      row('RAZORPAY SETTLEMENT RZP8812', 'RZP8812', clearing - 1000),
      row('SMS ALERT CHGS INCL GST', '', -5900),
      row('INT.PD 01-07 TO 30-09', '', 123400)].join('\n');
    await rejects(accounts.importStatement(w.db, w.teacherA, w.schoolA, { bankLabel: 'SBI Colaba', csv }), /not part of your role/);
    const imp = await accounts.importStatement(w.db, acct, w.schoolA, { bankLabel: 'SBI Colaba', csv });
    expect(imp.lines).toBe(open.length + 4);
    expect(imp.matched).toBe(open.length);                            // every entry already in the books, matched by itself
    await rejects(accounts.importStatement(w.db, acct, w.schoolA, { bankLabel: 'SBI Colaba', csv }), /already imported/);
    const left = await accounts.bankLines(w.db, acct, w.schoolA) as unknown as { lines: { id: string; narration: string; looksLike: string | null }[] };
    expect(left.lines.map((l) => l.looksLike).sort()).toEqual(['CHARGES', 'GATEWAY', 'INTEREST', null].sort());
    const by = (re: RegExp) => left.lines.find((l) => re.test(l.narration))!.id;
    await accounts.postLine(w.db, acct, by(/RAZORPAY/), { kind: 'GATEWAY', chargesPaise: 1000 });
    await accounts.postLine(w.db, acct, by(/SMS/), { kind: 'CHARGES' });
    await accounts.postLine(w.db, acct, by(/INT\.PD/), { kind: 'INTEREST' });
    await rejects(accounts.ignoreLine(w.db, acct, by(/SCHOOL FUND/), 'x'), /say why/i);
    await accounts.ignoreLine(w.db, acct, by(/SCHOOL FUND/), 'Opening balance from before NavShiksha');
    expect((await w.db.one<{ b: number }>(`select sum(l.debit_paise - l.credit_paise)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = '1150'`, [w.schoolA])).b).toBe(0);
    await balanced();
    // The reconciliation explains the bank's balance exactly: the books, plus the opening balance set aside.
    const r = await accounts.reconciliation(w.db, acct, w.schoolA, T);
    expect(r.bankBalance).toBe(bal);
    expect(Math.round(r.bankBalance! - r.bookBalance)).toBe(500000000);
    expect(r.unpresented).toEqual([]);
  });

  it('gives income and expenditure and a balanced balance sheet, for the school and added up for NES', async () => {
    const ie = await accounts.incomeExpenditure(w.db, acct, w.schoolA, '2026-04-01', T);
    expect(ie.income.map((a) => a.code)).toContain('4900');
    expect(ie.expenditure.map((a) => a.code)).toEqual(expect.arrayContaining(['5300', '5900']));
    expect(Math.round(ie.surplus)).toBe(Math.round(ie.totalIncome - ie.totalExpenditure));
    const bs = await accounts.balanceSheet(w.db, acct, w.schoolA, T);
    expect(bs.balanced).toBe(true);
    const nes = await accounts.balanceSheet(w.db, w.admin, (await w.db.one<{ id: string }>(`select id from org_unit where kind = 'society'`)).id, T);
    expect(nes.balanced).toBe(true);
    expect(nes.schools.length).toBe(2);
    await rejects(accounts.incomeExpenditure(w.db, w.teacherA, w.schoolA, '2026-04-01', T), /not part of your role/);
    const book = await accounts.accountBook(w.db, acct, w.schoolA, '1100', '2026-04-01', T);
    expect(book.closing).toBe(Math.round(book.lines.reduce((s, l) => s + l.debit - l.credit, book.opening)));
  });

  it('makes Form 16 Part B and the quarterly TDS return from the locked payrolls', async () => {
    const fy = payroll.fyOf(prev).code;
    const a = await payroll.annualTax(w.db, acct, meera, fy);
    const paid = await w.db.one<{ tds: number }>(`select coalesce(sum(l.amount_paise), 0)::float as tds from payroll_line l join payroll_run r on r.id = l.run_id where l.user_id = $1 and l.code = 'TDS' and r.status in ('LOCKED', 'PAID')`, [meera]);
    expect(a.tdsDeducted).toBe(paid.tds);
    expect(a.gross).toBeGreaterThan(0);
    expect(a.quarters.reduce((s, q) => s + q.tds, 0)).toBe(a.tdsDeducted);
    await rejects(payroll.annualTax(w.db, w.teacherA, meera, fy), /not part of your role/);
    expect((await PDFDocument.load(await payroll.form16Pdf(w.db, await loadActor(w.db, meera), meera, fy))).getPageCount()).toBe(1);
    const q = (['Q1', 'Q2', 'Q3', 'Q4'] as const)[[4, 7, 10, 1].indexOf([4, 7, 10, 1].find((m, i) => { const mm = Number(prev.slice(5, 7)); return mm >= m && mm <= [6, 9, 12, 3][i]; })!)];
    const before = (await w.db.one<{ n: number }>(`select count(*)::int as n from pii_view where field = 'PAN'`)).n;
    const ret = await payroll.tdsReturn(w.db, acct, w.schoolA, fy, q);
    expect(ret.csv).toContain('ABCDE1234F');
    expect(ret.csv).toContain(',192');
    expect(ret.tanMissing).toBe(true);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from pii_view where field = 'PAN'`)).n).toBe(before + ret.deductees);
  });
});
