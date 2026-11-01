import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { sign } from '../src/modules/payments.js';

const env = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = env; delete process.env.NES_DEMO_LOGIN; });

describe('production guards', () => {
  it('turns demo sign-in off in production', async () => {
    const db = await openDb();
    await migrate(db);
    process.env.NODE_ENV = 'production';
    const res = await buildApp(db).request('/api/v1/auth/demo-users');
    expect(res.status).toBe(404);
  });

  it('turns demo sign-in off when asked to', async () => {
    const db = await openDb();
    await migrate(db);
    process.env.NES_DEMO_LOGIN = 'off';
    expect((await buildApp(db).request('/api/v1/auth/demo-users')).status).toBe(404);
  });

  it('will not sign gateway calls with the sandbox secret in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => sign('{}')).toThrow(/NES_GATEWAY_SECRET/);
  });
});
