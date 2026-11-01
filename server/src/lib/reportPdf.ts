import type { PDFFont } from 'pdf-lib';
import { nesEmblem, SOCIETY } from './brand.js';
import { wrap, lh } from './cardStyle.js';
import { embedImage, hex, newDocument, Sheet, type Colour } from './pdf.js';

/**
 * Plain A4 documents that flow onto as many pages as they need: minutes of a meeting, an
 * inspection report, the monthly MIS pack. Headings, paragraphs, label–value pairs and tables,
 * with the NES emblem, the title on every page and page numbers.
 */

const W = 210, H = 297, M = 16, BOTTOM = H - 18;
const INK: Colour = hex('#1D1D1F'), MUTED: Colour = hex('#6E6E73'), RULE: Colour = hex('#D2D2D7'), NAVY: Colour = hex('#0A3A66'), BAND: Colour = hex('#F2F5F9');

export interface Column { label: string; width: number; align?: 'left' | 'right' }

export class Report {
  y = M;
  sheet!: Sheet;
  private pages: Sheet[] = [];
  constructor(private doc: Awaited<ReturnType<typeof newDocument>>, private title: string, private subtitle: string, private logo: Awaited<ReturnType<typeof embedImage>>) {
    this.page();
  }
  get fonts() { return this.doc.fonts; }

  private page() {
    this.sheet = new Sheet(this.doc.doc, W, H, this.doc.fonts);
    this.pages.push(this.sheet);
    if (this.logo) this.sheet.page.drawImage(this.logo, { x: M * 72 / 25.4, y: (H - M - 12) * 72 / 25.4, width: 12 * 72 / 25.4, height: 12 * 72 / 25.4 });
    this.sheet.text(SOCIETY.toUpperCase(), M + 15, M, { size: 7.5, font: this.fonts.bold, colour: MUTED });
    this.sheet.text(this.title, M + 15, M + 3.6, { size: 13, font: this.fonts.bold, colour: NAVY, maxWidth: W - 2 * M - 15 });
    if (this.subtitle) this.sheet.text(this.subtitle, M + 15, M + 9, { size: 8.5, colour: MUTED, maxWidth: W - 2 * M - 15 });
    this.sheet.line(M, M + 15, W - M, M + 15, { colour: RULE, width: 0.3 });
    this.y = M + 20;
  }

  /** Starts a new page when fewer than `need` millimetres are left. */
  need(mm: number) { if (this.y + mm > BOTTOM) this.page(); }

  heading(text: string) {
    this.need(14);
    this.y += 2;
    this.sheet.text(text, M, this.y, { size: 11, font: this.fonts.bold, colour: INK, maxWidth: W - 2 * M });
    this.y += 6.5;
  }

  para(text: string, o: { size?: number; muted?: boolean; font?: PDFFont; indent?: number } = {}) {
    const size = o.size ?? 9.5, x = M + (o.indent ?? 0);
    for (const l of wrap(o.font ?? this.fonts.regular, text || '—', size, W - M - x)) {
      this.need(lh(size));
      this.sheet.text(l, x, this.y, { size, font: o.font ?? this.fonts.regular, colour: o.muted ? MUTED : INK });
      this.y += lh(size);
    }
    this.y += 1.5;
  }

  /** "Label  value" lines, two to a row. */
  pairs(items: [string, string][]) {
    const colW = (W - 2 * M) / 2;
    for (let i = 0; i < items.length; i += 2) {
      this.need(10);
      items.slice(i, i + 2).forEach(([k, v], j) => {
        this.sheet.text(k, M + j * colW, this.y, { size: 7.5, colour: MUTED });
        this.sheet.text(v || '—', M + j * colW, this.y + 3.4, { size: 9.5, font: this.fonts.bold, colour: INK, maxWidth: colW - 4 });
      });
      this.y += 9;
    }
    this.y += 1;
  }

  /** A table whose rows wrap and continue on the next page, repeating the header. */
  table(cols: Column[], rows: string[][], o: { size?: number } = {}) {
    const size = o.size ?? 8.5, total = cols.reduce((a, c) => a + c.width, 0), scale = (W - 2 * M) / total;
    const widths = cols.map((c) => c.width * scale);
    const header = () => {
      this.sheet.rect(M, this.y, W - 2 * M, 6.5, { fill: BAND });
      let x = M;
      cols.forEach((c, i) => { this.sheet.text(c.label, x + 1.5, this.y + 1.6, { size: 7.5, font: this.fonts.bold, colour: MUTED, maxWidth: widths[i] - 3, align: c.align === 'right' ? 'right' : 'left' }); x += widths[i]; });
      this.y += 7.5;
    };
    this.need(16); header();
    for (const r of rows) {
      const cells = r.map((v, i) => wrap(this.fonts.regular, v ?? '', size, widths[i] - 3));
      const h = Math.max(...cells.map((c) => c.length)) * lh(size) + 2;
      if (this.y + h > BOTTOM) { this.page(); header(); }
      let x = M;
      cells.forEach((c, i) => {
        c.forEach((l, k) => this.sheet.text(l, x + 1.5, this.y + 0.6 + k * lh(size), { size, colour: INK, maxWidth: widths[i] - 3, align: cols[i].align === 'right' ? 'right' : 'left' }));
        x += widths[i];
      });
      this.y += h;
      this.sheet.line(M, this.y - 0.6, W - M, this.y - 0.6, { colour: RULE, width: 0.2 });
    }
    this.y += 3;
  }

  /** Space for signatures at the end. */
  signatures(names: string[]) {
    this.need(26);
    this.y += 12;
    const w = (W - 2 * M) / Math.max(names.length, 1);
    names.forEach((n, i) => {
      this.sheet.line(M + i * w + 4, this.y, M + (i + 1) * w - 8, this.y, { colour: INK, width: 0.3 });
      this.sheet.text(n, M + i * w + 4, this.y + 1.5, { size: 8, colour: MUTED, maxWidth: w - 12 });
    });
    this.y += 10;
  }

  finish() {
    const generated = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    this.pages.forEach((p, i) => p.text(`NavShiksha · ${generated} · page ${i + 1} of ${this.pages.length}`, M, H - 11, { size: 7, colour: MUTED }));
  }
}

export async function reportPdf(title: string, subtitle: string, build: (r: Report) => void | Promise<void>) {
  const doc = await newDocument(title);
  const logo = await embedImage(doc.doc, nesEmblem().data, 'image/png').catch(() => null);
  const r = new Report(doc, title, subtitle, logo);
  await build(r);
  r.finish();
  return Buffer.from(await doc.doc.save());
}
