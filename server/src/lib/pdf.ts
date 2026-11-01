import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import bwip from 'bwip-js';

/**
 * Drawing printable pages in millimetres, measured from the top-left of the paper.
 *
 * Every print (book labels, ID cards, certificates) is a PDF whose page is exactly the paper
 * size. The printer profile's calibration (offset right/down in mm, scale %) is applied to
 * everything drawn, so a school can correct for its own printer once and every later print lines
 * up. PDFs must be printed at "Actual size" (100%), never "Fit to page".
 */

export interface Calibration { offsetX: number; offsetY: number; scale: number }
export const NO_CALIBRATION: Calibration = { offsetX: 0, offsetY: 0, scale: 100 };

const PT = 72 / 25.4;                 // points per millimetre
export type Colour = [number, number, number];
export const BLACK: Colour = [0, 0, 0];
const c = (x: Colour) => rgb(x[0], x[1], x[2]);

/** Parses "#1D4E89" into a colour; falls back to navy. */
export function hex(h: string | undefined, fallback: Colour = [0.06, 0.18, 0.36]): Colour {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h ?? '');
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : fallback;
}

export interface Fonts { regular: PDFFont; bold: PDFFont; serif: PDFFont; serifBold: PDFFont; mono: PDFFont }

export async function newDocument(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('NavShiksha');
  doc.setProducer('NavShiksha · Navy Education Society');
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  return { doc, fonts };
}

/** Standard PDF fonts cover Western European characters only; anything else is spelled out or dropped. */
export function safe(text: string, font: PDFFont) {
  const s = String(text ?? '').replace(/₹\s?/g, 'Rs. ').replace(/[​-‍﻿]/g, '');
  let out = '';
  for (const ch of s) {
    try { font.encodeText(ch); out += ch; } catch { out += ch.normalize('NFD').replace(/[^\x20-\x7E]/g, '') || '?'; }
  }
  return out;
}

export interface TextOpts { size?: number; font?: PDFFont; colour?: Colour; maxWidth?: number; align?: 'left' | 'centre' | 'right'; minSize?: number }

/** One page, drawn in millimetres from the paper's top-left, with the printer's calibration applied. */
export class Sheet {
  readonly page: PDFPage;
  private s: number;
  constructor(doc: PDFDocument, readonly w: number, readonly h: number, readonly fonts: Fonts, private cal: Calibration = NO_CALIBRATION) {
    this.page = doc.addPage([w * PT, h * PT]);
    this.s = cal.scale / 100;
  }
  private X(x: number) { return (x * this.s + this.cal.offsetX) * PT; }
  private Y(y: number) { return this.h * PT - (y * this.s + this.cal.offsetY) * PT; }
  private L(l: number) { return l * this.s * PT; }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Colour; stroke?: Colour; width?: number; dash?: boolean } = {}) {
    this.page.drawRectangle({ x: this.X(x), y: this.Y(y + h), width: this.L(w), height: this.L(h),
      color: o.fill ? c(o.fill) : undefined, borderColor: o.stroke ? c(o.stroke) : undefined, borderWidth: o.stroke ? (o.width ?? 0.25) * PT : 0,
      borderDashArray: o.dash ? [2, 2] : undefined });
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { colour?: Colour; width?: number; dash?: number[] } = {}) {
    this.page.drawLine({ start: { x: this.X(x1), y: this.Y(y1) }, end: { x: this.X(x2), y: this.Y(y2) }, thickness: (o.width ?? 0.25) * PT, color: c(o.colour ?? BLACK),
      dashArray: o.dash?.map((d) => d * PT) });
  }

  /** An ellipse centred at (cx, cy); a circle when ry is left out. */
  ellipse(cx: number, cy: number, rx: number, ry: number = rx, o: { fill?: Colour; stroke?: Colour; width?: number; opacity?: number } = {}) {
    this.page.drawEllipse({ x: this.X(cx), y: this.Y(cy), xScale: this.L(rx), yScale: this.L(ry),
      color: o.fill ? c(o.fill) : undefined, borderColor: o.stroke ? c(o.stroke) : undefined, borderWidth: o.stroke ? (o.width ?? 0.25) * PT : 0,
      opacity: o.opacity, borderOpacity: o.opacity });
  }

  /**
   * An SVG path (y downwards, as in SVG) with its origin at (x, y) mm, where one path unit is
   * `unit` mm. Used for drawn symbols: stars, plants, smileys, rounded panels.
   */
  path(d: string, x: number, y: number, unit: number, o: { fill?: Colour; stroke?: Colour; width?: number; opacity?: number } = {}) {
    this.page.drawSvgPath(d, { x: this.X(x), y: this.Y(y), scale: this.L(unit),
      color: o.fill ? c(o.fill) : undefined, borderColor: o.stroke ? c(o.stroke) : undefined, borderWidth: o.stroke ? (o.width ?? 0.25) / unit : undefined,
      opacity: o.opacity, borderOpacity: o.opacity });
  }

  /** A rectangle with rounded corners. */
  roundRect(x: number, y: number, w: number, h: number, r: number, o: { fill?: Colour; stroke?: Colour; width?: number; opacity?: number } = {}) {
    r = Math.min(r, w / 2, h / 2);
    const d = `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} H${r} A${r} ${r} 0 0 1 0 ${h - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`;
    this.path(d, x, y, 1, o);
  }

  /** Text width in millimetres. */
  width(str: string, size: number, font: PDFFont = this.fonts.regular) { return font.widthOfTextAtSize(safe(str, font), size) / PT; }

  /** Text with its top at y. Shrinks to fit maxWidth (down to minSize), then truncates with an ellipsis. Returns the height used. */
  text(str: string, x: number, y: number, o: TextOpts = {}) {
    const font = o.font ?? this.fonts.regular;
    let size = o.size ?? 9;
    let t = safe(str, font);
    const widthMm = (txt: string, sz: number) => font.widthOfTextAtSize(txt, sz) / PT;
    if (o.maxWidth) {
      const min = o.minSize ?? size * 0.7;
      while (size > min && widthMm(t, size) > o.maxWidth) size -= 0.25;
      if (widthMm(t, size) > o.maxWidth) { while (t.length > 1 && widthMm(`${t}…`, size) > o.maxWidth) t = t.slice(0, -1); t = `${t.trimEnd()}…`; }
    }
    const wMm = widthMm(t, size);
    const left = o.align === 'centre' && o.maxWidth ? x + (o.maxWidth - wMm) / 2 : o.align === 'right' && o.maxWidth ? x + o.maxWidth - wMm : x;
    const ascent = font.heightAtSize(size, { descender: false }) / PT;
    this.page.drawText(t, { x: this.X(left), y: this.Y(y + ascent), size: size * this.s, font, color: c(o.colour ?? BLACK) });
    return font.heightAtSize(size) / PT;
  }

  /** The height a paragraph would take, without drawing it. */
  measure(str: string, width: number, o: { size?: number; font?: PDFFont; lineGap?: number } = {}) {
    return this.lines(str, width, o.font ?? this.fonts.regular, o.size ?? 10).length * (((o.size ?? 10) * (o.lineGap ?? 1.45)) / PT);
  }

  private lines(str: string, width: number, font: PDFFont, size: number) {
    const words = safe(str, font).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) / PT > width && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /**
   * A wrapped paragraph where parts marked **like this** are bold (names, classes on certificates).
   * Returns the height used.
   */
  richParagraph(str: string, x: number, y: number, width: number, o: { size?: number; font: PDFFont; bold: PDFFont; colour?: Colour; lineGap?: number }) {
    const size = o.size ?? 11;
    // Words with their weight; a bold run keeps its spaces so it wraps like normal text.
    const words: { t: string; bold: boolean }[] = [];
    str.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      const bold = part.startsWith('**') && part.endsWith('**');
      const text = bold ? part.slice(2, -2) : part;
      for (const w of text.split(/(\s+)/)) if (w) words.push({ t: w, bold });
    });
    const width_ = (w: { t: string; bold: boolean }) => (w.bold ? o.bold : o.font).widthOfTextAtSize(safe(w.t, w.bold ? o.bold : o.font), size) / PT;
    const lines: { t: string; bold: boolean }[][] = [[]];
    let used = 0;
    for (const w of words) {
      const isSpace = /^\s+$/.test(w.t);
      const wd = width_(w);
      if (!isSpace && used + wd > width && lines[lines.length - 1].length) { lines.push([]); used = 0; }
      if (isSpace && !lines[lines.length - 1].length) continue;
      lines[lines.length - 1].push(w); used += wd;
    }
    const lh = (size * (o.lineGap ?? 1.5)) / PT;
    lines.forEach((line, i) => {
      let cx = x;
      while (line.length && /^\s+$/.test(line[line.length - 1].t)) line.pop();
      for (const w of line) { this.text(w.t, cx, y + i * lh, { size, font: w.bold ? o.bold : o.font, colour: o.colour }); cx += width_(w); }
    });
    return lines.length * lh;
  }

  /** Wraps text into lines within width; returns the height used. */
  paragraph(str: string, x: number, y: number, width: number, o: TextOpts & { lineGap?: number } = {}) {
    const font = o.font ?? this.fonts.regular;
    const size = o.size ?? 10;
    const words = safe(str, font).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) / PT > width && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    const lh = (size * (o.lineGap ?? 1.45)) / PT;
    // Centred or right-aligned paragraphs align each line within the width.
    lines.forEach((l, i) => this.text(l, x, y + i * lh, { ...o, font, size, maxWidth: o.align && o.align !== 'left' ? width : undefined }));
    return lines.length * lh;
  }

  /** An image fitted inside the box, centred, keeping its proportions. */
  image(img: PDFImage, x: number, y: number, w: number, h: number) {
    const r = Math.min(w / img.width, h / img.height);
    const dw = img.width * r, dh = img.height * r;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    this.page.drawImage(img, { x: this.X(dx), y: this.Y(dy + dh), width: this.L(dw), height: this.L(dh) });
  }

  /**
   * A Code 128 barcode filling the box, with the quiet zones barcode scanners need on each side.
   * Narrow bars are kept at 0.19 mm or wider so ordinary laser and thermal printers resolve them.
   */
  barcode(value: string, x: number, y: number, w: number, h: number) {
    const raw = bwip.raw({ bcid: 'code128', text: value })[0] as { sbs: number[] };
    const modules = raw.sbs.reduce((a, b) => a + b, 0) + 20;          // 10-module quiet zone each side
    const unit = w / modules;
    if (unit < 0.19) throw new Error(`The barcode "${value}" needs ${(modules * 0.19).toFixed(0)} mm of width to scan reliably; this label gives ${w.toFixed(0)} mm.`);
    let cx = x + 10 * unit;
    raw.sbs.forEach((width, i) => {
      if (i % 2 === 0) this.rect(cx, y, width * unit, h, { fill: BLACK });
      cx += width * unit;
    });
  }

  /** A QR code (for certificate verification and ID cards), with a 2-module quiet zone. */
  qr(value: string, x: number, y: number, size: number) {
    const q = bwip.raw({ bcid: 'qrcode', text: value, eclevel: 'M' } as Parameters<typeof bwip.raw>[0])[0] as { pixs: number[]; pixx: number; pixy: number };
    const unit = size / (q.pixx + 4);
    for (let r = 0; r < q.pixy; r++) {
      for (let col = 0; col < q.pixx; col++) {
        if (q.pixs[r * q.pixx + col]) this.rect(x + (col + 2) * unit, y + (r + 2) * unit, unit + 0.01, unit + 0.01, { fill: BLACK });
      }
    }
  }

  /** Thin crop marks at the corners of a box, outside it, for cutting cards from a sheet. */
  cropMarks(x: number, y: number, w: number, h: number) {
    const m = 3, g = 1;
    for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]] as const) {
      this.line(cx + dx * g, cy, cx + dx * (g + m), cy, { width: 0.15 });
      this.line(cx, cy + dy * g, cx, cy + dy * (g + m), { width: 0.15 });
    }
  }
}

export async function embedImage(doc: PDFDocument, data: Buffer | Uint8Array | null | undefined, type?: string | null) {
  if (!data) return null;
  try { return type === 'image/png' ? await doc.embedPng(data) : await doc.embedJpg(data); } catch { return null; }
}

/** Amount in words, Indian style: "One Lakh Twenty Thousand Rupees Only". */
export function rupeesInWords(paise: number) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n: number) => `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${n % 100 ? two(n % 100) : ''}`;
  let n = Math.floor(paise / 100);
  if (n === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return `${parts.join(' ')} Rupees Only`;
}

/** A date in words, as transfer certificates require: "Fourteenth June Two Thousand Thirteen". */
export function dateInWords(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const ord = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth',
    'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth', 'Twenty First', 'Twenty Second', 'Twenty Third', 'Twenty Fourth', 'Twenty Fifth', 'Twenty Sixth', 'Twenty Seventh', 'Twenty Eighth',
    'Twenty Ninth', 'Thirtieth', 'Thirty First'];
  const months = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const year = rupeesInWords(y * 100).replace(' Rupees Only', '');
  return `${ord[d]} ${months[m]} ${year}`;
}

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
