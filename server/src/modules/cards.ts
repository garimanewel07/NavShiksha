import { z } from 'zod';
import type { Db } from '../db/client.js';
import { invalid } from '../lib/errors.js';
import { embedImage, fmtDate, hex, newDocument, Sheet } from '../lib/pdf.js';
import type { PDFImage } from 'pdf-lib';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan } from './access.js';
import * as printing from './printing.js';

/**
 * Student and staff ID cards. Each school designs its cards once (colours, what is shown, the
 * back) and prints them for a class, a section or chosen people:
 *  - on a card printer (one CR80 card per page, 85.6 × 54 mm), or
 *  - on A4 sheets with crop marks (10 landscape or 9 portrait cards a sheet); the back pages are
 *    mirrored so double-sided printing (flip on the long edge) puts each back behind its front.
 * The card's barcode carries the NES ID (students) or staff number, which the library desk and
 * the gate scan.
 */

const SHOW = ['photo', 'class', 'admissionNo', 'dob', 'bloodGroup', 'house', 'parent', 'phone', 'barcode'] as const;
export const designSchema = z.object({
  orientation: z.enum(['PORTRAIT', 'LANDSCAPE']),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  heading: z.string().trim().min(2).max(80),
  subheading: z.string().trim().max(120),
  show: z.object(Object.fromEntries(SHOW.map((k) => [k, z.boolean()])) as Record<(typeof SHOW)[number], z.ZodBoolean>),
  // AUTO: the last day of the academic year the cards are printed for, so a new year needs no edit.
  validUntil: z.union([z.literal('AUTO'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  backLines: z.array(z.string().trim().max(120)).max(6),
  signatureLabel: z.string().trim().max(40),
  // Card stock. CR80 is the standard plastic (PVC) ID card; CR79 suits adhesive-backed cards.
  size: z.enum(['CR80', 'CR79', 'CUSTOM']).default('CR80'),
  customW: z.number().min(50).max(140).optional(),           // long side, mm
  customH: z.number().min(30).max(100).optional(),           // short side, mm
}).refine((d) => d.size !== 'CUSTOM' || (d.customW && d.customH && d.customW > d.customH), 'For a custom size give the long and short sides in millimetres.');
export type CardDesign = z.infer<typeof designSchema>;

const CR80 = { w: 85.6, h: 54 };
/** The card's real size (long side × short side, mm). Layouts are drawn for CR80 and scaled to fit. */
export function cardSize(d: CardDesign) {
  if (d.size === 'CR79') return { w: 84, h: 52 };
  if (d.size === 'CUSTOM' && d.customW && d.customH) return { w: d.customW, h: d.customH };
  return { w: 85.6, h: 54 };
}

async function defaults(db: Db, schoolId: string, kind: 'STUDENT' | 'STAFF'): Promise<CardDesign> {
  const h = await printing.schoolHeader(db, schoolId);
  return {
    orientation: kind === 'STUDENT' ? 'PORTRAIT' : 'LANDSCAPE', colour: '#0B2E59', textColour: '#FFFFFF',
    heading: h.name, subheading: [h.address, h.affiliation_no ? `CBSE Affiliation ${h.affiliation_no}` : ''].filter(Boolean).join(' · ').slice(0, 120),
    show: { photo: true, class: true, admissionNo: true, dob: true, bloodGroup: true, house: kind === 'STUDENT', parent: kind === 'STUDENT', phone: true, barcode: true },
    validUntil: 'AUTO',
    backLines: [
      'This card is the property of the school and must be carried at all times.',
      `If found, please return to: ${h.name}${h.address ? `, ${h.address}` : ''}.`,
      h.phone ? `Phone: ${h.phone}` : '',
    ].filter(Boolean),
    signatureLabel: 'Principal',
    size: 'CR80',
  };
}

export async function design(db: Db, actor: Actor, schoolId: string, kind: 'STUDENT' | 'STAFF') {
  await assertUnitInScope(db, actor, schoolId);
  const r = await db.maybeOne<{ design: CardDesign; version: number }>('select design, version from card_design where school_id = $1 and kind = $2', [schoolId, kind]);
  return r ? { ...r, saved: true } : { design: await defaults(db, schoolId, kind), version: 0, saved: false };
}

export async function saveDesign(db: Db, actor: Actor, schoolId: string, kind: 'STUDENT' | 'STAFF', input: unknown, version: number) {
  await assertCan(db, actor, 'cards.print', schoolId);
  const d = designSchema.safeParse(input);
  if (!d.success) throw invalid('Some card settings need attention.', d.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return db.tx(async (t) => {
    if (version === 0) {
      await t.query(`insert into card_design (school_id, kind, design, updated_by) values ($1, $2, $3, $4)`, [schoolId, kind, JSON.stringify(d.data), actor.id]);
      return { version: 1 };
    }
    const r = await t.maybeOne<{ version: number }>(`update card_design set design = $3, updated_by = $4 where school_id = $1 and kind = $2 and version = $5 returning version`,
      [schoolId, kind, JSON.stringify(d.data), actor.id, version]);
    if (!r) throw invalid('Someone else saved this design meanwhile. Reload to see their changes.');
    return r;
  }, { actor: actor.label });
}

interface Person { id: string; name: string; line1: string; rows: [string, string][]; emergency: [string, string][]; code: string; photo: Buffer | null; photoType: string | null }

async function students(db: Db, schoolId: string, d: CardDesign, sectionIds: string[] | null, studentIds: string[] | null): Promise<Person[]> {
  const rows = await db.query<{ id: string; name: string; nes_id: string; admission_no: string; cls: string; dob: string; blood_group: string | null; house: string | null; parent: string | null; phone: string | null; photo: Buffer | null; type: string | null }>(
    `select s.id, s.name, s.nes_id, e.admission_no, e.class_code || coalesce('-' || sec.name, '') as cls, s.dob::text, s.blood_group, h.name as house,
            g.name as parent, g.phone, p.data as photo, p.content_type as type
       from enrolment e join student s on s.id = e.student_id left join section sec on sec.id = e.section_id left join house h on h.id = e.house_id
       left join lateral (select g.name, g.phone from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = s.id order by sg.is_primary desc limit 1) g on true
       left join person_photo p on p.owner_kind = 'STUDENT' and p.owner_id = s.id
       join class_level cl on cl.code = e.class_code
      where e.school_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
        and ($2::uuid[] is null or e.section_id = any($2)) and ($3::uuid[] is null or s.id = any($3))
      order by cl.ordinal, sec.name, s.name`, [schoolId, sectionIds, studentIds]);
  return rows.map((r) => ({
    id: r.id, name: r.name, line1: d.show.class ? `Class ${r.cls}` : '', code: r.nes_id, photo: r.photo, photoType: r.type,
    rows: ([
      d.show.admissionNo ? ['Adm. No', r.admission_no] : null,
      d.show.dob ? ['Date of birth', fmtDate(r.dob)] : null,
      d.show.bloodGroup ? ['Blood group', r.blood_group ?? ''] : null,
      d.show.house && r.house ? ['House', r.house] : null,
    ].filter(Boolean)) as [string, string][],
    emergency: ([
      d.show.parent && r.parent ? ['Parent / guardian', r.parent] : null,
      d.show.phone && r.phone ? ['Phone', r.phone.replace('+91', '')] : null,
    ].filter(Boolean)) as [string, string][],
  }));
}

async function staff(db: Db, schoolId: string, d: CardDesign, userIds: string[] | null): Promise<Person[]> {
  const rows = await db.query<{ id: string; name: string; designation: string | null; employee_no: string | null; blood_group: string | null; phone: string | null; dob: string | null; emergency_contact: string | null; photo: Buffer | null; type: string | null }>(
    `select u.id, u.name, u.designation, sp.employee_no, sp.blood_group, sp.phone, sp.dob::text, sp.emergency_contact, p.data as photo, p.content_type as type
       from app_user u join org_unit o on o.id = $1 left join staff_profile sp on sp.user_id = u.id
       left join person_photo p on p.owner_kind = 'STAFF' and p.owner_id = u.id
      where u.active and u.role <> 'PARENT' and u.scope_path <@ o.path and ($2::uuid[] is null or u.id = any($2)) order by u.name`, [schoolId, userIds]);
  const missing = rows.filter((r) => !r.employee_no);
  if (missing.length) throw invalid(`Add staff numbers first for: ${missing.slice(0, 5).map((m) => m.name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);
  return rows.map((r) => ({
    id: r.id, name: r.name, line1: r.designation ?? '', code: `ST-${r.employee_no}`, photo: r.photo, photoType: r.type,
    rows: ([
      ['Staff No', r.employee_no!],
      d.show.dob && r.dob ? ['Date of birth', fmtDate(r.dob)] : null,
      d.show.bloodGroup ? ['Blood group', r.blood_group ?? ''] : null,
      d.show.phone && r.phone ? ['Phone', r.phone.replace('+91', '')] : null,
    ].filter(Boolean)) as [string, string][],
    emergency: (r.emergency_contact ? [['Emergency contact', r.emergency_contact]] : []) as [string, string][],
  }));
}

/** People without a photo, so the office can collect them before printing. */
export async function missingPhotos(db: Db, actor: Actor, schoolId: string, kind: 'STUDENT' | 'STAFF', sectionIds?: string[] | null) {
  await assertCan(db, actor, 'cards.print', schoolId);
  if (kind === 'STAFF') {
    return db.query(`select u.id, u.name, coalesce(u.designation, '') as detail from app_user u join org_unit o on o.id = $1
      where u.active and u.role <> 'PARENT' and u.scope_path <@ o.path and not exists (select 1 from person_photo p where p.owner_kind = 'STAFF' and p.owner_id = u.id) order by u.name`, [schoolId]);
  }
  return db.query(`select s.id, s.name, e.class_code || coalesce('-' || sec.name, '') || ' · ' || e.admission_no as detail
      from enrolment e join student s on s.id = e.student_id left join section sec on sec.id = e.section_id join class_level cl on cl.code = e.class_code
     where e.school_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) and ($2::uuid[] is null or e.section_id = any($2))
       and not exists (select 1 from person_photo p where p.owner_kind = 'STUDENT' and p.owner_id = s.id) order by cl.ordinal, sec.name, s.name`, [schoolId, sectionIds?.length ? sectionIds : null]);
}

interface Assets { logo: PDFImage | null; nes: PDFImage | null; signature: PDFImage | null }

function front(s: Sheet, x: number, y: number, d: CardDesign, p: Person, a: Assets, photo: PDFImage | null, kind: 'STUDENT' | 'STAFF') {
  const band = hex(d.colour), ink = hex(d.textColour, [1, 1, 1]);
  const portrait = d.orientation === 'PORTRAIT';
  const W = portrait ? CR80.h : CR80.w, H = portrait ? CR80.w : CR80.h;
  s.rect(x, y, W, H, { fill: [1, 1, 1] });
  const logo = a.logo || a.nes ? 9 : 0;
  // The school's emblem on the left, the NES emblem on the right, each on a white tile so it
  // reads on any band colour; the school name and address are centred between them.
  const side = 2.5 + (logo ? logo + 1 : 0);
  const hx = x + side, hw = W - 2 * side;
  const nameH = s.measure(d.heading, hw, { size: 7.5, font: s.fonts.bold, lineGap: 1.15 });
  // The band fits its text: the name (one or two lines) plus however many lines the address takes.
  const subH = d.subheading ? s.measure(d.subheading, hw, { size: 4.6, lineGap: 1.25 }) : 0;
  const headH = Math.max(logo ? 13 : 9, 2.2 + nameH + 0.8 + subH + 1.6);
  s.rect(x, y, W, headH, { fill: band });
  const tile = (img: PDFImage, tx: number) => { s.rect(tx - 0.5, y + (headH - 10) / 2, 10, 10, { fill: [1, 1, 1] }); s.image(img, tx, y + (headH - 9) / 2, 9, 9); };
  if (a.logo) tile(a.logo, x + 2);
  if (a.nes) tile(a.nes, x + W - 11);
  s.paragraph(d.heading, hx, y + 2.2, hw, { size: 7.5, font: s.fonts.bold, colour: ink, lineGap: 1.15, align: 'centre' });
  if (d.subheading) s.paragraph(d.subheading, hx, y + 2.2 + nameH + 0.8, hw, { size: 4.6, colour: ink, lineGap: 1.25, align: 'centre' });
  const label = kind === 'STUDENT' ? 'STUDENT IDENTITY CARD' : 'STAFF IDENTITY CARD';
  if (portrait) {
    s.text(label, x, y + headH + 1.3, { size: 5, font: s.fonts.bold, colour: band, maxWidth: W, align: 'centre' });
    const pw = 20, ph = 24, py = y + headH + 4.5;
    if (d.show.photo) { s.rect(x + (W - pw) / 2 - 0.4, py - 0.4, pw + 0.8, ph + 0.8, { stroke: band, width: 0.4 }); if (photo) s.image(photo, x + (W - pw) / 2, py, pw, ph); else noPhoto(s, x + (W - pw) / 2, py, pw, ph); }
    let ty = py + (d.show.photo ? ph + 2 : 0);
    s.text(p.name, x + 2, ty, { size: 8.5, font: s.fonts.bold, maxWidth: W - 4, align: 'centre', minSize: 6 }); ty += 3.8;
    if (p.line1) { s.text(p.line1, x + 2, ty, { size: 6.5, maxWidth: W - 4, align: 'centre' }); ty += 3.2; }
    for (const [k, v] of p.rows.slice(0, 5)) { s.text(k, x + 3, ty, { size: 5.5, colour: [0.35, 0.35, 0.4] }); s.text(v, x + 21, ty, { size: 5.8, font: s.fonts.bold, maxWidth: W - 24 }); ty += 2.7; }
    if (d.show.barcode) s.barcode(p.code, x + 3, H + y - 9.5, W - 6, 5.2);
    s.rect(x, y + H - 3.6, W, 3.6, { fill: band });
    s.text(`${p.code}  ·  Valid till ${fmtDate(d.validUntil)}`, x, y + H - 3, { size: 4.6, colour: ink, maxWidth: W, align: 'centre' });
  } else {
    const pw = 19, ph = 23, px = x + 3, py = y + headH + 3;
    if (d.show.photo) { s.rect(px - 0.4, py - 0.4, pw + 0.8, ph + 0.8, { stroke: band, width: 0.4 }); if (photo) s.image(photo, px, py, pw, ph); else noPhoto(s, px, py, pw, ph); }
    const tx = d.show.photo ? px + pw + 3 : x + 3, tw = W - (tx - x) - 3;
    s.text(label, tx, y + headH + 1.6, { size: 4.8, font: s.fonts.bold, colour: band });
    s.text(p.name, tx, y + headH + 4.3, { size: 8.5, font: s.fonts.bold, maxWidth: tw, minSize: 6 });
    let ty = y + headH + 8.4;
    if (p.line1) { s.text(p.line1, tx, ty, { size: 6.3, maxWidth: tw }); ty += 3.1; }
    for (const [k, v] of p.rows.slice(0, 5)) { s.text(k, tx, ty, { size: 5.2, colour: [0.35, 0.35, 0.4] }); s.text(v, tx + 16, ty, { size: 5.5, font: s.fonts.bold, maxWidth: tw - 16 }); ty += 2.55; }
    if (d.show.barcode) s.barcode(p.code, x + 2, y + H - 9.2, d.show.photo ? pw + 6 + 14 : W - 4, 5);
    s.rect(x, y + H - 3.4, W, 3.4, { fill: band });
    s.text(`${p.code}  ·  Valid till ${fmtDate(d.validUntil)}`, x + 3, y + H - 2.9, { size: 4.6, colour: ink, maxWidth: W - 6, align: 'right' });
  }
  s.rect(x, y, W, H, { stroke: [0.85, 0.85, 0.88], width: 0.15 });
}

function back(s: Sheet, x: number, y: number, d: CardDesign, p: Person, a: Assets) {
  const band = hex(d.colour);
  const portrait = d.orientation === 'PORTRAIT';
  const W = portrait ? CR80.h : CR80.w, H = portrait ? CR80.w : CR80.h;
  s.rect(x, y, W, H, { fill: [1, 1, 1] });
  s.rect(x, y, W, 3, { fill: band });
  let ty = y + 6;
  if (p.emergency.length) {
    s.text('IN AN EMERGENCY', x + 4, ty, { size: 5, font: s.fonts.bold, colour: band }); ty += 2.8;
    for (const [k, v] of p.emergency) { s.text(k, x + 4, ty, { size: 5.3, colour: [0.35, 0.35, 0.4] }); s.text(v, x + 4 + (portrait ? 19 : 22), ty, { size: 6, font: s.fonts.bold, maxWidth: W - 8 - (portrait ? 19 : 22) }); ty += 2.9; }
    ty += 1.2; s.line(x + 4, ty, x + W - 4, ty, { width: 0.15, colour: [0.8, 0.82, 0.86] }); ty += 2;
  }
  for (const l of d.backLines) { ty += s.paragraph(l, x + 4, ty, W - 8, { size: 5.6, lineGap: 1.3 }) + 1.2; }
  const sy = y + H - 16;
  if (a.signature) s.image(a.signature, x + W - 26, sy, 22, 8);
  s.line(x + W - 27, sy + 9, x + W - 4, sy + 9, { width: 0.2 });
  s.text(d.signatureLabel, x + W - 27, sy + 9.8, { size: 5.2, maxWidth: 23, align: 'centre' });
  s.text(p.name, x + 4, sy + 9.8, { size: 5, colour: [0.35, 0.35, 0.4], maxWidth: W - 34 });
  s.rect(x, y + H - 3, W, 3, { fill: band });
  s.rect(x, y, W, H, { stroke: [0.85, 0.85, 0.88], width: 0.15 });
}

/**
 * CARD_PRINTER: one card per page at the card's exact size, for plastic (PVC) card printers.
 * A4: plain A4 with crop marks. SHEET: a sheet or tray the school has defined (pre-cut PVC sheets,
 * inkjet PVC card trays), with its own card positions.
 */
export interface CardRun { kind: 'STUDENT' | 'STAFF'; sectionIds?: string[] | null; ids?: string[] | null; layout: 'CARD_PRINTER' | 'A4' | 'SHEET'; sheetId?: string | null; sides: 'FRONT' | 'BACK' | 'BOTH'; printerId?: string | null;
  /** Only people with no card yet for this academic year (new admissions, new staff, or everyone after the year changes). */
  onlyWithoutCard?: boolean;
  /** A design preview: drawn, but not recorded as a card issued. */
  preview?: boolean }

export async function pdf(db: Db, actor: Actor, schoolId: string, run: CardRun) {
  await assertCan(db, actor, 'cards.print', schoolId);
  const { design: saved } = await design(db, actor, schoolId, run.kind);
  const year = await currentYear(db);
  const d: CardDesign = { ...saved, validUntil: saved.validUntil === 'AUTO' ? year.last : saved.validUntil };
  let people = run.kind === 'STUDENT'
    ? await students(db, schoolId, d, run.sectionIds?.length ? run.sectionIds : null, run.ids?.length ? run.ids : null)
    : await staff(db, schoolId, d, run.ids?.length ? run.ids : null);
  if (run.onlyWithoutCard) {
    const have = new Set((await db.query<{ owner_id: string }>(`select distinct owner_id from card_issue where school_id = $1 and kind = $2 and academic_year = $3`, [schoolId, run.kind, year.code])).map((r) => r.owner_id));
    people = people.filter((p) => !have.has(p.id));
    if (!people.length) throw invalid(`Everyone chosen already has a card for ${year.code}.`);
  }
  if (!people.length) throw invalid('Nobody matches. Choose a class, a section or people.');
  if (people.length > 1500) throw invalid('Print at most 1,500 cards at a time; choose fewer classes.');
  const cal = await printing.calibration(db, schoolId, run.printerId);
  const { doc, fonts } = await newDocument(`${run.kind === 'STUDENT' ? 'Student' : 'Staff'} ID cards`);
  const raw = await printing.assets(db, schoolId);
  const a: Assets = { logo: await embedImage(doc, raw.LOGO?.data, raw.LOGO?.type), nes: await embedImage(doc, raw.NES?.data, raw.NES?.type), signature: await embedImage(doc, raw.SIGNATURE?.data, raw.SIGNATURE?.type) };
  const photos = new Map<string, PDFImage | null>();
  for (const p of people) photos.set(p.id, d.show.photo ? await embedImage(doc, p.photo, p.photoType) : null);
  const portrait = d.orientation === 'PORTRAIT';
  // Designs are laid out on CR80; other sizes scale the whole card evenly (f).
  const real = cardSize(d);
  const f = real.w / CR80.w;
  const W = portrait ? real.h : real.w, H = portrait ? real.w : real.h;          // real card, mm
  const scaled = { ...cal, scale: cal.scale * f };
  const wantFront = run.sides !== 'BACK', wantBack = run.sides !== 'FRONT';
  const at = (x: number, y: number) => ({ x: x / f, y: y / f });  // real position → drawing units (the page stays its real size)

  const sheetPages = async (positions: { x: number; y: number }[], pageW: number, pageH: number, marks: boolean) => {
    const per = positions.length;
    for (let i = 0; i < people.length; i += per) {
      const batch = people.slice(i, i + per);
      for (const side of ['FRONT', 'BACK'] as const) {
        if ((side === 'FRONT' && !wantFront) || (side === 'BACK' && !wantBack)) continue;
        const s = new Sheet(doc, pageW, pageH, fonts, scaled);
        batch.forEach((p, k) => {
          // Backs are mirrored left to right so each lands behind its front when printed double-sided (long-edge flip).
          const pos = side === 'FRONT' ? positions[k] : { x: pageW - positions[k].x - W, y: positions[k].y };
          const c = at(pos.x, pos.y);
          if (side === 'FRONT') front(s, c.x, c.y, d, p, a, photos.get(p.id)!, run.kind); else back(s, c.x, c.y, d, p, a);
          if (marks) s.cropMarks(c.x, c.y, W / f, H / f);
        });
      }
    }
  };

  if (run.layout === 'CARD_PRINTER') {
    for (const p of people) {
      if (wantFront) front(new Sheet(doc, W, H, fonts, scaled), 0, 0, d, p, a, photos.get(p.id)!, run.kind);
      if (wantBack) back(new Sheet(doc, W, H, fonts, scaled), 0, 0, d, p, a);
    }
  } else if (run.layout === 'SHEET') {
    const sh = run.sheetId ? await db.maybeOne<printing.LabelSheet>(`select ${printing.SHEET_COLS} from label_sheet where id = $1 and (school_id is null or school_id = $2)`, [run.sheetId, schoolId]) : null;
    if (!sh) throw invalid('Choose the card sheet or tray.');
    if (Math.abs(sh.label_w - W) > 1 || Math.abs(sh.label_h - H) > 1) {
      throw invalid(`The sheet "${sh.name}" holds ${sh.label_w} × ${sh.label_h} mm cards, but this design is ${W} × ${H} mm (${d.orientation.toLowerCase()}). Choose a matching sheet, or change the card size or orientation.`);
    }
    const positions: { x: number; y: number }[] = [];
    for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) positions.push({ x: sh.margin_left + c * (sh.label_w + sh.gap_x), y: sh.margin_top + r * (sh.label_h + sh.gap_y) });
    await sheetPages(positions, sh.page_w, sh.page_h, false);
  } else {
    // Plain A4, centred, with crop marks: as many cards as fit with room to cut between them.
    const gx = 6, gy = 4;
    const cols = Math.max(1, Math.floor((210 - 16 + gx) / (W + gx))), rows = Math.max(1, Math.floor((297 - 16 + gy) / (H + gy)));
    const left = (210 - (cols * W + (cols - 1) * gx)) / 2, top = (297 - (rows * H + (rows - 1) * gy)) / 2;
    const positions: { x: number; y: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) positions.push({ x: left + c * (W + gx), y: top + r * (H + gy) });
    await sheetPages(positions, 210, 297, true);
  }
  if (run.sides !== 'BACK' && !run.preview) {
    await db.tx(async (t) => {
      const had = new Set((await t.query<{ owner_id: string }>(`select distinct owner_id from card_issue where school_id = $1 and kind = $2 and academic_year = $3 and owner_id = any($4)`,
        [schoolId, run.kind, year.code, people.map((p) => p.id)])).map((r) => r.owner_id));
      for (const p of people) await t.query(`insert into card_issue (school_id, kind, owner_id, academic_year, reprint, printed_by) values ($1, $2, $3, $4, $5, $6)`, [schoolId, run.kind, p.id, year.code, had.has(p.id), actor.id]);
      await printing.log(t, actor, schoolId, run.kind === 'STUDENT' ? 'STUDENT_CARD' : 'STAFF_CARD', people.length,
        { layout: run.layout, sides: run.sides, year: year.code, withoutPhoto: people.filter((p) => !p.photo).length }, run.printerId);
    }, { actor: actor.label });
  }
  return { pdf: Buffer.from(await doc.save()), count: people.length, withoutPhoto: people.filter((p) => d.show.photo && !p.photo).map((p) => p.name) };
}


/** The academic year in force today, with its last day (cards are valid until then). */
async function currentYear(db: Db) {
  const y = await db.maybeOne<{ code: string; last: string }>(`select code, (upper(period) - 1)::text as last from academic_year where period @> current_date`);
  if (!y) throw invalid('No academic year covers today. Set up the academic year first.');
  return y;
}

/**
 * How many people have a card for this academic year. New admissions and new staff during the
 * year appear as "without a card", and at the change of year everyone does.
 */
export async function status(db: Db, actor: Actor, schoolId: string, kind: 'STUDENT' | 'STAFF') {
  await assertCan(db, actor, 'cards.print', schoolId);
  const y = await currentYear(db);
  const people = kind === 'STUDENT'
    ? await db.query<{ id: string; name: string; detail: string; section_id: string | null }>(
      `select s.id, s.name, e.class_code || coalesce('-' || sec.name, '') || ' · ' || e.admission_no as detail, e.section_id
         from enrolment e join student s on s.id = e.student_id left join section sec on sec.id = e.section_id join class_level cl on cl.code = e.class_code
        where e.school_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) order by cl.ordinal, sec.name, s.name`, [schoolId])
    : await db.query<{ id: string; name: string; detail: string; section_id: null }>(
      `select u.id, u.name, coalesce(u.designation, '') as detail, null as section_id from app_user u join org_unit o on o.id = $1
        where u.active and u.role <> 'PARENT' and u.scope_path <@ o.path order by u.name`, [schoolId]);
  const have = new Set((await db.query<{ owner_id: string }>(`select distinct owner_id from card_issue where school_id = $1 and kind = $2 and academic_year = $3`, [schoolId, kind, y.code])).map((r) => r.owner_id));
  const without = people.filter((p) => !have.has(p.id));
  return { year: y.code, validUntil: y.last, total: people.length, withCard: people.length - without.length, without: without.slice(0, 500), sampleId: people[0]?.id ?? null };
}

/** A light frame saying a photo is needed, so missing photos are obvious before cards are printed in bulk. */
function noPhoto(s: Sheet, x: number, y: number, w: number, h: number) {
  s.rect(x, y, w, h, { fill: [0.95, 0.95, 0.96] });
  s.text('Photo', x, y + h / 2 - 1.5, { size: 6, colour: [0.6, 0.6, 0.65], maxWidth: w, align: 'centre' });
}
