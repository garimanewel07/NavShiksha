import { beforeAll, describe, expect, it } from 'vitest';
import * as fees from '../src/modules/fees.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';

/** A family pays the whole year at once: the rest of the year is billed early, priced as it would be later. */

let w: World;
let kid: Awaited<ReturnType<typeof family>>;

beforeAll(async () => {
  w = await makeWorld();
  kid = await family(w, { classCode: 'X' });
  await fees.generateDemands(w.db, w.principalA, w.schoolA, YEAR, 'Q1');
});

describe('paying the whole year', () => {
  it('offers the unbilled quarters with their price, bills them on request, and is not billed twice later', async () => {
    const before = await fees.payOptions(w.db, kid.studentId);
    expect(before.wholeYear?.installments.map((i) => i.code)).toEqual(['Q2', 'Q3', 'Q4']);
    expect(before.wholeYear!.totalPaise).toBeGreaterThan(0);
    const r = await fees.billRestOfYear(w.db, kid.parent, kid.studentId);
    expect(r.billed).toHaveLength(3);
    const dues = await fees.dues(w.db, kid.studentId) as { installment_code?: string; bill?: string; due_paise: number }[];
    const billed = new Set(dues.map((d) => d.bill ?? d.installment_code));
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) expect(billed.has(q)).toBe(true);
    expect((await fees.payOptions(w.db, kid.studentId)).wholeYear).toBeNull();
    await rejects(fees.billRestOfYear(w.db, kid.parent, kid.studentId), /already billed/);
    const later = await fees.generateDemands(w.db, w.principalA, w.schoolA, YEAR, 'Q2');
    expect(later.created).toBe(0);                                         // this child's Q2 was billed already
  });
});

describe('paying the whole year when the school bills by the month', () => {
  it('offers every month not yet billed, and bills them all together', async () => {
    const w2 = await makeWorld();
    const k = await family(w2, { classCode: 'X' });
    await fees.generateDemands(w2.db, w2.principalA, w2.schoolA, YEAR, 'Q1');
    await fees.setSchedule(w2.db, w2.principalA, w2.schoolA, YEAR, 'MONTHLY');
    const o = await fees.payOptions(w2.db, k.studentId);
    const codes = o.wholeYear!.installments.map((i) => i.code);
    expect(codes).toEqual(['M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M01', 'M02', 'M03']);   // July to March, nine months
    await fees.billRestOfYear(w2.db, k.parent, k.studentId);
    const dues = await fees.dues(w2.db, k.studentId) as { bill?: string; installment_code?: string; due_paise: number }[];
    const due = dues.reduce((t, d) => t + d.due_paise, 0);
    expect(new Set(dues.map((d) => d.bill ?? d.installment_code)).size).toBe(10);           // Q1 and the nine months, all payable now
    expect(due).toBeGreaterThan(o.wholeYear!.totalPaise);                                    // Q1 (billed earlier) is still due too
  });
});
