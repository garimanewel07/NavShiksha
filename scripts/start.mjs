// Runs NavShiksha as one server (API and web app on one port), for a test server.
// First run: builds the demo data. Needs `npm run build` beforehand so the web app is included.
// Environment: PORT (default 8787), NES_TEST_PASSCODE (testers' passcode for demo sign-in).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const data = process.env.NES_DATA_DIR ?? fileURLToPath(new URL('../server/data/pg', import.meta.url));
if (!existsSync(new URL('../web/dist/index.html', import.meta.url))) console.warn('The web app is not built; run `npm run build` first. Starting the API only.');
if (!existsSync(data)) {
  console.log('First start: building the demo data (about two minutes)…');
  const r = spawnSync(npm, ['run', 'seed', '-w', 'server'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!process.env.NES_TEST_PASSCODE) console.warn('NES_TEST_PASSCODE is not set: anyone who has the address can sign in as any demo user.');
const p = spawn(npm, ['start', '-w', 'server'], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => p.kill(s));
p.on('exit', (code) => process.exit(code ?? 0));
