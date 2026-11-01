import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { categorise, studentFacts } from './categories.js';
import { post, signed } from './ledger.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { studentGrants } from './access.js';
import { schoolOf } from './org.js';
import * as charges from './charges.js';
import * as library from './library.js';
import * as notify from './notify.js';
import * as settings from './settings.js';
import * as approvals from './approvals.js';
import * as refunds from './refunds.js';
import * as fees from './fees.js';
import { localToday } from '../lib/dates.js';

/**
 * Moving between NES schools: a parent's posting, or a TC issued to another NES school.
 *
 * The child stays one NES student, so the new school receives everything at once: NES ID,
 * family and service record, photo, results, attendance history, certificates and documents.
 * Nothing is typed again.
 *
 * Each school charges only for the time the child studied there, and no money passes between
 * schools. A quarter belongs to the school where the child was when it began, so the old school
 * keeps the current quarter and the new school charges from its next one. Quarters the old school
 * had raised for later months are reversed there, with trips and events still to come; what the
 * family had paid for them clears anything else owed at the old school and the rest is refunded
 * by the old school. The new school sees every receipt from the old one and up to when fees are paid.
 */

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export interface MoveInput { studentId: string; toCampusId?: string; sectionId?: string; date: string; reason: string; classCode?: string; viaTc?: string | null }

export async function move(t: Db, actor: Actor, input: MoveInput) {
  const cur = await t.maybeOne<{ id: string; school_id: string; academic_year: string; class_code: string; from: string; section_id: string | null }>(
    `select id, school_id, academic_year, class_code, lower(period)::text as from, section_id from enrolment
      where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') for update`, [input.studentId]);
  if (!cur) throw conflict('not_enrolled', 'The student has no current enrolment to transfer.');
  if (input.date <= cur.from) throw invalid('The transfer date must be after the current enrolment began.');
  // The accepted seat decides the campus; without one (old records, tests) the campus is given.
  const seat = input.sectionId ? await t.one<{ campus_id: string; class_code: string }>('select campus_id, class_code from section where id = $1', [input.sectionId]) : null;
  const toCampusId = seat?.campus_id ?? input.toCampusId;
  if (!toCampusId) throw invalid('Choose the school the child is moving to.');
  const toSchool = await schoolOf(t, toCampusId);
  if (toSchool === cur.school_id) throw invalid('Use a section change for moves within the same school.');
  // Library books come back first (when the school requires it, as for a TC).
  if (await settings.get<boolean>(t, cur.school_id, 'certificates.tc_needs_no_dues')) {
    const books = await library.openForEnrolment(t, cur.id);
    if (books.length) throw conflict('books', `Return the library ${books.length === 1 ? 'book' : 'books'} first: ${books.map((b) => `"${b.title}"`).join(', ')}.`);
  }
  const student = await t.one<{ name: string }>('select name from student where id = $1', [input.studentId]);
  const names = await t.one<{ from_name: string; to_name: string }>(`select (select name from org_unit where id = $1) as from_name, (select name from org_unit where id = $2) as to_name`, [cur.school_id, toSchool]);

  // ── The new enrolment, with the same NES ID and everything attached to the student ──
  const classCode = seat?.class_code ?? input.classCode ?? cur.class_code;
  const { facts } = await studentFacts(t, input.studentId, input.date);
  const cat = await categorise(t, toSchool, 'ADMISSION', input.date, facts);
  const s = await t.one<{ code: string }>('select code from org_unit where id = $1', [toSchool]);
  const counter = await t.one<{ last_no: number }>(
    `insert into admission_counter (school_id, year, last_no) values ($1, $2, 1)
     on conflict (school_id, year) do update set last_no = admission_counter.last_no + 1 returning last_no`, [toSchool, cur.academic_year]);
  const admissionNo = `${s.code}/${cur.academic_year.slice(0, 4)}/${String(counter.last_no).padStart(4, '0')}`;
  // The section with the most room; the school can move the child afterwards.
  const section = input.sectionId
    ? await t.one<{ id: string; label: string }>(`select s.id, s.class_code || '-' || s.name as label from section s where s.id = $1`, [input.sectionId])
    : await t.maybeOne<{ id: string; label: string }>(
      `select s.id, s.class_code || '-' || s.name as label from section s where s.campus_id = $1 and s.academic_year = $2 and s.class_code = $3
        order by (select count(*) from enrolment e where e.section_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL')) - s.capacity, s.name limit 1`, [toCampusId, cur.academic_year, classCode]);
  await t.query(`update enrolment set status = 'TRANSFERRED_OUT', period = daterange(lower(period), $2::date) where id = $1`, [cur.id, input.date]);
  const roll = section ? (await t.one<{ n: number }>(`select coalesce(max(roll_no), 0) + 1 as n from enrolment where section_id = $1 and status in ('ACTIVE', 'PROVISIONAL')`, [section.id])).n : null;
  const ne = await t.one<{ id: string }>(
    `insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot, roll_no)
     values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', daterange($8::date, null), $9, $10, $11) returning id`,
    [input.studentId, toSchool, toCampusId, section?.id ?? null, cur.academic_year, classCode, admissionNo, input.date, cat.code,
     JSON.stringify({ admission: cat, transferredFrom: cur.id, fromSchool: names.from_name, reason: input.reason, tc: input.viaTc ?? null }), roll]);
  await t.query(`update enrolment set transferred_to = $2 where id = $1`, [cur.id, ne.id]);

  const closed = await closeAtSchool(t, actor, { id: cur.id, school_id: cur.school_id, academic_year: cur.academic_year }, input.studentId, input.date, `Moved to ${names.to_name}`);
  const joined = await charges.joinForTransfer(t, actor, ne.id, input.studentId);
  const billed = await fees.billJoiner(t, ne.id);
  const plan = closed.plan;

  // ── Who needs to know ──
  const paidTo = await t.maybeOne<{ label: string }>(
    `select to_char(upper(i.period) - 1, 'FMMonth YYYY') as label from fee_due d join fee_installment i on i.plan_id = $2 and i.code = d.installment_code
      where d.enrolment_id = $1 and d.bill = d.installment_code and d.owed_paise > 0 group by i.period having sum(d.owed_paise - d.paid_paise) <= 0 order by upper(i.period) desc limit 1`,
    [cur.id, plan?.id ?? null]);
  const outstanding = (await t.one<{ due: number }>(`select coalesce(sum(owed_paise - paid_paise), 0)::int as due from fee_due where enrolment_id = $1 and owed_paise > paid_paise`, [cur.id])).due;
  const office = await t.query<{ id: string }>(
    `select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role in ('SCHOOL_ADMIN', 'ACCOUNTANT') and u.scope_path <@ o.path
     union select user_id from duty where school_id = $1 and code = 'ADMISSION_INCHARGE' and valid @> current_date`, [toSchool]);
  await notify.toUsers(t, office.map((o) => o.id), { kind: 'NOTICE', title: `Joining from ${names.from_name}: ${student.name}`,
    body: `Class ${classCode}${section ? `, placed in ${section.label} (roll ${roll})` : ', no section yet'}, from ${notify.fmt(input.date)}. Admission no. ${admissionNo}. Records and results come across with the child.${paidTo ? ` Fees paid at ${names.from_name} up to ${paidTo.label}; charge from the next quarter.` : ''}`.slice(0, 400), link: '/incoming' });
  await notify.toParentsOf(t, [input.studentId], { kind: 'NOTICE', title: `${student.name} now belongs to ${names.to_name}`,
    body: `From ${notify.fmt(input.date)}, admission no. ${admissionNo}${section ? `, Class ${section.label}` : ''}. ${paidTo ? `Fees are paid at ${names.from_name} up to ${paidTo.label}; ${names.to_name} charges from the next quarter. ` : ''}${closed.refundPaise ? `${rupees(closed.refundPaise)} paid for later months will be refunded by ${names.from_name}. ` : ''}${outstanding ? `${rupees(outstanding)} is still due at ${names.from_name}.` : ''}`.slice(0, 400), link: '/' });
  await t.query(`insert into outbox (topic, payload) values ('student.transferred', $1)`, [JSON.stringify({ studentId: input.studentId, from: cur.school_id, to: toSchool, date: input.date })]);
  return { newEnrolmentId: ne.id, admissionNo, admissionCategory: cat.code, section: section?.label ?? null, rollNo: roll, feesPaidUpTo: paidTo?.label ?? null,
    reversedPaise: closed.reversed, chargesReleased: closed.released.released, chargesKept: closed.released.kept, chargesAtNewSchool: joined, instalmentsAtNewSchool: billed, certificatesLapsed: closed.lapsed, refundPaise: closed.refundPaise, outstandingAtPreviousSchoolPaise: outstanding, leaveCancelled: closed.leaveCancelled };
}

/**
 * What ends at a school when a child leaves it on a date (to another NES school, or out of NES):
 * instalments for months after it are reversed, trips and events still to come are released,
 * leave not yet decided is withdrawn, and certificate requests lapse.
 */
export async function closeAtSchool(t: Db, actor: Actor, cur: { id: string; school_id: string; academic_year: string }, studentId: string, date: string, why: string) {
  const plan = await t.maybeOne<{ id: string }>('select id from fee_plan where school_id = $1 and academic_year = $2', [cur.school_id, cur.academic_year]);
  const later = plan ? await t.query<{ code: string; label: string }>(`select code, label from fee_installment where plan_id = $1 and lower(period) >= $2::date order by lower(period)`, [plan.id, date]) : [];
  let reversed = 0;
  for (const inst of later) {
    const heads = await t.query<{ head_code: string; net: number; plan_id: string; version_id: string; fee_band: string; account: string }>(
      `select f.head_code, sum(f.net_paise)::int as net, (array_agg(f.plan_id))[1] as plan_id, (array_agg(f.version_id order by f.created_at))[1] as version_id,
              (array_agg(f.fee_band))[1] as fee_band, h.income_account as account
         from fee_demand f join fee_head h on h.code = f.head_code
        where f.enrolment_id = $1 and f.installment_code = $2 and f.bill = $2 group by f.head_code, h.income_account having sum(f.net_paise) <> 0`, [cur.id, inst.code]);
    if (!heads.length) continue;
    const key = randomUUID();
    for (const h of heads) {
      await t.query(
        `insert into fee_demand (enrolment_id, plan_id, installment_code, head_code, version_id, kind, gross_paise, concession_paise, fee_band, snapshot)
         values ($1, $2, $3, $4, $5, 'ADJUSTMENT', $6, 0, $7, $8)`,
        [cur.id, h.plan_id, inst.code, h.head_code, h.version_id, -h.net, h.fee_band, JSON.stringify({ why: `${why} on ${date}` })]);
      reversed += h.net;
    }
    await post(t, { schoolId: cur.school_id, narration: `${inst.label}: not charged, ${why.toLowerCase()}`, sourceType: 'transfer_reversal', sourceId: `${cur.id}:${inst.code}:${key}`,
      lines: [signed('1200', -heads.reduce((x, h) => x + h.net, 0), 'debit', studentId), ...heads.map((h) => signed(h.account, -h.net, 'credit', studentId))] });
  }
  const released = await charges.releaseForTransfer(t, actor, cur.id, studentId, date);
  const leaves = await t.query<{ id: string }>(`update leave_request set status = 'CANCELLED' where enrolment_id = $1 and status = 'PENDING' returning id`, [cur.id]);
  for (const l of leaves) await approvals.cancel(t, 'student_leave', l.id);
  // Other certificate requests lapse; the new school prepares any it needs (its CEA covers both schools).
  const lapsed = await t.query<{ id: string }>(
    `update certificate set status = 'REJECTED', data = data || jsonb_build_object('rejected', $2::text) where enrolment_id = $1 and status in ('REQUESTED', 'DRAFT', 'PENDING') and kind <> 'TC' returning id`,
    [cur.id, `${why}. Ask the new school if a certificate is still needed.`]);
  for (const l of lapsed) await approvals.cancel(t, 'certificate', l.id);
  // Money paid for what this school no longer provides first clears anything else owed here; the
  // rest is refunded to the family by this school (no money passes between schools).
  await refunds.applyCredit(t, cur.id, `Credit used: ${why.toLowerCase()}`);
  const bills = await t.query<{ bill: string }>(`select bill from fee_due where enrolment_id = $1 group by bill having sum(paid_paise - owed_paise) > 0`, [cur.id]);
  let refundPaise = 0;
  for (const b of bills) refundPaise += (await refunds.requestAuto(t, actor, { enrolmentId: cur.id, bill: b.bill, reason: `${why}: fees paid for later months` }))?.amountPaise ?? 0;
  if (refundPaise) {
    const office = await t.query<{ id: string }>(
      `select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role in ('SCHOOL_ADMIN', 'ACCOUNTANT') and u.scope_path <@ o.path`, [cur.school_id]);
    const child = await t.one<{ name: string }>('select name from student where id = $1', [studentId]);
    await notify.toUsers(t, office.map((o) => o.id), { kind: 'FEES', title: `Refund ${rupees(refundPaise)}: ${child.name}`,
      body: `${why} on ${notify.fmt(date)}. Fees paid for later months are to be refunded to the family; the refund is approved and ready to pay under Charges → Refunds.`, link: '/charges' });
  }
  return { plan, reversed, released, leaveCancelled: leaves.length, lapsed: lapsed.length, refundPaise };
}

/** Children who joined from another NES school, for the new school to check their section. */
export async function incoming(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(
    `select e.id as enrolment_id, s.id as student_id, s.name, s.nes_id, e.admission_no, e.class_code, e.section_id, sec.class_code || '-' || sec.name as section, e.roll_no,
            lower(e.period)::text as joined, e.category_snapshot->>'fromSchool' as from_school, e.category_snapshot->>'reason' as reason, e.category_snapshot->>'tc' as tc,
            (select coalesce(sum(p.amount_paise), 0)::int from payment p join enrolment x on x.id = (e.category_snapshot->>'transferredFrom')::uuid
              where p.student_id = s.id and p.school_id = x.school_id) as paid_before_paise
       from enrolment e join student s on s.id = e.student_id left join section sec on sec.id = e.section_id
      where e.school_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and e.category_snapshot ? 'transferredFrom' and lower(e.period) >= current_date - 120
      order by lower(e.period) desc`, [schoolId]);
}

/** Puts an incoming child in a different section (the roll number follows). */
export async function placeInSection(db: Db, actor: Actor, enrolmentId: string, sectionId: string) {
  const e = await db.maybeOne<{ school_id: string; section_id: string | null }>('select school_id, section_id from enrolment where id = $1 and upper_inf(period)', [enrolmentId]);
  if (!e) throw notFound('Enrolment');
  if (!(actor.role === 'SCHOOL_ADMIN' || actor.role === 'NES_ADMIN' || actor.duties.some((d) => d.code === 'ADMISSION_INCHARGE' && d.schoolId === e.school_id))) throw forbidden('Sections are set by the principal or the office.');
  await assertUnitInScope(db, actor, e.school_id);
  return db.tx(async (t) => {
    const roll = (await t.one<{ n: number }>(`select coalesce(max(roll_no), 0) + 1 as n from enrolment where section_id = $1 and status in ('ACTIVE', 'PROVISIONAL')`, [sectionId])).n;
    await t.query('update enrolment set section_id = $2, roll_no = $3 where id = $1', [enrolmentId, sectionId, roll]);
    return { rollNo: roll };
  }, { actor: actor.label });
}

// ── Requests: asking another Navy Children School or Navy Kindergarten ──────────────────

const OPEN_REQUEST = `('PENDING', 'WAITLISTED', 'ACCEPTED')`;
const today = () => localToday();

interface Current { id: string; school_id: string; academic_year: string; class_code: string; from: string; name: string }

async function current(db: Db, studentId: string) {
  const cur = await db.maybeOne<Current>(
    `select e.id, e.school_id, e.academic_year, e.class_code, lower(e.period)::text as from, s.name from enrolment e join student s on s.id = e.student_id
      where e.student_id = $1 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`, [studentId]);
  if (!cur) throw conflict('not_enrolled', 'The child is not enrolled in a school now.');
  return cur;
}

/** The parent, or the office of the child's present school (principal or admission in-charge). */
async function mayAsk(db: Db, actor: Actor, studentId: string): Promise<'PARENT' | 'SCHOOL'> {
  if (actor.role === 'PARENT') {
    const g = await studentGrants(db, actor, studentId);
    if (!g.has('documents')) throw forbidden();
    return 'PARENT';
  }
  const cur = await current(db, studentId);
  await schoolDesk(db, actor, cur.school_id, 'A move to another school is asked for by the parent or by the school office.');
  return 'SCHOOL';
}

/** A school's admission desk: its principal or the admission in-charge. */
async function schoolDesk(db: Db, actor: Actor, schoolId: string, why: string) {
  const ok = actor.role === 'SCHOOL_ADMIN' || actor.duties.some((d) => d.code === 'ADMISSION_INCHARGE' && d.schoolId === schoolId);
  if (!ok) throw forbidden(why);
  await assertUnitInScope(db, actor, schoolId);
}

async function deskUsers(t: Db, schoolId: string) {
  return (await t.query<{ id: string }>(
    `select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path
     union select user_id from duty where school_id = $1 and code = 'ADMISSION_INCHARGE' and valid @> current_date`, [schoolId])).map((r) => r.id);
}

/** Seats in each section of a class at a school: strength now, and seats already promised to accepted requests. */
async function seats(db: Db, schoolId: string, year: string, classCode: string) {
  return db.query<{ id: string; label: string; campus: string; capacity: number; strength: number; promised: number; free: number }>(
    `select sec.id, sec.class_code || '-' || sec.name as label, c.name as campus, sec.capacity,
            (select count(*) from enrolment e where e.section_id = sec.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))::int as strength,
            (select count(*) from transfer_request r where r.section_id = sec.id and r.status = 'ACCEPTED')::int as promised,
            (sec.capacity - (select count(*) from enrolment e where e.section_id = sec.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))
                          - (select count(*) from transfer_request r where r.section_id = sec.id and r.status = 'ACCEPTED'))::int as free
       from section sec join org_unit c on c.id = sec.campus_id
      where c.parent_id = $1 and c.active and sec.academic_year = $2 and sec.class_code = $3 order by c.name, sec.name`, [schoolId, year, classCode]);
}

/**
 * The Navy Children Schools and Navy Kindergartens that teach the child's class this year (a
 * Navy Kindergarten only its pre-primary classes), with whether seats are free. Staff see the
 * numbers; a parent sees "seats available" or "full: waiting list".
 */
export async function destinations(db: Db, actor: Actor, studentId: string, classCode?: string) {
  const as = await mayAsk(db, actor, studentId);
  const cur = await current(db, studentId);
  const cls = classCode ?? cur.class_code;
  const rows = await db.query<{ school_id: string; name: string; school_type: string; city: string | null; command: string | null; capacity: number; free: number }>(
    `select s.id as school_id, s.name, s.school_type, s.city, m.name as command, sum(sec.capacity)::int as capacity,
            sum(sec.capacity - (select count(*) from enrolment e where e.section_id = sec.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period))
                             - (select count(*) from transfer_request r where r.section_id = sec.id and r.status = 'ACCEPTED'))::int as free
       from org_unit s join org_unit c on c.parent_id = s.id and c.kind = 'campus' and c.active
       join section sec on sec.campus_id = c.id and sec.academic_year = $2 and sec.class_code = $3
       left join org_unit m on m.id = s.parent_id and m.kind = 'command'
      where s.kind = 'school' and s.active and s.school_type in ('NCS', 'NKG') and s.id <> $1
      group by s.id, s.name, s.school_type, s.city, m.name order by s.school_type, s.name`, [cur.school_id, cur.academic_year, cls]);
  const cl = await db.one<{ name: string }>('select name from class_level where code = $1', [cls]);
  return { classCode: cls, className: cl.name, schools: rows.map((r) => ({ schoolId: r.school_id, name: r.name, type: r.school_type, city: r.city, command: r.command,
    available: r.free > 0, ...(as === 'SCHOOL' ? { capacity: r.capacity, free: Math.max(0, r.free) } : {}) })) };
}

/** Asks another school to take the child. That school's office is told; nothing moves until it accepts. */
export async function requestTransfer(db: Db, actor: Actor, input: { studentId: string; toSchoolId: string; joiningOn: string; reason: string; classCode?: string }) {
  const as = await mayAsk(db, actor, input.studentId);
  const cur = await current(db, input.studentId);
  const options = await destinations(db, actor, input.studentId, input.classCode);
  const to = options.schools.find((s) => s.schoolId === input.toSchoolId);
  if (!to) throw invalid(`Choose a Navy Children School or Navy Kindergarten that teaches ${options.className}.`);
  if (input.joiningOn < today()) throw invalid('The joining date cannot be in the past.');
  if (input.reason.trim().length < 3) throw invalid('Give the reason, for example "Father posted to Kochi".');
  const open = await db.maybeOne<{ name: string }>(`select o.name from transfer_request r join org_unit o on o.id = r.to_school_id where r.student_id = $1 and r.status in ${OPEN_REQUEST}`, [input.studentId]);
  if (open) throw conflict('open', `A request to ${open.name} is already open. Cancel it first to ask another school.`);
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into transfer_request (student_id, from_enrolment, from_school_id, to_school_id, class_code, joining_on, reason, requested_by, requested_as)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [input.studentId, cur.id, cur.school_id, to.schoolId, options.classCode, input.joiningOn, input.reason.trim(), actor.id, as]);
    const from = await t.one<{ name: string }>('select name from org_unit where id = $1', [cur.school_id]);
    await notify.toUsers(t, await deskUsers(t, to.schoolId), { kind: 'TRANSFER', title: `Admission asked: ${cur.name}, ${options.className}`,
      body: `From ${from.name}, joining ${notify.fmt(input.joiningOn)}. ${input.reason.trim()}. Check seats and accept, wait-list or decline.`.slice(0, 400), link: '/incoming' }, input.studentId);
    if (as === 'PARENT') {
      await notify.toUsers(t, await deskUsers(t, cur.school_id), { kind: 'TRANSFER', title: `${cur.name} may leave for ${to.name}`,
        body: `The parent has asked ${to.name} for admission from ${notify.fmt(input.joiningOn)}. A TC can be issued once that school accepts.`, link: '/incoming?tab=out' }, input.studentId);
    } else {
      await notify.toParentsOf(t, [input.studentId], { kind: 'TRANSFER', title: `Admission asked at ${to.name}`,
        body: `${from.name} has asked ${to.name} to take ${cur.name} from ${notify.fmt(input.joiningOn)}. You will be told when it replies.`, link: '/certificates' });
    }
    return { id: r.id, status: 'PENDING', toSchool: to.name };
  }, { actor: actor.label });
}

const REQUEST_LIST = `select r.id, r.status, r.class_code, cl.name as class_name, r.joining_on::text, r.reason, r.requested_as, r.created_at, r.decided_at, r.decision_note,
       r.student_id, s.name as student, s.nes_id, s.gender, s.dob::text, e.admission_no, f.name as from_school, r.from_school_id, o.name as to_school, r.to_school_id,
       r.section_id, sec.class_code || '-' || sec.name as section, u.name as requested_by, d.name as decided_by, c.serial_no as tc_serial
  from transfer_request r join student s on s.id = r.student_id join enrolment e on e.id = r.from_enrolment join class_level cl on cl.code = r.class_code
  join org_unit f on f.id = r.from_school_id join org_unit o on o.id = r.to_school_id join app_user u on u.id = r.requested_by
  left join app_user d on d.id = r.decided_by left join section sec on sec.id = r.section_id left join certificate c on c.id = r.certificate_id`;

/** Requests to join this school, open ones first, with the seats in each section of the class. */
export async function incomingRequests(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  const rows = await db.query<Record<string, unknown> & { class_code: string; student_id: string }>(
    `${REQUEST_LIST} where r.to_school_id = $1 and (r.status in ${OPEN_REQUEST} or r.updated_at > now() - interval '60 days')
      order by (r.status in ('PENDING', 'WAITLISTED')) desc, r.created_at desc limit 200`, [schoolId]);
  const year = (await db.maybeOne<{ code: string }>(`select code from academic_year where period @> current_date`))?.code;
  const byClass = new Map<string, unknown>();
  for (const r of rows) if (!byClass.has(r.class_code) && year) byClass.set(r.class_code, await seats(db, schoolId, year, r.class_code));
  // The child's last result and this year's attendance help the decision.
  const out = [];
  for (const r of rows) {
    const att = await db.maybeOne<{ present: number; marked: number }>(
      `select count(*) filter (where m.status in ('P', 'L'))::int as present, count(*)::int as marked
         from attendance_mark m join enrolment e on e.id = m.enrolment_id join attendance_session a on a.id = m.session_id
        where e.student_id = $1 and a.on_date >= (select lower(period) from academic_year where period @> current_date)`, [r.student_id]);
    out.push({ ...r, attendance: att?.marked ? Math.round((att.present / att.marked) * 100) : null, sections: byClass.get(r.class_code) ?? [] });
  }
  return out;
}

/** Requests from this school to others (children leaving), for the office to issue TCs. */
export async function outgoingRequests(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  return db.query(`${REQUEST_LIST} where r.from_school_id = $1 and (r.status in ${OPEN_REQUEST} or r.updated_at > now() - interval '60 days')
    order by (r.status = 'ACCEPTED') desc, r.created_at desc limit 200`, [schoolId]);
}

/** A child's requests, for the parent app and the student record. */
export async function requestsForStudent(db: Db, actor: Actor, studentId: string) {
  const g = await studentGrants(db, actor, studentId);
  if (!g.has('documents') && !g.has('profile')) throw forbidden();
  return db.query(`${REQUEST_LIST} where r.student_id = $1 order by r.created_at desc`, [studentId]);
}

async function loadRequest(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Transfer request');
  const r = await db.maybeOne<{ id: string; status: string; student_id: string; student: string; from_school_id: string; to_school_id: string; class_code: string; class_name: string;
    joining_on: string; requested_by: string; from_name: string; to_name: string; academic_year: string; section_id: string | null }>(
    `select r.id, r.status, r.student_id, s.name as student, r.from_school_id, r.to_school_id, r.class_code, cl.name as class_name, r.joining_on::text, r.requested_by,
            f.name as from_name, o.name as to_name, e.academic_year, r.section_id
       from transfer_request r join student s on s.id = r.student_id join org_unit f on f.id = r.from_school_id join org_unit o on o.id = r.to_school_id
       join enrolment e on e.id = r.from_enrolment join class_level cl on cl.code = r.class_code where r.id = $1`, [id]);
  if (!r) throw notFound('Transfer request');
  return r;
}

/**
 * The new school's answer: accept into a section with a free seat, put on the waiting list, or
 * decline with a reason. The parent and the present school are told.
 */
export async function decide(db: Db, actor: Actor, id: string, input: { decision: 'ACCEPT' | 'WAITLIST' | 'DECLINE'; sectionId?: string; note?: string }) {
  const r = await loadRequest(db, id);
  await schoolDesk(db, actor, r.to_school_id, 'Admissions are decided by the principal or the admission in-charge of the school asked.');
  if (!['PENDING', 'WAITLISTED'].includes(r.status)) throw conflict('decided', 'This request has already been answered.');
  const note = input.note?.trim() || null;
  return db.tx(async (t) => {
    if (input.decision === 'ACCEPT') {
      if (!input.sectionId) throw invalid('Choose the section the child will join.');
      const sec = (await seats(t, r.to_school_id, r.academic_year, r.class_code)).find((x) => x.id === input.sectionId);
      if (!sec) throw invalid(`Choose a ${r.class_name} section of this school.`);
      if (sec.free <= 0) throw conflict('full', `${sec.label} is full: ${sec.strength} children and ${sec.promised} seats promised for ${sec.capacity} places. Choose another section or put the request on the waiting list.`);
      await t.query(`update transfer_request set status = 'ACCEPTED', section_id = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, input.sectionId, actor.id, note]);
      await notify.toParentsOf(t, [r.student_id], { kind: 'TRANSFER', title: `${r.to_name} has accepted ${r.student}`,
        body: `A seat in Class ${sec.label} from ${notify.fmt(r.joining_on)}. ${r.from_name} will now issue the transfer certificate; the records move across by themselves.`, link: '/certificates' });
      await notify.toUsers(t, await deskUsers(t, r.from_school_id), { kind: 'TRANSFER', title: `Accepted at ${r.to_name}: ${r.student}`,
        body: `Seat in Class ${sec.label} from ${notify.fmt(r.joining_on)}. Issue the TC; on issue the child moves there with every record.`, link: '/incoming?tab=out' }, r.student_id);
      return { status: 'ACCEPTED', section: sec.label };
    }
    if (input.decision === 'WAITLIST') {
      if (r.status === 'WAITLISTED') return { status: 'WAITLISTED' };
      await t.query(`update transfer_request set status = 'WAITLISTED', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, note]);
      await notify.toParentsOf(t, [r.student_id], { kind: 'TRANSFER', title: `${r.to_name}: on the waiting list`,
        body: `${r.class_name} is full for now. You will be told as soon as a seat is given.${note ? ` ${note}` : ''}`.slice(0, 400), link: '/certificates' });
      return { status: 'WAITLISTED' };
    }
    if (!note || note.length < 5) throw invalid('Give the reason; the parent and the present school will see it.');
    await t.query(`update transfer_request set status = 'DECLINED', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, note]);
    await notify.toParentsOf(t, [r.student_id], { kind: 'TRANSFER', title: `${r.to_name} cannot take ${r.student}`, body: note, link: '/certificates' });
    await notify.toUsers(t, await deskUsers(t, r.from_school_id), { kind: 'TRANSFER', title: `Declined by ${r.to_name}: ${r.student}`, body: note, link: '/incoming?tab=out' }, r.student_id);
    return { status: 'DECLINED' };
  }, { actor: actor.label });
}

/** Withdraws a request (the parent who asked, or the present school's office). An accepted seat is freed. */
export async function cancelRequest(db: Db, actor: Actor, id: string, reason: string) {
  const r = await loadRequest(db, id);
  if (actor.role === 'PARENT') { const g = await studentGrants(db, actor, r.student_id); if (!g.has('documents')) throw forbidden(); }
  else await schoolDesk(db, actor, r.from_school_id, 'A request is withdrawn by the parent or by the present school office.');
  if (!['PENDING', 'WAITLISTED', 'ACCEPTED'].includes(r.status)) throw conflict('closed', 'This request is already closed.');
  if (reason.trim().length < 3) throw invalid('Give the reason.');
  return db.tx(async (t) => {
    await t.query(`update transfer_request set status = 'CANCELLED', decision_note = $2 where id = $1`, [id, `Withdrawn: ${reason.trim()}`]);
    await notify.toUsers(t, await deskUsers(t, r.to_school_id), { kind: 'TRANSFER', title: `Withdrawn: ${r.student}`, body: `The request to join from ${r.from_name} was withdrawn. ${reason.trim()}`.slice(0, 400), link: '/incoming' }, r.student_id);
    return { status: 'CANCELLED' };
  }, { actor: actor.label });
}

/** The child's open request, if any (for the TC). */
export async function openRequest(db: Db, studentId: string) {
  return db.maybeOne<{ id: string; status: string; to_school_id: string; to_name: string; section_id: string | null; decision_note: string | null }>(
    `select r.id, r.status, r.to_school_id, o.name as to_name, r.section_id, r.decision_note from transfer_request r join org_unit o on o.id = r.to_school_id
      where r.student_id = $1 and r.status in ${OPEN_REQUEST}`, [studentId]);
}

/** Issuing the TC completes an accepted request: the child moves into the promised seat the day after leaving. */
export async function completeRequest(t: Db, actor: Actor, input: { requestId: string; certificateId: string; date: string; reason: string; serial: string }) {
  const r = await t.one<{ status: string; student_id: string; section_id: string }>('select status, student_id, section_id from transfer_request where id = $1 for update', [input.requestId]);
  if (r.status !== 'ACCEPTED') throw conflict('not_accepted', 'The new school has not accepted the child yet.');
  const moved = await move(t, actor, { studentId: r.student_id, sectionId: r.section_id, date: input.date, reason: input.reason, viaTc: input.serial });
  await t.query(`update transfer_request set status = 'COMPLETED', certificate_id = $2, new_enrolment_id = $3 where id = $1`, [input.requestId, input.certificateId, moved.newEnrolmentId]);
  return moved;
}
