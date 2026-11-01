import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import { open as unseal, seal } from '../lib/secret.js';
import type { Actor } from './auth.js';
import { assertStudentAccess, can } from './access.js';
import * as notify from './notify.js';
import * as messages from './messages.js';

/**
 * Tickets for faults, wrong records, extra requirements and access, and fixes without exposing
 * anyone's data. There is no chat: a user raises a ticket from the page they are on (the module is
 * worked out from the page, and "this record" can be attached with the detail that is wrong and
 * what it should be), then follows its progress and the resolution.
 *
 * The helpdesk works on tickets by hand from the desk. NES can also switch on the AI assistant
 * (off by default): it works only on faults and wrong records, through a signed, logged API that
 * returns only redacted text and opaque record references, never a name, phone number or a
 * school's records. It never writes to users; it sorts tickets and proposes fixes.
 *
 * Agents cannot change anything themselves. They propose: a data correction (applied by the system
 * through the same rules as the screens, once the department that owns the record approves and
 * sees the current and proposed values side by side), a repair (recalculating or resending, which
 * changes no data), a setting change, or a code change (which only the developer can accept).
 * Anything risky, unusual or a new feature goes to the developer before any work.
 */

export const MODULES: Record<string, string> = {
  admissions: 'Admissions', students: 'Students and records', attendance: 'Attendance', homework: 'Homework', timetable: 'Timetable and cover',
  exams: 'Exams, marks and report cards', fees: 'Fees and payments', transport: 'Transport', library: 'Library', certificates: 'Certificates and ID cards',
  staff: 'Staff and service book', payroll: 'Payroll and salaries', accounts: 'Accounts and bank', chat: 'Chat and messages', website: 'School website',
  recruitment: 'Recruitment', cwt: 'Common Written Test', parentapp: 'Parent app', signin: 'Signing in', other: 'Something else',
};
/** The page a ticket is raised from decides its module (nobody has to choose it). */
export function moduleOf(page: string | null | undefined) {
  const p = (page ?? '').toLowerCase();
  const map: [RegExp, string][] = [[/admission|incoming/, 'admissions'], [/student/, 'students'], [/attendance|register/, 'attendance'], [/homework/, 'homework'], [/timetable|cover/, 'timetable'],
    [/exam|mark|result|report/, 'exams'], [/fee|pay(ment)?s?$|charges|\/pay\b/, 'fees'], [/transport|bus/, 'transport'], [/library/, 'library'], [/certificate|card|print/, 'certificates'],
    [/staff|duties|class-teachers/, 'staff'], [/payroll|pay-structures|my\/pay/, 'payroll'], [/accounts/, 'accounts'], [/chat|messages|notices/, 'chat'], [/website|\/s\//, 'website'],
    [/careers|recruit|vacanc|application/, 'recruitment'], [/cwt/, 'cwt']];
  return map.find(([re]) => re.test(p))?.[1] ?? 'other';
}

const SLA_HOURS: Record<string, number> = { URGENT: 4, HIGH: 24, NORMAL: 72, LOW: 168 };

// ── Redaction: what an agent may read ─────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Removes personal data from text before any agent sees it: emails, phone numbers, long numbers
 * (Aadhaar, accounts, admission numbers), PAN, and the names of people known to the school
 * (whole names, then their individual parts).
 */
export function redact(text: string, names: string[]) {
  // Dates stay (a date alone identifies nobody, and agents need them to understand the problem).
  const dates: string[] = [];
  let s = text.replace(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/g, (d) => { dates.push(d); return `\u0000${dates.length - 1}\u0000`; })
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[EMAIL]')
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[PAN]')
    .replace(/\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*[-/][A-Z0-9]*\d{3,}[A-Z0-9]*\b/g, '[RECORD NO]')
    .replace(/(\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, '[PHONE]')
    .replace(/\b\d[\d\s-]{4,}\d\b/g, '[NUMBER]');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => dates[Number(i)]);
  const full = [...new Set(names.map((n) => n.replace(/^(Mr|Mrs|Ms|Dr|Shri|Smt|Lt Cdr|Cdr|Capt|PO|Lt)\.?\s+/i, '').trim()).filter((n) => n.length > 3))].sort((a, b) => b.length - a.length);
  for (const n of full) s = s.replace(new RegExp(`\\b${esc(n)}\\b`, 'gi'), '[NAME]');
  const parts = [...new Set(full.flatMap((n) => n.split(/\s+/)).filter((p) => p.length >= 4))];
  for (const p of parts) s = s.replace(new RegExp(`\\b${esc(p)}\\b`, 'g'), '[NAME]');
  return s;
}

async function namesFor(t: Db, schoolId: string | null, raisedBy: string) {
  const own = await t.query<{ name: string }>('select name from app_user where id = $1', [raisedBy]);
  if (!schoolId) return own.map((x) => x.name);
  const rows = await t.query<{ name: string }>(
    `select s.name from enrolment e join student s on s.id = e.student_id where e.school_id = $1
     union select u.name from employee e join app_user u on u.id = e.user_id where e.school_id = $1
     union select g.name from enrolment e join student_guardian sg on sg.student_id = e.student_id join guardian g on g.id = sg.guardian_id where e.school_id = $1`, [schoolId]);
  return [...own, ...rows].map((x) => x.name);
}

async function schoolOfUser(t: Db, actor: Actor) {
  if (actor.role === 'PARENT') return (await t.maybeOne<{ id: string }>(`select e.school_id as id from student_guardian sg join enrolment e on e.student_id = sg.student_id where sg.guardian_id = $1 and upper_inf(e.period) order by lower(e.period) desc limit 1`, [actor.guardianId]))?.id ?? null;
  if (!actor.scopePath) return null;
  return (await t.maybeOne<{ id: string }>(`select id from org_unit where kind = 'school' and $1::ltree <@ path`, [actor.scopePath]))?.id ?? null;
}

// ── Tickets (any user) ────────────────────────────────────────────────────────────────────

export interface TicketInput { category: 'PROBLEM' | 'DATA' | 'REQUEST' | 'ACCESS'; module?: string; title: string; description: string; severity?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'; page?: string;
  refs?: { entityType: 'STUDENT' | 'GUARDIAN' | 'STAFF' | 'PAYROLL_RUN' | 'ROUTE' | 'SCHOOL' | 'VACANCY' | 'APPLICATION'; entityId: string; field?: string; correctValue?: string }[] }

/** A user may attach only a record they can see themself. */
async function assertCanRef(db: Db, actor: Actor, r: { entityType: string; entityId: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(r.entityId)) throw invalid('That record is not recognised.');
  if (r.entityType === 'STUDENT') { await assertStudentAccess(db, actor, r.entityId, 'profile'); return; }
  if (r.entityType === 'STAFF') {
    if (r.entityId === actor.id) return;
    const e = await db.maybeOne<{ school_id: string }>('select school_id from employee where user_id = $1', [r.entityId]);
    if (!e || !(await can(db, actor, 'staff.view', e.school_id))) throw forbidden('You cannot attach that staff record.');
    return;
  }
  if (r.entityType === 'GUARDIAN') {
    if (actor.guardianId === r.entityId) return;
    const kid = await db.maybeOne<{ student_id: string }>('select student_id from student_guardian where guardian_id = $1 limit 1', [r.entityId]);
    if (!kid) throw notFound('Parent');
    await assertStudentAccess(db, actor, kid.student_id, 'contact');
    return;
  }
  // Other records are attached for context only; the fix catalogue decides what can be changed.
}

export async function createTicket(db: Db, actor: Actor, input: TicketInput) {
  if (input.title.trim().length < 4) throw invalid('Give the ticket a short title.');
  if (input.description.trim().length < 10) throw invalid('Describe what happened, in a sentence or two.');
  for (const r of input.refs ?? []) await assertCanRef(db, actor, r);
  const schoolId = await schoolOfUser(db, actor);
  const module = input.module && MODULES[input.module] ? input.module : moduleOf(input.page);
  const severity = input.severity ?? 'NORMAL';
  return db.tx(async (t) => {
    const names = await namesFor(t, schoolId, actor.id);
    const tk = await t.one<{ id: string; number: string }>(
      `insert into ticket (raised_by, school_id, category, module, title, description, page, redacted_title, redacted_description, severity, due_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + $11 * interval '1 hour') returning id, number`,
      [actor.id, schoolId, input.category, module, input.title.trim(), input.description.trim(), input.page ?? null, redact(input.title.trim(), names), redact(input.description.trim(), names), severity, SLA_HOURS[severity]]);
    for (const r of input.refs ?? []) {
      if (r.field && !FIELDS[r.entityType]?.[r.field]) throw invalid('That detail cannot be corrected from a ticket.');
      await t.query('insert into ticket_ref (ref, ticket_id, entity_type, entity_id, field, correct_value) values ($1, $2, $3, $4, $5, $6)',
        [`R${randomBytes(6).toString('hex').toUpperCase()}`, tk.id, r.entityType, r.entityId, r.field ?? null, r.correctValue?.trim() || null]);
    }
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: `Received. ${input.category === 'REQUEST' ? 'Requests for something new are looked at by the helpdesk and decided by the developer.' : 'The helpdesk will look into it.'}`, schoolId, raisedBy: actor.id });
    const desk = await t.query<{ id: string }>(`select id from app_user where active and role in ('SUPPORT', 'DEVELOPER')`);
    await notify.toUsers(t, desk.map((d) => d.id), { kind: 'SUPPORT', title: `${tk.number}: ${redact(input.title.trim(), names)}`, body: `${MODULES[module]} · ${severity.toLowerCase()}`, link: `/support/${tk.number}` });
    return { id: tk.id, number: tk.number, module, dueAt: null };
  }, { actor: actor.label });
}

async function loadTicket(db: Db, number: string) {
  const t = await db.maybeOne<{ id: string; number: string; raised_by: string; school_id: string | null; status: string; category: string; module: string; title: string; needs_developer: boolean; developer_decision: string | null }>(
    'select id, number, raised_by, school_id, status, category, module, title, needs_developer, developer_decision from ticket where number = $1', [number.toUpperCase()]);
  if (!t) throw notFound('Ticket');
  return t;
}

const isDesk = (a: Actor) => ['SUPPORT', 'DEVELOPER', 'NES_ADMIN'].includes(a.role);

export async function myTickets(db: Db, actor: Actor) {
  return db.query(
    `select t.number, t.category, t.module, t.title, t.status, t.severity, t.created_at, t.updated_at, t.resolution, t.rating
       from ticket t where t.raised_by = $1 order by t.updated_at desc limit 100`, [actor.id]);
}

/**
 * One ticket for the person who raised it (full text, its progress and the resolution) or the desk
 * (redacted unless NES, with internal notes and what can be corrected on the attached records).
 */
export async function ticket(db: Db, actor: Actor, number: string) {
  const tk = await loadTicket(db, number);
  const own = tk.raised_by === actor.id;
  if (!own && !isDesk(actor)) throw forbidden();
  const full = own || actor.role === 'NES_ADMIN';
  const row = await db.one(
    `select t.number, t.category, t.module, t.status, t.severity, t.page, t.created_at, t.updated_at, t.due_at, t.resolved_at, t.resolution, t.rating, t.ai_summary, t.needs_developer, t.developer_decision, t.developer_note,
            ${full ? 't.title, t.description' : 't.redacted_title as title, t.redacted_description as description'},
            ${full ? 'u.name' : `'[NAME]'`} as raised_by, u.role as raised_by_role, o.name as school, a.name as assigned_to, r.name as resolved_by
       from ticket t join app_user u on u.id = t.raised_by left join org_unit o on o.id = t.school_id left join support_agent a on a.id = t.assigned_agent_id left join support_agent r on r.id = t.resolved_by_agent_id
      where t.id = $1`, [tk.id]);
  const msgs = await db.query(
    `select m.id, m.author_kind, ${full ? 'm.body' : 'm.redacted_body as body'}, m.internal, m.created_at, coalesce(sa.name, case when m.author_kind = 'USER' then ${full ? 'u.name' : `'[NAME]'`} end, 'NavShiksha') as author
       from ticket_message m left join support_agent sa on sa.id = m.agent_id left join app_user u on u.id = m.author_user_id
      where m.ticket_id = $1 and ($2 or (m.author_kind = 'SYSTEM' and not m.internal)) order by m.id`, [tk.id, !own]);
  const fixes = await db.query(`select number, kind, field, action, summary, status, risk, created_at, decision_note, developer_note, result from fix_proposal where ticket_id = $1 order by created_at`, [tk.id]);
  const refs = (await db.query<{ ref: string; entity_type: string; field: string | null; has_value: boolean }>('select ref, entity_type, field, correct_value is not null as has_value from ticket_ref where ticket_id = $1', [tk.id]))
    .map((r) => (own ? { ref: r.ref, entity_type: r.entity_type } : { ref: r.ref, entity_type: r.entity_type, correctableFields: Object.fromEntries(Object.entries(FIELDS[r.entity_type] ?? {}).map(([k, d]) => [k, d.label])), userSaysWrong: r.field, userGaveCorrectValue: r.has_value }));
  return { ...row, progress: own ? msgs : undefined, notes: own ? undefined : msgs, fixes, refs };
}

async function addMessage(t: Db, ticketId: string, m: { kind: 'USER' | 'AGENT' | 'STAFF' | 'SYSTEM'; userId?: string | null; agentId?: string | null; body: string; internal?: boolean; schoolId: string | null; raisedBy: string }) {
  const names = await namesFor(t, m.schoolId, m.raisedBy);
  await t.query(`insert into ticket_message (ticket_id, author_kind, author_user_id, agent_id, body, redacted_body, internal) values ($1,$2,$3,$4,$5,$6,$7)`,
    [ticketId, m.kind, m.userId ?? null, m.agentId ?? null, m.body.trim(), redact(m.body.trim(), names), !!m.internal]);
  await t.query('update ticket set updated_at = now() where id = $1', [ticketId]);
}

/** Tells the person who raised the ticket that it has moved on (in NavShiksha, and by email). */
async function tellUser(t: Db, tk: { id: string; number: string; title: string; raised_by: string }, status: string, note: string) {
  await notify.toUsers(t, [tk.raised_by], { kind: 'SUPPORT', title: `${tk.number}: ${status}`, body: note.slice(0, 160), link: `/help/${tk.number}` });
  const u = await t.one<{ email: string | null }>('select email from app_user where id = $1', [tk.raised_by]);
  if (u.email) await messages.queue(t, { template: 'TICKET_UPDATE_EMAIL', to: u.email, vars: { number: tk.number, title: tk.title, status, note }, context: 'SUPPORT', refType: 'ticket', refId: tk.number });
}

/** If it is not fixed after all, the person who raised it can reopen it once, saying why. */
export async function reopen(db: Db, actor: Actor, number: string, why: string) {
  const tk = await loadTicket(db, number);
  if (tk.raised_by !== actor.id) throw forbidden();
  if (tk.status !== 'RESOLVED') throw conflict('state', 'Only a resolved ticket can be reopened.');
  if (why.trim().length < 5) throw invalid('Say what is still wrong.');
  if ((await db.one<{ n: number }>(`select count(*)::int as n from ticket_message where ticket_id = $1 and author_kind = 'USER'`, [tk.id])).n >= 2) throw conflict('limit', 'This ticket has been reopened twice. Please raise a new one.');
  await db.tx(async (t) => {
    await addMessage(t, tk.id, { kind: 'USER', userId: actor.id, body: `Reopened: ${why.trim()}`, internal: true, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: 'Reopened; the helpdesk will look again.', schoolId: tk.school_id, raisedBy: tk.raised_by });
    await t.query(`update ticket set status = 'IN_PROGRESS', resolved_at = null, resolution = null, updated_at = now() where id = $1`, [tk.id]);
  }, { actor: actor.label });
  return { status: 'IN_PROGRESS' };
}

export async function rate(db: Db, actor: Actor, number: string, rating: number) {
  const tk = await loadTicket(db, number);
  if (tk.raised_by !== actor.id) throw forbidden();
  if (!['RESOLVED', 'CLOSED'].includes(tk.status)) throw conflict('open', 'Rate the ticket once it is resolved.');
  await db.tx((t) => t.query(`update ticket set rating = $2, status = 'CLOSED', updated_at = now() where id = $1`, [tk.id, rating]), { actor: actor.label });
  return { ok: true };
}

// ── The desk (helpdesk staff, the developer, NES) ─────────────────────────────────────────

export async function deskList(db: Db, actor: Actor, q: { status?: string; category?: string; module?: string; agent?: string; sort?: string; search?: string }) {
  if (!isDesk(actor)) throw forbidden();
  const full = actor.role === 'NES_ADMIN';
  const order = { newest: 't.created_at desc', oldest: 't.created_at', due: 't.due_at', severity: `array_position(array['URGENT','HIGH','NORMAL','LOW'], t.severity), t.due_at`,
    agent: 'r.name nulls last, t.resolved_at desc', assigned: 'a.name nulls last, t.updated_at desc', updated: 't.updated_at desc' }[q.sort ?? 'due'] ?? 't.due_at';
  return db.query(
    `select t.number, t.category, t.module, t.status, t.severity, t.created_at, t.updated_at, t.due_at, t.resolved_at, t.needs_developer, t.rating,
            ${full ? 't.title' : 't.redacted_title as title'}, o.code as school_code, a.name as assigned_to, r.name as resolved_by, t.due_at < now() and t.status not in ('RESOLVED', 'CLOSED', 'REJECTED') as overdue,
            (select count(*) from fix_proposal f where f.ticket_id = t.id and f.status in ('DEVELOPER_REVIEW', 'PROPOSED'))::int as open_fixes
       from ticket t left join org_unit o on o.id = t.school_id left join support_agent a on a.id = t.assigned_agent_id left join support_agent r on r.id = t.resolved_by_agent_id
      where ($1::text is null or t.status = any(string_to_array($1, ','))) and ($2::text is null or t.category = $2) and ($3::text is null or t.module = $3)
        and ($4::text is null or a.name = $4 or r.name = $4) and ($5::text is null or t.redacted_title ilike '%' || $5 || '%' or t.number = upper($5))
      order by ${order} limit 500`, [q.status ?? null, q.category ?? null, q.module ?? null, q.agent ?? null, q.search ?? null]);
}

/** Resolutions by agent: how many each resolved, how fast, and how they were rated. */
export async function agentStats(db: Db, actor: Actor) {
  if (!isDesk(actor)) throw forbidden();
  return db.query(
    `select a.name, a.kind, a.active, count(t.id)::int as resolved, round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600)::numeric, 1)::float as avg_hours,
            round(avg(t.rating)::numeric, 1)::float as avg_rating, (select count(*) from fix_proposal f where f.agent_id = a.id and f.status = 'APPLIED')::int as fixes_applied,
            (select count(*) from ticket x where x.assigned_agent_id = a.id and x.status not in ('RESOLVED', 'CLOSED', 'REJECTED'))::int as open, a.last_seen_at
       from support_agent a left join ticket t on t.resolved_by_agent_id = a.id group by a.id order by a.name`);
}

/**
 * The desk person's own agent identity (made the first time they act, so the helpdesk needs no
 * set-up). Everything they do is recorded against it, so resolutions can be sorted by agent.
 */
async function deskAgent(db: Db, actor: Actor): Promise<Agent> {
  if (!isDesk(actor)) throw forbidden();
  let a = await db.maybeOne<{ id: string; name: string; kind: Agent['kind']; active: boolean }>('select id, name, kind, active from support_agent where user_id = $1', [actor.id]);
  if (!a) {
    const kind = actor.role === 'DEVELOPER' ? 'DEVELOPER' : 'HUMAN';
    a = await db.tx((t) => t.one<{ id: string; name: string; kind: Agent['kind']; active: boolean }>(
      `insert into support_agent (name, kind, user_id, key_id, secret_cipher, scopes, created_by) values ($1, $2, $3, $4, $5, $6, $3) returning id, name, kind, active`,
      [actor.name, kind, actor.id, `nsk_${randomBytes(8).toString('hex')}`, seal(randomBytes(32).toString('base64url')), ['READ', 'REPLY', 'PROPOSE']]), { actor: actor.label });
  }
  if (!a.active) throw forbidden('Your helpdesk access is switched off.');
  return { id: a.id, name: a.name, kind: a.kind, scopes: ['READ', 'REPLY', 'PROPOSE'] };
}

/** The manual workflow: the same steps the AI can take, done by a person at the desk. */
export async function deskTake(db: Db, actor: Actor, number: string) {
  const a = await deskAgent(db, actor);
  const tk = await loadTicket(db, number);
  if (['RESOLVED', 'CLOSED', 'REJECTED'].includes(tk.status)) throw conflict('closed', 'This ticket is closed.');
  await db.tx((t) => t.query(`update ticket set assigned_agent_id = $2, first_response_at = coalesce(first_response_at, now()), status = case when status = 'NEW' then 'TRIAGED' else status end, updated_at = now() where id = $1`, [tk.id, a.id]), { actor: actor.label });
  return { assignedTo: a.name };
}
export async function deskNote(db: Db, actor: Actor, number: string, body: string) { return agentMessage(db, await deskAgent(db, actor), number, { body, internal: true }); }
export async function deskTriage(db: Db, actor: Actor, number: string, input: Parameters<typeof agentTriage>[3]) { return agentTriage(db, await deskAgent(db, actor), number, input); }
export async function deskPropose(db: Db, actor: Actor, number: string, input: Parameters<typeof agentPropose>[3]) { return agentPropose(db, await deskAgent(db, actor), number, input); }
export async function deskResolve(db: Db, actor: Actor, number: string, resolution: string) { return agentResolve(db, await deskAgent(db, actor), number, resolution); }

/** Not a fault, or not something NavShiksha will do: closed with the reason, which the user sees. */
export async function deskReject(db: Db, actor: Actor, number: string, reason: string) {
  const a = await deskAgent(db, actor);
  const tk = await loadTicket(db, number);
  if (['CLOSED', 'REJECTED'].includes(tk.status)) throw conflict('closed', 'This ticket is closed.');
  if (reason.trim().length < 5) throw invalid('Give the reason; the user sees it.');
  if (await db.maybeOne(`select 1 from fix_proposal where ticket_id = $1 and status in ('DEVELOPER_REVIEW', 'PROPOSED')`, [tk.id])) throw conflict('fix_open', 'A fix is still waiting for approval.');
  await db.tx(async (t) => {
    await t.query(`update ticket set status = 'REJECTED', resolution = $2, resolved_by_agent_id = $3, resolved_at = now(), updated_at = now() where id = $1`, [tk.id, reason.trim(), a.id]);
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: `Closed: ${reason.trim()}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await tellUser(t, tk, 'closed', reason.trim());
  }, { actor: actor.label });
  return { status: 'REJECTED' };
}

// ── Switching the AI assistant on or off (NES) ────────────────────────────────────────────

const society = (db: Db) => db.one<{ id: string }>(`select id from org_unit where kind = 'society'`).then((r) => r.id);
export async function aiEnabled(db: Db) {
  const { get } = await import('./settings.js');
  return get<boolean>(db, await society(db), 'support.ai_assistant');
}
/** NES switches the AI assistant on or off from today (kept in the settings history). */
export async function setAi(db: Db, actor: Actor, on: boolean) {
  if (actor.role !== 'NES_ADMIN') throw forbidden('NES decides whether the AI assistant works on tickets.');
  const { set } = await import('./settings.js');
  await set(db, actor, await society(db), { key: 'support.ai_assistant', value: on, from: localToday(), note: on ? 'AI assistant switched on' : 'AI assistant switched off' });
  return { on };
}

/** The developer accepts a ticket for work (or declines it, with the reason given to the user). */
export async function developerDecide(db: Db, actor: Actor, number: string, approve: boolean, note: string) {
  if (actor.role !== 'DEVELOPER') throw forbidden('Only the developer decides this.');
  const tk = await loadTicket(db, number);
  if (!tk.needs_developer) throw conflict('not_needed', 'This ticket is not waiting for the developer.');
  if (note.trim().length < 4) throw invalid('Give a short reason; it is shown to the user.');
  await db.tx(async (t) => {
    await t.query(`update ticket set developer_decision = $2, developer_note = $3, developer_by = $4, status = $5, updated_at = now(), resolved_at = case when $2 = 'DECLINED' then now() else resolved_at end where id = $1`,
      [tk.id, approve ? 'APPROVED' : 'DECLINED', note.trim(), actor.id, approve ? 'IN_PROGRESS' : 'REJECTED']);
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: approve ? `The developer accepted this for work: ${note.trim()}` : `Not taken up: ${note.trim()}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await tellUser(t, tk, approve ? 'accepted for work' : 'not taken up', note.trim());
  }, { actor: actor.label });
  return { decision: approve ? 'APPROVED' : 'DECLINED' };
}

// ── Agents: identities, keys and the signed API ───────────────────────────────────────────

/** NES makes an agent (the helpdesk person, the developer, or the AI). The secret is shown once. */
export async function createAgent(db: Db, actor: Actor, input: { name: string; kind: 'AI' | 'HUMAN' | 'DEVELOPER'; userId?: string | null; scopes?: string[] }) {
  if (actor.role !== 'NES_ADMIN') throw forbidden('Agents are set up by NES.');
  if (input.userId) {
    const u = await db.maybeOne<{ role: string }>('select role from app_user where id = $1', [input.userId]);
    if (!u || !['SUPPORT', 'DEVELOPER', 'NES_ADMIN'].includes(u.role)) throw invalid('Link the agent to a helpdesk or developer sign-in.');
  }
  const keyId = `nsk_${randomBytes(8).toString('hex')}`, secret = randomBytes(32).toString('base64url');
  const r = await db.tx((t) => t.one<{ id: string }>(`insert into support_agent (name, kind, user_id, key_id, secret_cipher, scopes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [input.name.trim(), input.kind, input.userId ?? null, keyId, seal(secret), input.scopes ?? ['READ', 'REPLY', 'PROPOSE'], actor.id]), { actor: actor.label });
  return { id: r.id, keyId, secret, note: 'Keep the secret safe: it is not shown again. The agent signs every request with it.' };
}

export async function rotateAgent(db: Db, actor: Actor, id: string) {
  if (actor.role !== 'NES_ADMIN') throw forbidden();
  const secret = randomBytes(32).toString('base64url');
  const r = await db.tx((t) => t.query('update support_agent set secret_cipher = $2 where id = $1 returning key_id', [id, seal(secret)]), { actor: actor.label });
  if (!r.length) throw notFound('Agent');
  return { keyId: (r[0] as { key_id: string }).key_id, secret };
}

export async function setAgentActive(db: Db, actor: Actor, id: string, active: boolean) {
  if (actor.role !== 'NES_ADMIN') throw forbidden();
  await db.tx((t) => t.query('update support_agent set active = $2 where id = $1', [id, active]), { actor: actor.label });
  return { active };
}

export interface Agent { id: string; name: string; kind: 'AI' | 'HUMAN' | 'DEVELOPER'; scopes?: string[] }
const rate60 = new Map<string, number[]>();

/** The string an agent signs: timestamp, method, path and the body's SHA-256, one per line. */
export const signingString = (ts: string, method: string, path: string, bodyText: string) => `${ts}\n${method.toUpperCase()}\n${path}\n${createHash('sha256').update(bodyText).digest('hex')}`;
export const sign = (secret: string, ts: string, method: string, path: string, bodyText: string) => createHmac('sha256', secret).update(signingString(ts, method, path, bodyText)).digest('hex');

/**
 * Checks an agent request: a known, active key; a timestamp within five minutes; an HMAC-SHA256
 * signature over the request made with the agent's secret; never the same signature twice; and at
 * most 120 requests a minute. In production the request must have come over HTTPS.
 */
export async function authenticateAgent(db: Db, h: { key?: string; ts?: string; sig?: string; proto?: string }, method: string, path: string, bodyText: string): Promise<Agent> {
  if (process.env.NODE_ENV === 'production' && h.proto !== 'https') throw new AppError(403, 'https_only', 'The agent API is reachable over HTTPS only.');
  if (!h.key || !h.ts || !h.sig) throw new AppError(401, 'unsigned', 'Sign the request (X-NS-Key, X-NS-Timestamp, X-NS-Signature).');
  const a = await db.maybeOne<{ id: string; name: string; kind: Agent['kind']; secret_cipher: string; scopes: string[]; active: boolean }>('select id, name, kind, secret_cipher, scopes, active from support_agent where key_id = $1', [h.key]);
  if (!a || !a.active) throw new AppError(401, 'unknown_agent', 'Unknown or disabled agent.');
  if (a.kind === 'AI' && !(await aiEnabled(db))) throw new AppError(403, 'ai_off', 'The AI assistant is switched off by NES; tickets are handled by the helpdesk.');
  if (!/^\d{13}$/.test(h.ts) || Math.abs(Date.now() - Number(h.ts)) > 300_000) throw new AppError(401, 'stale', 'The request is too old or its clock is wrong.');
  const expected = Buffer.from(sign(unseal(a.secret_cipher), h.ts, method, path, bodyText), 'hex'), got = Buffer.from(h.sig, 'hex');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new AppError(401, 'bad_signature', 'The signature does not match.');
  const used = await db.query(`insert into agent_nonce (agent_id, signature) values ($1, $2) on conflict do nothing returning 1`, [a.id, h.sig]);
  if (!used.length) throw new AppError(401, 'replayed', 'This request was already used.');
  const now = Date.now(), hits = (rate60.get(a.id) ?? []).filter((x) => now - x < 60_000);
  if (hits.length >= 120) throw new AppError(429, 'slow_down', 'Too many requests.');
  rate60.set(a.id, [...hits, now]);
  await db.query(`update support_agent set last_seen_at = now() where id = $1`, [a.id]);
  if (Math.random() < 0.02) await db.query(`delete from agent_nonce where at < now() - interval '10 minutes'`);
  return { id: a.id, name: a.name, kind: a.kind, scopes: a.scopes };
}

export async function logCall(db: Db, agentId: string, method: string, path: string, status: number) {
  await db.query('insert into agent_call (agent_id, method, path, status) values ($1, $2, $3, $4)', [agentId, method, path.slice(0, 200), status]);
}

const needScope = (a: Agent, s: string) => { if (a.scopes && !a.scopes.includes(s)) throw forbidden(`This agent may not ${s.toLowerCase()}.`); };

/**
 * Tickets for an agent. "Waiting" means new or reopened and not yet taken by a person. The AI only
 * gets faults and wrong records; requests for something new and access problems are for people.
 */
export async function agentQueue(db: Db, agent: Agent, q: { status?: string; waiting?: boolean }) {
  needScope(agent, 'READ');
  return db.query(
    `select t.number, t.category, t.module, t.status, t.severity, t.redacted_title as title, t.created_at, t.updated_at, t.due_at, t.needs_developer, t.developer_decision
       from ticket t left join support_agent a on a.id = t.assigned_agent_id
      where ($1::text is null or t.status = any(string_to_array($1, ','))) and t.status not in ('CLOSED', 'REJECTED', 'RESOLVED')
        and (not $2 or t.category in ('PROBLEM', 'DATA')) and (not $3 or (t.status in ('NEW', 'IN_PROGRESS') and (a.id is null or a.id = $4)))
      order by array_position(array['URGENT','HIGH','NORMAL','LOW'], t.severity), t.due_at limit 100`, [q.status ?? null, agent.kind === 'AI', !!q.waiting, agent.id]);
}

/** One ticket as an agent may see it: redacted text, opaque record references, what can be fixed. */
export async function agentTicket(db: Db, agent: Agent, number: string) {
  needScope(agent, 'READ');
  const tk = await loadTicket(db, number);
  const t = await db.one(
    `select t.number, t.category, t.module, t.status, t.severity, t.page, t.redacted_title as title, t.redacted_description as description, t.created_at, t.due_at, t.needs_developer, t.developer_decision, t.developer_note, t.ai_summary,
            o.code as school_code, u.role as raised_by_role from ticket t join app_user u on u.id = t.raised_by left join org_unit o on o.id = t.school_id where t.id = $1`, [tk.id]);
  const msgs = await db.query(`select m.id, m.author_kind, m.redacted_body as body, m.internal, m.created_at, sa.name as agent from ticket_message m left join support_agent sa on sa.id = m.agent_id where m.ticket_id = $1 order by m.id`, [tk.id]);
  // The correct value a user typed is never shown: the agent proposes USER_VALUE and the system puts it in.
  const refs = (await db.query<{ ref: string; entity_type: string; field: string | null; has_value: boolean }>('select ref, entity_type, field, correct_value is not null as has_value from ticket_ref where ticket_id = $1', [tk.id]))
    .map((r) => ({ ref: r.ref, entity_type: r.entity_type, correctableFields: Object.keys(FIELDS[r.entity_type] ?? {}), userSaysWrong: r.field, userGaveCorrectValue: r.has_value ? 'USER_VALUE' : null }));
  const fixes = await db.query(`select number, kind, ref, field, action, summary, status, risk, decision_note, developer_note, result, created_at from fix_proposal where ticket_id = $1 order by created_at`, [tk.id]);
  return { ...t, messages: msgs, refs, fixes };
}

/**
 * A working note on the ticket for the helpdesk and developer (diagnosis, what was checked). Users
 * are never written to: they see the ticket's progress and its resolution.
 */
export async function agentMessage(db: Db, agent: Agent, number: string, input: { body: string; internal?: boolean }) {
  needScope(agent, 'REPLY');
  const tk = await loadTicket(db, number);
  if (input.body.trim().length < 2) throw invalid('Write the note.');
  if (input.internal === false) throw invalid('Users are not written to. Resolve or close the ticket with a note they will see.');
  await db.tx(async (t) => {
    await addMessage(t, tk.id, { kind: 'AGENT', agentId: agent.id, body: input.body, internal: true, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await t.query(`update ticket set first_response_at = coalesce(first_response_at, now()), assigned_agent_id = coalesce(assigned_agent_id, $2), status = case when status in ('NEW', 'TRIAGED') then 'IN_PROGRESS' else status end where id = $1`, [tk.id, agent.id]);
  }, { actor: `agent ${agent.name}` });
  return { ok: true };
}

/** An agent sorts a ticket: category, module, severity, a summary, and whether it needs the developer first. */
export async function agentTriage(db: Db, agent: Agent, number: string, input: { category?: string; module?: string; severity?: string; summary?: string; needsDeveloper?: boolean; reason?: string }) {
  needScope(agent, 'REPLY');
  const tk = await loadTicket(db, number);
  if (input.module && !MODULES[input.module]) throw invalid('Unknown module.');
  await db.tx(async (t) => {
    await t.query(`update ticket set category = coalesce($2, category), module = coalesce($3, module), severity = coalesce($4, severity), ai_summary = coalesce($5, ai_summary),
                          needs_developer = needs_developer or coalesce($6, false), assigned_agent_id = coalesce(assigned_agent_id, $7),
                          status = case when coalesce($6, false) and developer_decision is null then 'AWAITING_DEVELOPER' when status = 'NEW' then 'TRIAGED' else status end, updated_at = now() where id = $1`,
      [tk.id, input.category ?? null, input.module ?? null, input.severity ?? null, input.summary?.slice(0, 1000) ?? null, input.needsDeveloper ?? null, agent.id]);
    if (input.needsDeveloper && !tk.needs_developer) {
      await addMessage(t, tk.id, { kind: 'SYSTEM', body: `Sent to the developer for a decision before any work: ${input.reason ?? 'needs a change to the system'}`, internal: false, schoolId: tk.school_id, raisedBy: tk.raised_by });
      const devs = await t.query<{ id: string }>(`select id from app_user where active and role = 'DEVELOPER'`);
      await notify.toUsers(t, devs.map((d) => d.id), { kind: 'SUPPORT', title: `${tk.number}: needs your decision`, body: input.reason ?? '', link: `/support/${tk.number}` });
    }
  }, { actor: `agent ${agent.name}` });
  return { ok: true };
}

export async function agentResolve(db: Db, agent: Agent, number: string, resolution: string) {
  needScope(agent, 'REPLY');
  const tk = await loadTicket(db, number);
  if (resolution.trim().length < 5) throw invalid('Say how it was resolved.');
  if (await db.maybeOne(`select 1 from fix_proposal where ticket_id = $1 and status in ('DEVELOPER_REVIEW', 'PROPOSED')`, [tk.id])) throw conflict('fix_open', 'A fix is still waiting for approval.');
  await db.tx(async (t) => {
    await t.query(`update ticket set status = 'RESOLVED', resolution = $2, resolved_by_agent_id = $3, resolved_at = now(), updated_at = now() where id = $1`, [tk.id, resolution.trim(), agent.id]);
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: `Resolved: ${resolution.trim()}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await tellUser(t, tk, 'resolved', resolution.trim());
  }, { actor: `agent ${agent.name}` });
  return { status: 'RESOLVED' };
}

// ── What can be fixed, and who approves it ────────────────────────────────────────────────

type FieldDef = { label: string; check?: RegExp };
/** Fields an agent may propose to correct, by kind of record. */
export const FIELDS: Record<string, Record<string, FieldDef>> = {
  STUDENT: { name: { label: 'Name' }, dob: { label: 'Date of birth', check: /^\d{4}-\d{2}-\d{2}$/ }, gender: { label: 'Gender', check: /^(F|M|X)$/ }, bloodGroup: { label: 'Blood group', check: /^(A|B|AB|O)[+-]$/ },
    apaarId: { label: 'APAAR ID', check: /^\d{12}$/ }, pen: { label: 'PEN', check: /^\d{11}$/ }, previousSchool: { label: 'Previous school' } },
  GUARDIAN: { name: { label: 'Name' }, phone: { label: 'Mobile', check: /^\+91[6-9]\d{9}$/ }, email: { label: 'Email', check: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }, address: { label: 'Address' } },
  STAFF: { name: { label: 'Name' }, phone: { label: 'Mobile' }, email: { label: 'Email' }, dob: { label: 'Date of birth', check: /^\d{4}-\d{2}-\d{2}$/ }, bloodGroup: { label: 'Blood group', check: /^(A|B|AB|O)[+-]$/ },
    emergencyContact: { label: 'Emergency contact' }, title: { label: 'Title' }, employeeNo: { label: 'School staff number' }, uan: { label: 'UAN', check: /^\d{12}$/ } },
};

/** Repairs: recalculations and resends that put things right without changing anyone's data. */
export const REPAIRS: Record<string, { label: string; needs: 'SCHOOL' | 'PAYROLL_RUN' | 'STUDENT'; permission: 'principal' | 'staff.manage' | 'pay.prepare' | 'accounts.reconcile' | 'transport.manage' }> = {
  RESYNC_CHAT_GROUPS: { label: 'Rebuild the staff chat groups from the staff lists', needs: 'SCHOOL', permission: 'principal' },
  REFRESH_DESIGNATIONS: { label: 'Work out every staff designation again (post, subject, class)', needs: 'SCHOOL', permission: 'staff.manage' },
  RECOMPUTE_PAYROLL_DRAFT: { label: 'Work a payroll draft out again', needs: 'PAYROLL_RUN', permission: 'pay.prepare' },
  RETRY_FAILED_MESSAGES: { label: 'Send again the emails and SMS that failed', needs: 'SCHOOL', permission: 'principal' },
  REMATCH_BANK_STATEMENT: { label: 'Match the bank statement to the books again', needs: 'SCHOOL', permission: 'accounts.reconcile' },
  REBILL_TRANSPORT: { label: 'Put a child’s transport fee right from their bus stop', needs: 'STUDENT', permission: 'transport.manage' },
};

export async function catalog() {
  return { modules: MODULES, fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, d]) => [f, d.label]))])),
    repairs: Object.fromEntries(Object.entries(REPAIRS).map(([k, v]) => [k, { label: v.label, needs: v.needs }])),
    rules: ['Agents never see or change records. Propose; the department approves; the system applies it with the same checks as the screens.', 'Code changes, high-risk fixes and new features go to the developer first.'] };
}

/**
 * An agent proposes a fix. Data corrections must name a record attached to the ticket and a field
 * from the catalogue; repairs an action from the catalogue. Code changes and high-risk proposals
 * wait for the developer; a ticket sent to the developer takes no proposals until accepted.
 */
export async function agentPropose(db: Db, agent: Agent, number: string, input: { kind: 'DATA_CORRECTION' | 'REPAIR' | 'SETTING' | 'CODE_CHANGE'; ref?: string; field?: string; newValue?: string; action?: string; params?: Record<string, unknown>; summary: string; details?: string; risk?: 'LOW' | 'MEDIUM' | 'HIGH' }) {
  needScope(agent, 'PROPOSE');
  const tk = await loadTicket(db, number);
  if (tk.needs_developer && tk.developer_decision !== 'APPROVED' && input.kind !== 'CODE_CHANGE') throw conflict('developer_first', 'This ticket is waiting for the developer’s decision.');
  let schoolId = tk.school_id;
  if (input.kind === 'DATA_CORRECTION') {
    const r = await db.maybeOne<{ entity_type: string; entity_id: string; correct_value: string | null }>('select entity_type, entity_id, correct_value from ticket_ref where ref = $1 and ticket_id = $2', [input.ref ?? '', tk.id]);
    if (!r) throw invalid('Name a record attached to this ticket (its reference).');
    if (input.newValue === 'USER_VALUE') {
      if (!r.correct_value) throw invalid('The user gave no correct value for this record.');
      input = { ...input, newValue: r.correct_value };
    }
    const f = FIELDS[r.entity_type]?.[input.field ?? ''];
    if (!f) throw invalid(`That field cannot be corrected this way. Correctable: ${Object.keys(FIELDS[r.entity_type] ?? {}).join(', ') || 'none'}.`);
    if (!input.newValue || (f.check && !f.check.test(input.newValue))) throw invalid(`The new ${f.label.toLowerCase()} is not in the right form.`);
    schoolId = await entitySchool(db, r.entity_type, r.entity_id) ?? schoolId;
  }
  if (input.kind === 'REPAIR') {
    const rp = REPAIRS[input.action ?? ''];
    if (!rp) throw invalid(`Unknown repair. Available: ${Object.keys(REPAIRS).join(', ')}.`);
    if (rp.needs !== 'SCHOOL') {
      const r = await db.maybeOne<{ entity_type: string; entity_id: string }>('select entity_type, entity_id from ticket_ref where ref = $1 and ticket_id = $2', [input.ref ?? '', tk.id]);
      if (!r || r.entity_type !== rp.needs) throw invalid(`This repair needs a ${rp.needs.toLowerCase().replace('_', ' ')} attached to the ticket.`);
      schoolId = await entitySchool(db, r.entity_type, r.entity_id) ?? schoolId;
    } else if (!schoolId) throw invalid('This repair needs a school; the ticket has none.');
  }
  if (input.kind === 'SETTING' && (!input.field || input.newValue === undefined)) throw invalid('Name the setting and the new value.');
  const developerFirst = input.kind === 'CODE_CHANGE' || input.risk === 'HIGH';
  return db.tx(async (t) => {
    const f = await t.one<{ number: string }>(
      `insert into fix_proposal (ticket_id, agent_id, kind, ref, field, new_value, action, params, summary, details, risk, school_id, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning number`,
      [tk.id, agent.id, input.kind, input.ref ?? null, input.field ?? null, input.newValue ?? null, input.action ?? null, JSON.stringify(input.params ?? {}), input.summary.trim(), input.details ?? '', input.risk ?? 'LOW', schoolId, developerFirst ? 'DEVELOPER_REVIEW' : 'PROPOSED']);
    await t.query(`update ticket set status = $2, updated_at = now() where id = $1`, [tk.id, developerFirst ? 'AWAITING_DEVELOPER' : 'AWAITING_APPROVAL']);
    await t.query(`update ticket set assigned_agent_id = coalesce(assigned_agent_id, $2) where id = $1`, [tk.id, agent.id]);
    await addMessage(t, tk.id, { kind: 'SYSTEM', body: `A fix has been proposed (${f.number}): ${input.summary.trim()}. ${developerFirst ? 'The developer reviews it first.' : 'Waiting for the responsible office to approve.'}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    const to = developerFirst ? await t.query<{ id: string }>(`select id from app_user where active and role = 'DEVELOPER'`) : await approverUsers(t, schoolId);
    await notify.toUsers(t, to.map((x) => x.id), { kind: 'SUPPORT', title: `${f.number}: a fix to approve`, body: input.summary.trim(), link: developerFirst ? `/support/${tk.number}` : '/approvals' });
    return { number: f.number, status: developerFirst ? 'DEVELOPER_REVIEW' : 'PROPOSED' };
  }, { actor: `agent ${agent.name}` });
}

async function entitySchool(t: Db, type: string, id: string) {
  if (type === 'STUDENT') return (await t.maybeOne<{ s: string }>(`select school_id as s from enrolment where student_id = $1 order by upper_inf(period) desc, lower(period) desc limit 1`, [id]))?.s ?? null;
  if (type === 'GUARDIAN') return (await t.maybeOne<{ s: string }>(`select e.school_id as s from student_guardian sg join enrolment e on e.student_id = sg.student_id where sg.guardian_id = $1 order by upper_inf(e.period) desc limit 1`, [id]))?.s ?? null;
  if (type === 'STAFF') return (await t.maybeOne<{ s: string }>('select school_id as s from employee where user_id = $1', [id]))?.s ?? null;
  if (type === 'PAYROLL_RUN') return (await t.maybeOne<{ s: string }>('select school_id as s from payroll_run where id = $1', [id]))?.s ?? null;
  if (type === 'SCHOOL') return id;
  return null;
}

async function approverUsers(t: Db, schoolId: string | null) {
  if (!schoolId) return t.query<{ id: string }>(`select id from app_user where active and role = 'NES_ADMIN'`);
  return t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [schoolId]);
}

/** May this person approve this fix? The department that owns the record, by the same rules as the screens. */
async function mayApprove(db: Db, actor: Actor, f: { kind: string; entity_type: string | null; school_id: string | null; action: string | null }) {
  if (f.kind === 'CODE_CHANGE') return actor.role === 'DEVELOPER';
  if (f.kind === 'SETTING') return actor.role === 'NES_ADMIN' || (!!f.school_id && actor.role === 'SCHOOL_ADMIN' && (await can(db, actor, 'overview.view', f.school_id)));
  if (!f.school_id) return actor.role === 'NES_ADMIN';
  if (f.kind === 'DATA_CORRECTION') return can(db, actor, f.entity_type === 'STAFF' ? 'staff.manage' : 'admissions.manage', f.school_id);
  const rp = REPAIRS[f.action ?? ''];
  if (!rp) return false;
  if (rp.permission === 'principal') return (actor.role === 'SCHOOL_ADMIN' && (await can(db, actor, 'overview.view', f.school_id))) || actor.role === 'NES_ADMIN';
  return can(db, actor, rp.permission, f.school_id);
}

const FIX_SELECT = `select f.id, f.ticket_id, f.number, f.kind, f.ref, f.field, f.new_value, f.action, f.params, f.summary, f.details, f.risk, f.status, f.school_id, f.created_at, t.number as ticket, t.title as ticket_title,
  a.name as agent, r.entity_type, r.entity_id, o.name as school from fix_proposal f join ticket t on t.id = f.ticket_id join support_agent a on a.id = f.agent_id
  left join ticket_ref r on r.ref = f.ref left join org_unit o on o.id = f.school_id`;

/** The current value of a field (shown to the approver only, beside the proposed one). */
async function currentValue(db: Db, type: string, id: string, field: string) {
  const col: Record<string, string> = { name: 'name', dob: 'dob::text', gender: 'gender', bloodGroup: 'blood_group', apaarId: 'apaar_id', pen: 'pen', previousSchool: 'previous_school', phone: 'phone', email: 'email', address: 'address',
    emergencyContact: 'emergency_contact', title: 'title', employeeNo: 'employee_no', uan: 'uan' };
  if (type === 'STUDENT') return (await db.maybeOne<{ v: string | null }>(`select ${col[field]} as v from student where id = $1`, [id]))?.v ?? null;
  if (type === 'GUARDIAN') return (await db.maybeOne<{ v: string | null }>(`select ${col[field]} as v from guardian where id = $1`, [id]))?.v ?? null;
  if (type === 'STAFF') {
    const onUser = ['name', 'phone', 'email'].includes(field);
    return (await db.maybeOne<{ v: string | null }>(onUser ? `select ${col[field]} as v from app_user where id = $1` : `select ${col[field]} as v from employee where user_id = $1`, [id]))?.v ?? null;
  }
  return null;
}

/** Fixes waiting for this person: for the department (and NES), and for the developer. */
export async function approvals(db: Db, actor: Actor) {
  const rows = await db.query<{ id: string; kind: string; entity_type: string | null; entity_id: string | null; school_id: string | null; action: string | null; field: string | null; status: string }>(
    `${FIX_SELECT} where f.status in ('PROPOSED', 'DEVELOPER_REVIEW') order by f.created_at`);
  const out = [];
  for (const f of rows) {
    const dev = f.status === 'DEVELOPER_REVIEW';
    if (dev ? actor.role !== 'DEVELOPER' : !(await mayApprove(db, actor, f))) continue;
    const label = f.kind === 'DATA_CORRECTION' && f.entity_type && f.entity_id
      ? (f.entity_type === 'STUDENT' ? (await db.one<{ n: string }>('select name as n from student where id = $1', [f.entity_id])).n
        : f.entity_type === 'GUARDIAN' ? (await db.one<{ n: string }>('select name as n from guardian where id = $1', [f.entity_id])).n
        : (await db.one<{ n: string }>('select name as n from app_user where id = $1', [f.entity_id])).n) : null;
    out.push({ ...f, record: label, fieldLabel: f.entity_type && f.field ? FIELDS[f.entity_type]?.[f.field]?.label : f.field, repairLabel: f.action ? REPAIRS[f.action]?.label : null,
      currentValue: f.kind === 'DATA_CORRECTION' && f.entity_type && f.entity_id && f.field && !dev ? await currentValue(db, f.entity_type, f.entity_id, f.field) : null, stage: dev ? 'DEVELOPER' : 'DEPARTMENT' });
  }
  return out;
}

/**
 * Approves (and applies) or rejects a fix. Data corrections and settings are applied through the
 * same functions as the screens, as the approver, so every rule and the audit log apply; repairs
 * run their action; code changes are accepted by the developer and marked applied when released.
 */
export async function decideFix(db: Db, actor: Actor, number: string, approve: boolean, note = '') {
  const f = await db.maybeOne<{ id: string; kind: string; status: string; entity_type: string | null; entity_id: string | null; school_id: string | null; action: string | null; field: string | null; new_value: string | null; params: Record<string, unknown>; ticket_id: string; summary: string; risk: string }>(
    `${FIX_SELECT} where f.number = $1`, [number.toUpperCase()]);
  if (!f) throw notFound('Fix');
  const tk = await db.one<{ number: string; raised_by: string; school_id: string | null }>('select number, raised_by, school_id from ticket where id = $1', [f.ticket_id]);
  if (!approve && note.trim().length < 3) throw invalid('Give the reason for rejecting.');
  // The developer's review comes first for code and high-risk proposals.
  if (f.status === 'DEVELOPER_REVIEW') {
    if (actor.role !== 'DEVELOPER') throw forbidden('The developer reviews this first.');
    const next = !approve ? 'REJECTED' : f.kind === 'CODE_CHANGE' ? 'APPROVED' : 'PROPOSED';
    await db.tx(async (t) => {
      await t.query(`update fix_proposal set status = $2, developer_by = $3, developer_at = now(), developer_note = $4 where id = $1`, [f.id, next, actor.id, note.trim() || null]);
      await t.query(`update ticket set needs_developer = true, developer_decision = $2, status = $3, updated_at = now() where id = $1`, [f.ticket_id, approve ? 'APPROVED' : 'DECLINED', !approve ? 'IN_PROGRESS' : next === 'PROPOSED' ? 'AWAITING_APPROVAL' : 'IN_PROGRESS']);
      await addMessage(t, f.ticket_id, { kind: 'SYSTEM', body: `${number}: ${approve ? (f.kind === 'CODE_CHANGE' ? 'accepted by the developer; it comes with the next release.' : 'reviewed by the developer; now with the responsible office.') : `not accepted by the developer: ${note.trim()}`}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
      if (next === 'PROPOSED') { const to = await approverUsers(t, f.school_id); await notify.toUsers(t, to.map((x) => x.id), { kind: 'SUPPORT', title: `${number}: a fix to approve`, body: f.summary, link: '/approvals' }); }
    }, { actor: actor.label });
    return { status: next };
  }
  if (f.status === 'APPROVED' && f.kind === 'CODE_CHANGE') {
    if (actor.role !== 'DEVELOPER') throw forbidden();
    await db.tx(async (t) => {
      await t.query(`update fix_proposal set status = 'APPLIED', applied_at = now(), result = $2 where id = $1`, [f.id, note.trim() || 'Released']);
      await addMessage(t, f.ticket_id, { kind: 'SYSTEM', body: `${number}: the change is released. ${note.trim()}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    }, { actor: actor.label });
    return { status: 'APPLIED' };
  }
  if (f.status !== 'PROPOSED') throw conflict('decided', 'Already decided.');
  if (!(await mayApprove(db, actor, f))) throw forbidden('This fix is approved by the office responsible for the record.');
  if (!approve) {
    await db.tx(async (t) => {
      await t.query(`update fix_proposal set status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [f.id, actor.id, note.trim()]);
      await t.query(`update ticket set status = 'IN_PROGRESS', updated_at = now() where id = $1`, [f.ticket_id]);
      await addMessage(t, f.ticket_id, { kind: 'SYSTEM', body: `${number} was not approved: ${note.trim()}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    }, { actor: actor.label });
    return { status: 'REJECTED' };
  }
  let result = '';
  try {
    result = await applyFix(db, actor, f);
  } catch (e) {
    await db.tx(async (t) => {
      await t.query(`update fix_proposal set status = 'FAILED', decided_by = $2, decided_at = now(), result = $3 where id = $1`, [f.id, actor.id, (e as Error).message.slice(0, 500)]);
      await addMessage(t, f.ticket_id, { kind: 'SYSTEM', body: `${number} could not be applied: ${(e as Error).message}`, internal: true, schoolId: tk.school_id, raisedBy: tk.raised_by });
    }, { actor: actor.label });
    throw e;
  }
  await db.tx(async (t) => {
    await t.query(`update fix_proposal set status = 'APPLIED', decided_by = $2, decided_at = now(), decision_note = $3, applied_at = now(), result = $4 where id = $1`, [f.id, actor.id, note.trim() || null, result]);
    await t.query(`update ticket set status = 'IN_PROGRESS', updated_at = now() where id = $1 and status = 'AWAITING_APPROVAL'`, [f.ticket_id]);
    await addMessage(t, f.ticket_id, { kind: 'SYSTEM', body: `${number} approved and applied by the school office. ${result}`, schoolId: tk.school_id, raisedBy: tk.raised_by });
    await tellUser(t, { id: f.ticket_id, number: tk.number, title: f.summary, raised_by: tk.raised_by }, 'fix applied', `${f.summary}. ${result}`);
  }, { actor: actor.label });
  return { status: 'APPLIED', result };
}

async function applyFix(db: Db, actor: Actor, f: { kind: string; entity_type: string | null; entity_id: string | null; field: string | null; new_value: string | null; action: string | null; school_id: string | null; params: Record<string, unknown> }) {
  if (f.kind === 'DATA_CORRECTION') {
    const v = f.new_value!;
    const patch = { [f.field!]: v };
    if (f.entity_type === 'STUDENT') { const { updateDetails } = await import('./students.js'); await updateDetails(db, actor, f.entity_id!, patch); }
    else if (f.entity_type === 'GUARDIAN') { const { updateGuardian } = await import('./students.js'); await updateGuardian(db, actor, f.entity_id!, patch); }
    else if (f.entity_type === 'STAFF') { const staff = await import('./staff.js'); await staff.updateDetails(db, actor, f.entity_id!, patch); }
    return `${FIELDS[f.entity_type!]?.[f.field!]?.label ?? f.field} corrected.`;
  }
  if (f.kind === 'SETTING') {
    const settings = await import('./settings.js');
    const unit = f.school_id ?? (await db.one<{ id: string }>(`select id from org_unit where kind = 'society'`)).id;
    let value: unknown = f.new_value;
    try { value = JSON.parse(f.new_value!); } catch { /* a plain string */ }
    await settings.set(db, actor, unit, { key: f.field!, value, from: localToday(), note: 'From a support ticket' });
    return `Setting ${f.field} changed from today.`;
  }
  if (f.kind === 'REPAIR') {
    switch (f.action) {
      case 'RESYNC_CHAT_GROUPS': { const chat = await import('./chat.js'); await chat.syncAutoGroups(db); return 'Chat groups rebuilt.'; }
      case 'REFRESH_DESIGNATIONS': {
        const staff = await import('./staff.js');
        const ids = await db.query<{ user_id: string }>('select user_id from employee where school_id = $1 and separated_on is null', [f.school_id]);
        await db.tx(async (t) => { for (const x of ids) await staff.refreshDesignation(t, x.user_id); }, { actor: actor.label });
        return `${ids.length} designations worked out again.`;
      }
      case 'RECOMPUTE_PAYROLL_DRAFT': { const payroll = await import('./payroll.js'); await payroll.recompute(db, actor, f.entity_id!); return 'Payroll draft worked out again.'; }
      case 'RETRY_FAILED_MESSAGES': { const n = await db.tx((t) => messages.retryFailed(t, f.school_id), { actor: actor.label }); return `${n} messages queued again.`; }
      case 'REMATCH_BANK_STATEMENT': { const accounts = await import('./accounts.js'); const n = await accounts.rematch(db, actor, f.school_id!); return `${n} statement lines matched.`; }
      case 'REBILL_TRANSPORT': { const transport = await import('./transport.js'); const r = await transport.rebillStudent(db, actor, f.entity_id!); return r.length ? `Transport fee put right: ${r.join(', ')}.` : 'The transport fee was already right.'; }
    }
  }
  throw invalid('This fix cannot be applied here.');
}

// ── Product knowledge: how each module is meant to work (the docs, never data) ────────────

let KB: { title: string; text: string }[] | null = null;
function knowledgeBase() {
  if (KB) return KB;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files = [join(root, 'README.md'), ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join(root, 'docs', f))];
  KB = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const parts = text.split(/\n(?=#{1,3} )/);
    for (const p of parts) KB.push({ title: (p.match(/^#{1,3} (.+)/)?.[1] ?? file.split('/').pop()!).trim(), text: p.slice(0, 3000) });
  }
  return KB;
}

/** The product documentation sections that best match (for an agent working out whether something is a fault). */
export function knowledge(query: string) {
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return knowledgeBase().map((s) => ({ ...s, score: terms.reduce((n, w) => n + (s.text.toLowerCase().split(w).length - 1) + (s.title.toLowerCase().includes(w) ? 3 : 0), 0) }))
    .filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(({ title, text }) => ({ title, text }));
}

export async function agents(db: Db, actor: Actor) {
  if (!isDesk(actor)) throw forbidden();
  return db.query(`select a.id, a.name, a.kind, a.key_id, a.scopes, a.active, a.created_at, a.last_seen_at, u.name as signs_in_as, (select count(*) from agent_call c where c.agent_id = a.id and c.at > now() - interval '1 day')::int as calls_today
    from support_agent a left join app_user u on u.id = a.user_id order by a.name`);
}
