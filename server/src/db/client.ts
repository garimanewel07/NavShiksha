import { mkdirSync } from 'node:fs';
import { SCHOOL_TIME_ZONE } from '../lib/dates.js';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { ltree } from '@electric-sql/pglite/contrib/ltree';

/**
 * The only database surface the application uses. Every module talks to this
 * interface, so swapping the embedded PGlite (dev/test) for a pooled PostgreSQL
 * client (production) touches this file alone.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  /** Runs fn in one transaction. Nested calls join the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>, opts?: { actor?: string }): Promise<T>;
  /** Closes the database cleanly (the server does this when it is stopped). */
  close?(): Promise<void>;
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<unknown>;
};

function wrap(q: Queryable, inTx: boolean, root: PGlite): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query(sql, params);
      return r.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const rows = await db.query<T>(sql, params);
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
    async maybeOne<T>(sql: string, params: unknown[] = []) {
      const rows = await db.query<T>(sql, params);
      if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
      return rows[0] ?? null;
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>, opts?: { actor?: string }) {
      if (inTx) {
        if (opts?.actor) await db.query(`select set_config('app.actor', $1, true)`, [opts.actor]);
        return fn(db);
      }
      return root.transaction(async (t) => {
        const inner = wrap(t as unknown as Queryable, true, root);
        await inner.query(`select set_config('app.actor', $1, true)`, [opts?.actor ?? 'system']);
        return fn(inner);
      }) as Promise<T>;
    },
  };
  return db;
}

export async function openDb(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = await PGlite.create({ dataDir, extensions: { btree_gist, ltree } });
  // The schools' day: current_date and now() in India time, matching localToday() in the code.
  await pg.exec(`set time zone '${SCHOOL_TIME_ZONE}'`);
  const db = wrap(pg as unknown as Queryable, false, pg);
  db.close = () => pg.close();
  return db;
}

/** server/data/pg, wherever the process is started from. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/pg', import.meta.url));
