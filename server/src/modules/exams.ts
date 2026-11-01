import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { newDocument, Sheet, fmtDate } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import * as duties from './duties.js';
import * as notify from './notify.js';
import { looksLikeCbseTxt, parseCbseResult } from '../lib/cbseResult.js';
import { streamFrom } from '../reference/piPolicy.js';

/**
 * The exam office's remaining work: rooms; the seating plan for each exam day (classes mixed so no
 * two neighbours sit the same paper) and invigilation duties (never a teacher of a paper being
 * written, shared out evenly, never two rooms at once); moderation of marks sheets (submitted by
 * the subject teacher, moderated by the exam in-charge with every change and its reason kept);
 * answer-script bundles; and the board: CBSE registration data (from the records, with what is
 * missing), board roll numbers, and the CBSE result file loaded and analysed.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const desk = (db: Db, actor: Actor, schoolId: string) => duties.assertLeaderOrDuty(db, actor, schoolId, 'EXAM_INCHARGE');

async function assessmentOf(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Assessment');
  const a = await db.maybeOne<{ id: string; school_id: string; academic_year: string; name: string; status: string }>('select id, school_id, academic_year, name, status from assessment where id = $1', [id]);
  if (!a) throw notFound('Assessment');
  return a;
}

// ── Rooms ─────────────────────────────────────────────────────────────────────────────────

export async function rooms(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(`select r.id, r.name, r.kind, r.capacity, r.exam_seats, r.active, r.campus_id, c.name as campus from room r join org_unit c on c.id = r.campus_id where r.school_id = $1 order by c.name, r.name`, [schoolId]);
}

export async function saveRoom(db: Db, actor: Actor, schoolId: string, input: { id?: string; campusId: string; name: string; kind: string; capacity: number; examSeats: number; active?: boolean }) {
  await desk(db, actor, schoolId);
  if (!(await db.maybeOne(`select 1 from org_unit where id = $1 and parent_id = $2 and kind = 'campus'`, [input.campusId, schoolId]))) throw invalid('Choose a campus of this school.');
  return db.tx((t) => input.id
    ? t.one<{ id: string }>(`update room set campus_id = $3, name = $4, kind = $5, capacity = $6, exam_seats = $7, active = coalesce($8, active) where id = $1 and school_id = $2 returning id`, [input.id, schoolId, input.campusId, input.name.trim(), input.kind, input.capacity, input.examSeats, input.active ?? null])
    : t.one<{ id: string }>(`insert into room (school_id, campus_id, name, kind, capacity, exam_seats) values ($1,$2,$3,$4,$5,$6) returning id`, [schoolId, input.campusId, input.name.trim(), input.kind, input.capacity, input.examSeats]),
  { actor: actor.label });
}

// ── Seating and invigilation ──────────────────────────────────────────────────────────────

/** The exam days of an assessment, with the papers and how many sit each. */
export async function days(db: Db, actor: Actor, assessmentId: string) {
  const a = await assessmentOf(db, assessmentId);
  await assertUnitInScope(db, actor, a.school_id);
  return db.query(
    `select p.exam_date::text, p.session, jsonb_agg(jsonb_build_object('class', p.class_code, 'subject', s.name, 'code', p.subject_code) order by cl.ordinal) as papers,
            (select count(*) from enrolment e where e.school_id = $2 and upper_inf(e.period) and e.status = 'ACTIVE' and e.academic_year = $3 and e.class_code in (select x.class_code from assessment_paper x where x.assessment_id = $1 and x.exam_date = p.exam_date and x.session = p.session))::int as candidates,
            (select count(*) from exam_seat x where x.assessment_id = $1 and x.exam_date = p.exam_date and x.session = p.session)::int as seated,
            (select count(*) from invigilation x where x.assessment_id = $1 and x.exam_date = p.exam_date and x.session = p.session)::int as invigilators
       from assessment_paper p join subject s on s.code = p.subject_code join class_level cl on cl.code = p.class_code
      where p.assessment_id = $1 and p.exam_date is not null group by p.exam_date, p.session order by p.exam_date, p.session`, [assessmentId, a.school_id, a.academic_year]);
}

/**
 * Seats every child sitting a paper on that day and session across the exam rooms, taking the
 * classes in turn so neighbours write different papers; then gives each room its invigilators.
 */
export async function plan(db: Db, actor: Actor, assessmentId: string, examDate: string, session: 'MORNING' | 'AFTERNOON') {
  const a = await assessmentOf(db, assessmentId);
  await desk(db, actor, a.school_id);
  const papers = await db.query<{ class_code: string; subject_code: string }>(`select class_code, subject_code from assessment_paper where assessment_id = $1 and exam_date = $2 and session = $3`, [assessmentId, examDate, session]);
  if (!papers.length) throw invalid('No paper is written then.');
  const subjectOf = new Map(papers.map((p) => [p.class_code, p.subject_code]));
  const kids = await db.query<{ id: string; class_code: string }>(
    `select e.id, e.class_code from enrolment e join section s on s.id = e.section_id left join student st on st.id = e.student_id
      where e.school_id = $1 and e.academic_year = $2 and upper_inf(e.period) and e.status = 'ACTIVE' and e.class_code = any($3::text[]) order by e.class_code, s.name, e.roll_no nulls last, st.name`,
    [a.school_id, a.academic_year, [...subjectOf.keys()]]);
  const rms = await db.query<{ id: string; name: string; exam_seats: number }>(`select id, name, exam_seats from room where school_id = $1 and active and exam_seats > 0 order by name`, [a.school_id]);
  const seats = rms.reduce((s, r) => s + r.exam_seats, 0);
  if (seats < kids.length) throw conflict('rooms', `${kids.length} children write then but the exam rooms seat ${seats}. Add rooms or seats under Rooms.`);
  // Classes in turn: A1, B1, C1, A2, B2, C2…
  const byClass = [...new Set(kids.map((k) => k.class_code))].map((c) => kids.filter((k) => k.class_code === c));
  const order: { id: string; class_code: string }[] = [];
  for (let i = 0; order.length < kids.length; i++) for (const g of byClass) if (g[i]) order.push(g[i]);
  const teachersOfPapers = await db.query<{ id: string }>(
    `select distinct tl.teacher_id as id from teaching_load tl join section s on s.id = tl.section_id join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and s.academic_year = $2 and tl.teacher_id is not null and (s.class_code, tl.subject_code) in (select p.class_code, p.subject_code from assessment_paper p where p.assessment_id = $3 and p.exam_date = $4 and p.session = $5)`,
    [a.school_id, a.academic_year, assessmentId, examDate, session]);
  const exclude = new Set(teachersOfPapers.map((t) => t.id));
  const pool = await db.query<{ id: string; name: string; load: number }>(
    `select u.id, u.name, (select count(*) from invigilation i where i.assessment_id = $2 and i.user_id = u.id and not (i.exam_date = $3 and i.session = $4))::int as load
       from app_user u join org_unit o on o.id = $1
      where u.active and u.role = 'TEACHER' and u.scope_path <@ o.path
        and not exists (select 1 from teacher_absence ta where ta.teacher_id = u.id and ta.period @> $3::date and ta.periods is null)
        and not exists (select 1 from invigilation i where i.user_id = u.id and i.exam_date = $3 and i.session = $4 and i.assessment_id <> $2)
      order by load, u.name`, [a.school_id, assessmentId, examDate, session]);
  const free = pool.filter((p) => !exclude.has(p.id));
  return db.tx(async (t) => {
    await t.query('delete from exam_seat where assessment_id = $1 and exam_date = $2 and session = $3', [assessmentId, examDate, session]);
    await t.query('delete from invigilation where assessment_id = $1 and exam_date = $2 and session = $3', [assessmentId, examDate, session]);
    let k = 0;
    const used: { id: string; name: string; n: number }[] = [];
    for (const r of rms) {
      let n = 0;
      while (n < r.exam_seats && k < order.length) {
        const kid = order[k++]; n++;
        await t.query(`insert into exam_seat (assessment_id, exam_date, session, room_id, seat_no, enrolment_id, subject_code) values ($1,$2,$3,$4,$5,$6,$7)`, [assessmentId, examDate, session, r.id, n, kid.id, subjectOf.get(kid.class_code)]);
      }
      if (n) used.push({ id: r.id, name: r.name, n });
    }
    let shortBy = 0;
    for (const r of used) {
      const need = r.n > 30 ? 2 : 1;
      for (let j = 0; j < need; j++) {
        free.sort((x, y) => x.load - y.load);
        const p = free.shift();
        if (!p) { shortBy++; continue; }
        await t.query(`insert into invigilation (assessment_id, exam_date, session, room_id, user_id) values ($1,$2,$3,$4,$5)`, [assessmentId, examDate, session, r.id, p.id]);
        p.load++;
      }
    }
    const invited = await t.query<{ user_id: string }>('select user_id from invigilation where assessment_id = $1 and exam_date = $2 and session = $3', [assessmentId, examDate, session]);
    await notify.toUsers(t, invited.map((i) => i.user_id), { kind: 'EVENT', title: `Invigilation: ${fmtDate(examDate)}, ${session.toLowerCase()}`, body: a.name, link: '/invigilation' });
    return { seated: k, rooms: used.length, invigilators: invited.length, shortOfInvigilators: shortBy };
  }, { actor: actor.label });
}

export async function seating(db: Db, actor: Actor, assessmentId: string, examDate: string, session: string) {
  const a = await assessmentOf(db, assessmentId);
  await assertUnitInScope(db, actor, a.school_id);
  const roomsUsed = await db.query<{ room_id: string; room: string }>(`select distinct x.room_id, r.name as room from exam_seat x join room r on r.id = x.room_id where x.assessment_id = $1 and x.exam_date = $2 and x.session = $3 order by r.name`, [assessmentId, examDate, session]);
  const out = [];
  for (const r of roomsUsed) {
    out.push({ ...r,
      invigilators: (await db.query<{ name: string }>(`select u.name from invigilation i join app_user u on u.id = i.user_id where i.assessment_id = $1 and i.exam_date = $2 and i.session = $3 and i.room_id = $4 order by u.name`, [assessmentId, examDate, session, r.room_id])).map((x) => x.name),
      seats: await db.query(`select x.seat_no, st.name, e.admission_no, e.class_code || '-' || coalesce(s.name, '') as class, sj.name as subject from exam_seat x join enrolment e on e.id = x.enrolment_id join student st on st.id = e.student_id
                               left join section s on s.id = e.section_id join subject sj on sj.code = x.subject_code where x.assessment_id = $1 and x.exam_date = $2 and x.session = $3 and x.room_id = $4 order by x.seat_no`, [assessmentId, examDate, session, r.room_id]) });
  }
  return { assessment: a.name, examDate, session, rooms: out };
}

/** One page per room for the door and the invigilator: seats, names, classes, papers, a signature column. */
export async function seatingPdf(db: Db, actor: Actor, assessmentId: string, examDate: string, session: string) {
  const s = await seating(db, actor, assessmentId, examDate, session);
  const { doc, fonts: f } = await newDocument(`Seating ${fmtDate(examDate)}`);
  for (const r of s.rooms) {
    const pg = new Sheet(doc, 210, 297, f);
    pg.text(`${s.assessment} · ${fmtDate(examDate)} · ${session.toLowerCase()}`, 15, 12, { size: 10 });
    pg.text(`Room ${r.room}`, 15, 18, { size: 16, font: f.bold });
    pg.text(`Invigilators: ${r.invigilators.join(', ') || '—'}`, 15, 27, { size: 9.5, maxWidth: 180 });
    let y = 36;
    [['Seat', 15], ['Name', 28], ['Adm. no.', 98], ['Class', 125], ['Paper', 143], ['Signature', 172]].forEach(([l, x]) => pg.text(l as string, x as number, y, { size: 8.5, font: f.bold }));
    y += 6;
    for (const x of r.seats as { seat_no: number; name: string; admission_no: string; class: string; subject: string }[]) {
      if (y > 285) break;
      pg.text(String(x.seat_no), 15, y, { size: 9 }); pg.text(x.name, 28, y, { size: 9, maxWidth: 68 }); pg.text(x.admission_no, 98, y, { size: 8, maxWidth: 26 });
      pg.text(x.class, 125, y, { size: 9 }); pg.text(x.subject, 143, y, { size: 8.5, maxWidth: 28 }); pg.line(172, y + 4, 195, y + 4);
      y += 6.4;
    }
  }
  if (!s.rooms.length) new Sheet(doc, 210, 297, f).text('No seating plan yet.', 20, 20);
  return { name: `seating-${examDate}-${session.toLowerCase()}.pdf`, data: Buffer.from(await doc.save()) };
}

/** A teacher's invigilation duties from today. */
export async function myDuties(db: Db, actor: Actor) {
  return db.query(`select i.exam_date::text, i.session, r.name as room, a.name as assessment, (select count(*) from exam_seat x where x.assessment_id = i.assessment_id and x.exam_date = i.exam_date and x.session = i.session and x.room_id = i.room_id)::int as candidates
                     from invigilation i join room r on r.id = i.room_id join assessment a on a.id = i.assessment_id where i.user_id = $1 and i.exam_date >= current_date order by i.exam_date, i.session`, [actor.id]);
}

// ── Moderation ────────────────────────────────────────────────────────────────────────────

async function canMarkSheet(db: Db, actor: Actor, sectionId: string, subjectCode: string) {
  return !!(await db.maybeOne(`select 1 from teaching_load where section_id = $1 and subject_code = $2 and teacher_id = $3
                                 union select 1 from timetable t join timetable_slot x on x.timetable_id = t.id where t.section_id = $1 and x.subject_code = $2 and x.teacher_id = $3 and t.valid @> current_date`, [sectionId, subjectCode, actor.id]));
}

/** The subject teacher submits a complete marks sheet for moderation (it can no longer be changed by them). */
export async function submitSheet(db: Db, actor: Actor, assessmentId: string, sectionId: string, subjectCode: string) {
  const a = await assessmentOf(db, assessmentId);
  if (a.status !== 'OPEN') throw conflict('state', 'Marks are not open.');
  if (!(await canMarkSheet(db, actor, sectionId, subjectCode))) throw forbidden('The subject teacher submits the marks sheet.');
  const gap = await db.one<{ n: number }>(`select count(*)::int as n from enrolment e where e.section_id = $1 and upper_inf(e.period) and e.status in ('ACTIVE', 'PROVISIONAL')
                                             and not exists (select 1 from mark m where m.assessment_id = $2 and m.enrolment_id = e.id and m.subject_code = $3)`, [sectionId, assessmentId, subjectCode]);
  if (gap.n) throw invalid(`${gap.n} children have no mark (enter Absent for those who missed it).`);
  await db.tx(async (t) => {
    await t.query(`insert into marks_sheet (assessment_id, section_id, subject_code, submitted_by) values ($1,$2,$3,$4)
                   on conflict (assessment_id, section_id, subject_code) do update set status = 'SUBMITTED', submitted_by = excluded.submitted_by, submitted_at = now(), moderated_by = null, moderated_at = null, note = null
                   where marks_sheet.status = 'RETURNED'`, [assessmentId, sectionId, subjectCode, actor.id]);
    const ex = await t.query<{ id: string }>(`select user_id as id from duty where school_id = $1 and code = 'EXAM_INCHARGE' and valid @> current_date`, [a.school_id]);
    await notify.toUsers(t, ex.map((e) => e.id), { kind: 'RESULT', title: `Marks sheet to moderate: ${subjectCode}`, body: a.name, link: '/moderation' });
  }, { actor: actor.label });
  return { status: 'SUBMITTED' };
}

/** Sheets waiting for moderation at a school. */
export async function toModerate(db: Db, actor: Actor, schoolId: string) {
  await desk(db, actor, schoolId);
  return db.query(
    `select ms.assessment_id, ms.section_id, ms.subject_code, ms.status, ms.submitted_at, u.name as teacher, a.name as assessment, s.class_code || '-' || s.name as section, sj.name as subject,
            (select round(avg(m.marks / p.max_marks * 100), 1)::float from mark m join enrolment e on e.id = m.enrolment_id join assessment_paper p on p.assessment_id = m.assessment_id and p.class_code = e.class_code and p.subject_code = m.subject_code
              where m.assessment_id = ms.assessment_id and m.subject_code = ms.subject_code and e.section_id = ms.section_id and not m.absent) as average,
            (select round(avg(m.marks / p.max_marks * 100), 1)::float from mark m join enrolment e on e.id = m.enrolment_id join assessment_paper p on p.assessment_id = m.assessment_id and p.class_code = e.class_code and p.subject_code = m.subject_code
              where m.assessment_id = ms.assessment_id and m.subject_code = ms.subject_code and e.class_code = s.class_code and not m.absent) as class_average
       from marks_sheet ms join assessment a on a.id = ms.assessment_id join section s on s.id = ms.section_id join subject sj on sj.code = ms.subject_code join app_user u on u.id = ms.submitted_by
      where a.school_id = $1 and a.status = 'OPEN' and ms.status = 'SUBMITTED' order by ms.submitted_at`, [schoolId]);
}

/**
 * The exam in-charge moderates a sheet: changes marks with a reason each (kept for ever), then
 * accepts the sheet, or returns it to the teacher with a note.
 */
export async function moderate(db: Db, actor: Actor, assessmentId: string, sectionId: string, subjectCode: string, input: { changes?: { enrolmentId: string; marks: number; reason: string }[]; accept: boolean; note?: string }) {
  const a = await assessmentOf(db, assessmentId);
  await desk(db, actor, a.school_id);
  const ms = await db.maybeOne<{ status: string; submitted_by: string }>('select status, submitted_by from marks_sheet where assessment_id = $1 and section_id = $2 and subject_code = $3', [assessmentId, sectionId, subjectCode]);
  if (!ms || ms.status !== 'SUBMITTED') throw conflict('state', 'This sheet is not waiting for moderation.');
  if (!input.accept && !input.note?.trim()) throw invalid('Tell the teacher what to look at.');
  return db.tx(async (t) => {
    for (const c of input.changes ?? []) {
      if (c.reason.trim().length < 4) throw invalid('Give a reason for each change.');
      const m = await t.maybeOne<{ marks: string | null }>(`select m.marks from mark m join enrolment e on e.id = m.enrolment_id where m.assessment_id = $1 and m.enrolment_id = $2 and m.subject_code = $3 and e.section_id = $4`, [assessmentId, c.enrolmentId, subjectCode, sectionId]);
      if (!m) throw invalid('A child in the changes is not on this sheet.');
      await t.query('update mark set marks = $4, absent = false, entered_by = $5, entered_at = now() where assessment_id = $1 and enrolment_id = $2 and subject_code = $3', [assessmentId, c.enrolmentId, subjectCode, c.marks, actor.id]);
      await t.query('insert into mark_moderation (assessment_id, enrolment_id, subject_code, from_marks, to_marks, reason, by_user) values ($1,$2,$3,$4,$5,$6,$7)', [assessmentId, c.enrolmentId, subjectCode, m.marks, c.marks, c.reason.trim(), actor.id]);
    }
    await t.query(`update marks_sheet set status = $4, moderated_by = $5, moderated_at = now(), note = $6 where assessment_id = $1 and section_id = $2 and subject_code = $3`,
      [assessmentId, sectionId, subjectCode, input.accept ? 'MODERATED' : 'RETURNED', actor.id, input.note?.trim() || null]);
    await notify.toUsers(t, [ms.submitted_by], { kind: 'RESULT', title: input.accept ? `Marks moderated: ${subjectCode}` : `Marks sheet returned: ${subjectCode}`, body: input.note?.trim() || (input.changes?.length ? `${input.changes.length} marks changed in moderation.` : 'Accepted as entered.'), link: '/marks' });
    return { status: input.accept ? 'MODERATED' : 'RETURNED', changed: input.changes?.length ?? 0 };
  }, { actor: actor.label });
}

export async function sheetStatus(db: Db, assessmentId: string, sectionId: string, subjectCode: string) {
  return (await db.maybeOne<{ status: string }>('select status from marks_sheet where assessment_id = $1 and section_id = $2 and subject_code = $3', [assessmentId, sectionId, subjectCode]))?.status ?? null;
}

export async function moderationLog(db: Db, actor: Actor, assessmentId: string) {
  const a = await assessmentOf(db, assessmentId);
  await desk(db, actor, a.school_id);
  return db.query(`select st.name, e.class_code || '-' || s.name as section, sj.name as subject, x.from_marks::float, x.to_marks::float, x.reason, u.name as by, x.at
                     from mark_moderation x join enrolment e on e.id = x.enrolment_id join student st on st.id = e.student_id left join section s on s.id = e.section_id join subject sj on sj.code = x.subject_code join app_user u on u.id = x.by_user
                    where x.assessment_id = $1 order by x.at desc`, [assessmentId]);
}

// ── Answer scripts ────────────────────────────────────────────────────────────────────────

export async function bundles(db: Db, actor: Actor, assessmentId: string) {
  const a = await assessmentOf(db, assessmentId);
  await assertUnitInScope(db, actor, a.school_id);
  return db.query(`select b.id, s.class_code || '-' || s.name as section, sj.name as subject, b.scripts, u.name as evaluator, b.issued_at, b.returned_at, b.returned_count, b.note
                     from script_bundle b join section s on s.id = b.section_id join subject sj on sj.code = b.subject_code join app_user u on u.id = b.evaluator where b.assessment_id = $1 order by s.class_code, s.name, sj.name`, [assessmentId]);
}

export async function issueBundle(db: Db, actor: Actor, assessmentId: string, input: { sectionId: string; subjectCode: string; scripts: number; evaluator: string }) {
  const a = await assessmentOf(db, assessmentId);
  await desk(db, actor, a.school_id);
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into script_bundle (assessment_id, section_id, subject_code, scripts, evaluator, issued_by) values ($1,$2,$3,$4,$5,$6) returning id`, [assessmentId, input.sectionId, input.subjectCode, input.scripts, input.evaluator, actor.id]);
    await notify.toUsers(t, [input.evaluator], { kind: 'RESULT', title: `${input.scripts} answer scripts to evaluate`, body: `${a.name}, ${input.subjectCode}`, link: '/marks' });
    return r;
  }, { actor: actor.label });
}

/** Scripts back from the evaluator; a short count is noted for the exam in-charge. */
export async function returnBundle(db: Db, actor: Actor, id: string, input: { count: number; note?: string }) {
  const b = await db.maybeOne<{ assessment_id: string; scripts: number; returned_at: string | null }>('select assessment_id, scripts, returned_at from script_bundle where id = $1', [id]);
  if (!b) throw notFound('Bundle');
  const a = await assessmentOf(db, b.assessment_id);
  await desk(db, actor, a.school_id);
  if (b.returned_at) throw conflict('returned', 'Already returned.');
  if (input.count !== b.scripts && !input.note?.trim()) throw invalid(`${b.scripts} scripts were issued; say what happened to the rest.`);
  await db.tx((t) => t.query(`update script_bundle set returned_at = now(), returned_count = $2, note = $3 where id = $1`, [id, input.count, input.note?.trim() || null]), { actor: actor.label });
  return { ok: true };
}

// ── The board ─────────────────────────────────────────────────────────────────────────────

const REG_CLASSES: Record<string, string> = { IX: 'SECONDARY', X: 'SECONDARY', XI: 'SENIOR', XII: 'SENIOR' };

/**
 * CBSE registration (IX, XI) or list of candidates (X, XII), built from the records: the child's
 * and parents' names, date of birth, category, APAAR ID and the subjects the class is taught, with
 * CBSE subject codes. Rows with something missing are flagged, so the office corrects the record once.
 */
export async function boardData(db: Db, actor: Actor, schoolId: string, classCode: string) {
  await desk(db, actor, schoolId);
  const level = REG_CLASSES[classCode];
  if (!level) throw invalid('Registration data is for Classes IX to XII.');
  const rows = await db.query<{ enrolment_id: string; name: string; dob: string; gender: string; mother_name: string | null; father_name: string | null; category: string | null; apaar_id: string | null; pen: string | null;
    admission_no: string; section: string; board_roll_no: string | null; board_reg_no: string | null; subjects: string[] | null; codes: string[] | null }>(
    `select e.id as enrolment_id, st.name, st.dob::text, st.gender,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'MOTHER' limit 1) as mother_name,
            (select g.name from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id and sg.relationship = 'FATHER' limit 1) as father_name, st.social_category as category, st.apaar_id, st.pen, e.admission_no, s.name as section, e.board_roll_no, e.board_reg_no,
            (select array_agg(sj.name order by sj.name) from teaching_load tl join subject sj on sj.code = tl.subject_code where tl.section_id = e.section_id) as subjects,
            (select array_agg(cs.cbse_code order by sj.name) from teaching_load tl join subject sj on sj.code = tl.subject_code join cbse_subject cs on cs.subject_code = tl.subject_code and cs.level = $3 where tl.section_id = e.section_id) as codes
       from enrolment e join student st on st.id = e.student_id left join section s on s.id = e.section_id
      where e.school_id = $1 and e.class_code = $2 and upper_inf(e.period) and e.status = 'ACTIVE' order by s.name, st.name`, [schoolId, classCode, level]);
  return rows.map((r) => ({ ...r, missing: [!r.mother_name && 'mother’s name', !r.father_name && 'father’s name', !r.apaar_id && 'APAAR ID', !(r.codes?.length) && 'subjects', ['X', 'XII'].includes(classCode) && !r.board_reg_no && 'registration no.'].filter(Boolean) }));
}

export function boardCsv(rows: Awaited<ReturnType<typeof boardData>>) {
  const cell = (x: unknown) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Admission no', 'Section', 'Name', 'Mother', 'Father', 'Date of birth', 'Gender', 'APAAR ID', 'PEN', 'Registration no', 'Roll no', 'Subject codes', 'Missing'];
  return [head.join(','), ...rows.map((r) => [r.admission_no, r.section, r.name, r.mother_name, r.father_name, r.dob, r.gender, r.apaar_id, r.pen, r.board_reg_no, r.board_roll_no, (r.codes ?? []).join(' '), r.missing.join('; ')].map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Board registration and roll numbers from CBSE, by admission number. */
export async function setBoardNumbers(db: Db, actor: Actor, schoolId: string, rows: { admissionNo: string; regNo?: string; rollNo?: string }[]) {
  await desk(db, actor, schoolId);
  return db.tx(async (t) => {
    let n = 0; const unknown: string[] = [];
    for (const r of rows) {
      const u = await t.query(`update enrolment set board_reg_no = coalesce($3, board_reg_no), board_roll_no = coalesce($4, board_roll_no) where school_id = $1 and admission_no = $2 and upper_inf(period) returning id`,
        [schoolId, r.admissionNo.trim(), r.regNo?.trim() || null, r.rollNo?.trim() || null]);
      if (u.length) n++; else unknown.push(r.admissionNo);
    }
    return { updated: n, unknown };
  }, { actor: actor.label });
}

/**
 * Loads the CBSE result file (comma-separated: roll number, name, then code, marks and grade for
 * each subject, then the result). Each row is matched to the child by board roll number, else by
 * name in that class; Best 5 (English and the best four others) and the percentage are worked out.
 */
/**
 * Loads the CBSE result file for Class X or XII: the text file CBSE sends schools (or a CSV with
 * roll, name, then code/marks/grade per subject, and the result). With dryRun nothing is saved and
 * the school sees what was read and which children it matched. The file is kept as uploaded.
 * Parents see the results only once the school publishes them.
 */
export async function importBoardResults(db: Db, actor: Actor, schoolId: string, input: { year: number; classCode: 'X' | 'XII'; content: string; fileName?: string; dryRun?: boolean }) {
  await desk(db, actor, schoolId);
  const names = new Map((await db.query<{ cbse_code: string; cbse_name: string }>('select distinct cbse_code, cbse_name from cbse_subject')).map((x) => [x.cbse_code, x.cbse_name]));
  const format = looksLikeCbseTxt(input.content) ? 'CBSE_TXT' : 'CSV';
  type Parsed = { roll: string; gender: 'M' | 'F' | null; flag?: string | null; name: string; subjects: { code: string; marks: number | null; grade: string; absent?: boolean }[]; result: string };
  let parsed: Parsed[];
  let skipped: { line: number; text: string }[] = [];
  let supplementary = false;
  if (format === 'CBSE_TXT') {
    const r = parseCbseResult(input.content);
    ({ rows: parsed, skipped } = r);
    // The file says which school, class and examination it is: refuse one meant for somewhere else.
    if (r.info.level && r.info.level !== input.classCode) throw invalid(`This is the Class ${r.info.level} result file, but Class ${input.classCode} was chosen.`);
    const own = await db.one<{ school_no: string | null }>('select school_no from org_unit where id = $1', [schoolId]);
    if (r.info.schoolCode && own.school_no && own.school_no.replace(/\D/g, '') !== r.info.schoolCode) throw invalid(`This file is for CBSE school ${r.info.schoolCode}; this school's CBSE number is ${own.school_no}.`);
    supplementary = r.info.supplementary || r.rows.some((x) => x.flag);
  } else {
    const lines = input.content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    parsed = lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      const subj: { code: string; marks: number | null; grade: string }[] = [];
      for (let i = 2; i + 2 < cells.length; i += 3) if (cells[i]) subj.push({ code: cells[i], marks: Number(cells[i + 1]), grade: cells[i + 2] });
      return { roll: cells[0], gender: null, name: cells[1], subjects: subj, result: (cells[cells.length - 1] ?? '').toUpperCase() };
    }).filter((r) => r.roll && r.name && r.subjects.length);
  }
  if (!parsed.length) throw invalid('No results could be read from this file. Upload the result file CBSE sent the school (TXT), or the CSV.');
  const REAL = ['PASS', 'COMP', 'COMPTT', 'FAIL', 'ESSENTIAL REPEAT'];
  type Subj = { code: string; name: string; marks: number | null; grade: string; attempt?: string };
  const bestFive = (subjects: Subj[]) => {
    const english = subjects.filter((x) => ['184', '101', '301', '001'].includes(x.code)).sort((a, b) => (b.marks ?? 0) - (a.marks ?? 0))[0];
    const rest = subjects.filter((x) => x !== english).sort((a, b) => (b.marks ?? 0) - (a.marks ?? 0)).slice(0, english ? 4 : 5);
    return [...(english ? [english] : []), ...rest].reduce((t, x) => t + (x.marks ?? 0), 0);
  };
  const rows: (Parsed & { subjects: Subj[]; best5: number; percentage: number; stream: string | null; enrolmentId: string | null; matchedTo: string | null; update: boolean; changes: { code: string; from: string; to: string }[]; publishedBefore: boolean })[] = [];
  for (const r of parsed) {
    let subjects: Subj[] = r.subjects.map((x) => ({ code: x.code, name: names.get(x.code) ?? x.code, marks: x.marks, grade: x.grade }));
    let result = r.result;
    const changes: { code: string; from: string; to: string }[] = [];
    // A supplementary (compartment or improvement) file carries only the subjects taken again: they
    // update the main result. Improvement keeps the better of the two marks, as CBSE does.
    const prior = supplementary ? await db.maybeOne<{ subjects: Subj[]; result: string; published_at: string | null; enrolment_id: string | null; name: string; gender: 'M' | 'F' | null }>(
      'select subjects, result, published_at, enrolment_id, name, gender from board_result where school_id = $1 and year = $2 and class_code = $3 and roll_no = $4', [schoolId, input.year, input.classCode, r.roll]) : null;
    if (prior) {
      const merged = prior.subjects.map((x) => ({ ...x }));
      for (const n of subjects) {
        const old = merged.find((x) => x.code === n.code);
        const keepOld = r.flag === 'I' && old && (old.marks ?? 0) >= (n.marks ?? 0);
        if (old && !keepOld) { changes.push({ code: n.code, from: `${old.marks ?? 'AB'} ${old.grade}`, to: `${n.marks ?? 'AB'} ${n.grade}` }); Object.assign(old, n, { attempt: r.flag === 'I' ? 'IMPROVEMENT' : 'SUPPLEMENTARY' }); }
        else if (!old) { merged.push({ ...n, attempt: 'SUPPLEMENTARY' }); changes.push({ code: n.code, from: '—', to: `${n.marks ?? 'AB'} ${n.grade}` }); }
      }
      subjects = merged;
      result = REAL.includes(r.result) ? r.result : merged.every((x) => (x.marks ?? 0) >= 33) ? 'PASS' : prior.result;
    }
    const best = bestFive(subjects);
    const e = await db.maybeOne<{ id: string; name: string }>(
      `select e.id, st.name from enrolment e join student st on st.id = e.student_id
        where e.school_id = $1 and (e.board_roll_no = $2 or (e.class_code = $3 and lower(regexp_replace(st.name, '\\s+', ' ', 'g')) = lower($4)))
        order by (e.board_roll_no = $2) desc nulls last, upper_inf(e.period) desc limit 1`, [schoolId, r.roll, input.classCode, r.name.replace(/\s+/g, ' ')]);
    rows.push({ ...r, gender: r.gender ?? prior?.gender ?? null, subjects, result, best5: best, percentage: Math.round((best / 5) * 100) / 100, stream: input.classCode === 'XII' ? streamFrom(subjects.map((x) => x.code)) : null,
      enrolmentId: e?.id ?? prior?.enrolment_id ?? null, matchedTo: e?.name ?? null, update: !!prior, changes, publishedBefore: !!prior?.published_at });
  }
  const summary = { format, supplementary, rows: rows.length, updates: rows.filter((r) => r.update).length, matched: rows.filter((r) => r.enrolmentId).length, passed: rows.filter((r) => r.result === 'PASS').length, skipped };
  if (input.dryRun) return { ...summary, preview: rows.slice(0, 400) };
  return db.tx(async (t) => {
    await t.query(`insert into board_upload (school_id, year, class_code, file_name, format, content, rows, matched, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [schoolId, input.year, input.classCode, input.fileName ?? 'result', format, input.content, summary.rows, summary.matched, actor.id]);
    for (const r of rows) await t.query(
      `insert into board_result (school_id, year, class_code, roll_no, name, gender, stream, enrolment_id, subjects, best5, percentage, result, imported_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (school_id, year, class_code, roll_no) do update set name = excluded.name, gender = excluded.gender, stream = excluded.stream, enrolment_id = excluded.enrolment_id,
         subjects = excluded.subjects, best5 = excluded.best5, percentage = excluded.percentage, result = excluded.result, imported_at = now()`,
      [schoolId, input.year, input.classCode, r.roll, r.name, r.gender, r.stream, r.enrolmentId, JSON.stringify(r.subjects), r.best5, r.percentage, r.result, actor.id]);
    // Families already shown the main result are told when the supplementary result changes it.
    const told = rows.filter((r) => r.update && r.publishedBefore && r.changes.length && r.enrolmentId);
    if (told.length) {
      const kids = (await t.query<{ student_id: string }>('select student_id from enrolment where id = any($1)', [told.map((r) => r.enrolmentId)])).map((x) => x.student_id);
      await notify.toParentsOf(t, kids, { kind: 'RESULT', title: `CBSE Class ${input.classCode} supplementary result`, body: 'The board result in the app now includes the supplementary examination.', link: '/results' });
    }
    return summary;
  }, { actor: actor.label });
}

/** The school publishes the board results: parents of matched children see them in the app and are told. */
export async function publishBoardResults(db: Db, actor: Actor, schoolId: string, year: number, classCode: 'X' | 'XII') {
  await desk(db, actor, schoolId);
  return db.tx(async (t) => {
    const rows = await t.query<{ student_id: string | null }>(
      `with up as (update board_result set published_at = now(), published_by = $4 where school_id = $1 and year = $2 and class_code = $3 and published_at is null returning enrolment_id)
       select e.student_id from up left join enrolment e on e.id = up.enrolment_id`, [schoolId, year, classCode, actor.id]);
    if (!rows.length) throw invalid('There are no unpublished results for this class and year.');
    const kids = rows.map((r) => r.student_id).filter(Boolean) as string[];
    await notify.toParentsOf(t, kids, { kind: 'RESULT', title: `CBSE Class ${classCode} result ${year}`, body: 'The board result is now in the app.', link: '/results' });
    return { published: rows.length, parentsTold: kids.length };
  }, { actor: actor.label });
}

/** A child's published board result, for the parent. */
export async function boardResultFor(db: Db, studentId: string) {
  return db.query(
    `select b.year, b.class_code, b.roll_no, b.subjects, b.percentage::float as percentage, b.result, b.published_at from board_result b join enrolment e on e.id = b.enrolment_id
      where e.student_id = $1 and b.published_at is not null order by b.year desc`, [studentId]);
}

/** Uploaded files, newest first. */
export async function boardUploads(db: Db, actor: Actor, schoolId: string) {
  await desk(db, actor, schoolId);
  return db.query(
    `select u.id, u.year, u.class_code, u.file_name, u.format, u.rows, u.matched, u.uploaded_at, a.name as by,
            (select count(*) from board_result b where b.school_id = u.school_id and b.year = u.year and b.class_code = u.class_code and b.published_at is not null)::int as published
       from board_upload u join app_user a on a.id = u.uploaded_by where u.school_id = $1 order by u.uploaded_at desc`, [schoolId]);
}

/** The board results analysed: pass rate, subject averages, the toppers, and grade spread. */
export async function boardAnalysis(db: Db, actor: Actor, schoolId: string, year: number, classCode: string) {
  await assertUnitInScope(db, actor, schoolId);
  const rows = await db.query<{ roll_no: string; name: string; percentage: number; result: string; subjects: { code: string; name: string; marks: number; grade: string }[] }>(
    `select roll_no, name, percentage::float, result, subjects from board_result where school_id = $1 and year = $2 and class_code = $3 order by percentage desc`, [schoolId, year, classCode]);
  const subj = new Map<string, { name: string; marks: number[] }>();
  for (const r of rows) for (const s of r.subjects) { const x = subj.get(s.code) ?? { name: s.name, marks: [] }; x.marks.push(s.marks); subj.set(s.code, x); }
  return {
    candidates: rows.length, passed: rows.filter((r) => r.result === 'PASS').length,
    passPct: rows.length ? Math.round((rows.filter((r) => r.result === 'PASS').length / rows.length) * 1000) / 10 : 0,
    average: rows.length ? Math.round((rows.reduce((s, r) => s + r.percentage, 0) / rows.length) * 10) / 10 : 0,
    above90: rows.filter((r) => r.percentage >= 90).length,
    toppers: rows.slice(0, 10),
    compartment: rows.filter((r) => r.result !== 'PASS').map((r) => ({ roll_no: r.roll_no, name: r.name, result: r.result })),
    subjects: [...subj.entries()].map(([code, x]) => ({ code, name: x.name, candidates: x.marks.length, average: Math.round((x.marks.reduce((a, b) => a + b, 0) / x.marks.length) * 10) / 10, highest: Math.max(...x.marks), below33: x.marks.filter((m) => m < 33).length })).sort((a, b) => b.average - a.average),
  };
}
