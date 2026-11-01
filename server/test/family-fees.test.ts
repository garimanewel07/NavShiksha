import { beforeAll, describe, expect, it } from 'vitest';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import * as settings from '../src/modules/settings.js';
import { family, makeWorld, YEAR, type World } from './helpers.js';
import { localToday } from '../src/lib/dates.js';

/**
 * The PTA fee is paid once per family: brothers and sisters (children sharing a parent) are found
 * from the parents, and the fee is billed to the eldest at the school only.
 */

let w: World;
type Fam = Awaited<ReturnType<typeof family>>;
let elder: Fam, younger: { studentId: string; enrolmentId: string }, other: Fam;

/** A brother or sister: a child added to the same parent, as the admission form does. */
async function sibling(f: Fam, dob: string, start = '2026-04-01') {
  const s = await w.db.one<{ id: string }>(`insert into student (name, dob, gender) values ('Younger Child', $1, 'M') returning id`, [dob]);
  await w.db.query(`insert into student_guardian (student_id, guardian_id, relationship, is_primary) values ($1, $2, 'FATHER', true)`, [s.id, f.guardianId]);
  const e = await w.db.one<{ id: string }>(
    `insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
     values ($1, $2, $3, $4, $5, 'VIII', 'A/' || substr(md5(random()::text), 1, 8), 'ACTIVE', daterange($6::date, null), '1', '{}') returning id`, [s.id, w.schoolA, w.campusA, w.sectionsA.VIII[0], YEAR, start]);
  return { studentId: s.id, enrolmentId: e.id };
}
const pta = async (enrolmentId: string) => (await w.db.one<{ n: number }>(`select coalesce(sum(net_paise), 0)::int as n from fee_demand where enrolment_id = $1 and head_code = 'PTA'`, [enrolmentId])).n;

beforeAll(async () => {
  w = await makeWorld();
  await settings.set(w.db, w.principalA, w.schoolA, { key: 'fees.pta_amount', value: 500, from: localToday() });
  elder = await family(w, { classCode: 'X' });                    // born 2013
  younger = await sibling(elder, '2016-03-02');
  other = await family(w, { classCode: 'X' });
});

describe('the PTA fee, once per family', () => {
  it('knows the brothers and sisters from the parents', async () => {
    const f = await fees.family(w.db, younger.studentId);
    expect(f.members.map((m) => m.id).sort()).toEqual([elder.studentId, younger.studentId].sort());
  });

  it('bills it to the eldest only, with the first bill, and to every other family once', async () => {
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    expect(await pta(elder.enrolmentId)).toBe(50000);
    expect(await pta(younger.enrolmentId)).toBe(0);
    expect(await pta(other.enrolmentId)).toBe(50000);
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q2');   // not again in the year
    expect(await pta(elder.enrolmentId)).toBe(50000);
    // A third child of the family who joins later does not pay it.
    const third = await sibling(elder, '2018-01-20', '2026-07-15');
    await w.db.tx((t) => fees.billJoiner(t, third.enrolmentId), { actor: 'test' });
    expect(await pta(third.enrolmentId)).toBe(0);
    const f = await fees.family(w.db, third.studentId);
    expect(f.pta?.billedTo).toMatchObject({ studentId: elder.studentId, amount: 50000, paid: false });
  });

  it('is paid with the eldest’s fees, into the PTA fund (not the school’s income)', async () => {
    const o = await payments.createOrder(w.db, elder.parent, { studentId: elder.studentId, method: 'UPI', idempotencyKey: `pta-${elder.studentId}`, items: [{ enrolmentId: elder.enrolmentId, bill: 'Q1' }] }) as { id: string };
    await payments.sandboxPay(w.db, elder.parent, o.id, 'success');
    expect((await fees.family(w.db, younger.studentId)).pta?.billedTo?.paid).toBe(true);
    const fund = await w.db.one<{ c: number }>(`select coalesce(sum(credit_paise - debit_paise), 0)::int as c from journal_line where account_code = '2320'`);
    expect(fund.c).toBe(2 * 50000);                                 // billed to two families
    const bal = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
    expect(bal.d).toBe(bal.c);
  });
});
