import type { Db } from '../db/client.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { buildFacts, categorise, type ServiceFacts } from './categories.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { schoolOf } from './org.js';
import * as duties from './duties.js';
import { assertCan } from './access.js';
import * as fees from './fees.js';
import { localToday } from '../lib/dates.js';

async function admissionDesk(db: Db, actor: Actor, applicationId: string) {
  const a = await db.maybeOne<{ school_id: string }>('select school_id from application where id = $1', [applicationId]);
  if (!a) throw notFound('Application');
  await duties.assertLeaderOrDuty(db, actor, a.school_id, 'ADMISSION_INCHARGE');
}

export interface ServiceInput {
  service: string; status: string; rankCode?: string | null; civilOfficer?: boolean; postedInStation?: boolean;
}

export interface ApplicationInput {
  campusId: string; academicYear: string; classCode: string;
  child: { name: string; dob: string; gender: 'F' | 'M' | 'X'; bloodGroup?: string | null; apaarId?: string | null; pen?: string | null };
  guardian: { name: string; phone: string; email?: string };
  relationship: 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'GRANDPARENT';
  service: ServiceInput;
  /** Asked once here and carried into the records on admission. */
  address?: string | null; previousSchool?: string | null;
  otherParent?: { name: string; phone: string; email?: string; relationship: 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'GRANDPARENT' } | null;
}

const today = () => localToday();

const toFacts = (s: ServiceInput): ServiceFacts => ({
  service: s.service, status: s.status, rank_code: s.rankCode ?? null,
  civil_officer: !!s.civilOfficer, posted_in_station: !!s.postedInStation,
});

/** Works out both categories for a would-be applicant, with the reasons. Nothing is saved. */
export async function evaluateApplicant(db: Db, schoolId: string, relationship: string, service: ServiceInput, on = today()) {
  const facts = await buildFacts(db, toFacts(service), relationship);
  const admission = await categorise(db, schoolId, 'ADMISSION', on, facts);
  const feeBand = await categorise(db, schoolId, 'FEE_BAND', on, facts);
  return { admission, feeBand, facts };
}

/** Records a change in a guardian's service from a date: the open fact is closed, a new one opens. */
export async function recordServiceFact(db: Db, guardianId: string, from: string, s: ServiceInput, evidence?: string) {
  const open = await db.maybeOne<ServiceFacts & { id: string; from: string }>(
    `select id, lower(valid)::text as from, service, status, rank_code, civil_officer, posted_in_station
       from guardian_service_fact where guardian_id = $1 and upper_inf(valid)`, [guardianId]);
  const next = toFacts(s);
  if (open && open.service === next.service && open.status === next.status && open.rank_code === next.rank_code
      && open.civil_officer === next.civil_officer && open.posted_in_station === next.posted_in_station) return open.id;
  if (open) {
    if (open.from >= from) throw invalid(`A change must start after ${open.from}, when the current record began.`);
    await db.query(`update guardian_service_fact set valid = daterange(lower(valid), $2::date) where id = $1`, [open.id, from]);
  }
  const r = await db.one<{ id: string }>(
    `insert into guardian_service_fact (guardian_id, valid, service, status, rank_code, civil_officer, posted_in_station, evidence)
     values ($1, daterange($2::date, null), $3, $4, $5, $6, $7, $8) returning id`,
    [guardianId, from, next.service, next.status, next.rank_code, next.civil_officer, next.posted_in_station, evidence ?? null]);
  return r.id;
}

export async function submitApplication(db: Db, actor: Actor, input: ApplicationInput) {
  const schoolId = await schoolOf(db, input.campusId);
  if (actor.role !== 'PARENT') await assertCan(db, actor, 'admissions.manage', schoolId);
  const yr = await db.maybeOne<{ start: string }>(`select lower(period)::text as start from academic_year where code = $1`, [input.academicYear]);
  if (!yr) throw invalid('Unknown academic year.');
  return db.tx(async (t) => {
    let g = await t.maybeOne<{ id: string }>('select id from guardian where phone = $1', [input.guardian.phone]);
    if (!g) {
      g = await t.one<{ id: string }>(`insert into guardian (name, phone, email) values ($1, $2, $3) returning id`,
        [input.guardian.name, input.guardian.phone, input.guardian.email ?? null]);
    }
    await recordServiceFact(t, g.id, today(), input.service);
    const ev = await evaluateApplicant(t, schoolId, input.relationship, input.service);
    if (input.otherParent && input.otherParent.phone === input.guardian.phone) throw invalid('The second parent needs their own mobile number.');
    if (input.otherParent && input.otherParent.relationship === input.relationship && input.relationship !== 'GUARDIAN') throw invalid('The two parents cannot have the same relationship.');
    // A brother or sister already at an NES school: the family's address is already known.
    const known = await t.maybeOne<{ address: string | null }>('select address from guardian where id = $1', [g.id]);
    const app = await t.one<{ id: string; ref_no: string }>(
      `insert into application (school_id, campus_id, academic_year, class_code, child_name, child_dob, child_gender, guardian_id, relationship,
                                admission_category, category_priority, fee_band, category_explanation, child_blood_group, child_apaar_id, child_pen, previous_school, address, other_parent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id, ref_no`,
      [schoolId, input.campusId, input.academicYear, input.classCode, input.child.name, input.child.dob, input.child.gender, g.id,
       input.relationship, ev.admission.code, ev.admission.priority, ev.feeBand.code,
       JSON.stringify({ admission: ev.admission, feeBand: ev.feeBand }), input.child.bloodGroup || null, input.child.apaarId || null, input.child.pen || null,
       input.previousSchool?.trim() || null, input.address?.trim() || known?.address || null, input.otherParent ? JSON.stringify(input.otherParent) : null]);
    const docs = new Set(['BIRTH_CERTIFICATE', ...ev.admission.requiredDocs]);
    for (const d of docs) await t.query(`insert into application_document (application_id, doc_type) values ($1, $2)`, [app.id, d]);
    return { ...app, admissionCategory: ev.admission, feeBand: ev.feeBand, documents: [...docs] };
  }, { actor: actor.label });
}

export async function listApplications(db: Db, actor: Actor, schoolId: string, status?: string) {
  await assertCan(db, actor, 'admissions.view', schoolId);
  return db.query(
    `select a.id, a.ref_no, a.child_name, a.class_code, a.status, a.admission_category, a.category_priority, a.fee_band, a.submitted_at,
            c.name as campus, g.name as guardian_name, g.phone,
            (select count(*) filter (where d.status = 'PENDING') from application_document d where d.application_id = a.id)::int as docs_pending
       from application a join org_unit c on c.id = a.campus_id join guardian g on g.id = a.guardian_id
      where a.school_id = $1 and ($2::text is null or a.status = $2)
      order by a.category_priority, a.submitted_at`, [schoolId, status ?? null]);
}

export async function applicationDetail(db: Db, actor: Actor, id: string) {
  const a = await db.maybeOne<Record<string, unknown> & { id: string; school_id: string; status: string }>(
    `select a.*, c.name as campus, g.name as guardian_name, g.phone, cl.name as class_name
       from application a join org_unit c on c.id = a.campus_id join guardian g on g.id = a.guardian_id join class_level cl on cl.code = a.class_code
      where a.id = $1`, [id]);
  if (!a) throw notFound('Application');
  await assertCan(db, actor, 'admissions.view', a.school_id);
  const documents = await db.query('select doc_type, status, note, verified_by, verified_at from application_document where application_id = $1 order by doc_type', [id]);
  return { ...a, documents };
}

export async function verifyDocument(db: Db, actor: Actor, id: string, docType: string, status: 'VERIFIED' | 'REJECTED', note?: string) {
  await admissionDesk(db, actor, id);
  const a = await applicationDetail(db, actor, id);
  return db.tx(async (t) => {
    const r = await t.query(`update application_document set status = $3, note = $4, verified_by = $5, verified_at = now()
                              where application_id = $1 and doc_type = $2 returning 1`, [id, docType, status, note ?? null, actor.name]);
    if (!r.length) throw notFound('Document');
    const pending = await t.one<{ n: number }>(`select count(*)::int as n from application_document where application_id = $1 and status <> 'VERIFIED'`, [id]);
    if (pending.n === 0 && a.status === 'SUBMITTED') await t.query(`update application set status = 'VERIFIED' where id = $1`, [id]);
    return { allVerified: pending.n === 0 };
  }, { actor: actor.label });
}

/** Seats by class for a campus: capacity, filled, offered, and how the filled seats split by category. */
export async function seatMatrix(db: Db, actor: Actor, campusId: string, year: string) {
  const schoolId = await schoolOf(db, campusId);
  await assertCan(db, actor, 'admissions.view', schoolId);
  return db.query(
    `select cl.code as class_code, cl.name as class_name, cl.ordinal,
            coalesce((select sum(capacity) from section s where s.campus_id = $1 and s.academic_year = $2 and s.class_code = cl.code), 0)::int as capacity,
            (select count(*) from enrolment e where e.campus_id = $1 and e.academic_year = $2 and e.class_code = cl.code and e.status in ('ACTIVE', 'PROVISIONAL'))::int as filled,
            (select count(*) from application a where a.campus_id = $1 and a.academic_year = $2 and a.class_code = cl.code and a.status = 'OFFERED')::int as offered,
            (select coalesce(json_object_agg(c, n), '{}') from (select admission_category as c, count(*) as n from enrolment e
               where e.campus_id = $1 and e.academic_year = $2 and e.class_code = cl.code and e.status in ('ACTIVE', 'PROVISIONAL') group by 1) x) as by_category
       from class_level cl
      where exists (select 1 from section s where s.campus_id = $1 and s.academic_year = $2 and s.class_code = cl.code)
      order by cl.ordinal`, [campusId, year]);
}

/**
 * Offers a seat. If the class is full, only a Cat 1 child (highest priority) can still be offered,
 * and the over-capacity reason is recorded: Cat 1 children of serving naval personnel are not refused.
 */
export async function offerSeat(db: Db, actor: Actor, id: string, overCapacityReason?: string) {
  await admissionDesk(db, actor, id);
  return db.tx(async (t) => {
    const a = await t.maybeOne<{ school_id: string; campus_id: string; academic_year: string; class_code: string; status: string; category_priority: number; admission_category: string }>(
      `select school_id, campus_id, academic_year, class_code, status, category_priority, admission_category from application where id = $1 for update`, [id]);
    if (!a) throw notFound('Application');
    await assertUnitInScope(t, actor, a.school_id);
    const seats = await t.one<{ capacity: number; used: number }>(
      `select coalesce((select sum(capacity) from section where campus_id = $1 and academic_year = $2 and class_code = $3), 0)::int as capacity,
              ((select count(*) from enrolment where campus_id = $1 and academic_year = $2 and class_code = $3 and status in ('ACTIVE', 'PROVISIONAL'))
             + (select count(*) from application where campus_id = $1 and academic_year = $2 and class_code = $3 and status = 'OFFERED'))::int as used`,
      [a.campus_id, a.academic_year, a.class_code]);
    let reason: string | null = null;
    if (seats.used >= seats.capacity) {
      if (a.category_priority !== 1) throw conflict('class_full', `Class ${a.class_code} is full (${seats.used}/${seats.capacity}). Put the application on the waitlist.`);
      if (!overCapacityReason) throw conflict('needs_reason', 'The class is full. Cat 1 cannot be refused: give a reason to admit over capacity.');
      reason = overCapacityReason;
    }
    await t.query(`update application set status = 'OFFERED', over_capacity_reason = $2 where id = $1`, [id, reason]);
    await t.query(`insert into outbox (topic, payload) values ('admission.offered', $1)`, [JSON.stringify({ applicationId: id })]);
    return { offered: true, overCapacity: !!reason, seats };
  }, { actor: actor.label });
}

export async function setStatus(db: Db, actor: Actor, id: string, status: 'WAITLISTED' | 'REJECTED' | 'WITHDRAWN', note?: string) {
  await admissionDesk(db, actor, id);
  const a = await applicationDetail(db, actor, id);
  await db.tx((t) => t.query(`update application set status = $2, decision_note = coalesce($3, decision_note) where id = $1`, [id, status, note ?? null]), { actor: actor.label });
  return { id: a.id, status };
}

export async function nextAdmissionNo(db: Db, schoolId: string, year: string) {
  const s = await db.one<{ code: string }>('select code from org_unit where id = $1', [schoolId]);
  const r = await db.one<{ last_no: number }>(
    `insert into admission_counter (school_id, year, last_no) values ($1, $2, 1)
     on conflict (school_id, year) do update set last_no = admission_counter.last_no + 1 returning last_no`, [schoolId, year]);
  return `${s.code}/${year.slice(0, 4)}/${String(r.last_no).padStart(4, '0')}`;
}

/** Places a child in the section of the class with the most free seats. */
export async function pickSection(db: Db, campusId: string, year: string, classCode: string) {
  return db.maybeOne<{ id: string }>(
    `select s.id from section s where s.campus_id = $1 and s.academic_year = $2 and s.class_code = $3
      order by s.capacity - (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL')) desc, s.name limit 1`,
    [campusId, year, classCode]);
}

/**
 * Admits an offered child: creates the student (with a network-wide NES ID), links the guardian,
 * opens the enrolment and closes the application, all in one transaction.
 * Provisional admission (original TC awaited) sets a TC due date.
 */
export async function admit(db: Db, actor: Actor, id: string, opts: { provisional?: boolean; tcDueDate?: string; startDate?: string }) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN');
  return db.tx(async (t) => {
    const a = await t.maybeOne<{ school_id: string; campus_id: string; academic_year: string; class_code: string; status: string; child_name: string; child_dob: string; child_gender: string; guardian_id: string; relationship: string; admission_category: string; category_explanation: unknown;
      child_blood_group: string | null; child_apaar_id: string | null; child_pen: string | null; previous_school: string | null; address: string | null; other_parent: { name: string; phone: string; email?: string; relationship: string } | null }>(
      `select school_id, campus_id, academic_year, class_code, status, child_name, child_dob::text, child_gender, guardian_id, relationship,
              admission_category, category_explanation, child_blood_group, child_apaar_id, child_pen, previous_school, address, other_parent from application where id = $1 for update`, [id]);
    if (!a) throw notFound('Application');
    await assertUnitInScope(t, actor, a.school_id);
    if (a.status !== 'OFFERED') throw conflict('not_offered', 'Only an offered application can be admitted.');
    if (opts.provisional && !opts.tcDueDate) throw invalid('A provisional admission needs a date by which the original TC is due.');
    // Everything from the form goes into the records once: the child, the family's address, both parents.
    const s = await t.one<{ id: string; nes_id: string }>(`insert into student (name, dob, gender, blood_group, apaar_id, pen, previous_school) values ($1, $2, $3, $4, $5, $6, $7) returning id, nes_id`,
      [a.child_name, a.child_dob, a.child_gender, a.child_blood_group, a.child_apaar_id, a.child_pen, a.previous_school]);
    await t.query(`insert into student_guardian (student_id, guardian_id, relationship, is_primary) values ($1, $2, $3, true)`, [s.id, a.guardian_id, a.relationship]);
    const parents = [a.guardian_id];
    if (a.other_parent) {
      const o = await t.maybeOne<{ id: string }>('select id from guardian where phone = $1', [a.other_parent.phone])
        ?? await t.one<{ id: string }>('insert into guardian (name, phone, email) values ($1, $2, $3) returning id', [a.other_parent.name, a.other_parent.phone, a.other_parent.email ?? null]);
      await t.query(`insert into student_guardian (student_id, guardian_id, relationship, is_primary) values ($1, $2, $3, false) on conflict do nothing`, [s.id, o.id, a.other_parent.relationship]);
      parents.push(o.id);
    }
    if (a.address) await t.query('update guardian set address = $2 where id = any($1)', [parents, a.address]);
    // Each parent can sign in to the parent app from the day of admission (brothers and sisters share one sign-in).
    for (const gid of parents) {
      if (await t.maybeOne('select 1 from app_user where guardian_id = $1', [gid])) continue;
      await t.query(`insert into app_user (name, role, guardian_id) select name, 'PARENT', id from guardian where id = $1`, [gid]);
    }
    const section = await pickSection(t, a.campus_id, a.academic_year, a.class_code);
    const admissionNo = await nextAdmissionNo(t, a.school_id, a.academic_year);
    const start = opts.startDate ?? today();
    const e = await t.one<{ id: string }>(
      `insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period,
                              admission_category, category_snapshot, tc_due_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, daterange($9::date, null), $10, $11, $12) returning id`,
      [s.id, a.school_id, a.campus_id, section?.id ?? null, a.academic_year, a.class_code, admissionNo,
       opts.provisional ? 'PROVISIONAL' : 'ACTIVE', start, a.admission_category, JSON.stringify(a.category_explanation), opts.tcDueDate ?? null]);
    await t.query(`update application set status = $2, student_id = $3 where id = $1`, [id, opts.provisional ? 'PROVISIONAL' : 'ADMITTED', s.id]);
    await t.query(`insert into outbox (topic, payload) values ('admission.admitted', $1)`, [JSON.stringify({ studentId: s.id, admissionNo })]);
    // Instalments the school has already raised this year are billed now (earlier quarters too, per the school's setting).
    await fees.billJoiner(t, e.id);
    return { studentId: s.id, nesId: s.nes_id, enrolmentId: e.id, admissionNo, provisional: !!opts.provisional };
  }, { actor: actor.label });
}

/** The original TC has arrived: a provisional admission becomes final. */
export async function confirmProvisional(db: Db, actor: Actor, applicationId: string) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN');
  return db.tx(async (t) => {
    const a = await t.maybeOne<{ school_id: string; student_id: string; status: string }>('select school_id, student_id, status from application where id = $1 for update', [applicationId]);
    if (!a) throw notFound('Application');
    await assertUnitInScope(t, actor, a.school_id);
    if (a.status !== 'PROVISIONAL') throw conflict('not_provisional', 'This admission is not provisional.');
    await t.query(`update application set status = 'ADMITTED' where id = $1`, [applicationId]);
    await t.query(`update enrolment set status = 'ACTIVE' where student_id = $1 and school_id = $2 and status = 'PROVISIONAL'`, [a.student_id, a.school_id]);
    return { confirmed: true };
  }, { actor: actor.label });
}
