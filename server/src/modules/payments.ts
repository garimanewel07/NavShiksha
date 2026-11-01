import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { AppError, conflict, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import * as settings from './settings.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, assertStudentAccess } from './access.js';
import { post } from './ledger.js';

/**
 * Gateway charges per method, in basis points. Kept as data so NES can change who bears them.
 * UPI and RuPay debit carry no merchant charge at bank gateways.
 */
export const CHARGES_BPS: Record<string, number> = { UPI: 0, DEBIT_CARD: 0, NET_BANKING: 0, CREDIT_CARD: 150, CASH: 0, CHEQUE: 0 };

const SECRET = () => {
  const s = process.env.NES_GATEWAY_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('NES_GATEWAY_SECRET must be set in production.');
  return 'sandbox-secret-change-me';
};

export const sign = (body: string) => createHmac('sha256', SECRET()).update(body).digest('hex');

function verifySignature(body: string, signature: string | undefined) {
  if (!signature) return false;
  const a = Buffer.from(sign(body), 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Creates a payment order. The amount is worked out here from what is actually due, never
 * taken from the browser. The same idempotency key always returns the same order, so a
 * double-tap on "Pay" cannot create two orders.
 */
export async function createOrder(db: Db, actor: Actor, input: { studentId: string; items: { enrolmentId: string; bill?: string; installment?: string; amountPaise?: number }[]; method: string; idempotencyKey: string }) {
  await assertStudentAccess(db, actor, input.studentId, 'fees');
  // Staff take payments only at the fee counter; teachers never handle fees.
  if (actor.role !== 'PARENT') {
    const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 order by lower(period) desc limit 1`, [input.studentId]);
    await assertCan(db, actor, 'payments.collect', e?.school_id);
  }
  if (!(input.method in CHARGES_BPS)) throw invalid('Unknown payment method.');
  const existing = await db.maybeOne('select id, gateway_order_id, amount_paise::int, charge_paise::int, status from payment_order where idempotency_key = $1', [input.idempotencyKey]);
  if (existing) return existing;
  return db.tx(async (t) => {
    const lines: { demand_id: string; amount_paise: number; school_id: string }[] = [];
    for (const it of input.items) {
      // A bill is an instalment (Q1…Q4), arrears from a fee revision, or an additional charge.
      const bill = it.bill ?? it.installment;
      const rows = await t.query<{ head_code: string; due: number; school_id: string; student_id: string }>(
        `select d.head_code, (d.owed_paise - d.paid_paise)::int as due, e.school_id, e.student_id
           from fee_due d join enrolment e on e.id = d.enrolment_id join fee_head h on h.code = d.head_code
          where d.enrolment_id = $1 and d.bill = $2 order by h.alloc_priority`, [it.enrolmentId, bill]);
      if (!rows.length) throw notFound('Bill');
      if (rows[0].student_id !== input.studentId) throw invalid('That instalment belongs to a different student.');
      // Part of a bill (a quarter paid month by month): the amount goes to the heads in their usual order.
      const full = rows.filter((x) => x.due > 0).reduce((s, x) => s + x.due, 0);
      let left = it.amountPaise ?? full;
      if (it.amountPaise !== undefined && it.amountPaise < full) {
        if (!(await settings.get<boolean>(t, rows[0].school_id, 'fees.monthly_parts'))) throw invalid('This school takes each bill in full.');
        if (it.amountPaise < 10000) throw invalid('A part payment is at least ₹100.');
      }
      if (left > full) left = full;
      for (const r of rows.filter((x) => x.due > 0)) {
        if (left <= 0) break;
        const target = await t.one<{ id: string }>(
          `select id from fee_demand where enrolment_id = $1 and bill = $2 and head_code = $3 and net_paise > 0
            order by kind in ('REGULAR', 'CHARGE') desc, created_at limit 1`, [it.enrolmentId, bill, r.head_code]);
        const take = Math.min(r.due, left);
        lines.push({ demand_id: target.id, amount_paise: take, school_id: r.school_id });
        left -= take;
      }
    }
    if (!lines.length) throw conflict('nothing_due', 'Nothing is due for the selected instalments.');
    const schools = new Set(lines.map((l) => l.school_id));
    if (schools.size > 1) throw invalid('Pay each school separately.');
    const amount = lines.reduce((s, l) => s + l.amount_paise, 0);
    const charge = Math.round((amount * CHARGES_BPS[input.method]) / 10000);
    const gatewayOrderId = `sbx_order_${randomBytes(9).toString('hex')}`;
    return t.one(
      `insert into payment_order (school_id, student_id, guardian_id, amount_paise, method, charge_paise, gateway, gateway_order_id, idempotency_key, lines)
       values ($1, $2, $3, $4, $5, $6, 'SANDBOX', $7, $8, $9) returning id, gateway_order_id, amount_paise::int, charge_paise::int, status`,
      [[...schools][0], input.studentId, actor.guardianId, amount, input.method, charge, gatewayOrderId, input.idempotencyKey,
       JSON.stringify(lines.map(({ demand_id, amount_paise }) => ({ demand_id, amount_paise })))]);
  }, { actor: actor.label });
}

export async function nextReceiptNo(db: Db, schoolId: string, on: Date) {
  const y = on.getMonth() >= 3 ? on.getFullYear() : on.getFullYear() - 1;
  const fy = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  const s = await db.one<{ code: string }>('select code from org_unit where id = $1', [schoolId]);
  const r = await db.one<{ last_no: number }>(
    `insert into receipt_counter (school_id, fy, last_no) values ($1, $2, 1)
     on conflict (school_id, fy) do update set last_no = receipt_counter.last_no + 1 returning last_no`, [schoolId, fy]);
  return `${s.code}/${fy}/${String(r.last_no).padStart(6, '0')}`;
}

export interface GatewayEvent {
  event_id: string;
  type: 'payment.captured' | 'payment.failed';
  gateway_order_id: string;
  gateway_payment_id: string;
  amount_paise: number;
  method: string;
}

/**
 * Handles a gateway webhook. Order of checks: signature, then "seen this event before?",
 * then amount must equal the order amount. Capture writes payment, receipt, allocations and
 * the ledger journal in one transaction. Replays and retries are harmless.
 */
export async function handleWebhook(db: Db, rawBody: string, signature: string | undefined) {
  if (!verifySignature(rawBody, signature)) throw new AppError(401, 'bad_signature', 'Webhook signature is not valid.');
  const ev = JSON.parse(rawBody) as GatewayEvent;
  return db.tx(async (t) => {
    const fresh = await t.query(`insert into gateway_event (event_id, gateway, payload) values ($1, 'SANDBOX', $2) on conflict do nothing returning 1`, [ev.event_id, rawBody]);
    if (!fresh.length) return { status: 'duplicate_ignored' as const };
    const o = await t.maybeOne<{ id: string; school_id: string; student_id: string; amount_paise: number; status: string; lines: { demand_id: string; amount_paise: number }[] }>(
      `select id, school_id, student_id, amount_paise::int, status, lines from payment_order where gateway_order_id = $1 for update`, [ev.gateway_order_id]);
    if (!o) throw notFound('Order');
    if (o.status !== 'CREATED') return { status: 'already_final' as const, orderStatus: o.status };
    if (ev.type === 'payment.failed') {
      await t.query(`update payment_order set status = 'FAILED' where id = $1`, [o.id]);
      return { status: 'failed' as const };
    }
    if (ev.amount_paise !== o.amount_paise) throw conflict('amount_mismatch', 'The gateway amount does not match the order. The payment was not recorded.');
    await t.query(`update payment_order set status = 'CAPTURED' where id = $1`, [o.id]);
    const receiptNo = await nextReceiptNo(t, o.school_id, new Date());
    const p = await t.one<{ id: string }>(
      `insert into payment (order_id, school_id, student_id, gateway_payment_id, amount_paise, method, receipt_no)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`, [o.id, o.school_id, o.student_id, ev.gateway_payment_id, o.amount_paise, ev.method, receiptNo]);
    // Allocate against what is due now. If something was paid meanwhile (for example at the
    // counter), the surplus is held as an advance rather than over-allocated.
    let allocated = 0;
    for (const l of o.lines) {
      const due = await t.one<{ due: number }>(
        `select greatest(0, (d.owed_paise - d.paid_paise))::int as due from fee_due d join fee_demand f
            on f.enrolment_id = d.enrolment_id and f.bill = d.bill and f.head_code = d.head_code where f.id = $1`, [l.demand_id]);
      const amt = Math.min(due.due, l.amount_paise);
      if (amt > 0) {
        await t.query(`insert into payment_allocation (payment_id, demand_id, amount_paise) values ($1, $2, $3)`, [p.id, l.demand_id, amt]);
        allocated += amt;
      }
    }
    await post(t, {
      schoolId: o.school_id, narration: `Fee receipt ${receiptNo}`, sourceType: 'payment', sourceId: p.id,
      lines: [
        { account: ev.method === 'CASH' ? '1160' : '1150', debit: o.amount_paise },
        { account: '1200', credit: allocated, studentId: o.student_id },
        { account: '2100', credit: o.amount_paise - allocated, studentId: o.student_id },
      ],
    });
    await t.query(`insert into outbox (topic, payload) values ('payment.receipt', $1)`, [JSON.stringify({ paymentId: p.id, receiptNo, studentId: o.student_id })]);
    return { status: 'captured' as const, receiptNo, paymentId: p.id };
  }, { actor: 'gateway' });
}

/** The sandbox gateway: simulates the bank, then calls the same webhook path a real gateway would. */
export async function sandboxPay(db: Db, actor: Actor, orderId: string, outcome: 'success' | 'failure') {
  const o = await db.maybeOne<{ gateway_order_id: string; amount_paise: number; method: string; student_id: string; status: string }>(
    'select gateway_order_id, amount_paise::int, method, student_id, status from payment_order where id = $1', [orderId]);
  if (!o) throw notFound('Order');
  await assertStudentAccess(db, actor, o.student_id, 'fees');
  const ev: GatewayEvent = {
    event_id: `evt_${randomBytes(8).toString('hex')}`, type: outcome === 'success' ? 'payment.captured' : 'payment.failed',
    gateway_order_id: o.gateway_order_id, gateway_payment_id: `sbx_pay_${randomBytes(8).toString('hex')}`, amount_paise: o.amount_paise, method: o.method,
  };
  const body = JSON.stringify(ev);
  return handleWebhook(db, body, sign(body));
}

export async function receipt(db: Db, actor: Actor, receiptNo: string) {
  const r = await db.maybeOne<Record<string, unknown> & { student_id: string; school_id: string }>(
    `select p.receipt_no, p.amount_paise::int, p.method, p.captured_at, p.gateway_payment_id, p.student_id, p.school_id,
            s.name as student, s.nes_id, o.name as school, o.affiliation_no,
            (select c.address from enrolment e join org_unit c on c.id = e.campus_id where e.student_id = p.student_id and e.school_id = p.school_id
              order by lower(e.period) desc limit 1) as campus_address
       from payment p join student s on s.id = p.student_id join org_unit o on o.id = p.school_id where p.receipt_no = $1`, [receiptNo]);
  if (!r) throw notFound('Receipt');
  if (actor.role === 'PARENT') await assertStudentAccess(db, actor, r.student_id, 'fees');
  else await assertCan(db, actor, 'payments.view', r.school_id);
  const lines = await db.query(
    `select coalesce(c.title, case when f.bill <> f.installment_code then 'Arrears, ' || f.installment_code end, f.installment_code) as installment_code,
            h.name as head, a.amount_paise::int from payment_allocation a join fee_demand f on f.id = a.demand_id
       join fee_head h on h.code = f.head_code join payment p on p.id = a.payment_id left join fee_charge c on c.id = f.charge_id
      where p.receipt_no = $1 order by f.bill, h.alloc_priority`, [receiptNo]);
  return { ...r, lines };
}

/** A school's fees this year up to a date, for the accountant's home: what has fallen due, what is paid, and how many children are behind.
 *  The same sums as Insights, so the principal and the accountant see the same figures. */
export async function standing(db: Db, actor: Actor, schoolId: string, year: string, on: string) {
  await assertCan(db, actor, 'payments.view', schoolId);
  return db.one<{ due: number; paid: number; overdue_children: number }>(
    `with d as (
       select d.enrolment_id, e.status, d.net_paise, i.due_date,
              (select coalesce(sum(pa.amount_paise), 0) from payment_allocation pa where pa.demand_id = d.id) as paid
         from fee_demand d join enrolment e on e.id = d.enrolment_id
         join fee_installment i on i.plan_id = d.plan_id and i.code = d.installment_code
        where e.school_id = $1 and e.academic_year = $2 and i.due_date <= $3::date)
     select coalesce(sum(net_paise), 0)::bigint as due, coalesce(sum(paid), 0)::bigint as paid,
            count(distinct enrolment_id) filter (where net_paise > paid and due_date < $3::date and status in ('ACTIVE', 'PROVISIONAL'))::int as overdue_children
       from d`, [schoolId, year, on]);
}

export async function collections(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'payments.view', schoolId);
  const byDay = await db.query(
    `select captured_at::date::text as day, method, count(*)::int as receipts, sum(amount_paise)::bigint as amount_paise
       from payment where school_id = $1 group by 1, 2 order by 1 desc, 2 limit 60`, [schoolId]);
  const recent = await db.query(
    `select p.receipt_no, p.amount_paise::int, p.method, p.captured_at, s.name as student, s.nes_id
       from payment p join student s on s.id = p.student_id where p.school_id = $1 order by p.captured_at desc limit 25`, [schoolId]);
  return { byDay, recent };
}
