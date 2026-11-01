import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { post } from './ledger.js';
import * as notify from './notify.js';

/**
 * NES awards: cash prizes for toppers and the Outstanding Teacher Award. A school nominates, a
 * different NES officer approves (the database refuses self-approval), NES pays and the payment
 * is posted to the NES ledger. Every step is permanent.
 */
export async function schemes(db: Db) {
  return db.query(`select id, code, name, kind, amount_paise::int as amount_paise, criteria from award_scheme where valid @> current_date order by kind, amount_paise desc, name`);
}

export async function createScheme(db: Db, actor: Actor, input: { code: string; name: string; kind: 'STUDENT' | 'TEACHER'; amountPaise: number; criteria?: string; from: string }) {
  requireRole(actor, 'NES_ADMIN');
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into award_scheme (code, name, kind, amount_paise, criteria, valid, created_by) values ($1, $2, $3, $4, $5, daterange($6::date, null), $7) returning id`,
    [input.code, input.name.trim(), input.kind, input.amountPaise, input.criteria ?? '', input.from, actor.id]), { actor: actor.label });
  return r;
}

export async function nominate(db: Db, actor: Actor, input: { schemeId: string; schoolId: string; year: string; studentId?: string; teacherId?: string; citation: string; evidence?: Record<string, unknown> }) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN', 'COMMAND_OFFICER');
  await assertUnitInScope(db, actor, input.schoolId);
  if (input.studentId) {
    const e = await db.maybeOne('select 1 from enrolment where student_id = $1 and school_id = $2 and upper_inf(period)', [input.studentId, input.schoolId]);
    if (!e) throw invalid('The student is not currently at this school.');
  }
  if (input.teacherId) {
    const u = await db.maybeOne(`select 1 from app_user u join org_unit o on o.id = $2 where u.id = $1 and u.role = 'TEACHER' and u.scope_path <@ o.path`, [input.teacherId, input.schoolId]);
    if (!u) throw invalid('The teacher does not belong to this school.');
  }
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into award_nomination (scheme_id, school_id, academic_year, student_id, teacher_id, citation, evidence, nominated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.schemeId, input.schoolId, input.year, input.studentId ?? null, input.teacherId ?? null, input.citation.trim(), JSON.stringify(input.evidence ?? {}), actor.id]);
    const nes = await t.query<{ id: string }>(`select id from app_user where role = 'NES_ADMIN' and active and id <> $1`, [actor.id]);
    await notify.toUsers(t, nes.map((u) => u.id), { kind: 'AWARD', title: 'Award nomination to review', body: input.citation.trim().slice(0, 120), link: '/awards' });
    return r;
  }, { actor: actor.label });
}

async function nomination(db: Db, id: string) {
  const n = await db.maybeOne<{ id: string; status: string; school_id: string; student_id: string | null; teacher_id: string | null; amount_paise: number; scheme: string; nominee: string; nominated_by: string }>(
    `select n.id, n.status, n.school_id, n.student_id, n.teacher_id, s.amount_paise::int as amount_paise, s.name as scheme, n.nominated_by,
            coalesce(st.name, u.name) as nominee
       from award_nomination n join award_scheme s on s.id = n.scheme_id
       left join student st on st.id = n.student_id left join app_user u on u.id = n.teacher_id where n.id = $1`, [id]);
  if (!n) throw notFound('Nomination');
  return n;
}

export async function decide(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  requireRole(actor, 'NES_ADMIN');
  const n = await nomination(db, id);
  if (n.nominated_by === actor.id) throw invalid('A nomination must be approved by a different officer from the one who made it.');
  return db.tx(async (t) => {
    await t.query(`update award_nomination set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`,
      [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note?.trim() || null]);
    await notify.toUsers(t, [n.nominated_by], { kind: 'AWARD', title: approve ? `${n.scheme}: approved` : `${n.scheme}: not approved`, body: `${n.nominee}${note ? ` · ${note.trim()}` : ''}`, link: '/awards' });
    return { status: approve ? 'APPROVED' : 'REJECTED' };
  }, { actor: actor.label });
}

/** Records payment of an approved award and posts it to the NES ledger: awards expense against bank. */
export async function pay(db: Db, actor: Actor, id: string, paymentRef: string) {
  requireRole(actor, 'NES_ADMIN');
  const n = await nomination(db, id);
  if (n.status !== 'APPROVED') throw invalid('Only approved awards can be paid.');
  const nes = await db.one<{ id: string }>(`select id from org_unit where kind = 'society' order by name limit 1`);
  return db.tx(async (t) => {
    await t.query(`update award_nomination set status = 'PAID', paid_at = now(), payment_ref = $2 where id = $1`, [id, paymentRef.trim()]);
    await post(t, { schoolId: nes.id, narration: `${n.scheme} — ${n.nominee}`, sourceType: 'award', sourceId: id,
      lines: [{ account: '5200', debit: n.amount_paise, studentId: n.student_id }, { account: '1100', credit: n.amount_paise }] });
    if (n.student_id) await notify.toParentsOf(t, [n.student_id], { kind: 'AWARD', title: `Congratulations! ${n.scheme}`, body: `${n.nominee} has been awarded ₹${(n.amount_paise / 100).toLocaleString('en-IN')} by the Navy Education Society.`, link: '/results' });
    if (n.teacher_id) await notify.toUsers(t, [n.teacher_id], { kind: 'AWARD', title: `Congratulations! ${n.scheme}`, body: `Awarded ₹${(n.amount_paise / 100).toLocaleString('en-IN')} by the Navy Education Society.`, link: '/awards' });
    return { status: 'PAID' };
  }, { actor: actor.label });
}

export async function list(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  return db.query(
    `select n.id, n.status, n.academic_year, n.citation, n.evidence, n.nominated_at, n.decided_at, n.decision_note, n.paid_at, n.payment_ref,
            s.name as scheme, s.kind, s.amount_paise::int as amount_paise, o.name as school,
            coalesce(st.name, u.name) as nominee, nb.name as nominated_by, db.name as decided_by
       from award_nomination n join award_scheme s on s.id = n.scheme_id join org_unit o on o.id = n.school_id
       left join student st on st.id = n.student_id left join app_user u on u.id = n.teacher_id
       join app_user nb on nb.id = n.nominated_by left join app_user db on db.id = n.decided_by
      where o.path <@ $1::ltree order by (n.status = 'NOMINATED') desc, (n.status = 'APPROVED') desc, n.nominated_at desc limit 200`, [actor.scopePath]);
}

/** Awards a child has received, for the parent app. */
export async function forStudent(db: Db, studentId: string) {
  return db.query(
    `select s.name as scheme, s.amount_paise::int as amount_paise, n.academic_year, n.status, n.paid_at from award_nomination n
       join award_scheme s on s.id = n.scheme_id where n.student_id = $1 and n.status in ('APPROVED', 'PAID') order by n.decided_at desc`, [studentId]);
}
