import { randomInt } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { dateInWords, embedImage, fmtDate, newDocument, NO_CALIBRATION, rupeesInWords, Sheet, type Calibration } from '../lib/pdf.js';
import type { PDFImage } from 'pdf-lib';
import { SUBJECTS_BY_CLASS } from '../reference/nes-defaults.js';
import type { Actor } from './auth.js';
import { assertCan, can, studentGrants } from './access.js';
import * as approvals from './approvals.js';
import * as settings from './settings.js';
import * as notify from './notify.js';
import * as printing from './printing.js';
import * as library from './library.js';
import * as transfers from './transfers.js';
import { localToday } from '../lib/dates.js';

/**
 * Certificates: transfer (TC), bonafide, character, study, fee paid (for income tax) and
 * Children Education Allowance (CEA). Parents can request one in the app; the office prepares it
 * from the records (every field can be checked and corrected), it goes through the school's
 * approval chain, and on approval it gets the next serial number in the register and a
 * verification code. Anyone can check a certificate by scanning its QR code. Issued certificates
 * are never edited: a mistake is cancelled and a new one issued. A transfer certificate needs
 * all fees paid and library books returned, and ends the child's enrolment on the leaving date.
 */

export const KINDS = {
  TC: { title: 'Transfer Certificate', prefix: 'TC', parentMay: true },
  BONAFIDE: { title: 'Bonafide Certificate', prefix: 'BC', parentMay: true },
  CHARACTER: { title: 'Character Certificate', prefix: 'CC', parentMay: true },
  STUDY: { title: 'Study Certificate', prefix: 'SC', parentMay: true },
  FEE_PAID: { title: 'Fee Paid Certificate', prefix: 'FC', parentMay: true },
  CEA: { title: 'Consolidated Certificate from Head of School for Claiming Children Educational Allowance', prefix: 'CEA', parentMay: true },
} as const;
export type Kind = keyof typeof KINDS;

const today = () => localToday();
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const money = (p: number) => `Rs. ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CLASS_WORDS: Record<string, string> = { BV1: 'Bal Vatika One', BV2: 'Bal Vatika Two', BV3: 'Bal Vatika Three', I: 'One', II: 'Two', III: 'Three', IV: 'Four', V: 'Five', VI: 'Six',
  VII: 'Seven', VIII: 'Eight', IX: 'Nine', X: 'Ten', XI: 'Eleven', XII: 'Twelve' };
const NEXT_CLASS: Record<string, string> = { BV1: 'BV2', BV2: 'BV3', BV3: 'I', I: 'II', II: 'III', III: 'IV', IV: 'V', V: 'VI', VI: 'VII', VII: 'VIII', VIII: 'IX', IX: 'X', X: 'XI', XI: 'XII' };

/** The fields printed on a TC, in the CBSE order. */
export const TC_FIELDS: [string, string][] = [
  ['name', 'Name of pupil'], ['mother', "Mother's name"], ['father', "Father's / Guardian's name"], ['nationality', 'Nationality'],
  ['category', 'Whether the pupil belongs to SC / ST / OBC'], ['firstAdmission', 'Date of first admission in the school, with class'],
  ['dob', 'Date of birth according to the admission register (in figures)'], ['dobWords', 'Date of birth (in words)'],
  ['lastClass', 'Class in which the pupil last studied (in figures and words)'], ['lastExam', 'School / Board annual examination last taken, with result'],
  ['failed', 'Whether failed; if so, once or twice in the same class'], ['subjects', 'Subjects studied'],
  ['promotion', 'Whether qualified for promotion to the higher class; if so, to which class'], ['duesPaidUpTo', 'Month up to which school dues are paid'],
  ['concession', 'Any fee concession availed; if so, its nature'], ['workingDays', 'Total number of working days'], ['daysPresent', 'Total number of working days present'],
  ['ncc', 'Whether NCC cadet / Scout / Guide (give details)'], ['games', 'Games played or extracurricular activities'], ['conduct', 'General conduct'],
  ['applicationDate', 'Date of application for the certificate'], ['issueDate', 'Date of issue of the certificate'], ['reason', 'Reason for leaving the school'],
  ['remarks', 'Any other remarks'],
];

interface Facts { studentId: string; enrolmentId: string; schoolId: string; sectionId: string | null; name: string; gender: string; dob: string; nesId: string; admissionNo: string; classCode: string; section: string | null; year: string; from: string; to: string | null; status: string }

async function facts(db: Db, enrolmentId: string): Promise<Facts> {
  const e = await db.maybeOne<Facts>(
    `select s.id as "studentId", e.id as "enrolmentId", e.school_id as "schoolId", e.section_id as "sectionId", s.name, s.gender, s.dob::text as dob, s.nes_id as "nesId",
            e.admission_no as "admissionNo", e.class_code as "classCode", sec.name as section, e.academic_year as year, lower(e.period)::text as from,
            (upper(e.period) - 1)::text as to, e.status
       from enrolment e join student s on s.id = e.student_id left join section sec on sec.id = e.section_id where e.id = $1`, [enrolmentId]);
  if (!e) throw notFound('Enrolment');
  return e;
}

/** Every field the certificate prints, worked out from the records. The office checks and corrects them. */
async function build(db: Db, kind: Kind, f: Facts, extra: { purpose?: string; leavingDate?: string; reason?: string; fy?: string; applicationDate?: string; year?: string }) {
  const guardians = await db.query<{ name: string; relationship: string }>(
    `select g.name, sg.relationship from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = $1 order by sg.is_primary desc`, [f.studentId]);
  const father = guardians.find((g) => g.relationship === 'FATHER')?.name ?? '';
  const mother = guardians.find((g) => g.relationship === 'MOTHER')?.name ?? '';
  const guardian = father || mother || guardians[0]?.name || '';
  const first = await db.one<{ from: string; class_code: string }>(
    `select lower(period)::text as from, class_code from enrolment where student_id = $1 and school_id = $2 order by lower(period) limit 1`, [f.studentId, f.schoolId]);
  const cls = `${f.classCode}${f.section ? `-${f.section}` : ''}`;
  const relation = f.gender === 'F' ? 'daughter' : f.gender === 'M' ? 'son' : 'ward';
  const parentLine = father && mother ? `${father} and ${mother}` : guardian;
  const base: Record<string, string> = {
    name: f.name, father: father || guardian, mother, relation, parentLine, admissionNo: f.admissionNo, nesId: f.nesId, className: cls,
    classWords: CLASS_WORDS[f.classCode] ?? f.classCode, year: f.year, dob: fmtDate(f.dob), dobWords: dateInWords(f.dob), admittedOn: fmtDate(first.from),
    firstClass: first.class_code, purpose: extra.purpose ?? '',
  };
  if (kind === 'TC') {
    const att = await db.one<{ working: number; present: number }>(
      `select count(distinct a.id)::int as working, count(*) filter (where m.status = 'P')::int as present
         from attendance_session a left join attendance_mark m on m.session_id = a.id and m.enrolment_id = $1
        where a.section_id = $2 and a.on_date >= $3::date`, [f.enrolmentId, f.sectionId, f.from]);
    const res = await db.maybeOne<{ name: string; percentage: number; grade: string }>(
      `select a.name, r.percentage::float, r.grade from result r join assessment a on a.id = r.assessment_id where r.enrolment_id = $1 and a.status = 'PUBLISHED' order by a.published_at desc limit 1`, [f.enrolmentId]);
    const subj = await db.query<{ code: string; name: string }>('select code, name from subject where code = any($1)', [SUBJECTS_BY_CLASS[f.classCode] ?? []]);
    // The last month covered by an instalment that is fully paid: "September 2026".
    const paidTo = await db.maybeOne<{ label: string }>(
      `select to_char(upper(i.period) - 1, 'FMMonth YYYY') as label from fee_due d join fee_plan p on p.school_id = $2 and p.academic_year = $3
         join fee_installment i on i.plan_id = p.id and i.code = d.installment_code
        where d.enrolment_id = $1 and d.bill = d.installment_code group by i.period having sum(d.owed_paise - d.paid_paise) <= 0 order by upper(i.period) desc limit 1`, [f.enrolmentId, f.schoolId, f.year]);
    const concession = await db.maybeOne<{ n: number }>(`select count(*)::int as n from fee_demand where enrolment_id = $1 and concession_paise > 0`, [f.enrolmentId]);
    const next = NEXT_CLASS[f.classCode];
    return {
      ...base, nationality: 'Indian', category: '', firstAdmission: `${fmtDate(first.from)}, Class ${first.class_code}`,
      lastClass: `${f.classCode} (${CLASS_WORDS[f.classCode] ?? f.classCode})`,
      lastExam: res ? `${res.name}: ${res.percentage}%, grade ${res.grade}` : 'Not yet taken this year', failed: 'No',
      subjects: subj.map((s) => s.name).join(', '), promotion: next ? `Yes, to Class ${next}` : 'Not applicable',
      duesPaidUpTo: paidTo?.label ?? 'See accounts', concession: concession?.n ? 'Yes, under the NES concession rules' : 'No',
      workingDays: String(att.working), daysPresent: String(att.present), ncc: 'No', games: '', conduct: 'Good',
      applicationDate: fmtDate(extra.applicationDate ?? today()), issueDate: '', reason: extra.reason ?? 'Parent transferred',
      // Going to another Navy school: the request that school accepted (or is still deciding).
      ...(await destination(db, f.studentId)),
      leavingDate: extra.leavingDate ?? today(),
    };
  }
  if (kind === 'FEE_PAID') {
    const fy = extra.fy ?? (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; })();
    const y0 = Number(fy.slice(0, 4));
    const paid = await db.query<{ head_code: string; name: string; amount: number }>(
      `select f.head_code, h.name, sum(a.amount_paise)::int as amount from payment_allocation a join payment p on p.id = a.payment_id join fee_demand f on f.id = a.demand_id
         join fee_head h on h.code = f.head_code
        where p.student_id = $1 and p.school_id = $2 and p.captured_at >= $3::date and p.captured_at < $4::date group by 1, 2 order by 1`,
      [f.studentId, f.schoolId, `${y0}-04-01`, `${y0 + 1}-04-01`]);
    const tuition = paid.filter((p) => p.head_code === 'TUITION').reduce((s, p) => s + p.amount, 0);
    const total = paid.reduce((s, p) => s + p.amount, 0);
    return { ...base, fy, tuition: money(tuition), tuitionWords: rupeesInWords(tuition), other: money(total - tuition), total: money(total), totalWords: rupeesInWords(total),
      breakdown: paid.map((p) => `${p.name}: ${money(p.amount)}`).join('; ') || 'No payments recorded in this year' };
  }
  if (kind === 'CEA') {
    // The consolidated CEA certificate covers one academic year and every NES school the child
    // attended in it (a mid-year transfer on posting gives two rows).
    const yearCode = extra.year ?? f.year;
    const yr = await db.maybeOne<{ from: string; to: string }>(`select lower(period)::text as from, (upper(period) - 1)::text as to from academic_year where code = $1`, [yearCode]);
    if (!yr) throw invalid(`Unknown academic year ${yearCode}.`);
    const spells = await db.query<{ from: string; to: string | null; school: string; affiliation_no: string | null; board: string; cls: string; admission_no: string; roll: number | null }>(
      `select greatest(lower(e.period), $2::date)::text as from, least(coalesce(upper(e.period) - 1, $3::date), $3::date)::text as to, o.name as school, o.affiliation_no, o.board,
              e.class_code || coalesce(' ' || sec.name, '') as cls, e.admission_no,
              coalesce(e.roll_no, (select count(*) + 1 from enrolment x join student xs on xs.id = x.student_id
                                    where x.section_id = e.section_id and x.academic_year = e.academic_year and xs.name < s.name)::int) as roll
         from enrolment e join org_unit o on o.id = e.school_id join student s on s.id = e.student_id left join section sec on sec.id = e.section_id
        where e.student_id = $1 and e.period && daterange($2::date, ($3::date + 1)) order by lower(e.period)`, [f.studentId, yr.from, yr.to]);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    const out: Record<string, string> = {
      ...base, yearCode, yearFrom: fmtDate(yr.from), yearTo: fmtDate(yr.to), prefix: f.gender === 'F' ? 'Kumari' : f.gender === 'M' ? 'Master' : '',
      relationWord: f.gender === 'F' ? 'Daughter' : f.gender === 'M' ? 'Son' : 'Ward', father: father || guardian, className: spells.length ? spells[spells.length - 1].cls : cls,
      place: (await db.maybeOne<{ city: string | null }>('select city from org_unit where id = $1', [f.schoolId]))?.city ?? '',
    };
    spells.slice(-3).forEach((sp, i) => {
      const k = `s${i + 1}`;
      Object.assign(out, { [`${k}From`]: month(sp.from), [`${k}To`]: month(sp.to ?? yr.to), [`${k}School`]: sp.school, [`${k}Affiliation`]: sp.affiliation_no ?? '',
        [`${k}Class`]: sp.cls, [`${k}Roll`]: sp.roll ? String(sp.roll) : '', [`${k}Admission`]: sp.admission_no, [`${k}Board`]: sp.board });
    });
    return out;
  }
  if (kind === 'CHARACTER' || kind === 'STUDY') {
    return { ...base, from: fmtDate(first.from), to: f.to ? fmtDate(f.to) : 'date', studying: f.status === 'ACTIVE' || f.status === 'PROVISIONAL' ? 'yes' : 'no', conduct: 'good' };
  }
  return base;
}

/** Where the child is going, for a TC: the school asked in the open transfer request, or outside NES. */
async function destination(db: Db, studentId: string) {
  const r = await transfers.openRequest(db, studentId);
  if (!r) return { transferRequestId: '', destination: '', remarks: '' };
  return { transferRequestId: r.id, destination: r.to_name, remarks: `Transferred to ${r.to_name} (Navy Education Society)` };
}

/** The certificate's wording (all kinds but the TC, which prints as a numbered list). */
function body(kind: Kind, d: Record<string, string>, _school: { name: string; affiliation_no: string | null }) {
  // **…** prints in bold: the child's name and class stand out on every certificate.
  const pron = d.relation === 'daughter' ? 'she' : d.relation === 'son' ? 'he' : 'the student';
  const studying = d.studying !== 'no';
  const name = `**${d.name}**`;
  switch (kind) {
    case 'BONAFIDE':
      return [`This is to certify that ${name}, ${d.relation} of ${d.parentLine}, is a bonafide student of this school, studying in **Class ${d.className}** in the academic year ${d.year}. Admission number: ${d.admissionNo}.`,
        `Date of birth as recorded in the school register: ${d.dob} (${d.dobWords}).`,
        `This certificate is issued on request${d.purpose ? ` for the purpose of ${d.purpose}` : ''}.`];
    case 'CHARACTER':
      return [`This is to certify that ${name}, ${d.relation} of ${d.parentLine}, ${studying ? 'is' : 'was'} a student of this school from ${d.from}${studying ? '' : ` to ${d.to}`}${d.className ? `, ${studying ? 'now in' : 'last in'} **Class ${d.className}**` : ''}. Admission number: ${d.admissionNo}.`,
        `To the best of my knowledge, ${pron} bears a ${d.conduct} moral character and has taken part in school life with discipline.`,
        `This certificate is issued on request${d.purpose ? ` for the purpose of ${d.purpose}` : ''}.`];
    case 'STUDY':
      return [`This is to certify that ${name}, ${d.relation} of ${d.parentLine}, ${studying ? 'has been studying' : 'studied'} in this school from ${d.from}${studying ? ' to date' : ` to ${d.to}`}, joining in **Class ${d.firstClass}**, and ${studying ? 'is now in' : 'last studied in'} **Class ${d.className}**.`,
        `Admission number: ${d.admissionNo}. Date of birth as recorded in the school register: ${d.dob}.`,
        `This certificate is issued on request${d.purpose ? ` for the purpose of ${d.purpose}` : ''}.`];
    case 'FEE_PAID':
      return [`This is to certify that ${name}, ${d.relation} of ${d.parentLine}, studying in **Class ${d.className}** (admission number ${d.admissionNo}), has paid the following fees to this school during the financial year ${d.fy}:`,
        `Tuition fee: ${d.tuition} (${d.tuitionWords}).`, `Other fees: ${d.other}. Total paid: ${d.total} (${d.totalWords}).`, `Details: ${d.breakdown}.`,
        'The tuition fee is shown separately for claiming the deduction allowed for tuition fees under the Income-tax Act.'];
    default:
      return [];
  }
}

// ── Requests and preparation ─────────────────────────────────────────────────────────────

const office = (db: Db, actor: Actor, schoolId: string) => assertCan(db, actor, 'certificates.prepare', schoolId);

async function currentOrLast(db: Db, studentId: string) {
  const e = await db.maybeOne<{ id: string; school_id: string }>(`select id, school_id from enrolment where student_id = $1 order by upper_inf(period) desc, lower(period) desc limit 1`, [studentId]);
  if (!e) throw notFound('Enrolment');
  return e;
}

/** A parent asks for a certificate in the app. The office is told. */
export async function request(db: Db, actor: Actor, input: { studentId: string; kind: Kind; purpose: string; leavingDate?: string; reason?: string; destinationSchoolId?: string | null }) {
  if (actor.role !== 'PARENT') throw forbidden();
  const g = await studentGrants(db, actor, input.studentId);
  if (!g.has('documents')) throw forbidden();
  if (!KINDS[input.kind]?.parentMay) throw invalid('Choose a certificate.');
  if (input.purpose.trim().length < 3) throw invalid('Say what the certificate is for, for example "passport" or "admission at the new school".');
  const e = await currentOrLast(db, input.studentId);
  const open = await db.maybeOne(`select 1 from certificate where student_id = $1 and kind = $2 and status in ('REQUESTED', 'DRAFT', 'PENDING')`, [input.studentId, input.kind]);
  if (open) throw conflict('open', 'This certificate has already been requested and is being prepared.');
  // Moving to another Navy school: that school is asked for admission at the same time.
  if (input.kind === 'TC' && input.destinationSchoolId) {
    if (!input.leavingDate) throw invalid('Give the last day at this school.');
    await transfers.requestTransfer(db, actor, { studentId: input.studentId, toSchoolId: input.destinationSchoolId, joiningOn: plusDays(input.leavingDate, 1), reason: input.reason || input.purpose });
  }
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into certificate (school_id, kind, student_id, enrolment_id, purpose, data, status, requested_by) values ($1, $2, $3, $4, $5, $6, 'REQUESTED', $7) returning id`,
      [e.school_id, input.kind, input.studentId, e.id, input.purpose.trim(), JSON.stringify({ leavingDate: input.leavingDate ?? null, reason: input.reason ?? null }), actor.id]);
    const staff = await t.query<{ id: string }>(
      `select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path
        union select user_id from duty where school_id = $1 and code = 'ADMISSION_INCHARGE' and valid @> current_date`, [e.school_id]);
    const name = (await t.one<{ name: string }>('select name from student where id = $1', [input.studentId])).name;
    await notify.toUsers(t, staff.map((s) => s.id), { kind: 'CERTIFICATE', title: `${KINDS[input.kind].title} requested`, body: `${name}: ${input.purpose.trim()}`.slice(0, 200), link: '/certificates' });
    return { id: r.id, status: 'REQUESTED' };
  }, { actor: actor.label });
}

/** The office prepares a certificate (from a parent's request, or on its own), filled from the records. */
export async function prepare(db: Db, actor: Actor, input: { requestId?: string; studentId?: string; kind?: Kind; purpose?: string; leavingDate?: string; reason?: string; fy?: string; year?: string }) {
  if (input.requestId) {
    const r = await db.maybeOne<{ school_id: string; kind: Kind; enrolment_id: string; purpose: string; data: { leavingDate?: string; reason?: string }; status: string; created_at: string }>(
      'select school_id, kind, enrolment_id, purpose, data, status, created_at::date::text as created_at from certificate where id = $1', [input.requestId]);
    if (!r) throw notFound('Request');
    await office(db, actor, r.school_id);
    if (r.status !== 'REQUESTED') throw conflict('not_requested', 'This request is already being prepared.');
    const f = await facts(db, r.enrolment_id);
    const data = await build(db, r.kind, f, { purpose: r.purpose, leavingDate: r.data.leavingDate ?? undefined, reason: r.data.reason ?? undefined, applicationDate: r.created_at, fy: input.fy });
    await db.tx((t) => t.query(`update certificate set status = 'DRAFT', data = $2, prepared_by = $3 where id = $1`, [input.requestId, JSON.stringify(data), actor.id]), { actor: actor.label });
    return { id: input.requestId, data };
  }
  if (!input.studentId || !input.kind || !KINDS[input.kind]) throw invalid('Choose the student and the certificate.');
  const e = await currentOrLast(db, input.studentId);
  await office(db, actor, e.school_id);
  const f = await facts(db, e.id);
  if (input.kind === 'TC' && !['ACTIVE', 'PROVISIONAL'].includes(f.status)) throw conflict('left', 'This child has already left the school.');
  const data = await build(db, input.kind, f, { purpose: input.purpose, leavingDate: input.leavingDate, reason: input.reason, fy: input.fy, year: input.year });
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into certificate (school_id, kind, student_id, enrolment_id, purpose, data, status, requested_by, prepared_by) values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $7) returning id`,
    [e.school_id, input.kind, input.studentId, e.id, input.purpose ?? '', JSON.stringify(data), actor.id]), { actor: actor.label });
  return { id: r.id, data };
}

/** Corrections before submitting: any printed field can be changed while the certificate is a draft. */
export async function update(db: Db, actor: Actor, id: string, input: { data: Record<string, string>; purpose?: string }) {
  const c = await load(db, id);
  await office(db, actor, c.school_id);
  if (c.status !== 'DRAFT') throw conflict('not_draft', 'Only a draft can be changed.');
  const data = { ...c.data };
  for (const [k, v] of Object.entries(input.data)) { if (typeof v === 'string' && v.length <= 400) data[k] = v.trim(); }
  if (c.kind === 'TC' && data.leavingDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.leavingDate)) throw invalid('Give the leaving date as a date.');
  await db.tx((t) => t.query(`update certificate set data = $2, purpose = coalesce($3, purpose) where id = $1`, [id, JSON.stringify(data), input.purpose ?? null]), { actor: actor.label });
  return { ok: true };
}

export async function reject(db: Db, actor: Actor, id: string, reason: string) {
  const c = await load(db, id);
  await office(db, actor, c.school_id);
  if (!['REQUESTED', 'DRAFT'].includes(c.status)) throw conflict('state', 'Only a request or draft can be turned down here.');
  if (reason.trim().length < 5) throw invalid('Give the reason; the parent will see it.');
  await db.tx(async (t) => {
    await t.query(`update certificate set status = 'REJECTED', cancel_reason = null, data = data || jsonb_build_object('rejected', $2::text) where id = $1`, [id, reason.trim()]);
    await notify.toParentsOf(t, [c.student_id], { kind: 'CERTIFICATE', title: `${KINDS[c.kind].title}: not issued`, body: reason.trim(), link: '/certificates' });
  }, { actor: actor.label });
  return { status: 'REJECTED' };
}

// ── Approval and issue ───────────────────────────────────────────────────────────────────

interface Cert { id: string; school_id: string; kind: Kind; student_id: string; enrolment_id: string; data: Record<string, string>; status: string; purpose: string; serial_no: string | null; verify_code: string | null; issued_on: string | null; copies_printed: number; requested_by: string }

async function load(db: Db, id: string): Promise<Cert> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Certificate');
  const c = await db.maybeOne<Cert>('select id, school_id, kind, student_id, enrolment_id, data, status, purpose, serial_no, verify_code, issued_on::text, copies_printed, requested_by from certificate where id = $1', [id]);
  if (!c) throw notFound('Certificate');
  return c;
}

/** A TC waits for every fee to be paid and every library book to be returned, if the school says so. */
async function tcChecks(db: Db, c: Cert) {
  if (c.kind !== 'TC') return;
  // Going to another Navy school: only once that school has given a seat.
  const req = await transfers.openRequest(db, c.student_id);
  if (req && req.status !== 'ACCEPTED') {
    throw conflict('not_accepted', `${req.to_name} has not accepted the child yet (${req.status === 'WAITLISTED' ? 'on its waiting list' : 'waiting for its decision'}). The TC can be issued once it does, or after the request is withdrawn.`);
  }
  if (!(await settings.get<boolean>(db, c.school_id, 'certificates.tc_needs_no_dues'))) return;
  // Quarters and charges after the leaving date are not owed: issuing the TC reverses them.
  const after = plusDays(c.data.leavingDate || today(), 1);
  const due = await db.one<{ due: number }>(
    `select coalesce(sum(d.owed_paise - d.paid_paise), 0)::int as due from fee_due d join enrolment e on e.id = d.enrolment_id
       left join fee_plan p on p.school_id = e.school_id and p.academic_year = e.academic_year
       left join fee_installment i on i.plan_id = p.id and i.code = d.installment_code and d.bill = d.installment_code
       left join fee_charge ch on ch.id = d.charge_id
      where d.enrolment_id = $1 and d.owed_paise > d.paid_paise and (i.code is null or lower(i.period) < $2::date) and (ch.id is null or ch.due_on < $2::date)`, [c.enrolment_id, after]);
  const books = await library.openForEnrolment(db, c.enrolment_id);
  const problems = [
    due.due > 0 ? `${money(due.due)} of fees is still due` : '',
    books.length ? `${books.length === 1 ? 'a library book is' : `${books.length} library books are`} not returned (${books.map((b) => `"${b.title}"`).join(', ')})` : '',
  ].filter(Boolean);
  if (problems.length) throw conflict('dues', `The transfer certificate cannot be issued yet: ${problems.join('; ')}.`);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

async function issue(t: Db, c: Cert, actor: Actor) {
  await tcChecks(t, c);
  const year = (await t.one<{ code: string }>(`select academic_year as code from enrolment where id = $1`, [c.enrolment_id])).code;
  const n = await t.one<{ last_no: number }>(
    `insert into certificate_counter (school_id, kind, year, last_no) values ($1, $2, $3, 1) on conflict (school_id, kind, year) do update set last_no = certificate_counter.last_no + 1 returning last_no`,
    [c.school_id, c.kind, year]);
  const serial = `${KINDS[c.kind].prefix}/${year}/${String(n.last_no).padStart(4, '0')}`;
  const req = c.kind === 'TC' ? await transfers.openRequest(t, c.student_id) : null;
  const data = { ...c.data, issueDate: fmtDate(today()), ...(req ? { transferRequestId: req.id, destination: req.to_name, remarks: c.data.remarks || `Transferred to ${req.to_name} (Navy Education Society)` } : {}) };
  await t.query(`update certificate set status = 'ISSUED', serial_no = $2, verify_code = $3, issued_by = $4, issued_on = current_date, data = $5 where id = $1`,
    [c.id, serial, newCode(), actor.id, JSON.stringify(data)]);
  if (c.kind === 'TC') {
    const leaving = c.data.leavingDate || today();
    const e = await t.one<{ from: string; open: boolean }>(`select lower(period)::text as from, upper_inf(period) as open from enrolment where id = $1`, [c.enrolment_id]);
    const last = leaving < e.from ? e.from : leaving;
    if (req && e.open) {
      // To another Navy school that accepted the child: the move happens the next day, into the promised seat.
      await transfers.completeRequest(t, actor, { requestId: req.id, certificateId: c.id, date: plusDays(last, 1), reason: c.data.reason || `Transfer to ${req.to_name}`, serial });
    } else {
      // Leaving NES: the enrolment ends on the leaving date (its last day). Later quarters and
      // charges are reversed; money paid for them clears other dues, and the rest is refunded.
      const e2 = await t.one<{ school_id: string; academic_year: string }>('select school_id, academic_year from enrolment where id = $1', [c.enrolment_id]);
      await t.query(`update enrolment set status = 'WITHDRAWN', period = daterange(lower(period), $2::date) where id = $1 and upper_inf(period)`, [c.enrolment_id, plusDays(last, 1)]);
      await transfers.closeAtSchool(t, actor, { id: c.enrolment_id, ...e2 }, c.student_id, plusDays(last, 1), 'Left the school');
    }
  }
  await notify.toParentsOf(t, [c.student_id], { kind: 'CERTIFICATE', title: `${KINDS[c.kind].title} issued`, body: `Serial ${serial}. You can download it in the app or collect the signed copy from the office.`, link: '/certificates' });
  return serial;
}

const handler = {
  link: '/certificates',
  async context(db: Db, refId: string) {
    const r = await db.one<{ school_id: string; section_id: string | null }>('select c.school_id, e.section_id from certificate c join enrolment e on e.id = c.enrolment_id where c.id = $1', [refId]);
    return { schoolId: r.school_id, sectionId: r.section_id };
  },
  async beforeApprove(db: Db, refId: string) { await tcChecks(db, await load(db, refId)); },
  async onApproved(t: Db, refId: string, actor: Actor) { await issue(t, await load(t, refId), actor); },
  async onRejected(t: Db, refId: string, _actor: Actor, note: string) {
    await t.query(`update certificate set status = 'DRAFT', data = data || jsonb_build_object('returned', $2::text) where id = $1`, [refId, note || 'Returned for correction']);
  },
};
approvals.register('certificate', handler);
approvals.register('certificate_tc', handler);

/**
 * Sends a draft for approval. When the principal submits it themselves, their submission is the
 * approval and it is issued at once (the TC checks still apply).
 */
export async function submit(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  await office(db, actor, c.school_id);
  if (c.status !== 'DRAFT') throw conflict('not_draft', 'Only a draft can be sent for approval.');
  await tcChecks(db, c);
  return db.tx(async (t) => {
    await t.query(`update certificate set status = 'PENDING' where id = $1`, [id]);
    if (actor.role === 'SCHOOL_ADMIN') {
      const serial = await issue(t, { ...c, status: 'PENDING' }, actor);
      return { status: 'ISSUED', serial };
    }
    const name = (await t.one<{ name: string }>('select name from student where id = $1', [c.student_id])).name;
    const flow = await approvals.start(t, { kind: c.kind === 'TC' ? 'certificate_tc' : 'certificate', schoolId: c.school_id, refId: id,
      title: `${KINDS[c.kind].title}: ${name}`, summary: c.purpose || c.data.reason || '', facts: {}, requestedBy: actor.id });
    return { status: 'PENDING', steps: flow.steps.map((s) => s.label) };
  }, { actor: actor.label });
}

export async function cancel(db: Db, actor: Actor, id: string, reason: string) {
  const c = await load(db, id);
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Only the principal can cancel an issued certificate.');
  await office(db, actor, c.school_id);
  if (c.status !== 'ISSUED') throw conflict('not_issued', 'Only an issued certificate can be cancelled.');
  if (reason.trim().length < 5) throw invalid('Give the reason; anyone checking the certificate will see that it is cancelled.');
  await db.tx((t) => t.query(`update certificate set status = 'CANCELLED', cancel_reason = $2 where id = $1`, [id, reason.trim()]), { actor: actor.label });
  return { status: 'CANCELLED', note: c.kind === 'TC' ? 'The enrolment stays ended. To bring the child back, admit them again.' : undefined };
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────

const LIST = `select c.id, c.kind, c.status, c.serial_no, c.verify_code, c.purpose, c.issued_on::text, c.copies_printed, c.created_at, c.cancel_reason, c.data,
                     s.name as student, e.admission_no, e.class_code || coalesce('-' || sec.name, '') as class, u.name as requested_by, u.role = 'PARENT' as by_parent
                from certificate c join student s on s.id = c.student_id join enrolment e on e.id = c.enrolment_id left join section sec on sec.id = e.section_id
                join app_user u on u.id = c.requested_by`;

/** Narrowing the register: kind, academic year, class or section, and the issue date range (a week, a month, any dates). */
export interface Filter { kind?: Kind; year?: string; classCode?: string; sectionId?: string; from?: string; to?: string; includeCancelled?: boolean }

const FILTER = `($2::text is null or c.kind = $2) and ($3::text is null or e.academic_year = $3) and ($4::text is null or e.class_code = $4)
  and ($5::uuid is null or e.section_id = $5) and ($6::date is null or c.issued_on >= $6) and ($7::date is null or c.issued_on <= $7)`;
const filterArgs = (f: Filter) => [f.kind ?? null, f.year ?? null, f.classCode ?? null, f.sectionId ?? null, f.from ?? null, f.to ?? null];

export async function list(db: Db, actor: Actor, schoolId: string, status?: string, f: Filter = {}) {
  await office(db, actor, schoolId);
  const limit = Object.values(f).some(Boolean) ? 2000 : 300;
  return db.query(`${LIST} where c.school_id = $1 and ${FILTER} and ($8::text is null or c.status = $8)
    order by (c.status in ('REQUESTED', 'DRAFT', 'PENDING')) desc, c.issued_on desc nulls first, c.created_at desc limit ${limit}`, [schoolId, ...filterArgs(f), status ?? null]);
}

const ARCHIVE_MAX = 1500;

/**
 * Issued certificates in one download: every TC (or any kind) for a class, an academic year, a
 * month, a week or all time. A PDF begins with a register of what is inside, then one page per
 * certificate marked "Office copy" (it does not count as a printed copy); a spreadsheet is the
 * register alone.
 */
export async function archive(db: Db, actor: Actor, schoolId: string, f: Filter, format: 'PDF' | 'CSV' | 'COUNT', publicUrl: string) {
  await office(db, actor, schoolId);
  const rows = await db.query<{ id: string; kind: Kind; serial_no: string; issued_on: string; status: string; student: string; class: string; admission_no: string; year: string; cancel_reason: string | null }>(
    `select c.id, c.kind, c.serial_no, c.issued_on::text, c.status, s.name as student, e.class_code || coalesce('-' || sec.name, '') as class, e.admission_no, e.academic_year as year, c.cancel_reason
       from certificate c join student s on s.id = c.student_id join enrolment e on e.id = c.enrolment_id left join section sec on sec.id = e.section_id
       join class_level cl on cl.code = e.class_code
      where c.school_id = $1 and ${FILTER} and (c.status = 'ISSUED' or ($8 and c.status = 'CANCELLED'))
      order by c.kind, c.issued_on, c.serial_no`, [schoolId, ...filterArgs(f), !!f.includeCancelled]);
  if (format === 'COUNT') return { count: rows.length, max: ARCHIVE_MAX };
  if (!rows.length) throw invalid('No issued certificates match. Widen the dates or the class.');
  if (format === 'CSV') {
    const cell = (v: unknown) => { const t = v == null ? '' : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t; };
    const head = ['Serial no', 'Certificate', 'Issued on', 'Student', 'Class', 'Admission no', 'Academic year', 'Status', 'Cancelled because'];
    return { csv: [head, ...rows.map((r) => [r.serial_no, KINDS[r.kind].title, r.issued_on, r.student, r.class, r.admission_no, r.year, r.status === 'ISSUED' ? 'Issued' : 'Cancelled', r.cancel_reason ?? ''])]
      .map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n', count: rows.length };
  }
  if (rows.length > ARCHIVE_MAX) throw invalid(`${rows.length} certificates match; download at most ${ARCHIVE_MAX} at a time (choose a year, a class or dates).`);
  const doc = await newDocument('Certificates');
  const x = await context(db, schoolId, doc, null, true, publicUrl);
  // The register: what is in this file, in order.
  const what = [f.kind ? KINDS[f.kind].title : 'All certificates', f.year ? `academic year ${f.year}` : '', f.classCode ? `Class ${f.classCode}` : '',
    f.from || f.to ? `issued ${f.from ? fmtDate(f.from) : 'from the start'} to ${f.to ? fmtDate(f.to) : 'today'}` : ''].filter(Boolean).join(', ');
  const PER = 34;
  for (let p = 0; p * PER < rows.length; p++) {
    const sh = new Sheet(x.doc, 210, 297, x.fonts, NO_CALIBRATION);
    let y = 16;
    sh.text(x.school.name, 20, y, { size: 13, font: x.fonts.serifBold, colour: NAVY, maxWidth: 170, align: 'centre' }); y += 7;
    sh.text('Register of certificates', 20, y, { size: 11, font: x.fonts.bold, colour: NAVY, maxWidth: 170, align: 'centre' }); y += 5.5;
    sh.text(`${what} · ${rows.length} certificate${rows.length === 1 ? '' : 's'} · downloaded ${fmtDate(today())} by ${actor.name} · page ${p + 1}`, 20, y, { size: 8, font: x.fonts.regular, colour: GREY, maxWidth: 170, align: 'centre' }); y += 8;
    const cols: [string, number, number][] = [['#', 20, 8], ['Serial no', 28, 32], ['Certificate', 60, 32], ['Issued', 92, 19], ['Student', 111, 37], ['Class', 148, 13], ['Adm. no', 161, 29]];
    sh.rect(20, y - 1.5, 170, 6.5, { fill: [0.93, 0.94, 0.97] });
    for (const [h, cx, cw] of cols) sh.text(h, cx + 1, y, { size: 8, font: x.fonts.bold, colour: NAVY, maxWidth: cw - 2 });
    y += 7;
    rows.slice(p * PER, (p + 1) * PER).forEach((r, i) => {
      const n = p * PER + i + 1;
      const vals = [String(n), r.serial_no, KINDS[r.kind].title.replace('Consolidated Certificate from Head of School for Claiming Children Educational Allowance', 'CEA (consolidated)'), fmtDate(r.issued_on), r.student, r.class, r.admission_no];
      vals.forEach((v, k) => sh.text(v, cols[k][1] + 1, y, { size: 8, font: k === 1 ? x.fonts.mono ?? x.fonts.regular : x.fonts.regular, colour: r.status === 'CANCELLED' ? [0.7, 0.1, 0.1] : [0.1, 0.1, 0.12], maxWidth: cols[k][2] - 2 }));
      if (r.status === 'CANCELLED') sh.text('CANCELLED', 20, y + 3.2, { size: 6, font: x.fonts.bold, colour: [0.7, 0.1, 0.1] });
      sh.line(20, y + 4.6, 190, y + 4.6, { colour: [0.86, 0.87, 0.9], width: 0.2 });
      y += 7;
    });
  }
  for (const r of rows) {
    const c = await load(db, r.id);
    draw(x, c, c.status === 'CANCELLED' ? 'CANCELLED' : 'OFFICE COPY');
  }
  await db.tx((t) => printing.log(t, actor, schoolId, 'CERTIFICATE', rows.length, { archive: true, filter: f }, null), { actor: actor.label });
  return { pdf: Buffer.from(await doc.doc.save()), count: rows.length };
}

export async function one(db: Db, actor: Actor, id: string) {
  const c = await load(db, id);
  if (actor.role === 'PARENT') { await studentGrants(db, actor, c.student_id); } else await office(db, actor, c.school_id);
  const row = (await db.query(`${LIST} where c.id = $1`, [id]))[0];
  const progress = await approvals.progress(db, c.kind === 'TC' ? 'certificate_tc' : 'certificate', id);
  return { ...row, title: KINDS[c.kind].title, fields: c.kind === 'TC' ? TC_FIELDS : null, progress };
}

export async function forStudent(db: Db, actor: Actor, studentId: string) {
  const g = await studentGrants(db, actor, studentId);
  if (!g.has('documents')) throw forbidden();
  const rows = await db.query<Record<string, unknown> & { kind: Kind }>(`${LIST} where c.student_id = $1 order by c.created_at desc`, [studentId]);
  return rows.map(({ data, ...r }) => ({ ...r, title: KINDS[r.kind].title, note: (data as Record<string, string>)?.rejected ?? (data as Record<string, string>)?.returned ?? null }));
}

// ── Printing and verification ────────────────────────────────────────────────────────────

type Doc = Awaited<ReturnType<typeof newDocument>>;
interface PrintCtx { doc: Doc['doc']; fonts: Doc['fonts']; school: Awaited<ReturnType<typeof printing.schoolHeader>>; mode: string; topMm: number; cal: Calibration;
  logo: PDFImage | null; nes: PDFImage | null; sign: PDFImage | null; stamp: PDFImage | null; publicUrl: string; authority: string }

async function context(db: Db, schoolId: string, doc: Doc, printerId: string | null | undefined, parent: boolean, publicUrl: string): Promise<PrintCtx> {
  const school = await printing.schoolHeader(db, schoolId);
  const mode = await settings.get<string>(db, schoolId, 'certificates.letterhead');
  const topMm = mode === 'PREPRINTED' ? await settings.get<number>(db, schoolId, 'certificates.letterhead_top_mm') : 0;
  const cal = parent ? NO_CALIBRATION : await printing.calibration(db, schoolId, printerId);
  const raw = await printing.assets(db, schoolId);
  return { ...doc, school, mode, topMm, cal, publicUrl,
    logo: await embedImage(doc.doc, raw.LOGO?.data, raw.LOGO?.type), nes: await embedImage(doc.doc, raw.NES?.data, raw.NES?.type), sign: await embedImage(doc.doc, raw.SIGNATURE?.data, raw.SIGNATURE?.type),
    stamp: await embedImage(doc.doc, raw.STAMP?.data, raw.STAMP?.type), authority: await settings.get<string>(db, schoolId, 'certificates.cea_authority') };
}

const NAVY: [number, number, number] = [0.04, 0.18, 0.35];
const GREY: [number, number, number] = [0.38, 0.4, 0.45];

/** One certificate on one A4 page. */
function draw(x: PrintCtx, c: Cert, marking: string) {
  const { fonts, school } = x;
  const s = new Sheet(x.doc, 210, 297, fonts, x.cal);
  const L = 20, R = 190, W = R - L;
  const draft = c.status !== 'ISSUED';
  let y = 14;
  if (x.mode === 'PREPRINTED') y = x.topMm;
  else {
    // Heading: logo, school name, address, contact, board, affiliation, UDISE and school number.
    // The school's emblem on the left and the Navy Education Society's on the right; the school
    // name and details are centred between them.
    if (x.logo) s.image(x.logo, L, y, 26, 26);
    if (x.nes) s.image(x.nes, R - 26, y, 26, 26);
    const tx = x.logo || x.nes ? L + 30 : L, tw = x.logo || x.nes ? W - 60 : W;
    s.text(school.name, tx, y, { size: 18, font: fonts.serifBold, colour: NAVY, maxWidth: tw, align: 'centre' });
    let hy = y + 8.5;
    const lines = [
      school.address ?? '',
      [school.phone, school.email, school.website].filter(Boolean).join('  ·  '),
      school.board,
      [school.affiliation_no ? `Affiliation No. ${school.affiliation_no}` : '', school.udise ? `UDISE Code ${school.udise}` : '', school.school_no ? `School No. ${school.school_no}` : ''].filter(Boolean).join('  ·  '),
    ].filter(Boolean);
    for (const l of lines) { s.text(l, tx, hy, { size: 9, font: fonts.serif, colour: GREY, maxWidth: tw, align: 'centre' }); hy += 4.4; }
    y = Math.max(y + 28, hy + 1.5);
    s.rect(L, y, W, 0.9, { fill: NAVY }); s.rect(L, y + 1.6, W, 0.25, { fill: NAVY });
    y += 7;
  }
  if (marking) s.text(marking, L, y - 2, { size: 8, font: fonts.bold, colour: [0.72, 0.1, 0.1], maxWidth: W, align: 'right' });

  // Title.
  const title = KINDS[c.kind].title.toUpperCase();
  const titleLines = c.kind === 'CEA' ? ['CONSOLIDATED CERTIFICATE FROM HEAD OF SCHOOL', 'FOR CLAIMING CHILDREN EDUCATIONAL ALLOWANCE'] : [title];
  y += 3;
  for (const t of titleLines) { s.text(t, L, y, { size: c.kind === 'CEA' ? 13 : 15, font: fonts.serifBold, colour: NAVY, maxWidth: W, align: 'centre' }); y += 6.5; }
  y += 3;

  const d = c.data;
  const field = (label: string, value: string, x0: number, yy: number, w: number, labelW: number) => {
    s.text(label, x0, yy, { size: 10.5, font: fonts.serif });
    s.text(value || '—', x0 + labelW, yy, { size: 10.5, font: fonts.serifBold, maxWidth: w - labelW });
    s.line(x0 + labelW, yy + 4.6, x0 + w, yy + 4.6, { width: 0.15, colour: [0.7, 0.72, 0.76] });
  };

  if (c.kind === 'CEA') {
    y += 2;
    s.text('1.', L, y, { size: 10.5, font: fonts.serifBold });
    const I = L + 7, IW = R - I;
    // Labels in one column and values in the next, so every value starts at the same place.
    const V = I + 40, M = I + 90, MV = M + 34;
    const pair = (label: string, value: string, lx: number, vx: number, end: number, yy: number) => {
      s.text(label, lx, yy, { size: 10.5, font: fonts.serif, maxWidth: vx - lx - 2 });
      s.text(value || '—', vx, yy, { size: 10.5, font: fonts.serifBold, maxWidth: end - vx });
      s.line(vx, yy + 4.6, end, yy + 4.6, { width: 0.15, colour: [0.7, 0.72, 0.76] });
    };
    pair('This is to certify that', `${d.prefix ? `${d.prefix} ` : ''}${d.name}`, I, V, R, y); y += 8.5;
    pair(`${d.relationWord ?? 'Son'} of`, d.father, I, V, R, y); y += 8.5;
    pair('Date of birth', d.dob, I, V, M - 4, y);
    pair('was studying in class', d.className, M, MV, R, y); y += 8.5;
    pair('during the academic year', `${d.yearFrom}  to  ${d.yearTo}`, I, V, M - 4, y);
    s.text('in the following school(s):', M, y, { size: 10.5, font: fonts.serif });
    y += 9;
    // One block per NES school attended in the year (1.1, 1.2, 1.3); three blocks are drawn tighter to fit the page.
    const spells = ['s1', 's2', 's3'].filter((k) => d[`${k}School`]);
    const step = spells.length > 2 ? 5.9 : 7, boxH = spells.length > 2 ? 31 : 37;
    const BL = I + 4, BV = BL + 36, BM = M, BMV = MV, BR = R - 4;
    spells.forEach((k, i) => {
      s.rect(I, y - 2, IW, boxH, { stroke: [0.78, 0.8, 0.84], width: 0.25 });
      s.rect(I, y - 2, IW, 7.5, { fill: [0.94, 0.95, 0.97] });
      s.text(`1.${i + 1}`, BL, y, { size: 10.5, font: fonts.serifBold, colour: NAVY });
      s.text(`From ${d[`${k}From`]}  to  ${d[`${k}To`]}`, BL + 10, y, { size: 10.5, font: fonts.serifBold, colour: NAVY });
      let ry = y + 8;
      pair('At school', d[`${k}School`], BL, BV, BR, ry); ry += step;
      pair('Affiliation / Regn code', d[`${k}Affiliation`], BL, BV, BM - 4, ry);
      pair('in Class', d[`${k}Class`], BM, BMV, BR, ry); ry += step;
      pair('Roll No', d[`${k}Roll`], BL, BV, BM - 4, ry);
      pair('Admission / Regn No', d[`${k}Admission`], BM, BMV, BR, ry); ry += step;
      pair('and pattern', `${d[`${k}Board`]} curriculum`, BL, BV, BR, ry);
      y += boxH + 4;
    });
    s.text('2.', L, y, { size: 10.5, font: fonts.serifBold });
    s.text('This certificate has been issued based on the records held in the school.', I, y, { size: 10.5, font: fonts.serif });
    y += 12;
    const fy = Math.max(y, 214);
    ([['Ref. No.', c.serial_no ?? '—'], ['Date', c.issued_on ? fmtDate(c.issued_on) : fmtDate(today())], ['Place', d.place || school.city || '']] as const).forEach(([k, v], n) => {
      s.text(k, L, fy + n * 6, { size: 10, font: fonts.serif });
      s.text(`:  ${v}`, L + 17, fy + n * 6, { size: 10, font: fonts.serif });
    });
    signature(s, x, R, fy - 4, draft, 'Head of the School');
    s.paragraph(x.authority, L, 248, W, { size: 7.5, font: fonts.serif, colour: GREY, lineGap: 1.3 });
  } else {
    s.text(`No. ${c.serial_no ?? '—'}`, L, y, { size: 10, font: fonts.serif });
    s.text(`Date: ${c.issued_on ? fmtDate(c.issued_on) : fmtDate(today())}`, L, y, { size: 10, font: fonts.serif, maxWidth: W, align: 'right' });
    y += 5.5;
    s.text(`Admission No. ${d.admissionNo}`, L, y, { size: 10, font: fonts.serif });
    y += 10;
    if (c.kind === 'TC') {
      const labelW = 90;
      TC_FIELDS.forEach(([k, label], i) => {
        const value = k === 'issueDate' ? (c.issued_on ? fmtDate(c.issued_on) : '') : d[k] ?? '';
        const rowH = Math.max(s.measure(label, labelW - 10, { size: 9.3, font: fonts.serif, lineGap: 1.22 }), s.measure(value || '—', W - labelW - 1.5, { size: 9.3, font: fonts.serifBold, lineGap: 1.22 }));
        if (i % 2 === 0) s.rect(L, y - 1.3, W, rowH + 1.9, { fill: [0.965, 0.97, 0.98] });
        s.text(`${i + 1}.`, L + 1.5, y, { size: 9.3, font: fonts.serif, colour: GREY });
        s.paragraph(label, L + 8.5, y, labelW - 10, { size: 9.3, font: fonts.serif, lineGap: 1.22 });
        s.paragraph(value || '—', L + labelW, y, W - labelW - 1.5, { size: 9.3, font: fonts.serifBold, lineGap: 1.22 });
        y += rowH + 1.9;
      });
      const fy = Math.max(y + 8, 236);
      // Three signatures on one line: office, class teacher, principal.
      for (const [label, x0] of [['Prepared by', L], ['Checked by (Class Teacher)', L + 54]] as const) {
        s.line(x0, fy + 15, x0 + 46, fy + 15, { width: 0.3 });
        s.text(label, x0, fy + 17, { size: 10, font: fonts.serifBold, maxWidth: 46, align: 'centre' });
      }
      signature(s, x, R, fy, draft, 'Principal');
    } else if (c.kind === 'FEE_PAID') {
      const [intro, , , , note] = body(c.kind, d, school);
      y += s.richParagraph(intro, L, y, W, { size: 12, font: fonts.serif, bold: fonts.serifBold, lineGap: 1.65 }) + 5;
      // Fees by head, amounts right-aligned, tuition first (it is what the tax deduction needs).
      const heads = (d.breakdown ?? '').split('; ').map((p) => { const at = p.lastIndexOf(': '); return [p.slice(0, at), p.slice(at + 2)]; }).filter(([h, a]) => h && a);
      heads.sort(([a], [b]) => (b.startsWith('Tuition') ? 1 : 0) - (a.startsWith('Tuition') ? 1 : 0));
      const TX = L + 10, TW = W - 20, AX = TX + TW - 3;
      s.rect(TX, y - 1.5, TW, 7.5, { fill: [0.94, 0.95, 0.97] });
      s.text('Fee head', TX + 3, y, { size: 10.5, font: fonts.serifBold, colour: NAVY });
      s.text('Amount paid', TX, y, { size: 10.5, font: fonts.serifBold, colour: NAVY, maxWidth: TW - 3, align: 'right' });
      y += 8;
      for (const [h, a] of heads) {
        s.text(h, TX + 3, y, { size: 11, font: fonts.serif });
        s.text(a, TX, y, { size: 11, font: fonts.serif, maxWidth: AX - TX, align: 'right' });
        s.line(TX, y + 5, TX + TW, y + 5, { width: 0.15, colour: [0.8, 0.82, 0.86] });
        y += 7;
      }
      s.line(TX, y - 1.6, TX + TW, y - 1.6, { width: 0.4 });
      s.text('Total', TX + 3, y, { size: 11, font: fonts.serifBold });
      s.text(d.total, TX, y, { size: 11, font: fonts.serifBold, maxWidth: AX - TX, align: 'right' });
      y += 7;
      s.text(`(${d.totalWords})`, TX, y, { size: 9.5, font: fonts.serif, colour: GREY, maxWidth: TW - 3, align: 'right' });
      y += 11;
      y += s.richParagraph(`Of this, the tuition fee is **${d.tuition}** (${d.tuitionWords}). ${note}`, L, y, W, { size: 12, font: fonts.serif, bold: fonts.serifBold, lineGap: 1.65 }) + 5;
      signature(s, x, R, Math.max(y + 14, 222), draft, 'Principal');
    } else {
      for (const p of body(c.kind, d, school)) { y += s.richParagraph(p, L, y, W, { size: 12, font: fonts.serif, bold: fonts.serifBold, lineGap: 1.65 }) + 5; }
      signature(s, x, R, Math.max(y + 14, 222), draft, 'Principal');
    }
  }
  if (c.verify_code) {
    const url = `${x.publicUrl.replace(/\/$/, '')}/verify/${c.verify_code}`;
    s.qr(url, R - 22, 266, 22);
    s.text('Scan to check this certificate, or visit', R - 112, 271, { size: 7.5, colour: GREY, maxWidth: 88, align: 'right' });
    s.text(url, R - 112, 275, { size: 7.5, font: fonts.mono, maxWidth: 88, align: 'right' });
    s.text(`Verification code ${c.verify_code}`, R - 112, 279, { size: 7.5, colour: GREY, maxWidth: 88, align: 'right' });
  }
}

const SIGN_W = 62;

function signature(s: Sheet, x: PrintCtx, R: number, fy: number, draft: boolean, label: string) {
  if (!draft && x.stamp) s.image(x.stamp, R - 74, fy - 4, 26, 26);
  if (!draft && x.sign) s.image(x.sign, R - 48, fy, 46, 14);
  // The line, the title and the school name share one centre.
  s.line(R - SIGN_W, fy + 15, R, fy + 15, { width: 0.3 });
  s.text(label, R - SIGN_W, fy + 17, { size: 10, font: x.fonts.serifBold, maxWidth: SIGN_W, align: 'centre' });
  s.text(x.school.name, R - SIGN_W, fy + 21.5, { size: 8, font: x.fonts.serif, maxWidth: SIGN_W, align: 'centre' });
}

/**
 * A certificate as a PDF on A4. Office prints count copies: the first is the original, later
 * prints say "Duplicate". A parent's download is marked as a digital copy. The QR code links to
 * the public verification page.
 */
export async function pdf(db: Db, actor: Actor, id: string, input: { printerId?: string | null; publicUrl: string }) {
  const c = await load(db, id);
  const parent = actor.role === 'PARENT';
  if (parent) { const g = await studentGrants(db, actor, c.student_id); if (!g.has('documents')) throw forbidden(); } else await office(db, actor, c.school_id);
  if (c.status === 'CANCELLED') throw conflict('cancelled', 'This certificate has been cancelled.');
  if (c.status !== 'ISSUED' && parent) throw conflict('not_issued', 'This certificate has not been issued yet.');
  const doc = await newDocument(KINDS[c.kind].title);
  const x = await context(db, c.school_id, doc, input.printerId, parent, input.publicUrl);
  draw(x, c, c.status !== 'ISSUED' ? 'DRAFT - NOT VALID' : parent ? 'DIGITAL COPY' : c.copies_printed > 0 ? 'DUPLICATE COPY' : '');
  if (!parent && c.status === 'ISSUED') {
    await db.tx(async (t) => {
      await t.query(`update certificate set copies_printed = copies_printed + 1 where id = $1`, [id]);
      await printing.log(t, actor, c.school_id, 'CERTIFICATE', 1, { serial: c.serial_no, copy: c.copies_printed + 1 }, input.printerId);
    }, { actor: actor.label });
  }
  return Buffer.from(await doc.doc.save());
}

// ── A whole class at once (CEA and bonafide every year) ──────────────────────────────────

/** Drafts the certificate for every child in the chosen sections who does not already have one for that year. */
export async function prepareBulk(db: Db, actor: Actor, schoolId: string, input: { kind: 'CEA' | 'BONAFIDE'; sectionIds: string[]; year?: string; purpose?: string }) {
  await office(db, actor, schoolId);
  if (!input.sectionIds.length) throw invalid('Choose at least one class section.');
  const kids = await db.query<{ enrolment_id: string; student_id: string; year: string }>(
    `select e.id as enrolment_id, e.student_id, e.academic_year as year from enrolment e join section s on s.id = e.section_id join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and e.section_id = any($2) and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`, [schoolId, input.sectionIds]);
  let made = 0, skipped = 0;
  for (const k of kids) {
    const year = input.year ?? k.year;
    const exists = await db.maybeOne(`select 1 from certificate where student_id = $1 and kind = $2 and status not in ('REJECTED', 'CANCELLED')
      and (kind <> 'CEA' or data->>'yearCode' = $3) and (kind <> 'BONAFIDE' or data->>'year' = $3)`, [k.student_id, input.kind, year]);
    if (exists) { skipped++; continue; }
    const data = await build(db, input.kind, await facts(db, k.enrolment_id), { year, purpose: input.purpose });
    await db.tx((t) => t.query(
      `insert into certificate (school_id, kind, student_id, enrolment_id, purpose, data, status, requested_by, prepared_by) values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $7)`,
      [schoolId, input.kind, k.student_id, k.enrolment_id, input.purpose ?? (input.kind === 'CEA' ? 'Children Education Allowance' : ''), JSON.stringify(data), actor.id]), { actor: actor.label });
    made++;
  }
  return { prepared: made, alreadyHad: skipped };
}

/** The principal issues several checked drafts in one go (their action is the approval). */
export async function issueBulk(db: Db, actor: Actor, schoolId: string, ids: string[]) {
  if (actor.role !== 'SCHOOL_ADMIN' && actor.role !== 'NES_ADMIN') throw forbidden('Only the principal can issue certificates in bulk.');
  await office(db, actor, schoolId);
  const certs = await db.query<{ id: string }>(`select id from certificate where school_id = $1 and id = any($2) and status = 'DRAFT' and kind <> 'TC'`, [schoolId, ids]);
  if (!certs.length) throw invalid('Choose drafts to issue. Transfer certificates are issued one at a time.');
  return db.tx(async (t) => {
    const serials: string[] = [];
    for (const r of certs) {
      await t.query(`update certificate set status = 'PENDING' where id = $1`, [r.id]);
      serials.push(await issue(t, await load(t, r.id), actor));
    }
    return { issued: serials.length, first: serials[0], last: serials[serials.length - 1] };
  }, { actor: actor.label });
}

/** Several certificates in one PDF, one per page, in class and name order. */
export async function pdfBulk(db: Db, actor: Actor, schoolId: string, ids: string[], input: { printerId?: string | null; publicUrl: string }) {
  await office(db, actor, schoolId);
  const rows = await db.query<{ id: string }>(
    `select c.id from certificate c join enrolment e on e.id = c.enrolment_id join student s on s.id = c.student_id join class_level cl on cl.code = e.class_code
       left join section sec on sec.id = e.section_id
      where c.school_id = $1 and c.id = any($2) and c.status in ('DRAFT', 'PENDING', 'ISSUED') order by cl.ordinal, sec.name, s.name`, [schoolId, ids]);
  if (!rows.length) throw invalid('Choose certificates to print.');
  if (rows.length > 500) throw invalid('Print at most 500 certificates at a time.');
  const doc = await newDocument('Certificates');
  const x = await context(db, schoolId, doc, input.printerId, false, input.publicUrl);
  const printed: Cert[] = [];
  for (const r of rows) {
    const c = await load(db, r.id);
    draw(x, c, c.status !== 'ISSUED' ? 'DRAFT - NOT VALID' : c.copies_printed > 0 ? 'DUPLICATE COPY' : '');
    if (c.status === 'ISSUED') printed.push(c);
  }
  if (printed.length) {
    await db.tx(async (t) => {
      await t.query(`update certificate set copies_printed = copies_printed + 1 where id = any($1)`, [printed.map((c) => c.id)]);
      await printing.log(t, actor, schoolId, 'CERTIFICATE', printed.length, { bulk: true }, input.printerId);
    }, { actor: actor.label });
  }
  return { pdf: Buffer.from(await doc.doc.save()), count: rows.length };
}

/** Public check of a certificate from its code: no sign-in, nothing beyond what is printed on it. */
export async function verify(db: Db, code: string) {
  if (!/^[A-Z0-9]{10}$/.test(code.toUpperCase())) throw notFound('Certificate');
  const c = await db.maybeOne<{ kind: Kind; serial_no: string; status: string; issued_on: string; cancel_reason: string | null; name: string; school: string; class: string; admission_no: string }>(
    `select c.kind, c.serial_no, c.status, c.issued_on::text, c.cancel_reason, c.data->>'name' as name, o.name as school, c.data->>'className' as class, c.data->>'admissionNo' as admission_no
       from certificate c join org_unit o on o.id = c.school_id where c.verify_code = $1`, [code.toUpperCase()]);
  if (!c) throw notFound('Certificate');
  return { valid: c.status === 'ISSUED', status: c.status, title: KINDS[c.kind].title, serial: c.serial_no, issuedOn: c.issued_on, student: c.name, className: c.class,
    admissionNo: c.admission_no, school: c.school, cancelReason: c.status === 'CANCELLED' ? c.cancel_reason : null };
}

export const _canPrepare = (db: Db, actor: Actor, schoolId: string) => can(db, actor, 'certificates.prepare', schoolId);
