import { beforeAll, describe, expect, it } from 'vitest';
import * as fees from '../src/modules/fees.js';
import * as payments from '../src/modules/payments.js';
import { changeService } from '../src/modules/students.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const balanced = async () => {
  const r = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
  expect(r.d).toBe(r.c);
};

describe('fee demands', () => {
  it('prices from the rate table, fee band and sibling concession, and generates once only', async () => {
    const f1 = await family(w, { rank: 'N_PO' });
    const first = await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    const again = await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    expect(first.created).toBeGreaterThan(0);
    expect(again.created).toBe(0);
    const d = await fees.dues(w.db, f1.studentId);
    const tuition = d.find((x) => x.head_code === 'TUITION')!;
    expect(tuition.owed_paise).toBe(Math.round((10800 * 0.7) / 10) * 10 * 100);   // Class X, POs and below
    expect(d.find((x) => x.head_code === 'ANNUAL')).toBeTruthy();                 // annual charges only in Q1
    await balanced();
  });

  it('never lets a demand be edited or deleted', async () => {
    const d = await w.db.one<{ id: string }>('select id from fee_demand limit 1');
    await rejects(w.db.query('update fee_demand set gross_paise = 1 where id = $1', [d.id]), /permanent/);
    await rejects(w.db.query('delete from fee_demand where id = $1', [d.id]), /permanent/);
  });

  it('applies a retirement to fees from its date, without touching earlier quarters', async () => {
    const f = await family(w, { rank: 'N_LCDR' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    await changeService(w.db, w.admin, f.guardianId, { from: '2026-09-15', service: 'NAVY', status: 'ESM_PENSION', rankCode: 'N_LCDR' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q3');
    const d = await fees.dues(w.db, f.studentId);
    expect(d.filter((x) => x.head_code === 'TUITION').map((x) => x.owed_paise)).toEqual([1080000, 1080000]);  // still Officer band
    await rejects(changeService(w.db, w.admin, f.guardianId, { from: '2026-09-01', service: 'NAVY', status: 'SERVING', rankCode: 'N_LCDR', postedInStation: true }), /must start after/);
  });
});

describe('fee revisions', () => {
  it('needs a second person to approve, previews impact, and adds difference lines', async () => {
    const f = await family(w, { rank: 'N_PO' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q3');
    const draft = await fees.draftRevision(w.db, w.finance, w.planA, {
      effectiveFrom: '2026-10-01', policy: 'FUTURE_ONLY', note: 'Tuition revision',
      changes: [{ classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amountPaise: 900000 }],
    });
    const preview = await fees.previewRevision(w.db, draft.versionId);
    expect(preview.linesToAdd).toBeGreaterThan(0);
    expect(preview.untouchedInstallments).toEqual(['Q1', 'Q2']);
    await rejects(fees.approveRevision(w.db, w.finance, draft.versionId), /someone other than/);
    const before = (await fees.dues(w.db, f.studentId)).find((x) => x.installment_code === 'Q3' && x.head_code === 'TUITION')!;
    await fees.approveRevision(w.db, w.admin, draft.versionId);
    const after = (await fees.dues(w.db, f.studentId)).find((x) => x.installment_code === 'Q3' && x.head_code === 'TUITION')!;
    expect(after.owed_paise - before.owed_paise).toBe(900000 - before.owed_paise);
    await rejects(w.db.query(`update fee_rate set amount_paise = 1 where version_id = $1`, [draft.versionId]), /cannot change/);
    await balanced();
  });
});

describe('payments', () => {
  it('fixes the amount on the server, is idempotent, and records a payment exactly once', async () => {
    const f = await family(w, { rank: 'N_PO' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q1');
    const items = [{ enrolmentId: f.enrolmentId, installment: 'Q1' }];
    const o1 = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: 'key-0001', items }) as { id: string; amount_paise: number; gateway_order_id: string };
    const o2 = await payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: 'key-0001', items }) as { id: string };
    expect(o2.id).toBe(o1.id);

    const ev = { event_id: 'evt-1', type: 'payment.captured', gateway_order_id: o1.gateway_order_id, gateway_payment_id: 'pay-1', amount_paise: o1.amount_paise, method: 'UPI' };
    const body = JSON.stringify(ev);
    await rejects(payments.handleWebhook(w.db, body, 'deadbeef'), /signature/);
    const bad = JSON.stringify({ ...ev, event_id: 'evt-0', amount_paise: 1 });
    await rejects(payments.handleWebhook(w.db, bad, payments.sign(bad)), /does not match/);
    const r1 = await payments.handleWebhook(w.db, body, payments.sign(body));
    const r2 = await payments.handleWebhook(w.db, body, payments.sign(body));
    expect(r1.status).toBe('captured');
    expect(r2.status).toBe('duplicate_ignored');
    const n = await w.db.one<{ n: number }>('select count(*)::int as n from payment where order_id = $1', [o1.id]);
    expect(n.n).toBe(1);
    const due = await fees.dues(w.db, f.studentId);
    expect(due.filter((x) => x.installment_code === 'Q1').every((x) => x.due_paise === 0)).toBe(true);
    await rejects(payments.createOrder(w.db, f.parent, { studentId: f.studentId, method: 'UPI', idempotencyKey: 'key-0002', items }), /Nothing is due/);
    await balanced();
  });

  it("gives the school's fee standing: what is due so far, what is paid, and children behind", async () => {
    const s = await payments.standing(w.db, w.principalA, w.schoolA, YEAR, '2027-03-31');
    expect(Number(s.due)).toBeGreaterThan(0);
    expect(Number(s.paid)).toBeGreaterThan(0);
    expect(Number(s.paid)).toBeLessThanOrEqual(Number(s.due));
    expect(s.overdue_children).toBeGreaterThan(0);
    await rejects(payments.standing(w.db, w.teacherA, w.schoolA, YEAR, '2027-03-31'), /./);
  });

  it('refuses to allocate more than is owed and keeps receipts permanent', async () => {
    const p = await w.db.one<{ id: string }>('select p.id from payment p join payment_allocation a on a.payment_id = p.id limit 1');
    await rejects(w.db.tx((t) => t.query('insert into payment_allocation (payment_id, demand_id, amount_paise) values ($1, (select id from fee_demand d where kind = \'REGULAR\' and not exists (select 1 from payment_allocation x where x.payment_id = $1 and x.demand_id = d.id) limit 1), 99999999)', [p.id])), /exceeds the amount owed/);
    await rejects(w.db.query(`update payment set amount_paise = 1 where id = $1`, [p.id]), /permanent/);
  });

  it('rejects an unbalanced journal at commit', async () => {
    await rejects(w.db.tx(async (t) => {
      const j = await t.one<{ id: string }>(`insert into journal (school_id, narration, source_type, source_id) values ($1, 'bad', 'test', 'x1') returning id`, [w.schoolA]);
      await t.query(`insert into journal_line (journal_id, account_code, debit_paise) values ($1, '1150', 100)`, [j.id]);
      await t.query(`insert into journal_line (journal_id, account_code, credit_paise) values ($1, '1200', 90)`, [j.id]);
    }), /does not balance/);
  });
});
