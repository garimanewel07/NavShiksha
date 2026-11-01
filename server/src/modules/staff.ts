import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import { last4, mask, open, seal } from '../lib/secret.js';
import type { Actor } from './auth.js';
import { assertCan, can } from './access.js';
import * as notify from './notify.js';
import * as chat from './chat.js';
import * as classTeachers from './classTeachers.js';
import * as duties from './duties.js';
import * as staffLeave from './staffLeave.js';

/**
 * Staff records, the service book, posts, bank accounts, and each school's own pay: its pay
 * structures (as many as it needs), components with dates, pay scales with steps, and what each
 * person is paid. Each school manages all of this for itself; NES and the Commands see it.
 */

const UUID = /^[0-9a-f-]{36}$/i;
export const EMPLOYMENT: Record<string, string> = {
  PERMANENT: 'Permanent', CONTRACT: 'Contract (fixed term)', TEMPORARY: 'Temporary / ad hoc', PART_TIME: 'Part-time',
  GUEST: 'Guest (paid per period)', DAILY_WAGE: 'Daily wage', DEPUTATION: 'On deputation',
};

async function person(db: Db, userId: string) {
  if (!UUID.test(userId)) throw notFound('Staff member');
  const p = await db.maybeOne<{ user_id: string; name: string; role: string; designation: string | null; school_id: string; employment: string; category: string; gender: string | null;
    joined_service: string; separated_on: string | null; contract_until: string | null; confirmed_on: string | null; probation_until: string | null }>(
    `select e.user_id, u.name, u.role, u.designation, e.school_id, e.employment, e.category, e.gender, e.joined_service::text, e.separated_on::text, e.contract_until::text,
            e.confirmed_on::text, e.probation_until::text
       from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  if (!p) throw notFound('Staff member');
  return p;
}

// ── Directory and profile ─────────────────────────────────────────────────────────────────

/** Everyone on a school's staff: their post, employment, pay structure, bank and records state. */
export async function directory(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'staff.view', schoolId);
  const pay = await can(db, actor, 'pay.view', schoolId);
  const rows = await db.query(
    `select u.id as user_id, u.name, u.role, u.designation, e.nes_staff_id, e.employment, e.category, e.joined_service::text, e.contract_until::text, e.separated_on::text,
            e.confirmed_on::text, e.probation_until::text, p.employee_no,
            (select pt.name || coalesce(' · ' || sj.name, '') from appointment a join post po on po.id = a.post_id join post_type pt on pt.code = po.post_type
               left join subject sj on sj.code = po.subject_code where a.user_id = u.id and a.valid @> current_date limit 1) as post,
            ${pay ? `(select s.name from employee_pay ep join pay_structure s on s.id = ep.structure_id where ep.user_id = u.id and ep.valid @> current_date limit 1)` : 'null'} as structure,
            ${pay ? `(select b.status from employee_bank b where b.user_id = u.id order by b.requested_at desc limit 1)` : 'null'} as bank,
            e.user_id is not null as on_record
       from app_user u join org_unit o on o.id = $1
       left join employee e on e.user_id = u.id left join staff_profile p on p.user_id = u.id
      where u.role not in ('PARENT', 'NES_ADMIN', 'COMMAND_OFFICER') and (e.school_id = $1 or (e.user_id is null and u.active and u.scope_path <@ o.path))
      order by (e.separated_on is not null), u.name`, [schoolId]);
  return rows;
}

/** One person's record. Pay, bank and identity details only for those who handle pay. */
export async function profile(db: Db, actor: Actor, userId: string) {
  const self = actor.id === userId;
  const p = await person(db, userId);
  if (!self) await assertCan(db, actor, 'staff.view', p.school_id);
  const pay = self || await can(db, actor, 'pay.view', p.school_id);
  const e = await db.one(
    `select e.nes_staff_id, e.school_id, e.employment, e.category, e.gender, e.joined_service::text, e.probation_until::text, e.confirmed_on::text, e.retirement_on::text,
            e.contract_until::text, e.separated_on::text, e.separation_reason, e.pan_last4, e.aadhaar_last4, e.uan, e.esi_no, o.name as school, e.version,
            e.dob::text, e.blood_group, e.emergency_contact, e.title, e.employee_no, (select phone from app_user where id = e.user_id) as phone, (select email from app_user where id = e.user_id) as email
       from employee e join org_unit o on o.id = e.school_id where e.user_id = $1`, [userId]) as Record<string, unknown>;
  const service = await db.query(
    `select s.id, s.kind, s.on_date::text, s.summary, s.order_ref, s.details, s.corrects, u.name as recorded_by, s.recorded_at, o.name as school
       from service_event s join app_user u on u.id = s.recorded_by join org_unit o on o.id = s.school_id where s.user_id = $1 order by s.on_date, s.recorded_at`, [userId]);
  const posts = await db.query(
    `select a.id, pt.name as post, sj.name as subject, po.pay_level, lower(a.valid)::text as from, upper(a.valid)::text as to, a.order_ref, o.name as school
       from appointment a join post po on po.id = a.post_id join post_type pt on pt.code = po.post_type join org_unit o on o.id = po.school_id
       left join subject sj on sj.code = po.subject_code where a.user_id = $1 order by lower(a.valid) desc`, [userId]);
  // Everything else about the person, read from where it is kept: classes taught, class-teacher role, duties, leave.
  const teaching = await db.query(
    `select l.section_id, s.class_code, s.name as section, l.subject_code, sj.name as subject, l.periods_per_week from teaching_load l join section s on s.id = l.section_id
       join subject sj on sj.code = l.subject_code join class_level cl on cl.code = s.class_code where l.teacher_id = $1 order by cl.ordinal, s.name, sj.name`, [userId]);
  const classTeacher = await db.query(
    `select c.id, c.kind, s.id as section_id, s.class_code || '-' || s.name as section, lower(c.valid)::text as from from class_teacher c join section s on s.id = c.section_id
      where c.user_id = $1 and (upper_inf(c.valid) or upper(c.valid) > current_date) order by lower(c.valid)`, [userId]);
  const dutyRows = await db.query(`select code, lower(valid)::text as from, upper(valid)::text as to from duty where user_id = $1 and (upper_inf(valid) or upper(valid) > current_date)`, [userId]);
  return {
    user: { id: userId, name: p.name, role: p.role, designation: p.designation, schoolId: p.school_id },
    teaching, classTeacher, duties: dutyRows, missing: await missing(db, userId),
    leave: await staffLeave.balances(db, userId),
    employee: { ...e, pan: mask(e.pan_last4 as string, 10), aadhaar: mask(e.aadhaar_last4 as string, 12), employmentLabel: EMPLOYMENT[e.employment as string] },
    service, posts,
    pay: pay ? await db.query(
      `select ep.id, s.name as structure, ep.base_paise::int as base_paise, sc.name as scale, ep.step, sc.steps_paise[ep.step]::int as step_paise, lower(ep.valid)::text as from, upper(ep.valid)::text as to, ep.order_ref
         from employee_pay ep join pay_structure s on s.id = ep.structure_id left join pay_scale sc on sc.id = ep.scale_id where ep.user_id = $1 order by lower(ep.valid) desc`, [userId]) : null,
    components: pay ? await db.query(`select id, code, name, kind, amount_paise::int as amount_paise, lower(valid)::text as from, upper(valid)::text as to, note, approved_by is not null as approved from employee_component where user_id = $1 order by lower(valid) desc`, [userId]) : null,
    bank: pay ? await db.query(
      `select b.id, b.account_last4, b.ifsc, b.bank_name, b.holder_name, b.status, b.requested_at, b.verified_at, r.name as requested_by, v.name as verified_by
         from employee_bank b join app_user r on r.id = b.requested_by left join app_user v on v.id = b.verified_by where b.user_id = $1 order by b.requested_at desc`, [userId]) : null,
  };
}

/** Everything about a new member of staff, asked once. Only the first part is required; the rest can follow on their record. */
export interface StaffInput {
  userId?: string;                                   // someone who already signs in (a teacher already on NavShiksha)
  name?: string; title?: string; designation?: string;
  category: 'TEACHING' | 'NON_TEACHING'; employment: string; gender?: 'F' | 'M' | 'X' | null;
  joinedService: string; contractUntil?: string | null; probationUntil?: string | null; retirementOn?: string | null; orderRef: string;
  phone?: string | null; email?: string | null; dob?: string | null; bloodGroup?: string | null; emergencyContact?: string | null; employeeNo?: string | null;
  postId?: string | null;                            // the vacant sanctioned post they are appointed against
  teaches?: { sectionId: string; subjectCode: string; periodsPerWeek?: number }[];
  classTeacherOf?: { sectionId: string; kind: 'CLASS' | 'CO' } | null;
  duties?: string[];
  pay?: { structureId: string; scaleId?: string | null; step?: number | null; basePaise?: number | null; from?: string } | null;   // from: the joining date, or this month for staff already in service
  bank?: { account: string; ifsc: string; bankName: string; holderName?: string } | null;
  identity?: { pan?: string; aadhaar?: string; uan?: string | null; esiNo?: string | null } | null;
}

const phone91 = (p?: string | null) => (p ? `+91${p.replace(/\D/g, '').slice(-10)}` : null);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Puts a person on the school's staff, from one form. One step gives them their sign-in, NES staff
 * ID, service book, post, the classes and subjects they teach (which the timetable, marks sheets,
 * report cards and cover all follow), their class, duties, pay, salary account (verified by a
 * second person), identity numbers, this year's leave and the staff chat. Nothing is entered again
 * anywhere else; every other screen reads it from here.
 */
export async function enrol(db: Db, actor: Actor, schoolId: string, input: StaffInput) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  if (!EMPLOYMENT[input.employment]) throw invalid('Choose the kind of employment.');
  if (['CONTRACT', 'TEMPORARY'].includes(input.employment) && !input.contractUntil) throw invalid('Give the date the contract or temporary term ends.');
  if (input.contractUntil && input.contractUntil < input.joinedService) throw invalid('The term cannot end before joining.');
  if ((input.pay || input.bank || input.identity) && !(await can(db, actor, 'pay.prepare', schoolId))) throw forbidden('Pay, bank and identity details are entered by the accountant or the principal; leave them for the accountant.');
  const phone = phone91(input.phone);
  if (phone && !/^\+91[6-9][0-9]{9}$/.test(phone)) throw invalid('Give a 10-digit mobile number.');
  const school = await db.one<{ path: string; name: string }>(`select path::text, name from org_unit where id = $1 and kind = 'school'`, [schoolId]);
  const result = await db.tx(async (t) => {
    let userId = input.userId;
    if (userId) {
      const u = await t.maybeOne<{ path: string }>(`select scope_path::text as path from app_user where id = $1 and role not in ('PARENT', 'NES_ADMIN', 'COMMAND_OFFICER')`, [userId]);
      if (!u || !(u.path === school.path || u.path.startsWith(`${school.path}.`))) throw invalid('That person is not on this school’s list of users.');
      if (await t.maybeOne('select 1 from employee where user_id = $1', [userId])) throw conflict('exists', 'This person already has a staff record.');
      await t.query('update app_user set phone = coalesce($2, phone), email = coalesce($3, email) where id = $1', [userId, phone, input.email?.trim() || null]);
    } else {
      if (!input.name || input.name.trim().length < 3) throw invalid('Give the person’s full name.');
      if (phone && await t.maybeOne('select 1 from app_user where phone = $1', [phone])) throw conflict('phone', 'Someone already signs in with this mobile number.');
      userId = (await t.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path, phone, email) values ($1, $2, $3, $4::ltree, $5, $6) returning id`,
        [input.name.trim(), input.category === 'TEACHING' ? 'TEACHER' : 'STAFF', input.title?.trim() || input.designation?.trim() || null, school.path, phone, input.email?.trim() || null])).id;
    }
    const e = await t.one<{ nes_staff_id: string }>(
      `insert into employee (user_id, school_id, employment, category, gender, joined_service, contract_until, probation_until, retirement_on, dob, blood_group, emergency_contact, employee_no, title)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning nes_staff_id`,
      [userId, schoolId, input.employment, input.category, input.gender ?? null, input.joinedService, input.contractUntil ?? null,
       input.employment === 'PERMANENT' ? input.probationUntil ?? null : null, input.retirementOn ?? null, input.dob || null, input.bloodGroup || null,
       input.emergencyContact?.trim() || null, input.employeeNo?.trim() || null, input.title?.trim() || input.designation?.trim() || null]);
    await t.query(`insert into service_event (user_id, school_id, kind, on_date, summary, order_ref, details, recorded_by) values ($1, $2, 'JOINED', $3, $4, $5, $6, $7)`,
      [userId, schoolId, input.joinedService, `Joined ${school.name} · ${EMPLOYMENT[input.employment]}${input.contractUntil ? ` until ${input.contractUntil}` : ''}`, input.orderRef, JSON.stringify({ employment: input.employment }), actor.id]);
    if (input.employment === 'PERMANENT' && input.probationUntil) {
      await t.query(`insert into service_event (user_id, school_id, kind, on_date, summary, order_ref, recorded_by) values ($1, $2, 'PROBATION', $3, $4, $5, $6)`,
        [userId, schoolId, input.joinedService, `On probation until ${input.probationUntil}`, input.orderRef, actor.id]);
    }
    const from = later(input.joinedService, localToday());
    if (input.postId) await appoint(t, actor, input.postId, { userId: userId!, from: input.joinedService, orderRef: input.orderRef });
    if (input.teaches?.length) await assignTeaching(t, actor, schoolId, userId!, input.teaches);
    if (input.classTeacherOf) await classTeachers.assign(t, actor, { sectionId: input.classTeacherOf.sectionId, userId: userId!, kind: input.classTeacherOf.kind, from });
    for (const code of input.duties ?? []) await duties.assign(t, actor, schoolId, { userId: userId!, code, from });
    if (input.pay) await setPay(t, actor, userId!, { ...input.pay, from: input.pay.from ?? later(input.joinedService, localToday().slice(0, 8) + '01'), orderRef: input.orderRef });
    if (input.identity?.pan || input.identity?.aadhaar) await setIdentity(t, actor, userId!, { pan: input.identity.pan, aadhaar: input.identity.aadhaar });
    if (input.identity?.uan || input.identity?.esiNo) await t.query('update employee set uan = coalesce($2, uan), esi_no = coalesce($3, esi_no) where user_id = $1', [userId, input.identity.uan || null, input.identity.esiNo || null]);
    if (input.bank) await requestBank(t, actor, userId!, { ...input.bank, holderName: input.bank.holderName?.trim() || (input.name ?? '').replace(/^(Mr|Mrs|Ms|Dr|Shri|Smt)\.? /, '') });
    // This year's leave, pro rata from the joining date.
    if (['PERMANENT', 'CONTRACT', 'TEMPORARY'].includes(input.employment)) {
      await staffLeave.credit(t, actor.id, [{ user_id: userId!, category: input.category, joined_service: input.joinedService }], Number(localToday().slice(0, 4)));
    }
    await refreshDesignation(t, userId!);
    return { userId: userId!, nesStaffId: e.nes_staff_id };
  }, { actor: actor.label });
  await chat.syncAutoGroups(db);
  return { ...result, missing: await missing(db, result.userId) };
}

/** Everything the "add a member of staff" form offers, in one call: vacant posts, the school's pay, classes needing a teacher, duties. */
export async function formOptions(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  const pay = await can(db, actor, 'pay.prepare', schoolId);
  // Pay is suggested from the school's own records: what others on the same kind of post, or the same kind of employment, are paid on.
  const posts = await db.query(
    `select po.id, po.post_type, pt.name as post, pt.category, sj.name as subject, po.pay_level,
            ${pay ? `(select jsonb_build_object('structureId', ep.structure_id, 'scaleId', ep.scale_id) from employee_pay ep join appointment a on a.user_id = ep.user_id and a.valid @> current_date
               join post p2 on p2.id = a.post_id where p2.school_id = po.school_id and p2.post_type = po.post_type and coalesce(p2.pay_level, 0) = coalesce(po.pay_level, 0) and ep.valid @> current_date
               order by lower(ep.valid) desc limit 1)` : 'null'} as suggest
       from post po join post_type pt on pt.code = po.post_type left join subject sj on sj.code = po.subject_code
      where po.school_id = $1 and po.sanctioned @> current_date and not exists (select 1 from appointment a where a.post_id = po.id and (upper_inf(a.valid) or upper(a.valid) > current_date))
      order by pt.ordinal, sj.name nulls first`, [schoolId]);
  const sections = await db.query(
    `select s.id, s.class_code || '-' || s.name as label, s.class_code,
            (select u.name from class_teacher c join app_user u on u.id = c.user_id where c.section_id = s.id and c.kind = 'CLASS' and c.valid @> current_date) as class_teacher,
            (select u.name from class_teacher c join app_user u on u.id = c.user_id where c.section_id = s.id and c.kind = 'CO' and c.valid @> current_date) as co_class_teacher,
            coalesce((select jsonb_agg(jsonb_build_object('subject_code', l.subject_code, 'subject', sj.name, 'teacher', u.name, 'periods', l.periods_per_week) order by sj.name)
               from teaching_load l join subject sj on sj.code = l.subject_code left join app_user u on u.id = l.teacher_id where l.section_id = s.id), '[]') as load
       from section s join org_unit c on c.id = s.campus_id join class_level cl on cl.code = s.class_code join academic_year y on y.code = s.academic_year
      where c.parent_id = $1 and y.period @> current_date order by cl.ordinal, s.name`, [schoolId]);
  const structures = pay ? await db.query(`select s.id, s.name, s.pf, exists (select 1 from pay_structure_component c where c.structure_id = s.id and c.calc = 'BASE' and c.status = 'APPROVED') as has_base
      from pay_structure s where s.school_id = $1 and s.active order by s.name`, [schoolId]) : [];
  const scales = pay ? (await db.query<{ steps_paise: string[] }>(`select id, name, steps_paise::text[] as steps_paise from pay_scale where school_id = $1 and approved_by is not null order by name`, [schoolId])).map((x) => ({ ...x, steps_paise: x.steps_paise.map(Number) })) : [];
  const byEmployment = pay ? Object.fromEntries((await db.query<{ employment: string; structure_id: string }>(
    `select distinct on (e.employment) e.employment, ep.structure_id from employee e join employee_pay ep on ep.user_id = e.user_id and ep.valid @> current_date
      where e.school_id = $1 and e.separated_on is null group by e.employment, ep.structure_id order by e.employment, count(*) desc`, [schoolId])).map((r) => [r.employment, r.structure_id])) : {};
  return { posts, sections, structures, scales, byEmployment, subjects: await db.query('select code, name from subject order by name'), duties: duties.DUTIES, employment: EMPLOYMENT, canPay: pay };
}

/**
 * The subjects and classes a teacher teaches. This one list is what the timetable is built from,
 * what decides whose marks sheets they fill, and who covers when they are away. Lessons in the
 * timetable now in force that have nobody yet are given to them at once.
 */
export async function assignTeaching(db: Db, actor: Actor, schoolId: string, userId: string, rows: { sectionId: string; subjectCode: string; periodsPerWeek?: number }[]) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  return db.tx(async (t) => {
    let filled = 0;
    for (const r of rows) {
      const ok = await t.maybeOne(`select 1 from section s join org_unit c on c.id = s.campus_id where s.id = $1 and c.parent_id = $2`, [r.sectionId, schoolId]);
      if (!ok) throw invalid('A class in the list is not at this school.');
      await t.query(`insert into teaching_load (section_id, subject_code, teacher_id, periods_per_week) values ($1, $2, $3, $4)
        on conflict (section_id, subject_code) do update set teacher_id = excluded.teacher_id, periods_per_week = coalesce($5, teaching_load.periods_per_week)`,
        [r.sectionId, r.subjectCode, userId, r.periodsPerWeek ?? 6, r.periodsPerWeek ?? null]);
      // Vacant lessons of the timetable in force go to the new teacher where they are free at that time.
      const f = await t.query(
        `update timetable_slot x set teacher_id = $3 from timetable tt
          where x.timetable_id = tt.id and tt.section_id = $1 and tt.valid @> current_date and x.subject_code = $2 and x.teacher_id is null
            and not exists (select 1 from timetable_slot y join timetable u on u.id = y.timetable_id where y.teacher_id = $3 and u.valid && tt.valid and y.weekday = x.weekday and y.period = x.period)
          returning 1`, [r.sectionId, r.subjectCode, userId]);
      filled += f.length;
    }
    await refreshDesignation(t, userId);
    return { saved: rows.length, lessonsFilled: filled };
  }, { actor: actor.label });
}

const SHORT_POST: Record<string, string> = { PGT: 'PGT', TGT: 'TGT', PRT: 'PRT', PTI: 'PTI' };
const HEAD_POSTS = ['PRINCIPAL', 'VICE_PRINCIPAL', 'HEADMISTRESS'];

/**
 * The designation shown everywhere (ID card, chat, payslip, sign-in) is worked out, never typed:
 * the post (or the person's own title), the subject they teach, and their class. "TGT Mathematics,
 * class teacher VIII-B". It changes by itself when any of these change.
 */
export async function refreshDesignation(t: Db, userId: string) {
  const r = await t.maybeOne<{ post_type: string | null; post: string | null; post_category: string | null; post_subject: string | null; title: string | null; employment: string; taught: string | null; ct: string | null; ct_kind: string | null; designation: string | null }>(
    `select po.post_type, pt.name as post, pt.category as post_category, sj.name as post_subject, e.title, e.employment, u.designation,
            (select s2.name from teaching_load l join subject s2 on s2.code = l.subject_code join section x on x.id = l.section_id join org_unit c on c.id = x.campus_id
              where l.teacher_id = e.user_id and c.parent_id = e.school_id group by s2.name order by sum(l.periods_per_week) desc, s2.name limit 1) as taught,
            (select x.class_code || '-' || x.name from class_teacher c join section x on x.id = c.section_id where c.user_id = e.user_id and c.valid @> current_date order by c.kind limit 1) as ct,
            (select c.kind from class_teacher c where c.user_id = e.user_id and c.valid @> current_date order by c.kind limit 1) as ct_kind
       from employee e join app_user u on u.id = e.user_id
       left join appointment a on a.user_id = e.user_id and a.valid @> current_date left join post po on po.id = a.post_id
       left join post_type pt on pt.code = po.post_type left join subject sj on sj.code = po.subject_code
      where e.user_id = $1 and (e.separated_on is null or e.separated_on >= current_date)`, [userId]);
  if (!r) return;
  const head = r.post_type && HEAD_POSTS.includes(r.post_type);
  // A teaching post names the role; for office and support posts the person's own title is more exact ("Gardener").
  const usePost = r.post && !(r.title && r.post_category === 'NON_TEACHING');
  const role = usePost ? (SHORT_POST[r.post_type!] ?? r.post) : r.title ?? (r.employment === 'GUEST' ? 'Guest teacher' : null);
  if (!role) return;
  const subject = head || !usePost ? null : r.post_subject ?? r.taught;
  const parts = [`${role}${subject ? ` ${subject}` : ''}`];
  if (r.ct) parts.push(`${r.ct_kind === 'CLASS' ? 'class teacher' : 'co-class teacher'} ${r.ct}`);
  const d = parts.join(', ');
  if (d !== r.designation) await t.query('update app_user set designation = $2 where id = $1', [userId, d]);
}

/** What is still to be filled in on a person's record, for the office's checklist. */
export async function missing(db: Db, userId: string) {
  const r = await db.one<{ category: string; employment: string; phone: string | null; dob: string | null; post: boolean; teaches: boolean; pay: boolean; bank: boolean; pan: boolean; photo: boolean }>(
    `select e.category, e.employment, u.phone, e.dob::text,
            exists (select 1 from appointment a where a.user_id = e.user_id and a.valid @> current_date) as post,
            exists (select 1 from teaching_load l where l.teacher_id = e.user_id) as teaches,
            exists (select 1 from employee_pay p where p.user_id = e.user_id and (upper_inf(p.valid) or upper(p.valid) > current_date)) as pay,
            exists (select 1 from employee_bank b where b.user_id = e.user_id and b.status in ('PENDING', 'VERIFIED')) as bank,
            e.pan_last4 is not null as pan,
            exists (select 1 from person_photo f where f.owner_kind = 'STAFF' and f.owner_id = e.user_id) as photo
       from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  const out: string[] = [];
  if (!r.phone) out.push('Mobile number (for signing in)');
  if (!r.dob) out.push('Date of birth');
  if (!r.photo) out.push('Photo (for the ID card)');
  if (!r.post && !['GUEST', 'DAILY_WAGE', 'DEPUTATION'].includes(r.employment)) out.push('Post');
  if (r.category === 'TEACHING' && !r.teaches) out.push('Classes and subjects taught');
  if (!r.pay) out.push('Pay');
  if (!r.bank) out.push('Salary bank account');
  if (!r.pan && !['GUEST', 'DAILY_WAGE'].includes(r.employment)) out.push('PAN');
  return out;
}

/**
 * The one place a person's details are corrected: name, mobile, email, date of birth, blood group,
 * emergency contact, title, staff number, gender, UAN. The ID card, chat, payslip and service book
 * all read them from here (history is in the audit log).
 */
export async function updateDetails(db: Db, actor: Actor, userId: string, input: { name?: string; phone?: string | null; email?: string | null; dob?: string | null; bloodGroup?: string | null;
  emergencyContact?: string | null; title?: string | null; employeeNo?: string | null; gender?: 'F' | 'M' | 'X' | null; category?: 'TEACHING' | 'NON_TEACHING'; uan?: string | null; esiNo?: string | null; retirementOn?: string | null }) {
  const p = await person(db, userId);
  if (actor.id !== userId) await assertCan(db, actor, 'staff.manage', p.school_id);
  // In the staff app a person may correct only their own contact details.
  const own = actor.id === userId && !(await can(db, actor, 'staff.manage', p.school_id));
  if (own && Object.keys(input).some((k) => !['phone', 'email', 'emergencyContact', 'bloodGroup'].includes(k))) throw forbidden('Ask the office to correct these details.');
  const phone = input.phone === undefined ? undefined : phone91(input.phone);
  if (phone && !/^\+91[6-9][0-9]{9}$/.test(phone)) throw invalid('Give a 10-digit mobile number.');
  if (phone && await db.maybeOne('select 1 from app_user where phone = $1 and id <> $2', [phone, userId])) throw conflict('phone', 'Someone else signs in with this mobile number.');
  await db.tx(async (t) => {
    await t.query(`update app_user set name = coalesce($2, name), phone = case when $3::boolean then $4 else phone end, email = case when $5::boolean then $6 else email end where id = $1`,
      [userId, input.name?.trim() || null, phone !== undefined, phone ?? null, input.email !== undefined, input.email?.trim() || null]);
    const set = (v: unknown) => v !== undefined;
    await t.query(
      `update employee set gender = coalesce($2, gender), category = coalesce($3, category), uan = coalesce($4, uan), esi_no = coalesce($5, esi_no), retirement_on = coalesce($6::date, retirement_on),
              dob = case when $7 then $8::date else dob end, blood_group = case when $9 then $10 else blood_group end, emergency_contact = case when $11 then $12 else emergency_contact end,
              title = case when $13 then $14 else title end, employee_no = case when $15 then $16 else employee_no end, updated_at = now() where user_id = $1`,
      [userId, input.gender ?? null, input.category ?? null, input.uan ?? null, input.esiNo ?? null, input.retirementOn ?? null,
       set(input.dob), input.dob || null, set(input.bloodGroup), input.bloodGroup || null, set(input.emergencyContact), input.emergencyContact?.trim() || null,
       set(input.title), input.title?.trim() || null, set(input.employeeNo), input.employeeNo?.trim() || null]);
    await refreshDesignation(t, userId);
  }, { actor: actor.label });
  return { ok: true };
}

/** PAN and Aadhaar, stored encrypted. Set by the accountant or principal. */
export async function setIdentity(db: Db, actor: Actor, userId: string, input: { pan?: string; aadhaar?: string }) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  const pan = input.pan?.trim().toUpperCase();
  const aadhaar = input.aadhaar?.replace(/\s/g, '');
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw invalid('A PAN has five letters, four digits and a letter, like ABCDE1234F.');
  if (aadhaar && !/^[2-9][0-9]{11}$/.test(aadhaar)) throw invalid('An Aadhaar number has 12 digits.');
  await db.tx(async (t) => {
    if (pan) await t.query('update employee set pan_last4 = $2, pan_cipher = $3, updated_at = now() where user_id = $1', [userId, last4(pan), seal(pan)]);
    if (aadhaar) await t.query('update employee set aadhaar_last4 = $2, aadhaar_cipher = $3, updated_at = now() where user_id = $1', [userId, last4(aadhaar), seal(aadhaar)]);
  }, { actor: actor.label });
  return { pan: pan ? mask(last4(pan), 10) : undefined, aadhaar: aadhaar ? mask(last4(aadhaar), 12) : undefined };
}

/** Shows a full identity number to someone who handles pay; every view is recorded with its purpose. */
export async function revealIdentity(db: Db, actor: Actor, userId: string, field: 'PAN' | 'AADHAAR', purpose: string) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  if (purpose.trim().length < 4) throw invalid('Say why you need the full number; it is recorded.');
  const r = await db.one<{ v: string | null }>(`select ${field === 'PAN' ? 'pan_cipher' : 'aadhaar_cipher'} as v from employee where user_id = $1`, [userId]);
  if (!r.v) throw notFound('Number');
  await db.tx((t) => t.query('insert into pii_view (user_id, field, viewed_by, purpose) values ($1, $2, $3, $4)', [userId, field, actor.id, purpose.trim()]), { actor: actor.label });
  return { value: open(r.v) };
}

// ── Handing over when someone leaves or moves ─────────────────────────────────────────────

/**
 * From the day a person stops working at a school: their class-teacher roles end, the classes they
 * taught are marked as needing a teacher (so the timetable and marks sheets show the gap), and
 * their lessons in the timetable in force are covered day by day until it is re-published.
 */
async function handOver(t: Db, actor: Actor, userId: string, schoolId: string, from: string, reason: string) {
  // Not started yet: removed. Started: ended (an assignment that began on or after the last day is kept to that one day).
  const ct = await t.query(`delete from class_teacher where user_id = $1 and lower(valid) >= $2::date and lower(valid) > current_date returning 1`, [userId, from]);
  const ct2 = await t.query(`update class_teacher set valid = daterange(lower(valid), greatest($2::date, lower(valid) + 1))
                               where user_id = $1 and (upper_inf(valid) or upper(valid) > greatest($2::date, lower(valid) + 1)) returning 1`, [userId, from]);
  const load = await t.query(
    `update teaching_load l set teacher_id = null from section s join org_unit c on c.id = s.campus_id
      where l.section_id = s.id and c.parent_id = $2 and l.teacher_id = $1 returning l.periods_per_week`, [userId, schoolId]);
  const lessons = await t.one<{ n: number }>(
    `select count(*)::int as n from timetable_slot x join timetable tt on tt.id = x.timetable_id join section s on s.id = tt.section_id join org_unit c on c.id = s.campus_id
      where x.teacher_id = $1 and c.parent_id = $2 and (upper_inf(tt.valid) or upper(tt.valid) > $3::date)`, [userId, schoolId, from]);
  if (lessons.n) await t.query(`insert into teacher_absence (school_id, teacher_id, period, reason, recorded_by) values ($1, $2, daterange($3::date, null), $4, $5) on conflict do nothing`,
    [schoolId, userId, from, `No longer at the school: ${reason}`.slice(0, 200), actor.id]);
  const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path and u.id <> $2`, [schoolId, userId]);
  if (load.length || ct.length + ct2.length) {
    const name = (await t.one<{ name: string }>('select name from app_user where id = $1', [userId])).name;
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'NOTICE', title: `${name}'s classes need a teacher`,
      body: `${load.length} class-subject${load.length === 1 ? '' : 's'}${ct.length + ct2.length ? ' and a class-teacher role' : ''} from ${from}. Their lessons are covered day by day until the timetable is re-published.`, link: '/timetable' });
  }
  return { classTeacher: ct.length + ct2.length, classesTaught: load.length, weeklyLessons: lessons.n };
}

// ── The service book ───────────────────────────────────────────────────────────────────────

/**
 * Adds to the service book. Some entries change the record: confirmation, a contract renewed,
 * being made permanent, a transfer to another Navy school, separation. Nothing is ever edited:
 * a mistake is corrected by a new entry that cites it.
 */
export async function addEvent(db: Db, actor: Actor, userId: string, input: { kind: string; onDate: string; summary: string; orderRef?: string | null; corrects?: string | null;
  contractUntil?: string | null; toSchoolId?: string | null; reason?: string | null }) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'staff.manage', p.school_id);
  if (p.separated_on && input.kind !== 'CORRECTION' && input.kind !== 'NOTE') throw conflict('separated', 'This person has left; only corrections and notes can be added.');
  if (input.summary.trim().length < 3) throw invalid('Write what happened.');
  if (['CONFIRMED', 'CONTRACT_RENEWED', 'MADE_PERMANENT', 'PROMOTION', 'TRANSFER', 'SEPARATION', 'PENALTY'].includes(input.kind) && !input.orderRef?.trim()) throw invalid('Give the order number for this entry.');
  return db.tx(async (t) => {
    const details: Record<string, unknown> = {};
    if (input.kind === 'CONFIRMED') {
      if (p.employment !== 'PERMANENT') throw invalid('Only permanent staff are confirmed after probation.');
      await t.query('update employee set confirmed_on = $2, updated_at = now() where user_id = $1', [userId, input.onDate]);
    }
    if (input.kind === 'CONTRACT_RENEWED') {
      if (!['CONTRACT', 'TEMPORARY'].includes(p.employment)) throw invalid('Only contract and temporary staff have terms to renew.');
      if (!input.contractUntil || input.contractUntil <= (p.contract_until ?? '')) throw invalid('The new term must end later than the present one.');
      await t.query('update employee set contract_until = $2, updated_at = now() where user_id = $1', [userId, input.contractUntil]);
      Object.assign(details, { from: p.contract_until, until: input.contractUntil });
    }
    if (input.kind === 'MADE_PERMANENT') {
      if (p.employment === 'PERMANENT') throw invalid('Already permanent.');
      await t.query(`update employee set employment = 'PERMANENT', contract_until = null, updated_at = now() where user_id = $1`, [userId]);
      Object.assign(details, { was: p.employment });
    }
    if (input.kind === 'TRANSFER') {
      if (!input.toSchoolId) throw invalid('Choose the school the person moves to.');
      const to = await t.maybeOne<{ path: string; name: string }>(`select path::text, name from org_unit where id = $1 and kind = 'school' and active`, [input.toSchoolId]);
      if (!to || input.toSchoolId === p.school_id) throw invalid('Choose another Navy school.');
      // The person keeps their NES staff ID, service book and leave balance; the new school pays them from the date.
      await t.query(`update appointment set valid = daterange(lower(valid), $2::date) where user_id = $1 and valid @> $2::date`, [userId, input.onDate]);
      await t.query(`update employee_pay set valid = daterange(lower(valid), $2::date) where user_id = $1 and upper_inf(valid)`, [userId, input.onDate]);
      await t.query(`update employee set school_id = $2, updated_at = now() where user_id = $1`, [userId, input.toSchoolId]);
      await t.query(`update app_user set scope_path = $2::ltree where id = $1`, [userId, to.path]);
      await t.query(`update duty set valid = daterange(lower(valid), $2::date) where user_id = $1 and valid @> $2::date`, [userId, input.onDate]).catch(() => null);
      Object.assign(details, { from: p.school_id, to: input.toSchoolId, toName: to.name, handedOver: await handOver(t, actor, userId, p.school_id, input.onDate, `Transferred to ${to.name}`) });
    }
    if (input.kind === 'SEPARATION') {
      if (!input.reason?.trim()) throw invalid('Give the reason for leaving (retired, resigned, contract ended, …).');
      await t.query(`update employee set separated_on = $2, separation_reason = $3, updated_at = now() where user_id = $1`, [userId, input.onDate, input.reason.trim()]);
      await t.query(`update appointment set valid = daterange(lower(valid), ($2::date + 1)) where user_id = $1 and upper_inf(valid)`, [userId, input.onDate]);
      await t.query(`update employee_pay set valid = daterange(lower(valid), ($2::date + 1)) where user_id = $1 and upper_inf(valid)`, [userId, input.onDate]);
      await t.query(`update duty set valid = daterange(lower(valid), ($2::date + 1)) where user_id = $1 and (upper_inf(valid) or upper(valid) > $2::date + 1) and lower(valid) <= $2::date`, [userId, input.onDate]);
      await t.query(`delete from duty where user_id = $1 and lower(valid) > $2::date`, [userId, input.onDate]);
      Object.assign(details, { reason: input.reason.trim(), handedOver: await handOver(t, actor, userId, p.school_id, addDays(input.onDate, 1), input.reason.trim()) });
    }
    if (input.kind === 'CORRECTION' && !input.corrects) throw invalid('Choose the entry being corrected.');
    if (input.corrects && !(await t.maybeOne('select 1 from service_event where id = $1 and user_id = $2', [input.corrects, userId]))) throw invalid('That entry is not in this service book.');
    const r = await t.one<{ id: string }>(
      `insert into service_event (user_id, school_id, kind, on_date, summary, order_ref, corrects, details, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [userId, p.school_id, input.kind, input.onDate, input.summary.trim(), input.orderRef?.trim() || null, input.corrects ?? null, JSON.stringify(details), actor.id]);
    await notify.toUsers(t, [userId], { kind: 'PAY', title: 'Service book updated', body: input.summary.trim().slice(0, 200), link: '/my/pay' });
    if (!['TRANSFER', 'SEPARATION'].includes(input.kind)) await refreshDesignation(t, userId);
    return { id: r.id, handedOver: (details.handedOver as Record<string, number> | undefined) ?? null };
  }, { actor: actor.label });
}

/** Contracts and temporary terms ending soon, and probations due for confirmation. */
export async function dueSoon(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'staff.view', schoolId);
  return db.query(
    `select u.id as user_id, u.name, e.employment, e.contract_until::text, e.probation_until::text,
            case when e.contract_until is not null then 'TERM_ENDS' else 'CONFIRMATION_DUE' end as what
       from employee e join app_user u on u.id = e.user_id
      where e.school_id = $1 and e.separated_on is null
        and ((e.contract_until is not null and e.contract_until <= current_date + 60) or (e.probation_until is not null and e.confirmed_on is null and e.probation_until <= current_date + 30))
      order by coalesce(e.contract_until, e.probation_until)`, [schoolId]);
}

// ── Posts ──────────────────────────────────────────────────────────────────────────────────

/** Sanctioned posts with who holds each now; vacancies are posts with nobody. */
export async function posts(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'staff.view', schoolId);
  return db.query(
    `select po.id, po.post_type, pt.name as post, pt.category, po.subject_code, sj.name as subject, po.pay_level, lower(po.sanctioned)::text as sanctioned_from, po.order_ref,
            a.user_id, u.name as holder, lower(a.valid)::text as holder_from, e.employment
       from post po join post_type pt on pt.code = po.post_type left join subject sj on sj.code = po.subject_code
       left join appointment a on a.post_id = po.id and a.valid @> current_date left join app_user u on u.id = a.user_id left join employee e on e.user_id = a.user_id
      where po.school_id = $1 and po.sanctioned @> current_date order by pt.ordinal, sj.name nulls first, holder nulls last`, [schoolId]);
}

export async function postTypes(db: Db) {
  return db.query('select code, name, category from post_type order by ordinal');
}

export async function addPost(db: Db, actor: Actor, schoolId: string, input: { postType: string; subjectCode?: string | null; payLevel?: number | null; from: string; orderRef: string; count?: number }) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  const n = Math.min(Math.max(input.count ?? 1, 1), 50);
  await db.tx(async (t) => {
    for (let i = 0; i < n; i++) await t.query(`insert into post (school_id, post_type, subject_code, pay_level, sanctioned, order_ref, created_by) values ($1, $2, $3, $4, daterange($5::date, null), $6, $7)`,
      [schoolId, input.postType, input.subjectCode || null, input.payLevel ?? null, input.from, input.orderRef.trim(), actor.id]);
  }, { actor: actor.label });
  return { added: n };
}

export async function abolishPost(db: Db, actor: Actor, postId: string, onDate: string) {
  const p = await db.maybeOne<{ school_id: string }>('select school_id from post where id = $1', [postId]);
  if (!p) throw notFound('Post');
  await assertCan(db, actor, 'staff.manage', p.school_id);
  if (await db.maybeOne('select 1 from appointment where post_id = $1 and (upper_inf(valid) or upper(valid) > $2::date)', [postId, onDate])) throw conflict('held', 'Someone holds this post; end their appointment first.');
  await db.tx((t) => t.query('update post set sanctioned = daterange(lower(sanctioned), $2::date) where id = $1', [postId, onDate]), { actor: actor.label });
  return { ok: true };
}

/** Appoints a person to a vacant post from a date (ending any other post they hold). */
export async function appoint(db: Db, actor: Actor, postId: string, input: { userId: string; from: string; orderRef: string }) {
  const p = await db.maybeOne<{ school_id: string; name: string }>('select po.school_id, pt.name from post po join post_type pt on pt.code = po.post_type where po.id = $1', [postId]);
  if (!p) throw notFound('Post');
  await assertCan(db, actor, 'staff.manage', p.school_id);
  const e = await person(db, input.userId);
  if (e.school_id !== p.school_id) throw invalid('That person is not on this school’s staff.');
  return db.tx(async (t) => {
    await t.query(`update appointment set valid = daterange(lower(valid), $2::date) where user_id = $1 and valid @> $2::date and lower(valid) < $2::date`, [input.userId, input.from]);
    await t.query(`insert into appointment (post_id, user_id, valid, order_ref, created_by) values ($1, $2, daterange($3::date, null), $4, $5)`, [postId, input.userId, input.from, input.orderRef.trim(), actor.id]);
    await t.query(`insert into service_event (user_id, school_id, kind, on_date, summary, order_ref, recorded_by) values ($1, $2, 'NOTE', $3, $4, $5, $6)`,
      [input.userId, p.school_id, input.from, `Appointed against the post of ${p.name}`, input.orderRef.trim(), actor.id]);
    await refreshDesignation(t, input.userId);
    return { ok: true };
  }, { actor: actor.label });
}

// ── Bank accounts ──────────────────────────────────────────────────────────────────────────

/** A new salary account: from the person themself (staff app) or the accountant. A second person verifies it. */
export async function requestBank(db: Db, actor: Actor, userId: string, input: { account: string; ifsc: string; bankName: string; holderName: string }) {
  const p = await person(db, userId);
  if (actor.id !== userId) await assertCan(db, actor, 'pay.prepare', p.school_id);
  const acct = input.account.replace(/\s/g, '');
  if (!/^[0-9]{9,18}$/.test(acct)) throw invalid('A bank account number has 9 to 18 digits.');
  const ifsc = input.ifsc.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw invalid('An IFSC has 11 characters, like SBIN0001234.');
  if (await db.maybeOne(`select 1 from employee_bank where user_id = $1 and status = 'PENDING'`, [userId])) throw conflict('pending', 'A bank change is already waiting to be verified.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into employee_bank (user_id, account_last4, account_cipher, ifsc, bank_name, holder_name, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [userId, last4(acct), seal(acct), ifsc, input.bankName.trim(), input.holderName.trim(), actor.id]);
    // The person is always told, so a change they did not make is noticed at once.
    await notify.toUsers(t, [userId], { kind: 'PAY', title: 'Salary bank account change requested', body: `A new account ending ${last4(acct)} (${ifsc}) was entered${actor.id === userId ? ' by you' : ` by ${actor.name}`}. If you did not ask for this, tell the principal now.`, link: '/my/pay' });
    return { id: r.id };
  }, { actor: actor.label });
}

export async function verifyBank(db: Db, actor: Actor, bankId: string, approve: boolean, note?: string) {
  const b = await db.maybeOne<{ user_id: string; requested_by: string; status: string; account_last4: string }>('select user_id, requested_by, status, account_last4 from employee_bank where id = $1', [bankId]);
  if (!b) throw notFound('Bank change');
  const p = await person(db, b.user_id);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  if (b.requested_by === actor.id || b.user_id === actor.id) throw forbidden('A bank change is verified by someone other than the person who asked for it.');
  if (b.status !== 'PENDING') throw conflict('done', 'Already decided.');
  await db.tx(async (t) => {
    await t.query(`update employee_bank set status = $2, verified_by = $3, verified_at = now(), note = $4 where id = $1`, [bankId, approve ? 'VERIFIED' : 'REJECTED', actor.id, note?.trim() || null]);
    await notify.toUsers(t, [b.user_id], { kind: 'PAY', title: approve ? 'New salary account verified' : 'Bank change not accepted', body: approve ? `Salary goes to the account ending ${b.account_last4} after the waiting period.` : note?.trim() || 'Please check the details and ask again.', link: '/my/pay' });
  }, { actor: actor.label });
  return { status: approve ? 'VERIFIED' : 'REJECTED' };
}

/** The account salary is paid into on a date: the latest verified one that has passed its waiting period. */
export async function bankFor(t: Db, userId: string, onDate: string, coolingDays: number) {
  return t.maybeOne<{ id: string; account_last4: string; account_cipher: string; ifsc: string; bank_name: string; holder_name: string; verified_at: string }>(
    `select id, account_last4, account_cipher, ifsc, bank_name, holder_name, verified_at::text
       from employee_bank where user_id = $1 and status = 'VERIFIED' and verified_at::date <= $2::date - $3::int order by verified_at desc limit 1`, [userId, onDate, coolingDays]);
}

export async function pendingBanks(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  return db.query(
    `select b.id, u.name, b.account_last4, b.ifsc, b.bank_name, b.holder_name, b.requested_at, r.name as requested_by, b.requested_by = $2 as mine
       from employee_bank b join employee e on e.user_id = b.user_id join app_user u on u.id = b.user_id join app_user r on r.id = b.requested_by
      where e.school_id = $1 and b.status = 'PENDING' order by b.requested_at`, [schoolId, actor.id]);
}

// ── The school's pay structures, components and scales ─────────────────────────────────────

export async function structures(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'pay.view', schoolId);
  const list = await db.query<{ id: string; school_id: string | null }>(
    `select s.id, s.school_id, s.name, s.description, s.pf, s.esi, s.pt, s.tds, s.active,
            (select count(*) from employee_pay ep where ep.structure_id = s.id and ep.valid @> current_date)::int as people
       from pay_structure s where s.school_id = $1 or (s.school_id is null and s.active) order by (s.school_id is null), s.name`, [schoolId]);
  const comps = await db.query<{ structure_id: string }>(
    `select c.id, c.structure_id, c.code, c.name, c.kind, c.calc, c.percent::float as percent, c.of_codes, c.amount_paise::int as amount_paise, c.unit, c.taxable, c.pf_wage, c.prorate,
            c.ordinal, lower(c.valid)::text as from, upper(c.valid)::text as to, c.status, cb.name as created_by, ab.name as approved_by, c.created_by = $2 as mine
       from pay_structure_component c join app_user cb on cb.id = c.created_by left join app_user ab on ab.id = c.approved_by
      where c.structure_id = any($1) and c.status <> 'REJECTED' and (upper_inf(c.valid) or upper(c.valid) > current_date - 400)
      order by c.ordinal, lower(c.valid)`, [list.map((s) => s.id), actor.id]);
  const scales = await db.query(`select id, name, steps_paise::bigint[] as steps_paise, increment_month, lower(valid)::text as from, approved_by is not null as approved from pay_scale where school_id = $1 or school_id is null order by name`, [schoolId]);
  return { structures: list.map((s) => ({ ...s, template: !s.school_id, components: comps.filter((c) => c.structure_id === s.id) })), scales: (scales as any[]).map((x) => ({ ...x, steps_paise: (x.steps_paise as string[]).map(Number) })) };
}

export async function createStructure(db: Db, actor: Actor, schoolId: string | null, input: { name: string; description?: string; pf: 'NONE' | 'CEILING' | 'ACTUAL'; esi: boolean; pt: boolean; tds: boolean; copyFrom?: string | null; from?: string }) {
  if (schoolId) await assertCan(db, actor, 'pay.prepare', schoolId);
  else if (actor.role !== 'NES_ADMIN') throw forbidden('Templates are published by NES.');
  return db.tx(async (t) => {
    const s = await t.one<{ id: string }>(`insert into pay_structure (school_id, name, description, pf, esi, pt, tds, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [schoolId, input.name.trim(), input.description?.trim() ?? '', input.pf, input.esi, input.pt, input.tds, actor.id]);
    if (input.copyFrom) {
      // Copied components start as drafts for the school to check and approve.
      await t.query(
        `insert into pay_structure_component (structure_id, code, name, kind, calc, percent, of_codes, amount_paise, unit, taxable, pf_wage, prorate, ordinal, valid, created_by)
         select $1, code, name, kind, calc, percent, of_codes, amount_paise, unit, taxable, pf_wage, prorate, ordinal, daterange($3::date, null), $4
           from pay_structure_component where structure_id = $2 and status = 'APPROVED' and valid @> $3::date`, [s.id, input.copyFrom, input.from ?? localToday(), actor.id]);
    }
    return { id: s.id };
  }, { actor: actor.label });
}

async function structureSchool(db: Db, structureId: string) {
  if (!UUID.test(structureId)) throw notFound('Pay structure');
  const s = await db.maybeOne<{ school_id: string | null; name: string }>('select school_id, name from pay_structure where id = $1', [structureId]);
  if (!s) throw notFound('Pay structure');
  return s;
}

export interface ComponentInput { code: string; name: string; kind: 'EARNING' | 'DEDUCTION'; calc: 'BASE' | 'PERCENT' | 'FLAT' | 'PER_UNIT'; percent?: number | null; ofCodes?: string[] | null;
  amountPaise?: number | null; unit?: 'PERIODS' | 'DAYS_PRESENT' | 'HOURS' | null; taxable: boolean; pfWage: boolean; prorate: boolean; ordinal: number; from: string }

/** Proposes a component, or a change to one from a date (a new rate). Someone else approves it. */
export async function proposeComponent(db: Db, actor: Actor, structureId: string, input: ComponentInput) {
  const s = await structureSchool(db, structureId);
  if (s.school_id) await assertCan(db, actor, 'pay.prepare', s.school_id); else if (actor.role !== 'NES_ADMIN') throw forbidden();
  const code = input.code.trim().toUpperCase();
  if (input.calc === 'PERCENT') {
    if (!input.ofCodes?.length) throw invalid('Choose the components the percentage is of.');
    const known = await db.query<{ code: string }>(`select distinct code from pay_structure_component where structure_id = $1 and status = 'APPROVED'`, [structureId]);
    const missing = input.ofCodes.filter((c) => !known.some((k) => k.code === c));
    if (missing.length) throw invalid(`The structure has no approved ${missing.join(', ')} yet.`);
  }
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into pay_structure_component (structure_id, code, name, kind, calc, percent, of_codes, amount_paise, unit, taxable, pf_wage, prorate, ordinal, valid, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, daterange($14::date, null), $15) returning id`,
    [structureId, code, input.name.trim(), input.kind, input.calc, input.calc === 'PERCENT' ? input.percent : null, input.calc === 'PERCENT' ? input.ofCodes : null,
     ['FLAT', 'PER_UNIT'].includes(input.calc) ? input.amountPaise : null, input.calc === 'PER_UNIT' ? input.unit : null, input.taxable, input.pfWage, input.prorate, input.ordinal, input.from, actor.id]), { actor: actor.label });
  return { id: r.id, status: 'DRAFT' };
}

/**
 * Approves a proposed component (by someone other than the proposer). An approved rule of the same
 * code ends the day before the new one starts. If that date is in the past, arrears are due for
 * months already paid: the payroll offers a supplementary run.
 */
export async function decideComponent(db: Db, actor: Actor, componentId: string, approve: boolean) {
  const c = await db.maybeOne<{ structure_id: string; code: string; from: string; status: string; created_by: string }>(
    `select structure_id, code, lower(valid)::text as from, status, created_by from pay_structure_component where id = $1`, [componentId]);
  if (!c) throw notFound('Component');
  const s = await structureSchool(db, c.structure_id);
  if (s.school_id) await assertCan(db, actor, 'pay.approve', s.school_id); else if (actor.role !== 'NES_ADMIN') throw forbidden();
  if (c.created_by === actor.id) throw forbidden('A pay change is approved by someone other than the person who proposed it.');
  if (c.status !== 'DRAFT') throw conflict('decided', 'Already decided.');
  return db.tx(async (t) => {
    if (approve) {
      await t.query(`update pay_structure_component set valid = daterange(lower(valid), $3::date) where structure_id = $1 and code = $2 and status = 'APPROVED' and upper_inf(valid) and lower(valid) < $3::date`,
        [c.structure_id, c.code, c.from]);
      await t.query(`update pay_structure_component set status = 'APPROVED', approved_by = $2, approved_at = now() where id = $1`, [componentId, actor.id]);
    } else await t.query(`update pay_structure_component set status = 'REJECTED' where id = $1`, [componentId]);
    const backdated = approve && c.from < localToday().slice(0, 8) + '01';
    return { status: approve ? 'APPROVED' : 'REJECTED', arrearsFrom: backdated ? c.from.slice(0, 8) + '01' : null };
  }, { actor: actor.label });
}

export async function addScale(db: Db, actor: Actor, schoolId: string, input: { name: string; stepsPaise: number[]; incrementMonth: number; from: string }) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  if (!input.stepsPaise.length || input.stepsPaise.some((x, i) => x <= 0 || (i > 0 && x <= input.stepsPaise[i - 1]))) throw invalid('Steps must be amounts that go up.');
  const r = await db.tx((t) => t.one<{ id: string }>(`insert into pay_scale (school_id, name, steps_paise, increment_month, valid, created_by) values ($1,$2,$3,$4, daterange($5::date, null), $6) returning id`,
    [schoolId, input.name.trim(), input.stepsPaise, input.incrementMonth, input.from, actor.id]), { actor: actor.label });
  return { id: r.id };
}

export async function approveScale(db: Db, actor: Actor, scaleId: string) {
  const s = await db.maybeOne<{ school_id: string; created_by: string; approved_by: string | null }>('select school_id, created_by, approved_by from pay_scale where id = $1', [scaleId]);
  if (!s) throw notFound('Pay scale');
  await assertCan(db, actor, 'pay.approve', s.school_id);
  if (s.created_by === actor.id) throw forbidden('A pay scale is approved by someone other than the person who made it.');
  await db.tx((t) => t.query('update pay_scale set approved_by = $2 where id = $1', [scaleId, actor.id]), { actor: actor.label });
  return { ok: true };
}

/**
 * Fixes a person's pay from a date: their structure and base (an amount, or a step on a scale).
 * The previous record ends the day before. Recorded in the service book.
 */
export async function setPay(db: Db, actor: Actor, userId: string, input: { structureId: string; from: string; basePaise?: number | null; scaleId?: string | null; step?: number | null; orderRef: string; summary?: string }) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  const s = await structureSchool(db, input.structureId);
  if (s.school_id !== p.school_id) throw invalid('Use one of this school’s own pay structures (copy a template first).');
  if (input.scaleId) {
    const sc = await db.maybeOne<{ n: number; approved: boolean; school_id: string }>('select cardinality(steps_paise) as n, approved_by is not null as approved, school_id from pay_scale where id = $1', [input.scaleId]);
    if (!sc || sc.school_id !== p.school_id) throw invalid('Choose one of this school’s pay scales.');
    if (!sc.approved) throw invalid('The pay scale has not been approved yet.');
    if (!input.step || input.step > sc.n) throw invalid(`Choose a step from 1 to ${sc.n}.`);
  }
  if (input.from < p.joined_service) throw invalid('Pay cannot start before joining.');
  return db.tx(async (t) => {
    await t.query(`update employee_pay set valid = daterange(lower(valid), $2::date) where user_id = $1 and valid @> $2::date and lower(valid) < $2::date`, [userId, input.from]);
    if (await t.maybeOne('select 1 from employee_pay where user_id = $1 and lower(valid) >= $2::date', [userId, input.from])) throw conflict('later', 'A later pay record exists; change from its date instead.');
    const r = await t.one<{ id: string }>(`insert into employee_pay (user_id, structure_id, valid, base_paise, scale_id, step, order_ref, recorded_by) values ($1,$2, daterange($3::date, null), $4,$5,$6,$7,$8) returning id`,
      [userId, input.structureId, input.from, input.basePaise ?? null, input.scaleId ?? null, input.step ?? null, input.orderRef.trim(), actor.id]);
    await t.query(`insert into service_event (user_id, school_id, kind, on_date, summary, order_ref, details, recorded_by) values ($1, $2, 'PAY_FIXED', $3, $4, $5, $6, $7)`,
      [userId, p.school_id, input.from, input.summary?.trim() || `Pay fixed: ${s.name}${input.basePaise ? `, ₹${(input.basePaise / 100).toLocaleString('en-IN')}` : ''}${input.step ? `, step ${input.step}` : ''}`,
       input.orderRef.trim(), JSON.stringify({ structureId: input.structureId, basePaise: input.basePaise, scaleId: input.scaleId, step: input.step }), actor.id]);
    return { id: r.id };
  }, { actor: actor.label });
}

/** Yearly increments due: people on a scale whose increment month it is and who are not on the top step. */
export async function incrementsDue(db: Db, actor: Actor, schoolId: string, month: string) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  return db.query(
    `select ep.user_id, u.name, sc.name as scale, ep.step, sc.steps_paise[ep.step]::int as now_paise, sc.steps_paise[ep.step + 1]::int as next_paise
       from employee_pay ep join employee e on e.user_id = ep.user_id join app_user u on u.id = ep.user_id join pay_scale sc on sc.id = ep.scale_id
      where e.school_id = $1 and e.separated_on is null and ep.valid @> $2::date and sc.increment_month = extract(month from $2::date)
        and ep.step < cardinality(sc.steps_paise) and lower(ep.valid) < $2::date - 180
      order by u.name`, [schoolId, month]);
}

export async function grantIncrements(db: Db, actor: Actor, schoolId: string, month: string, userIds: string[]) {
  await assertCan(db, actor, 'pay.approve', schoolId);
  const due = (await incrementsDue(db, actor, schoolId, month) as { user_id: string; step: number }[]).filter((d) => userIds.includes(d.user_id));
  for (const d of due) {
    const cur = await db.one<{ structure_id: string; scale_id: string }>('select structure_id, scale_id from employee_pay where user_id = $1 and valid @> $2::date', [d.user_id, month]);
    await setPay(db, actor, d.user_id, { structureId: cur.structure_id, scaleId: cur.scale_id, step: d.step + 1, from: month, orderRef: `Annual increment ${month.slice(0, 7)}`, summary: `Annual increment: step ${d.step} → ${d.step + 1}` });
  }
  return { granted: due.length };
}

/** An allowance or deduction for one person (headship, society subscription, court attachment), approved by another. */
export async function addPersonComponent(db: Db, actor: Actor, userId: string, input: { code: string; name: string; kind: 'EARNING' | 'DEDUCTION'; taxable: boolean; amountPaise: number; from: string; to?: string | null; note: string }) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into employee_component (user_id, code, name, kind, taxable, amount_paise, valid, note, created_by) values ($1,$2,$3,$4,$5,$6, daterange($7::date, $8::date), $9, $10) returning id`,
    [userId, input.code.trim().toUpperCase(), input.name.trim(), input.kind, input.taxable, input.amountPaise, input.from, input.to ?? null, input.note.trim(), actor.id]), { actor: actor.label });
  return { id: r.id };
}

export async function approvePersonComponent(db: Db, actor: Actor, id: string) {
  const c = await db.maybeOne<{ user_id: string; created_by: string }>('select user_id, created_by from employee_component where id = $1', [id]);
  if (!c) throw notFound('Allowance or deduction');
  const p = await person(db, c.user_id);
  await assertCan(db, actor, 'pay.approve', p.school_id);
  if (c.created_by === actor.id) throw forbidden('Approved by someone other than the person who entered it.');
  await db.tx((t) => t.query('update employee_component set approved_by = $2 where id = $1', [id, actor.id]), { actor: actor.label });
  return { ok: true };
}

// ── Loans and advances ─────────────────────────────────────────────────────────────────────

export async function proposeLoan(db: Db, actor: Actor, userId: string, input: { kind: string; principalPaise: number; instalmentPaise: number; firstMonth: string; note?: string }) {
  const p = await person(db, userId);
  await assertCan(db, actor, 'pay.prepare', p.school_id);
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into staff_loan (user_id, school_id, kind, principal_paise, instalment_paise, first_month, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [userId, p.school_id, input.kind, input.principalPaise, input.instalmentPaise, input.firstMonth, input.note ?? '', actor.id]), { actor: actor.label });
  return { id: r.id };
}

export async function decideLoan(db: Db, actor: Actor, loanId: string, approve: boolean) {
  const l = await db.maybeOne<{ school_id: string; created_by: string; user_id: string }>('select school_id, created_by, user_id from staff_loan where id = $1', [loanId]);
  if (!l) throw notFound('Loan');
  await assertCan(db, actor, 'pay.approve', l.school_id);
  if (l.created_by === actor.id || l.user_id === actor.id) throw forbidden('A loan is sanctioned by someone other than the person who entered it or receives it.');
  await db.tx((t) => t.query(`update staff_loan set status = $2, sanctioned_by = $3, sanctioned_at = now() where id = $1`, [loanId, approve ? 'SANCTIONED' : 'REJECTED', actor.id]), { actor: actor.label });
  return { status: approve ? 'SANCTIONED' : 'REJECTED' };
}

export async function loans(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'pay.view', schoolId);
  return db.query(
    `select l.id, u.name, l.kind, l.principal_paise::int as principal_paise, l.instalment_paise::int as instalment_paise, l.first_month::text, l.status, l.note,
            coalesce((select sum(pl.amount_paise) from payroll_line pl join payroll_run r on r.id = pl.run_id where pl.loan_id = l.id and r.status in ('LOCKED', 'PAID')), 0)::int as recovered_paise,
            cb.name as created_by, l.created_by = $2 as mine
       from staff_loan l join app_user u on u.id = l.user_id join app_user cb on cb.id = l.created_by where l.school_id = $1 order by l.status = 'PROPOSED' desc, l.created_at desc`, [schoolId, actor.id]);
}

