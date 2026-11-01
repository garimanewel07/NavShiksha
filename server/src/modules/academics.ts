import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertCan, assertStudentAccess, can } from './access.js';
import { assertTeaches, sectionInfo } from './sections.js';
import * as duties from './duties.js';
import * as notify from './notify.js';
import { ASSESSMENT_PLAN, SUBJECTS_BY_CLASS } from '../reference/nes-defaults.js';
import { HPC_CLASSES } from '../reference/hpcTemplates.js';

interface Assessment { id: string; school_id: string; academic_year: string; code: string; name: string; status: string; scale: string; weight: number }

async function load(db: Db, id: string): Promise<Assessment> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Assessment');
  const a = await db.maybeOne<Assessment>('select id, school_id, academic_year, code, name, status, scale, weight::float as weight from assessment where id = $1', [id]);
  if (!a) throw notFound('Assessment');
  return a;
}

async function leader(db: Db, actor: Actor, schoolId: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
}

/** Exam set-up, marks progress and locking: school leadership or the exam in-charge. */
async function examDesk(db: Db, actor: Actor, schoolId: string) {
  await duties.assertLeaderOrDuty(db, actor, schoolId, 'EXAM_INCHARGE');
}

// ── Setting up exams ──────────────────────────────────────────────────────────────────────

export async function list(db: Db, actor: Actor, schoolId: string, year: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select a.id, a.code, a.name, a.kind, a.weight::float as weight, a.status, a.starts::text, a.ends::text, a.published_at,
            (select count(*) from assessment_paper p where p.assessment_id = a.id)::int as papers,
            (select count(*) from mark m where m.assessment_id = a.id)::int as marks_entered,
            (select count(*) from enrolment e join assessment_paper p on p.class_code = e.class_code and p.assessment_id = a.id
              where e.school_id = a.school_id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))::int as marks_expected
       from assessment a where a.school_id = $1 and a.academic_year = $2 order by a.starts nulls last, a.code`, [schoolId, year]);
}

/** One exam with its progress, for its own page. */
export async function one(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await assertUnitInScope(db, actor, a.school_id);
  const row = ((await list(db, actor, a.school_id, a.academic_year)) as { id: string }[]).find((x) => x.id === id);
  return { ...row, school_id: a.school_id, academic_year: a.academic_year };
}

/** Creates one assessment from the NES plan, with papers for every class the school teaches. */
export async function createFromPlan(db: Db, actor: Actor, schoolId: string, year: string, code: string) {
  await examDesk(db, actor, schoolId);
  const plan = ASSESSMENT_PLAN.find((p) => p.code === code);
  if (!plan) throw invalid('Unknown assessment in the NES plan.');
  return db.tx(async (t) => {
    const a = await t.one<{ id: string }>(
      `insert into assessment (school_id, academic_year, code, name, kind, weight, starts, ends, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [schoolId, year, plan.code, plan.name, plan.kind, plan.weight, plan.starts, plan.ends, actor.id]);
    const classes = await t.query<{ class_code: string }>(
      `select distinct s.class_code from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1 and s.academic_year = $2`, [schoolId, year]);
    let papers = 0;
    for (const { class_code } of classes) {
      for (const subj of SUBJECTS_BY_CLASS[class_code] ?? []) {
        await t.query(`insert into assessment_paper (assessment_id, class_code, subject_code, max_marks) values ($1, $2, $3, $4)`, [a.id, class_code, subj, plan.maxMarks]);
        papers++;
      }
    }
    return { id: a.id, papers };
  }, { actor: actor.label });
}

export async function papers(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await assertUnitInScope(db, actor, a.school_id);
  return db.query(
    `select p.class_code, cl.name as class_name, p.subject_code, sj.name as subject, p.max_marks::float as max_marks, p.exam_date::text
       from assessment_paper p join class_level cl on cl.code = p.class_code join subject sj on sj.code = p.subject_code
      where p.assessment_id = $1 order by cl.ordinal, sj.name`, [id]);
}

export async function setPaper(db: Db, actor: Actor, id: string, input: { classCode: string; subjectCode: string; maxMarks: number | null; examDate?: string | null }) {
  const a = await load(db, id);
  await examDesk(db, actor, a.school_id);
  await db.tx(async (t) => {
    if (input.maxMarks === null) await t.query('delete from assessment_paper where assessment_id = $1 and class_code = $2 and subject_code = $3', [id, input.classCode, input.subjectCode]);
    else await t.query(
      `insert into assessment_paper (assessment_id, class_code, subject_code, max_marks, exam_date) values ($1, $2, $3, $4, $5)
       on conflict (assessment_id, class_code, subject_code) do update set max_marks = excluded.max_marks, exam_date = excluded.exam_date`,
      [id, input.classCode, input.subjectCode, input.maxMarks, input.examDate ?? null]);
  }, { actor: actor.label });
  return { ok: true };
}

/** What is still missing before an assessment can be locked: section × subject with gaps. */
export async function progress(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await assertUnitInScope(db, actor, a.school_id);
  return db.query(
    `select s.id as section_id, s.class_code, s.name as section, p.subject_code, sj.name as subject,
            count(e.id)::int as strength, count(m.enrolment_id)::int as entered,
            (select u.name from timetable t join timetable_slot x on x.timetable_id = t.id join app_user u on u.id = x.teacher_id
              where t.section_id = s.id and t.valid @> current_date and x.subject_code = p.subject_code limit 1) as teacher
       from assessment_paper p
       join section s on s.class_code = p.class_code and s.academic_year = $2
       join org_unit c on c.id = s.campus_id and c.parent_id = $3
       join class_level cl on cl.code = s.class_code join subject sj on sj.code = p.subject_code
       left join enrolment e on e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
       left join mark m on m.assessment_id = p.assessment_id and m.enrolment_id = e.id and m.subject_code = p.subject_code
      where p.assessment_id = $1
      group by s.id, s.class_code, s.name, cl.ordinal, p.subject_code, sj.name
      order by cl.ordinal, s.name, sj.name`, [id, a.academic_year, a.school_id]);
}

export async function open(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await examDesk(db, actor, a.school_id);
  await db.tx((t) => t.query(`update assessment set status = 'OPEN' where id = $1`, [id]), { actor: actor.label });
  return { status: 'OPEN' };
}

/** Locks marks entry. Refused while any child is missing a mark (enter Absent if they missed it). */
export async function lock(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await examDesk(db, actor, a.school_id);
  const gaps = (await progress(db, actor, id) as { strength: number; entered: number; class_code: string; section: string; subject: string }[])
    .filter((r) => r.entered < r.strength);
  if (gaps.length) throw invalid(`Marks are missing in ${gaps.length} class papers.`, gaps.slice(0, 10).map((g) => ({ field: `${g.class_code}-${g.section}`, message: `${g.subject}: ${g.strength - g.entered} missing` })));
  const { get } = await import('./settings.js');
  if (await get<boolean>(db, a.school_id, 'exams.moderation_required')) {
    const unmod = await db.one<{ n: number }>(
      `select count(*)::int as n from assessment_paper p join section s on s.class_code = p.class_code and s.academic_year = $2 join org_unit c on c.id = s.campus_id and c.parent_id = $3
        where p.assessment_id = $1 and exists (select 1 from enrolment e where e.section_id = s.id and upper_inf(e.period))
          and not exists (select 1 from marks_sheet m where m.assessment_id = p.assessment_id and m.section_id = s.id and m.subject_code = p.subject_code and m.status = 'MODERATED')`, [id, a.academic_year, a.school_id]);
    if (unmod.n) throw invalid(`${unmod.n} marks sheets have not been moderated yet.`);
  }
  await db.tx((t) => t.query(`update assessment set status = 'LOCKED', locked_by = $2, locked_at = now() where id = $1`, [id, actor.id]), { actor: actor.label });
  return { status: 'LOCKED' };
}

export async function reopen(db: Db, actor: Actor, id: string, reason: string) {
  const a = await load(db, id);
  await examDesk(db, actor, a.school_id);
  await db.tx(async (t) => {
    await t.query(`update assessment set status = 'OPEN', locked_by = null, locked_at = null where id = $1`, [id]);
    await t.query(`insert into assessment_reopen (assessment_id, reason, reopened_by) values ($1, $2, $3)`, [id, reason.trim(), actor.id]);
  }, { actor: actor.label });
  return { status: 'OPEN' };
}

/**
 * Publishes results: computes every child's total, percentage, grade and rank once, stores them
 * permanently, and tells parents. After this nothing about the assessment can change.
 */
export async function publish(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await leader(db, actor, a.school_id);
  if (a.status !== 'LOCKED') throw invalid('Lock the marks before publishing results.');
  return db.tx(async (t) => {
    await t.query(
      `with m as (
         select mk.enrolment_id, e.class_code, e.section_id, mk.subject_code, sj.name, mk.marks, mk.absent, p.max_marks
           from mark mk join enrolment e on e.id = mk.enrolment_id join subject sj on sj.code = mk.subject_code
           join assessment_paper p on p.assessment_id = mk.assessment_id and p.class_code = e.class_code and p.subject_code = mk.subject_code
          where mk.assessment_id = $1),
       agg as (
         select enrolment_id, class_code, section_id, sum(coalesce(marks, 0)) as obtained, sum(max_marks) as max_total,
                jsonb_agg(jsonb_build_object('code', subject_code, 'name', name, 'marks', marks, 'max', max_marks, 'absent', absent,
                  'pct', round(coalesce(marks, 0) * 100 / max_marks, 1), 'grade', grade_for($2, coalesce(marks, 0) * 100 / max_marks)) order by name) as subjects
           from m group by 1, 2, 3)
       insert into result (assessment_id, enrolment_id, section_id, class_code, obtained, max_total, percentage, grade, rank_section, rank_class, subjects)
       select $1, enrolment_id, section_id, class_code, obtained, max_total, round(obtained * 100 / max_total, 2),
              grade_for($2, obtained * 100 / max_total),
              rank() over (partition by section_id order by obtained * 100 / max_total desc),
              rank() over (partition by class_code order by obtained * 100 / max_total desc), subjects
         from agg`, [id, a.scale]);
    await t.query(`update assessment set status = 'PUBLISHED', published_by = $2, published_at = now() where id = $1`, [id, actor.id]);
    const kids = await t.query<{ student_id: string }>(`select e.student_id from result r join enrolment e on e.id = r.enrolment_id where r.assessment_id = $1`, [id]);
    const notified = await notify.toParentsOf(t, kids.map((k) => k.student_id), { kind: 'RESULT', title: `${a.name} results are out`, body: 'See marks, grades and the report card in the app.', link: '/results' });
    return { status: 'PUBLISHED', results: kids.length, notified };
  }, { actor: actor.label });
}

/** The NES plan for the year, and which of its exams this school has already set up. */
export async function planFor(db: Db, actor: Actor, schoolId: string, year: string) {
  await assertUnitInScope(db, actor, schoolId);
  const have = new Set((await db.query<{ code: string }>('select code from assessment where school_id = $1 and academic_year = $2', [schoolId, year])).map((r) => r.code));
  return ASSESSMENT_PLAN.map((p) => ({ ...p, created: have.has(p.code) }));
}

/** A child's exam date sheet: papers of their class in exams not yet published, with dates set. */
export async function examSchedule(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'academics');
  return db.query(
    `select a.name as assessment, a.code, a.status, p.exam_date::text as date, sj.name as subject, p.max_marks::float as max_marks
       from enrolment e join assessment a on a.school_id = e.school_id and a.academic_year = e.academic_year and a.status <> 'PUBLISHED'
       join assessment_paper p on p.assessment_id = a.id and p.class_code = e.class_code join subject sj on sj.code = p.subject_code
      where e.student_id = $1 and upper_inf(e.period) and e.status in ('ACTIVE', 'PROVISIONAL')
      order by a.starts nulls last, p.exam_date nulls last, sj.name`, [studentId]);
}

/** Report cards a class teacher fills in: the holistic card and remarks for their class, for every open exam. */
export async function myCards(db: Db, actor: Actor) {
  // Balvatika to Class V fill the Holistic Progress Card (term examinations only); older classes the domain card.
  return db.query(
    `select a.id as assessment_id, a.name as assessment, a.status, s.id as section_id, s.class_code, s.name as section, ct.kind,
            s.class_code = any($2) as holistic,
            (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))::int as strength,
            case when s.class_code = any($2)
              then (select count(distinct h.enrolment_id) from hpc_rating h join enrolment e on e.id = h.enrolment_id where h.assessment_id = a.id and e.section_id = s.id)
              else (select count(distinct h.enrolment_id) from hpc_entry h join enrolment e on e.id = h.enrolment_id where h.assessment_id = a.id and e.section_id = s.id) end::int as cards_started,
            (select count(*) from report_remark r join enrolment e on e.id = r.enrolment_id where r.assessment_id = a.id and e.section_id = s.id)::int as remarks
       from class_teacher ct join section s on s.id = ct.section_id join org_unit c on c.id = s.campus_id
       join assessment a on a.school_id = c.parent_id and a.academic_year = s.academic_year and a.status in ('OPEN', 'LOCKED', 'PUBLISHED')
       join class_level cl on cl.code = s.class_code
      where ct.user_id = $1 and ct.valid @> current_date and (a.kind <> 'PERIODIC' or not s.class_code = any($2))
      order by a.starts desc nulls last, cl.ordinal, s.name`, [actor.id, HPC_CLASSES]);
}

// ── Marks entry ───────────────────────────────────────────────────────────────────────────

/** Subject teacher (from the timetable), the class teacher, or school leadership. */
async function assertCanMark(db: Db, actor: Actor, a: Assessment, sectionId: string, subjectCode: string | null) {
  const s = await sectionInfo(db, sectionId);
  if (s.school_id !== a.school_id) throw invalid('This class is not in the school that set the assessment.');
  await assertUnitInScope(db, actor, s.school_id);
  if (actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN') return s;
  if (actor.role !== 'TEACHER') throw forbidden();
  if (subjectCode && (await duties.has(db, actor.id, a.school_id, 'EXAM_INCHARGE'))) return s;   // moderating
  // The class teacher (or co-class teacher) writes the holistic card and remarks; subject marks
  // are entered only by the teacher of that subject.
  if (!subjectCode && (s.class_teacher_id === actor.id || s.co_class_teacher_id === actor.id)) return s;
  if (subjectCode) {
    const teaches = await db.maybeOne(
      `select 1 from timetable t join timetable_slot x on x.timetable_id = t.id
        where t.section_id = $1 and t.valid @> current_date and x.teacher_id = $2 and x.subject_code = $3 limit 1`, [sectionId, actor.id, subjectCode]);
    if (teaches) return s;
  }
  throw forbidden('You do not teach this subject to this class.');
}

/** Papers a teacher should mark: every open assessment × the subjects they teach in each section. */
export async function mySheets(db: Db, actor: Actor) {
  return db.query(
    `with mine as (
       select distinct t.section_id, x.subject_code from timetable t join timetable_slot x on x.timetable_id = t.id
        where t.valid @> current_date and x.teacher_id = $1)
     select a.id as assessment_id, a.name as assessment, a.status, s.id as section_id, s.class_code, s.name as section, p.subject_code, sj.name as subject, p.max_marks::float as max_marks,
            (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))::int as strength,
            (select count(*) from mark m join enrolment e on e.id = m.enrolment_id where m.assessment_id = a.id and m.subject_code = p.subject_code and e.section_id = s.id)::int as entered
       from mine join section s on s.id = mine.section_id join org_unit c on c.id = s.campus_id
       join assessment a on a.school_id = c.parent_id and a.academic_year = s.academic_year and a.status in ('OPEN', 'LOCKED')
       join assessment_paper p on p.assessment_id = a.id and p.class_code = s.class_code and p.subject_code = mine.subject_code
       join subject sj on sj.code = p.subject_code join class_level cl on cl.code = s.class_code
      order by a.starts, cl.ordinal, s.name, sj.name`, [actor.id]);
}

export async function sheet(db: Db, actor: Actor, id: string, sectionId: string, subjectCode: string) {
  const a = await load(db, id);
  const s = await assertCanMark(db, actor, a, sectionId, subjectCode);
  const paper = await db.maybeOne<{ max_marks: number }>('select max_marks::float as max_marks from assessment_paper where assessment_id = $1 and class_code = $2 and subject_code = $3', [id, s.class_code, subjectCode]);
  if (!paper) throw notFound('Paper');
  const students = await db.query(
    `select e.id as enrolment_id, st.name, e.admission_no, m.marks::float as marks, m.absent
       from enrolment e join student st on st.id = e.student_id
       left join mark m on m.assessment_id = $1 and m.enrolment_id = e.id and m.subject_code = $3
      where e.section_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) order by st.name`, [id, sectionId, subjectCode]);
  return { assessment: a.name, status: a.status, section: s.label, subjectCode, maxMarks: paper.max_marks, students };
}

/** Saves a class's marks for one paper in one transaction; the database refuses anything above the maximum. */
export async function saveMarks(db: Db, actor: Actor, id: string, sectionId: string, subjectCode: string, entries: { enrolmentId: string; marks: number | null; absent: boolean }[]) {
  const a = await load(db, id);
  await assertCanMark(db, actor, a, sectionId, subjectCode);
  const sheetState = (await db.maybeOne<{ status: string }>('select status from marks_sheet where assessment_id = $1 and section_id = $2 and subject_code = $3', [id, sectionId, subjectCode]))?.status;
  if (sheetState && sheetState !== 'RETURNED' && !(await duties.has(db, actor.id, a.school_id, 'EXAM_INCHARGE')) && actor.role !== 'SCHOOL_ADMIN') throw forbidden('These marks have been submitted for moderation; the exam in-charge changes them now.');
  return db.tx(async (t) => {
    const roll = new Set((await t.query<{ id: string }>(`select id from enrolment where section_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [sectionId])).map((r) => r.id));
    let saved = 0;
    for (const e of entries) {
      if (!roll.has(e.enrolmentId)) throw invalid('A student in the list is not in this class.');
      if (!e.absent && (e.marks === null || Number.isNaN(e.marks))) {
        await t.query('delete from mark where assessment_id = $1 and enrolment_id = $2 and subject_code = $3', [id, e.enrolmentId, subjectCode]);
        continue;
      }
      await t.query(
        `insert into mark (assessment_id, enrolment_id, subject_code, marks, absent, entered_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (assessment_id, enrolment_id, subject_code) do update set marks = excluded.marks, absent = excluded.absent, entered_by = excluded.entered_by, entered_at = now()
         where mark.marks is distinct from excluded.marks or mark.absent <> excluded.absent`,
        [id, e.enrolmentId, subjectCode, e.absent ? null : e.marks, e.absent, actor.id]);
      saved++;
    }
    return { saved };
  }, { actor: actor.label });
}

// ── Holistic Progress Card ────────────────────────────────────────────────────────────────

export async function hpcSheet(db: Db, actor: Actor, id: string, sectionId: string) {
  const a = await load(db, id);
  const s = await assertCanMark(db, actor, a, sectionId, null);
  const domains = await db.query('select code, name, hint from hpc_domain order by ordinal');
  const students = await db.query(
    `select e.id as enrolment_id, st.name, e.admission_no,
            coalesce((select jsonb_object_agg(h.domain_code, jsonb_build_object('level', h.level, 'remark', h.remark)) from hpc_entry h where h.assessment_id = $1 and h.enrolment_id = e.id), '{}') as entries,
            (select remark from report_remark r where r.assessment_id = $1 and r.enrolment_id = e.id) as remark
       from enrolment e join student st on st.id = e.student_id
      where e.section_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) order by st.name`, [id, sectionId]);
  return { assessment: a.name, status: a.status, section: s.label, domains, students };
}

export async function saveHpc(db: Db, actor: Actor, id: string, sectionId: string, enrolmentId: string, input: { entries: { domain: string; level: string; remark?: string }[]; remark?: string }) {
  const a = await load(db, id);
  await assertCanMark(db, actor, a, sectionId, null);
  const ok = await db.maybeOne('select 1 from enrolment where id = $1 and section_id = $2', [enrolmentId, sectionId]);
  if (!ok) throw invalid('This student is not in the class.');
  await db.tx(async (t) => {
    for (const e of input.entries) {
      await t.query(
        `insert into hpc_entry (assessment_id, enrolment_id, domain_code, level, remark, entered_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (assessment_id, enrolment_id, domain_code) do update set level = excluded.level, remark = excluded.remark, entered_by = excluded.entered_by, entered_at = now()`,
        [id, enrolmentId, e.domain, e.level, (e.remark ?? '').trim(), actor.id]);
    }
    if (input.remark !== undefined) {
      if (input.remark.trim()) await t.query(
        `insert into report_remark (assessment_id, enrolment_id, remark, entered_by) values ($1, $2, $3, $4)
         on conflict (assessment_id, enrolment_id) do update set remark = excluded.remark, entered_by = excluded.entered_by, entered_at = now()`, [id, enrolmentId, input.remark.trim(), actor.id]);
      else await t.query('delete from report_remark where assessment_id = $1 and enrolment_id = $2', [id, enrolmentId]);
    }
  }, { actor: actor.label });
  return { ok: true };
}

// ── Results and analysis ──────────────────────────────────────────────────────────────────

/** Results for a school's assessment: class and subject Performance Index, grade spread, toppers. */
export async function analysis(db: Db, actor: Actor, id: string) {
  const a = await load(db, id);
  await assertCan(db, actor, 'results.analysis', a.school_id);
  if (a.status !== 'PUBLISHED') return { assessment: a, published: false };
  const byClass = await db.query(
    `select r.class_code, cl.name as class_name, count(*)::int as students, round(avg(r.percentage), 1)::float as average,
            round(sum(g.points) * 100.0 / (count(*) * 7), 1)::float as pi
       from result r join class_level cl on cl.code = r.class_code join grade_band g on g.scale = $2 and g.grade = r.grade
      where r.assessment_id = $1 group by r.class_code, cl.name, cl.ordinal order by cl.ordinal`, [id, a.scale]);
  const bySubject = await db.query(
    `select s->>'name' as subject, count(*)::int as entries, round(avg((s->>'pct')::numeric), 1)::float as average,
            round(sum(g.points) * 100.0 / (count(*) * 7), 1)::float as pi
       from result r cross join lateral jsonb_array_elements(r.subjects) s join grade_band g on g.scale = $2 and g.grade = s->>'grade'
      where r.assessment_id = $1 group by 1 order by pi desc`, [id, a.scale]);
  const grades = await db.query(
    `select g.grade, count(r.*)::int as n from grade_band g left join result r on r.grade = g.grade and r.assessment_id = $1
      where g.scale = $2 group by g.grade, g.min_pct order by g.min_pct desc`, [id, a.scale]);
  const toppers = await db.query(
    `select r.class_code, st.name, sec.name as section, r.percentage::float as percentage, r.grade from result r
       join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id left join section sec on sec.id = r.section_id
       join class_level cl on cl.code = r.class_code
      where r.assessment_id = $1 and r.rank_class = 1 order by cl.ordinal, st.name`, [id]);
  const overall = await db.one<{ students: number; average: number; pi: number }>(
    `select count(*)::int as students, round(avg(r.percentage), 1)::float as average, round(sum(g.points) * 100.0 / greatest(count(*) * 7, 1), 1)::float as pi
       from result r join grade_band g on g.scale = $2 and g.grade = r.grade where r.assessment_id = $1`, [id, a.scale]);
  return { assessment: a, published: true, overall, byClass, bySubject, grades, toppers };
}

export async function sectionResults(db: Db, actor: Actor, id: string, sectionId: string) {
  const a = await load(db, id);
  const s = await sectionInfo(db, sectionId);
  // The class's own teachers see its results; analysis across classes needs the analysis permission.
  if (!(await can(db, actor, 'results.analysis', s.school_id))) await assertTeaches(db, actor, sectionId);
  return db.query(
    `select r.enrolment_id, st.name, e.admission_no, r.obtained::float as obtained, r.max_total::float as max_total, r.percentage::float as percentage, r.grade, r.rank_section, r.subjects
       from result r join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id
      where r.assessment_id = $1 and r.section_id = $2 order by r.rank_section, st.name`, [a.id, sectionId]);
}

/** A child's published results across the year, the HPC, and the running final result. */
export async function forStudent(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId, 'academics');
  const rows = await db.query<{ assessment_id: string; code: string; name: string; kind: string; weight: number; published_at: string; percentage: number; grade: string; rank_section: number | null; obtained: number; max_total: number; subjects: unknown; section_size: number }>(
    `select a.id as assessment_id, a.code, a.name, a.kind, a.weight::float as weight, a.published_at, r.percentage::float as percentage, r.grade, r.rank_section,
            r.obtained::float as obtained, r.max_total::float as max_total, r.subjects,
            (select count(*) from result x where x.assessment_id = r.assessment_id and x.section_id = r.section_id)::int as section_size
       from result r join assessment a on a.id = r.assessment_id join enrolment e on e.id = r.enrolment_id
      where e.student_id = $1 order by a.starts`, [studentId]);
  const hpc = await db.query(
    `select a.name as assessment, d.name as domain, d.hint, h.level, h.remark from hpc_entry h
       join assessment a on a.id = h.assessment_id join hpc_domain d on d.code = h.domain_code join enrolment e on e.id = h.enrolment_id
      where e.student_id = $1 and a.status = 'PUBLISHED' order by a.starts, d.ordinal`, [studentId]);
  const remarks = await db.query(
    `select a.name as assessment, r.remark, u.name as by from report_remark r join assessment a on a.id = r.assessment_id
       join enrolment e on e.id = r.enrolment_id join app_user u on u.id = r.entered_by where e.student_id = $1 and a.status = 'PUBLISHED' order by a.starts`, [studentId]);
  const weighted = rows.filter((r) => r.weight > 0);
  const wsum = weighted.reduce((s, r) => s + r.weight, 0);
  const running = wsum ? Math.round((weighted.reduce((s, r) => s + r.weight * r.percentage, 0) / wsum) * 10) / 10 : null;
  // Balvatika to Class V: the published terms, each with its Holistic Progress Card.
  const holistic = await db.query(
    `select a.id as assessment_id, a.name, a.published_at from enrolment e join assessment a on a.school_id = e.school_id and a.academic_year = e.academic_year
      where e.student_id = $1 and e.class_code = any($2) and a.status = 'PUBLISHED' and a.kind in ('TERM', 'ANNUAL') order by a.starts`, [studentId, HPC_CLASSES]);
  return { results: rows, hpc, remarks, holistic, running: running === null ? null : { percentage: running, basedOn: weighted.map((r) => r.code), weightCovered: wsum } };
}

// ── Unified: across schools ───────────────────────────────────────────────────────────────

/**
 * NES and Command view of one exam (by code) across every school in scope: Performance Index,
 * average and toppers, plus the best school per class.
 */
export async function acrossSchools(db: Db, actor: Actor, year: string, code: string) {
  if (actor.role !== 'NES_ADMIN' && actor.role !== 'COMMAND_OFFICER') throw forbidden('Comparisons across schools are for NES and the Commands.');
  await assertCan(db, actor, 'results.analysis');
  const schools = await db.query(
    `select o.id as school_id, o.name as school, a.status, count(r.*)::int as students,
            round(avg(r.percentage), 1)::float as average,
            round(sum(g.points) * 100.0 / nullif(count(r.*) * 7, 0), 1)::float as pi,
            count(*) filter (where r.grade in ('A1', 'A2'))::int as distinctions
       from org_unit o join assessment a on a.school_id = o.id and a.academic_year = $2 and a.code = $3
       left join result r on r.assessment_id = a.id left join grade_band g on g.scale = a.scale and g.grade = r.grade
      where o.path <@ $1::ltree and o.kind = 'school' group by o.id, o.name, a.status order by pi desc nulls last`, [actor.scopePath, year, code]);
  const classes = await db.query(
    `select r.class_code, cl.name as class_name, o.name as school, round(sum(g.points) * 100.0 / (count(*) * 7), 1)::float as pi, round(avg(r.percentage), 1)::float as average, count(*)::int as students
       from result r join assessment a on a.id = r.assessment_id join org_unit o on o.id = a.school_id
       join grade_band g on g.scale = a.scale and g.grade = r.grade join class_level cl on cl.code = r.class_code
      where o.path <@ $1::ltree and a.academic_year = $2 and a.code = $3
      group by r.class_code, cl.name, cl.ordinal, o.name order by cl.ordinal, pi desc`, [actor.scopePath, year, code]);
  const toppers = await db.query(
    `select * from (
       select r.class_code, cl.ordinal, st.name, o.name as school, r.percentage::float as percentage, r.grade,
              rank() over (partition by r.class_code order by r.percentage desc) as nes_rank
         from result r join assessment a on a.id = r.assessment_id join org_unit o on o.id = a.school_id
         join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id join class_level cl on cl.code = r.class_code
        where o.path <@ $1::ltree and a.academic_year = $2 and a.code = $3) x
      where nes_rank <= 3 order by ordinal, nes_rank, name`, [actor.scopePath, year, code]);
  const best: Record<string, { school: string; pi: number }> = {};
  for (const c of classes as { class_code: string; school: string; pi: number }[]) if (!best[c.class_code]) best[c.class_code] = { school: c.school, pi: c.pi };
  return { code, schools, classes, bestByClass: best, toppers };
}

/** Toppers for a school website: the latest published term or annual exam, first in each class. */
export async function publicToppers(db: Db, schoolId: string, perClass: number) {
  const a = await db.maybeOne<{ id: string; name: string }>(
    `select id, name from assessment where school_id = $1 and status = 'PUBLISHED' and kind in ('TERM', 'ANNUAL') order by published_at desc limit 1`, [schoolId]);
  if (!a) return null;
  const rows = await db.query<{ class_code: string; class_name: string; name: string; percentage: number }>(
    `select r.class_code, cl.name as class_name, st.name, r.percentage::float as percentage from result r
       join enrolment e on e.id = r.enrolment_id join student st on st.id = e.student_id join class_level cl on cl.code = r.class_code
      where r.assessment_id = $1 and r.rank_class <= $2 order by cl.ordinal desc, r.rank_class, st.name`, [a.id, perClass]);
  return { assessment: a.name, rows };
}
