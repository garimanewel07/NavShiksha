// Starts the API (port 8787) and the web app (port 5173) together, on Windows, macOS and Linux.
// Ctrl+C stops both.
import { spawn } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Node.js 22.12 or newer is needed (this is ${process.versions.node}). Install the LTS version from https://nodejs.org and try again.`);
  process.exit(1);
}

const run = (name, workspace) => {
  const p = spawn('npm', ['run', 'dev', '-w', workspace], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  p.stdout.on('data', (c) => console.log(tag(c)));
  p.stderr.on('data', (c) => console.error(tag(c)));
  p.on('exit', (code) => { console.log(`[${name}] stopped${code ? ` (exit ${code})` : ''}`); process.exit(code ?? 0); });
  return p;
};

const api = run('api', 'server');
const web = run('web', 'web');
console.log('\nStarting… open http://localhost:5173 in your browser once both are ready.\n');
const stop = () => { api.kill(); web.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
