import { readFileSync } from 'node:fs';
import { degrees, rgb, StandardFonts, type PDFDocument, type PDFFont, type PDFImage } from 'pdf-lib';
import { hex, safe, type Colour, type Fonts, type Sheet } from './pdf.js';

/**
 * The look of NES report cards, taken from the cards the schools print today (Holistic Progress
 * Card, Session 2026-27): a navy band with the emblem and "Holistic Progress Card" on the cover,
 * light-blue pages with hatched circles, navy headings, yellow tags, light cells with navy edges,
 * gold stars, plants and smileys for ratings. Every card (Balvatika to Class XII) uses these
 * pieces, so all of them look like one family. Measurements are millimetres on A4.
 */

export const NAVY = hex('#0A5A96');
export const PAGE = hex('#BEE6F8');
export const SKY = hex('#74C9F0');
export const CELL = hex('#D3ECFB');
export const PAPER = hex('#F0F8FE');
export const TAG = hex('#FFF3A3');
export const INK = hex('#15202B');
export const RED = hex('#A3272B');
export const WHITE: Colour = [1, 1, 1];
const GOLD = hex('#F2B632'), GOLD_EDGE = hex('#B07B12'), HATCH = hex('#9CCCE6');
const GREEN = hex('#3E8E2E'), LEAF = hex('#6BBF3A'), TRUNK = hex('#8B5A2B'), POT = hex('#D9733B'), POT_RIM = hex('#B85A26'), SOIL = hex('#7A5230');
const SMILE = hex('#F7D31E'), SMILE_EDGE = hex('#C89B00'), DARK = hex('#3B2A12');
const WOOD = hex('#B8692E'), WOOD_DARK = hex('#7E4316');

export const A4 = { w: 210, h: 297 };
const PT = 72 / 25.4;

// ── Fonts ────────────────────────────────────────────────────────────────────────────────

export interface CardFonts { display: PDFFont; body: PDFFont; bold: PDFFont; serif: PDFFont; serifBold: PDFFont }

/**
 * The schools' cards use Spicy Rice for headings and Nunito for text. When those font files are
 * installed in reference/fonts (with the @pdf-lib/fontkit package) they are used; otherwise the
 * standard PDF fonts stand in, so cards always print.
 */
export async function cardFonts(doc: PDFDocument, base: Fonts): Promise<CardFonts> {
  const fallback: CardFonts = { display: await doc.embedFont(StandardFonts.HelveticaBoldOblique), body: base.regular, bold: base.bold, serif: base.serif, serifBold: base.serifBold };
  const FONTKIT: string = '@pdf-lib/fontkit';
  try {
    const fk = await import(FONTKIT);
    doc.registerFontkit(fk.default ?? fk);
    const file = (n: string) => readFileSync(new URL(`../reference/fonts/${n}`, import.meta.url));
    const out = { ...fallback };
    try { out.display = await doc.embedFont(file('SpicyRice-Regular.ttf'), { subset: true }); } catch { /* keep the stand-in */ }
    try { out.body = await doc.embedFont(file('Nunito-Regular.ttf'), { subset: true }); out.bold = await doc.embedFont(file('Nunito-Bold.ttf'), { subset: true }); } catch { /* keep the stand-in */ }
    return out;
  } catch { return fallback; }
}

// ── Text helpers ─────────────────────────────────────────────────────────────────────────

/** Splits text into lines that fit the width. */
export function wrap(font: PDFFont, text: string, size: number, width: number) {
  const out: string[] = [];
  for (const para of safe(text ?? '', font).split(/\n/)) {
    let cur = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) / PT > width && cur) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

/** Line height in millimetres for a font size. */
export const lh = (size: number) => size * 0.3528 * 1.32;

/** The top of a line of text that sits in the middle of a box of height h. */
export const mid = (y: number, h: number, size: number) => y + (h - size * 0.26) / 2;

/** Draws wrapped lines; returns the height used. */
export function lines(s: Sheet, ls: string[], x: number, y: number, o: { size: number; font: PDFFont; colour?: Colour; width?: number; align?: 'left' | 'centre' }) {
  ls.forEach((l, i) => s.text(l, x, y + i * lh(o.size), { size: o.size, font: o.font, colour: o.colour ?? INK, maxWidth: o.align === 'centre' ? o.width : undefined, align: o.align }));
  return ls.length * lh(o.size);
}

// ── Page furniture ───────────────────────────────────────────────────────────────────────

/** A circle filled with diagonal hatching, as on the schools' cards. */
function hatch(s: Sheet, cx: number, cy: number, r: number) {
  for (let t = -r; t <= r; t += 2.3) {
    const u = Math.sqrt(Math.max(r * r - t * t, 0));
    const px = cx + t / Math.SQRT2, py = cy + t / Math.SQRT2;
    s.line(px - u / Math.SQRT2, py + u / Math.SQRT2, px + u / Math.SQRT2, py - u / Math.SQRT2, { colour: HATCH, width: 0.45 });
  }
}

/** Light pages carry the hatched circles and rings; rating pages are plain sky blue. */
export function background(s: Sheet, kind: 'light' | 'sky') {
  s.rect(0, 0, A4.w, A4.h, { fill: kind === 'light' ? PAGE : SKY });
  if (kind === 'sky') return;
  hatch(s, 196, 6, 20); hatch(s, 188, 128, 26); hatch(s, 192, 262, 28); hatch(s, 4, 82, 20);
  s.ellipse(12, 150, 6.5, 6.5, { stroke: WHITE, width: 2, opacity: 0.75 });
  s.ellipse(52, 186, 4, 4, { stroke: WHITE, width: 1.6, opacity: 0.75 });
  s.ellipse(196, 32, 4.5, 4.5, { stroke: hex('#F5D90A'), width: 1.3 });
  s.path('M0 10 L6 0 L12 10 Z', 186, 210, 1, { stroke: hex('#7FD8B4'), width: 1.2 });
  s.rect(0, 293.5, A4.w, 3.5, { fill: NAVY });
}

/** A big heading in the display face, centred on the page. */
export function title(s: Sheet, f: CardFonts, text: string, y: number, size = 26) {
  s.text(text, 10, y, { size, font: f.display, colour: NAVY, maxWidth: 190, align: 'centre', minSize: 14 });
}

/** A yellow tag (Part A, CURRICULUM GOALS, a developmental goal). Returns its height. */
export function tag(s: Sheet, f: CardFonts, text: string, x: number, y: number, o: { centre?: boolean; size?: number } = {}) {
  const size = o.size ?? 10.5, w = s.width(text, size, f.body) + 5, h = 7;
  const left = o.centre ? (A4.w - w) / 2 : x;
  s.rect(left, y, w, h, { fill: TAG });
  s.text(text, left + 2.5, mid(y, h, size), { size, font: f.body, colour: INK });
  return h;
}

/** A navy heading bar with white text. */
export function band(s: Sheet, f: CardFonts, text: string, x: number, y: number, w: number, h: number, o: { align?: 'left' | 'centre'; size?: number; font?: PDFFont } = {}) {
  const size = o.size ?? 11;
  s.rect(x, y, w, h, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 });
  s.text(text, o.align === 'left' ? x + 2.5 : x + 1, mid(y, h, size), { size, font: o.font ?? f.body, colour: WHITE, maxWidth: o.align === 'left' ? w - 4 : w - 2, align: o.align === 'left' ? 'left' : 'centre', minSize: 7 });
}

/** A table cell: light fill with a thin navy edge. */
export function cell(s: Sheet, x: number, y: number, w: number, h: number, fill: Colour = CELL) {
  s.rect(x, y, w, h, { fill, stroke: NAVY, width: 0.25 });
}

/** "DRAFT" across a page printed before the results are published. */
export function draft(s: Sheet, f: CardFonts) {
  s.page.drawText('DRAFT · NOT PUBLISHED', { x: 40 * PT, y: 70 * PT, size: 46, font: f.bold, color: rgb(0.75, 0.2, 0.2), opacity: 0.16, rotate: degrees(52) });
}

// ── Rating symbols ───────────────────────────────────────────────────────────────────────

export function star(s: Sheet, cx: number, cy: number, r: number) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    pts.push(`${(Math.cos(a) * rr).toFixed(3)} ${(Math.sin(a) * rr).toFixed(3)}`);
  }
  s.path(`M${pts.join(' L')} Z`, cx, cy, 1, { fill: GOLD, stroke: GOLD_EDGE, width: 0.18 });
}

/** One to three gold stars in a row, centred. */
export function stars(s: Sheet, n: number, cx: number, cy: number, r = 1.9) {
  const gap = r * 2.15;
  for (let i = 0; i < n; i++) star(s, cx + (i - (n - 1) / 2) * gap, cy, r);
}

/** Beginner: a sprout; progressing: a potted plant; proficient: a tree. Drawn in a box `size` mm high. */
export function plant(s: Sheet, level: number, cx: number, cy: number, size = 5.5) {
  const k = size / 10, ox = cx - 5 * k, oy = cy - 5 * k;
  const P = (d: string, o: Parameters<Sheet['path']>[4]) => s.path(d, ox, oy, k, o);
  const E = (x: number, y: number, rx: number, ry: number, fill: Colour) => s.ellipse(ox + x * k, oy + y * k, rx * k, ry * k, { fill });
  if (level >= 3) {
    E(5, 9.6, 2.8, 0.5, GREEN);
    P('M4.3 9.6 L4.5 5.2 H5.5 L5.7 9.6 Z', { fill: TRUNK });
    E(5, 4.3, 3.4, 3, GREEN); E(3.2, 5, 2.1, 1.8, LEAF); E(6.8, 5, 2.1, 1.8, LEAF); E(5, 2.6, 2.2, 1.8, LEAF);
  } else if (level === 2) {
    P('M5 6.2 Q2.8 4.4 3.2 1.9 Q5.3 3.2 5 6.2 Z', { fill: LEAF, stroke: GREEN, width: 0.1 });
    P('M5 6.2 Q7.2 4.4 6.8 1.9 Q4.7 3.2 5 6.2 Z', { fill: LEAF, stroke: GREEN, width: 0.1 });
    P('M5 6.2 Q3.9 3.6 5 0.7 Q6.1 3.6 5 6.2 Z', { fill: GREEN });
    P('M2.6 5.8 H7.4 V6.7 H2.6 Z', { fill: POT_RIM });
    P('M2.9 6.7 H7.1 L6.4 9.8 H3.6 Z', { fill: POT });
  } else {
    E(5, 8.9, 3.3, 1.1, SOIL);
    P('M5 8.6 L5 5.4', { stroke: GREEN, width: 0.06 * size });
    P('M5 5.8 Q3.1 5.6 2.7 3.9 Q4.7 3.9 5 5.8 Z', { fill: LEAF, stroke: GREEN, width: 0.08 });
    P('M5 5.8 Q6.9 5.6 7.3 3.9 Q5.3 3.9 5 5.8 Z', { fill: LEAF, stroke: GREEN, width: 0.08 });
  }
}

/** 3: a big smile; 2: a smile; 1: a sad face. */
export function smiley(s: Sheet, level: number, cx: number, cy: number, r = 2.2) {
  s.ellipse(cx, cy, r, r, { fill: SMILE, stroke: SMILE_EDGE, width: 0.2 });
  s.ellipse(cx - 0.34 * r, cy - 0.25 * r, 0.1 * r, 0.17 * r, { fill: DARK });
  s.ellipse(cx + 0.34 * r, cy - 0.25 * r, 0.1 * r, 0.17 * r, { fill: DARK });
  if (level >= 3) s.path('M-0.52 0.12 Q0 0.9 0.52 0.12 Z', cx, cy, r, { fill: DARK });
  else if (level === 2) s.path('M-0.45 0.22 Q0 0.68 0.45 0.22', cx, cy, r, { stroke: DARK, width: 0.09 * r });
  else s.path('M-0.42 0.55 Q0 0.18 0.42 0.55', cx, cy, r, { stroke: DARK, width: 0.09 * r });
}

export function tick(s: Sheet, cx: number, cy: number, size = 3) {
  s.path('M-0.5 0 L-0.15 0.4 L0.5 -0.45', cx, cy, size, { stroke: INK, width: 0.45 });
}

// ── The cover ────────────────────────────────────────────────────────────────────────────

function cloud(s: Sheet, x: number, y: number, k: number) {
  for (const [dx, dy, r] of [[0, 0, 7], [8, -3, 8], [17, 0, 7], [8, 3, 7], [-6, 3, 5], [23, 3, 5]]) s.ellipse(x + dx * k, y + dy * k, r * k, r * k * 0.8, { fill: WHITE });
}

function tree(s: Sheet, x: number, y: number, k: number) {
  s.rect(x - 2.5 * k, y, 5 * k, 32 * k, { fill: TRUNK });
  for (const [dx, dy, r, c] of [[0, -6, 16, GREEN], [-11, 2, 11, LEAF], [11, 2, 11, LEAF], [0, -14, 11, LEAF], [-6, -4, 9, hex('#9ACD32')], [7, -8, 8, hex('#9ACD32')]] as [number, number, number, Colour][])
    s.ellipse(x + dx * k, y + dy * k, r * k, r * k * 0.9, { fill: c });
}

/**
 * The cover: navy band with the emblem, the school and "Holistic Progress Card"; a picture (the
 * school's own artwork if it has uploaded one, otherwise a drawn park scene); and a wooden board
 * with the child's name, roll number, class and admission number, and the session.
 */
export function cover(s: Sheet, f: CardFonts, o: { school: string; heading: string; logo: PDFImage | null; art: PDFImage | null; fields: [string, string][]; session: string }) {
  if (o.art) {
    const r = Math.max(A4.w / o.art.width, (A4.h - 33) / o.art.height);
    s.page.drawImage(o.art, { x: ((A4.w - o.art.width * r) / 2) * PT, y: 0, width: o.art.width * r * PT, height: o.art.height * r * PT });
  } else {
    s.rect(0, 33, A4.w, A4.h - 33, { fill: hex('#8FD3F4') });
    cloud(s, 140, 70, 1.1); cloud(s, 82, 92, 1.2); cloud(s, 6, 82, 0.9); cloud(s, 186, 118, 0.8);
    s.ellipse(40, 300, 125, 48, { fill: hex('#9ACD32') });
    s.ellipse(185, 306, 110, 44, { fill: hex('#7CB518') });
    tree(s, 16, 196, 1.5); tree(s, 196, 192, 1.4);
    s.rect(0, 262, A4.w, 35, { fill: hex('#86C440') });
    for (let i = 0; i < 16; i++) {
      const x = 6 + i * 13.2, y = 280 + (i % 3) * 4;
      s.path('M0 0 L1.5 -7 L3 0 L4.5 -6 L6 0 Z', x - 4, y + 6, 1, { fill: hex('#4F9A2A') });
      for (const a of [0, 72, 144, 216, 288]) s.ellipse(x + Math.cos((a * Math.PI) / 180) * 1.8, y + Math.sin((a * Math.PI) / 180) * 1.8, 1.5, 1.5, { fill: hex('#F48FB1') });
      s.ellipse(x, y, 0.9, 0.9, { fill: hex('#F5D90A') });
    }
  }
  // The board on its posts, with an apple and books on top.
  const bx = 38, by = 120, bw = 134, bh = 100;
  s.rect(58, by + bh - 2, 9, 52, { fill: WOOD, stroke: WOOD_DARK, width: 0.5 });
  s.rect(143, by + bh - 2, 9, 52, { fill: WOOD, stroke: WOOD_DARK, width: 0.5 });
  s.rect(bx, by, bw, bh, { fill: WOOD, stroke: WOOD_DARK, width: 0.7 });
  s.rect(bx + 5, by + 5, bw - 10, bh - 10, { fill: WHITE, stroke: hex('#BDBDBD'), width: 0.4 });
  for (const [nx, ny] of [[bx + 2.5, by + 2.5], [bx + bw - 2.5, by + 2.5], [bx + 2.5, by + bh - 2.5], [bx + bw - 2.5, by + bh - 2.5]]) s.ellipse(nx, ny, 0.9, 0.9, { fill: WOOD_DARK });
  s.ellipse(152, by - 6, 6, 5.5, { fill: hex('#D62828') }); s.path('M0 0 Q3 -4 6 -3 Q3 -1 0 0 Z', 152, by - 11, 1, { fill: LEAF });
  for (const [i, c] of [hex('#3A86C8'), hex('#D62828'), hex('#2A9D8F')].entries()) s.rect(116, by - 4 - i * 2.4, 16, 2.2, { fill: c, stroke: WHITE, width: 0.2 });
  // The fields.
  o.fields.forEach(([k, v], i) => {
    const y = by + 13 + i * 15;
    s.text(k, bx + 12, y + 1, { size: 13, font: f.display, colour: RED, maxWidth: 36, minSize: 9 });
    s.text(':', bx + 50, y, { size: 13, font: f.bold, colour: INK });
    s.text(v || ' ', bx + 54, y, { size: 12, font: f.bold, colour: INK, maxWidth: bw - 64, minSize: 7.5 });
    s.line(bx + 54, y + 6.5, bx + bw - 10, y + 6.5, { colour: RED, width: 0.35, dash: [0.6, 0.8] });
  });
  s.text('Session', bx + 24, by + 77, { size: 18, font: f.display, colour: RED });
  const pw = s.width(o.session, 16, f.display) + 10;
  s.roundRect(bx + 62, by + 74.5, pw, 12, 4, { fill: RED });
  s.text(o.session, bx + 62, by + 77.5, { size: 16, font: f.display, colour: WHITE, maxWidth: pw, align: 'centre' });
  // The band on top, drawn last so artwork never covers it.
  s.rect(0, 0, A4.w, 33, { fill: NAVY });
  s.rect(4, 3, 27, 27, { fill: WHITE });
  if (o.logo) s.image(o.logo, 5, 4, 25, 25);
  s.text(o.school, 34, 5, { size: 14, font: f.body, colour: WHITE, maxWidth: 172, align: 'centre', minSize: 9 });
  s.text(o.heading, 34, 13.5, { size: 30, font: f.display, colour: WHITE, maxWidth: 172, align: 'centre', minSize: 16 });
}

// ── Closing: attendance, remarks, signatures ─────────────────────────────────────────────

export interface TermClose { label: string; days: number; present: number; remark: string | null }

/** Attendance per term, the teacher's remark per term, and the signatures. Returns the y below. */
export function closing(s: Sheet, f: CardFonts, y: number, terms: TermClose[], sign: { date: string; teacher: PDFImage | null; principal: PDFImage | null }) {
  const x = 8, w = 194;
  band(s, f, 'Attendance', x, y, w, 8, { size: 12 }); y += 8;
  const cols: [string, number][] = [['Term', 38], ['Total Working Days', 80], ['Present', 38], ['Absent', 38]];
  let cx = x;
  for (const [h, cw] of cols) { cell(s, cx, y, cw, 7, TAG); s.text(h, cx, mid(y, 7, 11), { size: 11, font: f.serifBold, colour: INK, maxWidth: cw, align: 'centre' }); cx += cw; }
  y += 7;
  for (const t of terms) {
    cx = x;
    for (const [v, [, cw]] of [[t.label, cols[0]], [t.days ? String(t.days) : '—', cols[1]], [t.days ? String(t.present) : '—', cols[2]], [t.days ? String(t.days - t.present) : '—', cols[3]]] as [string, [string, number]][]) {
      cell(s, cx, y, cw, 6); s.text(v, cx, mid(y, 6, 9), { size: 9, font: f.body, colour: INK, maxWidth: cw, align: 'centre' }); cx += cw;
    }
    y += 6;
  }
  y += 5;
  band(s, f, "Teacher's Remarks", x, y, w, 8, { size: 12 }); y += 8;
  for (const t of terms) {
    const ls = wrap(f.body, t.remark ?? '—', 9.5, w - 32);
    const h = Math.max(9, ls.length * lh(9.5) + 4);
    cell(s, x, y, w, h, PAPER);
    s.text(`${t.label}:`, x + 2, y + 2.2, { size: 10, font: f.bold, colour: INK });
    lines(s, ls, x + 28, y + 2.2, { size: 9.5, font: f.body });
    y += h;
  }
  y += 4;
  cell(s, x, y, w, 34, CELL);
  s.text(`Date: ${sign.date}`, x, y + 3, { size: 9.5, font: f.body, colour: INK, maxWidth: w, align: 'centre' });
  const slots: [string, PDFImage | null][] = [['Class Teacher', sign.teacher], ['PRINCIPAL', sign.principal], ['Parent', null]];
  slots.forEach(([label, img], i) => {
    const sx = x + i * (w / 3);
    if (img) s.image(img, sx + w / 6 - 18, y + 9, 36, 15);
    s.text(label, sx, y + 27, { size: 9.5, font: f.body, colour: INK, maxWidth: w / 3, align: 'centre' });
  });
  return y + 34;
}
