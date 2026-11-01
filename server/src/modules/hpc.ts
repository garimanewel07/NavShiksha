import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertStudentAccess, can } from './access.js';
import { sectionInfo } from './sections.js';
import * as duties from './duties.js';
import { decodeImage } from './printing.js';
import { HPC_CLASSES, HPC_TEMPLATES, type HpcItem, type HpcTemplate } from '../reference/hpcTemplates.js';

/**
 * The Holistic Progress Card for Balvatika to Class V, in the format NES prescribes: NES keeps a
 * template per class; each term the class teacher rates every item for every child; the parent
 * (or the teacher) fills "All About Me" and adds the child's drawings; the card is printed from
 * all of it with the term's attendance, height and weight and the teacher's remark, so nothing is
 * typed twice. Ratings belong to a term assessment and lock with it.
 */

export const isHpcClass = (classCode: string) => HPC_CLASSES.includes(classCode);

// ── Templates ────────────────────────────────────────────────────────────────────────────

export async function template(db: Db, classCode: string): Promise<HpcTemplate & { version: number; custom: boolean }> {
  const row = await db.maybeOne<{ body: HpcTemplate; version: number }>('select body, version from hpc_template where class_code = $1', [classCode]);
  if (row) return { ...row.body, version: row.version, custom: true };
  const d = HPC_TEMPLATES[classCode];
  if (!d) throw notFound('Holistic card template for this class');
  return { ...d, version: 0, custom: false };
}

type Rule = { kind: 'LEVEL' | 'SMILEY' | 'YESNO' | 'TEXT' } | { kind: 'CHOICE'; scale: string[] };

/** How each item is rated, by item id. */
export function rules(t: HpcTemplate) {
  const m = new Map<string, Rule & { part: string }>();
  for (const p of t.parts) {
    const add = (items: HpcItem[], r: Rule) => items.forEach((i) => m.set(i.id, { ...r, part: p.id }));
    if (p.kind === 'STARS' || p.kind === 'GOALS' || p.kind === 'SUBJECT') p.groups.forEach((g) => add(g.items, { kind: 'LEVEL' }));
    else if (p.kind === 'SMILEYS') p.groups.forEach((g) => add(g.items, { kind: 'SMILEY' }));
    else if (p.kind === 'CHOICE') add(p.items, { kind: 'CHOICE', scale: p.scale });
    else if (p.kind === 'YESNO') add(p.items, { kind: 'YESNO' });
    else add(p.items, { kind: 'TEXT' });
  }
  return m;
}

function valid(r: Rule, v: string) {
  switch (r.kind) {
    case 'LEVEL': return ['1', '2', '3', 'NA'].includes(v);
    case 'SMILEY': return ['1', '2', '3'].includes(v);
    case 'YESNO': return v === 'YES' || v === 'NO';
    case 'CHOICE': return r.scale.includes(v);
    default: return v.trim().length > 0 && v.length <= 400;
  }
}

export async function templates(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  const saved = await db.query<{ class_code: string; version: number; updated_at: string; by: string }>(
    'select t.class_code, t.version, t.updated_at, u.name as by from hpc_template t join app_user u on u.id = t.updated_by');
  const names = await db.query<{ code: string; name: string }>('select code, name from class_level where code = any($1) order by ordinal', [HPC_CLASSES]);
  return names.map((c) => {
    const s = saved.find((x) => x.class_code === c.code);
    return { classCode: c.code, className: c.name, stage: HPC_TEMPLATES[c.code].stage, custom: !!s, version: s?.version ?? 0, updatedAt: s?.updated_at ?? null, updatedBy: s?.by ?? null };
  });
}

/**
 * NES changes a class's template. Items keep their ids; new items (id '') get the next free id in
 * their part, so ratings already given stay attached to the same statement.
 */
export async function saveTemplate(db: Db, actor: Actor, classCode: string, body: HpcTemplate) {
  requireRole(actor, 'NES_ADMIN');
  if (!isHpcClass(classCode)) throw invalid('Holistic cards are for Balvatika to Class V.');
  const used = new Set<string>();
  const fresh = (prefix: string) => { let n = 1; while (used.has(`${prefix}.${n}`)) n++; const id = `${prefix}.${n}`; used.add(id); return id; };
  const claim = (id: string) => { if (used.has(id)) throw invalid(`Item ${id} appears twice in the template.`); used.add(id); };
  const partIds = new Set<string>();
  // First pass: claim the ids already given, so new ones never collide with them.
  body.parts.forEach((p) => {
    if (!/^\d{1,3}$/.test(p.id) || partIds.has(p.id)) throw invalid('Each part needs its own number.');
    partIds.add(p.id);
    const each = (it: HpcItem) => { if (it.id) { if (!new RegExp(`^${p.id}\\.\\d{1,3}(\\.\\d{1,3})?$`).test(it.id)) throw invalid(`Item ${it.id} does not belong to part ${p.id}.`); claim(it.id); } };
    if ('groups' in p) p.groups.forEach((g) => g.items.forEach(each)); else p.items.forEach(each);
  });
  body.favourites.forEach((f, i) => { f.id = `f.${i + 1}`; });
  for (const p of body.parts) {
    if ('groups' in p) p.groups.forEach((g, j) => { g.id = `${p.id}.${j + 1}`; g.items.forEach((it) => { if (!it.id) it.id = fresh(g.id); }); });
    else p.items.forEach((it) => { if (!it.id) it.id = fresh(`${p.id}.0`); });
  }
  return db.tx(async (t) => {
    await t.query(
      `insert into hpc_template (class_code, body, updated_by) values ($1, $2, $3)
       on conflict (class_code) do update set body = excluded.body, updated_by = excluded.updated_by`, [classCode, JSON.stringify(body), actor.id]);
    return template(t, classCode);
  }, { actor: actor.label });
}

/** Back to the NES default from the sample cards. */
export async function resetTemplate(db: Db, actor: Actor, classCode: string) {
  requireRole(actor, 'NES_ADMIN');
  await db.tx((t) => t.query('delete from hpc_template where class_code = $1', [classCode]), { actor: actor.label });
  return template(db, classCode);
}

// ── Terms ────────────────────────────────────────────────────────────────────────────────

export interface Term { id: string; code: string; name: string; kind: string; status: string; starts: string | null; ends: string | null; published_at: string | null; label: string; from: string; to: string }

const ROMAN = ['I', 'II', 'III', 'IV'];

/**
 * The term examinations of a school's year (Half-Yearly, Annual), each with the stretch of days it
 * covers for attendance: from the start of the year (or the day after the last term ended) to the
 * day it ended.
 */
export async function terms(db: Db, schoolId: string, year: string): Promise<Term[]> {
  const y = await db.one<{ from: string; to: string }>(`select lower(period)::text as from, (upper(period) - 1)::text as to from academic_year where code = $1`, [year]);
  const rows = await db.query<Omit<Term, 'label' | 'from' | 'to'>>(
    `select id, code, name, kind, status, starts::text, ends::text, published_at from assessment
      where school_id = $1 and academic_year = $2 and kind in ('TERM', 'ANNUAL') order by starts nulls last, code`, [schoolId, year]);
  let from = y.from;
  return rows.map((r, i) => {
    const to = r.ends ?? y.to;
    const t = { ...r, label: `TERM ${ROMAN[i] ?? i + 1}`, from, to };
    from = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return t;
  });
}

interface Assessment { id: string; school_id: string; academic_year: string; code: string; name: string; kind: string; status: string; starts: string | null; published_at: string | null }

export async function assessment(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Assessment');
  const a = await db.maybeOne<Assessment>(
    'select id, school_id, academic_year, code, name, kind, status, starts::text, published_at from assessment where id = $1', [id]);
  if (!a) throw notFound('Assessment');
  if (a.kind === 'PERIODIC') throw invalid('Holistic cards are made for the term examinations (Half-Yearly and Annual), not periodic tests.');
  return a;
}

// ── Entry by the class teacher ───────────────────────────────────────────────────────────

/** The class teacher or co-class teacher; school leadership; the exam in-charge may look. */
async function mayRate(db: Db, actor: Actor, a: Assessment, sectionId: string, write: boolean) {
  const s = await sectionInfo(db, sectionId);
  if (s.school_id !== a.school_id) throw invalid('This class is not in the school that set the assessment.');
  await assertUnitInScope(db, actor, s.school_id);
  if (!isHpcClass(s.class_code)) throw invalid('Holistic cards are for Balvatika to Class V. Older classes use the marks report card.');
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return s;
  if (actor.role === 'TEACHER' && (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id)) return s;
  if (!write && await duties.has(db, actor.id, a.school_id, 'EXAM_INCHARGE')) return s;
  throw forbidden('The holistic card is filled by the class teacher.');
}

/** The class at a glance: how far each child's card has got this term. */
export async function sheet(db: Db, actor: Actor, assessmentId: string, sectionId: string) {
  const a = await assessment(db, assessmentId);
  const s = await mayRate(db, actor, a, sectionId, false);
  const t = await template(db, s.class_code);
  const total = rules(t).size;
  const students = await db.query(
    `select e.id as enrolment_id, e.student_id, st.name, e.admission_no, e.roll_no,
            (select count(*) from hpc_rating r where r.assessment_id = $1 and r.enrolment_id = e.id)::int as rated,
            exists (select 1 from report_remark r where r.assessment_id = $1 and r.enrolment_id = e.id) as remark,
            (select count(*) from hpc_profile p cross join lateral jsonb_object_keys(p.answers) k where p.enrolment_id = e.id)::int as favourites,
            (select count(*) from hpc_photo p where p.enrolment_id = e.id)::int as photos
       from enrolment e join student st on st.id = e.student_id
      where e.section_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL', 'COMPLETED') order by e.roll_no nulls last, st.name`, [a.id, sectionId]);
  return { assessment: { id: a.id, name: a.name, status: a.status }, section: s.label, classCode: s.class_code, items: total, favourites: t.favourites.length, glimpses: t.glimpses, students };
}

/** One child's card for entry: the template, this term's ratings and the earlier terms' for reference. */
export async function child(db: Db, actor: Actor, assessmentId: string, enrolmentId: string) {
  const a = await assessment(db, assessmentId);
  const e = await enrolment(db, enrolmentId);
  const s = await mayRate(db, actor, a, e.section_id, false);
  const t = await template(db, s.class_code);
  const all = await terms(db, a.school_id, a.academic_year);
  const earlier = all.filter((x) => x.id !== a.id && (x.starts ?? '') < (a.starts ?? '9999'));
  const ratings = await db.query<{ assessment_id: string; item_id: string; value: string }>(
    'select assessment_id, item_id, value from hpc_rating where enrolment_id = $1 and assessment_id = any($2)', [enrolmentId, [a.id, ...earlier.map((x) => x.id)]]);
  const by = (id: string) => Object.fromEntries(ratings.filter((r) => r.assessment_id === id).map((r) => [r.item_id, r.value]));
  const remark = await db.maybeOne<{ remark: string }>('select remark from report_remark where assessment_id = $1 and enrolment_id = $2', [a.id, enrolmentId]);
  return {
    assessment: { id: a.id, name: a.name, status: a.status, label: all.find((x) => x.id === a.id)?.label ?? a.name },
    student: { enrolmentId, studentId: e.student_id, name: e.name, rollNo: e.roll_no, section: s.label },
    template: t, ratings: by(a.id), remark: remark?.remark ?? '',
    earlier: earlier.map((x) => ({ label: x.label, ratings: by(x.id) })),
  };
}

async function enrolment(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Student');
  const e = await db.maybeOne<{ id: string; student_id: string; section_id: string; name: string; roll_no: number | null; academic_year: string }>(
    `select e.id, e.student_id, e.section_id, st.name, e.roll_no, e.academic_year from enrolment e join student st on st.id = e.student_id where e.id = $1`, [id]);
  if (!e || !e.section_id) throw notFound('Student');
  return e;
}

/**
 * Saves some of a child's ratings for the term (null clears one) and, if given, the remark. The
 * assessment must be open; once it is locked the card is fixed.
 */
export async function save(db: Db, actor: Actor, assessmentId: string, enrolmentId: string, input: { ratings: Record<string, string | null>; remark?: string }) {
  const a = await assessment(db, assessmentId);
  const e = await enrolment(db, enrolmentId);
  const s = await mayRate(db, actor, a, e.section_id, true);
  if (a.status !== 'OPEN') throw conflict('not_open', `The ${a.name} is ${a.status.toLowerCase()}; the holistic card can no longer be changed.`);
  const r = rules(await template(db, s.class_code));
  const bad = Object.entries(input.ratings).filter(([id, v]) => !r.has(id) || (v !== null && !valid(r.get(id)!, v)));
  if (bad.length) throw invalid('Some ratings are not allowed for their items.', bad.slice(0, 10).map(([id, v]) => ({ field: id, message: `“${v}” is not a rating for this item` })));
  return db.tx(async (t) => {
    let saved = 0;
    for (const [id, v] of Object.entries(input.ratings)) {
      if (v === null) { await t.query('delete from hpc_rating where assessment_id = $1 and enrolment_id = $2 and item_id = $3', [a.id, enrolmentId, id]); continue; }
      await t.query(
        `insert into hpc_rating (assessment_id, enrolment_id, item_id, value, entered_by) values ($1, $2, $3, $4, $5)
         on conflict (assessment_id, enrolment_id, item_id) do update set value = excluded.value, entered_by = excluded.entered_by, entered_at = now()
         where hpc_rating.value <> excluded.value`, [a.id, enrolmentId, id, v.trim(), actor.id]);
      saved++;
    }
    if (input.remark !== undefined) {
      if (input.remark.trim()) await t.query(
        `insert into report_remark (assessment_id, enrolment_id, remark, entered_by) values ($1, $2, $3, $4)
         on conflict (assessment_id, enrolment_id) do update set remark = excluded.remark, entered_by = excluded.entered_by, entered_at = now()`, [a.id, enrolmentId, input.remark.trim(), actor.id]);
      else await t.query('delete from report_remark where assessment_id = $1 and enrolment_id = $2', [a.id, enrolmentId]);
    }
    const n = await t.one<{ n: number }>('select count(*)::int as n from hpc_rating where assessment_id = $1 and enrolment_id = $2', [a.id, enrolmentId]);
    return { saved, rated: n.n, of: r.size };
  }, { actor: actor.label });
}

// ── All About Me: filled by the parent or the class teacher ─────────────────────────────

async function currentEnrolment(db: Db, studentId: string) {
  const e = await db.maybeOne<{ id: string; section_id: string | null; class_code: string; school_id: string; academic_year: string }>(
    `select id, section_id, class_code, school_id, academic_year from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [studentId]);
  if (!e) throw notFound('Current enrolment');
  return e;
}

/** The parent of the child, or the class teacher (or co) of the child's class, or leadership. */
async function mayEditProfile(db: Db, actor: Actor, studentId: string, e: { section_id: string | null; school_id: string }) {
  if (actor.role === 'PARENT') { await assertStudentAccess(db, actor, studentId, 'academics'); return; }
  await assertUnitInScope(db, actor, e.school_id);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return;
  if (e.section_id) {
    const s = await sectionInfo(db, e.section_id);
    if (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id) return;
  }
  throw forbidden('“All About Me” is filled by the parent or the class teacher.');
}

export async function profile(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'academics');
  const e = await currentEnrolment(db, studentId);
  if (!isHpcClass(e.class_code)) return { applies: false as const };
  const t = await template(db, e.class_code);
  const p = await db.maybeOne<{ answers: Record<string, string>; updated_at: string; by: string }>(
    'select p.answers, p.updated_at, u.name as by from hpc_profile p join app_user u on u.id = p.updated_by where p.enrolment_id = $1', [e.id]);
  const photos = await db.query('select id, kind, caption, uploaded_at from hpc_photo where enrolment_id = $1 order by kind, uploaded_at', [e.id]);
  const hw = await db.maybeOne<{ height_cm: number | null; weight_kg: number | null; on_date: string }>(
    `select height_cm::float as height_cm, weight_kg::float as weight_kg, on_date::text from health_checkup where student_id = $1 order by on_date desc limit 1`, [studentId]);
  return { applies: true as const, favourites: t.favourites, glimpses: t.glimpses, answers: p?.answers ?? {}, updatedAt: p?.updated_at ?? null, updatedBy: p?.by ?? null, photos, lastCheckup: hw };
}

export async function saveProfile(db: Db, actor: Actor, studentId: string, answers: Record<string, string>) {
  const e = await currentEnrolment(db, studentId);
  await mayEditProfile(db, actor, studentId, e);
  const t = await template(db, e.class_code);
  const ids = new Set(t.favourites.map((f) => f.id));
  const clean = Object.fromEntries(Object.entries(answers).filter(([k, v]) => ids.has(k) && v.trim()).map(([k, v]) => [k, v.trim().slice(0, 120)]));
  await db.tx((x) => x.query(
    `insert into hpc_profile (enrolment_id, answers, updated_by) values ($1, $2, $3)
     on conflict (enrolment_id) do update set answers = excluded.answers, updated_by = excluded.updated_by, updated_at = now()`, [e.id, JSON.stringify(clean), actor.id]), { actor: actor.label });
  return { ok: true, answered: Object.keys(clean).length };
}

const PHOTO_LIMIT = { FAMILY: 1, SELF: 1, PORTFOLIO: 4 } as const;

/** A drawing or photograph for the glimpse pages. Family and self replace the earlier one. */
export async function addPhoto(db: Db, actor: Actor, studentId: string, input: { kind: keyof typeof PHOTO_LIMIT; caption?: string; dataBase64: string }) {
  const e = await currentEnrolment(db, studentId);
  await mayEditProfile(db, actor, studentId, e);
  const { buf, type } = decodeImage(input.dataBase64, 1.5);
  return db.tx(async (t) => {
    const have = await t.query<{ id: string }>('select id from hpc_photo where enrolment_id = $1 and kind = $2 order by uploaded_at', [e.id, input.kind]);
    if (input.kind !== 'PORTFOLIO') for (const h of have) await t.query('delete from hpc_photo where id = $1', [h.id]);
    else if (have.length >= PHOTO_LIMIT.PORTFOLIO) throw invalid(`The portfolio holds ${PHOTO_LIMIT.PORTFOLIO} pictures. Remove one first.`);
    return t.one<{ id: string }>(
      `insert into hpc_photo (enrolment_id, kind, caption, content_type, data, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [e.id, input.kind, (input.caption ?? '').trim().slice(0, 80), type, buf, actor.id]);
  }, { actor: actor.label });
}

async function photoRow(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Picture');
  const p = await db.maybeOne<{ id: string; student_id: string; content_type: string; data: Buffer }>(
    `select p.id, e.student_id, p.content_type, p.data from hpc_photo p join enrolment e on e.id = p.enrolment_id where p.id = $1`, [id]);
  if (!p) throw notFound('Picture');
  return p;
}

export async function photoFile(db: Db, actor: Actor, id: string) {
  const p = await photoRow(db, id);
  await assertStudentAccess(db, actor, p.student_id, 'academics');
  return { content_type: p.content_type, data: p.data };
}

export async function removePhoto(db: Db, actor: Actor, id: string) {
  const p = await photoRow(db, id);
  const e = await currentEnrolment(db, p.student_id);
  await mayEditProfile(db, actor, p.student_id, e);
  await db.tx((t) => t.query('delete from hpc_photo where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

// ── Signatures ───────────────────────────────────────────────────────────────────────────

/** A member of staff uploads their own signature for the cards they sign. */
export async function setSignature(db: Db, actor: Actor, dataBase64: string) {
  if (!actor.scopePath || actor.role === 'PARENT') throw forbidden();
  const { buf, type } = decodeImage(dataBase64, 0.25);
  await db.tx((t) => t.query(
    `insert into staff_signature (user_id, content_type, data) values ($1, $2, $3)
     on conflict (user_id) do update set content_type = excluded.content_type, data = excluded.data, uploaded_at = now()`, [actor.id, type, buf]), { actor: actor.label });
  return { ok: true };
}

export async function mySignature(db: Db, actor: Actor) {
  const s = await db.maybeOne<{ content_type: string; data: Buffer }>('select content_type, data from staff_signature where user_id = $1', [actor.id]);
  if (!s) throw notFound('Signature');
  return s;
}

export async function removeSignature(db: Db, actor: Actor) {
  await db.tx((t) => t.query('delete from staff_signature where user_id = $1', [actor.id]), { actor: actor.label });
  return { ok: true };
}

/** For printing: may this person see a section's cards (class teacher, leadership, exam in-charge)? */
export async function mayPrint(db: Db, actor: Actor, a: { id: string; school_id: string }, sectionId: string) {
  await assertUnitInScope(db, actor, a.school_id);
  if (await can(db, actor, 'results.analysis', a.school_id)) return;
  const s = await sectionInfo(db, sectionId);
  if (actor.role === 'TEACHER' && (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id)) return;
  throw forbidden('Report cards are printed by the class teacher, the exam in-charge or the principal.');
}
