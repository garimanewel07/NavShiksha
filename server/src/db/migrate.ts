import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies SQL migrations in filename order, each in its own transaction.
 * An applied migration must never change: its checksum is stored and checked
 * on every start, so history cannot be rewritten by accident. Changes always
 * arrive as a new, additive migration (expand → migrate data → contract).
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migration (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>('select name, checksum from schema_migration')).map((r) => [r.name, r.checksum]),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(f);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${f} was edited after it was applied. Add a new migration instead.`);
      continue;
    }
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('insert into schema_migration(name, checksum) values ($1, $2)', [f, sum]);
    }, { actor: 'migration' });
    ran.push(f);
  }
  return ran;
}
