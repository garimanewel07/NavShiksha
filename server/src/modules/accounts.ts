import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';
import { post, signed } from './ledger.js';

/**
 * A school's books, kept by the school. Nothing here is typed twice: every fee receipt, refund,
 * salary, statutory payment and award is already in the books when it happens. The bank statement
 * is imported as the bank sent it and matched to those entries; only what the statement alone
 * reveals (a gateway's settlement, bank charges, interest, cash paid in) is posted from it.
 * NES and the Commands see the schools' books added up, never pooled.
 */

const rs = (p: number) => `₹${(Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

function parseDate(v: string): string | null {
  const t = v.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{2,4})$/.exec(t);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
  return null;
}
const parseAmount = (v: string | undefined) => {
  const t = (v ?? '').replace(/[₹,\s]/g, '').replace(/(Cr|Dr)\.?$/i, '');
  if (!t || t === '-') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

/** Which schools a unit (a school, a Command or NES) covers. */
async function schoolsUnder(db: Db, unitId: string) {
  return (await db.query<{ id: string; name: string }>(
    `select s.id, s.name from org_unit u join org_unit s on s.kind = 'school' and s.path <@ u.path where u.id = $1 order by s.name`, [unitId])).map((x) => x);
}

// ── Bank statements ───────────────────────────────────────────────────────────────────────

/**
 * Imports a statement exported from the bank's net banking (CSV). Columns are recognised by their
 * headings: date, narration, reference or cheque/UTR number, withdrawal and deposit (or one amount
 * with Dr/Cr), balance. Lines already imported from an overlapping statement are skipped. Every
 * line that matches an entry already in the books is matched at once.
 */
export async function importStatement(db: Db, actor: Actor, schoolId: string, input: { bankLabel: string; csv: string }) {
  await assertCan(db, actor, 'accounts.reconcile', schoolId);
  const { parseCsv } = await import('./dataio.js');
  const rows = parseCsv(input.csv).filter((r) => r.some((x) => x.trim()));
  const hi = rows.findIndex((r) => r.some((x) => /date/i.test(x)) && r.some((x) => /narration|description|particulars|remarks|details/i.test(x)));
  if (hi < 0) throw invalid('The file needs a heading row with Date and Narration (or Description) columns, as the bank exports it.');
  const h = rows[hi].map((x) => x.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim());
  const col = (re: RegExp, not?: RegExp) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const iDate = col(/^(txn |transaction |tran |value )?date$|^date/, /value/) >= 0 ? col(/^(txn |transaction |tran )?date$|^date/, /value/) : col(/date/);
  const iNar = col(/narration|description|particulars|remarks|details/);
  const iRef = col(/ref|cheque|chq|utr|instrument/);
  const iDr = col(/withdraw|debit|^dr$/), iCr = col(/deposit|credit|^cr$/);
  const iAmt = iDr < 0 && iCr < 0 ? col(/amount/) : -1, iType = iAmt >= 0 ? col(/dr cr|type|cr dr/) : -1;
  const iBal = col(/balance/);
  if (iDate < 0 || iNar < 0 || (iDr < 0 && iCr < 0 && iAmt < 0)) throw invalid('Could not find the date, narration and amount columns.');
  const errors: { line: number; message: string }[] = [];
  const lines: { on: string; narration: string; ref: string; amount: number; balance: number | null }[] = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const line = hi + i + 2;
    const on = parseDate(r[iDate] ?? '');
    if (!on) { if ((r[iDate] ?? '').trim() && !/total|opening|closing/i.test(r.join(' '))) errors.push({ line, message: `Date "${r[iDate]}" not understood` }); return; }
    let amount = 0;
    if (iAmt >= 0) { const a = parseAmount(r[iAmt]); const dr = /dr|debit|d$/i.test((iType >= 0 ? r[iType] : r[iAmt]) ?? ''); amount = dr ? -a : a; }
    else amount = parseAmount(iCr >= 0 ? r[iCr] : '') - parseAmount(iDr >= 0 ? r[iDr] : '');
    if (Number.isNaN(amount)) { errors.push({ line, message: 'An amount was not understood' }); return; }
    if (!amount) return;
    const bal = iBal >= 0 ? parseAmount(r[iBal]) : NaN;
    lines.push({ on, narration: (r[iNar] ?? '').trim().slice(0, 300), ref: iRef >= 0 ? (r[iRef] ?? '').trim().slice(0, 60) : '', amount, balance: Number.isNaN(bal) || iBal < 0 ? null : bal });
  });
  if (errors.length) throw invalid(`${errors.length} line${errors.length === 1 ? '' : 's'} could not be read, so nothing was imported.`, errors.slice(0, 30));
  if (!lines.length) throw invalid('The file has no transactions.');
  const sha = createHash('sha256').update(input.csv).digest('hex');
  if (await db.maybeOne('select 1 from bank_statement where school_id = $1 and file_sha = $2', [schoolId, sha])) throw conflict('imported', 'This statement was already imported.');
  const from = lines.map((l) => l.on).sort()[0], to = lines.map((l) => l.on).sort().at(-1)!;
  return db.tx(async (t) => {
    const s = await t.one<{ id: string }>(`insert into bank_statement (school_id, bank_label, period, file_sha, lines, imported_by) values ($1, $2, daterange($3::date, $4::date, '[]'), $5, $6, $7) returning id`,
      [schoolId, input.bankLabel.trim(), from, to, sha, lines.length, actor.id]);
    let added = 0;
    // Banks list newest first or oldest first; keep the order of the days as they happened.
    const ordered = lines.length > 1 && lines[0].on > lines[lines.length - 1].on ? [...lines].reverse() : lines;
    for (const [i, l] of ordered.entries()) {
      const r = await t.query(`insert into bank_line (statement_id, school_id, on_date, narration, reference, amount_paise, balance_paise, seq) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning 1`,
        [s.id, schoolId, l.on, l.narration, l.ref, l.amount, l.balance, i]);
      added += r.length;
    }
    const matched = await autoMatch(t, schoolId, actor.id);
    return { statementId: s.id, lines: lines.length, added, skipped: lines.length - added, matched, from, to };
  }, { actor: actor.label });
}

/** Book entries touching the bank that no statement line has matched yet. */
const OPEN_BOOK = `
  select j.id, j.posted_on::text as on_date, j.narration, j.source_type, sum(l.debit_paise - l.credit_paise)::bigint::float as amount
    from journal j join journal_line l on l.journal_id = j.id and l.account_code = '1100'
   where j.school_id = $1 and not exists (select 1 from bank_line b where b.journal_id = j.id)
   group by j.id having sum(l.debit_paise - l.credit_paise) <> 0`;

/**
 * Matches statement lines to book entries of the same amount within a week. A reference on the
 * statement (UTR, cheque number) that appears in the entry decides between several; otherwise only
 * a single candidate is matched, so nothing is matched by guesswork.
 */
async function autoMatch(t: Db, schoolId: string, actorId: string) {
  const open = await t.query<{ id: string; on_date: string; amount: number; narration: string }>(`${OPEN_BOOK}`, [schoolId]);
  const lines = await t.query<{ id: string; on_date: string; amount: number; narration: string; reference: string }>(
    `select id, on_date::text, amount_paise::float as amount, narration, reference from bank_line where school_id = $1 and status = 'UNMATCHED' order by on_date`, [schoolId]);
  const used = new Set<string>();
  let n = 0;
  for (const l of lines) {
    const c = open.filter((j) => !used.has(j.id) && Math.round(j.amount) === Math.round(l.amount) && j.on_date >= addDays(l.on_date, -7) && j.on_date <= addDays(l.on_date, 3));
    const refs = [l.reference, ...(l.narration.match(/[A-Z0-9]{8,}/gi) ?? [])].filter((x) => x && x.length >= 6).map((x) => x.toUpperCase());
    const byRef = c.filter((j) => refs.some((r) => j.narration.toUpperCase().includes(r)));
    const pick = byRef.length === 1 ? byRef[0] : c.length === 1 ? c[0] : null;
    if (!pick) continue;
    used.add(pick.id);
    await t.query(`update bank_line set status = 'MATCHED', journal_id = $2, how = 'AUTO', decided_by = $3, decided_at = now() where id = $1`, [l.id, pick.id, actorId]);
    n++;
  }
  return n;
}

/** Matches unmatched statement lines to the books again (a support repair). */
export async function rematch(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'accounts.reconcile', schoolId);
  return db.tx((t) => autoMatch(t, schoolId, actor.id), { actor: actor.label });
}

const GATEWAY = /razorpay|payu|ccavenue|billdesk|paytm|cashfree|settl|pg /i;

/** The statement lines still to explain, with the book entries each could be. */
export async function bankLines(db: Db, actor: Actor, schoolId: string, status = 'UNMATCHED') {
  await assertCan(db, actor, 'accounts.view', schoolId);
  const lines = await db.query<{ id: string; on_date: string; amount: number }>(
    `select b.id, b.on_date::text, b.narration, b.reference, b.amount_paise::float as amount, b.balance_paise::float as balance, b.status, b.how, b.note, j.narration as matched_to, u.name as decided_by
       from bank_line b left join journal j on j.id = b.journal_id left join app_user u on u.id = b.decided_by
      where b.school_id = $1 and ($2 = 'ALL' or b.status = $2) order by b.on_date desc, b.amount_paise limit 500`, [schoolId, status]);
  const open = await db.query<{ id: string; on_date: string; amount: number; narration: string; source_type: string }>(OPEN_BOOK, [schoolId]);
  const clearing = (await db.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = '1150'`, [schoolId])).b;
  const cash = (await db.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = '1160'`, [schoolId])).b;
  return {
    lines: lines.map((l) => ({ ...l,
      candidates: status === 'UNMATCHED' ? open.filter((j) => Math.round(j.amount) === Math.round(l.amount) && j.on_date >= addDays(l.on_date, -30) && j.on_date <= addDays(l.on_date, 7)).slice(0, 5) : [],
      looksLike: l.amount > 0 && GATEWAY.test((l as { narration?: string }).narration ?? '') ? 'GATEWAY' : l.amount < 0 && /charge|chgs|fee|gst|sms/i.test((l as { narration?: string }).narration ?? '') && Math.abs(l.amount) < 1_000_000 ? 'CHARGES'
        : l.amount > 0 && /int\.?\s*(pd|paid|credit)|interest/i.test((l as { narration?: string }).narration ?? '') ? 'INTEREST' : l.amount > 0 && /cash dep|by cash|csh dep/i.test((l as { narration?: string }).narration ?? '') ? 'CASH_DEPOSIT' : null })),
    awaitingSettlement: clearing, cashInHand: cash,
    unpresented: open.filter((j) => j.amount < 0).slice(0, 100), notInBank: open.filter((j) => j.amount > 0).slice(0, 100),
  };
}

async function loadLine(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Statement line');
  const l = await db.maybeOne<{ id: string; school_id: string; status: string; amount: number; on_date: string; narration: string; reference: string }>(
    'select id, school_id, status, amount_paise::float as amount, on_date::text, narration, reference from bank_line where id = $1', [id]);
  if (!l) throw notFound('Statement line');
  return l;
}

/** Matches a line by hand to a book entry of the same amount. */
export async function matchLine(db: Db, actor: Actor, lineId: string, journalId: string) {
  const l = await loadLine(db, lineId);
  await assertCan(db, actor, 'accounts.reconcile', l.school_id);
  if (l.status !== 'UNMATCHED') throw conflict('done', 'This line is already explained.');
  const j = await db.maybeOne<{ amount: number }>(`select sum(l.debit_paise - l.credit_paise)::float as amount from journal j join journal_line l on l.journal_id = j.id and l.account_code = '1100' where j.id = $1 and j.school_id = $2 group by j.id`, [journalId, l.school_id]);
  if (!j) throw invalid('That entry does not touch this school’s bank account.');
  if (Math.round(j.amount) !== Math.round(l.amount)) throw invalid(`The entry is for ${rs(j.amount)}; the bank shows ${rs(l.amount)}.`);
  await db.tx((t) => t.query(`update bank_line set status = 'MATCHED', journal_id = $2, how = 'MANUAL', decided_by = $3, decided_at = now() where id = $1`, [lineId, journalId, actor.id]), { actor: actor.label });
  return { status: 'MATCHED' };
}

/**
 * Posts what only the statement shows: a payment gateway's settlement of fees already received
 * (less its charges), bank charges, interest, or cash from the counter paid into the bank.
 */
export async function postLine(db: Db, actor: Actor, lineId: string, input: { kind: 'GATEWAY' | 'CHARGES' | 'INTEREST' | 'CASH_DEPOSIT'; chargesPaise?: number }) {
  const l = await loadLine(db, lineId);
  await assertCan(db, actor, 'accounts.reconcile', l.school_id);
  if (l.status !== 'UNMATCHED') throw conflict('done', 'This line is already explained.');
  const amt = Math.abs(l.amount), into = l.amount > 0;
  if (input.kind === 'CHARGES' ? into : !into) throw invalid(input.kind === 'CHARGES' ? 'Charges are money going out of the bank.' : 'This is money going out of the bank.');
  const charges = input.kind === 'GATEWAY' ? Math.max(0, Math.round(input.chargesPaise ?? 0)) : 0;
  return db.tx(async (t) => {
    const bal = async (code: string) => (await t.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = $2`, [l.school_id, code])).b;
    if (input.kind === 'GATEWAY' && amt + charges > (await bal('1150')) + 1) throw invalid(`Only ${rs(await bal('1150'))} of online fees is waiting to be settled.`);
    if (input.kind === 'CASH_DEPOSIT' && amt > (await bal('1160')) + 1) throw invalid(`The fee counter holds only ${rs(await bal('1160'))} in cash.`);
    const lines = input.kind === 'GATEWAY' ? [signed('1100', amt, 'debit'), signed('5900', charges, 'debit'), signed('1150', amt + charges, 'credit')]
      : input.kind === 'CHARGES' ? [signed('5900', amt, 'debit'), signed('1100', amt, 'credit')]
      : input.kind === 'INTEREST' ? [signed('1100', amt, 'debit'), signed('4900', amt, 'credit')]
      : [signed('1100', amt, 'debit'), signed('1160', amt, 'credit')];
    const label = { GATEWAY: 'Online fees settled by the payment gateway', CHARGES: 'Bank charges', INTEREST: 'Interest credited by the bank', CASH_DEPOSIT: 'Cash from the fee counter paid into the bank' }[input.kind];
    const jid = await post(t, { schoolId: l.school_id, narration: `${label}${l.reference ? ` · ${l.reference}` : ''}`, sourceType: 'bank_line', sourceId: l.id, lines, postedOn: l.on_date });
    await t.query(`update bank_line set status = 'POSTED', journal_id = $2, how = $3, decided_by = $4, decided_at = now() where id = $1`, [lineId, jid, input.kind, actor.id]);
    return { status: 'POSTED' };
  }, { actor: actor.label });
}

/** A line that is not the school's business (a transfer between its own accounts, a reversed entry), set aside with a reason. */
export async function ignoreLine(db: Db, actor: Actor, lineId: string, note: string) {
  const l = await loadLine(db, lineId);
  await assertCan(db, actor, 'accounts.reconcile', l.school_id);
  if (l.status !== 'UNMATCHED') throw conflict('done', 'This line is already explained.');
  if (note.trim().length < 4) throw invalid('Say why this line is set aside; it is kept with the line.');
  await db.tx((t) => t.query(`update bank_line set status = 'IGNORED', note = $2, how = 'IGNORED', decided_by = $3, decided_at = now() where id = $1`, [lineId, note.trim(), actor.id]), { actor: actor.label });
  return { status: 'IGNORED' };
}

/**
 * The bank reconciliation statement as on a date: the books' bank balance, the bank's own balance,
 * and the items that explain the difference (receipts not yet in the bank, payments not yet
 * presented, statement lines not yet explained).
 */
export async function reconciliation(db: Db, actor: Actor, schoolId: string, asOn = localToday()) {
  await assertCan(db, actor, 'accounts.view', schoolId);
  const book = (await db.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::float as b from journal_line l join journal j on j.id = l.journal_id
     where j.school_id = $1 and l.account_code = '1100' and j.posted_on <= $2`, [schoolId, asOn])).b;
  const bank = await db.maybeOne<{ balance: number | null; on_date: string }>(
    `select balance_paise::float as balance, on_date::text from bank_line where school_id = $1 and on_date <= $2 order by on_date desc, (select imported_at from bank_statement s where s.id = statement_id) desc, seq desc limit 1`, [schoolId, asOn]);
  // Outstanding on that date: entries in the books by then that the bank had not shown by then.
  const items = await db.query<{ amount: number; on_date: string; narration: string }>(
    `select j.posted_on::text as on_date, j.narration, sum(l.debit_paise - l.credit_paise)::float as amount
       from journal j join journal_line l on l.journal_id = j.id and l.account_code = '1100'
      where j.school_id = $1 and j.posted_on <= $2 and not exists (select 1 from bank_line b where b.journal_id = j.id and b.on_date <= $2)
      group by j.id having sum(l.debit_paise - l.credit_paise) <> 0 order by j.posted_on`, [schoolId, asOn]);
  const unexplained = await db.query<{ amount: number; on_date: string; narration: string }>(
    `select on_date::text, narration, amount_paise::float as amount from bank_line where school_id = $1 and on_date <= $2 and status = 'UNMATCHED' order by on_date`, [schoolId, asOn]);
  const notInBank = items.filter((i) => i.amount > 0), unpresented = items.filter((i) => i.amount < 0);
  const sum = (a: { amount: number }[]) => a.reduce((s, x) => s + x.amount, 0);
  const expected = book - sum(notInBank) - sum(unpresented) + sum(unexplained);
  return {
    asOn, bookBalance: book, bankBalance: bank?.balance ?? null, bankBalanceOn: bank?.on_date ?? null,
    notInBank, unpresented, unexplained, expectedBankBalance: expected,
    difference: bank?.balance === null || bank?.balance === undefined ? null : Math.round(bank.balance - expected),
  };
}

// ── Reports (a school, or a Command or all of NES added up) ────────────────────────────────

async function scope(db: Db, actor: Actor, unitId: string) {
  await assertCan(db, actor, 'accounts.view', unitId);
  const schools = await schoolsUnder(db, unitId);
  if (!schools.length) throw notFound('Schools');
  return schools;
}

/** Income and expenditure for a period: by account, and by school when more than one is added up. */
export async function incomeExpenditure(db: Db, actor: Actor, unitId: string, from: string, to: string) {
  const schools = await scope(db, actor, unitId);
  const rows = await db.query<{ code: string; name: string; type: string; school_id: string; amount: number }>(
    `select a.code, a.name, a.type, j.school_id, sum(case when a.type = 'INCOME' then l.credit_paise - l.debit_paise else l.debit_paise - l.credit_paise end)::float as amount
       from journal_line l join journal j on j.id = l.journal_id join ledger_account a on a.code = l.account_code
      where j.school_id = any($1) and a.type in ('INCOME', 'EXPENSE') and j.posted_on between $2 and $3 group by a.code, a.name, a.type, j.school_id order by a.code`, [schools.map((s) => s.id), from, to]);
  const accounts = [...new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, type: r.type }])).values()].map((a) => ({
    ...a, total: rows.filter((r) => r.code === a.code).reduce((s, r) => s + r.amount, 0),
    bySchool: Object.fromEntries(rows.filter((r) => r.code === a.code).map((r) => [r.school_id, r.amount])),
  }));
  const income = accounts.filter((a) => a.type === 'INCOME').reduce((s, a) => s + a.total, 0), expenditure = accounts.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s + a.total, 0);
  return { from, to, schools, income: accounts.filter((a) => a.type === 'INCOME'), expenditure: accounts.filter((a) => a.type === 'EXPENSE'), totalIncome: income, totalExpenditure: expenditure, surplus: income - expenditure };
}

/** Balances as on a date: what the school has, what it owes (fees in advance, salaries, PF, TDS), and the surplus so far. */
export async function balanceSheet(db: Db, actor: Actor, unitId: string, asOn = localToday()) {
  const schools = await scope(db, actor, unitId);
  const rows = await db.query<{ code: string; name: string; type: string; amount: number }>(
    `select a.code, a.name, a.type, sum(case when a.type = 'ASSET' or a.type = 'EXPENSE' then l.debit_paise - l.credit_paise else l.credit_paise - l.debit_paise end)::float as amount
       from journal_line l join journal j on j.id = l.journal_id join ledger_account a on a.code = l.account_code
      where j.school_id = any($1) and j.posted_on <= $2 group by a.code, a.name, a.type having sum(l.debit_paise - l.credit_paise) <> 0 order by a.code`, [schools.map((s) => s.id), asOn]);
  const of = (t: string) => rows.filter((r) => r.type === t);
  const surplus = of('INCOME').reduce((s, r) => s + r.amount, 0) - of('EXPENSE').reduce((s, r) => s + r.amount, 0);
  const assets = of('ASSET'), liabilities = [...of('LIABILITY'), ...of('EQUITY')];
  const ta = assets.reduce((s, r) => s + r.amount, 0), tl = liabilities.reduce((s, r) => s + r.amount, 0);
  return { asOn, schools, assets, liabilities, surplus, totalAssets: ta, totalLiabilities: tl + surplus, balanced: Math.round(ta) === Math.round(tl + surplus) };
}

/** One account's entries for a period with the running balance (the cash book is account 1160, the bank book 1100). */
export async function accountBook(db: Db, actor: Actor, schoolId: string, code: string, from: string, to: string) {
  await assertCan(db, actor, 'accounts.view', schoolId);
  const a = await db.maybeOne<{ name: string; type: string }>('select name, type from ledger_account where code = $1', [code]);
  if (!a) throw notFound('Account');
  const sign = ['ASSET', 'EXPENSE'].includes(a.type) ? 1 : -1;
  const opening = (await db.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::float as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = $2 and j.posted_on < $3`, [schoolId, code, from])).b * sign;
  const lines = await db.query<{ on_date: string; narration: string; debit: number; credit: number; source_type: string }>(
    `select j.posted_on::text as on_date, j.narration, j.source_type, l.debit_paise::float as debit, l.credit_paise::float as credit
       from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = $2 and j.posted_on between $3 and $4 order by j.posted_on, j.created_at, l.id`, [schoolId, code, from, to]);
  let bal = opening;
  return { code, name: a.name, from, to, opening, lines: lines.map((l) => ({ ...l, balance: (bal += (l.debit - l.credit) * sign) })), closing: bal };
}

/** Any report as a spreadsheet for the auditors. */
export function toCsv(head: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => { const s = v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
