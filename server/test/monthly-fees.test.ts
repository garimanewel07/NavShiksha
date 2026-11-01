import { beforeAll, describe, expect, it } from 'vitest';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import * as settings from '../src/modules/settings.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { localToday } from '../src/lib/dates.js';

/**
 * Monthly fees: a school may bill by the month instead of the quarter (for any months not billed
 * yet), and in a quarterly school a parent may pay a quarter in monthly parts.
 */

let w: World;
type Fam = Awaited<ReturnType<typeof family>>;
let f: Fam;
const lines = async (enrolmentId: string, bill: string) =>
  w.db.query<{ head_code: string; gross: number }>(`select head_code, gross_paise::int as gross from fee_demand where enrolment_id = $1 and bill = $2 and kind = 'REGULAR' order by head_code`, [enrolmentId, bill]);
const due = async (enrolmentId: string, bill: string) =>
  (await w.db.one<{ d: number }>(`select coalesce(sum(owed_paise - paid_paise), 0)::int as d from fee_due where enrolment_id = $1 and bill = $2`, [enrolmentId, bill])).d;

beforeAll(async () => {
  w = await makeWorld();
  f = await family(w, { classCode: 'X' });
});

describe('billing by the month', () => {
  it('turns the year into twelve monthly bills: a third of the quarter each, annual charges on the first', async () => {
    await rejects(fees.setSchedule(w.db, w.teacherA, w.schoolA, YEAR, 'MONTHLY'), /./);
    const r = await fees.setSchedule(w.db, w.principalA, w.schoolA, YEAR, 'MONTHLY');
    expect(r.installments.map((i) => i.code)).toEqual(['M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M01', 'M02', 'M03']);
    expect(r.installments[0]).toMatchObject({ label: 'April 2026', due: '2026-04-10' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'M04');
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'M05');
    const quarterly = await w.db.one<{ amount: number }>(
      `select r.amount_paise::int as amount from fee_rate r join fee_plan_version v on v.id = r.version_id join fee_plan p on p.id = v.plan_id
        where p.school_id = $1 and r.head_code = 'TUITION' and r.class_band = 'SECONDARY' and r.fee_band = (select fee_band from fee_demand where enrolment_id = $2 limit 1)`, [w.schoolA, f.enrolmentId]);
    const apr = await lines(f.enrolmentId, 'M04'), may = await lines(f.enrolmentId, 'M05');
    expect(apr.find((l) => l.head_code === 'TUITION')!.gross).toBe(Math.round(quarterly.amount / 3 / 100) * 100);
    expect(apr.some((l) => l.head_code === 'ANNUAL')).toBe(true);           // annual charges on the year's first bill
    expect(may.some((l) => l.head_code === 'ANNUAL')).toBe(false);
  });

  it('can go back to quarters for the months not billed yet; billed months stay', async () => {
    const r = await fees.setSchedule(w.db, w.principalA, w.schoolA, YEAR, 'QUARTERLY');
    // June finishes the quarter month by month; quarters from July.
    expect(r.installments.map((i) => i.code)).toEqual(['M06', 'Q2', 'Q3', 'Q4']);
    expect((await fees.installments(w.db, (await w.db.one<{ id: string }>('select id from fee_plan where school_id = $1', [w.schoolA])).id)).map((i) => i.code)).toEqual(['M04', 'M05', 'M06', 'Q2', 'Q3', 'Q4']);
  });
});

describe('paying a quarter in monthly parts', () => {
  it('takes part of a bill, to the fee heads in their usual order, when the school allows it', async () => {
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q2');
    const full = await due(f.enrolmentId, 'Q2');
    const part = Math.ceil(full / 3 / 100) * 100;
    const o = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `part-1-${f.studentId}`, items: [{ enrolmentId: f.enrolmentId, bill: 'Q2', amountPaise: part }] }) as { id: string; amount_paise: number };
    expect(o.amount_paise).toBe(part);
    await payments.sandboxPay(w.db, f.parent, o.id, 'success');
    expect(await due(f.enrolmentId, 'Q2')).toBe(full - part);
    await rejects(payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `part-small-${f.studentId}`, items: [{ enrolmentId: f.enrolmentId, bill: 'Q2', amountPaise: 5000 }] }), /at least ₹100/);
    // A school that takes each bill in full.
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'fees.monthly_parts', value: false, from: localToday() });
    await rejects(payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: `part-2-${f.studentId}`, items: [{ enrolmentId: f.enrolmentId, bill: 'Q2', amountPaise: part }] }), /in full/);
    expect((await fees.payOptions(w.db, f.studentId)).monthlyParts).toBe(false);
    const bal = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
    expect(bal.d).toBe(bal.c);
  });
});
