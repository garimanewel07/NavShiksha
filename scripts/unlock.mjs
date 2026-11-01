// Lifts "Stop all traffic" (lockdown). Run on the server itself: npm run unlock
// NES can stop all traffic from the app, but only someone with access to the server can lift it.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same place the server looks: NES_LOCKDOWN_FILE, else beside the database folder.
const file = process.env.NES_LOCKDOWN_FILE
  ?? (process.env.NES_DATA_DIR ? join(dirname(process.env.NES_DATA_DIR), 'LOCKDOWN') : fileURLToPath(new URL('../server/data/LOCKDOWN', import.meta.url)));
if (!existsSync(file)) { console.log('NavShiksha is not stopped (no lockdown file).'); process.exit(0); }
let why = '';
try { why = JSON.parse(readFileSync(file, 'utf8')).reason ?? ''; } catch { /* unreadable: lift anyway */ }
unlinkSync(file);
console.log(`Lockdown lifted${why ? ` (it was: ${why})` : ''}. NavShiksha takes traffic again within two seconds.`);
