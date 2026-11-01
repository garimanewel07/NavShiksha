import type { PDFDocument, PDFImage } from 'pdf-lib';
import type { Db } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import { embedImage, newDocument, Sheet } from '../lib/pdf.js';
import { localToday } from '../lib/dates.js';
import {
  A4, background, band, cardFonts, cell, closing, cover, draft, lh, lines, mid, NAVY, PAPER, plant, smiley, stars, tag, tick, title, wrap, WHITE, INK, CELL,
  type CardFonts,
} from '../lib/cardStyle.js';
import { hex } from '../lib/pdf.js';
import * as printing from './printing.js';
import { HPC_CLASSES, type HpcGroup, type HpcPart, type HpcTemplate } from '../reference/hpcTemplates.js';
import { template, terms as yearTerms, type Term } from './hpc.js';

/**
 * Prints Holistic Progress Cards in the schools' own format, for any term: the cover, All About
 * Me, the glimpse pages, every part of the class's template with a column per term so far (Term I
 * on the half-yearly card, Terms I and II on the annual card), then attendance, the teacher's
 * remarks, signatures and the key to the symbols.
 */

const X = 8, W = 194, TOP = 10, LIMIT = 286;

interface Kid {
  enrolment_id: string; student_id: string; section_id: string | null; name: string; dob: string; admission_no: string; roll_no: number | null;
  class_code: string; section: string | null; father: string | null; mother: string | null; class_teacher: string | null;
}
interface Photo { enrolment_id: string; kind: string; caption: string; content_type: string; data: Buffer }

const fmt = (iso: string | null | undefined, style: 'dmy' | 'dMony' = 'dmy') => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return style === 'dmy' ? `${d}-${m}-${y}` : `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}-${y}`;
};
const ROMAN: Record<string, string> = { BV1: 'I', BV2: 'II', BV3: 'III' };
const classSection = (k: Kid) => (ROMAN[k.class_code] ? `Balvatika-${ROMAN[k.class_code]}` : k.class_code) + (k.section ? ` ${k.section}` : '');
const titleCase = (t: string) => t.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

async function gather(db: Db, a: { school_id: string; academic_year: string }, cols: Term[], where: { sectionId?: string; studentId?: string }) {
  const kids = await db.query<Kid>(
    `select e.id as enrolment_id, e.student_id, e.section_id, st.name, st.dob::text, e.admission_no, e.roll_no, e.class_code, sec.name as section,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'FATHER' limit 1) as father,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'MOTHER' limit 1) as mother,
            case when e.section_id is not null then class_teacher_of(e.section_id) end as class_teacher
       from enrolment e join student st on st.id = e.student_id left join section sec on sec.id = e.section_id
      where e.school_id = $1 and e.academic_year = $2 and e.class_code = any($3) and e.status in ('ACTIVE', 'PROVISIONAL', 'COMPLETED')
        and ($4::uuid is null or e.section_id = $4) and ($5::uuid is null or e.student_id = $5)
      order by e.roll_no nulls last, st.name`, [a.school_id, a.academic_year, HPC_CLASSES, where.sectionId ?? null, where.studentId ?? null]);
  const ids = kids.map((k) => k.enrolment_id), sids = kids.map((k) => k.student_id), tids = cols.map((t) => t.id);
  const ratings = await db.query<{ assessment_id: string; enrolment_id: string; item_id: string; value: string }>(
    'select assessment_id, enrolment_id, item_id, value from hpc_rating where assessment_id = any($1) and enrolment_id = any($2)', [tids, ids]);
  const remarks = await db.query<{ assessment_id: string; enrolment_id: string; remark: string }>(
    'select assessment_id, enrolment_id, remark from report_remark where assessment_id = any($1) and enrolment_id = any($2)', [tids, ids]);
  const profiles = await db.query<{ enrolment_id: string; answers: Record<string, string> }>('select enrolment_id, answers from hpc_profile where enrolment_id = any($1)', [ids]);
  const photos = await db.query<Photo>('select enrolment_id, kind, caption, content_type, data from hpc_photo where enrolment_id = any($1) order by uploaded_at', [ids]);
  const from = cols[0]?.from ?? '1900-01-01', to = cols[cols.length - 1]?.to ?? '9999-12-31';
  const marks = await db.query<{ enrolment_id: string; on_date: string; status: string }>(
    `select m.enrolment_id, s.on_date::text, m.status from attendance_mark m join attendance_session s on s.id = m.session_id
      where m.enrolment_id = any($1) and s.on_date between $2 and $3`, [ids, from, to]);
  const checkups = await db.query<{ student_id: string; on_date: string; height_cm: number | null; weight_kg: number | null }>(
    `select student_id, on_date::text, height_cm::float as height_cm, weight_kg::float as weight_kg from health_checkup
      where student_id = any($1) and on_date <= $2 order by on_date`, [sids, to]);
  const teachers = [...new Set(kids.map((k) => k.class_teacher).filter(Boolean))] as string[];
  const signatures = await db.query<{ user_id: string; content_type: string; data: Buffer }>('select user_id, content_type, data from staff_signature where user_id = any($1)', [teachers]);
  return { kids, ratings, remarks, profiles, photos, marks, checkups, signatures };
}

type Data = Awaited<ReturnType<typeof gather>>;

interface Ctx {
  doc: PDFDocument; f: CardFonts; cols: Term[]; isDraft: boolean; school: string; logo: PDFImage | null; art: PDFImage | null; principal: PDFImage | null;
  teacherSign: Map<string, PDFImage | null>; date: string; session: string;
}

/** Pages flow one after another; a page that fills up continues on a new one of the same kind. */
class Flow {
  s!: Sheet; y = TOP; kind: 'light' | 'sky' = 'sky';
  constructor(private c: Ctx) {}
  page(kind: 'light' | 'sky') {
    this.s = new Sheet(this.c.doc, A4.w, A4.h, { regular: this.c.f.body, bold: this.c.f.bold, serif: this.c.f.serif, serifBold: this.c.f.serifBold, mono: this.c.f.body });
    background(this.s, kind);
    this.kind = kind; this.y = TOP;
  }
  /** Makes room for h; on a new page, `again` redraws the table heading. Returns true if it broke. */
  fit(h: number, again?: () => void) {
    if (this.y + h <= LIMIT) return false;
    this.page(this.kind); again?.(); return true;
  }
}

// ── Rating symbols in a cell ─────────────────────────────────────────────────────────────

type Symbol = 'STARS' | 'PLANTS' | 'SMILEYS';
function rating(c: Ctx, s: Sheet, kind: Symbol, v: string | undefined, x: number, y: number, w: number, h: number) {
  if (!v) return;
  if (v === 'NA') { s.text('N/A', x, mid(y, h, 8.5), { size: 8.5, font: c.f.bold, colour: INK, maxWidth: w, align: 'centre' }); return; }
  const n = Number(v), cx = x + w / 2, cy = y + h / 2;
  if (kind === 'STARS') stars(s, n, cx, cy, Math.min(1.9, h / 3.6));
  else if (kind === 'PLANTS') plant(s, n, cx, cy, Math.min(5.6, h - 1));
  else smiley(s, n, cx, cy, Math.min(2.3, h / 2.8));
}

/** Term heading cells to the right of a heading row. */
function termHeads(c: Ctx, s: Sheet, y: number, h: number, tw: number, o: { navy: boolean; font?: 'serif' | 'body' }) {
  c.cols.forEach((t, i) => {
    const x = X + W - (c.cols.length - i) * tw;
    if (o.navy) s.rect(x, y, tw, h, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 }); else cell(s, x, y, tw, h);
    s.text(t.label, x, mid(y, h, 10), { size: 10, font: o.font === 'serif' ? c.f.serif : c.f.body, colour: o.navy ? WHITE : INK, maxWidth: tw, align: 'centre' });
  });
}

// ── Parts ────────────────────────────────────────────────────────────────────────────────

/** Balvatika: a developmental goal, its domains in navy bars, indicators rated in stars. */
function starsPart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'STARS' }>, no: number, r: (id: string, t: number) => string | undefined) {
  const tw = 24, textW = W - c.cols.length * tw;
  fl.fit(40);
  fl.y += tag(fl.s, c.f, `${no}. ${p.tag}`, X, fl.y) + 1;
  p.groups.forEach((g, j) => {
    const head = (contd = false) => {
      band(fl.s, c.f, `${j + 1}. ${g.title}${contd ? ' (contd.)' : ''}`, X, fl.y, W, 10, { size: 12 }); fl.y += 10;
      fl.s.rect(X, fl.y, textW, 6.5, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 });
      termHeads(c, fl.s, fl.y, 6.5, tw, { navy: true }); fl.y += 6.5;
    };
    fl.fit(30); head();
    for (const it of g.items) {
      const ls = wrap(c.f.body, it.text, 9, textW - 4), h = Math.max(6.5, ls.length * lh(9) + 2.6);
      fl.fit(h, () => head(true));
      cell(fl.s, X, fl.y, textW, h); lines(fl.s, ls, X + 2, mid(fl.y, h, 9) - (ls.length - 1) * lh(9) / 2, { size: 9, font: c.f.body });
      c.cols.forEach((_, t) => { const x = X + textW + t * tw; cell(fl.s, x, fl.y, tw, h); rating(c, fl.s, 'STARS', r(it.id, t), x, fl.y, tw, h); });
      fl.y += h;
    }
    fl.y += 1.2;
  });
  fl.y += 2;
}

/** Classes I and II: curriculum goals, numbered indicators rated as plants. */
function goalsPart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'GOALS' }>, r: (id: string, t: number) => string | undefined) {
  const tw = 30, textW = W - c.cols.length * tw;
  fl.fit(40);
  fl.y += tag(fl.s, c.f, p.tag, X, fl.y) + 1;
  p.groups.forEach((g, j) => {
    const head = () => {
      cell(fl.s, X, fl.y, W, 9); fl.s.text(`${j + 1}. ${g.title}`, X, mid(fl.y, 9, 11.5), { size: 11.5, font: c.f.serifBold, colour: INK, maxWidth: W, align: 'centre', minSize: 8 }); fl.y += 9;
      cell(fl.s, X, fl.y, textW, 9); fl.s.text('Subject', X, mid(fl.y, 9, 11), { size: 11, font: c.f.serifBold, colour: INK, maxWidth: textW, align: 'centre' });
      termHeads(c, fl.s, fl.y, 9, tw, { navy: false, font: 'serif' }); fl.y += 9;
    };
    fl.fit(30); head();
    g.items.forEach((it, k) => {
      const ls = wrap(c.f.body, `${k + 1}. ${it.text}`, 9.5, textW - 4), h = Math.max(6.5, ls.length * lh(9.5) + 2.4);
      fl.fit(h, head);
      cell(fl.s, X, fl.y, textW, h); lines(fl.s, ls, X + 2, mid(fl.y, h, 9.5) - (ls.length - 1) * lh(9.5) / 2, { size: 9.5, font: c.f.body });
      c.cols.forEach((_, t) => { const x = X + textW + t * tw; cell(fl.s, x, fl.y, tw, h); rating(c, fl.s, 'PLANTS', r(it.id, t), x, fl.y, tw, h); });
      fl.y += h;
    });
    fl.y += 1.5;
  });
}

/**
 * Classes III to V, Part B: a subject in a navy bar, then each curricular goal (CG) on the left
 * against its competencies, rated as plants; observations are the same table answered YES/NO.
 */
function subjectPart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'SUBJECT' | 'YESNO' }>, no: number, r: (id: string, t: number) => string | undefined) {
  const tw = 22, CGW = 74, CW = W - CGW - c.cols.length * tw;
  const groups: (HpcGroup & { cg: string })[] = p.kind === 'SUBJECT'
    ? p.groups.map((g, j) => ({ ...g, cg: `CG ${j + 1} ${g.title}` }))
    : [{ id: p.id, title: p.title, items: p.items, cg: titleCase(p.title.replace(/-/g, ' ')) }];
  const word = p.kind === 'SUBJECT' ? 'Competencies' : 'Observations';
  const head = (contd = false) => {
    band(fl.s, c.f, `${p.title}${contd ? ' (contd.)' : ''}`, X, fl.y, W, 8.5, { align: 'left', size: 11 }); fl.y += 8.5;
    cell(fl.s, X, fl.y, CGW + CW, 7.5); fl.s.text(`${no} ${word}`, X, mid(fl.y, 7.5, 11), { size: 11, font: c.f.serifBold, colour: INK, maxWidth: CGW + CW, align: 'centre' });
    termHeads(c, fl.s, fl.y, 7.5, tw, { navy: false, font: 'serif' }); fl.y += 7.5;
  };
  fl.fit(45);
  if ('tag' in p && p.tag) fl.y += tag(fl.s, c.f, p.tag, X, fl.y, { centre: true }) + 2;
  head();
  for (const g of groups) {
    const cg = wrap(c.f.body, g.cg, 9.5, CGW - 5), cgH = cg.length * lh(9.5) + 5;
    const rows = g.items.map((it) => { const ls = wrap(c.f.body, it.text, 8.5, CW - 4); return { it, ls, h: Math.max(6.5, ls.length * lh(8.5) + 2.6) }; });
    const total = rows.reduce((t, x) => t + x.h, 0);
    if (cgH > total) rows[rows.length - 1].h += cgH - total;
    const sum = Math.max(total, cgH);
    if (fl.y + sum > LIMIT && sum <= LIMIT - TOP - 16) { fl.page(fl.kind); head(true); }
    let start = fl.y;
    const flush = () => {
      const h = fl.y - start; if (h <= 0) return;
      cell(fl.s, X, start, CGW, h);
      const fit = cg.slice(0, Math.max(1, Math.floor((h - 3) / lh(9.5))));
      lines(fl.s, fit, X + 2.5, start + (h - fit.length * lh(9.5)) / 2 + 0.6, { size: 9.5, font: c.f.body });
    };
    for (const row of rows) {
      if (fl.y + row.h > LIMIT) { flush(); fl.page(fl.kind); head(true); start = fl.y; }
      const cx = X + CGW;
      cell(fl.s, cx, fl.y, CW, row.h); lines(fl.s, row.ls, cx + 2, fl.y + 1.6, { size: 8.5, font: c.f.body });
      c.cols.forEach((_, t) => {
        const x = X + CGW + CW + t * tw; cell(fl.s, x, fl.y, tw, row.h);
        const v = r(row.it.id, t);
        if (p.kind === 'YESNO') { if (v) fl.s.text(v, x, mid(fl.y, row.h, 9.5), { size: 9.5, font: c.f.bold, colour: INK, maxWidth: tw, align: 'centre' }); }
        else rating(c, fl.s, 'PLANTS', v, x, fl.y, tw, row.h);
      });
      fl.y += row.h;
    }
    flush();
  }
  fl.y += 3;
}

/** Part A (how I feel at school) and Part C (peer feedback): a tick under one of the scale's answers. */
function choicePart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'CHOICE' }>, r: (id: string, t: number) => string | undefined) {
  fl.page('light');
  if (p.tag) fl.y += tag(fl.s, c.f, p.tag, X, fl.y, { centre: true }) + 3;
  const sw = p.scale.map((l) => Math.max(fl.s.width(l, 9, c.f.body) + 5, 10));
  const per = sw.reduce((a, b) => a + b, 0), qW = W - per * c.cols.length, hh = 9;
  const s = fl.s;
  s.rect(X, fl.y, qW, hh * 2, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 });
  s.text(p.title, X + 2, mid(fl.y, hh * 2, 12.5), { size: 12.5, font: c.f.bold, colour: WHITE, maxWidth: qW - 4, align: 'centre', minSize: 9 });
  c.cols.forEach((t, i) => {
    let x = X + qW + i * per;
    s.rect(x, fl.y, per, hh, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 });
    s.text(t.label, x, mid(fl.y, hh, 9.5), { size: 9.5, font: c.f.body, colour: WHITE, maxWidth: per, align: 'centre' });
    p.scale.forEach((l, k) => { s.rect(x, fl.y + hh, sw[k], hh, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 }); s.text(l, x, mid(fl.y + hh, hh, 9), { size: 9, font: c.f.body, colour: WHITE, maxWidth: sw[k], align: 'centre' }); x += sw[k]; });
  });
  fl.y += hh * 2;
  p.items.forEach((it, n) => {
    const ls = wrap(c.f.body, `${n + 1}. ${it.text}`, 9.5, qW - 4), h = Math.max(13, ls.length * lh(9.5) + 6);
    fl.fit(h);
    cell(fl.s, X, fl.y, qW, h); lines(fl.s, ls, X + 2, mid(fl.y, h, 9.5) - (ls.length - 1) * lh(9.5) / 2, { size: 9.5, font: c.f.body });
    c.cols.forEach((_, t) => {
      let x = X + qW + t * per;
      const v = r(it.id, t);
      p.scale.forEach((l, k) => { cell(fl.s, x, fl.y, sw[k], h); if (v === l) tick(fl.s, x + sw[k] / 2, fl.y + h / 2, 3.2); x += sw[k]; });
    });
    fl.y += h;
  });
}

/** Self and peer assessment (Classes I and II): activities rated in smileys. */
function smileysPart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'SMILEYS' }>, r: (id: string, t: number) => string | undefined) {
  fl.page('light');
  title(fl.s, c.f, p.title, fl.y, 26); fl.y += 14;
  const tw = 30, SW = 44, AW = W - SW - c.cols.length * tw;
  const head = () => {
    for (const [x, w, l] of [[X, SW, 'Subject'], [X + SW, AW, 'Activity']] as [number, number, string][]) {
      fl.s.rect(x, fl.y, w, 8, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 }); fl.s.text(l, x, mid(fl.y, 8, 11), { size: 11, font: c.f.body, colour: WHITE, maxWidth: w, align: 'centre' });
    }
    termHeads(c, fl.s, fl.y, 8, tw, { navy: true }); fl.y += 8;
  };
  head();
  for (const g of p.groups) {
    const rows = g.items.map((it, k) => { const ls = wrap(c.f.body, `${k + 1}. ${it.text}`, 10, AW - 4); return { it, ls, h: Math.max(6.8, ls.length * lh(10) + 2.4) }; });
    const sum = rows.reduce((t, x) => t + x.h, 0);
    fl.fit(sum, head);
    const start = fl.y;
    for (const row of rows) {
      cell(fl.s, X + SW, fl.y, AW, row.h); lines(fl.s, row.ls, X + SW + 2, mid(fl.y, row.h, 10) - (row.ls.length - 1) * lh(10) / 2, { size: 10, font: c.f.body });
      c.cols.forEach((_, t) => { const x = X + SW + AW + t * tw; cell(fl.s, x, fl.y, tw, row.h); rating(c, fl.s, 'SMILEYS', r(row.it.id, t), x, fl.y, tw, row.h); });
      fl.y += row.h;
    }
    cell(fl.s, X, start, SW, sum);
    const ls = wrap(c.f.body, g.title, 10, SW - 4);
    lines(fl.s, ls, X + 2, start + (sum - ls.length * lh(10)) / 2 + 0.6, { size: 10, font: c.f.body });
  }
}

/** Learner feedback: the child's own answers each term. */
function textPart(c: Ctx, fl: Flow, p: Extract<HpcPart, { kind: 'TEXT' }>, r: (id: string, t: number) => string | undefined) {
  fl.page('light');
  title(fl.s, c.f, p.title, fl.y, 26); fl.y += 14;
  const QW = 70, aw = (W - QW) / c.cols.length;
  fl.s.rect(X, fl.y, QW, 8, { fill: NAVY, stroke: hex('#7FC4EA'), width: 0.3 });
  termHeads(c, fl.s, fl.y, 8, aw, { navy: true }); fl.y += 8;
  for (const it of p.items) {
    const q = wrap(c.f.bold, it.text, 10, QW - 4);
    const ans = c.cols.map((_, t) => wrap(c.f.body, r(it.id, t) ?? '', 10, aw - 4));
    const h = Math.max(14, Math.max(q.length, ...ans.map((a) => a.length)) * lh(10) + 5);
    fl.fit(h);
    cell(fl.s, X, fl.y, QW, h, PAPER); lines(fl.s, q, X + 2, fl.y + 2.5, { size: 10, font: c.f.bold });
    ans.forEach((a, t) => { const x = X + QW + t * aw; cell(fl.s, x, fl.y, aw, h, PAPER); lines(fl.s, a, x + 2, fl.y + 2.5, { size: 10, font: c.f.body }); });
    fl.y += h;
  }
}

// ── Front pages ──────────────────────────────────────────────────────────────────────────

function aboutMe(c: Ctx, fl: Flow, k: Kid, t: HpcTemplate, answers: Record<string, string>, hw: { height: number | null; weight: number | null }[]) {
  fl.page('light');
  const s = fl.s;
  title(s, c.f, 'All About Me', 9, 30);
  const facts: [string, string][] = [["Student's Name", k.name.toUpperCase()], ["Father's Name", (k.father ?? '').toUpperCase()], ["Mother's Name", (k.mother ?? '').toUpperCase()],
    ['Date of Birth', fmt(k.dob)], ['Admission No.', k.admission_no], ['Class & Section', classSection(k)], ['Roll No.', k.roll_no ? String(k.roll_no) : '']];
  const favs = t.favourites.map((q) => ({ q: wrap(c.f.body, q.text, 10.5, 52), a: wrap(c.f.body, answers[q.id] ?? '', 10.5, 100) }));
  const favH = favs.length ? 16 + favs.reduce((h, x) => h + Math.max(x.q.length, x.a.length, 1) * lh(10.5) + 4.5, 0) : 0;
  const panelH = 14 + facts.length * 9.5 + favH + 6;
  s.roundRect(14, 30, 182, panelH + 8, 5, { fill: WHITE, opacity: 0.7 });
  s.roundRect(18, 34, 174, panelH, 4, { fill: PAPER });
  let y = 44;
  for (const [l, v] of facts) {
    s.text(l, 26, y, { size: 10.5, font: c.f.body, colour: INK });
    s.text(v, 86, y, { size: 10.5, font: c.f.bold, colour: INK, maxWidth: 98, minSize: 7.5 });
    s.line(86, y + 5.2, 184, y + 5.2, { colour: INK, width: 0.4 }); y += 9.5;
  }
  if (favs.length) {
    y += 4; s.text('My Favourites', 18, y, { size: 16, font: c.f.display, colour: NAVY, maxWidth: 174, align: 'centre' }); y += 12;
    for (const x of favs) {
      const h = Math.max(x.q.length, x.a.length, 1) * lh(10.5);
      lines(s, x.q, 26, y, { size: 10.5, font: c.f.body }); lines(s, x.a, 86, y, { size: 10.5, font: c.f.body });
      s.line(86, y + h + 0.6, 184, y + h + 0.6, { colour: INK, width: 0.4 }); y += h + 4.5;
    }
  }
  // Height and weight each term, from the school's health check-ups.
  const by = Math.min(34 + panelH + 14, 246);
  c.cols.forEach((term, i) => {
    const bx = 14 + i * 94;
    s.roundRect(bx, by, 88, 38, 3, { fill: hex('#9BCFF2') });
    s.text(term.label, bx, by + 5, { size: 18, font: c.f.display, colour: NAVY, maxWidth: 88, align: 'centre' });
    for (const [j, [l, v, u]] of ([['My Height is', hw[i]?.height, 'cm.'], ['My Weight is', hw[i]?.weight, 'kg.']] as [string, number | null, string][]).entries()) {
      const ly = by + 19 + j * 8;
      s.text(l, bx + 6, ly, { size: 10.5, font: c.f.body, colour: INK });
      const vx = bx + 7 + s.width(l, 10.5, c.f.body);
      s.text(v != null ? `${v}${u.replace('.', '')}` : '', vx + 1, ly, { size: 10.5, font: c.f.body, colour: INK });
      s.line(vx, ly + 5, vx + 18, ly + 5, { colour: INK, width: 0.4 });
      s.text('.', vx + 18.5, ly, { size: 10.5, font: c.f.body, colour: INK });
    }
  });
}

async function glimpses(c: Ctx, fl: Flow, t: HpcTemplate, photos: Photo[]) {
  if (!t.glimpses.length) return;
  const img = async (p: Photo | undefined) => (p ? embedImage(c.doc, p.data, p.content_type) : null);
  const panel = (s: Sheet, x: number, y: number, w: number, h: number, ims: (PDFImage | null)[]) => {
    s.roundRect(x, y, w, h, 4, { fill: WHITE, opacity: 0.7 });
    s.roundRect(x + 4, y + 4, w - 8, h - 8, 4, { fill: PAPER });
    const list = ims.filter(Boolean) as PDFImage[];
    if (!list.length) { s.text('Drawing or photograph to be pasted here', x + 4, y + h / 2 - 2, { size: 9, font: c.f.body, colour: hex('#8AA9BF'), maxWidth: w - 8, align: 'centre' }); return; }
    const n = list.length, cols = n > 1 ? 2 : 1, rows = Math.ceil(n / cols), cw = (w - 16) / cols, ch = (h - 16) / rows;
    list.forEach((im, i) => s.image(im, x + 8 + (i % cols) * cw + 1, y + 8 + Math.floor(i / cols) * ch + 1, cw - 2, ch - 2));
  };
  const family = await img(photos.find((p) => p.kind === 'FAMILY'));
  const self = await img(photos.find((p) => p.kind === 'SELF'));
  const portfolio = await Promise.all(photos.filter((p) => p.kind === 'PORTFOLIO').map((p) => img(p)));
  fl.page('light');
  const s = fl.s;
  if (t.glimpses.includes('FAMILY')) {
    title(s, c.f, 'A Glimpse of my family', 8, 26); panel(s, 14, 24, 182, 118, [family]);
    const both = t.glimpses.includes('PORTFOLIO');
    s.text('A Glimpse of myself', 12, 150, { size: 15, font: c.f.display, colour: NAVY, maxWidth: both ? 90 : 186, align: 'centre' });
    panel(s, 12, 160, both ? 90 : 186, 112, [self]);
    if (both) { s.text('My Portfolio', 108, 150, { size: 15, font: c.f.display, colour: NAVY, maxWidth: 90, align: 'centre' }); panel(s, 108, 160, 90, 112, portfolio); }
  } else {
    title(s, c.f, 'A Glimpse of myself', 8, 28);
    const withPortfolio = t.glimpses.includes('PORTFOLIO') && portfolio.length;
    panel(s, 14, 26, 182, withPortfolio ? 150 : 246, [self]);
    if (withPortfolio) { s.text('My Portfolio', 14, 182, { size: 15, font: c.f.display, colour: NAVY, maxWidth: 182, align: 'centre' }); panel(s, 14, 192, 182, 90, portfolio); }
  }
}

// ── The key to the symbols ───────────────────────────────────────────────────────────────

const LEVELS: [string, string, string][] = [
  ['BEGINNER', '1', 'The student is at the beginning stage of target competency and needs a great deal of support and handholding.'],
  ['PROGRESSING', '2', 'The student is able to meet some part of target competency independently but needs some (occasional) support and handholding.'],
  ['PROFICIENT', '3', 'The student is able to meet target competency independently without any support.'],
  ['NOT ASSESSED', 'NA', 'Parameters that were not assessed have been marked as N/A.'],
];

function key(c: Ctx, fl: Flow, t: HpcTemplate) {
  const kinds = new Set(t.parts.map((p) => p.kind));
  const tables: { name: string; sym: Symbol; rows: [string, string, string][] }[] = [];
  if (kinds.has('STARS')) tables.push({ name: 'Grade Scale', sym: 'STARS', rows: LEVELS });
  if (kinds.has('GOALS') || kinds.has('SUBJECT')) tables.push({ name: 'Key to the plants', sym: 'PLANTS', rows: LEVELS });
  if (kinds.has('SMILEYS')) tables.push({ name: 'Key to the smileys', sym: 'SMILEYS', rows: [['YES, A LOT', '3', 'I enjoy it or do it a lot.'], ['SOMETIMES', '2', 'Sometimes.'], ['NOT REALLY', '1', 'Not really, or not yet.']] });
  for (const tb of tables) {
    fl.fit(14 + tb.rows.length * 13);
    fl.y += 5;
    band(fl.s, c.f, tb.name, X, fl.y, W, 8, { size: 12 }); fl.y += 8;
    for (const [l, h] of [['Grade', 46], ['Explanation', W - 46]] as [string, number][]) { const x = l === 'Grade' ? X : X + 46; cell(fl.s, x, fl.y, h, 7, CELL); fl.s.text(l, x, mid(fl.y, 7, 10.5), { size: 10.5, font: c.f.serifBold, colour: INK, maxWidth: h, align: 'centre' }); }
    fl.y += 7;
    for (const [label, v, text] of tb.rows) {
      const ls = wrap(c.f.body, text, 9.5, W - 50), h = Math.max(13, ls.length * lh(9.5) + 4);
      cell(fl.s, X, fl.y, 46, h); cell(fl.s, X + 46, fl.y, W - 46, h);
      fl.s.text(label, X, fl.y + 2, { size: 9.5, font: c.f.bold, colour: INK, maxWidth: 46, align: 'centre' });
      rating(c, fl.s, tb.sym, v, X, fl.y + 5, 46, h - 5);
      lines(fl.s, ls, X + 48, mid(fl.y, h, 9.5) - (ls.length - 1) * lh(9.5) / 2, { size: 9.5, font: c.f.body });
      fl.y += h;
    }
  }
}

// ── One child's card ─────────────────────────────────────────────────────────────────────

async function card(c: Ctx, d: Data, k: Kid, t: HpcTemplate) {
  const ratings = d.ratings.filter((r) => r.enrolment_id === k.enrolment_id);
  const r = (id: string, ti: number) => ratings.find((x) => x.assessment_id === c.cols[ti].id && x.item_id === id)?.value;
  const fl = new Flow(c);

  fl.page('light');
  const s = fl.s;
  s.rect(0, 0, A4.w, A4.h, { fill: WHITE });
  cover(s, c.f, { school: c.school.toUpperCase(), heading: 'Holistic Progress Card', logo: c.logo, art: c.art, session: c.session,
    fields: [['Name', k.name.toUpperCase()], ['Roll Number', k.roll_no ? String(k.roll_no) : ''], ['Class/Section', classSection(k)], ['Admission No.', k.admission_no]] });

  const checks = d.checkups.filter((x) => x.student_id === k.student_id);
  const hw = c.cols.map((term) => {
    const inTerm = checks.filter((x) => x.on_date >= term.from && x.on_date <= term.to);
    const pick = (inTerm.length ? inTerm : checks.filter((x) => x.on_date <= term.to && x.on_date >= c.cols[0].from)).at(-1);
    return { height: pick?.height_cm ?? null, weight: pick?.weight_kg ?? null };
  });
  aboutMe(c, fl, k, t, d.profiles.find((p) => p.enrolment_id === k.enrolment_id)?.answers ?? {}, hw);
  await glimpses(c, fl, t, d.photos.filter((p) => p.enrolment_id === k.enrolment_id));

  let goal = 0, subject = 0, onSky = false;
  const sky = () => { if (!onSky) { fl.page('sky'); onSky = true; } };
  for (const p of t.parts) {
    if (p.kind === 'STARS') { sky(); starsPart(c, fl, p, ++goal, r); }
    else if (p.kind === 'GOALS') { sky(); goalsPart(c, fl, p, r); }
    else if (p.kind === 'SUBJECT' || p.kind === 'YESNO') { if (p.tag) onSky = false; sky(); subjectPart(c, fl, p, ++subject, r); }
    else {
      onSky = false;
      if (p.kind === 'CHOICE') choicePart(c, fl, p, r); else if (p.kind === 'SMILEYS') smileysPart(c, fl, p, r); else textPart(c, fl, p, r);
    }
  }

  fl.page('light');
  const mine = d.marks.filter((m) => m.enrolment_id === k.enrolment_id);
  fl.y = closing(fl.s, c.f, TOP + 2, c.cols.map((term) => {
    const days = mine.filter((m) => m.on_date >= term.from && m.on_date <= term.to);
    return { label: term.label, days: days.length, present: days.filter((m) => m.status === 'P').length,
      remark: d.remarks.find((x) => x.assessment_id === term.id && x.enrolment_id === k.enrolment_id)?.remark ?? null };
  }), { date: c.date, teacher: k.class_teacher ? c.teacherSign.get(k.class_teacher) ?? null : null, principal: c.principal });
  key(c, fl, t);
}

/**
 * The cards for a section or one child, for the chosen term. Parents get published terms only;
 * staff may print a draft (marked as such) while the term is still being filled in.
 */
export async function render(db: Db, a: { id: string; school_id: string; academic_year: string; starts: string | null; status: string; published_at: string | null; name: string },
  where: { sectionId?: string; studentId?: string }, o: { publishedOnly: boolean }) {
  const all = await yearTerms(db, a.school_id, a.academic_year);
  const cols = all.filter((t) => (t.starts ?? '') <= (a.starts ?? '9999') && (!o.publishedOnly || t.status === 'PUBLISHED'));
  if (!cols.some((t) => t.id === a.id)) throw notFound('Published results for this term');
  const d = await gather(db, a, cols, where);
  if (!d.kids.length) throw notFound('Children in Balvatika to Class V');
  const { doc, fonts } = await newDocument(`Holistic Progress Cards · ${a.name}`);
  const f = await cardFonts(doc, fonts);
  const raw = await printing.assets(db, a.school_id);
  const head = await printing.schoolHeader(db, a.school_id);
  const teacherSign = new Map<string, PDFImage | null>();
  for (const sg of d.signatures) teacherSign.set(sg.user_id, await embedImage(doc, sg.data, sg.content_type));
  const c: Ctx = {
    doc, f, cols, isDraft: a.status !== 'PUBLISHED', school: head.name,
    logo: await embedImage(doc, raw.LOGO?.data, raw.LOGO?.type), art: await embedImage(doc, raw.HPC_COVER?.data, raw.HPC_COVER?.type),
    principal: await embedImage(doc, raw.SIGNATURE?.data, raw.SIGNATURE?.type), teacherSign,
    date: fmt(a.published_at ? new Date(a.published_at).toISOString() : localToday(), 'dMony'),
    session: `${a.academic_year.slice(0, 4)}-${a.academic_year.slice(0, 2)}${a.academic_year.slice(5)}`,
  };
  const templates = new Map<string, HpcTemplate>();
  for (const k of d.kids) {
    if (!templates.has(k.class_code)) templates.set(k.class_code, await template(db, k.class_code));
    await card(c, d, k, templates.get(k.class_code)!);
  }
  // Drawn last so it lies over the tables, on every page.
  if (c.isDraft) for (const page of doc.getPages()) draft({ page } as Sheet, f);
  return { pdf: Buffer.from(await doc.save()), count: d.kids.length };
}

