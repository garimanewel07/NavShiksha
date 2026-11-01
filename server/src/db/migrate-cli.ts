import { DEFAULT_DATA_DIR, openDb } from './client.js';
import { migrate } from './migrate.js';

const db = await openDb(process.env.NES_DATA_DIR ?? DEFAULT_DATA_DIR);
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
