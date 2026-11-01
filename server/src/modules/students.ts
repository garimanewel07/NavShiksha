import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { categorise, studentFacts } from './categories.js';
import { dues } from './fees.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { recordServiceFact, type ServiceInput } from './admissions.js';
import { schoolOf } from './org.js';
import * as transfers from './transfers.js';

import { can, dutySchools, PERMISSIONS, studentGrants } from './access.js';
import { localToday } from '../lib/dates.js';
export { assertStudentAccess } from './access.js';

/**
 * Finding a child. Every member of staff can find any child in their part of NES by name, class or
 * admission number (a teacher on gate duty, a coordinator looking for a student). The list shows
 * only what everyone may see; categories appear only for those who handle them.
 */
export interface StudentFilter { classCode?: string; section?: string; status?: string; offset?: number }

/** Students by name or number, narrowed by class, section and status; a page of 100 at a time (newest search first). */
export async function search(db: Db, actor: Actor, q: string, schoolId?: string, f: StudentFilter = {}) {
  if (!actor.scopePath) throw forbidden();
  const allCategories = await can(db, actor, 'categories.view');
  return db.query(
    `select s.id, s.nes_id, s.name, e.admission_no, e.class_code, sec.name as section, e.status, e.school_id,
            case when $4 or e.school_id = any($5::uuid[]) then e.admission_category end as admission_category,
            o.name as school, c.name as campus
       from student s
       join enrolment e on e.student_id = s.id and upper_inf(e.period)
       join org_unit o on o.id = e.school_id join org_unit c on c.id = e.campus_id
       left join section sec on sec.id = e.section_id
      where o.path <@ $1::ltree and ($2::uuid is null or e.school_id = $2)
        and ($3 = '' or s.name ilike '%' || $3 || '%' or s.nes_id ilike $3 || '%' or e.admission_no ilike '%' || $3 || '%')
        and ($6::text is null or e.class_code = $6) and ($7::text is null or sec.name = $7) and ($8::text is null or e.status = $8)
      order by s.name limit 100 offset $9`, [actor.scopePath, schoolId ?? null, q.trim(), allCategories, dutySchools(actor, PERMISSIONS['categories.view'].duties),
      f.classCode ?? null, f.section ?? null, f.status ?? null, f.offset ?? 0]);
}

/**
 * A child's record, cut to what this person may see (see access.ts): a subject teacher sees the
 * class and attendance, never fees or categories; the accountant sees fees, never health; the
 * class teacher sees the family's contacts; the principal sees everything.
 */
export async function profile(db: Db, actor: Actor, studentId: string) {
  const g = await studentGrants(db, actor, studentId);
  const s = await db.maybeOne<Record<string, unknown>>('select id, nes_id, name, dob::text, gender, apaar_id, pen, blood_group, previous_school from student where id = $1', [studentId]);
  if (!s) throw notFound('Student');
  if (!g.has('health')) s.blood_group = null;
  if (!g.has('contact') && !g.has('documents')) { s.apaar_id = null; s.pen = null; }
  const enrolments = await db.query<Record<string, unknown>>(
    `select e.id, e.school_id, o.name as school, c.name as campus, c.address as campus_address, e.academic_year, e.class_code, cl.name as class_name,
            sec.name as section, e.admission_no, e.status, lower(e.period)::text as from, upper(e.period)::text as to,
            e.admission_category, e.category_snapshot, e.tc_due_date::text,
            (select u.name from app_user u where u.id = class_teacher_of(e.section_id)) as class_teacher
       from enrolment e join org_unit o on o.id = e.school_id join org_unit c on c.id = e.campus_id
       join class_level cl on cl.code = e.class_code left join section sec on sec.id = e.section_id
      where e.student_id = $1 order by lower(e.period) desc`, [studentId]);
  // Staff see only the enrolments inside their part of NES.
  const inScope = actor.role === 'PARENT' ? enrolments : (await db.query<{ id: string }>(
    `select e.id from enrolment e join org_unit o on o.id = e.school_id where e.student_id = $1 and o.path <@ $2::ltree`, [studentId, actor.scopePath])).map((x) => x.id);
  const visible = enrolments.filter((e) => actor.role === 'PARENT' || (inScope as string[]).includes(e.id as string)).map((e) => {
    if (g.has('category')) return e;
    const { admission_category, category_snapshot, ...rest } = e;
    return rest;
  });
  const guardians = await db.query<Record<string, unknown>>(
    `select g.id, g.name, g.phone, g.email, g.address, sg.relationship, sg.is_primary,
            f.service, f.status, f.rank_code, r.name as rank_name, r.band as rank_band, f.posted_in_station, lower(f.valid)::text as since
       from student_guardian sg join guardian g on g.id = sg.guardian_id
       left join guardian_service_fact f on f.guardian_id = g.id and upper_inf(f.valid)
       left join rank r on r.code = f.rank_code
      where sg.student_id = $1 order by sg.is_primary desc`, [studentId]);
  const people = guardians.map((x) => ({
    id: x.id, name: x.name, relationship: x.relationship, is_primary: x.is_primary,
    ...(g.has('contact') ? { phone: x.phone, email: x.email, address: x.address } : {}),
    ...(g.has('service') ? { service: x.service, status: x.status, rank_code: x.rank_code, rank_name: x.rank_name, rank_band: x.rank_band, posted_in_station: x.posted_in_station, since: x.since } : {}),
  }));
  const current = enrolments.find((e) => e.status === 'ACTIVE' || e.status === 'PROVISIONAL');
  let feeBand: unknown = null;
  if (current && g.has('category')) {
    try {
      const { facts } = await studentFacts(db, studentId, localToday());
      feeBand = await categorise(db, current.school_id as string, 'FEE_BAND', localToday(), facts);
    } catch { feeBand = null; }
  }
  const owed = g.has('fee_status') ? (await dues(db, studentId)) as { due_paise: number; due_date: string }[] : null;
  const attendance = g.has('attendance') ? await db.one(
    `select count(*) filter (where m.status = 'P')::int as present, count(*)::int as marked
       from attendance_mark m join attendance_session a on a.id = m.session_id join enrolment e on e.id = m.enrolment_id
      where e.student_id = $1 and a.on_date >= date_trunc('month', current_date)`, [studentId]) : null;
  const today = localToday();
  // Every receipt at every NES school, so a new school sees what was paid before the child joined.
  const payments = g.has('fees') ? await db.query(
    `select p.receipt_no, p.captured_at, p.amount_paise::int, p.method, o.name as school from payment p join org_unit o on o.id = p.school_id
      where p.student_id = $1 order by p.captured_at desc limit 50`, [studentId]) : null;
  return {
    grants: [...g],
    payments,
    student: s,
    enrolments: visible,
    guardians: people,
    feeBand,
    dues: g.has('fees') ? owed : null,
    feeStatus: owed ? (owed.some((d) => d.due_paise > 0 && d.due_date < today) ? 'OVERDUE' : 'CLEAR') : null,
    attendance,
  };
}

/**
 * Transfer within NES on a parent's posting. The current enrolment closes on the transfer date
 * and a new one opens at the destination on the same date, in one transaction; the database
 * guarantees the two never overlap. The NES ID, history and results travel with the child.
 */
/** A posting, promotion or retirement: recorded from its date; categories and fee bands follow. */
export async function changeService(db: Db, actor: Actor, guardianId: string, input: ServiceInput & { from: string; evidence?: string }) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN');
  const kids = await db.query<{ school_id: string }>(
    `select e.school_id from student_guardian sg join enrolment e on e.student_id = sg.student_id and upper_inf(e.period) where sg.guardian_id = $1`, [guardianId]);
  for (const k of kids) await assertUnitInScope(db, actor, k.school_id);
  const id = await db.tx((t) => recordServiceFact(t, guardianId, input.from, input, input.evidence), { actor: actor.label });
  return { factId: id };
}

/**
 * The one place a child's details are corrected (name, date of birth, blood group, APAAR, PEN,
 * previous school). Certificates, ID cards, report cards and the parent app all read them from the
 * student record, so a correction here is a correction everywhere. Kept in the audit log.
 */
export async function updateDetails(db: Db, actor: Actor, studentId: string, input: { name?: string; dob?: string; gender?: 'F' | 'M' | 'X'; bloodGroup?: string | null; apaarId?: string | null; pen?: string | null; previousSchool?: string | null }) {
  const cur = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period) limit 1`, [studentId]);
  if (!cur) throw notFound('Student');
  if (!(await can(db, actor, 'admissions.manage', cur.school_id))) throw forbidden('A child’s details are corrected by the school office (admission in-charge) or the principal.');
  const set = (v: unknown) => v !== undefined;
  await db.tx((t) => t.query(
    `update student set name = coalesce($2, name), dob = coalesce($3::date, dob), gender = coalesce($4, gender),
            blood_group = case when $5 then $6 else blood_group end, apaar_id = case when $7 then $8 else apaar_id end, pen = case when $9 then $10 else pen end,
            previous_school = case when $11 then $12 else previous_school end where id = $1`,
    [studentId, input.name?.trim() || null, input.dob ?? null, input.gender ?? null, set(input.bloodGroup), input.bloodGroup || null, set(input.apaarId), input.apaarId || null,
     set(input.pen), input.pen || null, set(input.previousSchool), input.previousSchool?.trim() || null]), { actor: actor.label });
  return { ok: true };
}

/**
 * A family's details, kept once on the parent and shared by all their children (in any NES
 * school): name, mobile, email, address. The parent may correct their own contact details.
 */
export async function updateGuardian(db: Db, actor: Actor, guardianId: string, input: { name?: string; phone?: string; email?: string | null; address?: string | null }) {
  const own = actor.role === 'PARENT' && actor.guardianId === guardianId;
  if (!own) {
    const schools = await db.query<{ school_id: string }>(
      `select distinct e.school_id from student_guardian sg join enrolment e on e.student_id = sg.student_id where sg.guardian_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`, [guardianId]);
    let ok = false;
    for (const x of schools) if (await can(db, actor, 'admissions.manage', x.school_id)) ok = true;
    if (!ok) throw forbidden('A family’s details are corrected by the school office or by the parent in the app.');
  }
  if (own && input.name) throw forbidden('Ask the school office to correct your name.');
  if (input.phone && !/^\+91[6-9]\d{9}$/.test(input.phone)) throw invalid('Use +91 and a 10-digit mobile number.');
  if (input.phone && await db.maybeOne('select 1 from guardian where phone = $1 and id <> $2', [input.phone, guardianId])) throw conflict('phone', 'Another parent already uses this mobile number.');
  const set = (v: unknown) => v !== undefined;
  await db.tx(async (t) => {
    await t.query(`update guardian set name = coalesce($2, name), phone = coalesce($3, phone), email = case when $4 then $5 else email end, address = case when $6 then $7 else address end where id = $1`,
      [guardianId, input.name?.trim() || null, input.phone ?? null, set(input.email), input.email?.trim() || null, set(input.address), input.address?.trim() || null]);
    if (input.name) await t.query(`update app_user set name = $2 where guardian_id = $1`, [guardianId, input.name.trim()]);
  }, { actor: actor.label });
  return { ok: true };
}
