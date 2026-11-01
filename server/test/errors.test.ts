import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeWorld, type World } from './helpers.js';

/** Bad input never crashes the server: a mistyped ID is "not found", a wrong value is "invalid". */

let w: World;
let app: ReturnType<typeof buildApp>;
let token = '';
const get = (path: string) => app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  w = await makeWorld();
  app = buildApp(w.db);
  const r = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: w.admin.id }) });
  token = ((await r.json()) as { token: string }).token;
});

describe('bad input', () => {
  it('answers a malformed ID with not found, never a server error', async () => {
    for (const p of ['/stock-audits/not-an-id', '/visitors/not-an-id/photo', '/students/not-an-id/pickups', '/alumni/not-an-id/matches']) {
      const r = await get(p);
      expect(r.status, p).toBeLessThan(500);
    }
    expect((await get('/stock-audits/not-an-id')).status).toBe(404);
  });

  it('answers a value outside the allowed ones with invalid', async () => {
    const r = await get(`/schools/${w.schoolA}/print-assets/STUDENT/file`);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('invalid');
  });
});
