import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';
import { AppError, forbidden, invalid } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { requireRole } from './auth.js';

/**
 * Emergency controls for NES (kill switches), for an attack or while the site is being updated.
 *
 * No switch deletes or changes data. Each only stops new work at the door, so whatever was in
 * progress finishes and nothing is half-saved: changes are refused (the user's typing stays on the
 * screen), payments are not started (the gateway's confirmations of payments already made are
 * always accepted, so no money is lost), messages wait in the queue and go out later, and sign-ins
 * or public pages are paused.
 *
 * "Stop all traffic" (lockdown) is a file next to the database. NES can switch it on from the app,
 * but it can be lifted only on the server itself (npm run unlock, or deleting the file), so a stolen
 * NES password cannot undo it.
 */

export const SWITCHES = {
  MAINTENANCE: { label: 'Maintenance', help: 'Everyone sees a maintenance page while the system is updated. NES can still sign in to check it.' },
  READ_ONLY: { label: 'Read only', help: 'Everyone can look, but nothing can be changed. Use while investigating a problem with data.' },
  PAYMENTS_OFF: { label: 'Pause payments', help: 'No new fee or application payments start. Payments already made are still confirmed by the bank.' },
  PUBLIC_OFF: { label: 'Pause public pages', help: 'School websites, NavShiksha Careers and the alumni portal show a maintenance page.' },
  SIGN_IN_OFF: { label: 'Pause sign-ins', help: 'Nobody new can sign in (staff, parents, candidates, alumni). People already signed in carry on.' },
  MESSAGES_OFF: { label: 'Hold outgoing messages', help: 'Emails and SMS wait in the queue and go out when this is turned off.' },
} as const;
export type SwitchKey = keyof typeof SWITCHES;

/** Where the lockdown file lives: beside the database folder (server/data/LOCKDOWN), or NES_LOCKDOWN_FILE. */
export const lockdownFile = () => process.env.NES_LOCKDOWN_FILE
  ?? (process.env.NES_DATA_DIR ? join(dirname(process.env.NES_DATA_DIR), 'LOCKDOWN') : fileURLToPath(new URL('../../data/LOCKDOWN', import.meta.url)));

let cache: { at: number; on: Partial<Record<SwitchKey, { reason: string; since: string }>>; lockdown: { reason: string; since: string } | null } | null = null;

function readLockdown() {
  if (process.env.NES_LOCKDOWN === '1') return { reason: 'Stopped by the server operator.', since: '' };
  const f = lockdownFile();
  if (!existsSync(f)) return null;
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return { reason: String(j.reason ?? ''), since: String(j.since ?? '') }; } catch { return { reason: '', since: '' }; }
}

/** The switches now (read at most every two seconds, so checking them costs nothing). */
export async function state(db: Db) {
  if (cache && Date.now() - cache.at < 2000) return cache;
  const rows = await db.query<{ key: SwitchKey; reason: string; set_at: string }>('select key, reason, set_at from system_switch where is_on');
  cache = { at: Date.now(), on: Object.fromEntries(rows.map((r) => [r.key, { reason: r.reason, since: r.set_at }])), lockdown: readLockdown() };
  return cache;
}
export const forget = () => { cache = null; };

/** What every screen needs to know (public): is the system in maintenance, read only, or stopped? */
export async function status(db: Db) {
  const s = await state(db);
  const mode = s.lockdown ? 'LOCKDOWN' : s.on.MAINTENANCE ? 'MAINTENANCE' : s.on.READ_ONLY ? 'READ_ONLY' : 'NORMAL';
  return { mode, message: s.lockdown?.reason || s.on.MAINTENANCE?.reason || s.on.READ_ONLY?.reason || '', paused: Object.keys(s.on).filter((k) => k !== 'MAINTENANCE' && k !== 'READ_ONLY') };
}

/** The role behind a token, for the maintenance check (which runs before sign-in is resolved). */
async function roleOf(db: Db, token: string | undefined) {
  if (!token) return null;
  return (await db.maybeOne<{ role: string }>('select u.role from app_session s join app_user u on u.id = s.user_id where s.token = $1 and s.expires_at > now()', [token]))?.role ?? null;
}

/**
 * The gate every request passes. Throws a coded error when a switch stops the request; otherwise
 * returns quietly. The bank's payment confirmations, the health check and the status are always let through.
 */
export async function gate(db: Db, method: string, path: string, token: string | undefined) {
  if (/^\/(health|system\/status|payments\/webhook)(\/|$)/.test(path)) return;
  const s = await state(db);
  if (s.lockdown) throw new AppError(503, 'locked_down', 'NavShiksha is stopped for safety. Nothing has been lost; it will be back shortly.');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const signingIn = /^\/(auth\/|public\/(careers|alumni)\/(otp|login|register))/.test(path);
  if (s.on.MAINTENANCE && !signingIn && !/^\/(me|system\/)/.test(path)) {
    if ((await roleOf(db, token)) !== 'NES_ADMIN') throw new AppError(503, 'maintenance', s.on.MAINTENANCE.reason || 'NavShiksha is being updated. Please try again in a little while.');
  }
  if (s.on.SIGN_IN_OFF && signingIn && !(path === '/auth/demo-users')) throw new AppError(503, 'sign_in_paused', 'Signing in is paused for a short while. Please try again later.');
  if (s.on.PUBLIC_OFF && path.startsWith('/public/')) throw new AppError(503, 'public_paused', 'This page is paused for a short while. Please try again later.');
  if (s.on.PAYMENTS_OFF && write && /^\/(payments\/orders|candidate\/applications\/[^/]+\/pay)$/.test(path)) throw new AppError(503, 'payments_paused', 'Payments are paused for a short while. Nothing has been charged; please try again later.');
  if (s.on.READ_ONLY && write && !signingIn && !/^\/system\//.test(path)) throw new AppError(423, 'read_only', 'Changes are paused for a short while, so this was not saved. What you typed is still on the screen; try again later.');
}

/** Whether outgoing messages and timed jobs should wait (maintenance, lockdown or held messages). */
export async function holdJobs(db: Db, kind: 'messages' | 'jobs') {
  const s = await state(db);
  return !!s.lockdown || !!s.on.MAINTENANCE || (kind === 'messages' && !!s.on.MESSAGES_OFF);
}

// ── NES controls ─────────────────────────────────────────────────────────────────────────

export async function list(db: Db, actor: Actor) {
  requireRole(actor, 'NES_ADMIN');
  const s = await state(db);
  const rows = await db.query<{ key: SwitchKey; is_on: boolean; reason: string; set_at: string; by: string | null }>(
    'select s.key, s.is_on, s.reason, s.set_at, u.name as by from system_switch s left join app_user u on u.id = s.set_by');
  const history = await db.query(
    `select e.key, e.is_on, e.reason, e.at, u.name as by from system_switch_event e left join app_user u on u.id = e.set_by order by e.at desc limit 50`);
  return {
    switches: (Object.keys(SWITCHES) as SwitchKey[]).map((k) => { const r = rows.find((x) => x.key === k); return { key: k, ...SWITCHES[k], on: !!r?.is_on, reason: r?.reason ?? '', since: r?.is_on ? r.set_at : null, by: r?.by ?? null }; }),
    lockdown: s.lockdown, lockdownFile: lockdownFile(), history,
  };
}

export async function set(db: Db, actor: Actor, key: SwitchKey, on: boolean, reason: string) {
  requireRole(actor, 'NES_ADMIN');
  if (!(key in SWITCHES)) throw invalid('Unknown switch.');
  if (on && reason.trim().length < 5) throw invalid('Say why, in a few words: it is shown to users and kept in the record.');
  await db.tx(async (t) => {
    await t.query(
      `insert into system_switch (key, is_on, reason, set_by, set_at) values ($1, $2, $3, $4, now())
       on conflict (key) do update set is_on = excluded.is_on, reason = excluded.reason, set_by = excluded.set_by, set_at = now()`, [key, on, reason.trim(), actor.id]);
    await t.query('insert into system_switch_event (key, is_on, reason, set_by) values ($1, $2, $3, $4)', [key, on, reason.trim() || (on ? '' : 'Turned off'), actor.id]);
  }, { actor: actor.label });
  forget();
  return list(db, actor);
}

/** Signs everyone out except the person doing it (for example after passwords may have leaked). */
export async function signEveryoneOut(db: Db, actor: Actor, reason: string) {
  requireRole(actor, 'NES_ADMIN');
  if (reason.trim().length < 5) throw invalid('Say why, in a few words.');
  const r = await db.tx(async (t) => {
    const gone = await t.query('delete from app_session where user_id <> $1 returning 1', [actor.id]);
    await t.query(`insert into system_switch_event (key, is_on, reason, set_by) values ('SIGN_OUT_ALL', true, $1, $2)`, [reason.trim(), actor.id]);
    return gone.length;
  }, { actor: actor.label });
  return { signedOut: r };
}

/** Stops all traffic. Lifted only on the server: npm run unlock (or delete the file). */
export async function lockdown(db: Db, actor: Actor, reason: string, confirm: string) {
  requireRole(actor, 'NES_ADMIN');
  if (confirm !== 'STOP') throw invalid('Type STOP to confirm.');
  if (reason.trim().length < 5) throw invalid('Say why, in a few words: it is shown to users and kept in the record.');
  await db.tx((t) => t.query(`insert into system_switch_event (key, is_on, reason, set_by) values ('LOCKDOWN', true, $1, $2)`, [reason.trim(), actor.id]), { actor: actor.label });
  writeFileSync(lockdownFile(), JSON.stringify({ reason: reason.trim(), since: new Date().toISOString(), by: actor.label }));
  forget();
  return { lockedDown: true, file: lockdownFile() };
}

/** For the unlock command on the server. */
export function unlock() {
  const f = lockdownFile();
  if (!existsSync(f)) return false;
  unlinkSync(f); forget();
  return true;
}

/** Records an unexpected error and returns the reference the user sees (for example E-LQ3K9-7F2A). */
export async function logError(db: Db, e: { method: string; path: string; status: number; message: string; stack?: string; userId?: string | null }) {
  const ref = `E-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  try {
    await db.query('insert into error_log (ref, method, path, status, message, stack, user_id) values ($1,$2,$3,$4,$5,$6,$7)',
      [ref, e.method, e.path.slice(0, 400), e.status, e.message.slice(0, 2000), e.stack?.slice(0, 8000) ?? null, e.userId ?? null]);
  } catch { /* the log must never cause a second failure */ }
  return ref;
}

/** A screen that crashed in someone's browser (the reference was made there); at most 30 a minute are kept. */
let clientBudget = { at: 0, n: 0 };
export async function logClientError(db: Db, e: { ref: string; message: string; stack?: string; path: string }) {
  if (Date.now() - clientBudget.at > 60_000) clientBudget = { at: Date.now(), n: 0 };
  if (++clientBudget.n > 30) return { kept: false };
  try {
    await db.query('insert into error_log (ref, method, path, status, message, stack) values ($1, $2, $3, 0, $4, $5) on conflict (ref) do nothing',
      [e.ref, 'BROWSER', e.path.slice(0, 400), e.message.slice(0, 1000), e.stack?.slice(0, 4000) ?? null]);
  } catch { /* best effort */ }
  return { kept: true };
}

export async function recentErrors(db: Db, actor: Actor) {
  if (!['NES_ADMIN', 'SUPPORT', 'DEVELOPER'].includes(actor.role)) throw forbidden();
  return db.query('select ref, at, method, path, status, message from error_log order by at desc limit 200');
}
