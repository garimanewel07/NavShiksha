import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as library from '../src/modules/library.js';
import * as printing from '../src/modules/printing.js';
import * as cards from '../src/modules/cards.js';
import * as certificates from '../src/modules/certificates.js';
import * as approvals from '../src/modules/approvals.js';
import * as duties from '../src/modules/duties.js';
import * as fees from '../src/modules/fees.js';
import * as settings from '../src/modules/settings.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, movedEarlier, rejects, YEAR, type World } from './helpers.js';
import { localToday, daysFromToday } from '../src/lib/dates.js';

let w: World;
let librarian: Actor; let office: Actor; let other: Actor;
type Fam = Awaited<ReturnType<typeof family>>;
let a: Fam, b: Fam;
const today = localToday();
const plus = (n: number) => daysFromToday(n);
const PT = 72 / 25.4;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pages = async (buf: Buffer) => { const d = await PDFDocument.load(buf); return d.getPages().map((p) => p.getSize()); };
const mm = (pt: number) => Math.round((pt / PT) * 10) / 10;
const sheetId = async (name: string) => (await w.db.one<{ id: string }>('select id from label_sheet where name like $1 and school_id is null', [`${name}%`])).id;

beforeAll(async () => {
  w = await makeWorld();
  const user = async (name: string, role: string) => loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, 'nes.wnc.ncs_a') returning id`, [name, role])).id);
  librarian = await user('Librarian Lata', 'TEACHER');
  office = await user('Office Omkar', 'TEACHER');
  other = await user('Other Teacher', 'TEACHER');
  await duties.assign(w.db, w.principalA, w.schoolA, { userId: librarian.id, code: 'LIBRARIAN', from: today });
  await duties.assign(w.db, w.principalA, w.schoolA, { userId: office.id, code: 'ADMISSION_INCHARGE', from: today });
  librarian = await loadActor(w.db, librarian.id); office = await loadActor(w.db, office.id);
  a = await family(w, { classCode: 'X', section: 0 }); b = await family(w, { classCode: 'X', section: 0 });
  await w.db.query(`update org_unit set affiliation_no = '1130046', udise_code = '27230100101', school_no = '76287', city = 'Mumbai', phone = '022 2215 0000', website = 'www.ncsalpha.edu.in' where id = $1`, [w.schoolA]);
});

describe('library', () => {
  let adm = '';
  it('numbers every copy in the accession register and issues by scanning', async () => {
    await rejects(library.addBook(w.db, other, w.schoolA, { title: 'X', copies: 1 }), /not part of your role/);
    const r = await library.addBook(w.db, librarian, w.schoolA, { title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', isbn: '978-81-7371-146-6', callNumber: '920 KAL', pricePaise: 35000, copies: 3 });
    expect(r.copies.map((c) => c.accessionNo)).toEqual([1, 2, 3]);
    expect(r.copies[0].barcode).toBe('A000001');
    adm = (await w.db.one<{ admission_no: string }>('select admission_no from enrolment where id = $1', [a.enrolmentId])).admission_no;
    const issued = await library.issue(w.db, librarian, w.schoolA, { borrower: adm, barcodes: ['A000001', '2'] });   // barcode, or accession number typed in
    expect(issued.dueOn).toBe(plus(14));
    await rejects(library.issue(w.db, librarian, w.schoolA, { borrower: adm, barcodes: ['A000003'] }), /may hold 2 books/);
    await rejects(library.issue(w.db, librarian, w.schoolA, { borrower: 'NOBODY-1', barcodes: ['A000003'] }), /No student or staff member/);
    const mine = await library.forStudent(w.db, a.parent, a.studentId);
    expect(mine.length).toBe(2);
  });

  it('fines late returns through fees, lets the librarian waive with a reason, and bills lost books', async () => {
    const back = await library.returnBook(w.db, librarian, w.schoolA, { barcode: 'A000001', on: plus(14 + 5) });
    expect(back).toMatchObject({ daysLate: 5, finePaise: 500 });
    const due = (await fees.dues(w.db, a.studentId)).find((d) => d.head_code === 'LIBRARY')!;
    expect(due).toMatchObject({ owed_paise: 500, label: 'Library fine' });
    const waived = await library.returnBook(w.db, librarian, w.schoolA, { barcode: 'A000002', on: plus(20), waive: 'Child was in hospital' });
    expect(waived).toMatchObject({ finePaise: 0, waived: true });
    await library.issue(w.db, librarian, w.schoolA, { borrower: adm, barcodes: ['A000003'] });
    await library.renew(w.db, librarian, w.schoolA, (await w.db.one<{ id: string }>(`select id from library_loan where returned_on is null`)).id);
    await rejects(library.renew(w.db, librarian, w.schoolA, (await w.db.one<{ id: string }>(`select id from library_loan where returned_on is null`)).id), /most allowed/);
    const lost = await library.markLost(w.db, librarian, w.schoolA, 'A000003', 'Lost on the bus');
    expect(lost.billedPaise).toBe(35000);
    await rejects(w.db.query(`update library_copy set barcode = 'X' where accession_no = 1`), /never change/);
    await rejects(w.db.query(`delete from library_loan`), /kept/);
  });

  it('imports the old ERP book list, keeping every existing label code so nothing is relabelled', async () => {
    const csv = [
      'Acc No,QR Code,Book Name,Author,Publisher,ISBN,Call No,Price,Rack,Date of Accession,Status',
      '1024,https://oldlib.example.in/b/1024,Godan,Premchand,Saraswati Press,,891.43 PRE,Rs. 120,R1,14/06/2019,Available',
      '1025,QR-001025,Godan,Premchand,Saraswati Press,,891.43 PRE,120,R1,14/06/2019,Issued',
      '1026,,Malgudi Days,R. K. Narayan,Indian Thought,9780143039655,823 NAR,250,R2,2019-07-01,Damaged',
      '1027,QR-001027,Old Atlas,,,,,abc,R9,32/13/2019,Weeded',
    ].join('\n');
    const p = await library.previewImport(w.db, librarian, w.schoolA, csv);
    expect(p).toMatchObject({ copies: 4, books: 3, keepLabels: 3, needLabels: 1, withErrors: 0 });
    expect(p.mapping).toMatchObject({ accession: 0, code: 1, title: 2, author: 3, location: 8, acquiredOn: 9, status: 10 });
    expect(p.rows.find((r) => r.line === 5)!.warnings.join(' ')).toMatch(/Price "abc".*Date "32\/13\/2019"/);
    const dupe = `${csv}\n1024,QR-X,Dup,,,,,,,,`;
    await rejects(library.importBooks(w.db, librarian, w.schoolA, dupe), /nothing was imported/);
    const r = await library.importBooks(w.db, librarian, w.schoolA, csv);
    expect(r).toEqual({ books: 3, copies: 4, keptLabels: 3, labelsToPrint: 1, nextAccession: 1028 });
    // Scanning the old QR label works at once; new copies continue the accession register.
    const kid = (await w.db.one<{ admission_no: string }>('select admission_no from enrolment where id = $1', [b.enrolmentId])).admission_no;
    expect((await library.issue(w.db, librarian, w.schoolA, { borrower: kid, barcodes: ['https://oldlib.example.in/b/1024'] })).issued[0].title).toBe('Godan');
    const more = await library.addBook(w.db, librarian, w.schoolA, { title: 'New Book', copies: 1 });
    expect(more.copies[0].accessionNo).toBe(1028);
    const statuses = await w.db.query<{ accession_no: number; status: string }>(`select accession_no, status from library_copy where accession_no in (1026, 1027) order by 1`);
    expect(statuses.map((s) => s.status)).toEqual(['DAMAGED', 'WITHDRAWN']);
    // Loans open in the old system come across too.
    expect(await library.importLoans(w.db, librarian, w.schoolA, `Admission No,QR Code,Issue Date,Due Date\n${kid},QR-001025,01/10/2026,15/10/2026`)).toEqual({ loans: 1 });
    expect((await library.overdue(w.db, librarian, w.schoolA)).some((o) => (o as { title: string }).title === 'Godan')).toBe(true);
  });

  it('prints barcode labels on the chosen stationery, starting where a used sheet left off', async () => {
    const sheet = await sheetId('A4, 65 labels');
    const r = await library.labelsPdf(w.db, librarian, w.schoolA, { unprinted: true, sheetId: sheet, startAt: 64 });
    expect(r.count).toBe(4);                                         // accession 1 and 2, 1026 (no old label) and 1028; the lost copy gets none
    expect(r.pages).toBe(2);                                         // slots 64 and 65 finish the part-used sheet; the rest start a new one
    const size = (await pages(r.pdf))[0];
    expect([mm(size.width), mm(size.height)]).toEqual([210, 297]);
    expect((await library.summary(w.db, librarian, w.schoolA) as { labels_to_print: number }).labels_to_print).toBe(0);
    const tiny = await printing.addLabelSheet(w.db, librarian, w.schoolA, { name: 'Tiny', page_w: 20, page_h: 10, cols: 1, rows: 1, label_w: 20, label_h: 10, margin_left: 0, margin_top: 0, gap_x: 0, gap_y: 0 });
    await rejects(library.labelsPdf(w.db, librarian, w.schoolA, { fromAccession: 1, toAccession: 1, sheetId: tiny.id }), /needs \d+ mm of width to scan reliably/);
  });
});

describe('printers and calibration', () => {
  it('records offsets per printer and prints a calibration page at the exact paper size', async () => {
    const p = await printing.savePrinter(w.db, office, w.schoolA, { name: 'Office laser', purpose: 'DOCUMENTS', offsetX: -1.5, offsetY: 2, scale: 100.5 });
    const list = await printing.printers(w.db, office, w.schoolA) as { offsetX: number; scale: number }[];
    expect(list[0]).toMatchObject({ offsetX: -1.5, scale: 100.5 });
    const cal = await printing.calibrationPdf(w.db, office, w.schoolA, p.id, 'A4');
    expect((await pages(cal)).map((s) => [mm(s.width), mm(s.height)])).toEqual([[210, 297]]);
    const card = await printing.calibrationPdf(w.db, office, w.schoolA, p.id, 'CARD');
    expect((await pages(card)).map((s) => [mm(s.width), mm(s.height)])).toEqual([[85.6, 54]]);
    await rejects(printing.savePrinter(w.db, other, w.schoolA, { name: 'Mine', purpose: 'LABELS' }), /not part of your role/);
    await rejects(printing.savePrinter(w.db, office, w.schoolA, { name: 'Bad', purpose: 'LABELS', offsetX: 40 }), /offset|check/);
  });
});

describe('ID cards', () => {
  it('lets the class teacher add photos for their own class only, and the office add them in bulk by admission number', async () => {
    await printing.setPhoto(w.db, w.teacherA, 'STUDENT', a.studentId, PNG);             // class teacher of X-A
    await rejects(printing.setPhoto(w.db, other, 'STUDENT', a.studentId, PNG), /class teacher for their own class/);
    await rejects(printing.setPhoto(w.db, office, 'STUDENT', a.studentId, Buffer.from('GIF89a').toString('base64')), /Only JPEG or PNG/);
    const adm = (await w.db.one<{ admission_no: string }>('select admission_no from enrolment where id = $1', [b.enrolmentId])).admission_no;
    const r = await printing.bulkPhotos(w.db, office, w.schoolA, 'STUDENT', [{ name: `${adm.replace(/\//g, '_')}.png`, dataBase64: PNG }, { name: 'unknown.png', dataBase64: PNG }]);
    expect(r).toMatchObject({ saved: 1, unmatched: ['unknown.png'] });
  });

  it('prints plastic CR80 cards one per page for a card printer, or on A4 with mirrored backs', async () => {
    const d = await cards.design(w.db, office, w.schoolA, 'STUDENT');
    expect(d.design).toMatchObject({ orientation: 'PORTRAIT', size: 'CR80' });
    const one = await cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', ids: [a.studentId, b.studentId], layout: 'CARD_PRINTER', sides: 'BOTH' });
    expect((await pages(one.pdf)).map((s) => [mm(s.width), mm(s.height)])).toEqual([[54, 85.6], [54, 85.6], [54, 85.6], [54, 85.6]]);
    const sheet = await cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', sectionIds: [w.sectionsA.X[0]], layout: 'A4', sides: 'BOTH' });
    expect((await pages(sheet.pdf)).length).toBe(2);                 // a front sheet and a back sheet
    await cards.saveDesign(w.db, office, w.schoolA, 'STUDENT', { ...d.design, size: 'CR79', orientation: 'LANDSCAPE' }, 0);
    const cr79 = await cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', ids: [a.studentId], layout: 'CARD_PRINTER', sides: 'FRONT' });
    expect((await pages(cr79.pdf)).map((s) => [mm(s.width), mm(s.height)])).toEqual([[84, 52]]);
    const tray = await printing.addLabelSheet(w.db, office, w.schoolA, { name: 'Inkjet PVC tray (2 cards)', page_w: 100, page_h: 130, cols: 1, rows: 2, label_w: 84, label_h: 52, margin_left: 8, margin_top: 10, gap_x: 0, gap_y: 6 });
    const onTray = await cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', ids: [a.studentId, b.studentId], layout: 'SHEET', sheetId: tray.id, sides: 'FRONT' });
    expect((await pages(onTray.pdf)).map((s) => [mm(s.width), mm(s.height)])).toEqual([[100, 130]]);
    const wrong = await printing.addLabelSheet(w.db, office, w.schoolA, { name: 'CR80 sheet', page_w: 210, page_h: 297, cols: 2, rows: 5, label_w: 85.6, label_h: 54, margin_left: 15, margin_top: 10, gap_x: 8, gap_y: 2 });
    await rejects(cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', ids: [a.studentId], layout: 'SHEET', sheetId: wrong.id, sides: 'FRONT' }), /holds 85.6 × 54 mm cards, but this design is 84 × 52/);
    await rejects(cards.saveDesign(w.db, office, w.schoolA, 'STUDENT', { ...d.design, size: 'CUSTOM' }, 1), /need attention/);
  });

  it('knows who has a card for this academic year, so new admissions can be printed on their own', async () => {
    const before = await cards.status(w.db, office, w.schoolA, 'STUDENT');
    expect(before.year).toBe('2026-27');
    expect(before.validUntil).toBe('2027-03-31');
    const late = await family(w, { classCode: 'X', section: 0 });           // joins mid-year
    const after = await cards.status(w.db, office, w.schoolA, 'STUDENT');
    expect(after.without.map((p) => p.id)).toContain(late.studentId);
    const r = await cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', sectionIds: [w.sectionsA.X[0]], layout: 'CARD_PRINTER', sides: 'FRONT', onlyWithoutCard: true });
    expect(r.count).toBe(after.without.filter((p) => p.detail.startsWith('X-A')).length);
    await rejects(cards.pdf(w.db, office, w.schoolA, { kind: 'STUDENT', ids: [late.studentId], layout: 'CARD_PRINTER', sides: 'FRONT', onlyWithoutCard: true }), /already has a card for 2026-27/);
  });

  it('imports staff details and prints staff cards with their staff number barcode', async () => {
    await rejects(cards.pdf(w.db, office, w.schoolA, { kind: 'STAFF', ids: [w.teacherA.id], layout: 'CARD_PRINTER', sides: 'FRONT' }), /Add staff numbers first/);
    await rejects(printing.importStaff(w.db, office, w.schoolA, 'Employee No,Name\nE1,X'), /principal/);
    const r = await printing.importStaff(w.db, w.principalA, w.schoolA, 'Employee No,Name,Designation,Mobile,Blood Group,Date of Joining\nT-101,Teacher Alpha,TGT Mathematics,98200 11111,B+ve,01/06/2015\nT-205,New Person,PRT,9820022222,O+,2020-06-01');
    expect(r).toEqual({ added: 1, updated: 1 });
    const p = await cards.pdf(w.db, office, w.schoolA, { kind: 'STAFF', ids: [w.teacherA.id], layout: 'CARD_PRINTER', sides: 'FRONT' });
    expect(p.count).toBe(1);
    const libraryCard = await library.borrower(w.db, librarian, w.schoolA, 'ST-T-101');
    expect(libraryCard).toMatchObject({ kind: 'STAFF', name: 'Teacher Alpha' });
  });
});

describe('certificates', () => {
  it('makes the consolidated CEA certificate with every NES school attended that year', async () => {
    const c = await family(w, { classCode: 'X', section: 1 });
    await w.db.query(`update enrolment set roll_no = 17 where id = $1`, [c.enrolmentId]);
    await movedEarlier(w, c.studentId, w.campusB, '2026-08-01', 'Father posted to Visakhapatnam');
    const r = await certificates.prepare(w.db, office, { studentId: c.studentId, kind: 'CEA' }).catch((e) => e);
    // The child is now at school B: school A's office cannot prepare it.
    expect(String(r)).toMatch(/outside your access/);
    const principalB = await loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ('Principal Bravo', 'SCHOOL_ADMIN', 'Principal', 'nes.enc.ncs_b') returning id`)).id);
    const d = await certificates.prepare(w.db, principalB, { studentId: c.studentId, kind: 'CEA' });
    expect(d.data).toMatchObject({ prefix: 'Kumari', relationWord: 'Daughter', yearFrom: '01/04/2026', yearTo: '31/03/2027',
      s1School: 'NCS Alpha', s1From: 'Apr 2026', s1To: 'Jul 2026', s1Class: 'X B', s1Roll: '17', s2School: 'NCS Bravo', s2From: 'Aug 2026', s2To: 'Mar 2027' });
    const issued = await certificates.submit(w.db, principalB, d.id);        // the principal's own submission issues it
    expect(issued).toMatchObject({ status: 'ISSUED', serial: 'CEA/2026-27/0001' });
    const pdf = await certificates.pdf(w.db, principalB, d.id, { publicUrl: 'https://erp.nes.test' });
    expect((await pages(pdf)).length).toBe(1);
  });

  it('goes from parent request to office draft to principal approval, with QR verification and cancellation', async () => {
    const req = await certificates.request(w.db, a.parent, { studentId: a.studentId, kind: 'BONAFIDE', purpose: 'Passport application' });
    await rejects(certificates.request(w.db, a.parent, { studentId: a.studentId, kind: 'BONAFIDE', purpose: 'Again' }), /already been requested/);
    const draft = await certificates.prepare(w.db, office, { requestId: req.id });
    expect(draft.data).toMatchObject({ purpose: 'Passport application', className: 'X-A' });
    await certificates.update(w.db, office, req.id, { data: { purpose: 'passport application at the Regional Passport Office' } });
    expect(await certificates.submit(w.db, office, req.id)).toMatchObject({ status: 'PENDING', steps: ['Principal'] });
    await rejects(certificates.pdf(w.db, a.parent, req.id, { publicUrl: 'x' }), /not been issued/);
    const item = (await approvals.inbox(w.db, w.principalA)).find((i) => i.kind === 'certificate')!;
    await approvals.decide(w.db, w.principalA, item.id, true);
    const one = await certificates.one(w.db, a.parent, req.id) as unknown as { status: string; serial_no: string; verify_code: string };
    expect(one).toMatchObject({ status: 'ISSUED', serial_no: 'BC/2026-27/0001' });
    expect(await certificates.verify(w.db, one.verify_code)).toMatchObject({ valid: true, title: 'Bonafide Certificate', student: 'Child Test' });
    expect((await pages(await certificates.pdf(w.db, a.parent, req.id, { publicUrl: 'https://erp.nes.test' }))).length).toBe(1);
    await rejects(w.db.query(`update certificate set data = '{}' where id = $1`, [req.id]), /cannot be changed/);
    await rejects(certificates.cancel(w.db, office, req.id, 'Wrong class'), /Only the principal/);
    await certificates.cancel(w.db, w.principalA, req.id, 'Issued with the wrong class');
    expect(await certificates.verify(w.db, one.verify_code)).toMatchObject({ valid: false, status: 'CANCELLED', cancelReason: 'Issued with the wrong class' });
  });

  it('holds a transfer certificate until fees are paid and books returned, then ends the enrolment', async () => {
    const t = await certificates.prepare(w.db, office, { studentId: a.studentId, kind: 'TC', leavingDate: today, reason: 'Father posted to Kochi' });
    expect(t.data).toMatchObject({ name: 'Child Test', lastClass: 'X (Ten)', promotion: 'Yes, to Class XI', reason: 'Father posted to Kochi' });
    // Library fine (₹5) and the lost book (₹350) are still due.
    await rejects(certificates.submit(w.db, office, t.id), /Rs\. 355\.00 of fees is still due/);
    await settings.set(w.db, w.principalA, w.schoolA, { key: 'certificates.tc_needs_no_dues', value: false, from: today });
    expect(await certificates.submit(w.db, office, t.id)).toMatchObject({ status: 'PENDING', steps: ['Class teacher', 'Principal'] });
    await approvals.decide(w.db, w.teacherA, (await approvals.inbox(w.db, w.teacherA)).find((i) => i.kind === 'certificate_tc')!.id, true);
    await approvals.decide(w.db, w.principalA, (await approvals.inbox(w.db, w.principalA)).find((i) => i.kind === 'certificate_tc')!.id, true);
    const e = await w.db.one<{ status: string; open: boolean }>('select status, upper_inf(period) as open from enrolment where id = $1', [a.enrolmentId]);
    expect(e).toEqual({ status: 'WITHDRAWN', open: false });
  });

  it('prepares, issues and prints CEA certificates for a whole class in one go', async () => {
    const r = await certificates.prepareBulk(w.db, office, w.schoolA, { kind: 'CEA', sectionIds: [w.sectionsA.X[0]] });
    expect(r.prepared).toBeGreaterThan(0);
    const again = await certificates.prepareBulk(w.db, office, w.schoolA, { kind: 'CEA', sectionIds: [w.sectionsA.X[0]] });
    expect(again.prepared).toBe(0);
    const ids = (await certificates.list(w.db, office, w.schoolA, 'DRAFT') as { id: string; kind: string }[]).filter((c) => c.kind === 'CEA').map((c) => c.id);
    await rejects(certificates.issueBulk(w.db, office, w.schoolA, ids), /Only the principal/);
    const issued = await certificates.issueBulk(w.db, w.principalA, w.schoolA, ids);
    expect(issued.issued).toBe(ids.length);
    const out = await certificates.pdfBulk(w.db, office, w.schoolA, ids, { publicUrl: 'https://erp.nes.test' });
    expect((await pages(out.pdf)).length).toBe(ids.length);
    void YEAR;
  });
});
