import type { Db } from '../db/client.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { evaluate, type Facts, type Rule } from '../lib/rules.js';
import type { Actor } from './auth.js';
import * as settings from './settings.js';
import * as duties from './duties.js';
import * as notify from './notify.js';
import * as classTeachers from './classTeachers.js';

/**
 * Approval chains. A request (student leave, a fee waiver, a late attendance correction…) goes
 * through the steps set for its kind in Settings, filtered by the request's facts (for example
 * "principal too, if leave is 4 days or more"). The steps are frozen on the request, so changing
 * the chain later never affects requests already in progress. The database refuses
 * self-approval and one person deciding two steps.
 */

export interface Step { who: string; label: string; when?: Rule }
export interface Handler {
  /** Where the request belongs, used to find approvers. */
  context(db: Db, refId: string): Promise<{ schoolId: string; sectionId?: string | null }>;
  onApproved(t: Db, refId: string, actor: Actor, note: string): Promise<void>;
  onRejected(t: Db, refId: string, actor: Actor, note: string): Promise<void>;
  /** Checks that must pass before a step can be approved (e.g. a certificate is attached). */
  beforeApprove?(db: Db, refId: string): Promise<void>;
  link: string;
}

const handlers = new Map<string, Handler>();
export const register = (kind: string, h: Handler) => { handlers.set(kind, h); };
const handler = (kind: string) => { const h = handlers.get(kind); if (!h) throw new Error(`No approval handler for ${kind}`); return h; };

/** Starts a request inside the caller's transaction and notifies the first approvers. */
export async function start(t: Db, input: { kind: string; schoolId: string; refId: string; title: string; summary: string; facts: Facts; requestedBy: string; payload?: unknown }) {
  const chainDef = await settings.get<Step[]>(t, input.schoolId, `approval.${input.kind}`);
  const steps = chainDef.filter((s) => !s.when || evaluate(s.when, input.facts).ok).map(({ who, label }) => ({ who, label }));
  const r = await t.one<{ id: string }>(
    `insert into approval_request (school_id, kind, ref_id, title, summary, steps, requested_by, payload) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.schoolId, input.kind, input.refId, input.title, input.summary, JSON.stringify(steps), input.requestedBy, JSON.stringify(input.payload ?? {})]);
  await notifyStep(t, input.kind, input.refId, steps[0], input.schoolId, input.title, input.summary);
  return { id: r.id, steps };
}

/** People who can act on a step. */
async function approversFor(db: Db, step: { who: string }, ctx: { schoolId: string; sectionId?: string | null }) {
  if (step.who === 'CLASS_TEACHER') {
    if (!ctx.sectionId) return [];
    // The class teacher; the co-class teacher acts when the class teacher is away or not yet allotted.
    const o = await classTeachers.of(db, ctx.sectionId);
    return o.actingId ? [o.actingId] : [];
  }
  if (step.who === 'PRINCIPAL') return (await db.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [ctx.schoolId])).map((u) => u.id);
  if (step.who === 'NES_ADMIN') return (await db.query<{ id: string }>(`select id from app_user where active and role = 'NES_ADMIN'`)).map((u) => u.id);
  if (step.who.startsWith('DUTY:')) return (await db.query<{ user_id: string }>(`select user_id from duty where school_id = $1 and code = $2 and valid @> current_date`, [ctx.schoolId, step.who.slice(5)])).map((u) => u.user_id);
  return [];
}

async function canAct(db: Db, actor: Actor, step: { who: string }, ctx: { schoolId: string; sectionId?: string | null }) {
  if (step.who === 'PRINCIPAL') return actor.role === 'SCHOOL_ADMIN' && !!(await db.maybeOne('select 1 from org_unit where id = $1 and path <@ $2::ltree', [ctx.schoolId, actor.scopePath ?? '']));
  if (step.who === 'NES_ADMIN') return actor.role === 'NES_ADMIN';
  if (step.who.startsWith('DUTY:')) return duties.has(db, actor.id, ctx.schoolId, step.who.slice(5));
  return (await approversFor(db, step, ctx)).includes(actor.id);
}

async function notifyStep(t: Db, kind: string, refId: string, step: { who: string; label: string } | undefined, schoolId: string, title: string, summary: string) {
  if (!step) return;
  const h = handler(kind);
  const ctx = { ...(await h.context(t, refId)), schoolId };
  const users = await approversFor(t, step, ctx);
  await notify.toUsers(t, users, { kind: 'LEAVE', title: `For your approval: ${title}`, body: summary.slice(0, 140), link: '/approvals' });
}

interface RequestRow { id: string; kind: string; ref_id: string; school_id: string; title: string; summary: string; steps: { who: string; label: string }[]; current_step: number; status: string; requested_by: string }

export async function forRef(db: Db, kind: string, refId: string) {
  return db.maybeOne<RequestRow>('select id, kind, ref_id, school_id, title, summary, steps, current_step, status, requested_by from approval_request where kind = $1 and ref_id = $2', [kind, refId]);
}

/** Approves or rejects the current step. The last approval, or any rejection, closes the request. */
export async function decide(db: Db, actor: Actor, requestId: string, approve: boolean, note = '') {
  const r = await db.maybeOne<RequestRow>('select id, kind, ref_id, school_id, title, summary, steps, current_step, status, requested_by from approval_request where id = $1', [requestId]);
  if (!r) throw notFound('Request');
  if (r.status !== 'PENDING') throw conflict('closed', 'This request has already been decided.');
  const h = handler(r.kind);
  const ctx = { ...(await h.context(db, r.ref_id)), schoolId: r.school_id };
  const step = r.steps[r.current_step - 1];
  if (!(await canAct(db, actor, step, ctx))) throw forbidden(`This step is for the ${step.label.toLowerCase()}.`);
  if (approve && h.beforeApprove) await h.beforeApprove(db, r.ref_id);
  return db.tx(async (t) => {
    await t.query(`insert into approval_decision (request_id, step_no, decision, decided_by, note) values ($1, $2, $3, $4, $5)`,
      [r.id, r.current_step, approve ? 'APPROVE' : 'REJECT', actor.id, note.trim()]);
    if (!approve) {
      await t.query(`update approval_request set status = 'REJECTED', closed_at = now() where id = $1`, [r.id]);
      await h.onRejected(t, r.ref_id, actor, note.trim());
      return { status: 'REJECTED' };
    }
    if (r.current_step >= r.steps.length) {
      await t.query(`update approval_request set status = 'APPROVED', closed_at = now() where id = $1`, [r.id]);
      await h.onApproved(t, r.ref_id, actor, note.trim());
      return { status: 'APPROVED' };
    }
    await t.query(`update approval_request set current_step = current_step + 1 where id = $1`, [r.id]);
    await notifyStep(t, r.kind, r.ref_id, r.steps[r.current_step], r.school_id, r.title, r.summary);
    return { status: 'PENDING', nextStep: r.steps[r.current_step].label };
  }, { actor: actor.label });
}

export async function cancel(t: Db, kind: string, refId: string) {
  await t.query(`update approval_request set status = 'CANCELLED', closed_at = now() where kind = $1 and ref_id = $2 and status = 'PENDING'`, [kind, refId]);
}

/** Requests waiting for this person, oldest first. */
export async function inbox(db: Db, actor: Actor) {
  if (!actor.scopePath) return [];
  const open = await db.query<RequestRow & { requested_at: string; requester: string; school: string }>(
    `select r.id, r.kind, r.ref_id, r.school_id, r.title, r.summary, r.steps, r.current_step, r.status, r.requested_by, r.requested_at, u.name as requester, o.name as school
       from approval_request r join org_unit o on o.id = r.school_id join app_user u on u.id = r.requested_by
      where r.status = 'PENDING' and o.path <@ $1::ltree order by r.requested_at limit 300`, [actor.scopePath]);
  const mine = [];
  for (const r of open) {
    const h = handlers.get(r.kind);
    if (!h) continue;
    const ctx = { ...(await h.context(db, r.ref_id)), schoolId: r.school_id };
    if (r.requested_by !== actor.id && await canAct(db, actor, r.steps[r.current_step - 1], ctx)) {
      const decisions = await db.query(`select d.step_no, d.decision, d.note, u.name as by, d.decided_at from approval_decision d join app_user u on u.id = d.decided_by where d.request_id = $1 order by d.step_no`, [r.id]);
      mine.push({ ...r, step: r.steps[r.current_step - 1], decisions, link: h.link });
    }
  }
  return mine;
}

/** Progress of a request for display next to its record. */
export async function progress(db: Db, kind: string, refId: string) {
  const r = await forRef(db, kind, refId);
  if (!r) return null;
  const decisions = await db.query<{ step_no: number; decision: string; by: string; note: string }>(
    `select d.step_no, d.decision, u.name as by, d.note from approval_decision d join app_user u on u.id = d.decided_by where d.request_id = $1 order by d.step_no`, [r.id]);
  return { id: r.id, status: r.status, steps: r.steps.map((s, i) => ({ ...s, done: decisions.find((d) => d.step_no === i + 1) ?? null, current: r.status === 'PENDING' && i + 1 === r.current_step })) };
}
