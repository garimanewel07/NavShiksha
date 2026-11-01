import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, can, studentGrants } from './access.js';
import { post, signed } from './ledger.js';
import * as notify from './notify.js';
import * as refunds from './refunds.js';
import { localToday } from '../lib/dates.js';

/**
 * Additional charges: anything a school collects outside the fee plan. CBSE registration and
 * board exam fees, a trip, an event, a diary or an ID card.
 *
 *  - Compulsory: every child in the chosen classes (or sections) is charged when the principal
 *    approves it. A child can be excused by the principal, with a reason.
 *  - Optional: parents are asked first. Only children whose parents say yes are charged. With a
 *    seat limit, later replies go to a waiting list and move up when someone withdraws.
 *    A child withdrawn by the refund date gets the money back; after it the charge stands.
 *
 * Money the school collects for someone else (CBSE, a trip operator) is held as a liability and
 * paid out, so it never shows as school income. Every line is permanent: a reversal is a new line.
 */

const today = () => localToday();
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export interface ChargeInput {
  schoolId: string; year: string; head: string; title: string; details?: string; amountPaise: number;
  mode: 'COMPULSORY' | 'OPTIONAL'; classCodes: string[]; sectionIds?: string[] | null; dueOn: string;
  respondBy?: string | null; capacity?: number | null; refundableUntil?: string | null; inChargeId?: string | null;
}

interface Charge {
  id: string; school_id: string; academic_year: string; head_code: string; title: string; details: string; amount_paise: number; mode: 'COMPULSORY' | 'OPTIONAL';
  class_codes: string[]; section_ids: string[] | null; due_on: string; respond_by: string | null; capacity: number | null; refundable_until: string | null;
  in_charge_id: string | null; status: string; created_by: string; approved_by: string | null; account: string;
}

async function load(db: Db, id: string): Promise<Charge> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Charge');
  const c = await db.maybeOne<Charge>(
    `select c.id, c.school_id, c.academic_year, c.head_code, c.title, c.details, c.amount_paise::int, c.mode, c.class_codes, c.section_ids, c.due_on::text,
            c.respond_by::text, c.capacity, c.refundable_until::text, c.in_charge_id, c.status, c.created_by, c.approved_by, h.income_account as account
       from fee_charge c join fee_head h on h.code = c.head_code where c.id = $1`, [id]);
  if (!c) throw notFound('Charge');
  return c;
}

/** The last day a withdrawal gets the money back: the refund date, or the due date if none was set. */
const refundableBy = (c: Charge) => c.refundable_until ?? c.due_on;

export async function draft(db: Db, actor: Actor, input: ChargeInput) {
  await assertCan(db, actor, 'fees.view', input.schoolId);
  if (actor.role === 'NES_ADMIN' || actor.role === 'SCHOOL_ADMIN' || actor.role === 'ACCOUNTANT') { /* may raise charges */ } else throw forbidden('Charges are raised by the accountant or the principal.');
  const head = await db.maybeOne<{ kind: string }>('select kind from fee_head where code = $1', [input.head]);
  if (!head || head.kind !== 'CHARGE') throw invalid('Choose a type of charge.');
  if (input.dueOn < today()) throw invalid('The due date must be today or later.');
  if (input.mode === 'OPTIONAL') {
    if (!input.respondBy) throw invalid('For an optional charge, give the date by which parents must reply.');
    if (input.respondBy < today() || input.respondBy > input.dueOn) throw invalid('Parents must reply on or after today and on or before the due date.');
  } else if (input.capacity) throw invalid('A seat limit applies only to optional charges.');
  if (input.refundableUntil && input.refundableUntil < today()) throw invalid('The refund date must be today or later.');
  const classes = await db.query<{ code: string }>('select code from class_level where code = any($1)', [input.classCodes]);
  if (!input.classCodes.length || classes.length !== new Set(input.classCodes).size) throw invalid('Choose the classes this applies to.');
  if (input.sectionIds?.length) {
    const ok = await db.query(`select 1 from section s join org_unit c on c.id = s.campus_id where s.id = any($1) and c.parent_id = $2 and s.class_code = any($3) and s.academic_year = $4`,
      [input.sectionIds, input.schoolId, input.classCodes, input.year]);
    if (ok.length !== input.sectionIds.length) throw invalid('The sections must belong to the chosen classes at this school.');
  }
  if (input.inChargeId) {
    const t = await db.maybeOne(`select 1 from app_user u join org_unit o on o.id = $2 where u.id = $1 and u.active and u.role in ('TEACHER', 'SCHOOL_ADMIN') and u.scope_path <@ o.path`, [input.inChargeId, input.schoolId]);
    if (!t) throw invalid('The person in charge must be a teacher of this school.');
  }
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into fee_charge (school_id, academic_year, head_code, title, details, amount_paise, mode, class_codes, section_ids, due_on, respond_by, capacity, refundable_until, in_charge_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [input.schoolId, input.year, input.head, input.title.trim(), (input.details ?? '').trim(), input.amountPaise, input.mode, input.classCodes,
     input.sectionIds?.length ? input.sectionIds : null, input.dueOn, input.mode === 'OPTIONAL' ? input.respondBy : null, input.mode === 'OPTIONAL' ? input.capacity ?? null : null,
     input.refundableUntil ?? null, input.inChargeId ?? null, actor.id]), { actor: actor.label });
  return { id: r.id, status: 'DRAFT' };
}

/** Children the charge reaches: current enrolments in the chosen classes (and sections). */
async function audience(db: Db, c: Charge) {
  return db.query<{ enrolment_id: string; student_id: string }>(
    `select e.id as enrolment_id, e.student_id from enrolment e
      where e.school_id = $1 and e.academic_year = $2 and e.class_code = any($3) and ($4::uuid[] is null or e.section_id = any($4))
        and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
        and not exists (select 1 from fee_charge_participant p where p.charge_id = $5 and p.enrolment_id = e.id)`,
    [c.school_id, c.academic_year, c.class_codes, c.section_ids, c.id]);
}

/** Adds a charge line (+) or its reversal (−), with its journal, for one child. */
async function line(t: Db, c: Charge, enrolmentId: string, studentId: string, sign: 1 | -1, why: string) {
  const d = await t.one<{ id: string }>(
    `insert into fee_demand (enrolment_id, head_code, kind, gross_paise, concession_paise, fee_band, snapshot, charge_id, bill_key, due_on)
     values ($1, $2, $3, $4, 0, '-', $5, $6, $7, $8) returning id`,
    [enrolmentId, c.head_code, sign > 0 ? 'CHARGE' : 'ADJUSTMENT', sign * c.amount_paise, JSON.stringify({ charge: c.title, why }), c.id, `C:${c.id}`, c.due_on]);
  await post(t, {
    schoolId: c.school_id, narration: `${sign > 0 ? '' : 'Reversed: '}${c.title}`, sourceType: 'fee_demand', sourceId: d.id,
    lines: [signed('1200', sign * c.amount_paise, 'debit', studentId), signed(c.account, sign * c.amount_paise, 'credit', studentId)],
  });
}

/** What the child is charged for this charge (its own lines; credit transfers are not counted). */
const chargeNet = async (db: Db, c: Charge, enrolmentId: string) =>
  (await db.one<{ net: number }>(`select coalesce(sum(net_paise), 0)::int as net from fee_demand where charge_id = $1 and enrolment_id = $2 and kind in ('CHARGE', 'ADJUSTMENT')`, [c.id, enrolmentId])).net;

/** What the child has paid towards this charge (after any refunds). */
const paidOn = async (db: Db, c: Charge, enrolmentId: string) =>
  (await db.maybeOne<{ paid: number }>(`select coalesce(sum(paid_paise), 0)::int as paid from fee_due where enrolment_id = $1 and bill = $2`, [enrolmentId, `C:${c.id}`]))?.paid ?? 0;

async function set(t: Db, c: Charge, enrolmentId: string, status: string, actor: Actor, note = '') {
  await t.query(`update fee_charge_participant set status = $3, replied_by = $4, replied_at = now(), note = $5 where charge_id = $1 and enrolment_id = $2`,
    [c.id, enrolmentId, status, actor.id, note]);
}

/** Approval by a second person opens the charge: compulsory ones are billed, optional ones ask parents. */
export async function approve(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Charges are approved by the principal.');
  await assertUnitInScope(db, actor, c.school_id);
  if (c.status !== 'DRAFT') throw conflict('not_draft', 'This charge has already been approved.');
  if (c.created_by === actor.id) throw conflict('maker_checker', 'A charge must be approved by someone other than the person who raised it.');
  if (c.due_on < today()) throw invalid('The due date has passed. Discard this draft and raise it again.');
  return db.tx(async (t) => {
    await t.query(`update fee_charge set status = 'OPEN', approved_by = $2, opened_at = now() where id = $1`, [id, actor.id]);
    const added = await addAudience(t, { ...c, status: 'OPEN' }, actor);
    return { status: 'OPEN', ...added };
  }, { actor: actor.label });
}

async function addAudience(t: Db, c: Charge, _actor: Actor) {
  const kids = await audience(t, c);
  for (const k of kids) {
    // Nobody has replied yet; for a compulsory charge the note says why the child is in.
    await t.query(`insert into fee_charge_participant (charge_id, enrolment_id, status, note) values ($1, $2, $3, $4)`,
      [c.id, k.enrolment_id, c.mode === 'COMPULSORY' ? 'IN' : 'AWAITING', c.mode === 'COMPULSORY' ? 'Applies to every child in the class' : '']);
    if (c.mode === 'COMPULSORY') await line(t, c, k.enrolment_id, k.student_id, 1, 'Compulsory');
  }
  if (kids.length) {
    await notify.toParentsOf(t, kids.map((k) => k.student_id), c.mode === 'COMPULSORY'
      ? { kind: 'FEES', title: c.title, body: `${rupees(c.amount_paise)} due by ${notify.fmt(c.due_on)}.${c.details ? ` ${c.details}` : ''}`.slice(0, 400), link: '/fees' }
      : { kind: 'FEES', title: `${c.title}: please reply`, body: `${rupees(c.amount_paise)}. Tell the school by ${notify.fmt(c.respond_by!)} whether your child is taking part. You are charged only if you say yes.${c.capacity ? ` ${c.capacity} places.` : ''}`, link: '/fees' });
  }
  return { added: kids.length };
}

/** Adds children who joined the classes after the charge opened. */
export async function refresh(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  await assertCan(db, actor, 'payments.collect', c.school_id);
  if (c.status !== 'OPEN') throw conflict('not_open', 'Only an open charge can take new children.');
  return db.tx((t) => addAudience(t, c, actor), { actor: actor.label });
}

/** Who may record a reply for a child: the parent, or staff on a paper slip (in-charge, class teacher, office). */
async function canRecordFor(db: Db, actor: Actor, c: Charge, enrolmentId: string, studentId: string) {
  if (actor.role === 'PARENT') { await studentGrants(db, actor, studentId); return 'PARENT'; }
  await assertUnitInScope(db, actor, c.school_id);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN' || actor.role === 'ACCOUNTANT') return 'OFFICE';
  if (c.in_charge_id === actor.id) return 'IN_CHARGE';
  const ct = await db.maybeOne(`select 1 from enrolment e join class_teacher x on x.section_id = e.section_id and x.valid @> current_date where e.id = $1 and x.user_id = $2`, [enrolmentId, actor.id]);
  if (ct) return 'CLASS_TEACHER';
  throw forbidden('Replies are recorded by the parent, the teacher in charge, the class teacher or the office.');
}

async function participant(db: Db, c: Charge, studentId: string) {
  const p = await db.maybeOne<{ enrolment_id: string; status: string }>(
    `select p.enrolment_id, p.status from fee_charge_participant p join enrolment e on e.id = p.enrolment_id where p.charge_id = $1 and e.student_id = $2`, [c.id, studentId]);
  if (!p) throw notFound('This charge does not apply to this child');
  return p;
}

/** Moves the first child on the waiting list into a freed place. */
async function promoteWaitlist(t: Db, c: Charge, actor: Actor) {
  if (!c.capacity) return null;
  const inCount = await t.one<{ n: number }>(`select count(*)::int as n from fee_charge_participant where charge_id = $1 and status = 'IN'`, [c.id]);
  if (inCount.n >= c.capacity) return null;
  const next = await t.maybeOne<{ enrolment_id: string; student_id: string }>(
    `select p.enrolment_id, e.student_id from fee_charge_participant p join enrolment e on e.id = p.enrolment_id
      where p.charge_id = $1 and p.status = 'WAITLIST' order by p.replied_at, p.enrolment_id limit 1`, [c.id]);
  if (!next) return null;
  await line(t, c, next.enrolment_id, next.student_id, 1, 'Moved up from the waiting list');
  await set(t, c, next.enrolment_id, 'IN', actor, 'Moved up from the waiting list');
  await notify.toParentsOf(t, [next.student_id], { kind: 'FEES', title: `${c.title}: a place is confirmed`, body: `A place opened up. ${rupees(c.amount_paise)} is due by ${notify.fmt(c.due_on)}.`, link: '/fees' });
  return next.enrolment_id;
}

/** Takes a charged child out: reversed (and refunded if paid) up to the refund date; after it the charge stands. */
async function takeOut(t: Db, c: Charge, enrolmentId: string, studentId: string, to: 'WITHDRAWN' | 'EXCUSED' | 'CANCELLED', actor: Actor, reason: string) {
  const net = await chargeNet(t, c, enrolmentId);
  const reverse = net > 0 && (to !== 'WITHDRAWN' || today() <= refundableBy(c));
  if (reverse) {
    await line(t, c, enrolmentId, studentId, -1, reason);
    if (await paidOn(t, c, enrolmentId) > 0) await refunds.settle(t, actor, enrolmentId, `${c.title}: ${reason}`);
  }
  await set(t, c, enrolmentId, to, actor, reason);
  return { reversed: reverse };
}

/**
 * A reply for one child: yes or no. Parents reply until the reply date; the teacher in charge,
 * class teacher or office can record a paper slip at any time while the charge is open.
 */
export async function respond(db: Db, actor: Actor, id: string, studentId: string, going: boolean, note = '') {
  const c = await load(db, id);
  if (c.mode !== 'OPTIONAL') throw invalid('This charge applies to every child in the class; ask the principal if a child should be excused.');
  if (c.status !== 'OPEN') throw conflict('closed', 'Replies for this are closed. Contact the school office.');
  const p = await participant(db, c, studentId);
  const who = await canRecordFor(db, actor, c, p.enrolment_id, studentId);
  if (who === 'PARENT' && today() > c.respond_by!) throw conflict('late', `Replies closed on ${notify.fmt(c.respond_by!)}. Contact the class teacher.`);
  return db.tx(async (t) => {
    if (going) {
      if (p.status === 'IN' || p.status === 'WAITLIST') return { status: p.status };
      if (['EXCUSED', 'CANCELLED'].includes(p.status)) throw conflict('final', 'This child has been excused from this charge.');
      const full = c.capacity ? (await t.one<{ n: number }>(`select count(*)::int as n from fee_charge_participant where charge_id = $1 and status = 'IN'`, [c.id])).n >= c.capacity : false;
      if (full) { await set(t, c, p.enrolment_id, 'WAITLIST', actor, note); return { status: 'WAITLIST' }; }
      // A child withdrawn after the refund date still carries the charge; taking part again adds nothing.
      if (await chargeNet(t, c, p.enrolment_id) === 0) await line(t, c, p.enrolment_id, studentId, 1, who === 'PARENT' ? 'Parent said yes' : `Recorded by ${who.toLowerCase().replace('_', ' ')}`);
      await set(t, c, p.enrolment_id, 'IN', actor, note);
      return { status: 'IN', duePaise: c.amount_paise, dueOn: c.due_on };
    }
    if (p.status === 'IN') {
      const r = await takeOut(t, c, p.enrolment_id, studentId, 'WITHDRAWN', actor, note || 'Withdrawn');
      await promoteWaitlist(t, c, actor);
      return { status: 'WITHDRAWN', refunded: r.reversed, refundableUntil: refundableBy(c) };
    }
    if (['AWAITING', 'NO_REPLY', 'WAITLIST'].includes(p.status)) { await set(t, c, p.enrolment_id, 'DECLINED', actor, note); return { status: 'DECLINED' }; }
    return { status: p.status };
  }, { actor: actor.label });
}

/** The principal excuses a child (hardship, medical, staff ward…). Any charge is reversed. */
export async function excuse(db: Db, actor: Actor, id: string, studentId: string, reason: string) {
  const c = await load(db, id);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Only the principal can excuse a child from a charge.');
  await assertUnitInScope(db, actor, c.school_id);
  if (reason.trim().length < 5) throw invalid('Give the reason; it is kept with the record.');
  if (c.status === 'CANCELLED') throw conflict('cancelled', 'This charge is cancelled.');
  const p = await participant(db, c, studentId);
  if (p.status === 'EXCUSED') return { status: 'EXCUSED' };
  return db.tx(async (t) => {
    const wasIn = p.status === 'IN';
    await takeOut(t, c, p.enrolment_id, studentId, 'EXCUSED', actor, reason.trim());
    if (wasIn) await promoteWaitlist(t, c, actor);
    await notify.toParentsOf(t, [studentId], { kind: 'FEES', title: `${c.title}: excused`, body: 'The principal has excused your child from this charge. Nothing is due for it.', link: '/fees' });
    return { status: 'EXCUSED' };
  }, { actor: actor.label });
}

/** Stops replies; children with no reply are marked so (and not charged). Can be reopened. */
export async function close(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  await assertCan(db, actor, 'payments.collect', c.school_id);
  if (c.status !== 'OPEN') throw conflict('not_open', 'This charge is not open.');
  return db.tx(async (t) => {
    const r = await t.query(`update fee_charge_participant set status = 'NO_REPLY' where charge_id = $1 and status = 'AWAITING' returning 1`, [id]);
    await t.query(`update fee_charge set status = 'CLOSED', closed_at = now() where id = $1`, [id]);
    return { status: 'CLOSED', noReply: r.length };
  }, { actor: actor.label });
}

export async function reopen(db: Db, actor: Actor, id: string, respondBy: string) {
  const c = await load(db, id);
  await assertCan(db, actor, 'payments.collect', c.school_id);
  if (c.status !== 'CLOSED') throw conflict('not_closed', 'Only a closed charge can be reopened.');
  if (respondBy < today() || respondBy > c.due_on) throw invalid('The new reply date must be between today and the due date.');
  await db.tx((t) => t.query(`update fee_charge set status = 'OPEN', respond_by = $2 where id = $1`, [id, respondBy]), { actor: actor.label });
  return { status: 'OPEN' };
}

/** Cancels the whole charge (trip called off). Every line is reversed and every payment refunded. */
export async function cancel(db: Db, actor: Actor, id: string, reason: string) {
  const c = await load(db, id);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Only the principal can cancel a charge.');
  await assertUnitInScope(db, actor, c.school_id);
  if (reason.trim().length < 5) throw invalid('Give the reason; parents will see it.');
  if (c.status === 'CANCELLED') return { status: 'CANCELLED', paidBack: 0 };
  return db.tx(async (t) => {
    const people = await t.query<{ enrolment_id: string; student_id: string; status: string }>(
      `select p.enrolment_id, e.student_id, p.status from fee_charge_participant p join enrolment e on e.id = p.enrolment_id where p.charge_id = $1 and p.status not in ('EXCUSED', 'CANCELLED')`, [id]);
    let refunded = 0;
    for (const p of people) {
      if (await chargeNet(t, c, p.enrolment_id) > 0) {
        const paid = await paidOn(t, c, p.enrolment_id);
        await line(t, c, p.enrolment_id, p.student_id, -1, `Cancelled: ${reason.trim()}`);
        if (paid > 0) { await refunds.settle(t, actor, p.enrolment_id, `${c.title} cancelled: ${reason.trim()}`); refunded++; }
      }
      await set(t, c, p.enrolment_id, 'CANCELLED', actor, reason.trim());
    }
    await t.query(`update fee_charge set status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 where id = $1`, [id, reason.trim()]);
    if (people.length) {
      await notify.toParentsOf(t, people.map((p) => p.student_id), { kind: 'FEES', title: `${c.title}: cancelled`, body: `${reason.trim()}. Nothing is due for it. Any money paid is adjusted against your fees or refunded, as the school has set.`.slice(0, 400), link: '/fees' });
    }
    return { status: 'CANCELLED', paidBack: refunded };
  }, { actor: actor.label });
}

/** Discards a draft that was never approved. */
export async function discard(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  await assertCan(db, actor, 'fees.view', c.school_id);
  if (c.status !== 'DRAFT') throw conflict('not_draft', 'Only a draft can be discarded; cancel an open charge instead.');
  await db.tx((t) => t.query('delete from fee_charge where id = $1', [id]), { actor: actor.label });
  return { discarded: true };
}

/** Money paid out of what was collected: to CBSE, the trip operator, the venue. */
export async function payout(db: Db, actor: Actor, id: string, input: { amountPaise: number; paidOn: string; payee: string; reference: string }) {
  const c = await load(db, id);
  await assertCan(db, actor, 'payments.collect', c.school_id);
  if (!['2300', '2310'].includes(c.account)) throw invalid('This charge is school income; there is nothing to pay out.');
  if (input.amountPaise <= 0) throw invalid('Enter the amount paid.');
  if (input.reference.trim().length < 3) throw invalid('Enter the bank or challan reference.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into fee_charge_payout (charge_id, amount_paise, paid_on, payee, reference, recorded_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [id, input.amountPaise, input.paidOn, input.payee.trim(), input.reference.trim(), actor.id]);
    await post(t, { schoolId: c.school_id, narration: `${c.title}: paid to ${input.payee.trim()} (${input.reference.trim()})`, sourceType: 'charge_payout', sourceId: r.id,
      lines: [{ account: c.account, debit: input.amountPaise }, { account: '1100', credit: input.amountPaise }] });
    return { id: r.id };
  }, { actor: actor.label });
}

async function totals(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const rows = await db.query<{ charge_id: string; counts: Record<string, number>; charged: number; collected: number; paid_out: number; refunded: number }>(
    `select c.id as charge_id,
            coalesce((select jsonb_object_agg(status, n) from (select status, count(*)::int as n from fee_charge_participant where charge_id = c.id group by status) s), '{}') as counts,
            coalesce((select sum(net_paise) from fee_demand where charge_id = c.id), 0)::int as charged,
            coalesce((select sum(a.amount_paise) from payment_allocation a join fee_demand d on d.id = a.demand_id where d.charge_id = c.id), 0)::int as collected,
            coalesce((select sum(r.amount_paise) from fee_refund_line r join fee_demand d on d.id = r.demand_id where d.charge_id = c.id), 0)::int as refunded,
            coalesce((select sum(amount_paise) from fee_charge_payout where charge_id = c.id), 0)::int as paid_out
       from fee_charge c where c.id = any($1)`, [ids]);
  return new Map(rows.map((r) => [r.charge_id, { counts: r.counts, chargedPaise: r.charged, collectedPaise: r.collected - r.refunded, outstandingPaise: Math.max(0, r.charged - (r.collected - r.refunded)), paidOutPaise: r.paid_out }]));
}

const SELECT = `select c.id, c.title, c.details, c.head_code, h.name as head, h.income_account as account, c.amount_paise::int, c.mode, c.class_codes,
                       (select array_agg(s.class_code || '-' || s.name order by s.class_code, s.name) from section s where s.id = any(c.section_ids)) as sections,
                       c.due_on::text, c.respond_by::text, c.capacity, c.refundable_until::text, c.status, c.cancel_reason, c.created_at,
                       c.in_charge_id, ic.name as in_charge, cu.name as raised_by, c.created_by, au.name as approved_by
                  from fee_charge c join fee_head h on h.code = c.head_code join app_user cu on cu.id = c.created_by
                  left join app_user au on au.id = c.approved_by left join app_user ic on ic.id = c.in_charge_id`;

/**
 * Charges at a school. The fee desk and principal see all, with money. A teacher sees the ones
 * they run, and those reaching their own class, without amounts collected.
 */
export async function list(db: Db, actor: Actor, schoolId: string, year: string) {
  await assertUnitInScope(db, actor, schoolId);
  const money = await can(db, actor, 'fees.view', schoolId);
  const rows = await db.query<Record<string, any>>(
    `${SELECT} where c.school_id = $1 and c.academic_year = $2 and ($3 or c.in_charge_id = $4 or exists (
        select 1 from class_teacher x join section s on s.id = x.section_id where x.user_id = $4 and x.valid @> current_date
           and s.class_code = any(c.class_codes) and (c.section_ids is null or s.id = any(c.section_ids))))
       and ($3 or c.status <> 'DRAFT')
      order by (c.status in ('DRAFT', 'OPEN')) desc, c.due_on desc`, [schoolId, year, money, actor.id]);
  const t = await totals(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...(money ? t.get(r.id) : { counts: t.get(r.id)?.counts ?? {} }) }));
}

/** One charge with its children: status, and paid or not. Class teachers see their own class. */
export async function detail(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  await assertUnitInScope(db, actor, c.school_id);
  const money = await can(db, actor, 'fees.view', c.school_id);
  const inCharge = c.in_charge_id === actor.id;
  if (!money && !inCharge && actor.role !== 'TEACHER') throw forbidden();
  const row = (await db.query<Record<string, any>>(`${SELECT} where c.id = $1`, [id]))[0];
  const people = await db.query<{ enrolment_id: string; student_id: string; name: string; admission_no: string; class: string; status: string; note: string; replied_at: string | null; replied_by: string | null; owed: number; paid: number; section_id: string }>(
    `select p.enrolment_id, e.student_id, s.name, e.admission_no, e.class_code || coalesce('-' || sec.name, '') as class, e.section_id, p.status, p.note, p.replied_at, u.name as replied_by,
            coalesce((select sum(owed_paise) from fee_due d where d.enrolment_id = p.enrolment_id and d.bill = 'C:' || p.charge_id), 0)::int as owed,
            coalesce((select sum(paid_paise) from fee_due d where d.enrolment_id = p.enrolment_id and d.bill = 'C:' || p.charge_id), 0)::int as paid
       from fee_charge_participant p join enrolment e on e.id = p.enrolment_id join student s on s.id = e.student_id
       left join section sec on sec.id = e.section_id left join app_user u on u.id = p.replied_by
      where p.charge_id = $1 order by e.class_code, sec.name, s.name`, [id]);
  let visible = people;
  if (!money && !inCharge) {
    const mine = (await db.query<{ section_id: string }>(`select section_id from class_teacher where user_id = $1 and valid @> current_date`, [actor.id])).map((x) => x.section_id);
    visible = people.filter((p) => mine.includes(p.section_id));
    if (!visible.length) throw forbidden('This charge does not reach your class.');
  }
  const payouts = money ? await db.query(`select p.amount_paise::int, p.paid_on::text, p.payee, p.reference, u.name as recorded_by from fee_charge_payout p join app_user u on u.id = p.recorded_by where p.charge_id = $1 order by p.paid_on`, [id]) : [];
  return {
    ...row, ...(money ? (await totals(db, [id])).get(id) : {}), payouts,
    canManage: money, canApprove: (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') && c.created_by !== actor.id,
    people: visible.map((p) => ({
      enrolmentId: p.enrolment_id, studentId: p.student_id, name: p.name, admissionNo: p.admission_no, class: p.class, status: p.status, note: p.note,
      repliedAt: p.replied_at, repliedBy: p.replied_by,
      // Teachers see only whether this charge is paid, never amounts or other fees.
      paid: p.owed > 0 ? (p.paid >= p.owed ? 'PAID' : p.paid > 0 ? 'PART' : 'UNPAID') : p.paid > 0 ? 'REFUND_DUE' : null,
      ...(money ? { owedPaise: p.owed, paidPaise: p.paid } : {}),
    })),
  };
}

/** For the parent app: every charge reaching this child, with what they can do. */
export async function forStudent(db: Db, actor: Actor, studentId: string) {
  const g = await studentGrants(db, actor, studentId);
  if (!g.has('fees')) throw forbidden();
  const rows = await db.query<Record<string, any>>(
    `select c.id, c.title, c.details, h.name as head, c.amount_paise::int, c.mode, c.due_on::text, c.respond_by::text, c.capacity, c.refundable_until::text, c.status, c.cancel_reason,
            p.status as my_status, ic.name as in_charge,
            (select count(*) from fee_charge_participant x where x.charge_id = c.id and x.status = 'IN')::int as taken,
            coalesce((select sum(owed_paise) from fee_due d where d.enrolment_id = p.enrolment_id and d.bill = 'C:' || c.id), 0)::int as owed,
            coalesce((select sum(paid_paise) from fee_due d where d.enrolment_id = p.enrolment_id and d.bill = 'C:' || c.id), 0)::int as paid
       from fee_charge_participant p join fee_charge c on c.id = p.charge_id join fee_head h on h.code = c.head_code
       join enrolment e on e.id = p.enrolment_id left join app_user ic on ic.id = c.in_charge_id
      where e.student_id = $1 order by (c.status = 'OPEN') desc, c.due_on`, [studentId]);
  const now = today();
  return rows.map((r) => ({
    ...r,
    seatsLeft: r.capacity ? Math.max(0, r.capacity - r.taken) : null,
    canReply: r.mode === 'OPTIONAL' && r.status === 'OPEN' && now <= r.respond_by && !['EXCUSED', 'CANCELLED'].includes(r.my_status),
    refundableNow: now <= (r.refundable_until ?? r.due_on),
  }));
}

/**
 * A child moving to another NES school leaves the old school's trips and events still to come:
 * each is reversed (any money paid becomes credit, which the transfer carries to the new school)
 * and the place goes to the next child on the waiting list.
 */
/**
 * A child moving to another NES school leaves the old school's charges still to come. Each is
 * reversed (paid money then goes with the child), unless the school has already spent it: money
 * sent to the board or the trip operator, or the refund date for the trip has passed. Then the
 * charge stands, as it would for any child who withdraws late, and the board registration goes
 * with the child.
 */
export async function releaseForTransfer(t: Db, actor: Actor, enrolmentId: string, studentId: string, from: string) {
  const open = await t.query<{ id: string; status: string }>(
    `select c.id, p.status from fee_charge_participant p join fee_charge c on c.id = p.charge_id
      where p.enrolment_id = $1 and c.status in ('OPEN', 'CLOSED') and c.due_on >= $2::date and p.status in ('IN', 'AWAITING', 'WAITLIST', 'NO_REPLY', 'DECLINED', 'WITHDRAWN')`,
    [enrolmentId, from]);
  let released = 0, kept = 0;
  for (const o of open) {
    const c = await load(t, o.id);
    const net = await chargeNet(t, c, enrolmentId);
    const spent = net > 0 && (!!(await t.maybeOne('select 1 from fee_charge_payout where charge_id = $1 limit 1', [c.id])) || (!!c.refundable_until && from > c.refundable_until));
    if (spent) {
      if (c.mode === 'OPTIONAL') await set(t, c, enrolmentId, 'WITHDRAWN', actor, 'Moved to another NES school after the money was paid out; the charge stands');
      kept++;
      continue;
    }
    if (net > 0) await line(t, c, enrolmentId, studentId, -1, 'Moved to another NES school');
    await set(t, c, enrolmentId, 'EXCUSED', actor, 'Moved to another NES school');
    if (o.status === 'IN') await promoteWaitlist(t, c, actor);
    released++;
  }
  return { released, kept };
}

/**
 * A child arriving from another NES school joins the new school's open charges for the class:
 * optional ones ask the parent as for everyone else; a compulsory one is billed unless the same
 * kind of charge (a board registration) was already paid this year at the old school.
 */
export async function joinForTransfer(t: Db, actor: Actor, enrolmentId: string, studentId: string) {
  const e = await t.one<{ school_id: string; academic_year: string; class_code: string; section_id: string | null }>(
    'select school_id, academic_year, class_code, section_id from enrolment where id = $1', [enrolmentId]);
  const ids = await t.query<{ id: string }>(
    `select id from fee_charge where school_id = $1 and academic_year = $2 and status = 'OPEN' and $3 = any(class_codes)
       and (section_ids is null or $4::uuid = any(section_ids)) and due_on >= current_date`, [e.school_id, e.academic_year, e.class_code, e.section_id]);
  let billed = 0, asked = 0, paidBefore = 0;
  for (const { id } of ids) {
    const c = await load(t, id);
    if (await t.maybeOne('select 1 from fee_charge_participant where charge_id = $1 and enrolment_id = $2', [c.id, enrolmentId])) continue;
    if (c.mode === 'OPTIONAL') {
      await t.query(`insert into fee_charge_participant (charge_id, enrolment_id, status, note) values ($1, $2, 'AWAITING', '')`, [c.id, enrolmentId]);
      await notify.toParentsOf(t, [studentId], { kind: 'FEES', title: `${c.title}: please reply`, body: `${rupees(c.amount_paise)}. Tell the school by ${notify.fmt(c.respond_by!)} whether your child is taking part. You are charged only if you say yes.`, link: '/fees' });
      asked++;
      continue;
    }
    const before = await t.maybeOne<{ school: string }>(
      `select o.name as school from fee_due d join enrolment x on x.id = d.enrolment_id join org_unit o on o.id = x.school_id
        where x.student_id = $1 and x.academic_year = $2 and x.id <> $3 and d.head_code = $4 and d.charge_id is not null and d.owed_paise > 0 and d.paid_paise >= d.owed_paise limit 1`,
      [studentId, e.academic_year, enrolmentId, c.head_code]);
    if (before) {
      await t.query(`insert into fee_charge_participant (charge_id, enrolment_id, status, note, replied_by, replied_at) values ($1, $2, 'EXCUSED', $3, $4, now())`,
        [c.id, enrolmentId, `Already paid at ${before.school}`, actor.id]);
      paidBefore++;
      continue;
    }
    await t.query(`insert into fee_charge_participant (charge_id, enrolment_id, status, note) values ($1, $2, 'IN', 'Applies to every child in the class')`, [c.id, enrolmentId]);
    await line(t, c, enrolmentId, studentId, 1, 'Compulsory');
    billed++;
  }
  return { billed, asked, paidBefore };
}
