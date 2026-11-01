import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { academicYearOf, localToday } from '../lib/dates.js';
import { reportPdf } from '../lib/reportPdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import * as notify from './notify.js';

/**
 * NES governance: committees at NES, Command or school level; agenda items submitted before a
 * cut-off; meetings with attendance and quorum; minutes drafted, circulated and confirmed by the
 * chair; decisions with an owner, a due date and actions whose progress is updated live; decisions
 * sent to the schools they affect, which acknowledge them and report the action taken; voting by
 * circulation between meetings; working groups; and the NES Conference (sessions are its meetings,
 * delegates its members, school topics its agenda, resolutions its decisions).
 *
 * Who sees what:
 *  - members see everything of their committee, including confidential items;
 *  - NES, a Command or a principal (the "manager" of committees in their part of the tree) sees the
 *    committee and its confirmed business, but never what is confidential unless they are a member;
 *  - an owner of a decision or an action sees that decision;
 *  - a principal sees the decisions sent to their school, to acknowledge and report on them.
 */

export const KINDS = {
  EXECUTIVE: 'Executive Committee', MANAGEMENT_ADVISORY: 'Management Advisory Committee', ACADEMIC_ADVISORY: 'Academic Advisory Committee',
  SCHOOL_MANAGING: 'School Managing Committee', ACADEMIC_MONITORING: 'Academic Monitoring Committee', PURCHASE: 'Purchase Committee',
  CHILD_PROTECTION: 'Child Protection Committee', SAFETY: 'Safety Committee', WORKING_GROUP: 'Working group', CONFERENCE: 'NES Conference', OTHER: 'Committee',
} as const;
export type Kind = keyof typeof KINDS;
const ABBR: Record<Kind, string> = { EXECUTIVE: 'EC', MANAGEMENT_ADVISORY: 'MAC', ACADEMIC_ADVISORY: 'AAC', SCHOOL_MANAGING: 'SMC', ACADEMIC_MONITORING: 'AMC',
  PURCHASE: 'PC', CHILD_PROTECTION: 'CPC', SAFETY: 'SC', WORKING_GROUP: 'WG', CONFERENCE: 'CONF', OTHER: 'COM' };

const MANAGERS = ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'];
const LIVE = ['DECIDED', 'IN_PROGRESS'];
const UUID = /^[0-9a-f-]{36}$/i;
const today = () => localToday();

type Committee = { id: string; unit_id: string; kind: Kind; name: string; purpose: string; quorum: number; ends_on: string | null; confidential: boolean; active: boolean; unit_path: string; unit: string; unit_kind: string };
type Member = { id: string; user_id: string | null; role: 'CHAIR' | 'CONVENER' | 'MEMBER' | 'INVITEE' };

export type MemberInput = { userId?: string; name?: string; detail?: string; email?: string; role: Member['role'] };

async function loadCommittee(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Committee');
  const c = await db.maybeOne<Committee>(
    `select c.id, c.unit_id, c.kind, c.name, c.purpose, c.quorum, c.ends_on::text, c.confidential, c.active, o.path::text as unit_path, o.name as unit, o.kind as unit_kind
       from committee c join org_unit o on o.id = c.unit_id where c.id = $1`, [id]);
  if (!c) throw notFound('Committee');
  return c;
}

/** Whether the person manages committees at this unit: NES, a Command or a principal, inside their scope. */
async function manages(db: Db, actor: Actor, unitPath: string) {
  if (!MANAGERS.includes(actor.role) || !actor.scopePath) return false;
  return !!(await db.maybeOne('select 1 where $1::ltree <@ $2::ltree', [unitPath, actor.scopePath]));
}

const myMembership = (db: Db, actor: Actor, committeeId: string) => db.maybeOne<Member>(
  `select id, user_id, role from committee_member where committee_id = $1 and user_id = $2 and valid @> current_date`, [committeeId, actor.id]);

/** What the person may do in a committee. */
async function rights(db: Db, actor: Actor, c: Committee) {
  const me = await myMembership(db, actor, c.id);
  const manager = await manages(db, actor, c.unit_path);
  const member = !!me && me.role !== 'INVITEE';
  // The NES Conference is open to every school under it: principals follow it and submit their school's topics.
  const school = c.kind === 'CONFERENCE' && c.active && !c.confidential && actor.role === 'SCHOOL_ADMIN' && !!actor.scopePath
    && !!(await db.maybeOne('select 1 where $1::ltree <@ $2::ltree', [actor.scopePath, c.unit_path]));
  return {
    me, manager, member,
    /** Sees meetings, minutes and decisions. Confidential committees: members only. */
    see: !!me || (manager && !c.confidential) || school,
    /** Runs the business: schedules meetings, builds the agenda, writes the minutes. */
    run: me?.role === 'CONVENER' || me?.role === 'CHAIR' || (manager && !c.confidential),
    chair: me?.role === 'CHAIR',
    /** Members (and, for the conference, every principal in it) submit agenda items. */
    submit: member || me?.role === 'CHAIR' || school,
  };
}

async function need(db: Db, actor: Actor, committeeId: string, what: 'see' | 'run' | 'manager') {
  const c = await loadCommittee(db, committeeId);
  const r = await rights(db, actor, c);
  if (!r[what]) throw forbidden(what === 'run' ? 'The convener or the chair runs the committee’s business.' : what === 'manager' ? 'Committees are set up by NES, the Command or the principal.' : 'This committee’s business is for its members.');
  return { c, r };
}

/** The people who hold sign-ins among the members, for notifications. */
const memberUsers = async (db: Db, committeeId: string, exceptId?: string) => (await db.query<{ user_id: string }>(
  `select user_id from committee_member where committee_id = $1 and user_id is not null and valid @> current_date and user_id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')`,
  [committeeId, exceptId ?? null])).map((r) => r.user_id);

async function addMembers(t: Db, actor: Actor, committeeId: string, unitPath: string, list: MemberInput[], from: string) {
  for (const m of list) {
    if (m.userId) {
      const u = await t.maybeOne<{ ok: boolean }>(`select (scope_path is not null) as ok from app_user where id = $1 and active and role not in ('PARENT', 'CANDIDATE', 'ALUMNUS', 'SUPPORT', 'DEVELOPER')`, [m.userId]);
      if (!u) throw invalid('Members are NES, Command or school staff, or people outside NavShiksha added by name.');
      await t.query(`insert into committee_member (committee_id, user_id, role, valid, added_by) values ($1, $2, $3, daterange($4::date, null), $5)`, [committeeId, m.userId, m.role, from, actor.id]);
    } else {
      if (!m.name || m.name.trim().length < 2) throw invalid('Give the name of a member from outside NavShiksha.');
      await t.query(`insert into committee_member (committee_id, external_name, external_detail, external_email, role, valid, added_by) values ($1, $2, $3, $4, $5, daterange($6::date, null), $7)`,
        [committeeId, m.name.trim(), m.detail?.trim() ?? '', m.email?.trim() || null, m.role, from, actor.id]);
    }
  }
  void unitPath;
}

// ── Committees ───────────────────────────────────────────────────────────────────────────────

export async function committees(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  return db.query(
    `select c.id, c.kind, c.name, c.purpose, c.quorum, c.ends_on::text, c.confidential, c.active, o.name as unit, o.kind as unit_kind,
            m.role as my_role,
            (select count(*)::int from committee_member x where x.committee_id = c.id and x.valid @> current_date) as members,
            (select min(starts_at) from meeting g where g.committee_id = c.id and g.status = 'SCHEDULED' and g.starts_at > now()) as next_meeting,
            case when m.id is not null or not c.confidential then
              (select count(*)::int from decision d where d.committee_id = c.id and d.status in ('DECIDED', 'IN_PROGRESS')) end as open_decisions
       from committee c join org_unit o on o.id = c.unit_id
       left join committee_member m on m.committee_id = c.id and m.user_id = $1 and m.valid @> current_date
      where m.id is not null or ($3 and o.path <@ $2::ltree)
         or (c.kind = 'CONFERENCE' and c.active and not c.confidential and $4 and $2::ltree <@ o.path)
      order by c.active desc, nlevel(o.path), o.name, c.name`, [actor.id, actor.scopePath, MANAGERS.includes(actor.role), actor.role === 'SCHOOL_ADMIN']);
}

export async function createCommittee(db: Db, actor: Actor, input: { unitId: string; kind: Kind; name?: string; purpose?: string; quorum: number; endsOn?: string | null; confidential?: boolean; members: MemberInput[] }) {
  if (!MANAGERS.includes(actor.role)) throw forbidden('Committees are set up by NES, the Command or the principal.');
  await assertUnitInScope(db, actor, input.unitId);
  const unit = await db.one<{ kind: string; name: string; path: string }>('select kind, name, path::text from org_unit where id = $1', [input.unitId]);
  if (unit.kind === 'campus') throw invalid('Committees belong to NES, a Command or a school.');
  if (['EXECUTIVE', 'MANAGEMENT_ADVISORY', 'ACADEMIC_ADVISORY', 'CONFERENCE'].includes(input.kind) && unit.kind !== 'society') throw invalid(`The ${KINDS[input.kind]} is an NES committee.`);
  if (input.kind === 'SCHOOL_MANAGING' && unit.kind !== 'school') throw invalid('The School Managing Committee belongs to a school.');
  if (input.kind === 'WORKING_GROUP' && !input.endsOn) throw invalid('Give the working group a deadline.');
  const roles = input.members.map((m) => m.role);
  if (roles.filter((r) => r === 'CHAIR').length !== 1 || roles.filter((r) => r === 'CONVENER').length !== 1) throw invalid('Name one chair and one convener.');
  if (!input.members.some((m) => m.role === 'CONVENER' && m.userId)) throw invalid('The convener runs the committee in NavShiksha, so must be someone with a NavShiksha sign-in.');
  const ids = input.members.map((m) => m.userId).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw invalid('Each person can be added once.');
  const name = input.name?.trim() || (input.kind === 'CONFERENCE' ? `NES Conference ${academicYearOf(today())}` : `${KINDS[input.kind]}${unit.kind === 'society' ? '' : `, ${unit.name}`}`);
  return db.tx(async (t) => {
    const c = await t.one<{ id: string }>(
      `insert into committee (unit_id, kind, name, purpose, quorum, ends_on, confidential, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.unitId, input.kind, name, input.purpose?.trim() ?? '', input.quorum, input.endsOn ?? null, input.confidential ?? input.kind === 'CHILD_PROTECTION', actor.id]);
    await addMembers(t, actor, c.id, unit.path, input.members, today());
    await notify.toUsers(t, ids.filter((x) => x !== actor.id) as string[], { kind: 'GOVERNANCE', title: `You are on the ${name}`, body: input.purpose?.trim().slice(0, 140) ?? '', link: `/governance/committees/${c.id}` });
    return { id: c.id };
  }, { actor: actor.label });
}

export async function updateCommittee(db: Db, actor: Actor, id: string, input: { name?: string; purpose?: string; quorum?: number; endsOn?: string | null; confidential?: boolean; active?: boolean }) {
  const { c } = await need(db, actor, id, 'manager');
  await db.tx((t) => t.query(
    `update committee set name = coalesce($2, name), purpose = coalesce($3, purpose), quorum = coalesce($4, quorum),
            ends_on = case when $5::boolean then $6::date else ends_on end, confidential = coalesce($7, confidential), active = coalesce($8, active) where id = $1`,
    [c.id, input.name?.trim() || null, input.purpose ?? null, input.quorum ?? null, input.endsOn !== undefined, input.endsOn ?? null, input.confidential ?? null, input.active ?? null]), { actor: actor.label });
  return committee(db, actor, id);
}

export async function addMember(db: Db, actor: Actor, id: string, input: MemberInput & { from?: string }) {
  const { c } = await need(db, actor, id, 'manager');
  try {
    await db.tx((t) => addMembers(t, actor, c.id, c.unit_path, [input], input.from ?? today()), { actor: actor.label });
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') throw conflict('member_clash', input.role === 'CHAIR' || input.role === 'CONVENER' ? `The committee already has a ${input.role.toLowerCase()}; end their term first.` : 'This person is already a member.');
    throw e;
  }
  if (input.userId && input.userId !== actor.id) await notify.toUsers(db, [input.userId], { kind: 'GOVERNANCE', title: `You are on the ${c.name}`, link: `/governance/committees/${c.id}` });
  return committee(db, actor, id);
}

/** Ends a membership (a member's term, or a chair handing over). The record stays. */
export async function endMember(db: Db, actor: Actor, memberId: string, on: string) {
  if (!UUID.test(memberId)) throw notFound('Member');
  const m = await db.maybeOne<{ committee_id: string; from: string }>('select committee_id, lower(valid)::text as from from committee_member where id = $1 and upper_inf(valid)', [memberId]);
  if (!m) throw notFound('Member');
  await need(db, actor, m.committee_id, 'manager');
  if (on < m.from) throw invalid('A term cannot end before it began.');
  await db.tx((t) => t.query(`update committee_member set valid = daterange(lower(valid), ($2::date + 1)) where id = $1`, [memberId, on]), { actor: actor.label });
  return committee(db, actor, m.committee_id);
}

export async function committee(db: Db, actor: Actor, id: string) {
  const c = await loadCommittee(db, id);
  const r = await rights(db, actor, c);
  if (!r.see && !r.manager) throw forbidden('This committee’s business is for its members.');
  const members = await db.query(
    `select m.id, m.user_id, m.role, coalesce(u.name, m.external_name) as name, coalesce(u.designation, m.external_detail) as detail, m.user_id is null as external,
            lower(m.valid)::text as from, (upper(m.valid) - 1)::text as until, m.valid @> current_date as current
       from committee_member m left join app_user u on u.id = m.user_id where m.committee_id = $1
      order by m.valid @> current_date desc, array_position(array['CHAIR', 'CONVENER', 'MEMBER', 'INVITEE'], m.role), name`, [id]);
  const base = { ...c, rights: { see: r.see, run: r.run, manage: r.manager, chair: r.chair, submit: r.submit, myRole: r.me?.role ?? null }, members };
  if (!r.see) return { ...base, meetings: [], agenda: [], decisions: [] };
  const meetings = await db.query(
    `select g.id, g.number, g.title, g.kind, g.starts_at, g.venue, g.status, g.minutes_status, g.agenda_closes,
            (select count(*)::int from agenda_item a where a.meeting_id = g.id and a.status = 'ACCEPTED') as items
       from meeting g where g.committee_id = $1 order by g.starts_at desc`, [id]);
  const agenda = await db.query(
    `select a.id, a.title, a.details, a.status, a.meeting_id, a.confidential, a.triage_note, a.created_at, u.name as raised_by, o.name as for_school, a.from_decision
       from agenda_item a join app_user u on u.id = a.raised_by left join org_unit o on o.id = a.for_unit
      where a.committee_id = $1 and (a.status in ('SUBMITTED', 'DEFERRED') or (a.status = 'ACCEPTED' and a.meeting_id is null))
        and (not a.confidential or $2) order by a.created_at`, [id, !!r.me]);
  const decisions = await decisionRows(db, actor, { committeeId: id });
  return { ...base, meetings, agenda, decisions };
}

/** Staff who can be made members: everyone with a staff sign-in in the committee's part of the tree (NES: anyone). */
export async function people(db: Db, actor: Actor, unitId: string, q: string) {
  // NES, Commands and principals in their part of the tree; a convener or chair for their committee's unit (to name owners).
  const runs = await db.maybeOne(
    `select 1 from committee c where c.unit_id = $2 and (exists (select 1 from committee_member m where m.committee_id = c.id and m.user_id = $1 and m.role in ('CONVENER', 'CHAIR') and m.valid @> current_date)
                                                      or exists (select 1 from decision d where d.committee_id = c.id and d.owner_id = $1 and d.status in ('DECIDED', 'IN_PROGRESS', 'IMPLEMENTED')))`, [actor.id, unitId]);
  if (!runs) {
    if (!MANAGERS.includes(actor.role)) throw forbidden();
    await assertUnitInScope(db, actor, unitId);
  }
  return db.query(
    `select u.id, u.name, u.designation, u.role, o.name as unit from app_user u join org_unit o on o.path = u.scope_path
      where u.active and u.role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF')
        and (u.scope_path <@ (select path from org_unit where id = $1) or u.scope_path @> (select path from org_unit where id = $1))
        and ($2 = '' or u.name ilike '%' || $2 || '%' or u.designation ilike '%' || $2 || '%')
      order by nlevel(u.scope_path), u.name limit 40`, [unitId, q.trim()]);
}

// ── Agenda ───────────────────────────────────────────────────────────────────────────────────

export async function submitItem(db: Db, actor: Actor, committeeId: string, input: { title: string; details?: string; meetingId?: string | null; confidential?: boolean }) {
  const c = await loadCommittee(db, committeeId);
  const r = await rights(db, actor, c);
  if (!r.submit && !r.run) throw forbidden('Agenda items are submitted by members of the committee.');
  if (!c.active) throw invalid('This committee is no longer active.');
  let meetingId: string | null = null;
  if (input.meetingId) {
    const g = await db.maybeOne<{ status: string; open: boolean }>('select status, agenda_closes > now() as open from meeting where id = $1 and committee_id = $2', [input.meetingId, committeeId]);
    if (!g || g.status !== 'SCHEDULED') throw invalid('Choose a meeting that is still to come.');
    if (!g.open && !r.run) throw invalid('The agenda for this meeting has closed. Submit it for the next meeting.');
    meetingId = input.meetingId;
  }
  // A principal's conference topic is their school's.
  const forUnit = actor.role === 'SCHOOL_ADMIN' ? (await db.maybeOne<{ id: string }>(`select id from org_unit where path = $1::ltree and kind = 'school'`, [actor.scopePath]))?.id ?? null : null;
  return db.tx(async (t) => {
    // The convener's own items go straight onto the agenda.
    const accepted = r.run;
    const a = await t.one<{ id: string }>(
      `insert into agenda_item (committee_id, meeting_id, position, title, details, raised_by, for_unit, confidential, status)
       values ($1, $2, case when $9 then (select coalesce(max(position), 0) + 1 from agenda_item where meeting_id = $2) end, $3, $4, $5, $6, $7, $8) returning id`,
      [committeeId, accepted ? meetingId : null, input.title.trim(), input.details?.trim() ?? '', actor.id, forUnit, input.confidential ?? c.confidential, accepted ? 'ACCEPTED' : 'SUBMITTED', accepted && !!meetingId]);
    if (!accepted) {
      const conv = await t.query<{ user_id: string }>(`select user_id from committee_member where committee_id = $1 and role = 'CONVENER' and user_id is not null and valid @> current_date`, [committeeId]);
      await notify.toUsers(t, conv.map((x) => x.user_id), { kind: 'GOVERNANCE', title: `Agenda item for the ${c.name}`, body: input.title.trim().slice(0, 140), link: `/governance/committees/${committeeId}` });
    }
    return { id: a.id, status: accepted ? 'ACCEPTED' : 'SUBMITTED', wantedMeeting: meetingId };
  }, { actor: actor.label });
}

/** The convener accepts an item onto a meeting, defers it, merges it into another, or turns it down with a reason. */
export async function triageItem(db: Db, actor: Actor, itemId: string, input: { action: 'ACCEPT' | 'DEFER' | 'MERGE' | 'REJECT'; meetingId?: string | null; mergeInto?: string; note?: string }) {
  if (!UUID.test(itemId)) throw notFound('Agenda item');
  const a = await db.maybeOne<{ committee_id: string; raised_by: string; title: string; status: string }>('select committee_id, raised_by, title, status from agenda_item where id = $1', [itemId]);
  if (!a) throw notFound('Agenda item');
  const { c } = await need(db, actor, a.committee_id, 'run');
  if (input.action === 'REJECT' && !(input.note?.trim())) throw invalid('Say why the item is not taken up; the person who raised it is told.');
  if (input.meetingId) {
    const g = await db.maybeOne<{ status: string; minutes_status: string }>('select status, minutes_status from meeting where id = $1 and committee_id = $2', [input.meetingId, a.committee_id]);
    if (!g || g.status === 'CANCELLED' || g.minutes_status === 'CONFIRMED') throw invalid('Choose a meeting of this committee whose minutes are still open.');
  }
  if (input.action === 'MERGE') {
    const into = input.mergeInto && await db.maybeOne('select 1 from agenda_item where id = $1 and committee_id = $2 and id <> $3', [input.mergeInto, a.committee_id, itemId]);
    if (!into) throw invalid('Choose the item to merge this into.');
  }
  const status = { ACCEPT: 'ACCEPTED', DEFER: 'DEFERRED', MERGE: 'MERGED', REJECT: 'REJECTED' }[input.action];
  await db.tx(async (t) => {
    await t.query(
      `update agenda_item set status = $2, meeting_id = $3, merged_into = $4, triage_note = $5,
              position = case when $3::uuid is not null then (select coalesce(max(position), 0) + 1 from agenda_item where meeting_id = $3) end where id = $1`,
      [itemId, status, input.action === 'ACCEPT' ? input.meetingId ?? null : null, input.action === 'MERGE' ? input.mergeInto : null, input.note?.trim() || null]);
    if (a.raised_by !== actor.id) await notify.toUsers(t, [a.raised_by], { kind: 'GOVERNANCE',
      title: `${a.title}: ${{ ACCEPT: 'on the agenda', DEFER: 'deferred', MERGE: 'merged with another item', REJECT: 'not taken up' }[input.action]}`, body: input.note?.trim() ?? c.name, link: `/governance/committees/${c.id}` });
  }, { actor: actor.label });
  return { status };
}

// ── Meetings ─────────────────────────────────────────────────────────────────────────────────

export async function scheduleMeeting(db: Db, actor: Actor, committeeId: string, input: { title?: string; kind?: 'ORDINARY' | 'SPECIAL' | 'SESSION'; startsAt: string; endsAt?: string | null; venue?: string; videoLink?: string; agendaCloses?: string | null }) {
  const { c } = await need(db, actor, committeeId, 'run');
  if (!c.active) throw invalid('This committee is no longer active.');
  const starts = new Date(input.startsAt);
  if (Number.isNaN(starts.getTime()) || starts.getTime() < Date.now() - 36e5) throw invalid('Choose a date and time from now on.');
  if (!input.venue?.trim() && !input.videoLink?.trim()) throw invalid('Give a venue, a video link, or both.');
  // The agenda closes three days before by default, or at the start if the meeting is sooner.
  const threeDays = starts.getTime() - 3 * 864e5;
  const closes = input.agendaCloses ? new Date(input.agendaCloses) : new Date(threeDays > Date.now() ? threeDays : starts.getTime());
  if (closes > starts) throw invalid('The agenda must close before the meeting starts.');
  return db.tx(async (t) => {
    const n = (await t.one<{ n: number }>('select coalesce(max(number), 0) + 1 as n from meeting where committee_id = $1', [committeeId])).n;
    const title = input.title?.trim() || (c.kind === 'CONFERENCE' ? `Session ${n}` : `${ordinal(n)} meeting of the ${c.name}`);
    const g = await t.one<{ id: string }>(
      `insert into meeting (committee_id, number, title, kind, starts_at, ends_at, venue, video_link, agenda_closes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [committeeId, n, title, input.kind ?? (c.kind === 'CONFERENCE' ? 'SESSION' : 'ORDINARY'), starts.toISOString(), input.endsAt ?? null, input.venue?.trim() ?? '', input.videoLink?.trim() ?? '', closes.toISOString(), actor.id]);
    // Items already accepted for "the next meeting" (and matters carried forward) go onto this one.
    await t.query(`update agenda_item set meeting_id = $2, position = sub.p from (select id, row_number() over (order by created_at) as p from agenda_item where committee_id = $1 and status = 'ACCEPTED' and meeting_id is null) sub
                    where agenda_item.id = sub.id`, [committeeId, g.id]);
    await notify.toUsers(t, await memberUsers(t, committeeId, actor.id), { kind: 'GOVERNANCE', title: `${title}: ${when(starts.toISOString())}`,
      body: `${input.venue?.trim() || 'Online'}. Agenda items by ${when(closes.toISOString())}.`, link: `/governance/meetings/${g.id}` });
    return { id: g.id, number: n };
  }, { actor: actor.label });
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

async function loadMeeting(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Meeting');
  const g = await db.maybeOne<{ id: string; committee_id: string; number: number; title: string; kind: string; starts_at: string; ends_at: string | null; venue: string; video_link: string; agenda_closes: string;
    status: string; cancel_reason: string | null; quorum_met: boolean | null; minutes_status: string; minutes_note: string; circulated_at: string | null; confirmed_at: string | null; confirmed_by: string | null; version: number }>(
    `select g.*, u.name as confirmed_by from meeting g left join app_user u on u.id = g.confirmed_by where g.id = $1`, [id]);
  if (!g) throw notFound('Meeting');
  return g;
}

export async function updateMeeting(db: Db, actor: Actor, id: string, input: { title?: string; startsAt?: string; endsAt?: string | null; venue?: string; videoLink?: string; agendaCloses?: string }) {
  const g = await loadMeeting(db, id);
  await need(db, actor, g.committee_id, 'run');
  if (g.status !== 'SCHEDULED') throw invalid('Only a meeting still to come can be changed.');
  const moved = !!input.startsAt && new Date(input.startsAt).getTime() !== new Date(g.starts_at).getTime();
  await db.tx(async (t) => {
    await t.query(`update meeting set title = coalesce($2, title), starts_at = coalesce($3, starts_at), ends_at = coalesce($4, ends_at), venue = coalesce($5, venue),
                   video_link = coalesce($6, video_link), agenda_closes = coalesce($7, agenda_closes), reminded_at = case when $8 then null else reminded_at end where id = $1`,
      [id, input.title?.trim() || null, input.startsAt ?? null, input.endsAt ?? null, input.venue ?? null, input.videoLink ?? null, input.agendaCloses ?? null, moved]);
    if (moved) await notify.toUsers(t, await memberUsers(t, g.committee_id, actor.id), { kind: 'GOVERNANCE', title: `${g.title} moved to ${when(input.startsAt!)}`, link: `/governance/meetings/${id}` });
  }, { actor: actor.label });
  return meeting(db, actor, id);
}

export async function cancelMeeting(db: Db, actor: Actor, id: string, reason: string) {
  const g = await loadMeeting(db, id);
  await need(db, actor, g.committee_id, 'run');
  if (g.status !== 'SCHEDULED') throw invalid('Only a meeting still to come can be cancelled.');
  if (reason.trim().length < 3) throw invalid('Say why; members are told.');
  await db.tx(async (t) => {
    await t.query(`update meeting set status = 'CANCELLED', cancel_reason = $2 where id = $1`, [id, reason.trim()]);
    // Its agenda waits for the next meeting.
    await t.query(`update agenda_item set meeting_id = null, position = null where meeting_id = $1`, [id]);
    await notify.toUsers(t, await memberUsers(t, g.committee_id, actor.id), { kind: 'GOVERNANCE', title: `${g.title} is cancelled`, body: reason.trim(), link: `/governance/committees/${g.committee_id}` });
  }, { actor: actor.label });
  return { ok: true };
}

export async function meeting(db: Db, actor: Actor, id: string) {
  const g = await loadMeeting(db, id);
  const { c, r } = await need(db, actor, g.committee_id, 'see');
  const member = !!r.me;
  const items = await db.query(
    `select a.id, a.position, a.title, a.details, a.discussion, a.confidential, u.name as raised_by, o.name as for_school, a.from_decision
       from agenda_item a join app_user u on u.id = a.raised_by left join org_unit o on o.id = a.for_unit
      where a.meeting_id = $1 and a.status = 'ACCEPTED' and (not a.confidential or $2) order by a.position, a.created_at`, [id, member]);
  const attendance = await db.query(
    `select m.id as member_id, m.role, coalesce(u.name, m.external_name) as name, coalesce(u.designation, m.external_detail) as detail, x.status
       from committee_member m left join app_user u on u.id = m.user_id
       left join meeting_attendance x on x.meeting_id = $1 and x.member_id = m.id
      where m.committee_id = $2 and m.valid @> ($3::timestamptz at time zone 'Asia/Kolkata')::date
      order by array_position(array['CHAIR', 'CONVENER', 'MEMBER', 'INVITEE'], m.role), name`, [id, g.committee_id, g.starts_at]);
  // A decision taken out of the draft minutes is kept in the record but not shown in them.
  const decisions = (await decisionRows(db, actor, { meetingId: id })).filter((d) => !(d.status === 'NOT_ADOPTED' && !d.by_circulation));
  const comments = await db.query(`select k.id, k.body, k.at, u.name from minutes_comment k join app_user u on u.id = k.user_id where k.meeting_id = $1 order by k.at`, [id]);
  const present = attendance.filter((a: any) => a.status === 'PRESENT' && a.role !== 'INVITEE').length;
  const chairHasSignIn = !!(await db.maybeOne(`select 1 from committee_member where committee_id = $1 and role = 'CHAIR' and user_id is not null and valid @> current_date`, [g.committee_id]));
  return {
    ...g, committee: { id: c.id, name: c.name, kind: c.kind, quorum: c.quorum, unit: c.unit, unit_id: c.unit_id, unit_path: c.unit_path }, items, attendance, present, decisions, comments,
    rights: { run: r.run, member, chair: r.chair || (!chairHasSignIn && r.me?.role === 'CONVENER'), comment: member && g.minutes_status === 'CIRCULATED', submit: (r.submit || r.run) && g.status === 'SCHEDULED' },
  };
}

/** Marks who came; the meeting is then held, and the minutes can be written. */
export async function attendance(db: Db, actor: Actor, id: string, marks: { memberId: string; status: 'PRESENT' | 'ABSENT' | 'LEAVE' }[]) {
  const g = await loadMeeting(db, id);
  const { c } = await need(db, actor, g.committee_id, 'run');
  if (g.status === 'CANCELLED') throw invalid('This meeting was cancelled.');
  if (g.minutes_status === 'CONFIRMED') throw invalid('The minutes are confirmed.');
  if (new Date(g.starts_at).getTime() > Date.now() + 2 * 36e5) throw invalid('Attendance is marked at the meeting.');
  return db.tx(async (t) => {
    for (const m of marks) {
      const ok = await t.maybeOne('select 1 from committee_member where id = $1 and committee_id = $2', [m.memberId, g.committee_id]);
      if (!ok) throw invalid('Someone in the list is not a member of this committee.');
      await t.query(`insert into meeting_attendance (meeting_id, member_id, status) values ($1, $2, $3) on conflict (meeting_id, member_id) do update set status = excluded.status`, [id, m.memberId, m.status]);
    }
    const present = (await t.one<{ n: number }>(`select count(*)::int as n from meeting_attendance x join committee_member m on m.id = x.member_id where x.meeting_id = $1 and x.status = 'PRESENT' and m.role <> 'INVITEE'`, [id])).n;
    await t.query(`update meeting set status = 'HELD', quorum_met = $2, minutes_status = case when minutes_status = 'NONE' then 'DRAFT' else minutes_status end where id = $1`, [id, present >= c.quorum]);
    return { present, quorum: c.quorum, quorumMet: present >= c.quorum };
  }, { actor: actor.label });
}

export async function saveMinutes(db: Db, actor: Actor, id: string, input: { note?: string; items?: { id: string; discussion: string }[] }) {
  const g = await loadMeeting(db, id);
  await need(db, actor, g.committee_id, 'run');
  if (!['DRAFT', 'CIRCULATED'].includes(g.minutes_status)) throw invalid(g.minutes_status === 'CONFIRMED' ? 'The minutes are confirmed and cannot be changed.' : 'Mark attendance first; the minutes follow the meeting.');
  await db.tx(async (t) => {
    if (input.note !== undefined) await t.query('update meeting set minutes_note = $2 where id = $1', [id, input.note]);
    for (const it of input.items ?? []) await t.query('update agenda_item set discussion = $3 where id = $1 and meeting_id = $2', [it.id, id, it.discussion]);
  }, { actor: actor.label });
  return meeting(db, actor, id);
}

export async function circulate(db: Db, actor: Actor, id: string) {
  const g = await loadMeeting(db, id);
  await need(db, actor, g.committee_id, 'run');
  if (g.minutes_status !== 'DRAFT') throw invalid('Only draft minutes are circulated.');
  await db.tx(async (t) => {
    await t.query(`update meeting set minutes_status = 'CIRCULATED', circulated_at = now() where id = $1`, [id]);
    await notify.toUsers(t, await memberUsers(t, g.committee_id, actor.id), { kind: 'GOVERNANCE', title: `Minutes of the ${g.title} for your comments`, body: 'Read them and comment before the chair confirms them.', link: `/governance/meetings/${id}` });
  }, { actor: actor.label });
  return meeting(db, actor, id);
}

export async function comment(db: Db, actor: Actor, id: string, body: string) {
  const g = await loadMeeting(db, id);
  const { r } = await need(db, actor, g.committee_id, 'see');
  if (!r.me) throw forbidden('Members comment on the minutes.');
  if (g.minutes_status !== 'CIRCULATED') throw invalid('Comments are taken while the minutes are circulated.');
  await db.tx(async (t) => {
    await t.query('insert into minutes_comment (meeting_id, user_id, body) values ($1, $2, $3)', [id, actor.id, body.trim()]);
    const conv = await t.query<{ user_id: string }>(`select user_id from committee_member where committee_id = $1 and role in ('CONVENER', 'CHAIR') and user_id is not null and user_id <> $2 and valid @> current_date`, [g.committee_id, actor.id]);
    await notify.toUsers(t, conv.map((x) => x.user_id), { kind: 'GOVERNANCE', title: `${actor.name} commented on the minutes`, body: body.trim().slice(0, 140), link: `/governance/meetings/${id}` });
  }, { actor: actor.label });
  return meeting(db, actor, id);
}

/**
 * The chair confirms the minutes (or the convener, when the chair has no NavShiksha sign-in). They
 * are then locked; each decision takes its recorded outcome; decisions are sent to the schools they
 * affect; matters needing another meeting go onto the next agenda; owners are told.
 */
export async function confirm(db: Db, actor: Actor, id: string) {
  const m = await meeting(db, actor, id);
  if (!m.rights.chair) throw forbidden('The chair confirms the minutes.');
  if (m.minutes_status !== 'CIRCULATED') throw invalid('Circulate the minutes to members before they are confirmed.');
  const c = await loadCommittee(db, m.committee_id);
  return db.tx(async (t) => {
    await t.query(`update meeting set minutes_status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now() where id = $1`, [id, actor.id]);
    const ds = await t.query<{ id: string }>(`select id from decision where meeting_id = $1 and status = 'PROPOSED'`, [id]);
    for (const d of ds) await settle(t, actor, d.id, c);
    return { confirmed: true, decisions: ds.length };
  }, { actor: actor.label });
}

/** A proposed decision takes effect: its outcome becomes its status, and everything that follows from it happens. */
async function settle(t: Db, actor: Actor, decisionId: string, c: Committee, adoptedByVote: boolean | null = null) {
  const d = await t.one<{ id: string; ref: string; title: string; body: string; outcome: string; owner_id: string | null; confidential: boolean; meeting_id: string | null; agenda_item_id: string | null; due_on: string | null }>(
    'select id, ref, title, body, outcome, owner_id, confidential, meeting_id, agenda_item_id, due_on::text from decision where id = $1', [decisionId]);
  const status = adoptedByVote === false ? 'NOT_ADOPTED' : d.outcome;
  await t.query(`update decision set status = $2, decided_at = case when $2 = 'DECIDED' then now() else decided_at end where id = $1`, [d.id, status]);
  await t.query(`insert into decision_event (decision_id, from_status, to_status, note, by_user) values ($1, 'PROPOSED', $2, $3, $4)`,
    [d.id, status, adoptedByVote === null ? 'Minutes confirmed' : adoptedByVote ? 'Adopted by circulation' : 'Not adopted by circulation', actor.id]);
  if (status === 'NEEDS_MEETING') {
    // Onto the next meeting's agenda, or the next one to be scheduled.
    const next = await t.maybeOne<{ id: string }>(`select id from meeting where committee_id = $1 and status = 'SCHEDULED' and starts_at > now() order by starts_at limit 1`, [c.id]);
    await t.query(
      `insert into agenda_item (committee_id, meeting_id, position, title, details, raised_by, confidential, status, from_decision)
       values ($1, $2, case when $2::uuid is not null then (select coalesce(max(position), 0) + 1 from agenda_item where meeting_id = $2) end, $3, $4, $5, $6, 'ACCEPTED', $7)`,
      [c.id, next?.id ?? null, `${d.title} (carried forward, ${d.ref})`, d.body, actor.id, d.confidential, d.id]);
  }
  if (status !== 'DECIDED') return;
  const people = [d.owner_id, ...(await t.query<{ owner_id: string }>('select owner_id from decision_action where decision_id = $1', [d.id])).map((a) => a.owner_id)].filter((x): x is string => !!x && x !== actor.id);
  await notify.toUsers(t, people, { kind: 'TASK', title: `${d.ref}: ${d.title}`, body: d.due_on ? `Due ${notify.fmt(d.due_on)}. Update the progress as you go.` : 'Update the progress as you go.', link: `/governance/decisions/${d.id}` });
  if (d.confidential) return;
  // A circular to each school it reaches; the principal acknowledges it and reports the action taken.
  const schools = await t.query<{ school_id: string }>('select school_id from decision_school where decision_id = $1', [d.id]);
  for (const s of schools) {
    const n = await t.one<{ id: string }>(`insert into notice (unit_id, title, body, kind, audience, created_by) values ($1, $2, $3, 'CIRCULAR', 'STAFF', $4) returning id`,
      [s.school_id, `${c.name}: ${d.title}`, `${d.body}\n\nDecision ${d.ref}. The principal acknowledges it and reports the action taken in NavShiksha.`, actor.id]);
    await t.query('update decision_school set notice_id = $3 where decision_id = $1 and school_id = $2', [d.id, s.school_id, n.id]);
    const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.role = 'SCHOOL_ADMIN' and u.active and u.scope_path = o.path`, [s.school_id]);
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'GOVERNANCE', title: `Decision for your school: ${d.title}`, body: `${d.ref}. Acknowledge it and report the action taken.`, link: `/governance/decisions/${d.id}` });
  }
}

export async function minutesPdf(db: Db, actor: Actor, id: string) {
  const m = await meeting(db, actor, id);
  const draft = m.minutes_status !== 'CONFIRMED';
  return reportPdf(`${draft ? 'DRAFT · ' : ''}Minutes: ${m.title}`, `${m.committee.name} · ${m.committee.unit} · ${when(m.starts_at)}${m.venue ? ` · ${m.venue}` : ''}`, (r) => {
    r.heading('Attendance');
    const by = (s: string) => m.attendance.filter((a: any) => a.status === s).map((a: any) => `${a.name}${a.role !== 'MEMBER' ? ` (${a.role.toLowerCase()})` : ''}`).join(', ') || '—';
    r.pairs([['Present', by('PRESENT')], ['Leave of absence', by('LEAVE')], ['Absent', by('ABSENT')], ['Quorum', `${m.present} of ${m.committee.quorum} needed: ${m.quorum_met ? 'met' : 'not met'}`]]);
    if (m.minutes_note.trim()) { r.heading('Opening'); r.para(m.minutes_note); }
    m.items.forEach((it: any, i: number) => {
      r.heading(`${i + 1}. ${it.title}`);
      if (it.details) r.para(it.details, { muted: true });
      r.para(it.discussion || 'No discussion recorded.');
      for (const d of m.decisions.filter((x: any) => x.agenda_item_id === it.id)) r.para(`Decision ${d.ref} (${d.outcome.toLowerCase().replace('_', ' ')}): ${d.body}${d.owner ? ` Owner: ${d.owner}.` : ''}${d.due_on ? ` Due ${d.due_on}.` : ''}`, { font: r.fonts.bold, indent: 4 });
    });
    const loose = m.decisions.filter((x: any) => !x.agenda_item_id);
    if (loose.length) { r.heading('Other decisions'); loose.forEach((d: any) => r.para(`${d.ref}: ${d.title}. ${d.body}`)); }
    if (m.minutes_status === 'CONFIRMED') r.para(`Confirmed by ${m.confirmed_by} on ${when(m.confirmed_at!)}.`, { muted: true });
    r.signatures(['Convener', 'Chair']);
  });
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────

/** Visible decisions, as rows with progress. */
async function decisionRows(db: Db, actor: Actor, f: { committeeId?: string; meetingId?: string; status?: string; schoolId?: string; ownerId?: string; q?: string; overdue?: boolean; ids?: string[] }) {
  return db.query<any>(
    `with me as (select $1::uuid as uid, $2::ltree as scope, $3::boolean as mgr, $4::boolean as head)
     select d.id, d.ref, d.title, d.body, d.reason, d.outcome, d.status, d.due_on::text, d.confidential, d.by_circulation, d.circulation_closes::text, d.meeting_id, d.agenda_item_id,
            d.committee_id, c.name as committee, c.kind as committee_kind, o.name as unit, u.name as owner, d.owner_id, d.created_at, d.decided_at, d.closed_at,
            (select round(avg(case when a.status = 'DONE' then 100 else a.percent end))::int from decision_action a where a.decision_id = d.id and a.status <> 'DROPPED') as progress,
            (select count(*)::int from decision_action a where a.decision_id = d.id and a.status = 'OPEN') as open_actions,
            (select count(*)::int from decision_action a where a.decision_id = d.id and a.status = 'OPEN' and a.due_on < current_date) as overdue_actions,
            (d.due_on < current_date and d.status in ('DECIDED', 'IN_PROGRESS')) as overdue,
            (select count(*)::int from decision_school s where s.decision_id = d.id) as schools,
            (select count(*)::int from decision_school s where s.decision_id = d.id and s.reported_at is not null) as reported
       from decision d join committee c on c.id = d.committee_id join org_unit o on o.id = c.unit_id left join app_user u on u.id = d.owner_id, me
      where (
              exists (select 1 from committee_member m where m.committee_id = d.committee_id and m.user_id = me.uid and m.valid @> current_date)
           or (me.mgr and o.path <@ me.scope and not c.confidential and not d.confidential and d.status <> 'PROPOSED')
           or (d.status <> 'PROPOSED' and (d.owner_id = me.uid or exists (select 1 from decision_action a where a.decision_id = d.id and a.owner_id = me.uid)))
           or (me.head and not d.confidential and d.status <> 'PROPOSED' and exists (select 1 from decision_school s join org_unit so on so.id = s.school_id where s.decision_id = d.id and so.path <@ me.scope))
            )
        and ($5::uuid is null or d.committee_id = $5) and ($6::uuid is null or d.meeting_id = $6) and ($7::text is null or d.status = $7)
        and ($8::uuid is null or exists (select 1 from decision_school s where s.decision_id = d.id and s.school_id = $8))
        and ($9::uuid is null or d.owner_id = $9)
        and ($10::text is null or to_tsvector('english', d.title || ' ' || d.body || ' ' || d.reason) @@ plainto_tsquery('english', $10) or d.title ilike '%' || $10 || '%' or d.ref ilike '%' || $10 || '%')
        and (not $11 or (d.status in ('DECIDED', 'IN_PROGRESS') and (d.due_on < current_date or exists (select 1 from decision_action a where a.decision_id = d.id and a.status = 'OPEN' and a.due_on < current_date))))
        and ($12::uuid[] is null or d.id = any($12))
      order by (d.status in ('DECIDED', 'IN_PROGRESS')) desc, d.due_on nulls last, d.created_at desc limit 500`,
    [actor.id, actor.scopePath, MANAGERS.includes(actor.role), actor.role === 'SCHOOL_ADMIN', f.committeeId ?? null, f.meetingId ?? null, f.status ?? null, f.schoolId ?? null, f.ownerId ?? null,
      f.q?.trim() || null, !!f.overdue, f.ids ?? null]);
}

export const decisions = (db: Db, actor: Actor, f: { committeeId?: string; status?: string; schoolId?: string; ownerId?: string; q?: string; overdue?: boolean }) => {
  if (!actor.scopePath) throw forbidden();
  return decisionRows(db, actor, f);
};

async function nextRef(t: Db, c: Committee) {
  const year = academicYearOf(today());
  const n = (await t.one<{ n: number }>(`select count(*)::int + 1 as n from decision where committee_id = $1 and ref like $2`, [c.id, `%/${year}/%`])).n;
  return `${ABBR[c.kind]}${c.unit_kind === 'society' ? '' : `-${(await t.one<{ code: string }>('select code from org_unit where id = $1', [c.unit_id])).code}`}/${year}/${String(n).padStart(2, '0')}`;
}

export interface DecisionInput {
  agendaItemId?: string | null; title: string; body: string; reason?: string; outcome?: 'DECIDED' | 'DEFERRED' | 'NEEDS_MEETING';
  ownerId?: string | null; dueOn?: string | null; schoolIds?: string[]; confidential?: boolean; actions?: { title: string; ownerId: string; dueOn: string }[];
}

async function checkPeople(t: Db, c: Committee, input: DecisionInput) {
  for (const uid of [input.ownerId, ...(input.actions ?? []).map((a) => a.ownerId)].filter(Boolean) as string[]) {
    const ok = await t.maybeOne(`select 1 from app_user where id = $1 and active and role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF')`, [uid]);
    if (!ok) throw invalid('Owners are NES, Command or school staff with a NavShiksha sign-in.');
  }
  for (const sid of input.schoolIds ?? []) {
    const ok = await t.maybeOne(`select 1 from org_unit where id = $1 and kind = 'school' and path <@ $2::ltree`, [sid, c.unit_path]);
    if (!ok) throw invalid('A decision reaches only schools under the committee.');
  }
  if (input.dueOn && input.dueOn < today()) throw invalid('The due date is in the past.');
  for (const a of input.actions ?? []) if (a.dueOn < today()) throw invalid(`“${a.title}” is due in the past.`);
}

async function insertDecision(t: Db, actor: Actor, c: Committee, input: DecisionInput, extra: { meetingId: string | null; byCirculation: boolean; closes: string | null }) {
  const d = await t.one<{ id: string; ref: string }>(
    `insert into decision (committee_id, meeting_id, agenda_item_id, ref, title, body, reason, outcome, owner_id, due_on, confidential, by_circulation, circulation_closes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, ref`,
    [c.id, extra.meetingId, input.agendaItemId ?? null, await nextRef(t, c), input.title.trim(), input.body.trim(), input.reason?.trim() ?? '', input.outcome ?? 'DECIDED',
      input.ownerId ?? null, input.dueOn ?? null, input.confidential ?? c.confidential, extra.byCirculation, extra.closes, actor.id]);
  await t.query(`insert into decision_event (decision_id, to_status, note, by_user) values ($1, 'PROPOSED', $2, $3)`, [d.id, extra.byCirculation ? 'Put to members by circulation' : 'Recorded in the minutes', actor.id]);
  for (const s of new Set(input.schoolIds ?? [])) await t.query('insert into decision_school (decision_id, school_id) values ($1, $2)', [d.id, s]);
  for (const a of input.actions ?? []) await t.query('insert into decision_action (decision_id, title, owner_id, due_on, created_by) values ($1, $2, $3, $4, $5)', [d.id, a.title.trim(), a.ownerId, a.dueOn, actor.id]);
  return d;
}

/** A decision recorded in the minutes, with its actions and the schools it reaches, in one form. */
export async function recordDecision(db: Db, actor: Actor, meetingId: string, input: DecisionInput) {
  const g = await loadMeeting(db, meetingId);
  const { c } = await need(db, actor, g.committee_id, 'run');
  if (g.status !== 'HELD' || g.minutes_status === 'CONFIRMED') throw invalid('Decisions are recorded in the minutes of a meeting that has been held, before they are confirmed.');
  if ((input.outcome ?? 'DECIDED') === 'DECIDED' && !g.quorum_met) throw invalid('The quorum was not met, so the meeting cannot take decisions. Record the item as deferred or needing another meeting.');
  if (input.agendaItemId && !(await db.maybeOne(`select 1 from agenda_item where id = $1 and meeting_id = $2`, [input.agendaItemId, meetingId]))) throw invalid('That item is not on this meeting’s agenda.');
  return db.tx(async (t) => {
    await checkPeople(t, c, input);
    return insertDecision(t, actor, c, input, { meetingId, byCirculation: false, closes: null });
  }, { actor: actor.label });
}

export async function editDecision(db: Db, actor: Actor, id: string, input: Partial<DecisionInput>) {
  const d = await loadDecision(db, id);
  const { c } = await need(db, actor, d.committee_id, 'run');
  if (d.status !== 'PROPOSED' || d.by_circulation) throw invalid('Only a decision in minutes not yet confirmed can be changed.');
  await db.tx(async (t) => {
    await checkPeople(t, c, { title: '', body: '', ...input });
    await t.query(`update decision set title = coalesce($2, title), body = coalesce($3, body), reason = coalesce($4, reason), outcome = coalesce($5, outcome),
                   owner_id = case when $6 then $7::uuid else owner_id end, due_on = case when $8 then $9::date else due_on end, confidential = coalesce($10, confidential) where id = $1`,
      [id, input.title?.trim() || null, input.body?.trim() || null, input.reason ?? null, input.outcome ?? null, input.ownerId !== undefined, input.ownerId ?? null, input.dueOn !== undefined, input.dueOn ?? null, input.confidential ?? null]);
    if (input.schoolIds) {
      await t.query('delete from decision_school where decision_id = $1', [id]);
      for (const s of new Set(input.schoolIds)) await t.query('insert into decision_school (decision_id, school_id) values ($1, $2)', [id, s]);
    }
  }, { actor: actor.label });
  return decision(db, actor, id);
}

/** Takes a decision out of draft minutes (before they are confirmed). */
export async function dropDecision(db: Db, actor: Actor, id: string) {
  const d = await loadDecision(db, id);
  await need(db, actor, d.committee_id, 'run');
  if (d.status !== 'PROPOSED' || d.by_circulation) throw invalid('Only a decision in minutes not yet confirmed can be taken out.');
  await db.tx(async (t) => {
    await t.query('delete from decision_action where decision_id = $1', [id]);
    await t.query('delete from decision_school where decision_id = $1', [id]);
    await t.query(`update decision set status = 'NOT_ADOPTED', meeting_id = meeting_id where id = $1`, [id]);
    await t.query(`insert into decision_event (decision_id, from_status, to_status, note, by_user) values ($1, 'PROPOSED', 'NOT_ADOPTED', 'Taken out of the draft minutes', $2)`, [id, actor.id]);
  }, { actor: actor.label });
  return { ok: true };
}

/** A resolution put to members between meetings; they vote by the closing date. */
export async function proposeByCirculation(db: Db, actor: Actor, committeeId: string, input: DecisionInput & { closesOn: string }) {
  const { c } = await need(db, actor, committeeId, 'run');
  if (input.closesOn < today()) throw invalid('Voting must close today or later.');
  return db.tx(async (t) => {
    await checkPeople(t, c, input);
    const d = await insertDecision(t, actor, c, { ...input, outcome: 'DECIDED' }, { meetingId: null, byCirculation: true, closes: input.closesOn });
    const voters = (await t.query<{ user_id: string }>(`select user_id from committee_member where committee_id = $1 and role <> 'INVITEE' and user_id is not null and valid @> current_date`, [committeeId])).map((x) => x.user_id);
    await notify.toUsers(t, voters, { kind: 'GOVERNANCE', title: `Your vote: ${input.title.trim()}`, body: `${c.name}. Voting closes ${notify.fmt(input.closesOn)}.`, link: `/governance/decisions/${d.id}` });
    return d;
  }, { actor: actor.label });
}

export async function vote(db: Db, actor: Actor, id: string, input: { vote: 'YES' | 'NO' | 'ABSTAIN'; note?: string }) {
  const d = await loadDecision(db, id);
  const c = await loadCommittee(db, d.committee_id);
  const me = await myMembership(db, actor, c.id);
  if (!me || me.role === 'INVITEE') throw forbidden('Members of the committee vote.');
  if (!d.by_circulation || d.status !== 'PROPOSED') throw invalid('This resolution is not open for votes.');
  if (d.circulation_closes! < today()) throw invalid('Voting has closed.');
  try {
    await db.tx((t) => t.query('insert into decision_vote (decision_id, member_id, vote, note) values ($1, $2, $3, $4)', [id, me.id, input.vote, input.note?.trim() ?? '']), { actor: actor.label });
  } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('already_voted', 'You have already voted; a vote cannot be changed.'); throw e; }
  // Once everyone has voted, the result is declared at once.
  const left = await db.one<{ n: number }>(`select count(*)::int as n from committee_member m where m.committee_id = $1 and m.role <> 'INVITEE' and m.user_id is not null and m.valid @> current_date
                                             and not exists (select 1 from decision_vote v where v.decision_id = $2 and v.member_id = m.id)`, [c.id, id]);
  if (left.n === 0) await countVotes(db, actor, id);
  return decision(db, actor, id);
}

/** Declares a resolution by circulation: adopted when more vote for than against and enough members voted for a quorum. */
export async function countVotes(db: Db, actor: Actor | null, id: string) {
  const d = await loadDecision(db, id);
  const c = await loadCommittee(db, d.committee_id);
  if (actor) {
    const r = await rights(db, actor, c);
    const everyone = (await db.one<{ n: number }>(`select count(*)::int as n from committee_member m where m.committee_id = $1 and m.role <> 'INVITEE' and m.user_id is not null and m.valid @> current_date and not exists (select 1 from decision_vote v where v.decision_id = $2 and v.member_id = m.id)`, [c.id, id])).n === 0;
    if (!r.run && !everyone) throw forbidden();
    if (!everyone && d.circulation_closes! >= today()) throw invalid('Voting is still open.');
  }
  if (!d.by_circulation || d.status !== 'PROPOSED') return { status: d.status };
  const v = await db.one<{ yes: number; no: number; cast: number }>(`select count(*) filter (where vote = 'YES')::int as yes, count(*) filter (where vote = 'NO')::int as no, count(*)::int as cast from decision_vote where decision_id = $1`, [id]);
  const adopted = v.yes > v.no && v.cast >= c.quorum;
  const by = actor ?? { id: d.created_by, label: 'NavShiksha (voting closed)' } as Actor;
  await db.tx((t) => settle(t, by, id, c, adopted), { actor: by.label });
  return { status: adopted ? 'DECIDED' : 'NOT_ADOPTED', ...v };
}

async function loadDecision(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Decision');
  const d = await db.maybeOne<{ id: string; committee_id: string; status: string; by_circulation: boolean; circulation_closes: string | null; owner_id: string | null; created_by: string; confidential: boolean }>(
    'select id, committee_id, status, by_circulation, circulation_closes::text, owner_id, created_by, confidential from decision where id = $1', [id]);
  if (!d) throw notFound('Decision');
  return d;
}

export async function decision(db: Db, actor: Actor, id: string) {
  const [d] = await decisionRows(db, actor, { ids: [id] });
  if (!d) { await loadDecision(db, id); throw forbidden('This decision is for the committee’s members and the people it concerns.'); }
  const c = await loadCommittee(db, d.committee_id);
  const r = await rights(db, actor, c);
  const actions = await db.query(
    `select a.id, a.title, a.owner_id, u.name as owner, a.due_on::text, a.percent, a.status, (a.status = 'OPEN' and a.due_on < current_date) as overdue,
            coalesce((select json_agg(json_build_object('percent', x.percent, 'note', x.note, 'at', x.at, 'by', w.name) order by x.at desc) from action_update x join app_user w on w.id = x.by_user where x.action_id = a.id), '[]') as updates
       from decision_action a join app_user u on u.id = a.owner_id where a.decision_id = $1 order by a.due_on, a.created_at`, [id]);
  const schools = await db.query(
    `select s.school_id, o.name as school, s.acknowledged_at, ua.name as acknowledged_by, s.report, s.reported_at, ur.name as reported_by,
            (o.path <@ $2::ltree and $3) as mine
       from decision_school s join org_unit o on o.id = s.school_id left join app_user ua on ua.id = s.acknowledged_by left join app_user ur on ur.id = s.reported_by
      where s.decision_id = $1 order by o.name`, [id, actor.scopePath, actor.role === 'SCHOOL_ADMIN']);
  const votes = d.by_circulation ? await db.query(
    `select coalesce(u.name, m.external_name) as name, v.vote, v.note, v.at from decision_vote v join committee_member m on m.id = v.member_id left join app_user u on u.id = m.user_id where v.decision_id = $1 order by v.at`, [id]) : [];
  const events = await db.query(`select e.from_status, e.to_status, e.note, e.at, u.name as by from decision_event e left join app_user u on u.id = e.by_user where e.decision_id = $1 order by e.at`, [id]);
  const myVote = r.me ? await db.maybeOne<{ vote: string }>('select vote from decision_vote where decision_id = $1 and member_id = $2', [id, r.me.id]) : null;
  const owner = d.owner_id === actor.id;
  return {
    ...d, committeeConfidential: c.confidential, committeeUnitId: c.unit_id, actions, schools, votes, events,
    rights: {
      run: r.run, owner,
      progress: LIVE.includes(d.status) && (owner || r.run),
      close: r.run && ['DECIDED', 'IN_PROGRESS', 'IMPLEMENTED'].includes(d.status),
      vote: d.by_circulation && d.status === 'PROPOSED' && !!r.me && r.me.role !== 'INVITEE' && !myVote && d.circulation_closes >= today(),
      myVote: myVote?.vote ?? null,
      count: d.by_circulation && d.status === 'PROPOSED' && r.run,
    },
  };
}

/** The owner (or the convener) moves a decision on: owner, due date, implemented, closed, or back to the committee. */
export async function setDecision(db: Db, actor: Actor, id: string, input: { status?: 'IMPLEMENTED' | 'CLOSED' | 'NEEDS_MEETING'; ownerId?: string; dueOn?: string; note?: string }) {
  const d = await decision(db, actor, id);
  if (!d.rights.progress && !d.rights.close) throw forbidden('The owner or the convener moves a decision on.');
  const c = await loadCommittee(db, d.committee_id);
  if (input.status === 'CLOSED' && !d.rights.close) throw forbidden('The convener or the chair closes a decision.');
  if (input.status && !d.rights.close && !(input.status === 'IMPLEMENTED' && d.rights.progress)) throw forbidden();
  const unreported = (d.schools as { reported_at: string | null }[]).filter((x) => !x.reported_at).length;
  if (input.status === 'CLOSED' && unreported) throw invalid(`${unreported} school(s) have not reported the action taken yet.`);
  await db.tx(async (t) => {
    if (input.ownerId || input.dueOn) await checkPeople(t, c, { title: '', body: '', ownerId: input.ownerId, dueOn: input.dueOn });
    await t.query(`update decision set owner_id = coalesce($2, owner_id), due_on = coalesce($3, due_on), status = coalesce($4, status),
                   closed_at = case when $4 = 'CLOSED' then now() else closed_at end where id = $1`, [id, input.ownerId ?? null, input.dueOn ?? null, input.status ?? null]);
    if (input.status) {
      await t.query('insert into decision_event (decision_id, from_status, to_status, note, by_user) values ($1, $2, $3, $4, $5)', [id, d.status, input.status, input.note?.trim() ?? '', actor.id]);
      if (input.status === 'NEEDS_MEETING') await t.query(
        `insert into agenda_item (committee_id, title, details, raised_by, confidential, status, from_decision) values ($1, $2, $3, $4, $5, 'ACCEPTED', $6)`,
        [c.id, `${d.title} (back to the committee, ${d.ref})`, input.note?.trim() || d.body, actor.id, d.confidential, id]);
    }
    if (input.ownerId && input.ownerId !== actor.id) await notify.toUsers(t, [input.ownerId], { kind: 'TASK', title: `You own ${d.ref}: ${d.title}`, link: `/governance/decisions/${id}` });
  }, { actor: actor.label });
  return decision(db, actor, id);
}

export async function addAction(db: Db, actor: Actor, decisionId: string, input: { title: string; ownerId: string; dueOn: string }) {
  const d = await decision(db, actor, decisionId);
  if (!d.rights.progress) throw forbidden('The decision’s owner or the convener adds actions.');
  const c = await loadCommittee(db, d.committee_id);
  await db.tx(async (t) => {
    await checkPeople(t, c, { title: '', body: '', actions: [input] });
    await t.query('insert into decision_action (decision_id, title, owner_id, due_on, created_by) values ($1, $2, $3, $4, $5)', [decisionId, input.title.trim(), input.ownerId, input.dueOn, actor.id]);
    if (d.status === 'IMPLEMENTED') await t.query(`update decision set status = 'IN_PROGRESS' where id = $1`, [decisionId]);
    if (input.ownerId !== actor.id) await notify.toUsers(t, [input.ownerId], { kind: 'TASK', title: `Action for you: ${input.title.trim()}`, body: `${d.ref} · due ${notify.fmt(input.dueOn)}`, link: `/governance/decisions/${decisionId}` });
  }, { actor: actor.label });
  return decision(db, actor, decisionId);
}

/**
 * The action's owner reports progress (a percentage and what was done). The decision follows:
 * in progress from the first update, implemented when every action is done.
 */
export async function updateAction(db: Db, actor: Actor, actionId: string, input: { percent: number; note: string; status?: 'DONE' | 'DROPPED' }) {
  if (!UUID.test(actionId)) throw notFound('Action');
  const a = await db.maybeOne<{ decision_id: string; owner_id: string; status: string; title: string }>('select decision_id, owner_id, status, title from decision_action where id = $1', [actionId]);
  if (!a) throw notFound('Action');
  const d = await decision(db, actor, a.decision_id);
  if (a.owner_id !== actor.id && !d.rights.progress) throw forbidden('The action’s owner reports its progress.');
  if (input.status === 'DROPPED' && !d.rights.progress) throw forbidden('The decision’s owner or the convener drops an action.');
  if (!LIVE.includes(d.status) && d.status !== 'IMPLEMENTED') throw invalid('This decision is not being carried out.');
  if (a.status !== 'OPEN') throw invalid('This action is finished.');
  const percent = input.status === 'DONE' ? 100 : Math.max(0, Math.min(100, Math.round(input.percent)));
  const status = input.status ?? (percent === 100 ? 'DONE' : 'OPEN');
  await db.tx(async (t) => {
    await t.query('insert into action_update (action_id, by_user, percent, note) values ($1, $2, $3, $4)', [actionId, actor.id, percent, input.note.trim()]);
    await t.query('update decision_action set percent = $2, status = $3 where id = $1', [actionId, percent, status]);
    const left = (await t.one<{ open: number; done: number }>(`select count(*) filter (where status = 'OPEN')::int as open, count(*) filter (where status = 'DONE')::int as done from decision_action where decision_id = $1`, [a.decision_id]));
    const next = left.open === 0 && left.done > 0 ? 'IMPLEMENTED' : 'IN_PROGRESS';
    if (next !== d.status && (d.status === 'DECIDED' || next === 'IMPLEMENTED')) {
      await t.query('update decision set status = $2 where id = $1', [a.decision_id, next]);
      await t.query('insert into decision_event (decision_id, from_status, to_status, note, by_user) values ($1, $2, $3, $4, $5)', [a.decision_id, d.status, next, next === 'IMPLEMENTED' ? 'Every action done' : `Work started: ${a.title}`, actor.id]);
    }
    const tell = [d.owner_id].filter((x) => x && x !== actor.id) as string[];
    await notify.toUsers(t, tell, { kind: 'TASK', title: `${a.title}: ${percent}%`, body: input.note.trim().slice(0, 140), link: `/governance/decisions/${a.decision_id}` });
  }, { actor: actor.label });
  return decision(db, actor, a.decision_id);
}

async function assertHead(db: Db, actor: Actor, decisionId: string, schoolId: string) {
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal acknowledges decisions and reports the action taken.');
  await assertUnitInScope(db, actor, schoolId);
  const s = await db.maybeOne<{ acknowledged_at: string | null; reported_at: string | null }>('select acknowledged_at, reported_at from decision_school where decision_id = $1 and school_id = $2', [decisionId, schoolId]);
  if (!s) throw notFound('Decision for this school');
  const d = await loadDecision(db, decisionId);
  if (d.status === 'PROPOSED' || d.confidential) throw notFound('Decision for this school');
  return s;
}

export async function acknowledge(db: Db, actor: Actor, decisionId: string, schoolId: string) {
  const s = await assertHead(db, actor, decisionId, schoolId);
  if (!s.acknowledged_at) await db.tx((t) => t.query('update decision_school set acknowledged_at = now(), acknowledged_by = $3 where decision_id = $1 and school_id = $2', [decisionId, schoolId, actor.id]), { actor: actor.label });
  return decision(db, actor, decisionId);
}

export async function reportAction(db: Db, actor: Actor, decisionId: string, schoolId: string, report: string) {
  const s = await assertHead(db, actor, decisionId, schoolId);
  if (report.trim().length < 10) throw invalid('Say what the school has done, in a sentence or two.');
  await db.tx(async (t) => {
    await t.query(`update decision_school set acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $3), report = $4, reported_at = now(), reported_by = $3
                   where decision_id = $1 and school_id = $2`, [decisionId, schoolId, actor.id, report.trim()]);
    const d = await t.one<{ owner_id: string | null; ref: string; committee_id: string }>('select owner_id, ref, committee_id from decision where id = $1', [decisionId]);
    const conv = await t.query<{ user_id: string }>(`select user_id from committee_member where committee_id = $1 and role = 'CONVENER' and user_id is not null and valid @> current_date`, [d.committee_id]);
    await notify.toUsers(t, [d.owner_id, ...conv.map((x) => x.user_id)].filter((x): x is string => !!x && x !== actor.id), { kind: 'GOVERNANCE', title: `${d.ref}: action taken reported`, body: report.trim().slice(0, 140), link: `/governance/decisions/${decisionId}` });
  }, { actor: actor.label });
  void s;
  return decision(db, actor, decisionId);
}

// ── Dashboard, my work, search ───────────────────────────────────────────────────────────────

export async function dashboard(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  const all = (await decisionRows(db, actor, {})).filter((d) => d.status !== 'PROPOSED');
  const group = (key: (d: any) => string) => {
    const m = new Map<string, { name: string; open: number; overdue: number; implemented: number; closed: number }>();
    for (const d of all) {
      const k = key(d); if (!k) continue;
      const g = m.get(k) ?? { name: k, open: 0, overdue: 0, implemented: 0, closed: 0 };
      if (LIVE.includes(d.status)) g.open++;
      if (d.overdue || d.overdue_actions) g.overdue++;
      if (d.status === 'IMPLEMENTED') g.implemented++;
      if (d.status === 'CLOSED') g.closed++;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  };
  const atr = await db.query(
    `select o.name as school, count(*)::int as sent, count(s.acknowledged_at)::int as acknowledged, count(s.reported_at)::int as reported
       from decision_school s join decision d on d.id = s.decision_id join org_unit o on o.id = s.school_id
      where d.status <> 'PROPOSED' and not d.confidential and o.path <@ $1::ltree and d.id = any($2::uuid[])
      group by o.name order by (count(*) - count(s.reported_at)) desc, o.name`, [actor.scopePath, all.map((d) => d.id)]);
  return {
    totals: {
      open: all.filter((d) => LIVE.includes(d.status)).length,
      overdue: all.filter((d) => LIVE.includes(d.status) && (d.overdue || d.overdue_actions)).length,
      implemented: all.filter((d) => d.status === 'IMPLEMENTED').length,
      closed: all.filter((d) => d.status === 'CLOSED').length,
      waiting: all.filter((d) => ['DEFERRED', 'NEEDS_MEETING'].includes(d.status)).length,
    },
    overdue: all.filter((d) => LIVE.includes(d.status) && (d.overdue || d.overdue_actions)).slice(0, 30),
    byCommittee: group((d) => d.committee), byOwner: group((d) => d.owner ?? ''), atr,
    upcoming: await db.query(
      `select g.id, g.title, g.starts_at, g.venue, c.name as committee from meeting g join committee c on c.id = g.committee_id join org_unit o on o.id = c.unit_id
        where g.status = 'SCHEDULED' and g.starts_at > now() - interval '3 hours'
          and (exists (select 1 from committee_member m where m.committee_id = c.id and m.user_id = $1 and m.valid @> current_date) or ($3 and o.path <@ $2::ltree and not c.confidential))
        order by g.starts_at limit 12`, [actor.id, actor.scopePath, MANAGERS.includes(actor.role)]),
  };
}

/** What waits for this person: meetings, actions, votes, minutes to confirm, items to triage, reports for their school. */
export async function mine(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  const actions = await db.query(
    `select a.id, a.title, a.due_on::text, a.percent, (a.due_on < current_date) as overdue, d.id as decision_id, d.ref, d.title as decision
       from decision_action a join decision d on d.id = a.decision_id where a.owner_id = $1 and a.status = 'OPEN' and d.status in ('DECIDED', 'IN_PROGRESS', 'IMPLEMENTED') order by a.due_on`, [actor.id]);
  const owned = (await decisionRows(db, actor, { ownerId: actor.id })).filter((d) => LIVE.includes(d.status));
  const meetings = await db.query(
    `select g.id, g.title, g.starts_at, g.venue, g.video_link, c.name as committee, m.role from meeting g join committee c on c.id = g.committee_id
       join committee_member m on m.committee_id = c.id and m.user_id = $1 and m.valid @> current_date
      where g.status = 'SCHEDULED' and g.starts_at > now() - interval '3 hours' order by g.starts_at limit 20`, [actor.id]);
  const votes = await db.query(
    `select d.id, d.ref, d.title, d.circulation_closes::text, c.name as committee from decision d join committee c on c.id = d.committee_id
       join committee_member m on m.committee_id = c.id and m.user_id = $1 and m.role <> 'INVITEE' and m.user_id is not null and m.valid @> current_date
      where d.by_circulation and d.status = 'PROPOSED' and d.circulation_closes >= current_date
        and not exists (select 1 from decision_vote v where v.decision_id = d.id and v.member_id = m.id)`, [actor.id]);
  const toConfirm = await db.query(
    `select g.id, g.title, c.name as committee from meeting g join committee c on c.id = g.committee_id
       join committee_member m on m.committee_id = c.id and m.user_id = $1 and m.valid @> current_date
      where g.minutes_status = 'CIRCULATED' and (m.role = 'CHAIR' or (m.role = 'CONVENER' and not exists (select 1 from committee_member x where x.committee_id = c.id and x.role = 'CHAIR' and x.user_id is not null and x.valid @> current_date)))`, [actor.id]);
  const toTriage = await db.query(
    `select c.id, c.name, count(*)::int as items from agenda_item a join committee c on c.id = a.committee_id
       join committee_member m on m.committee_id = c.id and m.user_id = $1 and m.role in ('CONVENER', 'CHAIR') and m.valid @> current_date
      where a.status = 'SUBMITTED' group by c.id, c.name`, [actor.id]);
  const forSchool = actor.role === 'SCHOOL_ADMIN' ? await db.query(
    `select d.id, d.ref, d.title, c.name as committee, s.school_id, s.acknowledged_at, s.reported_at from decision_school s join decision d on d.id = s.decision_id
       join committee c on c.id = d.committee_id join org_unit o on o.id = s.school_id
      where o.path <@ $1::ltree and s.reported_at is null and d.status not in ('PROPOSED', 'NOT_ADOPTED', 'DEFERRED', 'NEEDS_MEETING') and not d.confidential order by d.decided_at`, [actor.scopePath]) : [];
  return { actions, owned, meetings, votes, toConfirm, toTriage, forSchool };
}

export async function search(db: Db, actor: Actor, q: string) {
  if (!actor.scopePath) throw forbidden();
  if (q.trim().length < 2) return { decisions: [], items: [] };
  const decisions = await decisionRows(db, actor, { q });
  const items = await db.query(
    `select a.id, a.title, left(a.discussion, 300) as discussion, g.id as meeting_id, g.title as meeting, g.starts_at, c.name as committee
       from agenda_item a join meeting g on g.id = a.meeting_id join committee c on c.id = a.committee_id join org_unit o on o.id = c.unit_id
      where g.minutes_status = 'CONFIRMED' and a.status = 'ACCEPTED'
        and (a.title ilike '%' || $3 || '%' or a.discussion ilike '%' || $3 || '%')
        and (exists (select 1 from committee_member m where m.committee_id = c.id and m.user_id = $1 and m.valid @> current_date)
             or ($4 and o.path <@ $2::ltree and not c.confidential and not a.confidential))
      order by g.starts_at desc limit 50`, [actor.id, actor.scopePath, q.trim(), MANAGERS.includes(actor.role)]);
  return { decisions, items };
}

/** Whether to show the governance screens to someone who is not NES, a Command or a principal. */
export async function involved(db: Db, actor: Actor) {
  if (!actor.scopePath) return false;
  if (MANAGERS.includes(actor.role)) return true;
  return !!(await db.maybeOne(
    `select 1 where exists (select 1 from committee_member where user_id = $1 and valid @> current_date)
               or exists (select 1 from decision_action where owner_id = $1 and status = 'OPEN')
               or exists (select 1 from decision where owner_id = $1 and status in ('DECIDED', 'IN_PROGRESS'))`, [actor.id]));
}

// ── Timed work ───────────────────────────────────────────────────────────────────────────────

/** Reminders a day before a meeting, weekly reminders for overdue actions, and circulation results. */
export async function tick(db: Db) {
  const soon = await db.query<{ id: string; committee_id: string; title: string; starts_at: string; venue: string }>(
    `select id, committee_id, title, starts_at, venue from meeting where status = 'SCHEDULED' and reminded_at is null and starts_at between now() and now() + interval '24 hours'`);
  for (const g of soon) await db.tx(async (t) => {
    await notify.toUsers(t, await memberUsers(t, g.committee_id), { kind: 'GOVERNANCE', title: `Tomorrow: ${g.title}`, body: `${when(g.starts_at)}${g.venue ? ` · ${g.venue}` : ''}`, link: `/governance/meetings/${g.id}` });
    await t.query('update meeting set reminded_at = now() where id = $1', [g.id]);
  }, { actor: 'NavShiksha reminders' });
  const late = await db.query<{ id: string; owner_id: string; title: string; due_on: string; decision_id: string }>(
    `select a.id, a.owner_id, a.title, a.due_on::text, a.decision_id from decision_action a join decision d on d.id = a.decision_id
      where a.status = 'OPEN' and a.due_on < current_date and d.status in ('DECIDED', 'IN_PROGRESS') and (a.reminded_on is null or a.reminded_on <= current_date - 7)`);
  for (const a of late) await db.tx(async (t) => {
    await notify.toUsers(t, [a.owner_id], { kind: 'TASK', title: `Overdue: ${a.title}`, body: `It was due ${notify.fmt(a.due_on)}. Update the progress or ask for a new date.`, link: `/governance/decisions/${a.decision_id}` });
    await t.query('update decision_action set reminded_on = current_date where id = $1', [a.id]);
  }, { actor: 'NavShiksha reminders' });
  const closed = await db.query<{ id: string }>(`select id from decision where by_circulation and status = 'PROPOSED' and circulation_closes < current_date`);
  for (const d of closed) await countVotes(db, null, d.id);
  return { reminded: soon.length, overdue: late.length, counted: closed.length };
}
