import type { PDFDocument, PDFImage } from 'pdf-lib';
import type { Db } from '../db/client.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { embedImage, hex, newDocument, Sheet } from '../lib/pdf.js';
import { A4, background, band, cardFonts, cell, closing, cover, INK, mid, NAVY, PAPER, TAG, tag, title, WHITE, type CardFonts } from '../lib/cardStyle.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertStudentAccess, can } from './access.js';
import { sectionInfo } from './sections.js';
import * as printing from './printing.js';
import { localToday } from '../lib/dates.js';
import * as hpc from './hpc.js';
import * as hpcCard from './hpcCard.js';

/**
 * Report cards for Classes VI to XII from published results only, in the same look as the
 * Holistic Progress Cards (Balvatika to Class V go to hpcCard): the cover; All About Me; Part A,
 * every published exam of the year up to the one chosen side by side by subject with the weighted
 * result so far; Part B, the co-scholastic areas per term; then attendance and the teacher's remark
 * per term, signatures and the grading scale. Nothing on a report card is typed: it all comes from
 * records already kept and marks that were locked and published.
 */

interface Exam { id: string; code: string; name: string; starts: string | null; ends: string | null; weight: number; scale: string }
interface Child { enrolment_id: string; student_id: string; name: string; dob: string; admission_no: string; roll_no: number | null; class_code: string; class_name: string; section: string | null; father: string | null; mother: string | null; class_teacher: string | null }
interface ResultRow { assessment_id: string; student_id: string; percentage: number; grade: string; rank_section: number | null; obtained: number; max_total: number; section_size: number;
  subjects: { code: string; name: string; marks: number | null; max: number; absent: boolean; grade: string }[] }

const LEVEL: Record<string, string> = { BEGINNER: 'Beginner', PROGRESSING: 'Progressing', PROFICIENT: 'Proficient', ADVANCED: 'Advanced' };

async function exam(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Assessment');
  const a = await db.maybeOne<Exam & { school_id: string; academic_year: string; status: string; published_at: string | null }>(
    `select id, code, name, starts::text, ends::text, weight::float as weight, scale, school_id, academic_year, status, published_at from assessment where id = $1`, [id]);
  if (!a) throw notFound('Assessment');
  if (a.status !== 'PUBLISHED') throw conflict('not_published', 'Report cards are made from published results. Publish the results first.');
  return a;
}

/** The class teacher (or co-class teacher), school leadership, the exam in-charge, NES. */
async function mayPrintClass(db: Db, actor: Actor, schoolId: string, sectionId: string) {
  await assertUnitInScope(db, actor, schoolId);
  if (await can(db, actor, 'results.analysis', schoolId)) return;
  const s = await sectionInfo(db, sectionId);
  if (actor.role === 'TEACHER' && (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id)) return;
  throw forbidden('Report cards are printed by the class teacher, the exam in-charge or the principal.');
}

async function gather(db: Db, a: Exam & { school_id: string; academic_year: string }, where: { sectionId?: string; studentId?: string }) {
  const exams = await db.query<Exam>(
    `select id, code, name, starts::text, ends::text, weight::float as weight, scale from assessment
      where school_id = $1 and academic_year = $2 and status = 'PUBLISHED' and coalesce(starts, '1900-01-01') <= coalesce($3::date, '9999-12-31') order by starts nulls first, code`,
    [a.school_id, a.academic_year, a.starts]);
  const children = await db.query<Child>(
    `select r.enrolment_id, e.student_id, st.name, st.dob::text, e.admission_no, e.roll_no, r.class_code, cl.name as class_name, sec.name as section,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'FATHER' limit 1) as father,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'MOTHER' limit 1) as mother,
            case when r.section_id is not null then class_teacher_of(r.section_id) end as class_teacher
       from result r join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id join class_level cl on cl.code = r.class_code
       left join section sec on sec.id = r.section_id
      where r.assessment_id = $1 and ($2::uuid is null or r.section_id = $2) and ($3::uuid is null or e.student_id = $3)
      order by e.roll_no nulls last, st.name`, [a.id, where.sectionId ?? null, where.studentId ?? null]);
  const ids = children.map((c) => c.student_id), eids = children.map((c) => c.enrolment_id);
  const results = await db.query<ResultRow>(
    `select r.assessment_id, e.student_id, r.percentage::float as percentage, r.grade, r.rank_section, r.obtained::float as obtained, r.max_total::float as max_total, r.subjects,
            (select count(*) from result x where x.assessment_id = r.assessment_id and x.section_id = r.section_id)::int as section_size
       from result r join enrolment e on e.id = r.enrolment_id where r.assessment_id = any($1) and e.student_id = any($2)`, [exams.map((x) => x.id), ids]);
  // The term examinations so far: a column each for co-scholastic areas, attendance and remarks.
  const terms = (await hpc.terms(db, a.school_id, a.academic_year)).filter((t) => t.status === 'PUBLISHED' && (t.starts ?? '') <= (a.starts ?? '9999'));
  const termIds = terms.some((t) => t.id === a.id) ? terms.map((t) => t.id) : [...terms.map((t) => t.id), a.id];
  const hpcRows = await db.query<{ assessment_id: string; student_id: string; domain: string; level: string }>(
    `select h.assessment_id, e.student_id, d.name as domain, h.level from hpc_entry h join enrolment e on e.id = h.enrolment_id join hpc_domain d on d.code = h.domain_code
      where h.assessment_id = any($1) and e.student_id = any($2) order by d.ordinal`, [termIds, ids]);
  const remarks = await db.query<{ assessment_id: string; student_id: string; remark: string }>(
    `select r.assessment_id, e.student_id, r.remark from report_remark r join enrolment e on e.id = r.enrolment_id where r.assessment_id = any($1) and e.student_id = any($2)`, [termIds, ids]);
  const marks = await db.query<{ enrolment_id: string; on_date: string; status: string }>(
    `select m.enrolment_id, s.on_date::text, m.status from attendance_mark m join attendance_session s on s.id = m.session_id
      where m.enrolment_id = any($1) and s.on_date <= coalesce($2::date, current_date)`, [eids, a.ends]);
  const checkups = await db.query<{ student_id: string; on_date: string; height_cm: number | null; weight_kg: number | null }>(
    `select student_id, on_date::text, height_cm::float as height_cm, weight_kg::float as weight_kg from health_checkup where student_id = any($1) order by on_date`, [ids]);
  const teachers = [...new Set(children.map((c) => c.class_teacher).filter(Boolean))] as string[];
  const signatures = await db.query<{ user_id: string; content_type: string; data: Buffer }>('select user_id, content_type, data from staff_signature where user_id = any($1)', [teachers]);
  const scale = await db.query<{ grade: string; min_pct: number }>('select grade, min_pct::float as min_pct from grade_band where scale = $1 order by min_pct desc', [a.scale]);
  return { exams, children, results, terms, hpc: hpcRows, remarks, marks, checkups, signatures, scale };
}

type Data = Awaited<ReturnType<typeof gather>>;
interface Ctx { doc: PDFDocument; f: CardFonts; school: string; logo: PDFImage | null; art: PDFImage | null; principal: PDFImage | null; signs: Map<string, PDFImage | null>; year: string; date: string }

const fmt = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
const newPage = (c: Ctx, kind: 'light' | 'sky') => { const s = new Sheet(c.doc, A4.w, A4.h, { regular: c.f.body, bold: c.f.bold, serif: c.f.serif, serifBold: c.f.serifBold, mono: c.f.body }); background(s, kind); return s; };
const X = 8, W = 194;

/** One child: the cover, All About Me, results, co-scholastic areas, attendance, remarks and signatures. */
function card(c: Ctx, child: Child, d: Data, chosen: Exam) {
  const cls = `${child.class_code}${child.section ? ` ${child.section}` : ''}`;
  const termLabels = d.terms.length ? d.terms : [{ id: chosen.id, label: 'TERM I', from: '1900-01-01', to: chosen.ends ?? '9999-12-31' }];
  // Cover.
  const s0 = new Sheet(c.doc, A4.w, A4.h, { regular: c.f.body, bold: c.f.bold, serif: c.f.serif, serifBold: c.f.serifBold, mono: c.f.body });
  cover(s0, c.f, { school: c.school.toUpperCase(), heading: 'Progress Report Card', logo: c.logo, art: c.art, session: `${c.year.slice(0, 4)}-${c.year.slice(0, 2)}${c.year.slice(5)}`,
    fields: [['Name', child.name.toUpperCase()], ['Roll Number', child.roll_no ? String(child.roll_no) : ''], ['Class/Section', cls], ['Admission No.', child.admission_no]] });

  // All About Me: the records already kept, with height and weight from the health check-ups.
  const s1 = newPage(c, 'light');
  title(s1, c.f, 'All About Me', 9, 30);
  const facts: [string, string][] = [["Student's Name", child.name.toUpperCase()], ["Father's Name", (child.father ?? '').toUpperCase()], ["Mother's Name", (child.mother ?? '').toUpperCase()],
    ['Date of Birth', fmt(child.dob)], ['Admission No.', child.admission_no], ['Class & Section', cls], ['Roll No.', child.roll_no ? String(child.roll_no) : '']];
  s1.roundRect(14, 30, 182, 92, 5, { fill: WHITE, opacity: 0.7 });
  s1.roundRect(18, 34, 174, 84, 4, { fill: PAPER });
  facts.forEach(([l, v], i) => {
    const y = 44 + i * 10;
    s1.text(l, 26, y, { size: 10.5, font: c.f.body, colour: INK });
    s1.text(v, 86, y, { size: 10.5, font: c.f.bold, colour: INK, maxWidth: 98, minSize: 7.5 });
    s1.line(86, y + 5.2, 184, y + 5.2, { colour: INK, width: 0.4 });
  });
  const checks = d.checkups.filter((x) => x.student_id === child.student_id);
  termLabels.forEach((t, i) => {
    const pick = checks.filter((x) => x.on_date <= t.to).at(-1), bx = 14 + i * 94, by = 136;
    s1.roundRect(bx, by, 88, 38, 3, { fill: hex('#9BCFF2') });
    s1.text(t.label, bx, by + 5, { size: 18, font: c.f.display, colour: NAVY, maxWidth: 88, align: 'centre' });
    s1.text(`My Height is ${pick?.height_cm ?? '____'} cm.`, bx + 6, by + 19, { size: 10.5, font: c.f.body, colour: INK });
    s1.text(`My Weight is ${pick?.weight_kg ?? '____'} kg.`, bx + 6, by + 27, { size: 10.5, font: c.f.body, colour: INK });
  });

  // Part A: scholastic areas, every published exam so far side by side.
  const s = newPage(c, 'sky');
  let y = 10;
  y += tag(s, c.f, 'Part A · Scholastic Areas', X, y, { centre: true }) + 3;
  const mine = d.exams.map((e) => d.results.find((r) => r.assessment_id === e.id && r.student_id === child.student_id) ?? null);
  const subjects: { code: string; name: string }[] = [];
  for (const r of mine) for (const sj of r?.subjects ?? []) if (!subjects.some((z) => z.code === sj.code)) subjects.push({ code: sj.code, name: sj.name });
  const subjW = 52, gradeW = 22, colW = (W - subjW - gradeW) / Math.max(d.exams.length, 1);
  band(s, c.f, 'Subject', X, y, subjW, 12, { size: 10.5 });
  d.exams.forEach((e, i) => {
    const max = mine[i]?.subjects[0]?.max;
    band(s, c.f, '', X + subjW + i * colW, y, colW, 12);
    s.text(e.name.replace(' Examination', ''), X + subjW + i * colW, y + 2, { size: 8.5, font: c.f.bold, colour: WHITE, maxWidth: colW - 1, align: 'centre', minSize: 6 });
    s.text(max ? `out of ${max}${e.weight ? ` · ${e.weight}%` : ''}` : '', X + subjW + i * colW, y + 7, { size: 7, font: c.f.body, colour: WHITE, maxWidth: colW - 1, align: 'centre' });
  });
  band(s, c.f, `Grade (${chosen.code})`, X + W - gradeW, y, gradeW, 12, { size: 8.5 });
  y += 12;
  const chosenRes = mine[mine.length - 1];
  for (const sj of subjects) {
    cell(s, X, y, subjW, 7); s.text(sj.name, X + 2, mid(y, 7, 9.5), { size: 9.5, font: c.f.body, colour: INK, maxWidth: subjW - 4 });
    mine.forEach((r, i) => {
      const m = r?.subjects.find((z) => z.code === sj.code);
      cell(s, X + subjW + i * colW, y, colW, 7);
      s.text(!m ? '—' : m.absent ? 'AB' : String(m.marks), X + subjW + i * colW, mid(y, 7, 9.5), { size: 9.5, font: m?.absent ? c.f.bold : c.f.body, colour: INK, maxWidth: colW, align: 'centre' });
    });
    cell(s, X + W - gradeW, y, gradeW, 7);
    s.text(chosenRes?.subjects.find((z) => z.code === sj.code)?.grade ?? '—', X + W - gradeW, mid(y, 7, 9.5), { size: 9.5, font: c.f.bold, colour: INK, maxWidth: gradeW, align: 'centre' });
    y += 7;
  }
  const foot: [string, (r: ResultRow | null) => string][] = [
    ['Total', (r) => (r ? `${r.obtained} / ${r.max_total}` : '—')], ['Percentage', (r) => (r ? `${r.percentage.toFixed(1)}%` : '—')],
    ['Overall grade', (r) => r?.grade ?? '—'], ['Rank in section', (r) => (r?.rank_section ? `${r.rank_section} of ${r.section_size}` : '—')]];
  for (const [label, fn] of foot) {
    cell(s, X, y, subjW, 7, TAG); s.text(label, X + 2, mid(y, 7, 9.5), { size: 9.5, font: c.f.bold, colour: INK, maxWidth: subjW - 4 });
    mine.forEach((r, i) => { cell(s, X + subjW + i * colW, y, colW, 7, TAG); s.text(fn(r), X + subjW + i * colW, mid(y, 7, 9.5), { size: 9.5, font: c.f.bold, colour: INK, maxWidth: colW - 1, align: 'centre', minSize: 7 }); });
    cell(s, X + W - gradeW, y, gradeW, 7, TAG);
    y += 7;
  }
  const weighted = d.exams.map((e, i) => ({ e, r: mine[i] })).filter((z) => z.e.weight > 0 && z.r);
  const wsum = weighted.reduce((t, z) => t + z.e.weight, 0);
  if (wsum > 0) {
    const pct = weighted.reduce((t, z) => t + z.e.weight * z.r!.percentage, 0) / wsum;
    y += 3;
    cell(s, X, y, W, 9, PAPER);
    s.text(`Weighted result so far: ${pct.toFixed(1)}%  ·  grade ${d.scale.find((g) => pct >= g.min_pct)?.grade ?? '—'}   (${weighted.map((z) => `${z.e.code} ${z.e.weight}%`).join(', ')} of the final result)`,
      X + 3, mid(y, 9, 9.5), { size: 9.5, font: c.f.bold, colour: NAVY, maxWidth: W - 6, minSize: 7 });
    y += 9;
  }

  // Part B: co-scholastic areas, a column per term.
  y += 8;
  y += tag(s, c.f, 'Part B · Co-Scholastic Areas', X, y, { centre: true }) + 3;
  const domains = [...new Set(d.hpc.filter((h) => h.student_id === child.student_id).map((h) => h.domain))];
  const tw = 30, dw = W - termLabels.length * tw;
  band(s, c.f, 'Area', X, y, dw, 8, { size: 10.5 });
  termLabels.forEach((t, i) => band(s, c.f, t.label, X + dw + i * tw, y, tw, 8, { size: 10 }));
  y += 8;
  if (!domains.length) { cell(s, X, y, W, 7); s.text('Not recorded.', X + 2, mid(y, 7, 9.5), { size: 9.5, font: c.f.body, colour: INK }); y += 7; }
  for (const dm of domains) {
    cell(s, X, y, dw, 7); s.text(dm, X + 2, mid(y, 7, 9.5), { size: 9.5, font: c.f.body, colour: INK, maxWidth: dw - 4 });
    termLabels.forEach((t, i) => {
      const lv = d.hpc.find((h) => h.student_id === child.student_id && h.assessment_id === t.id && h.domain === dm)?.level;
      cell(s, X + dw + i * tw, y, tw, 7);
      s.text(lv ? (LEVEL[lv] ?? lv) : '—', X + dw + i * tw, mid(y, 7, 9), { size: 9, font: c.f.bold, colour: INK, maxWidth: tw, align: 'centre' });
    });
    y += 7;
  }

  // Attendance, remarks, signatures and the grading scale.
  const end = newPage(c, 'light');
  const mineDays = d.marks.filter((m) => m.enrolment_id === child.enrolment_id);
  let ey = closing(end, c.f, 12, termLabels.map((t) => {
    const days = mineDays.filter((m) => m.on_date >= t.from && m.on_date <= t.to);
    return { label: t.label, days: days.length, present: days.filter((m) => m.status === 'P').length,
      remark: d.remarks.find((r) => r.assessment_id === t.id && r.student_id === child.student_id)?.remark ?? null };
  }), { date: c.date, teacher: child.class_teacher ? c.signs.get(child.class_teacher) ?? null : null, principal: c.principal });
  ey += 6;
  band(end, c.f, 'Grading Scale', X, ey, W, 8, { size: 12 }); ey += 8;
  const gw = W / Math.max(d.scale.length, 1);
  d.scale.forEach((g, i) => {
    cell(end, X + i * gw, ey, gw, 7, TAG); end.text(g.grade, X + i * gw, mid(ey, 7, 10), { size: 10, font: c.f.serifBold, colour: INK, maxWidth: gw, align: 'centre' });
    cell(end, X + i * gw, ey + 7, gw, 7); end.text(`${g.min_pct}–${i === 0 ? 100 : d.scale[i - 1].min_pct - 1}`, X + i * gw, mid(ey + 7, 7, 9), { size: 9, font: c.f.body, colour: INK, maxWidth: gw, align: 'centre' });
  });
  end.text('AB: absent. Results as published by the school.', X, ey + 17, { size: 8, font: c.f.body, colour: INK });
}

async function render(db: Db, a: Exam & { school_id: string; academic_year: string; published_at?: string | null }, d: Data) {
  if (!d.children.length) throw notFound('Results for these children');
  const { doc, fonts } = await newDocument(`Report cards · ${a.name}`);
  const f = await cardFonts(doc, fonts);
  const raw = await printing.assets(db, a.school_id);
  const signs = new Map<string, PDFImage | null>();
  for (const sg of d.signatures) signs.set(sg.user_id, await embedImage(doc, sg.data, sg.content_type));
  const when = a.published_at ? new Date(a.published_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : localToday();
  const [yy, mm, dd] = when.split('-');
  const ctx: Ctx = { doc, f, school: (await printing.schoolHeader(db, a.school_id)).name, year: a.academic_year, signs,
    date: `${dd}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1]}-${yy}`,
    logo: await embedImage(doc, raw.LOGO?.data, raw.LOGO?.type), art: await embedImage(doc, raw.HPC_COVER?.data, raw.HPC_COVER?.type),
    principal: await embedImage(doc, raw.SIGNATURE?.data, raw.SIGNATURE?.type) };
  for (const c of d.children) card(ctx, c, d, a);
  return { pdf: Buffer.from(await doc.save()), count: d.children.length };
}

/** A whole section's report cards in one PDF (or chosen children), for printing. */
export async function forSection(db: Db, actor: Actor, assessmentId: string, sectionId: string) {
  // Balvatika to Class V get the Holistic Progress Card; staff may print it as a draft before publishing.
  if (hpc.isHpcClass((await sectionInfo(db, sectionId)).class_code)) {
    const h = await hpc.assessment(db, assessmentId);
    await mayPrintClass(db, actor, h.school_id, sectionId);
    return hpcCard.render(db, h, { sectionId }, { publishedOnly: false });
  }
  const a = await exam(db, assessmentId);
  await mayPrintClass(db, actor, a.school_id, sectionId);
  return render(db, a, await gather(db, a, { sectionId }));
}

/** One child's report card: the parent in the app, or staff who may see the child's marks. */
export async function forStudent(db: Db, actor: Actor, studentId: string, assessmentId: string) {
  await assertStudentAccess(db, actor, studentId, 'academics');
  const cls = /^[0-9a-f-]{36}$/i.test(assessmentId) ? await db.maybeOne<{ class_code: string }>(
    `select e.class_code from enrolment e join assessment a on a.school_id = e.school_id and a.academic_year = e.academic_year
      where a.id = $1 and e.student_id = $2 order by lower(e.period) desc limit 1`, [assessmentId, studentId]) : null;
  if (cls && hpc.isHpcClass(cls.class_code)) {
    const h = await hpc.assessment(db, assessmentId);
    return hpcCard.render(db, h, { studentId }, { publishedOnly: !actor.scopePath || actor.role === 'PARENT' || h.status === 'PUBLISHED' });
  }
  const a = await exam(db, assessmentId);
  return render(db, a, await gather(db, a, { studentId }));
}
