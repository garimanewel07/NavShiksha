import type { Db } from '../db/client.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { newDocument, Sheet } from '../lib/pdf.js';
import { post } from './ledger.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, assertStudentAccess } from './access.js';
import * as settings from './settings.js';
import * as notify from './notify.js';
import * as printing from './printing.js';
import { localToday } from '../lib/dates.js';

/**
 * The library. Every physical copy gets the next number in the school's accession register and
 * a barcode made from it. Issue and return work with a barcode scanner (it types like a
 * keyboard): scan the borrower's ID card, then the books; scan a book alone to return it.
 * Late returns are fined per day as the school sets; fines and lost books are billed to the
 * parent with the school fees.
 */

const today = () => localToday();
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const manage = (db: Db, actor: Actor, schoolId: string) => assertCan(db, actor, 'library.manage', schoolId);

async function schoolCode(db: Db, schoolId: string) {
  // NCS-MB → MB: the part that tells schools apart, kept short so labels stay scannable.
  const s = await db.one<{ code: string }>('select code from org_unit where id = $1', [schoolId]);
  return s.code.split('-').pop()!;
}

// ── Catalogue ────────────────────────────────────────────────────────────────────────────

export interface BookInput { title: string; author?: string; publisher?: string; edition?: string; year?: number | null; isbn?: string | null; subject?: string; language?: string; callNumber?: string; pricePaise?: number }

export async function addBook(db: Db, actor: Actor, schoolId: string, input: BookInput & { copies: number; location?: string; source?: 'PURCHASE' | 'DONATION' | 'OTHER'; acquiredOn?: string }) {
  await manage(db, actor, schoolId);
  if (input.copies < 1 || input.copies > 200) throw invalid('Add between 1 and 200 copies at a time.');
  const isbn = input.isbn ? input.isbn.replace(/[-\s]/g, '').toUpperCase() : null;
  return db.tx(async (t) => {
    const b = await t.one<{ id: string }>(
      `insert into library_book (school_id, title, author, publisher, edition, year, isbn, subject, language, call_number, price_paise)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [schoolId, input.title.trim(), (input.author ?? '').trim(), (input.publisher ?? '').trim(), (input.edition ?? '').trim(), input.year ?? null, isbn,
       (input.subject ?? '').trim(), (input.language ?? 'English').trim(), (input.callNumber ?? '').trim(), input.pricePaise ?? 0]);
    const copies = await addCopiesIn(t, schoolId, b.id, input.copies, input);
    return { bookId: b.id, copies };
  }, { actor: actor.label });
}

async function addCopiesIn(t: Db, schoolId: string, bookId: string, n: number, o: { location?: string; source?: string; acquiredOn?: string }) {
  const code = await schoolCode(t, schoolId);
  const r = await t.one<{ last_no: number }>(
    `insert into library_counter (school_id, last_no) values ($1, $2) on conflict (school_id) do update set last_no = library_counter.last_no + $2 returning last_no`, [schoolId, n]);
  const out: { id: string; accessionNo: number; barcode: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const acc = r.last_no - i;
    // An old label might already carry this code; then add a letter so codes stay unique.
    let barcode = `${code}${String(acc).padStart(6, '0')}`;
    for (let k = 0; await t.maybeOne('select 1 from library_copy where school_id = $1 and upper(barcode) = upper($2)', [schoolId, barcode]); k++) barcode = `${code}${String(acc).padStart(6, '0')}${'ABCDEFGHJK'[k]}`;
    const c = await t.one<{ id: string }>(
      `insert into library_copy (book_id, school_id, accession_no, barcode, acquired_on, source, location) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [bookId, schoolId, acc, barcode, o.acquiredOn ?? today(), o.source ?? 'PURCHASE', (o.location ?? '').trim()]);
    out.push({ id: c.id, accessionNo: acc, barcode });
  }
  return out;
}

export async function addCopies(db: Db, actor: Actor, bookId: string, input: { copies: number; location?: string; source?: 'PURCHASE' | 'DONATION' | 'OTHER'; acquiredOn?: string }) {
  const b = await db.maybeOne<{ school_id: string }>('select school_id from library_book where id = $1', [bookId]);
  if (!b) throw notFound('Book');
  await manage(db, actor, b.school_id);
  if (input.copies < 1 || input.copies > 200) throw invalid('Add between 1 and 200 copies at a time.');
  return db.tx((t) => addCopiesIn(t, b.school_id, bookId, input.copies, input), { actor: actor.label });
}

export async function updateBook(db: Db, actor: Actor, bookId: string, input: BookInput) {
  const b = await db.maybeOne<{ school_id: string }>('select school_id from library_book where id = $1', [bookId]);
  if (!b) throw notFound('Book');
  await manage(db, actor, b.school_id);
  await db.tx((t) => t.query(
    `update library_book set title = $2, author = $3, publisher = $4, edition = $5, year = $6, isbn = $7, subject = $8, language = $9, call_number = $10, price_paise = $11 where id = $1`,
    [bookId, input.title.trim(), input.author ?? '', input.publisher ?? '', input.edition ?? '', input.year ?? null, input.isbn ? input.isbn.replace(/[-\s]/g, '').toUpperCase() : null,
     input.subject ?? '', input.language ?? 'English', input.callNumber ?? '', input.pricePaise ?? 0]), { actor: actor.label });
  return { ok: true };
}

/** Changes a copy's condition: damaged, withdrawn from stock, or back on the shelf. */
export async function setCopyStatus(db: Db, actor: Actor, copyId: string, status: 'AVAILABLE' | 'DAMAGED' | 'WITHDRAWN', location?: string) {
  const c = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from library_copy where id = $1', [copyId]);
  if (!c) throw notFound('Copy');
  await manage(db, actor, c.school_id);
  if (c.status === 'ON_LOAN') throw conflict('on_loan', 'This copy is out on loan. Return it first.');
  await db.tx((t) => t.query(`update library_copy set status = $2, location = coalesce($3, location) where id = $1`, [copyId, status, location ?? null]), { actor: actor.label });
  return { ok: true };
}

/** Search by title, author, ISBN, subject, call number or a copy's barcode / accession number. */
export async function search(db: Db, actor: Actor, schoolId: string, q: string) {
  await assertUnitInScope(db, actor, schoolId);
  const term = q.trim();
  return db.query(
    `select b.id, b.title, b.author, b.publisher, b.edition, b.year, b.isbn, b.subject, b.language, b.call_number, b.price_paise::int,
            count(c.*)::int as copies,
            count(c.*) filter (where c.status = 'AVAILABLE')::int as available,
            count(c.*) filter (where c.status = 'ON_LOAN')::int as on_loan,
            min(c.accession_no) as first_accession,
            count(c.*) filter (where c.label_printed_at is null and c.status not in ('WITHDRAWN', 'LOST'))::int as labels_to_print
       from library_book b left join library_copy c on c.book_id = b.id
      where b.school_id = $1 and ($2 = '' or b.title ilike '%' || $2 || '%' or b.author ilike '%' || $2 || '%' or b.isbn = upper(replace($2, '-', ''))
            or b.subject ilike '%' || $2 || '%' or b.call_number ilike $2 || '%'
            or exists (select 1 from library_copy x where x.book_id = b.id and (upper(x.barcode) = upper($2) or x.accession_no::text = ltrim($2, '0'))))
      group by b.id order by b.title limit 200`, [schoolId, term]);
}

export async function book(db: Db, actor: Actor, bookId: string) {
  const b = await db.maybeOne<Record<string, unknown> & { school_id: string }>('select *, price_paise::int as price_paise from library_book where id = $1', [bookId]);
  if (!b) throw notFound('Book');
  await assertUnitInScope(db, actor, b.school_id);
  const copies = await db.query(
    `select c.id, c.accession_no, c.barcode, c.status, c.location, c.source, c.acquired_on::text, c.label_printed_at,
            l.due_on::text as due_on, coalesce(s.name, u.name) as borrower
       from library_copy c left join library_loan l on l.copy_id = c.id and l.returned_on is null
       left join enrolment e on e.id = l.enrolment_id left join student s on s.id = e.student_id left join app_user u on u.id = l.user_id
      where c.book_id = $1 order by c.accession_no`, [bookId]);
  return { ...b, copies };
}

// ── Borrowers ────────────────────────────────────────────────────────────────────────────

interface Borrower { kind: 'STUDENT' | 'STAFF'; enrolmentId: string | null; userId: string | null; studentId: string | null; name: string; detail: string }

/** Finds a borrower from what the ID card barcode carries (NES ID, admission number or staff number). */
export async function borrower(db: Db, actor: Actor, schoolId: string, code: string): Promise<Borrower & { loans: unknown[]; limit: number; overdue: number }> {
  await manage(db, actor, schoolId);
  const c = code.trim();
  const st = await db.maybeOne<{ enrolment_id: string; student_id: string; name: string; detail: string }>(
    `select e.id as enrolment_id, s.id as student_id, s.name, e.class_code || coalesce('-' || sec.name, '') || ' · ' || e.admission_no as detail
       from student s join enrolment e on e.student_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
       left join section sec on sec.id = e.section_id
      where e.school_id = $1 and (upper(s.nes_id) = upper($2) or upper(e.admission_no) = upper($2) or s.id::text = $2)`, [schoolId, c]);
  let b: Borrower;
  if (st) b = { kind: 'STUDENT', enrolmentId: st.enrolment_id, userId: null, studentId: st.student_id, name: st.name, detail: st.detail };
  else {
    const sf = await db.maybeOne<{ user_id: string; name: string; detail: string }>(
      `select p.user_id, u.name, coalesce(u.designation, '') || ' · ' || p.employee_no as detail from staff_profile p join app_user u on u.id = p.user_id
        where p.school_id = $1 and u.active and (upper(p.employee_no) = upper(regexp_replace($2, '^ST-', '', 'i')) or p.user_id::text = $2)`, [schoolId, c]);
    if (!sf) throw notFound(`No student or staff member with "${c}"`);
    b = { kind: 'STAFF', enrolmentId: null, userId: sf.user_id, studentId: null, name: sf.name, detail: sf.detail };
  }
  const loans = await openLoans(db, b);
  const limit = await settings.get<number>(db, schoolId, b.kind === 'STUDENT' ? 'library.max_books_student' : 'library.max_books_staff');
  return { ...b, loans, limit, overdue: loans.filter((l) => l.due_on < today()).length };
}

async function openLoans(db: Db, b: { enrolmentId: string | null; userId: string | null }) {
  return db.query<{ id: string; title: string; barcode: string; issued_on: string; due_on: string; renewals: number }>(
    `select l.id, bk.title, c.barcode, l.issued_on::text, l.due_on::text, l.renewals from library_loan l join library_copy c on c.id = l.copy_id join library_book bk on bk.id = c.book_id
      where l.returned_on is null and (l.enrolment_id = $1 or l.user_id = $2) order by l.due_on`, [b.enrolmentId, b.userId]);
}

async function copyByBarcode(db: Db, schoolId: string, barcode: string) {
  const c = await db.maybeOne<{ id: string; status: string; title: string; price_paise: number; book_id: string }>(
    `select c.id, c.status, b.title, b.price_paise::int, b.id as book_id from library_copy c join library_book b on b.id = c.book_id
      where c.school_id = $1 and (c.barcode = $2 or upper(c.barcode) = upper($2) or c.accession_no::text = ltrim($2, '0'))
      order by (c.barcode = $2) desc limit 1`, [schoolId, barcode.trim()]);
  if (!c) throw notFound(`No book with barcode "${barcode}"`);
  return c;
}

// ── Issue, return, renew ─────────────────────────────────────────────────────────────────

export async function issue(db: Db, actor: Actor, schoolId: string, input: { borrower: string; barcodes: string[] }) {
  const b = await borrower(db, actor, schoolId, input.borrower);
  if (!input.barcodes.length) throw invalid('Scan at least one book.');
  if (await settings.get<boolean>(db, schoolId, 'library.block_when_overdue') && b.overdue) {
    throw conflict('overdue', `${b.name} has ${b.overdue === 1 ? 'a book' : `${b.overdue} books`} overdue. Return ${b.overdue === 1 ? 'it' : 'them'} first.`);
  }
  if (b.loans.length + input.barcodes.length > b.limit) throw conflict('limit', `${b.name} may hold ${b.limit} books and already has ${b.loans.length}.`);
  const days = await settings.get<number>(db, schoolId, b.kind === 'STUDENT' ? 'library.loan_days_student' : 'library.loan_days_staff');
  const due = plusDays(today(), days);
  return db.tx(async (t) => {
    const issued: { title: string; barcode: string; dueOn: string }[] = [];
    for (const code of input.barcodes) {
      const c = await copyByBarcode(t, schoolId, code);
      if (c.status !== 'AVAILABLE') throw conflict('not_available', `"${c.title}" (${code}) is ${c.status === 'ON_LOAN' ? 'already on loan. Return it first' : c.status.toLowerCase()}.`);
      await t.query(`insert into library_loan (copy_id, school_id, enrolment_id, user_id, due_on, issued_by) values ($1, $2, $3, $4, $5, $6)`,
        [c.id, schoolId, b.enrolmentId, b.userId, due, actor.id]);
      await t.query(`update library_copy set status = 'ON_LOAN' where id = $1`, [c.id]);
      issued.push({ title: c.title, barcode: code.toUpperCase(), dueOn: due });
    }
    if (b.studentId) {
      await notify.toParentsOf(t, [b.studentId], { kind: 'LIBRARY', title: `${b.name} borrowed ${issued.length === 1 ? 'a book' : `${issued.length} books`}`,
        body: `${issued.map((i) => `"${i.title}"`).join(', ')}. Please return by ${notify.fmt(due)}.`.slice(0, 400), link: '/library' });
    }
    return { borrower: b.name, dueOn: due, issued };
  }, { actor: actor.label });
}

/** Bills a fine or a lost book to the family through fees (students), or records it (staff, collected at the desk). */
async function bill(t: Db, schoolId: string, loanId: string, enrolmentId: string | null, amount: number, what: string) {
  if (!enrolmentId || amount <= 0) return;
  const e = await t.one<{ student_id: string }>('select student_id from enrolment where id = $1', [enrolmentId]);
  const d = await t.one<{ id: string }>(
    `insert into fee_demand (enrolment_id, head_code, kind, gross_paise, concession_paise, fee_band, snapshot, bill_key, due_on)
     values ($1, 'LIBRARY', 'FINE', $2, 0, '-', $3, $4, $5) returning id`, [enrolmentId, amount, JSON.stringify({ loan: loanId, what }), `LIB:${loanId}`, plusDays(today(), 14)]);
  await post(t, { schoolId, narration: what, sourceType: 'fee_demand', sourceId: d.id,
    lines: [{ account: '1200', debit: amount, studentId: e.student_id }, { account: '4160', credit: amount, studentId: e.student_id }] });
  await notify.toParentsOf(t, [e.student_id], { kind: 'FEES', title: 'Library charge', body: `${what}: ${rupees(amount)}, added to your fees.`, link: '/fees' });
}

/** Return by scanning the book. Late returns are fined unless the librarian waives it with a reason. */
export async function returnBook(db: Db, actor: Actor, schoolId: string, input: { barcode: string; waive?: string | null; on?: string }) {
  await manage(db, actor, schoolId);
  const c = await copyByBarcode(db, schoolId, input.barcode);
  const l = await db.maybeOne<{ id: string; due_on: string; enrolment_id: string | null; user_id: string | null; borrower: string }>(
    `select l.id, l.due_on::text, l.enrolment_id, l.user_id, coalesce(s.name, u.name) as borrower from library_loan l
       left join enrolment e on e.id = l.enrolment_id left join student s on s.id = e.student_id left join app_user u on u.id = l.user_id
      where l.copy_id = $1 and l.returned_on is null`, [c.id]);
  if (!l) throw conflict('not_on_loan', `"${c.title}" is not on loan.`);
  const on = input.on ?? today();
  const late = Math.max(0, daysBetween(l.due_on, on));
  const rate = (await settings.get<number>(db, schoolId, 'library.fine_per_day')) * 100;
  const waived = !!input.waive?.trim();
  const fine = waived ? 0 : late * rate;
  return db.tx(async (t) => {
    await t.query(`update library_loan set returned_on = $2, returned_by = $3, fine_paise = $4, fine_note = $5 where id = $1`,
      [l.id, on, actor.id, fine, waived ? `Waived: ${input.waive!.trim()}` : late ? `${late} days late` : '']);
    await t.query(`update library_copy set status = 'AVAILABLE' where id = $1`, [c.id]);
    await bill(t, schoolId, l.id, l.enrolment_id, fine, `Library fine: "${c.title}" returned ${late} days late`);
    return { title: c.title, borrower: l.borrower, daysLate: late, finePaise: fine, waived: waived && late > 0, staff: !!l.user_id };
  }, { actor: actor.label });
}

export async function renew(db: Db, actor: Actor, schoolId: string, loanId: string) {
  await manage(db, actor, schoolId);
  const l = await db.maybeOne<{ renewals: number; due_on: string; enrolment_id: string | null; title: string }>(
    `select l.renewals, l.due_on::text, l.enrolment_id, b.title from library_loan l join library_copy c on c.id = l.copy_id join library_book b on b.id = c.book_id
      where l.id = $1 and l.school_id = $2 and l.returned_on is null`, [loanId, schoolId]);
  if (!l) throw notFound('Open loan');
  const max = await settings.get<number>(db, schoolId, 'library.max_renewals');
  if (l.renewals >= max) throw conflict('renewals', `"${l.title}" has been renewed ${l.renewals} time${l.renewals === 1 ? '' : 's'}, the most allowed. It must be returned.`);
  if (l.due_on < today()) throw conflict('overdue', `"${l.title}" is overdue. Return it (the fine is worked out) and issue it again.`);
  const days = await settings.get<number>(db, schoolId, l.enrolment_id ? 'library.loan_days_student' : 'library.loan_days_staff');
  const due = plusDays(today(), days);
  await db.tx((t) => t.query(`update library_loan set due_on = $2, renewals = renewals + 1 where id = $1`, [loanId, due]), { actor: actor.label });
  return { dueOn: due };
}

/** A lost book: the loan closes, the copy is marked lost, and its price is billed (students). */
export async function markLost(db: Db, actor: Actor, schoolId: string, barcode: string, note = '') {
  await manage(db, actor, schoolId);
  const c = await copyByBarcode(db, schoolId, barcode);
  const l = await db.maybeOne<{ id: string; enrolment_id: string | null }>('select id, enrolment_id from library_loan where copy_id = $1 and returned_on is null', [c.id]);
  if (!l) throw conflict('not_on_loan', `"${c.title}" is not on loan. To remove a copy from stock, mark it withdrawn.`);
  return db.tx(async (t) => {
    await t.query(`update library_loan set returned_on = current_date, returned_by = $2, lost = true, fine_paise = $3, fine_note = $4 where id = $1`,
      [l.id, actor.id, c.price_paise, `Lost${note ? `: ${note}` : ''}`]);
    await t.query(`update library_copy set status = 'LOST' where id = $1`, [c.id]);
    await bill(t, schoolId, l.id, l.enrolment_id, c.price_paise, `Lost library book: "${c.title}"`);
    return { title: c.title, billedPaise: l.enrolment_id ? c.price_paise : 0 };
  }, { actor: actor.label });
}

export async function overdue(db: Db, actor: Actor, schoolId: string) {
  await manage(db, actor, schoolId);
  return db.query(
    `select l.id, b.title, c.barcode, l.issued_on::text, l.due_on::text, (current_date - l.due_on)::int as days_late,
            coalesce(s.name, u.name) as borrower, coalesce(e.class_code || coalesce('-' || sec.name, ''), u.designation) as detail
       from library_loan l join library_copy c on c.id = l.copy_id join library_book b on b.id = c.book_id
       left join enrolment e on e.id = l.enrolment_id left join student s on s.id = e.student_id left join section sec on sec.id = e.section_id
       left join app_user u on u.id = l.user_id
      where l.school_id = $1 and l.returned_on is null and l.due_on < current_date order by l.due_on`, [schoolId]);
}

export async function summary(db: Db, actor: Actor, schoolId: string) {
  await manage(db, actor, schoolId);
  return db.one(
    `select (select count(*) from library_book where school_id = $1)::int as titles,
            (select count(*) from library_copy where school_id = $1 and status <> 'WITHDRAWN')::int as copies,
            (select count(*) from library_copy where school_id = $1 and status = 'ON_LOAN')::int as on_loan,
            (select count(*) from library_loan where school_id = $1 and returned_on is null and due_on < current_date)::int as overdue,
            (select count(*) from library_copy where school_id = $1 and label_printed_at is null and status not in ('WITHDRAWN', 'LOST'))::int as labels_to_print,
            (select count(*) from library_loan where school_id = $1 and issued_on = current_date)::int as issued_today`, [schoolId]);
}

/** A child's books, for the parent app and the class teacher. */
export async function forStudent(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'profile');
  return db.query(
    `select b.title, b.author, c.barcode, l.issued_on::text, l.due_on::text, l.returned_on::text, l.fine_paise::int, l.lost, (l.returned_on is null and l.due_on < current_date) as overdue
       from library_loan l join library_copy c on c.id = l.copy_id join library_book b on b.id = c.book_id join enrolment e on e.id = l.enrolment_id
      where e.student_id = $1 order by (l.returned_on is null) desc, l.issued_on desc limit 50`, [studentId]);
}

export async function mine(db: Db, actor: Actor) {
  return db.query(
    `select b.title, c.barcode, l.issued_on::text, l.due_on::text, (l.due_on < current_date) as overdue from library_loan l join library_copy c on c.id = l.copy_id
       join library_book b on b.id = c.book_id where l.user_id = $1 and l.returned_on is null order by l.due_on`, [actor.id]);
}

/** Open loans for an enrolment: a transfer certificate waits until these are back. */
export async function openForEnrolment(db: Db, enrolmentId: string) {
  return db.query<{ title: string; due_on: string }>(`select b.title, l.due_on::text from library_loan l join library_copy c on c.id = l.copy_id join library_book b on b.id = c.book_id
    where l.enrolment_id = $1 and l.returned_on is null`, [enrolmentId]);
}

/** The accession register as a spreadsheet. */
export async function register(db: Db, actor: Actor, schoolId: string) {
  await manage(db, actor, schoolId);
  return db.query<Record<string, unknown>>(
    `select c.accession_no, c.barcode, c.acquired_on::text, b.title, b.author, b.publisher, b.edition, b.year, b.isbn, b.call_number, b.subject, b.language,
            (b.price_paise / 100.0)::numeric(10, 2) as price, c.source, c.location, c.status
       from library_copy c join library_book b on b.id = c.book_id where c.school_id = $1 order by c.accession_no`, [schoolId]);
}

// ── Barcode labels ───────────────────────────────────────────────────────────────────────

/**
 * Spine or inside-cover labels on the school's label stationery. `startAt` skips labels already
 * used on a part-used sheet (1 = top-left, counting across then down).
 */
export async function labelsPdf(db: Db, actor: Actor, schoolId: string, input: { copyIds?: string[]; unprinted?: boolean; fromAccession?: number; toAccession?: number; sheetId: string; startAt?: number; printerId?: string | null }) {
  await manage(db, actor, schoolId);
  const sheet = await db.maybeOne<printing.LabelSheet>(`select ${printing.SHEET_COLS} from label_sheet where id = $1 and (school_id is null or school_id = $2)`, [input.sheetId, schoolId]);
  if (!sheet) throw notFound('Label sheet');
  const copies = await db.query<{ id: string; accession_no: number; barcode: string; title: string; call_number: string }>(
    `select c.id, c.accession_no, c.barcode, b.title, b.call_number from library_copy c join library_book b on b.id = c.book_id
      where c.school_id = $1 and c.status not in ('WITHDRAWN', 'LOST')
        and (($2::uuid[] is not null and c.id = any($2)) or ($2::uuid[] is null and (
              ($3 and c.label_printed_at is null) or (not $3 and c.accession_no between coalesce($4, 0) and coalesce($5, 2147483647)))))
      order by c.accession_no limit 2000`,
    [schoolId, input.copyIds?.length ? input.copyIds : null, !!input.unprinted, input.fromAccession ?? null, input.toAccession ?? null]);
  if (!copies.length) throw invalid('No copies match. Choose copies, a range of accession numbers, or "not yet printed".');
  const cal = await printing.calibration(db, schoolId, input.printerId);
  const code = (await db.one<{ code: string }>('select code from org_unit where id = $1', [schoolId])).code;
  const { doc, fonts } = await newDocument('Library labels');
  const perPage = sheet.cols * sheet.rows;
  let slot = Math.max(0, Math.min(perPage - 1, (input.startAt ?? 1) - 1));
  let page: Sheet | null = null;
  for (const c of copies) {
    if (!page || slot >= perPage) { page = new Sheet(doc, sheet.page_w, sheet.page_h, fonts, cal); if (slot >= perPage) slot = 0; }
    const col = slot % sheet.cols, row = Math.floor(slot / sheet.cols);
    const x = sheet.margin_left + col * (sheet.label_w + sheet.gap_x), y = sheet.margin_top + row * (sheet.label_h + sheet.gap_y);
    drawLabel(page, x, y, sheet.label_w, sheet.label_h, { school: code, call: c.call_number, barcode: c.barcode, accession: c.accession_no, title: c.title });
    slot++;
  }
  await db.tx(async (t) => {
    await t.query(`update library_copy set label_printed_at = now() where id = any($1)`, [copies.map((c) => c.id)]);
    await printing.log(t, actor, schoolId, 'BOOK_LABEL', copies.length, { sheet: sheet.name, first: copies[0].accession_no, last: copies[copies.length - 1].accession_no }, input.printerId);
  }, { actor: actor.label });
  return { pdf: Buffer.from(await doc.save()), count: copies.length, pages: doc.getPageCount() };
}

/** One label: school and call number, the barcode, then accession number and title. Sizes follow the label. */
function drawLabel(s: Sheet, x: number, y: number, w: number, h: number, l: { school: string; call: string; barcode: string; accession: number; title: string }) {
  const pad = Math.min(2, w * 0.05);
  const small = h < 23 ? 5.5 : 6.5;
  const lineH = small * 0.42;
  const inner = w - 2 * pad;
  s.text(l.school, x + pad, y + pad, { size: small, font: s.fonts.bold, maxWidth: inner * 0.45 });
  if (l.call) s.text(l.call, x + pad + inner * 0.45, y + pad, { size: small, font: s.fonts.bold, maxWidth: inner * 0.55, align: 'right' });
  const barTop = y + pad + lineH + 0.8;
  const barH = Math.max(6, h - 2 * pad - 2 * lineH - 2.4);
  s.barcode(l.barcode, x + pad - 1, barTop, inner + 2, barH);
  s.text(`${l.barcode}  ·  Acc. ${l.accession}`, x + pad, barTop + barH + 0.6, { size: small, font: s.fonts.mono, maxWidth: inner, align: 'centre' });
  if (h >= 21) s.text(l.title, x + pad, barTop + barH + 0.6 + lineH, { size: small - 0.5, maxWidth: inner, align: 'centre' });
}

// ── Import from the old ERP ──────────────────────────────────────────────────────────────

/**
 * The columns an old system's export may use, matched by name. Anything not recognised can be
 * mapped by hand in the import screen.
 */
export const IMPORT_FIELDS: Record<string, { label: string; names: string[]; required?: boolean }> = {
  accession: { label: 'Accession number', names: ['accession', 'accession no', 'accession number', 'acc no', 'acc', 'acc. no.', 'accn no', 'access no', 'accno'] },
  code: { label: 'Barcode / QR code on the label', names: ['barcode', 'bar code', 'qr', 'qr code', 'qrcode', 'code', 'book code', 'book id', 'label', 'copy id'] },
  title: { label: 'Title', names: ['title', 'book title', 'book name', 'name of book', 'name'], required: true },
  author: { label: 'Author', names: ['author', 'authors', 'author name', 'writer'] },
  publisher: { label: 'Publisher', names: ['publisher', 'publication', 'publishers'] },
  edition: { label: 'Edition', names: ['edition'] },
  year: { label: 'Year', names: ['year', 'publication year', 'year of publication'] },
  isbn: { label: 'ISBN', names: ['isbn', 'isbn no', 'isbn number'] },
  subject: { label: 'Subject', names: ['subject', 'category', 'genre'] },
  language: { label: 'Language', names: ['language', 'lang'] },
  callNumber: { label: 'Call number', names: ['call no', 'call number', 'class no', 'class number', 'ddc'] },
  price: { label: 'Price (₹)', names: ['price', 'cost', 'rate', 'amount', 'mrp'] },
  location: { label: 'Shelf / rack', names: ['shelf', 'rack', 'location', 'almirah', 'cupboard'] },
  acquiredOn: { label: 'Date of accession', names: ['date', 'date of accession', 'accession date', 'purchase date', 'acquired on', 'bill date'] },
  source: { label: 'Purchase or donation', names: ['source', 'mode', 'purchase/donation', 'how acquired'] },
  status: { label: 'Status', names: ['status', 'condition', 'state'] },
};

const norm = (h: string) => h.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

/** Guesses which spreadsheet column holds which field. */
export function guessMapping(headers: string[]) {
  const map: Record<string, number | null> = {};
  for (const [field, def] of Object.entries(IMPORT_FIELDS)) {
    const i = headers.findIndex((h) => def.names.includes(norm(h)));
    map[field] = i >= 0 ? i : null;
  }
  return map;
}

/** Dates as old systems write them: 2019-06-14, 14/06/2019, 14-06-2019, 14.06.2019. */
function parseDate(v: string) {
  const t = v.trim();
  if (!t) return null;
  const real = (y: string, mo: string, d: string) => {
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const dt = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : 'bad';
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return real(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) return real(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  return 'bad';
}

const STATUS_WORDS: [RegExp, 'AVAILABLE' | 'ON_LOAN' | 'LOST' | 'DAMAGED' | 'WITHDRAWN'][] = [
  [/^(available|in|in stock|on shelf|ok|good|active|)$/i, 'AVAILABLE'], [/issued|on loan|out|borrowed/i, 'ON_LOAN'], [/lost|missing/i, 'LOST'],
  [/damage|torn|repair/i, 'DAMAGED'], [/withdrawn|weeded|discard|written off|condemn/i, 'WITHDRAWN'],
];

export interface ImportRow { line: number; accession: number | null; code: string | null; book: BookInput; location: string; acquiredOn: string | null; source: 'PURCHASE' | 'DONATION' | 'OTHER'; status: 'AVAILABLE' | 'ON_LOAN' | 'LOST' | 'DAMAGED' | 'WITHDRAWN'; errors: string[]; warnings: string[] }

async function readRows(db: Db, schoolId: string, csv: string, mapping?: Record<string, number | null>) {
  const { parseCsv } = await import('./dataio.js');
  const all = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) throw invalid('The file has no rows. Export the book list from the old system as CSV (in Excel: Save As → CSV) and upload it.');
  const headers = all[0];
  const map = { ...guessMapping(headers), ...(mapping ?? {}) };
  if (map.title === null || map.title === undefined) throw invalid('Could not find the title column. Choose which column holds the title.', { headers, mapping: map });
  const get = (r: string[], f: string) => { const i = map[f]; return i === null || i === undefined ? '' : (r[i] ?? '').trim(); };
  const existing = await db.query<{ accession_no: number; barcode: string }>('select accession_no, barcode from library_copy where school_id = $1', [schoolId]);
  const accTaken = new Set(existing.map((e) => e.accession_no));
  const codeTaken = new Set(existing.map((e) => e.barcode.toUpperCase()));
  const seenAcc = new Map<number, number>(); const seenCode = new Map<string, number>();
  const rows: ImportRow[] = all.slice(1).map((r, i) => {
    const line = i + 2;
    const errors: string[] = []; const warnings: string[] = [];
    const accRaw = get(r, 'accession').replace(/^0+(?=\d)/, '');
    const accession = accRaw ? (/^\d{1,9}$/.test(accRaw) ? Number(accRaw) : NaN) : null;
    if (accession !== null && Number.isNaN(accession)) errors.push(`Accession number "${get(r, 'accession')}" is not a number`);
    if (accession && accTaken.has(accession)) errors.push(`Accession ${accession} is already in this school's register`);
    if (accession && seenAcc.has(accession)) errors.push(`Accession ${accession} also appears on line ${seenAcc.get(accession)}`);
    if (accession) seenAcc.set(accession, line);
    const code = get(r, 'code') || null;
    if (code && codeTaken.has(code.toUpperCase())) errors.push(`The label code "${code}" is already used by another copy`);
    if (code && seenCode.has(code.toUpperCase())) errors.push(`The label code "${code}" also appears on line ${seenCode.get(code.toUpperCase())}`);
    if (code) seenCode.set(code.toUpperCase(), line);
    if (!code && !accession) warnings.push('No accession number or label code: a new accession number and label will be made');
    else if (!code) warnings.push('No label code: a new barcode label will need printing');
    const title = get(r, 'title');
    if (!title) errors.push('Title is empty');
    const isbnRaw = get(r, 'isbn').replace(/[-\s]/g, '').toUpperCase();
    const isbn = /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(isbnRaw) ? isbnRaw : null;
    if (isbnRaw && !isbn) warnings.push(`ISBN "${get(r, 'isbn')}" is not valid and was left out`);
    const yearRaw = get(r, 'year');
    const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
    const priceRaw = get(r, 'price').replace(/[₹,\s]|rs\.?/gi, '');
    const price = priceRaw && /^\d+(\.\d{1,2})?$/.test(priceRaw) ? Math.round(Number(priceRaw) * 100) : 0;
    if (priceRaw && !price && priceRaw !== '0') warnings.push(`Price "${get(r, 'price')}" was not understood and set to 0`);
    const acquired = parseDate(get(r, 'acquiredOn'));
    if (acquired === 'bad') warnings.push(`Date "${get(r, 'acquiredOn')}" was not understood; today's date is used`);
    const statusRaw = get(r, 'status');
    const status = STATUS_WORDS.find(([re]) => re.test(statusRaw))?.[1] ?? 'AVAILABLE';
    if (statusRaw && !STATUS_WORDS.some(([re]) => re.test(statusRaw))) warnings.push(`Status "${statusRaw}" was not understood; treated as available`);
    const src = get(r, 'source');
    return {
      line, accession: accession && !Number.isNaN(accession) ? accession : null, code, errors, warnings,
      book: { title, author: get(r, 'author'), publisher: get(r, 'publisher'), edition: get(r, 'edition'), year, isbn, subject: get(r, 'subject'),
        language: get(r, 'language') || 'English', callNumber: get(r, 'callNumber'), pricePaise: price },
      location: get(r, 'location'), acquiredOn: acquired && acquired !== 'bad' ? acquired : null,
      source: /donat|gift/i.test(src) ? 'DONATION' : src && !/purchas|bought/i.test(src) ? 'OTHER' : 'PURCHASE',
      // Books marked "issued" come in as available; their loans are imported separately with the borrower.
      status: status === 'ON_LOAN' ? 'AVAILABLE' : status,
    };
  });
  return { headers, mapping: map, rows };
}

/** Checks the old system's book list and shows what would happen. Nothing is saved. */
export async function previewImport(db: Db, actor: Actor, schoolId: string, csv: string, mapping?: Record<string, number | null>) {
  await manage(db, actor, schoolId);
  const { headers, mapping: map, rows } = await readRows(db, schoolId, csv, mapping);
  const key = (b: BookInput) => `${(b.isbn ?? '')}|${b.title.toLowerCase()}|${(b.author ?? '').toLowerCase()}|${(b.edition ?? '').toLowerCase()}`;
  return {
    headers, mapping: map, fields: IMPORT_FIELDS,
    copies: rows.length, books: new Set(rows.filter((r) => !r.errors.length).map((r) => key(r.book))).size,
    keepLabels: rows.filter((r) => r.code && !r.errors.length).length, needLabels: rows.filter((r) => !r.code && !r.errors.length).length,
    withErrors: rows.filter((r) => r.errors.length).length,
    rows: rows.filter((r) => r.errors.length || r.warnings.length).slice(0, 300).map((r) => ({ line: r.line, title: r.book.title, accession: r.accession, code: r.code, errors: r.errors, warnings: r.warnings })),
    sample: rows.slice(0, 5).map((r) => ({ line: r.line, accession: r.accession, code: r.code, title: r.book.title, author: r.book.author, status: r.status })),
  };
}

/**
 * Imports the old book list, all or nothing. Copies of the same title are grouped under one book.
 * Each copy keeps its accession number and the code on its existing label, so scanning works at
 * once; copies with no code get a new barcode (and show up under "labels to print").
 */
export async function importBooks(db: Db, actor: Actor, schoolId: string, csv: string, mapping?: Record<string, number | null>) {
  await manage(db, actor, schoolId);
  const { rows } = await readRows(db, schoolId, csv, mapping);
  const bad = rows.filter((r) => r.errors.length);
  if (bad.length) throw invalid(`${bad.length} row${bad.length === 1 ? ' has' : 's have'} problems, so nothing was imported. Fix them and try again.`, bad.slice(0, 50).map((r) => ({ line: r.line, message: r.errors.join('; ') })));
  const code = await schoolCode(db, schoolId);
  return db.tx(async (t) => {
    const books = new Map<string, string>();
    let maxAcc = (await t.maybeOne<{ last_no: number }>('select last_no from library_counter where school_id = $1', [schoolId]))?.last_no ?? 0;
    for (const r of rows) if (r.accession && r.accession > maxAcc) maxAcc = r.accession;
    let next = maxAcc;
    let labelled = 0;
    for (const r of rows) {
      const k = `${r.book.isbn ?? ''}|${r.book.title.toLowerCase()}|${(r.book.author ?? '').toLowerCase()}|${(r.book.edition ?? '').toLowerCase()}`;
      let bookId = books.get(k);
      if (!bookId) {
        bookId = (await t.one<{ id: string }>(
          `insert into library_book (school_id, title, author, publisher, edition, year, isbn, subject, language, call_number, price_paise) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [schoolId, r.book.title, r.book.author ?? '', r.book.publisher ?? '', r.book.edition ?? '', r.book.year ?? null, r.book.isbn ?? null, r.book.subject ?? '', r.book.language ?? 'English', r.book.callNumber ?? '', r.book.pricePaise ?? 0])).id;
        books.set(k, bookId);
      }
      const acc = r.accession ?? ++next;
      const barcode = r.code ?? `${code}${String(acc).padStart(6, '0')}`;
      await t.query(
        `insert into library_copy (book_id, school_id, accession_no, barcode, status, acquired_on, source, location, label_printed_at, imported) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [bookId, schoolId, acc, barcode, r.status, r.acquiredOn ?? today(), r.source, r.location, r.code ? new Date().toISOString() : null]);
      if (r.code) labelled++;
    }
    await t.query(`insert into library_counter (school_id, last_no) values ($1, $2) on conflict (school_id) do update set last_no = greatest(library_counter.last_no, $2)`, [schoolId, next]);
    return { books: books.size, copies: rows.length, keptLabels: labelled, labelsToPrint: rows.length - labelled, nextAccession: next + 1 };
  }, { actor: actor.label });
}

/**
 * Books on loan in the old system: borrower (admission number, NES ID or staff number), the book
 * (label code or accession number), issue date and due date. Imported after the book list.
 */
export async function importLoans(db: Db, actor: Actor, schoolId: string, csv: string) {
  await manage(db, actor, schoolId);
  const { parseCsv } = await import('./dataio.js');
  const all = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) throw invalid('The file has no rows.');
  const h = all[0].map(norm);
  const col = (names: string[]) => h.findIndex((x) => names.includes(x));
  const iB = col(['borrower', 'admission no', 'adm no', 'member', 'member id', 'student id', 'nes id', 'employee no', 'staff no', 'card no']);
  const iC = col(['barcode', 'qr', 'qr code', 'code', 'book code', 'accession', 'accession no', 'acc no', 'book id']);
  const iI = col(['issued on', 'issue date', 'date of issue', 'issued']);
  const iD = col(['due on', 'due date', 'return by', 'due']);
  if (iB < 0 || iC < 0) throw invalid('The loans file needs a borrower column (admission number or staff number) and a book column (label code or accession number).');
  const errors: { line: number; message: string }[] = [];
  const plan: { line: number; copyId: string; enrolmentId: string | null; userId: string | null; issued: string; due: string }[] = [];
  const loanDays = await settings.get<number>(db, schoolId, 'library.loan_days_student');
  for (const [i, r] of all.slice(1).entries()) {
    const line = i + 2;
    const b = await borrower(db, actor, schoolId, r[iB] ?? '').catch(() => null);
    const c = await copyByBarcode(db, schoolId, r[iC] ?? '').catch(() => null);
    if (!b) { errors.push({ line, message: `No student or staff member "${r[iB]}"` }); continue; }
    if (!c) { errors.push({ line, message: `No book "${r[iC]}"; import the book list first` }); continue; }
    if (c.status !== 'AVAILABLE') { errors.push({ line, message: `"${c.title}" (${r[iC]}) is ${c.status.toLowerCase().replace('_', ' ')}` }); continue; }
    if (plan.some((p) => p.copyId === c.id)) { errors.push({ line, message: `"${c.title}" is listed twice` }); continue; }
    const issued = iI >= 0 ? parseDate(r[iI] ?? '') : null;
    const due = iD >= 0 ? parseDate(r[iD] ?? '') : null;
    if (issued === 'bad' || due === 'bad') { errors.push({ line, message: 'A date was not understood' }); continue; }
    const iss = issued ?? today();
    plan.push({ line, copyId: c.id, enrolmentId: b.enrolmentId, userId: b.userId, issued: iss, due: due ?? plusDays(iss, loanDays) });
  }
  if (errors.length) throw invalid(`${errors.length} loan${errors.length === 1 ? ' has' : 's have'} problems, so nothing was imported.`, errors.slice(0, 50));
  await db.tx(async (t) => {
    for (const p of plan) {
      await t.query(`insert into library_loan (copy_id, school_id, enrolment_id, user_id, issued_on, due_on, issued_by) values ($1, $2, $3, $4, $5, greatest($6::date, $5::date), $7)`,
        [p.copyId, schoolId, p.enrolmentId, p.userId, p.issued, p.due, actor.id]);
      await t.query(`update library_copy set status = 'ON_LOAN' where id = $1`, [p.copyId]);
    }
  }, { actor: actor.label });
  return { loans: plan.length };
}

export const IMPORT_TEMPLATE = 'Accession No,Barcode,Title,Author,Publisher,Edition,Year,ISBN,Subject,Language,Call No,Price,Shelf,Date of Accession,Source,Status\r\n'
  + '1024,LIB001024,Wings of Fire,A. P. J. Abdul Kalam,Universities Press,1st,1999,9788173711466,Biography,English,920 KAL,350,R3-S2,14/06/2019,Purchase,Available\r\n';
