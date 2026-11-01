import type { Db } from '../db/client.js';

export interface Line { account: string; debit?: number; credit?: number; studentId?: string | null }

/**
 * Posts one balanced journal for a business event. (source_type, source_id) is unique, so
 * posting the same event twice is impossible; the database also rejects any journal whose
 * debits and credits differ, at commit.
 */
export async function post(db: Db, j: { schoolId: string; narration: string; sourceType: string; sourceId: string; lines: Line[]; postedOn?: string }) {
  const lines = j.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (lines.length < 2) return null;
  const head = await db.one<{ id: string }>(
    `insert into journal (school_id, narration, source_type, source_id, posted_on) values ($1, $2, $3, $4, coalesce($5::date, current_date)) returning id`,
    [j.schoolId, j.narration, j.sourceType, j.sourceId, j.postedOn ?? null]);
  for (const l of lines) {
    await db.query(`insert into journal_line (journal_id, account_code, debit_paise, credit_paise, student_id) values ($1, $2, $3, $4, $5)`,
      [head.id, l.account, l.debit ?? 0, l.credit ?? 0, l.studentId ?? null]);
  }
  return head.id;
}

/** Signed amount helper: positive goes to the first side, negative flips sides. */
export function signed(account: string, amount: number, side: 'debit' | 'credit', studentId?: string): Line {
  const flip = amount < 0;
  const abs = Math.abs(amount);
  const s = flip ? (side === 'debit' ? 'credit' : 'debit') : side;
  return { account, [s]: abs, studentId } as Line;
}

export async function trialBalance(db: Db, schoolId: string) {
  return db.query(`select a.code, a.name, a.type, coalesce(sum(l.debit_paise), 0)::bigint as debit, coalesce(sum(l.credit_paise), 0)::bigint as credit
                     from ledger_account a
                     left join journal_line l on l.account_code = a.code
                     left join journal j on j.id = l.journal_id
                    where j.school_id = $1 or j.id is null
                    group by a.code, a.name, a.type order by a.code`, [schoolId]);
}
