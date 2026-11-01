import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { requireRole } from './auth.js';
import { assertStudentAccess } from './access.js';
import { assertTeaches, currentEnrolment } from './sections.js';
import * as notify from './notify.js';
import { localToday } from '../lib/dates.js';

export interface HomeworkInput { sectionId: string; subjectCode: string; title: string; details?: string; dueOn: string }

/** A teacher sets homework for a section; every parent in the section is notified at once. */
export async function create(db: Db, actor: Actor, input: HomeworkInput) {
  requireRole(actor, 'TEACHER', 'SCHOOL_ADMIN');
  const s = await assertTeaches(db, actor, input.sectionId);
  const today = localToday();
  if (input.dueOn < today) throw invalid('The due date cannot be in the past.');
  return db.tx(async (t) => {
    const h = await t.one<{ id: string }>(
      `insert into homework (section_id, subject_code, title, details, due_on, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.sectionId, input.subjectCode, input.title.trim(), (input.details ?? '').trim(), input.dueOn, actor.id]);
    const kids = await t.query<{ student_id: string }>(
      `select student_id from enrolment where section_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [input.sectionId]);
    const subject = await t.one<{ name: string }>('select name from subject where code = $1', [input.subjectCode]);
    const notified = await notify.toParentsOf(t, kids.map((k) => k.student_id),
      { kind: 'HOMEWORK', title: `${subject.name}: ${input.title.trim()}`, body: `Class ${s.label} · due ${notify.fmt(input.dueOn)}`, link: '/homework' });
    return { id: h.id, notified };
  }, { actor: actor.label });
}

export async function withdraw(db: Db, actor: Actor, id: string) {
  const h = await db.maybeOne<{ section_id: string; created_by: string }>('select section_id, created_by from homework where id = $1', [id]);
  if (!h) throw notFound('Homework');
  await assertTeaches(db, actor, h.section_id);
  if (actor.role === 'TEACHER' && h.created_by !== actor.id) throw forbidden('Only the teacher who set this homework can withdraw it.');
  await db.tx((t) => t.query('update homework set withdrawn_at = now() where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}

/** Homework for a section, newest first, with how many families have ticked it done. */
export async function forSection(db: Db, actor: Actor, sectionId: string) {
  await assertTeaches(db, actor, sectionId);
  return db.query(
    `select h.id, h.subject_code, sj.name as subject, h.title, h.details, h.assigned_on::text, h.due_on::text, h.withdrawn_at,
            u.name as set_by, (select count(*) from homework_done d where d.homework_id = h.id)::int as done,
            (select count(*) from enrolment e where e.section_id = h.section_id and e.status in ('ACTIVE', 'PROVISIONAL'))::int as strength,
            coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'type', a.content_type) order by a.uploaded_at) from attachment a
                       where a.ref_kind = 'homework' and a.ref_id = h.id and a.removed_at is null), '[]') as attachments
       from homework h join subject sj on sj.code = h.subject_code join app_user u on u.id = h.created_by
      where h.section_id = $1 order by h.assigned_on desc, h.created_at desc limit 100`, [sectionId]);
}

/** A child's homework: everything still due, plus the last two weeks. */
export async function forStudent(db: Db, actor: Actor, studentId: string) {
  await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  if (!e.section_id) return [];
  return db.query(
    `select h.id, sj.name as subject, h.subject_code, h.title, h.details, h.assigned_on::text, h.due_on::text, u.name as set_by,
            d.done_at is not null as done,
            coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'type', a.content_type) order by a.uploaded_at) from attachment a
                       where a.ref_kind = 'homework' and a.ref_id = h.id and a.removed_at is null), '[]') as attachments
       from homework h join subject sj on sj.code = h.subject_code join app_user u on u.id = h.created_by
       left join homework_done d on d.homework_id = h.id and d.student_id = $2
      where h.section_id = $1 and h.withdrawn_at is null and (h.due_on >= current_date or h.assigned_on >= current_date - 14)
      order by h.due_on, h.created_at`, [e.section_id, studentId]);
}

export async function setDone(db: Db, actor: Actor, homeworkId: string, studentId: string, done: boolean) {
  requireRole(actor, 'PARENT');
  await assertStudentAccess(db, actor, studentId);
  const e = await currentEnrolment(db, studentId);
  const h = await db.maybeOne('select 1 from homework where id = $1 and section_id = $2 and withdrawn_at is null', [homeworkId, e.section_id]);
  if (!h) throw notFound('Homework');
  await db.tx(async (t) => {
    if (done) await t.query(`insert into homework_done (homework_id, student_id, done_by) values ($1, $2, $3) on conflict do nothing`, [homeworkId, studentId, actor.id]);
    else await t.query('delete from homework_done where homework_id = $1 and student_id = $2', [homeworkId, studentId]);
  }, { actor: actor.label });
  return { done };
}

export const subjects = (db: Db) => db.query('select code, name from subject order by name');
