import { openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
const db = await openDb(); await migrate(db); console.log('migrated');
