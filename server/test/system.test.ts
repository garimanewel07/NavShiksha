import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as system from '../src/modules/system.js';
import { family, makeWorld, type World } from './helpers.js';

/**
 * The emergency controls: maintenance, read only, paused payments and sign-ins, held messages,
 * signing everyone out, and stopping all traffic (lifted only on the server). No switch loses data.
 */

let w: World;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
const call = (who: string | null, method: string, path: string, body?: unknown) => app.request(`/api/v1${path}`, {
  method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (id: string) => ((await (await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: id }) })).json()) as { token: string }).token;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; number: string; ref?: string } }).error;

beforeAll(async () => {
  process.env.NES_LOCKDOWN_FILE = join(mkdtempSync(join(tmpdir(), 'ns-')), 'LOCKDOWN');
  w = await makeWorld();
  app = buildApp(w.db);
  const k = await family(w, { classCode: 'X' });
  tokens.nes = await login(w.admin.id); tokens.principal = await login(w.principalA.id); tokens.parent = await login(k.parent.id);
});

describe('kill switches', () => {
  it('only NES may use them, and each needs a reason', async () => {
    expect((await call('principal', 'POST', '/system/switches/READ_ONLY', { on: true, reason: 'testing' })).status).toBe(403);
    expect((await call('nes', 'POST', '/system/switches/READ_ONLY', { on: true, reason: '' })).status).toBe(422);
  });

  it('read only: everyone can look, nothing can be changed, and the error says so', async () => {
    await call('nes', 'POST', '/system/switches/READ_ONLY', { on: true, reason: 'Checking a data problem' }); system.forget();
    expect((await call('principal', 'GET', '/org/tree')).status).toBe(200);
    const r = await call('principal', 'PUT', `/schools/${w.schoolA}/details`, { phone: '022 1234' });
    expect(r.status).toBe(423);
    expect(await err(r)).toMatchObject({ code: 'read_only', number: 'NS-423' });
    expect((await call(null, 'POST', '/payments/webhook', {})).status).not.toBe(423);       // the bank's confirmations always get through
    expect(await (await call(null, 'GET', '/system/status')).json()).toMatchObject({ mode: 'READ_ONLY' });
    await call('nes', 'POST', '/system/switches/READ_ONLY', { on: false, reason: '' }); system.forget();
    expect((await call('principal', 'PUT', `/schools/${w.schoolA}/details`, { phone: '022 1234' })).status).toBe(200);
  });

  it('maintenance: everyone sees the maintenance notice except NES, who can check the system', async () => {
    await call('nes', 'POST', '/system/switches/MAINTENANCE', { on: true, reason: 'Updating to the new version' }); system.forget();
    const r = await call('parent', 'GET', '/org/tree');
    expect(r.status).toBe(503);
    expect(await err(r)).toMatchObject({ code: 'maintenance', number: 'NS-503' });
    expect((await call('nes', 'GET', '/org/tree')).status).toBe(200);
    await call('nes', 'POST', '/system/switches/MAINTENANCE', { on: false, reason: '' }); system.forget();
  });

  it('pauses payments and sign-ins without touching anything else', async () => {
    await call('nes', 'POST', '/system/switches/PAYMENTS_OFF', { on: true, reason: 'Gateway incident' });
    await call('nes', 'POST', '/system/switches/SIGN_IN_OFF', { on: true, reason: 'Suspicious sign-ins' }); system.forget();
    expect(await err(await call('parent', 'POST', '/payments/orders', { studentId: w.schoolA, items: [], method: 'UPI', idempotencyKey: 'x' }))).toMatchObject({ code: 'payments_paused' });
    expect(await err(await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: w.admin.id }) }))).toMatchObject({ code: 'sign_in_paused' });
    expect((await call('parent', 'GET', '/notifications')).status).toBe(200);               // people already signed in carry on
    for (const k of ['PAYMENTS_OFF', 'SIGN_IN_OFF']) await call('nes', 'POST', `/system/switches/${k}`, { on: false, reason: '' });
    system.forget();
    expect(((await (await call('nes', 'GET', '/system/switches')).json()) as { history: unknown[] }).history.length).toBeGreaterThanOrEqual(8);   // every change recorded
  });

  it('signs everyone out except NES', async () => {
    const r = await (await call('nes', 'POST', '/system/sign-out-all', { reason: 'Passwords may have leaked' })).json() as { signedOut: number };
    expect(r.signedOut).toBeGreaterThanOrEqual(2);
    expect(await err(await call('parent', 'GET', '/notifications'))).toMatchObject({ code: 'signed_out', number: 'NS-401' });
    expect((await call('nes', 'GET', '/org/tree')).status).toBe(200);
  });

  it('stops all traffic, which only the server can lift', async () => {
    expect((await call('nes', 'POST', '/system/lockdown', { reason: 'Attack in progress', confirm: 'no' })).status).toBe(422);
    await call('nes', 'POST', '/system/lockdown', { reason: 'Attack in progress', confirm: 'STOP' }); system.forget();
    expect(await err(await call('nes', 'GET', '/org/tree'))).toMatchObject({ code: 'locked_down', number: 'NS-503' });
    expect((await call('nes', 'POST', '/system/switches/MAINTENANCE', { on: false, reason: '' })).status).toBe(503);   // not from the app
    expect((await call(null, 'GET', '/health')).status).toBe(200);
    expect(system.unlock()).toBe(true);                                                       // npm run unlock on the server
    expect((await call('nes', 'GET', '/org/tree')).status).toBe(200);
  });
});

describe('error pages', () => {
  it('numbers every error, and gives an unexpected one a reference kept in the log', async () => {
    expect(await err(await call('nes', 'GET', '/no/such/address'))).toMatchObject({ code: 'not_found', number: 'NS-404' });
    const ref = await system.logError(w.db, { method: 'GET', path: '/x', status: 500, message: 'boom' });
    expect(ref).toMatch(/^E-[A-Z0-9]+-[A-Z0-9]{4}$/);
    const log = await (await call('nes', 'GET', '/system/errors')).json() as { ref: string }[];
    expect(log.some((e) => e.ref === ref)).toBe(true);
  });

  it('keeps a browser crash, before sign-in too, under the reference the person was shown', async () => {
    expect((await call(null, 'POST', '/system/client-errors', { ref: 'C-MH2K9Q1-X3B1', message: 'x is undefined', path: '/fees' })).status).toBe(200);
    expect((await call(null, 'POST', '/system/client-errors', { ref: 'not a ref', message: 'x', path: '/' })).status).toBe(422);
    const log = await (await call('nes', 'GET', '/system/errors')).json() as { ref: string; method: string }[];
    expect(log.find((e) => e.ref === 'C-MH2K9Q1-X3B1')?.method).toBe('BROWSER');
  });
});

describe('screens show only what the person may do', () => {
  it('tells each person their permissions, the same table the server checks', async () => {
    tokens.principal = await login(w.principalA.id); tokens.parent = await login((await w.db.one<{ id: string }>(`select id from app_user where role = 'PARENT' limit 1`)).id);   // signed out above
    const me = async (who: string) => ((await (await call(who, 'GET', '/me')).json()) as { can: { roles: string[]; duties: Record<string, string[]> } }).can;
    const principal = await me('principal'), nes = await me('nes'), parent = await me('parent');
    expect(principal.roles).toEqual(expect.arrayContaining(['pay.approve', 'stores.manage', 'admissions.manage']));
    expect(nes.roles).toContain('stores.view');
    expect(nes.roles).not.toContain('stores.manage');                 // NES looks at a school's store; the school runs it
    expect(parent.roles).toEqual([]);
  });
});

