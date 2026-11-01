import type { Db } from '../db/client.js';
import { nesEmblem, schoolEmblem } from '../lib/brand.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { newDocument, Sheet, type Calibration, NO_CALIBRATION, BLACK } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import * as staff from './staff.js';
import { localToday } from '../lib/dates.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, can } from './access.js';

/**
 * Printers, stationery and the images printed on things.
 *
 * A school records each printer it uses (the office laser, the library label printer, the card
 * printer) with a calibration: how far right and down everything must move, and a small scale
 * correction. It prints the calibration page once, measures two lines with a ruler, and enters
 * the difference. Every later PDF for that printer carries the correction.
 */

const imageType = (buf: Buffer) => {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
};

export function decodeImage(dataBase64: string, maxMb = 1) {
  const buf = Buffer.from(dataBase64, 'base64');
  if (!buf.length) throw invalid('The file is empty.');
  if (buf.length > maxMb * 1024 * 1024) throw invalid(`Images must be ${maxMb} MB or smaller. Reduce the size and try again.`);
  const type = imageType(buf);
  if (!type) throw invalid('Only JPEG or PNG images can be printed.');
  return { buf, type };
}

// ── Printers ─────────────────────────────────────────────────────────────────────────────

export interface PrinterInput { name: string; purpose: 'LABELS' | 'CARDS' | 'DOCUMENTS'; offsetX?: number; offsetY?: number; scale?: number; notes?: string }

export async function printers(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select id, name, purpose, offset_x_mm::float as "offsetX", offset_y_mm::float as "offsetY", scale_pct::float as scale, notes, version, updated_at
       from printer_profile where school_id = $1 and active order by purpose, name`, [schoolId]);
}

export async function savePrinter(db: Db, actor: Actor, schoolId: string, input: PrinterInput & { id?: string; version?: number }) {
  await assertCan(db, actor, 'printers.manage', schoolId);
  const vals = [input.name.trim(), input.purpose, input.offsetX ?? 0, input.offsetY ?? 0, input.scale ?? 100, (input.notes ?? '').trim()];
  return db.tx(async (t) => {
    if (input.id) {
      const r = await t.maybeOne<{ id: string }>(
        `update printer_profile set name = $3, purpose = $4, offset_x_mm = $5, offset_y_mm = $6, scale_pct = $7, notes = $8
          where id = $1 and school_id = $2 and ($9::int is null or version = $9) returning id`, [input.id, schoolId, ...vals, input.version ?? null]);
      if (!r) throw invalid('Someone else changed this printer meanwhile. Reload and try again.');
      return { id: r.id };
    }
    return t.one<{ id: string }>(`insert into printer_profile (school_id, name, purpose, offset_x_mm, offset_y_mm, scale_pct, notes) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [schoolId, ...vals]);
  }, { actor: actor.label });
}

export async function removePrinter(db: Db, actor: Actor, id: string) {
  const p = await db.maybeOne<{ school_id: string }>('select school_id from printer_profile where id = $1', [id]);
  if (!p) throw notFound('Printer');
  await assertCan(db, actor, 'printers.manage', p.school_id);
  await db.tx((t) => t.query('update printer_profile set active = false where id = $1', [id]), { actor: actor.label });
  return { removed: true };
}

/** The calibration to apply for a print: the chosen printer's, or none. */
export async function calibration(db: Db, schoolId: string, printerId?: string | null): Promise<Calibration> {
  if (!printerId) return NO_CALIBRATION;
  const p = await db.maybeOne<{ x: number; y: number; s: number }>(
    'select offset_x_mm::float as x, offset_y_mm::float as y, scale_pct::float as s from printer_profile where id = $1 and school_id = $2 and active', [printerId, schoolId]);
  if (!p) throw notFound('Printer');
  return { offsetX: p.x, offsetY: p.y, scale: p.s };
}

export async function log(t: Db, actor: Actor, schoolId: string, kind: string, items: number, detail: Record<string, unknown>, printerId?: string | null) {
  await t.query(`insert into print_log (school_id, kind, items, detail, printer_id, printed_by) values ($1, $2, $3, $4, $5, $6)`,
    [schoolId, kind, items, JSON.stringify(detail), printerId ?? null, actor.id]);
}

/**
 * The calibration page for a printer. Lines are drawn at known distances from the paper's edges
 * with the printer's current correction applied. If a line measures off, the difference goes into
 * the printer's offsets; if the 150 mm line measures short or long, into its scale.
 */
export async function calibrationPdf(db: Db, actor: Actor, schoolId: string, printerId: string, paper: 'A4' | 'CARD' | 'LABEL', labelSheetId?: string | null) {
  await assertCan(db, actor, 'printers.manage', schoolId);
  const cal = await calibration(db, schoolId, printerId);
  const p = await db.one<{ name: string }>('select name from printer_profile where id = $1', [printerId]);
  const { doc, fonts } = await newDocument(`Calibration — ${p.name}`);
  if (paper === 'CARD') {
    const s = new Sheet(doc, 85.6, 54, fonts, cal);
    s.rect(2, 2, 81.6, 50, { stroke: BLACK, width: 0.3 });
    s.line(10, 0, 10, 54, { width: 0.2 }); s.line(0, 10, 85.6, 10, { width: 0.2 });
    s.text('Card calibration', 14, 13, { size: 8, font: fonts.bold });
    s.paragraph('The frame should sit 2 mm inside every edge. The thin lines should be 10 mm from the left and top edges.', 14, 18, 66, { size: 6 });
    s.text(`Now: right ${cal.offsetX} mm, down ${cal.offsetY} mm, scale ${cal.scale}%`, 14, 44, { size: 5.5 });
  } else if (paper === 'LABEL') {
    const sh = labelSheetId ? await db.maybeOne<LabelSheet>(`select ${SHEET_COLS} from label_sheet where id = $1`, [labelSheetId]) : null;
    if (!sh) throw invalid('Choose the label sheet to calibrate.');
    const s = new Sheet(doc, sh.page_w, sh.page_h, fonts, cal);
    for (let r = 0; r < sh.rows; r++) for (let col = 0; col < sh.cols; col++) {
      const x = sh.margin_left + col * (sh.label_w + sh.gap_x), y = sh.margin_top + r * (sh.label_h + sh.gap_y);
      s.rect(x + 1, y + 1, sh.label_w - 2, sh.label_h - 2, { stroke: BLACK, width: 0.2 });
      if (r === 0 && col === 0) s.text('1 mm inside each label', x + 2, y + 2, { size: 5, maxWidth: sh.label_w - 4 });
    }
  } else {
    const s = new Sheet(doc, 210, 297, fonts, cal);
    s.text('Printer calibration page', 30, 30, { size: 16, font: fonts.bold });
    s.paragraph(`Printer: ${p.name}. Print this page at Actual size (100%), not Fit to page. Measure with a ruler from the edge of the paper:`, 30, 40, 150, { size: 10 });
    const steps = [
      'The vertical line on the left should be exactly 20 mm from the left edge. If it is 22 mm, enter -2 for "Move right". If it is 18 mm, enter +2.',
      'The horizontal line at the top should be exactly 20 mm from the top edge. If it is 21 mm, enter -1 for "Move down".',
      'The long horizontal line should be exactly 150 mm long. If it is 148.5 mm, enter 101 for "Scale %" (150 ÷ 148.5 × 100, rounded).',
      'Save, print again, and check. Every label, card and certificate for this printer will use the correction.',
    ];
    let y = 55;
    steps.forEach((t, i) => { y += s.paragraph(`${i + 1}. ${t}`, 30, y, 150, { size: 9.5 }) + 2; });
    s.line(20, 0, 20, 297, { width: 0.3 }); s.line(0, 20, 210, 20, { width: 0.3 });
    s.line(30, 150, 180, 150, { width: 0.4 });
    for (let mm = 0; mm <= 150; mm += 10) { s.line(30 + mm, 147, 30 + mm, 153, { width: 0.25 }); s.text(String(mm), 30 + mm - 2, 155, { size: 6 }); }
    s.text('150 mm', 95, 142, { size: 8 });
    s.rect(30, 180, 85.6, 54, { stroke: BLACK, width: 0.3 });
    s.text('A credit-card size box (85.6 × 54 mm)', 33, 183, { size: 8 });
    s.text(`Correction now: move right ${cal.offsetX} mm, move down ${cal.offsetY} mm, scale ${cal.scale}%`, 30, 250, { size: 9, font: fonts.bold });
  }
  await log(db, actor, schoolId, 'CALIBRATION', 1, { paper }, printerId);
  return Buffer.from(await doc.save());
}

// ── Label sheets ─────────────────────────────────────────────────────────────────────────

export interface LabelSheet { id: string; name: string; page_w: number; page_h: number; cols: number; rows: number; label_w: number; label_h: number; margin_left: number; margin_top: number; gap_x: number; gap_y: number }
export const SHEET_COLS = `id, name, page_w::float, page_h::float, cols, rows, label_w::float, label_h::float, margin_left::float, margin_top::float, gap_x::float, gap_y::float`;

export async function labelSheets(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query<LabelSheet & { own: boolean }>(`select ${SHEET_COLS}, school_id is not null as own from label_sheet where school_id is null or school_id = $1 order by school_id nulls first, name`, [schoolId]);
}

export async function addLabelSheet(db: Db, actor: Actor, schoolId: string, s: Omit<LabelSheet, 'id'>) {
  await assertCan(db, actor, 'printers.manage', schoolId);
  return db.tx((t) => t.one<{ id: string }>(
    `insert into label_sheet (school_id, name, page_w, page_h, cols, rows, label_w, label_h, margin_left, margin_top, gap_x, gap_y)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [schoolId, s.name.trim(), s.page_w, s.page_h, s.cols, s.rows, s.label_w, s.label_h, s.margin_left, s.margin_top, s.gap_x, s.gap_y]), { actor: actor.label });
}

// ── School images: logo, signature, stamp ────────────────────────────────────────────────

export async function setAsset(db: Db, actor: Actor, schoolId: string, kind: 'LOGO' | 'SIGNATURE' | 'STAMP' | 'HPC_COVER', dataBase64: string) {
  if (kind === 'SIGNATURE' || kind === 'STAMP') { if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Only the principal can upload the signature and the school stamp.'); }
  await assertCan(db, actor, kind === 'LOGO' || kind === 'HPC_COVER' ? 'printers.manage' : 'certificates.prepare', schoolId);
  const { buf, type } = decodeImage(dataBase64);
  await db.tx((t) => t.query(
    `insert into print_asset (school_id, kind, content_type, data, uploaded_by) values ($1, $2, $3, $4, $5)
     on conflict (school_id, kind) do update set content_type = excluded.content_type, data = excluded.data, uploaded_by = excluded.uploaded_by, uploaded_at = now()`,
    [schoolId, kind, type, buf, actor.id]), { actor: actor.label });
  return { kind, contentType: type };
}

/**
 * A school's images for printing: its logo (uploaded, or the official emblem of its kind of
 * school), the NES emblem (NES may upload a newer one), the principal's signature and the stamp.
 */
export async function assets(db: Db, schoolId: string) {
  const rows = await db.query<{ kind: string; content_type: string; data: Buffer }>('select kind, content_type, data from print_asset where school_id = $1', [schoolId]);
  const own = Object.fromEntries(rows.map((r) => [r.kind, { type: r.content_type, data: r.data }])) as Record<string, { type: string; data: Buffer } | undefined>;
  const u = await db.one<{ school_type: string | null }>('select school_type from org_unit where id = $1', [schoolId]);
  const nes = await db.maybeOne<{ content_type: string; data: Buffer }>(
    `select a.content_type, a.data from print_asset a join org_unit o on o.id = a.school_id where o.kind = 'society' and a.kind = 'LOGO' limit 1`);
  return { ...own, LOGO: own.LOGO ?? schoolEmblem(u.school_type), NES: nes ? { type: nes.content_type, data: nes.data } : nesEmblem() } as Record<string, { type: string; data: Buffer } | undefined>;
}

/** The logo a school's website shows: the uploaded one, or the official emblem. Public. */
export async function publicLogo(db: Db, slug: string) {
  const s = await db.maybeOne<{ school_id: string }>('select school_id from site where slug = $1', [slug]);
  if (!s) throw notFound('Website');
  return (await assets(db, s.school_id)).LOGO!;
}

export async function assetList(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(`select a.kind, a.uploaded_at, u.name as uploaded_by from print_asset a join app_user u on u.id = a.uploaded_by where a.school_id = $1`, [schoolId]);
}

export async function assetFile(db: Db, actor: Actor, schoolId: string, kind: string) {
  await assertUnitInScope(db, actor, schoolId);
  const a = await db.maybeOne<{ content_type: string; data: Buffer }>('select content_type, data from print_asset where school_id = $1 and kind = $2', [schoolId, kind]);
  if (!a) throw notFound('Image');
  return a;
}

// ── Photos ───────────────────────────────────────────────────────────────────────────────

/** Office staff, or the class teacher for children in their own class. */
async function canPhotograph(db: Db, actor: Actor, kind: 'STUDENT' | 'STAFF', ownerId: string) {
  if (kind === 'STAFF') {
    const s = await db.maybeOne<{ school_id: string }>(`select o.id as school_id from app_user u join org_unit o on o.kind = 'school' and u.scope_path <@ o.path where u.id = $1 limit 1`, [ownerId]);
    if (!s) throw notFound('Staff member');
    await assertCan(db, actor, 'cards.print', s.school_id);
    return s.school_id;
  }
  const e = await db.maybeOne<{ school_id: string; section_id: string | null }>(
    `select school_id, section_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [ownerId]);
  if (!e) throw notFound('Current enrolment');
  if (await can(db, actor, 'cards.print', e.school_id)) return e.school_id;
  const ct = e.section_id && await db.maybeOne(`select 1 from class_teacher where section_id = $1 and user_id = $2 and valid @> current_date`, [e.section_id, actor.id]);
  if (!ct) throw forbidden('Photos are uploaded by the office, or by the class teacher for their own class.');
  return e.school_id;
}

export async function setPhoto(db: Db, actor: Actor, kind: 'STUDENT' | 'STAFF', ownerId: string, dataBase64: string) {
  await canPhotograph(db, actor, kind, ownerId);
  const { buf, type } = decodeImage(dataBase64);
  await db.tx((t) => t.query(
    `insert into person_photo (owner_kind, owner_id, content_type, data, uploaded_by) values ($1, $2, $3, $4, $5)
     on conflict (owner_kind, owner_id) do update set content_type = excluded.content_type, data = excluded.data, uploaded_by = excluded.uploaded_by, uploaded_at = now()`,
    [kind, ownerId, type, buf, actor.id]), { actor: actor.label });
  return { ok: true };
}

/**
 * Many photos at once, matched by file name: the admission number (students) or employee number
 * (staff), for example "NCS-MB_2026_0138.jpg". Returns what matched and what did not.
 */
export async function bulkPhotos(db: Db, actor: Actor, schoolId: string, kind: 'STUDENT' | 'STAFF', files: { name: string; dataBase64: string }[]) {
  await assertCan(db, actor, 'cards.print', schoolId);
  const done: string[] = []; const unmatched: string[] = []; const failed: { name: string; reason: string }[] = [];
  for (const f of files) {
    const key = f.name.replace(/\.[^.]+$/, '').trim();
    const variants = [key, key.replace(/_/g, '/'), key.replace(/_/g, '-')];
    const owner = kind === 'STUDENT'
      ? await db.maybeOne<{ id: string }>(`select student_id as id from enrolment where school_id = $1 and admission_no = any($2) and status in ('ACTIVE', 'PROVISIONAL') limit 1`, [schoolId, variants])
      : await db.maybeOne<{ id: string }>(`select user_id as id from staff_profile where school_id = $1 and employee_no = any($2) limit 1`, [schoolId, variants]);
    if (!owner) { unmatched.push(f.name); continue; }
    try { await setPhoto(db, actor, kind, owner.id, f.dataBase64); done.push(f.name); } catch (e) { failed.push({ name: f.name, reason: (e as Error).message }); }
  }
  return { saved: done.length, unmatched, failed };
}

export async function photo(db: Db, actor: Actor, kind: 'STUDENT' | 'STAFF', ownerId: string) {
  if (!actor.scopePath && actor.role !== 'PARENT') throw forbidden();
  if (actor.role === 'PARENT') {
    if (kind !== 'STUDENT' || !(await db.maybeOne('select 1 from student_guardian where student_id = $1 and guardian_id = $2', [ownerId, actor.guardianId]))) throw forbidden();
  }
  const p = await db.maybeOne<{ content_type: string; data: Buffer }>('select content_type, data from person_photo where owner_kind = $1 and owner_id = $2', [kind, ownerId]);
  if (!p) throw notFound('Photo');
  return p;
}

// ── Staff details (for staff cards) ──────────────────────────────────────────────────────

export async function staffList(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'cards.print', schoolId);
  return db.query(
    `select u.id, u.name, u.designation, u.role, p.employee_no, p.blood_group, p.phone, p.dob::text, p.joined_on::text, p.emergency_contact, p.version,
            exists (select 1 from person_photo f where f.owner_kind = 'STAFF' and f.owner_id = u.id) as has_photo
       from employee e join app_user u on u.id = e.user_id join staff_profile p on p.user_id = u.id
      where e.school_id = $1 and u.active order by u.name`, [schoolId]);
}

export async function saveStaff(db: Db, actor: Actor, schoolId: string, userId: string, input: { employeeNo: string; bloodGroup?: string | null; phone?: string | null; dob?: string | null; joinedOn?: string | null; emergencyContact?: string | null }) {
  await assertCan(db, actor, 'cards.print', schoolId);
  // The card shows the staff record; corrections made here are made to that record.
  const e = await db.maybeOne('select 1 from employee where user_id = $1 and school_id = $2', [userId, schoolId]);
  if (!e) throw invalid('Add this person on the Staff screen first; the ID card is made from their staff record.');
  await staff.updateDetails(db, actor, userId, { employeeNo: input.employeeNo, bloodGroup: input.bloodGroup ?? null, phone: input.phone ?? null, dob: input.dob ?? null, emergencyContact: input.emergencyContact ?? null });
  return { ok: true };
}

/** The school's printed identity: name, campus address, affiliation number, contact. */
export async function schoolHeader(db: Db, schoolId: string) {
  const s = await db.one<{ name: string; code: string; affiliation_no: string | null; udise: string | null; address: string | null; school_no: string | null; website: string | null;
    own_phone: string | null; own_email: string | null; city: string | null; board: string }>(
    `select o.name, o.code, o.affiliation_no, o.udise_code as udise, o.school_no, o.website, o.phone as own_phone, o.email as own_email, o.city, o.board,
            coalesce(o.address, (select c.address from org_unit c where c.parent_id = o.id and c.kind = 'campus' and c.active order by c.code limit 1)) as address
       from org_unit o where o.id = $1`, [schoolId]);
  const site = await db.maybeOne<{ phone: string | null; email: string | null }>(
    `select r.content->'settings'->>'phone' as phone, r.content->'settings'->>'email' as email from site s join site_release r on r.school_id = s.school_id
      where s.school_id = $1 order by r.version desc limit 1`, [schoolId]).catch(() => null);
  void site;
  return { ...s, phone: s.own_phone, email: s.own_email };
}

/**
 * Staff details from the old ERP or a spreadsheet: staff number, name, designation, phone,
 * blood group, date of birth, date of joining. Matched to existing staff by staff number, then
 * by exact name; anyone else is added as a teacher of the school. All or nothing.
 */
export async function importStaff(db: Db, actor: Actor, schoolId: string, csv: string) {
  await assertCan(db, actor, 'cards.print', schoolId);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Staff are added by the principal.');
  const { parseCsv } = await import('./dataio.js');
  const rows = parseCsv(csv).filter((r) => r.some((x) => x.trim()));
  if (rows.length < 2) throw invalid('The file has no rows.');
  const h = rows[0].map((x) => x.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim());
  const col = (names: string[]) => h.findIndex((x) => names.includes(x));
  const iNo = col(['employee no', 'staff no', 'emp no', 'employee code', 'staff id', 'emp id', 'employee id']);
  const iName = col(['name', 'staff name', 'employee name', 'teacher name']);
  if (iNo < 0 || iName < 0) throw invalid('The file needs a staff number column and a name column.');
  const iDes = col(['designation', 'post', 'role']), iPhone = col(['phone', 'mobile', 'mobile no', 'contact']), iBg = col(['blood group', 'blood']);
  const iDob = col(['dob', 'date of birth', 'birth date']), iJoin = col(['doj', 'date of joining', 'joining date', 'joined on']);
  const date = (v: string | undefined) => {
    const t = (v ?? '').trim(); if (!t) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return 'bad';
  };
  const school = await db.one<{ path: string }>('select path::text from org_unit where id = $1', [schoolId]);
  const errors: { line: number; message: string }[] = [];
  const plan = rows.slice(1).map((r, i) => {
    const line = i + 2, no = (r[iNo] ?? '').trim(), name = (r[iName] ?? '').trim();
    const phone = iPhone >= 0 ? (r[iPhone] ?? '').replace(/\D/g, '').slice(-10) : '';
    const bg = iBg >= 0 ? (r[iBg] ?? '').toUpperCase().replace(/\s|VE$/g, '').replace('POS', '+').replace('NEG', '-') : '';
    const dob = date(iDob >= 0 ? r[iDob] : ''), joined = date(iJoin >= 0 ? r[iJoin] : '');
    if (!no) errors.push({ line, message: 'Staff number is empty' });
    if (name.length < 2) errors.push({ line, message: 'Name is empty' });
    if (phone && !/^[6-9]\d{9}$/.test(phone)) errors.push({ line, message: `Phone "${r[iPhone]}" is not a 10-digit mobile number` });
    if (bg && !['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(bg)) errors.push({ line, message: `Blood group "${r[iBg]}" is not recognised` });
    if (dob === 'bad' || joined === 'bad') errors.push({ line, message: 'A date was not understood (use DD/MM/YYYY)' });
    return { line, no, name, designation: iDes >= 0 ? (r[iDes] ?? '').trim() : '', phone: phone ? `+91${phone}` : null, bg: bg || null, dob: dob === 'bad' ? null : dob, joined: joined === 'bad' ? null : joined };
  });
  const dup = new Map<string, number>();
  for (const p of plan) { if (dup.has(p.no.toUpperCase())) errors.push({ line: p.line, message: `Staff number ${p.no} also appears on line ${dup.get(p.no.toUpperCase())}` }); dup.set(p.no.toUpperCase(), p.line); }
  if (errors.length) throw invalid(`${errors.length} row${errors.length === 1 ? ' has' : 's have'} problems, so nothing was imported.`, errors.slice(0, 50));
  // Each row becomes (or updates) the person's one staff record; nothing is kept separately for the ID card.
  return db.tx(async (t) => {
    let added = 0, updated = 0;
    for (const p of plan) {
      const known = await t.maybeOne<{ id: string }>(`select user_id as id from employee where school_id = $1 and (upper(employee_no) = upper($2) or nes_staff_id = upper($2))`, [schoolId, p.no])
        ?? await t.maybeOne<{ id: string }>(`select e.user_id as id from employee e join app_user u on u.id = e.user_id where e.school_id = $1 and lower(u.name) = lower($2) limit 1`, [schoolId, p.name]);
      if (known) {
        await staff.updateDetails(t, actor, known.id, { employeeNo: p.no, ...(p.phone ? { phone: p.phone } : {}), ...(p.bg ? { bloodGroup: p.bg } : {}), ...(p.dob ? { dob: p.dob } : {}), ...(p.designation ? { title: p.designation } : {}) });
        updated++; continue;
      }
      const user = await t.maybeOne<{ id: string }>(`select u.id from app_user u where u.role not in ('PARENT', 'NES_ADMIN', 'COMMAND_OFFICER') and u.scope_path <@ $1::ltree and lower(u.name) = lower($2) limit 1`, [school.path, p.name]);
      await staff.enrol(t, actor, schoolId, { userId: user?.id, name: p.name, title: p.designation || undefined, category: /teach|tgt|pgt|prt|principal|librarian|counsel|pti|educator/i.test(p.designation) || !p.designation ? 'TEACHING' : 'NON_TEACHING',
        employment: 'PERMANENT', joinedService: p.joined ?? localToday(), orderRef: 'Brought over from the previous ERP', phone: p.phone, dob: p.dob, bloodGroup: p.bg, employeeNo: p.no });
      if (user) updated++; else added++;
    }
    return { added, updated };
  }, { actor: actor.label });
}
