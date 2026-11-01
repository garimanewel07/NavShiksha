import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertTeaches } from './sections.js';
import * as notify from './notify.js';

/**
 * Two-way messages. Every recipient is a (child, guardian) pair, so each reply carries the
 * child's name, class, section and admission number and the guardian's relationship.
 */
export async function createThread(db: Db, actor: Actor, input: { sectionId: string; subject: string; body: string; replyMode: 'NONE' | 'ALLOWED' | 'REQUIRED'; options?: string[] }) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN', 'TEACHER');
  const sec = await db.maybeOne<{ school_id: string }>(
    `select c.parent_id as school_id from section s join org_unit c on c.id = s.campus_id where s.id = $1`, [input.sectionId]);
  if (!sec) throw notFound('Section');
  await assertUnitInScope(db, actor, sec.school_id);
  if (actor.role === 'TEACHER') await assertTeaches(db, actor, input.sectionId);
  if (input.replyMode === 'REQUIRED' && input.options && input.options.length === 1) throw invalid('Give at least two answer choices, or none.');
  return db.tx(async (t) => {
    const th = await t.one<{ id: string }>(
      `insert into thread (school_id, subject, created_by, section_id, reply_mode, options) values ($1, $2, $3, $4, $5, $6) returning id`,
      [sec.school_id, input.subject, actor.id, input.sectionId, input.replyMode, input.options ?? []]);
    const r = await t.query(
      `insert into thread_recipient (thread_id, student_id, guardian_id)
       select $1, e.student_id, sg.guardian_id from enrolment e join student_guardian sg on sg.student_id = e.student_id
        where e.section_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL') returning 1`, [th.id, input.sectionId]);
    await t.query(`insert into message (thread_id, author_id, body) values ($1, $2, $3)`, [th.id, actor.id, input.body]);
    await t.query(`insert into outbox (topic, payload) values ('message.new', $1)`, [JSON.stringify({ threadId: th.id, recipients: r.length })]);
    const kids = await t.query<{ student_id: string }>('select distinct student_id from thread_recipient where thread_id = $1', [th.id]);
    await notify.toParentsOf(t, kids.map((k) => k.student_id), {
      kind: 'MESSAGE', title: input.subject, body: input.replyMode === 'REQUIRED' ? 'Reply needed' : input.body.slice(0, 140), link: `/messages/${th.id}` });
    return { threadId: th.id, recipients: r.length };
  }, { actor: actor.label });
}

async function canSeeThread(db: Db, actor: Actor, threadId: string) {
  const th = await db.maybeOne<{ school_id: string; created_by: string }>('select school_id, created_by from thread where id = $1', [threadId]);
  if (!th) throw notFound('Conversation');
  if (actor.role === 'PARENT') {
    const ok = await db.maybeOne('select 1 from thread_recipient where thread_id = $1 and guardian_id = $2', [threadId, actor.guardianId]);
    if (!ok) throw forbidden();
  } else await assertUnitInScope(db, actor, th.school_id);
  return th;
}

export async function inbox(db: Db, actor: Actor) {
  if (actor.role === 'PARENT') {
    return db.query(
      `select t.id, t.subject, t.reply_mode, t.options, t.created_at, u.name as from_name, u.designation as from_designation,
              (select body from message m where m.thread_id = t.id order by created_at limit 1) as preview,
              exists (select 1 from message m where m.thread_id = t.id and m.author_id = (select id from app_user where guardian_id = $1 limit 1)) as replied,
              (select json_agg(json_build_object('studentId', s.id, 'name', s.name)) from thread_recipient r join student s on s.id = r.student_id
                where r.thread_id = t.id and r.guardian_id = $1) as children
         from thread t join app_user u on u.id = t.created_by
        where exists (select 1 from thread_recipient r where r.thread_id = t.id and r.guardian_id = $1)
        order by t.created_at desc`, [actor.guardianId]);
  }
  return db.query(
    `select t.id, t.subject, t.reply_mode, t.options, t.created_at, sec.class_code, sec.name as section,
            (select count(*) from thread_recipient r where r.thread_id = t.id)::int as recipients,
            (select count(distinct m.student_id) from message m where m.thread_id = t.id and m.student_id is not null)::int as replied,
            (select count(*) from message m where m.thread_id = t.id and m.author_id <> $1
               and not exists (select 1 from message_read x where x.message_id = m.id and x.user_id = $1))::int as unread,
            (select max(created_at) from message m where m.thread_id = t.id) as last_at
       from thread t left join section sec on sec.id = t.section_id
      where t.created_by = $1 or ($2 in ('NES_ADMIN', 'SCHOOL_ADMIN') and t.school_id in (select id from org_unit where path <@ $3::ltree))
      order by last_at desc`, [actor.id, actor.role, actor.scopePath]);
}

/** A conversation with every message labelled by who sent it and which child it is about. */
export async function thread(db: Db, actor: Actor, threadId: string) {
  const th = await canSeeThread(db, actor, threadId);
  const head = await db.one(`select t.id, t.subject, t.reply_mode, t.options, t.created_at, sec.class_code, sec.name as section
                               from thread t left join section sec on sec.id = t.section_id where t.id = $1`, [threadId]);
  const messages = await db.query(
    `select m.id, m.body, m.choice, m.created_at, m.author_id = $2 as mine,
            u.name as sender, u.role as sender_role, u.designation,
            s.name as student_name, s.nes_id, e.class_code, sec.name as section, e.admission_no, sg.relationship
       from message m join app_user u on u.id = m.author_id
       left join student s on s.id = m.student_id
       left join enrolment e on e.student_id = s.id and upper_inf(e.period)
       left join section sec on sec.id = e.section_id
       left join student_guardian sg on sg.student_id = s.id and sg.guardian_id = u.guardian_id
      where m.thread_id = $1
        and ($3::uuid is null or m.author_id = $2 or u.role <> 'PARENT')
      order by m.created_at`, [threadId, actor.id, actor.role === 'PARENT' ? actor.guardianId : null]);
  await db.query(`insert into message_read (message_id, user_id) select id, $2 from message where thread_id = $1 on conflict do nothing`, [threadId, actor.id]);
  return { ...head, createdBy: th.created_by, messages };
}

export async function reply(db: Db, actor: Actor, threadId: string, input: { body?: string; choice?: string; studentId?: string }) {
  await canSeeThread(db, actor, threadId);
  const th = await db.one<{ reply_mode: string; options: string[] }>('select reply_mode, options from thread where id = $1', [threadId]);
  if (actor.role === 'PARENT') {
    if (th.reply_mode === 'NONE') throw invalid('Replies are turned off for this message.');
    if (!input.studentId) throw invalid('Say which child this reply is about.');
    const ok = await db.maybeOne('select 1 from thread_recipient where thread_id = $1 and guardian_id = $2 and student_id = $3', [threadId, actor.guardianId, input.studentId]);
    if (!ok) throw forbidden();
  }
  if (input.choice && !th.options.includes(input.choice)) throw invalid('That answer is not one of the choices.');
  if (!input.choice && !input.body?.trim()) throw invalid('Write a reply or choose an answer.');
  const m = await db.tx((t) => t.one<{ id: string }>(
    `insert into message (thread_id, author_id, student_id, body, choice) values ($1, $2, $3, $4, $5) returning id`,
    [threadId, actor.id, actor.role === 'PARENT' ? input.studentId : null, input.body ?? '', input.choice ?? null]), { actor: actor.label });
  return { messageId: m.id };
}

/** For reply-needed messages: who answered what, and who has not answered yet. */
export async function responses(db: Db, actor: Actor, threadId: string) {
  if (actor.role === 'PARENT') throw forbidden();
  await canSeeThread(db, actor, threadId);
  return db.query(
    `select s.id as student_id, s.name as student_name, e.class_code, sec.name as section, e.admission_no,
            g.name as guardian_name, sg.relationship,
            (select m.choice from message m join app_user u on u.id = m.author_id
              where m.thread_id = r.thread_id and m.student_id = r.student_id and u.guardian_id = r.guardian_id order by m.created_at desc limit 1) as choice,
            (select m.body from message m join app_user u on u.id = m.author_id
              where m.thread_id = r.thread_id and m.student_id = r.student_id and u.guardian_id = r.guardian_id order by m.created_at desc limit 1) as note
       from thread_recipient r join student s on s.id = r.student_id join guardian g on g.id = r.guardian_id
       join student_guardian sg on sg.student_id = r.student_id and sg.guardian_id = r.guardian_id
       left join enrolment e on e.student_id = s.id and upper_inf(e.period) left join section sec on sec.id = e.section_id
      where r.thread_id = $1 order by s.name`, [threadId]);
}
