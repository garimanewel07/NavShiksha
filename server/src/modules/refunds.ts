import type { Db } from '../db/client.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';
import { post } from './ledger.js';
import * as approvals from './approvals.js';
import * as notify from './notify.js';
import * as settings from './settings.js';

/**
 * Refunds of credit on a bill: a trip the child left before the refund date, a cancelled trip,
 * a fee reduced after it was paid. Refunds that follow a rule (the principal cancelled the trip,
 * the parent withdrew in time) are approved by that rule. Any other refund goes through the
 * school's approval chain. Money leaves the bank only when the accountant records the transfer.
 */

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

approvals.register('fee_refund', {
  link: '/charges?tab=refunds',
  async context(db, refId) {
    const r = await db.one<{ school_id: string; section_id: string | null }>('select f.school_id, e.section_id from fee_refund f join enrolment e on e.id = f.enrolment_id where f.id = $1', [refId]);
    return { schoolId: r.school_id, sectionId: r.section_id };
  },
  async onApproved(t, refId) { await t.query(`update fee_refund set status = 'APPROVED' where id = $1`, [refId]); },
  async onRejected(t, refId) { await t.query(`update fee_refund set status = 'REJECTED' where id = $1`, [refId]); },
});

/**
 * Uses credit for dues: money a family has paid beyond what a bill now owes (a withdrawn trip,
 * a fee reduced after payment) is moved to their oldest unpaid bills at the same school, by a
 * pair of TRANSFER lines that add up to zero. No money moves, so no journal is needed: the
 * family's receivable is unchanged; only which bill it sits on changes.
 */
export async function applyCredit(t: Db, enrolmentId: string, reason: string) {
  const rows = await t.query<{ bill: string; head_code: string; owed: number; paid: number; due_date: string; priority: number }>(
    `select d.bill, d.head_code, d.owed_paise::int as owed, d.paid_paise::int as paid, h.alloc_priority as priority,
            coalesce(d.due_on, ch.due_on, i.due_date, current_date)::text as due_date
       from fee_due d join enrolment e on e.id = d.enrolment_id join fee_head h on h.code = d.head_code
       left join fee_plan p on p.school_id = e.school_id and p.academic_year = e.academic_year
       left join fee_installment i on i.plan_id = p.id and i.code = d.installment_code
       left join fee_charge ch on ch.id = d.charge_id
      where d.enrolment_id = $1 and d.owed_paise <> d.paid_paise
      order by 6, h.alloc_priority`, [enrolmentId]);
  const credits = rows.filter((r) => r.paid > r.owed).map((r) => ({ ...r, left: r.paid - r.owed }));
  const dues = rows.filter((r) => r.owed > r.paid).map((r) => ({ ...r, left: r.owed - r.paid }));
  let moved = 0;
  for (const c of credits) {
    for (const d of dues) {
      if (c.left <= 0) break;
      if (d.left <= 0) continue;
      const x = Math.min(c.left, d.left);
      await transferLine(t, enrolmentId, c.bill, c.head_code, x, { to: d.bill, reason });
      await transferLine(t, enrolmentId, d.bill, d.head_code, -x, { from: c.bill, reason });
      c.left -= x; d.left -= x; moved += x;
    }
  }
  return { movedPaise: moved };
}

async function transferLine(t: Db, enrolmentId: string, bill: string, head: string, amount: number, note: Record<string, string>) {
  // The new line belongs to the same bill as an existing one: copy its instalment, version or charge.
  const like = await t.one<{ plan_id: string | null; installment_code: string | null; version_id: string | null; charge_id: string | null; bill_key: string | null; due_on: string | null; fee_band: string }>(
    `select plan_id, installment_code, version_id, charge_id, bill_key, due_on::text, fee_band from fee_demand where enrolment_id = $1 and bill = $2 and head_code = $3 order by created_at limit 1`,
    [enrolmentId, bill, head]);
  await t.query(
    `insert into fee_demand (enrolment_id, plan_id, installment_code, head_code, version_id, kind, gross_paise, concession_paise, fee_band, snapshot, charge_id, bill_key, due_on)
     values ($1, $2, $3, $4, $5, 'TRANSFER', $6, 0, $7, $8, $9, $10, $11)`,
    [enrolmentId, like.plan_id, like.installment_code, head, like.version_id, amount, like.fee_band, JSON.stringify(note), like.charge_id, like.bill_key, like.due_on]);
}

/**
 * What happens to a credit, as the school has chosen: used for other dues first (the default),
 * with anything left kept for the next instalment; or refunded at once.
 */
export async function settle(t: Db, actor: Actor, enrolmentId: string, reason: string) {
  const e = await t.one<{ school_id: string }>('select school_id from enrolment where id = $1', [enrolmentId]);
  const mode = await settings.get<string>(t, e.school_id, 'fees.credit_use');
  if (mode === 'ADJUST') return { ...(await applyCredit(t, enrolmentId, reason)), refunds: 0 };
  const bills = await t.query<{ bill: string }>(`select bill from fee_due where enrolment_id = $1 group by bill having sum(paid_paise - owed_paise) > 0`, [enrolmentId]);
  let n = 0;
  for (const b of bills) if (await requestAuto(t, actor, { enrolmentId, bill: b.bill, reason })) n++;
  return { movedPaise: 0, refunds: n };
}

/** Credit on one bill: money paid beyond what is now owed, per head. */
async function credit(db: Db, enrolmentId: string, bill: string) {
  const rows = await db.query<{ head_code: string; credit: number }>(
    `select head_code, (paid_paise - owed_paise)::int as credit from fee_due where enrolment_id = $1 and bill = $2 and paid_paise > owed_paise`, [enrolmentId, bill]);
  return { total: rows.reduce((s, r) => s + r.credit, 0), heads: rows };
}

async function open(db: Db, enrolmentId: string, bill: string) {
  return db.maybeOne<{ id: string; status: string }>(`select id, status from fee_refund where enrolment_id = $1 and bill = $2 and status in ('PENDING', 'APPROVED')`, [enrolmentId, bill]);
}

/** A refund the rules already allow, raised inside the caller's transaction, ready to pay. */
export async function requestAuto(t: Db, actor: Actor, input: { enrolmentId: string; bill: string; reason: string }) {
  const c = await credit(t, input.enrolmentId, input.bill);
  if (c.total <= 0 || await open(t, input.enrolmentId, input.bill)) return null;
  const e = await t.one<{ school_id: string; student_id: string }>('select school_id, student_id from enrolment where id = $1', [input.enrolmentId]);
  const r = await t.one<{ id: string }>(
    `insert into fee_refund (school_id, enrolment_id, student_id, bill, amount_paise, reason, status, requested_by) values ($1, $2, $3, $4, $5, $6, 'APPROVED', $7) returning id`,
    [e.school_id, input.enrolmentId, e.student_id, input.bill, c.total, input.reason, actor.id]);
  return { id: r.id, amountPaise: c.total };
}

/** Any other refund (for example a fee reduced after it was paid): goes for approval. */
export async function request(db: Db, actor: Actor, input: { enrolmentId: string; bill: string; reason: string }) {
  const e = await db.maybeOne<{ school_id: string; student_id: string; name: string }>(
    'select e.school_id, e.student_id, s.name from enrolment e join student s on s.id = e.student_id where e.id = $1', [input.enrolmentId]);
  if (!e) throw notFound('Enrolment');
  await assertCan(db, actor, 'payments.collect', e.school_id);
  if (input.reason.trim().length < 5) throw invalid('Give the reason for the refund.');
  const c = await credit(db, input.enrolmentId, input.bill);
  if (c.total <= 0) throw conflict('no_credit', 'There is no credit on this bill to refund.');
  if (await open(db, input.enrolmentId, input.bill)) throw conflict('duplicate', 'A refund for this bill is already in progress.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into fee_refund (school_id, enrolment_id, student_id, bill, amount_paise, reason, requested_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [e.school_id, input.enrolmentId, e.student_id, input.bill, c.total, input.reason.trim(), actor.id]);
    const flow = await approvals.start(t, { kind: 'fee_refund', schoolId: e.school_id, refId: r.id, title: `Refund: ${e.name}, ${rupees(c.total)}`, summary: input.reason.trim(),
      facts: { amount_rupees: c.total / 100 }, requestedBy: actor.id });
    return { id: r.id, amountPaise: c.total, steps: flow.steps.map((s) => s.label) };
  }, { actor: actor.label });
}

/** Records the money going back to the family, after approval. */
export async function pay(db: Db, actor: Actor, id: string, input: { method: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH'; reference: string }) {
  const r = await db.maybeOne<{ school_id: string; enrolment_id: string; student_id: string; bill: string; amount_paise: number; status: string; requested_by: string }>(
    'select school_id, enrolment_id, student_id, bill, amount_paise::int, status, requested_by from fee_refund where id = $1', [id]);
  if (!r) throw notFound('Refund');
  await assertCan(db, actor, 'payments.collect', r.school_id);
  if (r.status !== 'APPROVED') throw conflict('not_approved', r.status === 'PENDING' ? 'This refund is waiting for approval.' : `This refund is ${r.status.toLowerCase()}.`);
  if (input.reference.trim().length < 3) throw invalid('Enter the transfer, cheque or cash voucher reference.');
  return db.tx(async (t) => {
    const c = await credit(t, r.enrolment_id, r.bill);
    let left = Math.min(r.amount_paise, c.total);
    if (left <= 0) throw conflict('no_credit', 'The credit on this bill has already been used.');
    const paidNow = left;
    for (const h of c.heads) {
      if (left <= 0) break;
      const amt = Math.min(left, h.credit);
      const d = await t.one<{ id: string }>(`select id from fee_demand where enrolment_id = $1 and bill = $2 and head_code = $3 order by net_paise desc, created_at limit 1`, [r.enrolment_id, r.bill, h.head_code]);
      await t.query(`insert into fee_refund_line (refund_id, demand_id, amount_paise) values ($1, $2, $3)`, [id, d.id, amt]);
      left -= amt;
    }
    await t.query(`update fee_refund set status = 'PAID', method = $2, reference = $3, paid_by = $4, paid_at = now() where id = $1`, [id, input.method, input.reference.trim(), actor.id]);
    await post(t, { schoolId: r.school_id, narration: `Refund (${input.reference.trim()})`, sourceType: 'fee_refund', sourceId: id,
      lines: [{ account: '1200', debit: paidNow, studentId: r.student_id }, { account: input.method === 'CASH' ? '1160' : '1100', credit: paidNow }] });
    await notify.toParentsOf(t, [r.student_id], { kind: 'FEES', title: `Refund of ${rupees(paidNow)}`, body: `${input.method === 'CASH' ? 'Paid in cash' : input.method === 'CHEQUE' ? 'Cheque' : 'Bank transfer'}, reference ${input.reference.trim()}.`, link: '/fees' });
    return { status: 'PAID', amountPaise: paidNow };
  }, { actor: actor.label });
}

export async function list(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'payments.view', schoolId);
  return db.query(
    `select f.id, f.bill, f.amount_paise::int, f.reason, f.status, f.requested_at, f.method, f.reference, f.paid_at, s.name as student, e.admission_no,
            e.class_code, u.name as requested_by, p.name as paid_by, c.title as charge
       from fee_refund f join student s on s.id = f.student_id join enrolment e on e.id = f.enrolment_id join app_user u on u.id = f.requested_by
       left join app_user p on p.id = f.paid_by left join fee_charge c on f.bill = 'C:' || c.id::text
      where f.school_id = $1 order by (f.status in ('PENDING', 'APPROVED')) desc, f.requested_at desc limit 200`, [schoolId]);
}

/** Credits on a student's bills, for the parent app and the fee desk. */
export async function creditsFor(db: Db, studentId: string) {
  return db.query<{ enrolment_id: string; bill: string; credit_paise: number; refund_status: string | null }>(
    `select d.enrolment_id, d.bill, sum(d.paid_paise - d.owed_paise)::int as credit_paise,
            (select status from fee_refund f where f.enrolment_id = d.enrolment_id and f.bill = d.bill order by requested_at desc limit 1) as refund_status
       from fee_due d join enrolment e on e.id = d.enrolment_id where e.student_id = $1 group by d.enrolment_id, d.bill having sum(d.paid_paise - d.owed_paise) > 0`, [studentId]);
}

