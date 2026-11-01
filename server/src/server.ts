import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { DEFAULT_DATA_DIR, openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { syncAutoGroups } from './modules/chat.js';
import { releaseDue } from './modules/cwt.js';
import { dispatch } from './modules/messages.js';
import * as governance from './modules/governance.js';
import * as insights from './modules/insights.js';
import * as system from './modules/system.js';

const db = await openDb(process.env.NES_DATA_DIR ?? DEFAULT_DATA_DIR);
const ran = await migrate(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);
// Staff groups (each school, principals, NES and Command channels) follow the staff lists.
await syncAutoGroups(db);

// Emails and SMS go out from the message queue every few seconds.
setInterval(async () => { if (await system.holdJobs(db, 'messages')) return; dispatch(db).catch((e) => console.error('Message dispatch:', e)); }, 3000);
// CWT papers go to the centres at their release time, and answer keys once the test has ended.
// Meeting reminders, overdue actions, voting results and the monthly MIS pack notice, every ten minutes.
setInterval(async () => { if (await system.holdJobs(db, 'jobs')) return; governance.tick(db).then(() => insights.monthly(db)).catch((e) => console.error('Governance:', e)); }, 600_000);
setInterval(async () => { if (await system.holdJobs(db, 'jobs')) return; releaseDue(db).then((r) => r.length && console.log('CWT released:', r.join(', '))).catch((e) => console.error('CWT release:', e)); }, 60_000);

const port = Number(process.env.PORT ?? 8787);
// When the web app has been built (npm run build), this one server also serves it, so a test
// server needs a single port: the API under /api/v1 and the pages everywhere else.
const web = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const root = new Hono();
root.route('/', buildApp(db));
// While all traffic is stopped, every page is a plain notice (the app itself is not served).
const STOPPED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NavShiksha · paused</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F5F5F7;color:#1D1D1F;padding:24px}
main{max-width:520px;background:#fff;border-radius:24px;padding:36px;text-align:center}h1{font-size:26px;margin:0 0 10px}p{color:#6E6E73;margin:8px 0}code{background:#F5F5F7;padding:2px 8px;border-radius:6px}</style></head>
<body><main><h1>NavShiksha is paused for safety</h1><p>The system has been stopped for a short while. Nothing has been lost: everything saved is safe, and payments already made are recorded.</p>
<p>Please try again later.</p><p><code>NS-503 · locked_down</code></p></main></body></html>`;
root.use('*', async (c, next) => {
  if (!c.req.path.startsWith('/api/') && (await system.state(db)).lockdown) return c.html(STOPPED, 503, { 'retry-after': '300' });
  await next();
});
if (existsSync(`${web}index.html`)) {
  // Built files have the content in their name, so browsers may keep them for good; the page itself
  // is always checked again, so after an update everyone gets the new version on their next visit.
  root.use('/assets/*', async (c, next) => { await next(); if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable'); });
  root.use('/*', serveStatic({ root: web }));
  root.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    // A file that is not there (an old script after an update) is a plain 404, never the page in its place.
    if (/\.[a-z0-9]{1,8}$/i.test(c.req.path)) return c.text('NS-404 · not found', 404, { 'cache-control': 'no-store' });
    return c.html(readFileSync(`${web}index.html`, 'utf8'), 200, { 'cache-control': 'no-cache' });
  });
}
const server = serve({ fetch: root.fetch, port }, () => console.log(`NavShiksha on http://localhost:${port} (API at /api/v1${existsSync(`${web}index.html`) ? ', web app included' : ''})`));
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${port} is already in use: NavShiksha (or another program) is already running. Stop it with Ctrl+C in its window, or start this one on another port, e.g. PORT=8788 npm start.`);
  process.exit(1);
});
// Stopping (Ctrl+C, or the host restarting the server) closes the database cleanly first. A hard
// stop in the middle of a write can leave the built-in database unable to open again.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping NavShiksha…');
  server.close();
  try { await db.close?.(); } catch (e) { console.error('Closing the database:', e); }
  process.exit(0);
});
