import type { Db } from '../db/client.js';
import { conflict, invalid, notFound, forbidden } from '../lib/errors.js';
import { evaluate, type Facts, type Rule } from '../lib/rules.js';
import { percentOf } from '../lib/money.js';
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** Fee notices carry the full date: "1 Apr 2026". */
const fullDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
import { categorise, studentFacts } from './categories.js';
import { post, signed } from './ledger.js';
import type { Actor } from './auth.js';
import * as transport from './transport.js';
import { assertUnitInScope, requireRole } from './auth.js';
import * as notify from './notify.js';
import * as refunds from './refunds.js';
import * as settings from './settings.js';
import { localToday } from '../lib/dates.js';

interface Installment { code: string; label: string; due_date: string; start: string; end: string }
interface Rate { head_code: string; periodicity: string; amount_paise: number }
const monthsIn = (start: string, end: string) => (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7));
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const plan = (db: Db, schoolId: string, year: string) =>
  db.maybeOne<{ id: string }>('select id from fee_plan where school_id = $1 and academic_year = $2', [schoolId, year]);

export async function installments(db: Db, planId: string) {
  return db.query<Installment>(
    `select code, label, due_date::text, lower(period)::text as start, upper(period)::text as end from fee_installment where plan_id = $1 order by lower(period)`, [planId]);
}

async function versionOn(db: Db, planId: string, on: string) {
  const v = await db.maybeOne<{ id: string; version: number }>(
    `select id, version from fee_plan_version where plan_id = $1 and status = 'PUBLISHED' and valid @> $2::date`, [planId, on]);
  if (!v) throw invalid(`No published fee version covers ${on}.`);
  return v;
}

async function concessionRules(db: Db, schoolId: string, on: string) {
  return db.query<{ id: string; name: string; condition: Rule; head_code: string; percent: string }>(
    `select id, name, condition, head_code, percent from concession_rule
      where (school_id = $1 or school_id is null) and valid @> $2::date order by priority`, [schoolId, on]);
}

/**
 * Whether this child carries the family's PTA fee on this bill, and how much. The family is every
 * child sharing a parent. It is billed once (a year, or ever, by the school's setting) at this
 * school, to the eldest of the family enrolled here for the bill's period. A bill already carrying
 * it keeps the amount it was billed at.
 */
async function ptaFor(db: Db, e: EnrolmentRef, planId: string, inst: Installment) {
  const amount = (await settings.get<number>(db, e.school_id, 'fees.pta_amount')) * 100;
  const own = await db.maybeOne<{ gross: number }>(`select gross_paise::int as gross from fee_demand where enrolment_id = $1 and installment_code = $2 and head_code = 'PTA' and kind = 'REGULAR'`, [e.id, inst.code]);
  if (own) return own.gross;
  if (!amount) return 0;
  const once = (await settings.get<string>(db, e.school_id, 'fees.pta_frequency')) === 'ONCE';
  const year = (await db.one<{ y: string }>('select academic_year as y from fee_plan where id = $1', [planId])).y;
  const billed = await db.maybeOne(
    `select 1 from fee_demand d join enrolment x on x.id = d.enrolment_id
      where d.head_code = 'PTA' and d.kind = 'REGULAR' and x.school_id = $1 and x.student_id in (select student_id from family_of($2)) and ($3 or x.academic_year = $4) limit 1`,
    [e.school_id, e.student_id, once, year]);
  if (billed) return 0;
  const eldest = await db.maybeOne<{ student_id: string }>(
    `select x.student_id from enrolment x join student s on s.id = x.student_id
      where x.school_id = $1 and x.academic_year = $2 and x.status in ('ACTIVE', 'PROVISIONAL') and x.period && daterange($3::date, $4::date)
        and x.student_id in (select student_id from family_of($5)) order by s.dob, x.admission_no limit 1`, [e.school_id, year, inst.start, inst.end, e.student_id]);
  return eldest?.student_id === e.student_id ? amount : 0;
}

/**
 * The family's PTA fee and the brothers and sisters, for the parent app and the student's record:
 * who carries it this year, and whether it is paid.
 */
export async function family(db: Db, studentId: string) {
  const members = await db.query<{ id: string; name: string; class_code: string | null; section: string | null; school: string | null; school_id: string | null }>(
    `select s.id, s.name, e.class_code, sec.name as section, o.name as school, e.school_id from family_of($1) f join student s on s.id = f.student_id
       left join enrolment e on e.student_id = s.id and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
       left join section sec on sec.id = e.section_id left join org_unit o on o.id = e.school_id order by s.dob`, [studentId]);
  const me = members.find((m) => m.id === studentId);
  if (!me?.school_id) return { members, pta: null };
  const amount = (await settings.get<number>(db, me.school_id, 'fees.pta_amount')) * 100;
  const frequency = await settings.get<string>(db, me.school_id, 'fees.pta_frequency');
  const billed = await db.maybeOne<{ student_id: string; name: string; amount: number; owed: number; paid: number; year: string }>(
    `select x.student_id, s.name, d.gross_paise::int as amount, f.owed_paise::int as owed, f.paid_paise::int as paid, x.academic_year as year
       from fee_demand d join enrolment x on x.id = d.enrolment_id join student s on s.id = x.student_id
       join fee_due f on f.enrolment_id = d.enrolment_id and f.bill = d.bill and f.head_code = 'PTA'
      where d.head_code = 'PTA' and d.kind = 'REGULAR' and x.school_id = $1 and x.student_id in (select student_id from family_of($2))
      order by x.academic_year desc, d.created_at desc limit 1`, [me.school_id, studentId]);
  return { members, pta: { amount, frequency, billedTo: billed ? { studentId: billed.student_id, name: billed.name, amount: billed.amount, paid: billed.paid >= billed.owed, year: billed.year } : null } };
}

/**
 * The price of one instalment for one enrolment: the fee version in force at the start of the
 * instalment, the class band of the enrolment, and the fee band worked out from the guardian's
 * service facts on that date. Pure calculation; nothing is written.
 */
export interface EnrolmentRef { id: string; student_id: string; school_id: string; class_code: string; start: string }

export async function priceInstallment(db: Db, enrolment: EnrolmentRef, planId: string, inst: Installment, versionId?: string) {
  const v = versionId ? { id: versionId } : await versionOn(db, planId, inst.start);
  // Facts are read on the later of the instalment start and the joining date.
  const on = enrolment.start > inst.start ? enrolment.start : inst.start;
  const { facts } = await studentFacts(db, enrolment.student_id, on);
  const band = await categorise(db, enrolment.school_id, 'FEE_BAND', on, facts);
  const cls = await db.one<{ fee_band: string }>('select fee_band from class_level where code = $1', [enrolment.class_code]);
  const rates = await db.query<Rate>(
    `select head_code, periodicity, amount_paise::int from fee_rate where version_id = $1 and class_band = $2 and fee_band = $3`,
    [v.id, cls.fee_band, band.code]);
  const rules = await concessionRules(db, enrolment.school_id, inst.start);
  // Transport: the months of this instalment the child uses the bus, at their stop's fare (from the allocation, never typed here).
  const bus = await transport.chargeFor(db, enrolment.id, inst.start, inst.end);
  if (bus.gross > 0) rates.push({ head_code: 'TRANSPORT', periodicity: 'QUARTERLY', amount_paise: bus.gross });
  // Quarterly rates are for three months: a monthly bill is a third of the quarter (to the rupee). Annual charges go on the year's first bill.
  const months = monthsIn(inst.start, inst.end);
  const first = await db.one<{ start: string }>('select min(lower(period))::text as start from fee_installment where plan_id = $1', [planId]);
  // PTA: once per family (one child pays it, the eldest at the school), on the family's first bill of the year (or once ever).
  const pta = await ptaFor(db, enrolment, planId, inst);
  if (pta > 0) rates.push({ head_code: 'PTA', periodicity: 'ONCE', amount_paise: pta });
  const lines = rates
    .filter((r) => r.periodicity === 'QUARTERLY' || r.periodicity === 'ONCE' || inst.start === first.start)
    .map((r) => (r.periodicity === 'QUARTERLY' && r.head_code !== 'TRANSPORT' && months !== 3 ? { ...r, amount_paise: Math.round((r.amount_paise * months) / 3 / 100) * 100 } : r))
    .map((r) => {
      const applied = rules.filter((c) => c.head_code === r.head_code && evaluate(c.condition, facts as Facts).ok);
      const pct = Math.min(100, applied.reduce((s, c) => s + Number(c.percent), 0));
      return { head: r.head_code, gross: r.amount_paise, concession: percentOf(r.amount_paise, pct), concessions: applied.map((c) => c.name) };
    });
  return { versionId: v.id, feeBand: band.code, classBand: cls.fee_band, because: band.because, lines };
}

async function postDemandJournal(db: Db, schoolId: string, studentId: string, key: string, narration: string,
  lines: { head: string; gross: number; concession: number }[]) {
  const heads = await db.query<{ code: string; income_account: string }>('select code, income_account from fee_head');
  const acct = new Map(heads.map((h) => [h.code, h.income_account]));
  const net = lines.reduce((s, l) => s + l.gross - l.concession, 0);
  const concession = lines.reduce((s, l) => s + l.concession, 0);
  await post(db, {
    schoolId, narration, sourceType: 'fee_demand', sourceId: key,
    lines: [
      signed('1200', net, 'debit', studentId),
      signed('5100', concession, 'debit', studentId),
      ...lines.map((l) => signed(acct.get(l.head)!, l.gross, 'credit', studentId)),
    ],
  });
}

/**
 * Which enrolments pay an instalment ($3 start, $4 end, $5 the new-admission setting):
 * - the school where the child was enrolled when the instalment began pays the whole of it, so a
 *   child who moves from another NES school pays the old school for the quarter in progress and
 *   this school from the next one;
 * - a child who joins mid-instalment and was at no NES school when it began pays it here;
 * - a new admission (not from another NES school this year) also pays the earlier instalments of
 *   the year when the school charges new admissions from the start of the year.
 */
const OWES = `(
  (e.period && daterange($3::date, $4::date)
     and (lower(e.period) <= $3::date or not exists (select 1 from enrolment o where o.student_id = e.student_id and o.period @> $3::date)))
  or ($5 = 'YEAR_START' and lower(e.period) >= $4::date
     and not exists (select 1 from enrolment o where o.student_id = e.student_id and o.academic_year = e.academic_year and o.id <> e.id and lower(o.period) < lower(e.period))))`;

/** Raises one instalment for one enrolment (once), with its journal and any credit used. */
async function raise(t: Db, schoolId: string, planId: string, inst: Installment, e: EnrolmentRef) {
  const already = await t.maybeOne(`select 1 from fee_demand where enrolment_id = $1 and installment_code = $2 and kind = 'REGULAR' limit 1`, [e.id, inst.code]);
  if (already) return false;
  const price = await priceInstallment(t, e, planId, inst);
  for (const l of price.lines) {
    await t.query(
      `insert into fee_demand (enrolment_id, plan_id, installment_code, head_code, version_id, kind, gross_paise, concession_paise, fee_band, snapshot)
       values ($1, $2, $3, $4, $5, 'REGULAR', $6, $7, $8, $9)`,
      [e.id, planId, inst.code, l.head, price.versionId, l.gross, l.concession, price.feeBand,
       JSON.stringify({ classBand: price.classBand, because: price.because, concessions: l.concessions })]);
  }
  await postDemandJournal(t, schoolId, e.student_id, `${e.id}:${inst.code}:REGULAR`, `Fees ${inst.label}`, price.lines);
  // Credit the family already has (a withdrawn trip, a reduced fee) goes against the new instalment.
  if (await t.maybeOne(`select 1 from fee_due where enrolment_id = $1 and paid_paise > owed_paise limit 1`, [e.id])) {
    if (await settings.get<string>(t, schoolId, 'fees.credit_use') === 'ADJUST') await refunds.applyCredit(t, e.id, `Credit used for ${inst.label}`);
  }
  return true;
}

/**
 * A child who joins after the school has raised instalments (a new admission, or a move from
 * another NES school) is billed at once for those of them the child owes here: for a new admission
 * in June or July that includes the earlier quarters when the school charges from the start of the
 * year. Instalments the school has not raised yet follow when it raises them for everyone.
 */
export async function billJoiner(t: Db, enrolmentId: string) {
  const e = await t.one<EnrolmentRef & { year: string }>(
    `select id, student_id, school_id, class_code, lower(period)::text as start, academic_year as year from enrolment where id = $1`, [enrolmentId]);
  const p = await plan(t, e.school_id, e.year);
  if (!p) return [];
  const mode = await settings.get<string>(t, e.school_id, 'fees.new_admission_from');
  const raised: string[] = [];
  for (const inst of await installments(t, p.id)) {
    const begun = await t.maybeOne(`select 1 from fee_demand f join enrolment x on x.id = f.enrolment_id where f.plan_id = $1 and f.installment_code = $2 and f.kind = 'REGULAR' and x.school_id = $3 limit 1`, [p.id, inst.code, e.school_id]);
    if (!begun) continue;
    const owes = await t.maybeOne(`select 1 from enrolment e where e.id = $1 and e.academic_year = $2 and ${OWES}`, [enrolmentId, e.year, inst.start, inst.end, mode]);
    if (owes && await raise(t, e.school_id, p.id, inst, e)) raised.push(inst.code);
  }
  if (raised.length) {
    const labels = (await installments(t, p.id)).filter((i) => raised.includes(i.code)).map((i) => i.label);
    await notify.toParentsOf(t, [e.student_id], { kind: 'FEES', title: 'Fees for this year', body: `${labels.join(', ')} ${labels.length === 1 ? 'is' : 'are'} now due. See Fees in the app.`, link: '/fees' });
  }
  return raised;
}

/**
 * Raises regular demands for one instalment for every current enrolment in a school.
 * Safe to run any number of times: a student is charged a regular line once per instalment
 * and head (enforced by a unique index), and its journal once (unique source).
 */
export async function generateDemands(db: Db, actor: Actor, schoolId: string, year: string, installmentCode: string) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT');
  await assertUnitInScope(db, actor, schoolId);
  const p = await plan(db, schoolId, year);
  if (!p) throw notFound('Fee plan');
  const inst = (await installments(db, p.id)).find((i) => i.code === installmentCode);
  if (!inst) throw notFound('Instalment');
  const enrolments = await db.query<EnrolmentRef>(
    `select e.id, e.student_id, e.school_id, e.class_code, lower(e.period)::text as start from enrolment e
      where e.school_id = $1 and e.academic_year = $2 and ${OWES}`,
    [schoolId, year, inst.start, inst.end, await settings.get<string>(db, schoolId, 'fees.new_admission_from')]);
  let created = 0, skipped = 0;
  for (const e of enrolments) {
    if (await db.tx((t) => raise(t, schoolId, p.id, inst, e), { actor: actor.label })) created++; else skipped++;
  }
  return { installment: inst.code, created, skipped };
}

/**
 * How the school bills the rest of the year: by the quarter (four bills) or by the month (twelve).
 * Only months not billed yet change; what is billed stays. Rates are not touched: a month is a third
 * of the quarter. A quarter cut by an earlier change stays monthly until the next quarter begins.
 */
export async function setSchedule(db: Db, actor: Actor, schoolId: string, year: string, schedule: 'QUARTERLY' | 'MONTHLY') {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  const p = await plan(db, schoolId, year);
  if (!p) throw notFound('Fee plan');
  const all = await installments(db, p.id);
  const billed = await db.query<{ code: string }>('select distinct installment_code as code from fee_demand where plan_id = $1', [p.id]);
  const raised = new Set(billed.map((b) => b.code));
  const open = all.filter((i) => !raised.has(i.code));
  if (!open.length) throw conflict('all_billed', 'Every instalment of the year is already billed.');
  const firstOpen = open[0].start;
  if (all.some((i) => raised.has(i.code) && i.start > firstOpen)) throw conflict('gap', 'A later instalment is already billed; change from after it.');
  const end = all.at(-1)!.end;
  const dueDay = await settings.get<number>(db, schoolId, 'fees.monthly_due_day');
  const quarterDue = all.find((i) => /^Q/.test(i.code)) ? Number(all.find((i) => /^Q/.test(i.code))!.due_date.slice(8, 10)) : 25;
  const next = (d: string, n: number) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n; return `${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`; };
  const rows: { code: string; label: string; due: string; start: string; end: string }[] = [];
  for (let d = firstOpen; d < end;) {
    const m = Number(d.slice(5, 7));
    const quarterStart = [4, 7, 10, 1].includes(m);
    if (schedule === 'QUARTERLY' && quarterStart && next(d, 3) <= end) {
      const q = { 4: 'Q1', 7: 'Q2', 10: 'Q3', 1: 'Q4' }[m]!, e = next(d, 3);
      rows.push({ code: q, label: `${MONTH_NAME[m - 1].slice(0, 3)}–${MONTH_NAME[(m + 1) % 12].slice(0, 3)}`, due: `${d.slice(0, 8)}${String(quarterDue).padStart(2, '0')}`, start: d, end: e });
      d = e;
    } else {
      rows.push({ code: `M${String(m).padStart(2, '0')}`, label: `${MONTH_NAME[m - 1]} ${d.slice(0, 4)}`, due: `${d.slice(0, 8)}${String(dueDay).padStart(2, '0')}`, start: d, end: next(d, 1) });
      d = next(d, 1);
    }
  }
  await db.tx(async (t) => {
    await t.query('delete from fee_installment where plan_id = $1 and not (code = any($2::text[]))', [p.id, [...raised]]);
    for (const r of rows) await t.query('insert into fee_installment (plan_id, code, label, due_date, period) values ($1, $2, $3, $4, daterange($5::date, $6::date))', [p.id, r.code, r.label, r.due, r.start, r.end]);
  }, { actor: actor.label });
  return { schedule, from: firstOpen, installments: rows.map((r) => ({ code: r.code, label: r.label, due: r.due })) };
}

/**
 * What a student owes now, by bill and head: instalments (Q1…Q4), arrears from a fee revision
 * (with their own due dates), and additional charges such as CBSE registration or a trip.
 * A negative due is a credit (for example a withdrawn trip that was already paid).
 */
export async function dues(db: Db, studentId: string) {
  return db.query<{ enrolment_id: string; school: string; bill: string; kind: 'INSTALMENT' | 'ARREARS' | 'CHARGE'; installment_code: string | null; label: string; detail: string | null;
    due_date: string; head_code: string; head: string; owed_paise: number; paid_paise: number; due_paise: number; charge_id: string | null; period_start: string | null; period_end: string | null; school_id: string }>(
    `select d.enrolment_id, o.name as school, d.bill, d.installment_code, d.head_code, h.name as head, d.charge_id,
            case when d.charge_id is not null or d.bill like 'LIB:%' then 'CHARGE' when d.bill <> d.installment_code then 'ARREARS' else 'INSTALMENT' end as kind,
            coalesce(ch.title, case when d.bill like 'LIB:%' then 'Library fine' end, case when d.bill <> d.installment_code then 'Arrears: fee revision from ' || to_char(lower(v.valid), 'FMDD Mon YYYY')
                                     || coalesce(' (part ' || nullif(split_part(d.bill, '-', 2), '') || ')', '') end, i.label) as label,
            case when d.charge_id is not null then nullif(ch.details, '') when d.bill <> d.installment_code then v.note end as detail,
            coalesce(d.due_on, ch.due_on, i.due_date)::text as due_date,
            d.owed_paise::int, d.paid_paise::int, (d.owed_paise - d.paid_paise)::int as due_paise,
            lower(i.period)::text as period_start, upper(i.period)::text as period_end, e.school_id
       from fee_due d join enrolment e on e.id = d.enrolment_id join org_unit o on o.id = e.school_id
       join fee_head h on h.code = d.head_code
       left join fee_plan p on p.school_id = e.school_id and p.academic_year = e.academic_year
       left join fee_installment i on i.plan_id = p.id and i.code = d.installment_code
       left join fee_charge ch on ch.id = d.charge_id
       left join fee_plan_version v on v.id = d.revision_id
      where e.student_id = $1 and not (d.owed_paise = 0 and d.paid_paise = 0)
      order by coalesce(d.due_on, ch.due_on, i.due_date), h.alloc_priority`, [studentId]);
}

export async function planDetail(db: Db, schoolId: string, year: string) {
  const p = await plan(db, schoolId, year);
  if (!p) throw notFound('Fee plan');
  const versions = await db.query(
    `select id, version, status, policy, lower(valid)::text as valid_from, upper(valid)::text as valid_to, note, created_by, approved_by
       from fee_plan_version where plan_id = $1 order by version`, [p.id]);
  const current = await db.maybeOne<{ id: string }>(
    `select id from fee_plan_version where plan_id = $1 and status = 'PUBLISHED' and valid @> current_date`, [p.id]);
  const rates = current ? await db.query(
    `select class_band, fee_band, head_code, periodicity, amount_paise::int from fee_rate where version_id = $1 order by class_band, fee_band, head_code`, [current.id]) : [];
  return { planId: p.id, installments: await installments(db, p.id), versions, currentVersionId: current?.id ?? null, rates };
}

export interface RevisionInput {
  effectiveFrom: string;
  policy: 'FUTURE_ONLY' | 'DIFFERENCE_ON_PAID';
  note: string;
  /** How arrears on instalments already due or paid are collected. */
  arrears?: { mode: 'WITH_NEXT' | 'ON_DATE' | 'SPREAD'; due?: string | null };
  changes: { classBand: string; feeBand: string; head: string; amountPaise: number }[];
}

/** Drafts a new fee version: a copy of the version in force, with the requested rate changes. */
export async function draftRevision(db: Db, actor: Actor, planId: string, input: RevisionInput) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT');
  const p = await db.maybeOne<{ school_id: string }>('select school_id from fee_plan where id = $1', [planId]);
  if (!p) throw notFound('Fee plan');
  await assertUnitInScope(db, actor, p.school_id);
  if (!input.changes.length) throw invalid('Add at least one rate change.');
  const arrears = input.arrears ?? { mode: 'WITH_NEXT' };
  if (arrears.mode === 'ON_DATE' && (!arrears.due || arrears.due < today())) throw invalid('Choose a date, today or later, for the arrears to be paid by.');
  if (input.note.trim().length < 5) throw invalid('Give the reason for the change, for example the NES order number. Parents see it with any arrears.');
  return db.tx(async (t) => {
    const base = await versionOn(t, planId, input.effectiveFrom);
    const next = await t.one<{ n: number }>('select max(version) + 1 as n from fee_plan_version where plan_id = $1', [planId]);
    const d = await t.one<{ id: string }>(
      `insert into fee_plan_version (plan_id, version, valid, status, policy, note, arrears_mode, arrears_due) values ($1, $2, daterange($3::date, null), 'DRAFT', $4, $5, $6, $7) returning id`,
      [planId, next.n, input.effectiveFrom, input.policy, input.note.trim(), arrears.mode, arrears.mode === 'ON_DATE' ? arrears.due : null]);
    await t.query(`insert into fee_rate (version_id, class_band, fee_band, head_code, periodicity, amount_paise)
                   select $1, class_band, fee_band, head_code, periodicity, amount_paise from fee_rate where version_id = $2`, [d.id, base.id]);
    for (const c of input.changes) {
      const r = await t.query(`update fee_rate set amount_paise = $5 where version_id = $1 and class_band = $2 and fee_band = $3 and head_code = $4 returning 1`,
        [d.id, c.classBand, c.feeBand, c.head, c.amountPaise]);
      if (!r.length) throw invalid(`There is no ${c.head} rate for ${c.classBand} / ${c.feeBand} to change.`);
    }
    return { versionId: d.id, version: next.n };
  }, { actor: actor.label });
}

const today = () => localToday();
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Owed and paid on one instalment, per head, across every bill it has lines in (arrears included). */
async function onInstallment(db: Db, enrolmentId: string, installmentCode: string) {
  return db.query<{ head_code: string; net: number; paid: number }>(
    `select f.head_code, sum(f.net_paise)::int as net,
            (coalesce((select sum(a.amount_paise) from payment_allocation a join fee_demand g on g.id = a.demand_id where g.enrolment_id = $1 and g.installment_code = $2 and g.head_code = f.head_code), 0)
           - coalesce((select sum(r.amount_paise) from fee_refund_line r join fee_demand g on g.id = r.demand_id where g.enrolment_id = $1 and g.installment_code = $2 and g.head_code = f.head_code), 0))::int as paid
       from fee_demand f where f.enrolment_id = $1 and f.installment_code = $2 group by f.head_code`, [enrolmentId, installmentCode]);
}

/**
 * When arrears are due: with the next instalment, on a chosen date, or split over every
 * instalment still to come. Worked out on the day of approval.
 */
async function arrearsSchedule(db: Db, planId: string, version: number, mode: string, due: string | null, on: string) {
  const ahead = (await installments(db, planId)).filter((i) => i.due_date >= on);
  const fallback = plusDays(on, 15);
  if (mode === 'ON_DATE') return [{ billKey: `REV${version}`, dueOn: due! }];
  if (mode === 'SPREAD' && ahead.length > 1) return ahead.map((i, k) => ({ billKey: `REV${version}-${k + 1}`, dueOn: i.due_date }));
  return [{ billKey: `REV${version}`, dueOn: ahead[0]?.due_date ?? fallback }];
}

/** Splits an amount into n parts that add up exactly (the last part takes the remainder). */
const split = (amount: number, n: number) => {
  const part = Math.trunc(amount / n);
  return Array.from({ length: n }, (_, k) => (k === n - 1 ? amount - part * (n - 1) : part));
};

/**
 * Works out what a draft would do before anyone approves it. Every instalment already raised
 * that starts on or after the effective date is re-priced:
 *  - not yet due and not fully paid: the difference joins that instalment;
 *  - already due, or already paid: the difference is arrears, billed separately with its own
 *    due date (paid instalments only under DIFFERENCE_ON_PAID).
 * Instalments not yet raised simply use the new rates. A reduction becomes a credit.
 */
export async function previewRevision(db: Db, versionId: string, on = today()) {
  const v = await db.maybeOne<{ plan_id: string; policy: string; status: string; valid_from: string; school_id: string; academic_year: string; version: number; arrears_mode: string; arrears_due: string | null; note: string }>(
    `select v.plan_id, v.policy, v.status, lower(v.valid)::text as valid_from, p.school_id, p.academic_year, v.version, v.arrears_mode, v.arrears_due::text, v.note
       from fee_plan_version v join fee_plan p on p.id = v.plan_id where v.id = $1`, [versionId]);
  if (!v) throw notFound('Fee version');
  const all = await installments(db, v.plan_id);
  const insts = all.filter((i) => i.start >= v.valid_from);
  const schedule = await arrearsSchedule(db, v.plan_id, v.version, v.arrears_mode, v.arrears_due, on);
  const changes: { enrolmentId: string; studentId: string; installment: string; head: string; delta: number; paid: boolean; arrears: boolean }[] = [];
  const enrolments = await db.query<EnrolmentRef>(
    `select id, student_id, school_id, class_code, lower(period)::text as start from enrolment
      where school_id = $1 and academic_year = $2 and status in ('ACTIVE', 'PROVISIONAL')`,
    [v.school_id, v.academic_year]);
  for (const e of enrolments) {
    for (const inst of insts) {
      const existing = await onInstallment(db, e.id, inst.code);
      if (!existing.length) continue;
      const price = await priceInstallment(db, e, v.plan_id, inst, versionId);
      for (const l of price.lines) {
        const cur = existing.find((x) => x.head_code === l.head);
        if (!cur) continue;
        const delta = l.gross - l.concession - cur.net;
        if (delta === 0) continue;
        const paid = cur.paid > 0 && cur.paid >= cur.net;
        if (paid && v.policy === 'FUTURE_ONLY') continue;
        // An increase on a paid or overdue instalment is arrears; a reduction on an unpaid one simply lowers it.
        changes.push({ enrolmentId: e.id, studentId: e.student_id, installment: inst.code, head: l.head, delta, paid, arrears: paid || (delta > 0 && inst.due_date < on) });
      }
    }
  }
  const arrears = changes.filter((c) => c.arrears);
  const perStudent = new Map<string, number>();
  for (const c of arrears) perStudent.set(c.studentId, (perStudent.get(c.studentId) ?? 0) + c.delta);
  return {
    versionId, policy: v.policy, effectiveFrom: v.valid_from, status: v.status, note: v.note,
    studentsAffected: new Set(changes.map((c) => c.studentId)).size,
    linesToAdd: changes.length,
    extraDemandPaise: changes.reduce((s, c) => s + c.delta, 0),
    arrearsPaise: arrears.reduce((s, c) => s + c.delta, 0),
    arrearsStudents: perStudent.size,
    largestArrearsPaise: Math.max(0, ...perStudent.values()),
    arrearsMode: v.arrears_mode,
    arrearsSchedule: schedule,
    paidInstallmentsAffected: changes.filter((c) => c.paid).length,
    untouchedInstallments: all.filter((i) => i.start < v.valid_from).map((i) => i.code),
    changes,
  };
}

/** Approval by a second person publishes the version and adds the difference lines, atomically. */
export async function approveRevision(db: Db, actor: Actor, versionId: string, on = today()) {
  requireRole(actor, 'NES_ADMIN', 'SCHOOL_ADMIN');
  return db.tx(async (t) => {
    const v = await t.maybeOne<{ plan_id: string; status: string; created_by: string; valid_from: string; school_id: string }>(
      `select v.plan_id, v.status, v.created_by, lower(v.valid)::text as valid_from, p.school_id
         from fee_plan_version v join fee_plan p on p.id = v.plan_id where v.id = $1 for update of v`, [versionId]);
    if (!v) throw notFound('Fee version');
    await assertUnitInScope(t, actor, v.school_id);
    if (v.status !== 'DRAFT') throw conflict('already_published', 'This version is already published.');
    if (v.created_by === actor.label) throw conflict('maker_checker', 'A fee change must be approved by someone other than the person who drafted it.');
    const preview = await previewRevision(t, versionId, on);

    await t.query(`update fee_plan_version set valid = daterange(lower(valid), $2::date)
                    where plan_id = $1 and status = 'PUBLISHED' and valid @> $2::date and lower(valid) < $2::date`, [v.plan_id, v.valid_from]);
    // Versions starting on or after the new date are replaced by it entirely.
    await t.query(`update fee_plan_version set status = 'SUPERSEDED' where plan_id = $1 and status = 'PUBLISHED' and lower(valid) >= $2::date`, [v.plan_id, v.valid_from]);
    await t.query(`update fee_plan_version set status = 'PUBLISHED', approved_by = $2, published_at = now() where id = $1`, [versionId, actor.label]);
    const byKey = new Map<string, typeof preview.changes>();
    for (const c of preview.changes) {
      const k = `${c.enrolmentId}:${c.installment}`;
      byKey.set(k, [...(byKey.get(k) ?? []), c]);
    }
    for (const [k, group] of byKey) {
      const [enrolmentId, installment] = k.split(':');
      const band = await t.one<{ fee_band: string }>(`select fee_band from fee_demand where enrolment_id = $1 and installment_code = $2 and kind = 'REGULAR' limit 1`, [enrolmentId, installment]);
      for (const c of group) {
        // Arrears go to their own bill(s) with their own due dates; otherwise the difference joins the instalment.
        const parts = c.arrears ? preview.arrearsSchedule : [{ billKey: null, dueOn: null }];
        const amounts = split(c.delta, parts.length);
        for (let k = 0; k < parts.length; k++) {
          if (amounts[k] === 0) continue;
          await t.query(
            `insert into fee_demand (enrolment_id, plan_id, installment_code, head_code, version_id, kind, gross_paise, concession_paise, fee_band, snapshot, bill_key, due_on)
             values ($1, $2, $3, $4, $5, 'DIFFERENCE', $6, 0, $7, $8, $9, $10)`,
            [enrolmentId, v.plan_id, installment, c.head, versionId, amounts[k], band.fee_band,
             JSON.stringify({ revision: versionId, wasPaid: c.paid, arrears: c.arrears, part: parts.length > 1 ? `${k + 1} of ${parts.length}` : null }), parts[k].billKey, parts[k].dueOn]);
        }
      }
      await postDemandJournal(t, v.school_id, group[0].studentId, `${k}:DIFFERENCE:${versionId}`, 'Fee revision difference',
        group.map((c) => ({ head: c.head, gross: c.delta, concession: 0 })));
      await t.query(`insert into outbox (topic, payload) values ('fee.revised', $1)`,
        [JSON.stringify({ studentId: group[0].studentId, installment, deltaPaise: group.reduce((s, c) => s + c.delta, 0) })]);
    }
    // A reduction on a paid instalment leaves a credit: use it (or refund it) as the school has set.
    for (const enrolmentId of new Set(preview.changes.filter((c) => c.delta < 0).map((c) => c.enrolmentId))) {
      await refunds.settle(t, actor, enrolmentId, `Fee revision from ${preview.effectiveFrom}`);
    }
    // Tell each family what changed and when any arrears are due.
    const perStudent = new Map<string, { arrears: number; future: number }>();
    for (const c of preview.changes) {
      const x = perStudent.get(c.studentId) ?? { arrears: 0, future: 0 };
      if (c.arrears) x.arrears += c.delta; else x.future += c.delta;
      perStudent.set(c.studentId, x);
    }
    const when = preview.arrearsSchedule.length > 1 ? `in ${preview.arrearsSchedule.length} parts with the coming instalments` : `by ${fullDate(preview.arrearsSchedule[0].dueOn)}`;
    for (const [studentId, x] of perStudent) {
      const parts = [
        x.arrears > 0 ? `Arrears of ${rupees(x.arrears)} for instalments already raised are due ${when}.` : x.arrears < 0 ? `You have a credit of ${rupees(-x.arrears)}.` : '',
        x.future ? `Instalments not yet paid are adjusted by ${rupees(x.future)}.` : '',
      ].filter(Boolean).join(' ');
      await notify.toParentsOf(t, [studentId], { kind: 'FEES', title: `Fees revised from ${fullDate(preview.effectiveFrom)}`, body: `${preview.note}. ${parts}`.slice(0, 400), link: '/fees' });
    }
    return { published: versionId, linesAdded: preview.linesToAdd, studentsAffected: preview.studentsAffected, arrearsPaise: preview.arrearsPaise, arrearsSchedule: preview.arrearsSchedule };
  }, { actor: actor.label });
}

/** The current year's instalments this child owes that the school has not billed yet, priced as they would be. */
async function notYetBilled(db: Db, studentId: string) {
  const e = await db.maybeOne<EnrolmentRef & { year: string }>(
    `select id, student_id, school_id, class_code, lower(period)::text as start, academic_year as year from enrolment
      where student_id = $1 and upper_inf(period) and status in ('ACTIVE', 'PROVISIONAL')`, [studentId]);
  if (!e) return null;
  const p = await plan(db, e.school_id, e.year);
  if (!p) return null;
  const mode = await settings.get<string>(db, e.school_id, 'fees.new_admission_from');
  const out: { inst: Installment; amountPaise: number }[] = [];
  for (const inst of await installments(db, p.id)) {
    if (await db.maybeOne(`select 1 from fee_demand where enrolment_id = $1 and installment_code = $2 and kind = 'REGULAR' limit 1`, [e.id, inst.code])) continue;
    if (!await db.maybeOne(`select 1 from enrolment e where e.id = $1 and e.academic_year = $2 and ${OWES}`, [e.id, e.year, inst.start, inst.end, mode])) continue;
    const price = await priceInstallment(db, e, p.id, inst);
    out.push({ inst, amountPaise: price.lines.reduce((t, l) => t + l.gross - l.concession, 0) });
  }
  return { e, planId: p.id, rest: out };
}

/** What the parent app may offer: paying a quarter month by month, and paying the rest of the year now. */
export async function payOptions(db: Db, studentId: string) {
  const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and upper_inf(period) and status in ('ACTIVE', 'PROVISIONAL')`, [studentId]);
  if (!e) return { monthlyParts: false, wholeYear: null };
  const allowed = await settings.get<boolean>(db, e.school_id, 'fees.pay_whole_year');
  const ahead = allowed ? await notYetBilled(db, studentId) : null;
  return {
    monthlyParts: await settings.get<boolean>(db, e.school_id, 'fees.monthly_parts'),
    wholeYear: ahead && ahead.rest.length ? { installments: ahead.rest.map((r) => ({ code: r.inst.code, label: r.inst.label, dueDate: r.inst.due_date, amountPaise: r.amountPaise })), totalPaise: ahead.rest.reduce((t, r) => t + r.amountPaise, 0) } : null,
  };
}

/**
 * The parent chooses to pay the whole year: the rest of the year's instalments are billed now
 * (each priced as it would be later, with concessions), so they appear with the dues and can be
 * paid together. Billing later for everyone skips them, as each is billed once.
 */
export async function billRestOfYear(db: Db, actor: Actor, studentId: string) {
  const ahead = await notYetBilled(db, studentId);
  if (!ahead) throw notFound('Current enrolment');
  if (!await settings.get<boolean>(db, ahead.e.school_id, 'fees.pay_whole_year')) throw forbidden('This school does not take the whole year’s fees at once.');
  if (!ahead.rest.length) throw invalid('Every instalment of this year is already billed.');
  return db.tx(async (t) => {
    const done: string[] = [];
    for (const r of ahead.rest) if (await raise(t, ahead.e.school_id, ahead.planId, r.inst, ahead.e)) done.push(r.inst.label);
    return { billed: done };
  }, { actor: actor.label });
}
