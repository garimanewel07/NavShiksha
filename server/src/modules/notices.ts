import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertStudentAccess } from './access.js';
import { currentEnrolment } from './sections.js';
import * as notify from './notify.js';

export interface NoticeInput {
  unitId: string; title: string; body: string;
  kind: 'CIRCULAR' | 'NOTICE' | 'EVENT' | 'URGENT'; audience: 'ALL' | 'PARENTS' | 'STAFF';
  classCodes?: string[]; isPublic?: boolean;
}

/**
 * NES, a Command or a school issues a notice; it reaches every school under that unit. Parents
 * (and, for ALL or STAFF, staff) get a notification in the same transaction.
 */
export async function create(db: Db, actor: Actor, input: NoticeInput) {
  requireRole(actor, 'NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN');
  await assertUnitInScope(db, actor, input.unitId);
  const classCodes = input.classCodes?.length ? input.classCodes : null;
  return db.tx(async (t) => {
    const n = await t.one<{ id: string; path: string }>(
      `insert into notice (unit_id, title, body, kind, audience, class_codes, is_public, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, (select path::text from org_unit where id = $1) as path`,
      [input.unitId, input.title.trim(), input.body.trim(), input.kind, input.audience, classCodes, input.isPublic ?? false, actor.id]);
    let parents = 0, staff = 0;
    const note = { kind: 'NOTICE' as const, title: input.title.trim(), body: input.body.trim().slice(0, 140), link: `/notices/${n.id}` };
    if (input.audience !== 'STAFF') {
      const kids = await t.query<{ student_id: string }>(
        `select e.student_id from enrolment e join org_unit o on o.id = e.school_id
          where o.path <@ $1::ltree and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
            and ($2::text[] is null or e.class_code = any($2))`, [n.path, classCodes]);
      parents = await notify.toParentsOf(t, kids.map((k) => k.student_id), note);
    }
    if (input.audience !== 'PARENTS') {
      const users = await t.query<{ id: string }>(`select id from app_user where active and role <> 'PARENT' and scope_path <@ $1::ltree and id <> $2`, [n.path, actor.id]);
      staff = await notify.toUsers(t, users.map((u) => u.id), { ...note, link: '/notices' });
    }
    return { id: n.id, notified: { parents, staff } };
  }, { actor: actor.label });
}

export async function withdraw(db: Db, actor: Actor, id: string) {
  const n = await db.maybeOne<{ unit_id: string }>('select unit_id from notice where id = $1', [id]);
  if (!n) throw notFound('Notice');
  requireRole(actor, 'NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN');
  await assertUnitInScope(db, actor, n.unit_id);
  await db.tx((t) => t.query('update notice set withdrawn_at = now() where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

const SELECT = `select n.id, n.title, n.body, n.kind, n.audience, n.class_codes, n.is_public, n.created_at, n.withdrawn_at,
                       o.name as issued_by_unit, o.kind as unit_kind, u.name as issued_by,
                       coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'type', a.content_type) order by a.uploaded_at) from attachment a
                       where a.ref_kind = 'notice' and a.ref_id = n.id and a.removed_at is null), '[]') as attachments
                  from notice n join org_unit o on o.id = n.unit_id join app_user u on u.id = n.created_by`;

/** Staff see notices issued inside their scope and those from above that apply to them. */
export async function forStaff(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  return db.query(`${SELECT} where (o.path <@ $1::ltree or o.path @> $1::ltree) order by n.created_at desc limit 100`, [actor.scopePath]);
}

/** A child's notices: from the school and every unit above it, for the child's class. */
export async function forStudent(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  return db.query(
    `${SELECT} join org_unit sch on sch.id = $1
      where o.path @> sch.path and n.withdrawn_at is null and n.audience in ('ALL', 'PARENTS')
        and (n.class_codes is null or $2 = any(n.class_codes))
      order by n.created_at desc limit 60`, [e.school_id, e.class_code]);
}

export async function one(db: Db, actor: Actor, id: string, studentId?: string) {
  const n = await db.maybeOne<Record<string, unknown>>(`${SELECT} where n.id = $1`, [id]);
  if (!n) throw notFound('Notice');
  if (actor.role === 'PARENT') {
    if (!studentId) throw invalid('Choose a child.');
    const visible = (await forStudent(db, actor, studentId)).some((x) => x.id === id);
    if (!visible) throw notFound('Notice');
  } else {
    const ok = (await forStaff(db, actor)).some((x) => x.id === id);
    if (!ok) throw notFound('Notice');
  }
  return n;
}

/** Public notices for a school website. */
export async function publicFor(db: Db, schoolId: string, limit: number) {
  return db.query(
    `select n.id, n.title, n.body, n.kind, n.created_at from notice n join org_unit o on o.id = n.unit_id join org_unit sch on sch.id = $1
      where o.path @> sch.path and n.is_public and n.withdrawn_at is null order by n.created_at desc limit $2`, [schoolId, limit]);
}

// ── Academic calendar ───────────────────────────────────────────────────────────────────────

export interface EventInput { unitId: string; title: string; kind: 'HOLIDAY' | 'VACATION' | 'EXAM' | 'EVENT' | 'PTM'; from: string; to: string; details?: string; notify?: boolean }

export async function addEvent(db: Db, actor: Actor, input: EventInput) {
  requireRole(actor, 'NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN');
  await assertUnitInScope(db, actor, input.unitId);
  if (input.to < input.from) throw invalid('The end date is before the start date.');
  return db.tx(async (t) => {
    const ev = await t.one<{ id: string; path: string }>(
      `insert into calendar_event (unit_id, title, kind, period, details, created_by) values ($1, $2, $3, daterange($4::date, ($5::date + 1)), $6, $7)
       returning id, (select path::text from org_unit where id = $1) as path`,
      [input.unitId, input.title.trim(), input.kind, input.from, input.to, input.details ?? '', actor.id]);
    let notified = 0;
    if (input.notify) {
      const kids = await t.query<{ student_id: string }>(
        `select e.student_id from enrolment e join org_unit o on o.id = e.school_id
          where o.path <@ $1::ltree and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`, [ev.path]);
      const when = notify.fmtRange(input.from, input.to);
      notified = await notify.toParentsOf(t, kids.map((k) => k.student_id), { kind: 'EVENT', title: input.title.trim(), body: when, link: '/calendar' });
    }
    return { id: ev.id, notified };
  }, { actor: actor.label });
}

export async function removeEvent(db: Db, actor: Actor, id: string) {
  const ev = await db.maybeOne<{ unit_id: string }>('select unit_id from calendar_event where id = $1', [id]);
  if (!ev) throw notFound('Event');
  requireRole(actor, 'NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN');
  await assertUnitInScope(db, actor, ev.unit_id);
  await db.tx((t) => t.query('delete from calendar_event where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

/** Events that apply to a school (its own and every unit above it) between two dates. */
export async function eventsForSchool(db: Db, schoolId: string, from: string, to: string) {
  return db.query(
    `select ev.id, ev.title, ev.kind, lower(ev.period)::text as starts, (upper(ev.period) - 1)::text as ends, ev.details, o.name as unit, o.kind as unit_kind
       from calendar_event ev join org_unit o on o.id = ev.unit_id join org_unit sch on sch.id = $1
      where o.path @> sch.path and ev.period && daterange($2::date, $3::date, '[]')
      order by lower(ev.period), ev.title`, [schoolId, from, to]);
}

export async function eventsForStaff(db: Db, actor: Actor, from: string, to: string) {
  if (!actor.scopePath) throw forbidden();
  return db.query(
    `select ev.id, ev.title, ev.kind, lower(ev.period)::text as starts, (upper(ev.period) - 1)::text as ends, ev.details, o.name as unit, o.kind as unit_kind, ev.unit_id
       from calendar_event ev join org_unit o on o.id = ev.unit_id
      where (o.path <@ $1::ltree or o.path @> $1::ltree) and ev.period && daterange($2::date, $3::date, '[]')
      order by lower(ev.period), ev.title`, [actor.scopePath, from, to]);
}
