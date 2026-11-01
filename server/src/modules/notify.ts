import type { Db } from '../db/client.js';
import type { Actor } from './auth.js';

export type Kind = 'HOMEWORK' | 'NOTICE' | 'ATTENDANCE' | 'LEAVE' | 'MESSAGE' | 'FEES' | 'EVENT' | 'RESULT' | 'AWARD' | 'PROXY' | 'LIBRARY' | 'CERTIFICATE' | 'TRANSFER' | 'CHAT' | 'PAY' | 'TRANSPORT' | 'SUPPORT' | 'RECRUITMENT' | 'HEALTH' | 'GATE' | 'STORES' | 'ALUMNI' | 'GOVERNANCE' | 'TASK' | 'INSPECTION';
export interface Note { kind: Kind; title: string; body?: string; link?: string }

/** "2026-10-16" → "Fri 16 Oct", for notification text people read on a phone. */
export const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const fmtRange = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);

/**
 * Notifications are written in the same transaction as the event that causes them, so a rolled
 * back change never notifies anyone. A matching outbox row lets the dispatcher send push or SMS.
 */
export async function toParentsOf(t: Db, studentIds: string[], n: Note) {
  if (!studentIds.length) return 0;
  const rows = await t.query(
    `insert into notification (user_id, student_id, kind, title, body, link)
     select u.id, sg.student_id, $2, $3, $4, $5
       from student_guardian sg join app_user u on u.guardian_id = sg.guardian_id and u.active
      where sg.student_id = any($1::uuid[])
     returning id`, [studentIds, n.kind, n.title, n.body ?? '', n.link ?? null]);
  if (rows.length) await t.query(`insert into outbox (topic, payload) values ('notify.push', $1)`, [JSON.stringify({ kind: n.kind, title: n.title, count: rows.length })]);
  return rows.length;
}

export async function toUsers(t: Db, userIds: string[], n: Note, studentId: string | null = null) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const rows = await t.query(
    `insert into notification (user_id, student_id, kind, title, body, link)
     select u, $2, $3, $4, $5, $6 from unnest($1::uuid[]) u returning id`, [ids, studentId, n.kind, n.title, n.body ?? '', n.link ?? null]);
  return rows.length;
}

export async function mine(db: Db, actor: Actor, limit = 60) {
  const items = await db.query(
    `select n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, n.student_id, s.name as student_name
       from notification n left join student s on s.id = n.student_id
      where n.user_id = $1 order by n.created_at desc, n.id desc limit $2`, [actor.id, limit]);
  const { unread } = await db.one<{ unread: number }>('select count(*)::int as unread from notification where user_id = $1 and read_at is null', [actor.id]);
  return { unread, items };
}

/** Marks some (or all) of the signed-in person's notifications read. Others' rows are untouched. */
export async function markRead(db: Db, actor: Actor, ids: number[] | 'all') {
  return db.tx(async (t) => {
    const rows = ids === 'all'
      ? await t.query('update notification set read_at = now() where user_id = $1 and read_at is null returning id', [actor.id])
      : await t.query('update notification set read_at = now() where user_id = $1 and read_at is null and id = any($2::bigint[]) returning id', [actor.id, ids]);
    return { marked: rows.length };
  }, { actor: actor.label });
}
