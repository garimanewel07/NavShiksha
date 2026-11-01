import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';

/**
 * Staff chat: one person to another, groups, every school's staff group, the principals of all
 * Navy schools, and announcement channels from NES and from each Command. Parents are not part of
 * it; they have Messages.
 *
 * Everything said is end-to-end encrypted on the people's own devices (see 0020_chat.sql). This
 * module only keeps who is in which conversation, hands out the public keys and the wrapped
 * conversation keys, and stores ciphertext it cannot read. It enforces the rules that keep the
 * encryption honest: a message must use the conversation's current key, and the key changes
 * whenever someone joins or leaves.
 */

const UUID = /^[0-9a-f-]{36}$/i;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

function staffOnly(actor: Actor) {
  if (actor.role === 'PARENT') throw forbidden('Chat is for staff. Parents talk to the school through Messages.');
}

// ── Identity: the person's key pair, and the PIN-protected backup of the private key ──────

export interface IdentityInput { publicKey: string; keyBackup: string; backupSalt: string; backupIv: string; backupIterations: number; fingerprint: string }

export async function identity(db: Db, actor: Actor) {
  staffOnly(actor);
  return db.maybeOne(`select public_key as "publicKey", key_backup as "keyBackup", backup_salt as "backupSalt", backup_iv as "backupIv",
      backup_iterations as "backupIterations", fingerprint, key_version as "keyVersion" from chat_identity where user_id = $1`, [actor.id]);
}

/** First set-up, or a reset after a forgotten PIN (a new key: earlier messages cannot be read again). */
export async function setIdentity(db: Db, actor: Actor, input: IdentityInput, reset = false) {
  staffOnly(actor);
  for (const [k, v] of Object.entries({ publicKey: input.publicKey, keyBackup: input.keyBackup, backupSalt: input.backupSalt, backupIv: input.backupIv })) {
    if (!/^[A-Za-z0-9+/=]{16,8000}$/.test(v)) throw invalid(`The ${k} is not valid.`);
  }
  if (!/^[0-9A-F ]{20,120}$/.test(input.fingerprint)) throw invalid('The fingerprint is not valid.');
  if (!Number.isInteger(input.backupIterations) || input.backupIterations < 200_000) throw invalid('The PIN protection is too weak.');
  const had = await db.maybeOne<{ key_version: number }>('select key_version from chat_identity where user_id = $1', [actor.id]);
  if (had && !reset) throw conflict('exists', 'Secure chat is already set up for you. Enter your chat PIN to open it on this device.');
  if (!had && reset) throw notFound('Chat key');
  return db.tx(async (t) => {
    if (had) {
      await t.query(`update chat_identity set public_key = $2, key_backup = $3, backup_salt = $4, backup_iv = $5, backup_iterations = $6, fingerprint = $7,
          key_version = key_version + 1, updated_at = now() where user_id = $1`,
        [actor.id, input.publicKey, input.keyBackup, input.backupSalt, input.backupIv, input.backupIterations, input.fingerprint]);
      // Everyone this person talks to is told the key changed, as the safety number differs now.
      const convs = await t.query<{ conversation_id: string }>('select conversation_id from chat_member where user_id = $1 and left_at is null', [actor.id]);
      for (const c of convs) await system(t, c.conversation_id, `${actor.name}'s security key changed (a new device or a reset PIN).`);
    } else {
      await t.query(`insert into chat_identity (user_id, public_key, key_backup, backup_salt, backup_iv, backup_iterations, fingerprint) values ($1, $2, $3, $4, $5, $6, $7)`,
        [actor.id, input.publicKey, input.keyBackup, input.backupSalt, input.backupIv, input.backupIterations, input.fingerprint]);
    }
    return { keyVersion: had ? had.key_version + 1 : 1 };
  }, { actor: actor.label });
}

// ── Groups the system keeps ─────────────────────────────────────────────────────────────────

interface Want { auto: string; unitId: string; kind: 'GROUP' | 'CHANNEL'; title: string; members: Map<string, { role: 'ADMIN' | 'MEMBER'; canPost: boolean }> }

/**
 * Brings the automatic groups in line with the staff lists: every school's staff, the principals
 * of all the Navy schools, NES announcements to everybody, and each Command's announcements to
 * the staff of its schools. People who join get the next key; people who leave lose access.
 */
export async function syncAutoGroups(db: Db) {
  const staff = await db.query<{ id: string; role: string; path: string }>(`select id, role, scope_path::text as path from app_user u where active and role <> 'PARENT' and scope_path is not null and not exists (select 1 from employee e where e.user_id = u.id and e.separated_on < current_date)`);
  const units = await db.query<{ id: string; kind: string; name: string; path: string }>(`select id, kind, name, path::text as path from org_unit where active and kind in ('society', 'command', 'school')`);
  const under = (p: string, unit: string) => p === unit || p.startsWith(`${unit}.`);
  const wants: Want[] = [];
  const nes = units.find((u) => u.kind === 'society');
  for (const s of units.filter((u) => u.kind === 'school')) {
    const m = new Map(staff.filter((u) => under(u.path, s.path)).map((u) => [u.id, { role: (u.role === 'SCHOOL_ADMIN' ? 'ADMIN' : 'MEMBER') as 'ADMIN' | 'MEMBER', canPost: true }]));
    if (m.size) wants.push({ auto: 'SCHOOL_STAFF', unitId: s.id, kind: 'GROUP', title: `All staff · ${s.name.replace('Navy Children School, ', 'NCS ').replace('Navy Kindergarten, ', 'NKG ')}`, members: m });
  }
  if (nes) {
    wants.push({ auto: 'PRINCIPALS', unitId: nes.id, kind: 'GROUP', title: 'Principals of the Navy schools',
      members: new Map(staff.filter((u) => ['SCHOOL_ADMIN', 'NES_ADMIN', 'COMMAND_OFFICER'].includes(u.role)).map((u) => [u.id, { role: u.role === 'NES_ADMIN' ? 'ADMIN' : 'MEMBER', canPost: true }])) });
    wants.push({ auto: 'NES_ALL', unitId: nes.id, kind: 'CHANNEL', title: 'NES announcements',
      members: new Map(staff.map((u) => [u.id, { role: u.role === 'NES_ADMIN' ? 'ADMIN' : 'MEMBER', canPost: u.role === 'NES_ADMIN' }])) });
  }
  for (const c of units.filter((u) => u.kind === 'command')) {
    const m = new Map(staff.filter((u) => under(u.path, c.path) || u.role === 'NES_ADMIN').map((u) => [u.id, { role: (u.role === 'COMMAND_OFFICER' || u.role === 'NES_ADMIN' ? 'ADMIN' : 'MEMBER') as 'ADMIN' | 'MEMBER', canPost: u.role === 'COMMAND_OFFICER' || u.role === 'NES_ADMIN' }]));
    if ([...m.keys()].some((id) => staff.find((s) => s.id === id)?.role === 'COMMAND_OFFICER')) {
      wants.push({ auto: 'COMMAND', unitId: c.id, kind: 'CHANNEL', title: `${c.name} · announcements`, members: m });
    }
  }
  let changed = 0;
  for (const w of wants) {
    await db.tx(async (t) => {
      const conv = await t.one<{ id: string }>(
        `insert into chat_conversation (kind, title, auto, unit_id) values ($1, $2, $3, $4)
         on conflict (auto, unit_id) where auto is not null do update set title = excluded.title returning id`, [w.kind, w.title, w.auto, w.unitId]);
      const now = await t.query<{ user_id: string; role: string; can_post: boolean; left_at: string | null }>('select user_id, role, can_post, left_at from chat_member where conversation_id = $1', [conv.id]);
      const have = new Map(now.map((r) => [r.user_id, r]));
      let membership = false;
      for (const [id, m] of w.members) {
        const h = have.get(id);
        if (!h) { await t.query(`insert into chat_member (conversation_id, user_id, role, can_post) values ($1, $2, $3, $4)`, [conv.id, id, m.role, m.canPost]); membership = true; }
        else if (h.left_at) { await t.query(`update chat_member set left_at = null, joined_at = now(), role = $3, can_post = $4 where conversation_id = $1 and user_id = $2`, [conv.id, id, m.role, m.canPost]); membership = true; }
        else if (h.role !== m.role || h.can_post !== m.canPost) await t.query(`update chat_member set role = $3, can_post = $4 where conversation_id = $1 and user_id = $2`, [conv.id, id, m.role, m.canPost]);
      }
      for (const h of now) if (!h.left_at && !w.members.has(h.user_id)) { await t.query(`update chat_member set left_at = now() where conversation_id = $1 and user_id = $2`, [conv.id, h.user_id]); membership = true; }
      if (membership) { await rekey(t, conv.id); changed++; }
    }, { actor: 'chat-sync' });
  }
  return { groups: wants.length, changed };
}

let lastSync = 0;
async function syncNowAndThen(db: Db) {
  if (Date.now() - lastSync < 5 * 60_000) return;
  lastSync = Date.now();
  await syncAutoGroups(db);
}

/** After anyone joins or leaves, the next message needs a new conversation key. */
async function rekey(t: Db, conversationId: string) {
  await t.query('update chat_conversation set needs_epoch = epoch + 1 where id = $1 and needs_epoch <= epoch', [conversationId]);
}

async function system(t: Db, conversationId: string, text: string) {
  await t.query(`insert into chat_message (conversation_id, kind, system_text) values ($1, 'SYSTEM', $2)`, [conversationId, text.slice(0, 300)]);
  await t.query('update chat_conversation set last_message_at = now() where id = $1', [conversationId]);
}

// ── People and conversations ───────────────────────────────────────────────────────────────

/** Staff anyone may write to: every active member of staff in the Navy schools, NES and the Commands. */
export async function directory(db: Db, actor: Actor, q: string) {
  staffOnly(actor);
  const term = q.trim();
  if (term.length < 2) return [];
  return db.query(
    `select u.id, u.name, u.designation, coalesce((select o.name from org_unit o where o.path = u.scope_path), 'Navy Education Society') as unit,
            exists (select 1 from chat_identity i where i.user_id = u.id) as ready
       from app_user u where u.active and u.role <> 'PARENT' and u.id <> $1 and (u.name ilike $2 or u.designation ilike $2)
      order by (u.scope_path = $3::ltree) desc, u.name limit 30`, [actor.id, `%${term.replace(/[%_]/g, '')}%`, actor.scopePath]);
}

async function membership(db: Db, actor: Actor, conversationId: string) {
  staffOnly(actor);
  if (!UUID.test(conversationId)) throw notFound('Conversation');
  const m = await db.maybeOne<{ role: string; can_post: boolean; joined_at: string; left_at: string | null; kind: string; auto: string | null; epoch: number; needs_epoch: number; title: string | null }>(
    `select m.role, m.can_post, m.joined_at, m.left_at, c.kind, c.auto, c.epoch, c.needs_epoch, c.title from chat_member m join chat_conversation c on c.id = m.conversation_id
      where m.conversation_id = $1 and m.user_id = $2`, [conversationId, actor.id]);
  if (!m || m.left_at) throw forbidden('You are not in this conversation.');
  return m;
}

export async function conversations(db: Db, actor: Actor) {
  staffOnly(actor);
  await syncNowAndThen(db);
  return db.query(
    `select c.id, c.kind, c.auto, c.epoch, c.needs_epoch, m.role, m.can_post, c.last_message_at,
            case when c.kind = 'DIRECT' then o.name else c.title end as title,
            case when c.kind = 'DIRECT' then o.designation end as subtitle, o.id as other_id,
            (select count(*) from chat_member x where x.conversation_id = c.id and x.left_at is null)::int as members,
            (select count(*) from chat_message g where g.conversation_id = c.id and g.created_at > greatest(m.joined_at, coalesce(r.read_at, m.joined_at))
               and coalesce(g.sender_id, '00000000-0000-0000-0000-000000000000') <> $1 and g.deleted_at is null)::int as unread,
            last.id as last_id, last.kind as last_kind, last.epoch as last_epoch, last.iv as last_iv, last.ciphertext as last_ciphertext, last.system_text as last_system,
            last.deleted_at is not null as last_deleted, ls.name as last_sender, last.sender_id as last_sender_id,
            -- This device can help: it holds the current key and someone who set up chat lacks it, or the key must move on.
            (c.needs_epoch > c.epoch or (exists (select 1 from chat_key k join chat_identity me on me.user_id = k.user_id and me.key_version = k.recipient_key_version
                                                 where k.conversation_id = c.id and k.epoch = c.epoch and k.user_id = $1)
               and exists (select 1 from chat_member x join chat_identity i on i.user_id = x.user_id where x.conversation_id = c.id and x.left_at is null
                           and not exists (select 1 from chat_key k2 where k2.conversation_id = c.id and k2.epoch = c.epoch and k2.user_id = x.user_id and k2.recipient_key_version = i.key_version)))) as needs_keys
       from chat_member m join chat_conversation c on c.id = m.conversation_id
       left join chat_read r on r.conversation_id = c.id and r.user_id = m.user_id
       left join lateral (select u.id, u.name, u.designation from chat_member y join app_user u on u.id = y.user_id where c.kind = 'DIRECT' and y.conversation_id = c.id and y.user_id <> $1 limit 1) o on true
       left join lateral (select * from chat_message g where g.conversation_id = c.id and g.created_at >= m.joined_at order by g.created_at desc limit 1) last on true
       left join app_user ls on ls.id = last.sender_id
      where m.user_id = $1 and m.left_at is null
      order by coalesce(c.last_message_at, c.created_at) desc`, [actor.id]);
}

/** Unread messages across all conversations, for the badge in the menu. */
export async function unread(db: Db, actor: Actor) {
  if (actor.role === 'PARENT') return { unread: 0 };
  const r = await db.one<{ n: number }>(
    `select count(*)::int as n from chat_member m join chat_message g on g.conversation_id = m.conversation_id
       left join chat_read r on r.conversation_id = m.conversation_id and r.user_id = m.user_id
      where m.user_id = $1 and m.left_at is null and g.created_at > greatest(m.joined_at, coalesce(r.read_at, m.joined_at))
        and g.sender_id is distinct from $1 and g.deleted_at is null`, [actor.id]);
  return { unread: r.n };
}

/** One-to-one: the same conversation every time for the same two people. */
export async function direct(db: Db, actor: Actor, userId: string) {
  staffOnly(actor);
  if (!UUID.test(userId) || userId === actor.id) throw invalid('Choose someone else.');
  const other = await db.maybeOne<{ name: string }>(`select name from app_user where id = $1 and active and role <> 'PARENT'`, [userId]);
  if (!other) throw notFound('Staff member');
  const pair = [actor.id, userId].sort().join(':');
  return db.tx(async (t) => {
    const found = await t.maybeOne<{ id: string }>('select id from chat_conversation where direct_pair = $1', [pair]);
    if (found) return { id: found.id };
    const c = await t.one<{ id: string }>(`insert into chat_conversation (kind, direct_pair, created_by) values ('DIRECT', $1, $2) returning id`, [pair, actor.id]);
    await t.query(`insert into chat_member (conversation_id, user_id, role) values ($1, $2, 'ADMIN'), ($1, $3, 'ADMIN')`, [c.id, actor.id, userId]);
    return { id: c.id };
  }, { actor: actor.label });
}

export async function createGroup(db: Db, actor: Actor, input: { title: string; memberIds: string[] }) {
  staffOnly(actor);
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw invalid('Give the group a name of up to 80 letters.');
  const ids = [...new Set(input.memberIds.filter((x) => x !== actor.id))];
  if (!ids.length) throw invalid('Add at least one person.');
  if (ids.length > 500) throw invalid('A group has at most 500 people.');
  const ok = await db.query<{ id: string; name: string }>(`select id, name from app_user where id = any($1) and active and role <> 'PARENT'`, [ids]);
  if (ok.length !== ids.length) throw invalid('Some of those people cannot be added (only staff can be in a group).');
  return db.tx(async (t) => {
    const c = await t.one<{ id: string }>(`insert into chat_conversation (kind, title, created_by) values ('GROUP', $1, $2) returning id`, [title, actor.id]);
    await t.query(`insert into chat_member (conversation_id, user_id, role) values ($1, $2, 'ADMIN')`, [c.id, actor.id]);
    for (const u of ok) await t.query(`insert into chat_member (conversation_id, user_id) values ($1, $2)`, [c.id, u.id]);
    await system(t, c.id, `${actor.name} made the group "${title}".`);
    return { id: c.id };
  }, { actor: actor.label });
}

/**
 * A conversation as one member sees it: the members with their public keys (and whether they
 * have set up chat), the key epoch, and this person's wrapped keys for every epoch since joining.
 */
export async function detail(db: Db, actor: Actor, conversationId: string) {
  const me = await membership(db, actor, conversationId);
  const members = await db.query<{ id: string; name: string; designation: string | null; unit: string; role: string; can_post: boolean; public_key: string | null; key_version: number | null; fingerprint: string | null }>(
    `select u.id, u.name, u.designation, coalesce((select o.name from org_unit o where o.path = u.scope_path), 'Navy Education Society') as unit, m.role, m.can_post,
            i.public_key, i.key_version, i.fingerprint
       from chat_member m join app_user u on u.id = m.user_id left join chat_identity i on i.user_id = u.id
      where m.conversation_id = $1 and m.left_at is null order by (m.role = 'ADMIN') desc, u.name`, [conversationId]);
  const mine = await db.query(
    `select k.epoch, k.wrapped_key as "wrappedKey", k.iv, k.wrapped_by as "wrappedBy", k.wrapper_public_key as "wrapperPublicKey"
       from chat_key k join chat_identity i on i.user_id = k.user_id and i.key_version = k.recipient_key_version
      where k.conversation_id = $1 and k.user_id = $2 order by k.epoch`, [conversationId, actor.id]);
  // Members who have set up chat but hold no key for the current epoch (joined since, or reset their PIN).
  const missing = me.epoch === 0 ? [] : (await db.query<{ user_id: string }>(
    `select m.user_id from chat_member m join chat_identity i on i.user_id = m.user_id
      where m.conversation_id = $1 and m.left_at is null
        and not exists (select 1 from chat_key k where k.conversation_id = $1 and k.epoch = $2 and k.user_id = m.user_id and k.recipient_key_version = i.key_version)`,
    [conversationId, me.epoch])).map((r) => r.user_id);
  const c = await db.one<{ title: string | null; kind: string; auto: string | null; created_by: string | null }>('select title, kind, auto, created_by from chat_conversation where id = $1', [conversationId]);
  return { id: conversationId, kind: c.kind, auto: c.auto, title: c.kind === 'DIRECT' ? members.find((m) => m.id !== actor.id)?.name ?? 'Chat' : c.title,
    myRole: me.role, canPost: me.can_post, epoch: me.epoch, needsEpoch: me.needs_epoch, members, myKeys: mine, missing };
}

export interface Envelope { userId: string; wrappedKey: string; iv: string; recipientKeyVersion: number }

/**
 * Stores conversation keys wrapped by one member for others. Starting a new epoch must cover every
 * member who has set up chat; adding to the current epoch covers members who lack it.
 */
export async function putKeys(db: Db, actor: Actor, conversationId: string, input: { epoch: number; envelopes: Envelope[] }) {
  const me = await membership(db, actor, conversationId);
  const mine = await db.maybeOne<{ public_key: string; key_version: number }>('select public_key, key_version from chat_identity where user_id = $1', [actor.id]);
  if (!mine) throw conflict('no_identity', 'Set up secure chat first.');
  return db.tx(async (t) => {
    const c = await t.one<{ epoch: number; needs_epoch: number }>('select epoch, needs_epoch from chat_conversation where id = $1 for update', [conversationId]);
    const ready = await t.query<{ user_id: string; key_version: number }>(
      `select m.user_id, i.key_version from chat_member m join chat_identity i on i.user_id = m.user_id where m.conversation_id = $1 and m.left_at is null`, [conversationId]);
    const version = new Map(ready.map((r) => [r.user_id, r.key_version]));
    for (const e of input.envelopes) {
      if (!version.has(e.userId)) throw invalid('A key was wrapped for someone who is not in this conversation or has no chat key.');
      if (version.get(e.userId) !== e.recipientKeyVersion) throw conflict('stale', 'Someone’s chat key changed; reload and try again.');
      if (!/^[A-Za-z0-9+/=]{16,400}$/.test(e.wrappedKey) || !/^[A-Za-z0-9+/=]{12,40}$/.test(e.iv)) throw invalid('A wrapped key is not valid.');
    }
    if (input.epoch === c.needs_epoch && input.epoch > c.epoch) {
      const covered = new Set(input.envelopes.map((e) => e.userId));
      if (ready.some((r) => !covered.has(r.user_id))) throw conflict('incomplete', 'The new key must be shared with every member who has set up chat.');
      await t.query('update chat_conversation set epoch = $2 where id = $1', [conversationId, input.epoch]);
    } else if (input.epoch === c.epoch && c.epoch > 0) {
      const has = await t.maybeOne('select 1 from chat_key where conversation_id = $1 and epoch = $2 and user_id = $3', [conversationId, c.epoch, actor.id]);
      if (!has) throw forbidden('Only someone who holds the key can share it.');
    } else {
      throw conflict('rekey', 'The conversation key has moved on; reload and try again.');
    }
    for (const e of input.envelopes) {
      await t.query(
        `insert into chat_key (conversation_id, epoch, user_id, wrapped_key, iv, wrapped_by, wrapper_public_key, recipient_key_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
        [conversationId, input.epoch, e.userId, e.wrappedKey, e.iv, actor.id, mine.public_key, e.recipientKeyVersion]);
    }
    void me;
    return { epoch: input.epoch, stored: input.envelopes.length };
  }, { actor: actor.label });
}

// ── Messages and files ─────────────────────────────────────────────────────────────────────

export async function send(db: Db, actor: Actor, conversationId: string, input: { epoch: number; iv: string; ciphertext: string; attachmentId?: string | null; replyTo?: string | null }) {
  const me = await membership(db, actor, conversationId);
  if (!me.can_post) throw forbidden('Only the people who run this channel can post in it.');
  if (!/^[A-Za-z0-9+/=]{12,40}$/.test(input.iv) || !/^[A-Za-z0-9+/=]+$/.test(input.ciphertext) || input.ciphertext.length > 200_000) throw invalid('The message is not valid.');
  return db.tx(async (t) => {
    const c = await t.one<{ epoch: number; needs_epoch: number }>('select epoch, needs_epoch from chat_conversation where id = $1 for update', [conversationId]);
    if (c.epoch !== c.needs_epoch || input.epoch !== c.epoch) throw conflict('rekey', 'Someone joined or left, so the conversation key changed. Sending again uses the new key.');
    if (input.attachmentId) {
      const a = await t.maybeOne('select 1 from chat_attachment a where a.id = $1 and a.conversation_id = $2 and a.uploaded_by = $3 and not exists (select 1 from chat_message m where m.attachment_id = a.id)',
        [input.attachmentId, conversationId, actor.id]);
      if (!a) throw invalid('That file was not uploaded to this conversation.');
    }
    if (input.replyTo && !(await t.maybeOne('select 1 from chat_message where id = $1 and conversation_id = $2', [input.replyTo, conversationId]))) throw invalid('That message is not in this conversation.');
    const m = await t.one<{ id: string; created_at: string }>(
      `insert into chat_message (conversation_id, sender_id, kind, epoch, iv, ciphertext, attachment_id, reply_to) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
      [conversationId, actor.id, input.attachmentId ? 'FILE' : 'TEXT', input.epoch, input.iv, input.ciphertext, input.attachmentId ?? null, input.replyTo ?? null]);
    await t.query('update chat_conversation set last_message_at = $2 where id = $1', [conversationId, m.created_at]);
    await t.query(`insert into chat_read (conversation_id, user_id, read_at) values ($1, $2, $3) on conflict (conversation_id, user_id) do update set read_at = excluded.read_at`, [conversationId, actor.id, m.created_at]);
    return m;
  }, { actor: actor.label });
}

/** Messages since this person joined, newest last. `after` fetches only new ones (for polling). */
export async function messages(db: Db, actor: Actor, conversationId: string, opts: { before?: string; after?: string; limit?: number } = {}) {
  const me = await membership(db, actor, conversationId);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const rows = await db.query(
    `select g.id, g.sender_id as "senderId", u.name as sender, g.kind, g.epoch, g.iv, g.ciphertext, g.system_text as "systemText", g.attachment_id as "attachmentId",
            a.size_bytes as "size", g.reply_to as "replyTo", g.created_at as "createdAt", g.deleted_at is not null as deleted
       from chat_message g left join app_user u on u.id = g.sender_id left join chat_attachment a on a.id = g.attachment_id
      where g.conversation_id = $1 and g.created_at >= $2 and ($3::timestamptz is null or g.created_at < $3) and ($4::timestamptz is null or g.created_at > $4)
      order by g.created_at ${opts.after ? 'asc' : 'desc'} limit ${limit}`, [conversationId, me.joined_at, opts.before ?? null, opts.after ?? null]);
  return opts.after ? rows : rows.reverse();
}

export async function markRead(db: Db, actor: Actor, conversationId: string) {
  await membership(db, actor, conversationId);
  await db.tx((t) => t.query(`insert into chat_read (conversation_id, user_id, read_at) values ($1, $2, now()) on conflict (conversation_id, user_id) do update set read_at = now()`, [conversationId, actor.id]), { actor: actor.label });
  return { ok: true };
}

/** The sender deletes a message for everyone: its encrypted content (and file) is erased. */
export async function remove(db: Db, actor: Actor, messageId: string) {
  staffOnly(actor);
  if (!UUID.test(messageId)) throw notFound('Message');
  const m = await db.maybeOne<{ conversation_id: string; sender_id: string | null; attachment_id: string | null; deleted_at: string | null }>(
    'select conversation_id, sender_id, attachment_id, deleted_at from chat_message where id = $1', [messageId]);
  if (!m) throw notFound('Message');
  if (m.sender_id !== actor.id) throw forbidden('Only the sender can delete a message.');
  if (m.deleted_at) return { ok: true };
  await membership(db, actor, m.conversation_id);
  await db.tx(async (t) => {
    await t.query('update chat_message set deleted_at = now(), ciphertext = null, iv = null where id = $1', [messageId]);
    if (m.attachment_id) await t.query(`update chat_attachment set data = '\\x00'::bytea, size_bytes = 1 where id = $1`, [m.attachment_id]);
  }, { actor: actor.label });
  return { ok: true };
}

/** An encrypted file (image or document), uploaded before the message that carries its key. */
export async function upload(db: Db, actor: Actor, conversationId: string, data: Uint8Array) {
  const me = await membership(db, actor, conversationId);
  if (!me.can_post) throw forbidden('Only the people who run this channel can post in it.');
  if (!data.length) throw invalid('The file is empty.');
  if (data.length > MAX_FILE_BYTES + 64) throw invalid('Files can be up to 25 MB.');
  const r = await db.tx((t) => t.one<{ id: string }>(`insert into chat_attachment (conversation_id, uploaded_by, size_bytes, data) values ($1, $2, $3, $4) returning id`,
    [conversationId, actor.id, Math.min(data.length, MAX_FILE_BYTES), Buffer.from(data)]), { actor: actor.label });
  return { id: r.id };
}

export async function download(db: Db, actor: Actor, attachmentId: string) {
  staffOnly(actor);
  if (!UUID.test(attachmentId)) throw notFound('File');
  const a = await db.maybeOne<{ conversation_id: string; data: Buffer; created_at: string }>('select conversation_id, data, created_at from chat_attachment where id = $1', [attachmentId]);
  if (!a) throw notFound('File');
  const me = await membership(db, actor, a.conversation_id);
  if (new Date(a.created_at) < new Date(me.joined_at)) throw forbidden('This file was shared before you joined.');
  return a.data;
}

// ── Members of a group ─────────────────────────────────────────────────────────────────────

async function groupAdmin(db: Db, actor: Actor, conversationId: string) {
  const me = await membership(db, actor, conversationId);
  if (me.kind !== 'GROUP' || me.auto) throw forbidden(me.auto ? 'This group follows the staff lists; its members change by themselves.' : 'Only groups have members to manage.');
  if (me.role !== 'ADMIN') throw forbidden('Only the group’s admins can change its members.');
  return me;
}

export async function addMembers(db: Db, actor: Actor, conversationId: string, userIds: string[]) {
  await groupAdmin(db, actor, conversationId);
  const ok = await db.query<{ id: string; name: string }>(`select id, name from app_user where id = any($1) and active and role <> 'PARENT'`, [userIds]);
  if (!ok.length) throw invalid('Choose staff to add.');
  return db.tx(async (t) => {
    for (const u of ok) {
      await t.query(`insert into chat_member (conversation_id, user_id) values ($1, $2)
                     on conflict (conversation_id, user_id) do update set left_at = null, joined_at = now(), role = 'MEMBER', can_post = true`, [conversationId, u.id]);
    }
    await rekey(t, conversationId);
    await system(t, conversationId, `${actor.name} added ${ok.map((u) => u.name).join(', ')}.`);
    return { added: ok.length };
  }, { actor: actor.label });
}

export async function removeMember(db: Db, actor: Actor, conversationId: string, userId: string) {
  const self = userId === actor.id;
  if (self) {
    const me = await membership(db, actor, conversationId);
    if (me.kind !== 'GROUP' || me.auto) throw forbidden(me.auto ? 'You are in this group because of your post; it follows the staff lists.' : 'You cannot leave a one-to-one chat.');
  } else await groupAdmin(db, actor, conversationId);
  const u = await db.maybeOne<{ name: string }>(`select u.name from chat_member m join app_user u on u.id = m.user_id where m.conversation_id = $1 and m.user_id = $2 and m.left_at is null`, [conversationId, userId]);
  if (!u) throw notFound('Member');
  return db.tx(async (t) => {
    await t.query('update chat_member set left_at = now() where conversation_id = $1 and user_id = $2', [conversationId, userId]);
    // A group never has nobody in charge.
    const admins = await t.one<{ n: number }>(`select count(*)::int as n from chat_member where conversation_id = $1 and left_at is null and role = 'ADMIN'`, [conversationId]);
    if (!admins.n) await t.query(`update chat_member set role = 'ADMIN' where conversation_id = $1 and user_id = (select user_id from chat_member where conversation_id = $1 and left_at is null order by joined_at limit 1)`, [conversationId]);
    await rekey(t, conversationId);
    await system(t, conversationId, self ? `${u.name} left.` : `${actor.name} removed ${u.name}.`);
    return { ok: true };
  }, { actor: actor.label });
}

export async function setRole(db: Db, actor: Actor, conversationId: string, userId: string, role: 'ADMIN' | 'MEMBER') {
  await groupAdmin(db, actor, conversationId);
  await db.tx((t) => t.query('update chat_member set role = $3 where conversation_id = $1 and user_id = $2 and left_at is null', [conversationId, userId, role]), { actor: actor.label });
  return { ok: true };
}

export async function rename(db: Db, actor: Actor, conversationId: string, title: string) {
  await groupAdmin(db, actor, conversationId);
  const t2 = title.trim();
  if (t2.length < 2 || t2.length > 80) throw invalid('Give the group a name of up to 80 letters.');
  await db.tx(async (t) => {
    await t.query('update chat_conversation set title = $2 where id = $1', [conversationId, t2]);
    await system(t, conversationId, `${actor.name} renamed the group "${t2}".`);
  }, { actor: actor.label });
  return { ok: true };
}
