import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import { open as unseal } from '../lib/secret.js';
import type { Actor } from './auth.js';
import { assertCan, can } from './access.js';
import { post, signed, type Line as JLine } from './ledger.js';
import * as notify from './notify.js';
import * as settings from './settings.js';
import * as staff from './staff.js';
import * as staffLeave from './staffLeave.js';
import * as printing from './printing.js';
import { embedImage, newDocument, rupeesInWords, Sheet } from '../lib/pdf.js';

/**
 * The payroll. Each school runs its own: the accountant prepares the month, the principal
 * approves it (never the same person), and approval locks it for ever. Every payslip line keeps
 * how it was worked out. A month is split wherever a person's pay or the school's rates change, so
 * a DA rise from the 17th pays exactly. Mistakes and back-dated changes are settled by a
 * supplementary run that pays (or recovers) the difference; a leaver's dues by a final settlement.
 */

const rs = (p: number) => `₹${(Math.round(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const monthEnd = (m: string) => addDays(addDays(m, 32).slice(0, 8) + '01', -1);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
const monthName = (m: string) => new Date(`${m}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fyOf = (m: string) => { const y = Number(m.slice(0, 4)); const s = Number(m.slice(5, 7)) >= 4 ? y : y - 1; return { start: `${s}-04-01`, end: `${s + 1}-03-31`, code: `${s}-${String((s + 1) % 100).padStart(2, '0')}` }; };

export interface PayLine { code: string; name: string; kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER'; taxable: boolean; amount: number; basis: string; inputs?: Record<string, unknown>; loanId?: string | null; forMonth?: string | null; pfWage?: boolean; prorate?: boolean }
export interface Issue { level: 'ERROR' | 'WARNING'; userId: string; name: string; message: string }

// ── The law, read once per computation ─────────────────────────────────────────────────────

async function statutory(t: Db) {
  const rows = await t.query<{ code: string; value: number; from: string; to: string | null }>(
    `select code, value::float as value, lower(valid)::text as from, upper(valid)::text as to from statutory_rate where status = 'APPROVED'`);
  return (code: string, on: string) => {
    const r = rows.find((x) => x.code === code && x.from <= on && (!x.to || on < x.to));
    if (!r) throw invalid(`No ${code} rate is in force on ${on}. NES must load it.`);
    return r.value;
  };
}

async function ptFor(t: Db, state: string, gross: number, month: string) {
  const s = await t.maybeOne<{ amount: number; feb: number | null }>(
    `select amount_paise::int as amount, february_paise::int as feb from pt_slab where state = $1 and valid @> $3::date and from_paise <= $2 and (to_paise is null or to_paise >= $2) order by from_paise desc limit 1`,
    [state, Math.round(gross), month]);
  if (!s) return 0;
  return month.slice(5, 7) === '02' && s.feb !== null ? s.feb : s.amount;
}

async function taxOn(t: Db, regime: 'NEW' | 'OLD', income: number, on: string, rate: (c: string, d: string) => number) {
  const slabs = await t.query<{ from: number; rate: number }>(`select from_paise::bigint::float as from, rate::float as rate from tax_slab where regime = $1 and valid @> $2::date order by from_paise`, [regime, on]);
  let tax = 0;
  slabs.forEach((s, i) => { const top = slabs[i + 1]?.from ?? Infinity; if (income > s.from) tax += ((Math.min(income, top) - s.from) * s.rate) / 100; });
  const limit = rate(regime === 'NEW' ? 'REBATE_NEW_LIMIT' : 'REBATE_OLD_LIMIT', on), max = rate(regime === 'NEW' ? 'REBATE_NEW_MAX' : 'REBATE_OLD_MAX', on);
  if (income <= limit) tax = Math.max(0, tax - max);
  return Math.round((tax * (1 + rate('CESS_PCT', on) / 100)) / 100) * 100;      // to the rupee
}

// ── One person, one month ──────────────────────────────────────────────────────────────────

interface Ctx { schoolId: string; month: string; to: string; rate: Awaited<ReturnType<typeof statutory>>; ptState: string; kind: 'REGULAR' | 'SUPPLEMENTARY' | 'FINAL'; lastDay?: string }

/**
 * Works out one person's pay for a month (to `lastDay` for a final settlement). Returns the lines,
 * the slip figures and anything the approver should know. Nothing is written.
 */
export async function compute(t: Db, c: Ctx, userId: string, opts: { withTax?: boolean; fullMonth?: boolean } = {}) {
  const issues: Issue[] = [];
  const e = await t.one<{ name: string; employment: string; joined: string; separated: string | null; contract_until: string | null; nes_staff_id: string }>(
    `select u.name, e.employment, e.joined_service::text as joined, e.separated_on::text as separated, e.contract_until::text, e.nes_staff_id from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  const mEnd = monthEnd(c.month), dim = days(c.month, mEnd);
  const start = e.joined > c.month && !opts.fullMonth ? e.joined : c.month;
  let end = opts.fullMonth ? mEnd : c.lastDay ?? mEnd;
  if (e.separated && e.separated < end && !opts.fullMonth) end = e.separated;
  const issue = (level: Issue['level'], message: string) => issues.push({ level, userId, name: e.name, message });
  if (start > end) return { lines: [] as PayLine[], slip: null, issues };
  const employedDays = days(start, end);

  const pays = await t.query<{ structure_id: string; from: string; to: string | null; base: number | null; scale_steps: string[] | null; step: number | null; pf: string; esi: boolean; pt: boolean; tds: boolean; structure: string }>(
    `select ep.structure_id, lower(ep.valid)::text as from, upper(ep.valid)::text as to, ep.base_paise::float as base, sc.steps_paise::text[] as scale_steps, ep.step,
            s.pf, s.esi, s.pt, s.tds, s.name as structure
       from employee_pay ep join pay_structure s on s.id = ep.structure_id left join pay_scale sc on sc.id = ep.scale_id
      where ep.user_id = $1 and ep.valid && daterange($2::date, $3::date, '[]') order by lower(ep.valid)`, [userId, start, end]);
  if (!pays.length) { issue('ERROR', 'No pay fixed for this month.'); return { lines: [] as PayLine[], slip: null, issues }; }
  const comps = await t.query<{ structure_id: string; code: string; name: string; kind: 'EARNING' | 'DEDUCTION'; calc: string; percent: number | null; of_codes: string[] | null; amount: number | null; unit: string | null;
    taxable: boolean; pf_wage: boolean; prorate: boolean; ordinal: number; from: string; to: string | null }>(
    `select structure_id, code, name, kind, calc, percent::float as percent, of_codes, amount_paise::float as amount, unit, taxable, pf_wage, prorate, ordinal, lower(valid)::text as from, upper(valid)::text as to
       from pay_structure_component where structure_id = any($1) and status = 'APPROVED' and valid && daterange($2::date, $3::date, '[]') order by ordinal`, [pays.map((p) => p.structure_id), start, end]);

  // Split the employed days wherever the pay record or a component changes.
  const cuts = new Set<string>([start, addDays(end, 1)]);
  if (!opts.fullMonth) for (const p of pays) { if (p.from > start) cuts.add(p.from); if (p.to && p.to <= end) cuts.add(p.to); }
  for (const x of comps) { if (x.from > start) cuts.add(x.from); if (x.to && x.to <= end) cuts.add(x.to); }
  const points = [...cuts].sort();
  const acc = new Map<string, PayLine & { parts: string[] }>();
  const add = (l: Omit<PayLine, 'basis'> & { part: string }) => {
    const cur = acc.get(l.code) ?? { ...l, amount: 0, basis: '', parts: [] };
    cur.amount += l.amount; cur.parts.push(l.part); acc.set(l.code, cur);
  };
  const units = await t.query<{ unit: string; quantity: number }>(`select unit, quantity::float as quantity from payroll_input where school_id = $1 and month = $2 and user_id = $3`, [c.schoolId, c.month, userId]);
  const month = await staffLeave.monthFor(t, userId, c.month);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = addDays(points[i + 1], -1);
    // For gratuity and encashment (full month), the last pay record counts for the whole month.
    const p = pays.find((x) => x.from <= a && (!x.to || a < x.to)) ?? (opts.fullMonth ? pays[pays.length - 1] : undefined);
    if (!p) continue;
    const w = days(a, b) / dim;
    const base = p.base ?? (p.scale_steps && p.step ? Number(p.scale_steps[p.step - 1]) : null);
    const vals = new Map<string, number>();
    for (const x of comps.filter((y) => y.structure_id === p.structure_id && y.from <= a && (!y.to || a < y.to))) {
      let monthly = 0, how = '';
      if (x.calc === 'BASE') { if (base === null) { issue('ERROR', `No base pay or scale step for ${x.name}.`); continue; } monthly = base; how = rs(base); }
      else if (x.calc === 'FLAT') { monthly = x.amount!; how = rs(monthly); }
      else if (x.calc === 'PERCENT') { const of = (x.of_codes ?? []).reduce((s, k) => s + (vals.get(k) ?? 0), 0); monthly = (of * x.percent!) / 100; how = `${x.percent}% × ${(x.of_codes ?? []).join(' + ')} ${rs(of)}`; }
      else if (x.calc === 'PER_UNIT') {
        if (i > 0) continue;                                                   // counted once for the month
        const q = x.unit === 'DAYS_PRESENT' ? (units.find((u) => u.unit === 'DAYS_PRESENT')?.quantity ?? month.present) : units.find((u) => u.unit === x.unit)?.quantity ?? 0;
        if (!q) issue('WARNING', `No ${x.unit === 'PERIODS' ? 'periods' : x.unit === 'HOURS' ? 'hours' : 'days'} entered for ${x.name}.`);
        add({ code: x.code, name: x.name, kind: x.kind, taxable: x.taxable, pfWage: x.pf_wage, prorate: false, amount: q * x.amount!, part: `${q} ${x.unit?.toLowerCase().replace('_', ' ')} × ${rs(x.amount!)}` });
        continue;
      }
      vals.set(x.code, monthly);
      const amt = x.prorate ? monthly * w : (i === 0 ? monthly : 0);
      add({ code: x.code, name: x.name, kind: x.kind, taxable: x.taxable, pfWage: x.pf_wage, prorate: x.prorate, amount: amt,
        part: `${how}${x.prorate && w < 1 ? ` × ${days(a, b)}/${dim} days` : ''}` });
    }
  }
  // The person's own allowances and deductions.
  const own = await t.query<{ code: string; name: string; kind: 'EARNING' | 'DEDUCTION'; taxable: boolean; amount: number; from: string; to: string | null }>(
    `select code, name, kind, taxable, amount_paise::float as amount, lower(valid)::text as from, upper(valid)::text as to from employee_component
      where user_id = $1 and approved_by is not null and valid && daterange($2::date, $3::date, '[]')`, [userId, start, end]);
  for (const o of own) {
    const a = o.from > start ? o.from : start, b = o.to && addDays(o.to, -1) < end ? addDays(o.to, -1) : end;
    const d = days(a, b);
    add({ code: o.code, name: o.name, kind: o.kind, taxable: o.taxable, prorate: true, amount: (o.amount * d) / dim, part: `${rs(o.amount)}${d < dim ? ` × ${d}/${dim} days` : ''}` });
  }
  const lines: PayLine[] = [...acc.values()].map(({ parts, ...l }) => ({ ...l, amount: Math.round(l.amount), basis: parts.length > 1 ? parts.join(' + ') : parts[0] }));

  // Loss of pay: days absent without leave, and unpaid or half-paid leave.
  const proratable = lines.filter((l) => l.kind === 'EARNING' && l.prorate !== false).reduce((s, l) => s + l.amount, 0);
  const lopDays = Math.min(month.lopDays, employedDays);
  if (lopDays > 0 && proratable > 0) {
    const perDay = proratable / employedDays;
    lines.push({ code: 'LOP', name: 'Loss of pay', kind: 'DEDUCTION', taxable: true, amount: Math.round(perDay * lopDays), basis: `${lopDays} day${lopDays === 1 ? '' : 's'} × ${rs(perDay)} a day`, inputs: { lopDays, employedDays } });
  }
  if (!month.marked && c.kind === 'REGULAR' && !lines.some((l) => l.code !== 'LOP' && l.basis.includes('days present'))) issue('WARNING', 'No attendance is marked for this month.');
  const earnings = lines.filter((l) => l.kind === 'EARNING').reduce((s, l) => s + l.amount, 0);
  const lop = lines.find((l) => l.code === 'LOP')?.amount ?? 0;
  const gross = earnings - lop;
  const p0 = pays[pays.length - 1];
  const lopShare = proratable > 0 ? 1 - lop / Math.max(earnings, 1) : 1;

  // Provident fund (structure's choice: none, on the ceiling, on actual wages; none on deputation).
  if (p0.pf !== 'NONE' && e.employment !== 'DEPUTATION' && gross > 0) {
    let wages = lines.filter((l) => l.kind === 'EARNING' && l.pfWage).reduce((s, l) => s + l.amount, 0) * lopShare;
    const excluded = gross - wages;
    let rule = '';
    if (excluded > gross / 2) { wages += excluded - gross / 2; rule = ' (excluded allowances above half of pay added back: the 50% rule)'; }
    let ceiling = 0;
    for (let d = c.month; d <= mEnd; d = addDays(d, 1)) ceiling += c.rate('PF_CEILING', d);
    ceiling /= dim;
    const base = p0.pf === 'CEILING' ? Math.min(wages, ceiling) : wages;
    const emp = Math.round((base * c.rate('PF_EMP_PCT', mEnd)) / 100 / 100) * 100;
    const eps = Math.round((Math.min(base, c.rate('EPS_CEILING', mEnd)) * c.rate('PF_ER_EPS_PCT', mEnd)) / 100 / 100) * 100;
    lines.push({ code: 'PF', name: 'Provident fund', kind: 'DEDUCTION', taxable: false, amount: emp, basis: `${c.rate('PF_EMP_PCT', mEnd)}% of PF wages ${rs(base)}${p0.pf === 'CEILING' && wages > ceiling ? ` (ceiling ${rs(ceiling)})` : ''}${rule}`, inputs: { wages: Math.round(wages), base: Math.round(base) } });
    lines.push({ code: 'ER_EPS', name: 'Employer pension (EPS)', kind: 'EMPLOYER', taxable: false, amount: eps, basis: `${c.rate('PF_ER_EPS_PCT', mEnd)}% of ${rs(Math.min(base, c.rate('EPS_CEILING', mEnd)))}` });
    lines.push({ code: 'ER_EPF', name: 'Employer EPF', kind: 'EMPLOYER', taxable: false, amount: emp - eps, basis: `${c.rate('PF_EMP_PCT', mEnd)}% of ${rs(base)} less pension share` });
    lines.push({ code: 'ER_EDLI', name: 'Employer EDLI', kind: 'EMPLOYER', taxable: false, amount: Math.round((Math.min(base, ceiling) * c.rate('EDLI_PCT', mEnd)) / 100), basis: `${c.rate('EDLI_PCT', mEnd)}% of ${rs(Math.min(base, ceiling))}` });
    lines.push({ code: 'ER_PF_ADMIN', name: 'EPF administration charges', kind: 'EMPLOYER', taxable: false, amount: Math.round((base * c.rate('PF_ADMIN_PCT', mEnd)) / 100), basis: `${c.rate('PF_ADMIN_PCT', mEnd)}% of ${rs(base)}` });
  }
  // ESI: where gross pay is within the ceiling, or the person was covered at the start of the contribution period.
  if (p0.esi && gross > 0) {
    const periodStart = Number(c.month.slice(5, 7)) >= 4 && Number(c.month.slice(5, 7)) <= 9 ? `${c.month.slice(0, 4)}-04-01` : Number(c.month.slice(5, 7)) >= 10 ? `${c.month.slice(0, 4)}-10-01` : `${Number(c.month.slice(0, 4)) - 1}-10-01`;
    const covered = gross <= c.rate('ESI_CEILING', mEnd) || !!(await t.maybeOne(
      `select 1 from payroll_line l join payroll_run r on r.id = l.run_id where l.user_id = $1 and l.code = 'ESI' and r.status in ('LOCKED', 'PAID') and r.month >= $2 and r.month < $3`, [userId, periodStart, c.month]));
    if (covered) {
      const emp = Math.ceil((gross * c.rate('ESI_EMP_PCT', mEnd)) / 100 / 100) * 100;
      lines.push({ code: 'ESI', name: 'Employees’ state insurance', kind: 'DEDUCTION', taxable: false, amount: emp, basis: `${c.rate('ESI_EMP_PCT', mEnd)}% of gross ${rs(gross)}` });
      lines.push({ code: 'ER_ESI', name: 'Employer ESI', kind: 'EMPLOYER', taxable: false, amount: Math.round((gross * c.rate('ESI_ER_PCT', mEnd)) / 100), basis: `${c.rate('ESI_ER_PCT', mEnd)}% of gross ${rs(gross)}` });
    }
  }
  // Professional tax of the school's state.
  if (p0.pt && gross > 0 && c.kind !== 'SUPPLEMENTARY') {
    const pt = await ptFor(t, c.ptState, gross, c.month);
    if (pt) lines.push({ code: 'PT', name: 'Professional tax', kind: 'DEDUCTION', taxable: false, amount: pt, basis: `${c.ptState} slab for gross ${rs(gross)}${c.month.slice(5, 7) === '02' ? ' (February)' : ''}` });
  }
  // Income tax: the year's tax under the chosen regime, less what is already deducted, spread over the months left.
  if (p0.tds && opts.withTax !== false && c.kind !== 'SUPPLEMENTARY') {
    const fy = fyOf(c.month);
    const decl = await t.maybeOne<{ regime: 'NEW' | 'OLD'; items: Record<string, number> }>('select regime, items from tax_declaration where user_id = $1 and fy = $2', [userId, fy.code]);
    const regime = decl?.regime ?? 'NEW';
    const before = await t.one<{ taxable: number; tds: number }>(
      `select coalesce(sum(case when l.kind = 'EARNING' and l.taxable then l.amount_paise when l.code = 'LOP' then -l.amount_paise else 0 end), 0)::float as taxable,
              coalesce(sum(case when l.code = 'TDS' then l.amount_paise else 0 end), 0)::float as tds
         from payroll_line l join payroll_run r on r.id = l.run_id
        where l.user_id = $1 and r.status in ('LOCKED', 'PAID') and coalesce(l.for_month, r.month) between $2 and $3 and r.month < $4`, [userId, fy.start, fy.end, c.month]);
    const thisTaxable = lines.filter((l) => l.kind === 'EARNING' && l.taxable).reduce((s, l) => s + l.amount, 0) - lop;
    const lastPaid = [fy.end, e.contract_until ?? fy.end, e.separated ?? fy.end, c.kind === 'FINAL' ? c.month : fy.end].sort()[0];
    const monthsLeft = Math.max(0, (Number(lastPaid.slice(0, 4)) - Number(c.month.slice(0, 4))) * 12 + Number(lastPaid.slice(5, 7)) - Number(c.month.slice(5, 7)));
    let projected = before.taxable + thisTaxable + thisTaxable * monthsLeft;
    const std = c.rate(regime === 'NEW' ? 'STD_DED_NEW' : 'STD_DED_OLD', mEnd);
    let deductions = std;
    if (regime === 'OLD') {
      const it = decl?.items ?? {};
      deductions += Math.min(Number(it['80C'] ?? 0), 15000000) + Math.min(Number(it['80D'] ?? 0), 5000000) + Number(it.HRA_EXEMPT ?? 0) + Number(it.OTHER ?? 0);
      const ptYear = (lines.find((l) => l.code === 'PT')?.amount ?? 0) * (monthsLeft + 1);
      deductions += ptYear;
    }
    projected = Math.max(0, projected - deductions);
    const annual = await taxOn(t, regime, projected, mEnd, c.rate);
    const tds = Math.max(0, Math.round((annual - before.tds) / (monthsLeft + 1) / 100) * 100);
    lines.push({ code: 'TDS', name: 'Income tax (TDS)', kind: 'DEDUCTION', taxable: false, amount: tds,
      basis: `${regime === 'NEW' ? 'New' : 'Old'} regime: taxable income for the year ${rs(projected)} after ${rs(deductions)} deductions; tax ${rs(annual)}, already deducted ${rs(before.tds)}, over ${monthsLeft + 1} month${monthsLeft ? 's' : ''}`,
      inputs: { regime, projected, annual, deductedBefore: before.tds, monthsLeft } });
  }
  // Loans and advances: the instalment, never more than what is left.
  const loans = await t.query<{ id: string; kind: string; principal: number; instalment: number; recovered: number }>(
    `select l.id, l.kind, l.principal_paise::float as principal, l.instalment_paise::float as instalment,
            coalesce((select sum(pl.amount_paise) from payroll_line pl join payroll_run r on r.id = pl.run_id where pl.loan_id = l.id and r.status in ('LOCKED', 'PAID')), 0)::float as recovered
       from staff_loan l where l.user_id = $1 and l.status = 'SANCTIONED' and l.first_month <= $2`, [userId, c.month]);
  for (const l of loans) {
    const left = l.principal - l.recovered;
    if (left <= 0) continue;
    const take = c.kind === 'FINAL' ? left : Math.min(l.instalment, left);
    lines.push({ code: 'LOAN', name: `Recovery: ${l.kind.toLowerCase().replace('_', ' ')}`, kind: 'DEDUCTION', taxable: false, amount: take, basis: `${c.kind === 'FINAL' ? 'Whole balance' : `Instalment ${rs(l.instalment)}`}; ${rs(left - take)} left after this`, loanId: l.id });
  }
  const deductions = lines.filter((l) => l.kind === 'DEDUCTION' && l.code !== 'LOP').reduce((s, l) => s + l.amount, 0);
  const employer = lines.filter((l) => l.kind === 'EMPLOYER').reduce((s, l) => s + l.amount, 0);
  const net = gross - deductions;
  if (net < 0) issue('ERROR', `Net pay would be ${rs(net)}: deductions are more than pay.`);
  if (e.contract_until && e.contract_until < c.month && !e.separated) issue('WARNING', `The contract ended on ${e.contract_until}. Renew it or record that the person has left.`);
  return { lines, slip: { daysInMonth: dim, paidDays: employedDays - lopDays, lopDays, gross, deductions, net, employer }, issues };
}

// ── Runs ───────────────────────────────────────────────────────────────────────────────────

async function ctxFor(t: Db, schoolId: string, month: string, kind: Ctx['kind'], lastDay?: string): Promise<Ctx> {
  return { schoolId, month, to: monthEnd(month), kind, lastDay, rate: await statutory(t), ptState: await settings.get<string>(t, schoolId, 'payroll.pt_state') };
}

async function writePerson(t: Db, runId: string, userId: string, r: Awaited<ReturnType<typeof compute>>, bankId: string | null) {
  if (!r.slip) return;
  await t.query(`insert into payroll_slip (run_id, user_id, days_in_month, paid_days, lop_days, gross_paise, deduction_paise, net_paise, employer_paise, bank_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [runId, userId, r.slip.daysInMonth, r.slip.paidDays, r.slip.lopDays, Math.round(r.slip.gross), Math.round(r.slip.deductions), Math.round(r.slip.net), Math.round(r.slip.employer), bankId]);
  for (const l of r.lines) {
    if (!l.amount && l.code !== 'TDS') continue;
    await t.query(`insert into payroll_line (run_id, user_id, code, name, kind, taxable, amount_paise, basis, inputs, loan_id, for_month) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [runId, userId, l.code, l.name, l.kind, l.taxable, Math.round(l.amount), l.basis, JSON.stringify(l.inputs ?? {}), l.loanId ?? null, l.forMonth ?? null]);
  }
}

async function fill(t: Db, runId: string) {
  const run = await t.one<{ school_id: string; month: string; kind: Ctx['kind']; for_user: string | null }>('select school_id, month::text, kind, for_user from payroll_run where id = $1', [runId]);
  await t.query('delete from payroll_line where run_id = $1', [runId]);
  await t.query('delete from payroll_slip where run_id = $1', [runId]);
  const mEnd = monthEnd(run.month);
  const cooling = await settings.get<number>(t, run.school_id, 'payroll.bank_cooling_days');
  const alert = await settings.get<number>(t, run.school_id, 'payroll.change_alert_pct');
  const people = run.kind === 'FINAL' ? [{ user_id: run.for_user! }] : await t.query<{ user_id: string }>(
    `select e.user_id from employee e where e.school_id = $1 and e.joined_service <= $3 and (e.separated_on is null or e.separated_on >= $2)
        and exists (select 1 from employee_pay ep where ep.user_id = e.user_id and ep.valid && daterange($2::date, $3::date, '[]'))
        and not exists (select 1 from payroll_run f where f.kind = 'FINAL' and f.for_user = e.user_id and f.month = $2::date)`, [run.school_id, run.month, mEnd]);
  const ctx = await ctxFor(t, run.school_id, run.month, run.kind, run.kind === 'FINAL' ? (await t.one<{ d: string }>('select separated_on::text as d from employee where user_id = $1', [run.for_user])).d : undefined);
  const issues: Issue[] = [];
  for (const p of people) {
    const r = await compute(t, ctx, p.user_id);
    const bank = await staff.bankFor(t, p.user_id, mEnd, cooling);
    if (r.slip && r.slip.net > 0 && !bank) r.issues.push({ level: 'ERROR', userId: p.user_id, name: r.issues[0]?.name ?? (await t.one<{ name: string }>('select name from app_user where id = $1', [p.user_id])).name, message: `No verified bank account (verified at least ${cooling} days before the month end).` });
    const newer = await t.maybeOne(`select 1 from employee_bank where user_id = $1 and status = 'VERIFIED' and verified_at::date > $2::date - $3::int`, [p.user_id, mEnd, cooling]);
    if (newer) r.issues.push({ level: 'WARNING', userId: p.user_id, name: '', message: 'A new bank account was verified recently; this month is paid into the previous one.' });
    if (run.kind === 'REGULAR' && r.slip) {
      const last = await t.maybeOne<{ net: number }>(`select s.net_paise::float as net from payroll_slip s join payroll_run x on x.id = s.run_id where s.user_id = $1 and x.kind = 'REGULAR' and x.status in ('LOCKED', 'PAID') and x.month < $2 order by x.month desc limit 1`, [p.user_id, run.month]);
      if (last && last.net > 0 && Math.abs(r.slip.net - last.net) / last.net * 100 > alert) r.issues.push({ level: 'WARNING', userId: p.user_id, name: '', message: `Net pay ${rs(r.slip.net)} is ${Math.round(((r.slip.net - last.net) / last.net) * 100)}% different from last month (${rs(last.net)}).` });
    }
    await writePerson(t, runId, p.user_id, r, bank?.id ?? null);
    issues.push(...r.issues);
  }
  for (const i of issues) if (!i.name) i.name = (await t.one<{ name: string }>('select name from app_user where id = $1', [i.userId])).name;
  const totals = await t.one<{ people: number; gross: number; deductions: number; net: number; employer: number }>(
    `select count(*)::int as people, coalesce(sum(gross_paise), 0)::float as gross, coalesce(sum(deduction_paise), 0)::float as deductions, coalesce(sum(net_paise), 0)::float as net, coalesce(sum(employer_paise), 0)::float as employer from payroll_slip where run_id = $1`, [runId]);
  await t.query('update payroll_run set totals = $2, issues = $3 where id = $1', [runId, JSON.stringify(totals), JSON.stringify(issues)]);
  return { totals, issues };
}

async function loadRun(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Payroll run');
  const r = await db.maybeOne<{ id: string; school_id: string; month: string; kind: Ctx['kind']; status: string; prepared_by: string; title: string; for_user: string | null; totals: Record<string, number>; issues: Issue[] }>(
    'select id, school_id, month::text, kind, status, prepared_by, title, for_user, totals, issues from payroll_run where id = $1', [id]);
  if (!r) throw notFound('Payroll run');
  return r;
}

/** The month's regular payroll for a school, worked out for everyone on its staff. */
export async function createRun(db: Db, actor: Actor, schoolId: string, month: string) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  if (!/^\d{4}-\d{2}-01$/.test(month)) throw invalid('Choose a month.');
  if (month > localToday()) throw invalid('A month’s payroll is prepared during or after the month.');
  if (await db.maybeOne(`select 1 from payroll_run where school_id = $1 and month = $2 and kind = 'REGULAR'`, [schoolId, month])) throw conflict('exists', 'This month’s payroll already exists.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into payroll_run (school_id, month, kind, title, prepared_by) values ($1, $2, 'REGULAR', $3, $4) returning id`, [schoolId, month, `Salary for ${monthName(month)}`, actor.id]);
    return { id: r.id, ...(await fill(t, r.id)) };
  }, { actor: actor.label });
}

/** Works the draft out again after inputs, attendance or pay changed. */
export async function recompute(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  if (r.status !== 'DRAFT') throw conflict('not_draft', 'Only a draft is worked out again; send it back to draft first.');
  if (r.kind === 'SUPPLEMENTARY') throw conflict('supplementary', 'Discard this arrears run and make it again.');
  return db.tx((t) => fill(t, id), { actor: actor.label });
}

export async function discard(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  if (r.status !== 'DRAFT') throw conflict('not_draft', 'Only a draft can be discarded.');
  await db.tx(async (t) => {
    await t.query('delete from payroll_line where run_id = $1', [id]);
    await t.query('delete from payroll_slip where run_id = $1', [id]);
    await t.query('delete from payroll_run where id = $1', [id]);
  }, { actor: actor.label });
  return { ok: true };
}

/** The accountant sends the run to the principal. Refused while any error remains. */
export async function submit(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  if (r.status !== 'DRAFT') throw conflict('state', 'Only a draft is submitted.');
  const errors = r.issues.filter((i) => i.level === 'ERROR');
  if (errors.length) throw invalid(`${errors.length} problem${errors.length === 1 ? '' : 's'} must be fixed first: ${errors.slice(0, 3).map((i) => `${i.name}: ${i.message}`).join('; ')}`);
  await db.tx(async (t) => {
    await t.query(`update payroll_run set status = 'SUBMITTED', submitted_at = now() where id = $1`, [id]);
    const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path and u.id <> $2`, [r.school_id, actor.id]);
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'PAY', title: `${r.title}: ready for approval`, body: `${r.totals.people} people, net ${rs(r.totals.net)}.${r.issues.length ? ` ${r.issues.length} point${r.issues.length === 1 ? '' : 's'} to check.` : ''}`, link: `/payroll/${id}` });
  }, { actor: actor.label });
  return { status: 'SUBMITTED' };
}

export async function sendBack(db: Db, actor: Actor, id: string, note: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.approve', r.school_id);
  if (r.status !== 'SUBMITTED') throw conflict('state', 'Only a submitted run can be sent back.');
  await db.tx(async (t) => {
    await t.query(`update payroll_run set status = 'DRAFT' where id = $1`, [id]);
    await notify.toUsers(t, [r.prepared_by], { kind: 'PAY', title: `${r.title}: sent back`, body: note.trim().slice(0, 300), link: `/payroll/${id}` });
  }, { actor: actor.label });
  return { status: 'DRAFT' };
}

/**
 * The principal approves: the run locks for ever, the journal is posted (salary expense against
 * salaries, PF, ESI, professional tax and TDS payable, loans recovered) and payslips reach the staff app.
 */
export async function approve(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.approve', r.school_id);
  if (r.prepared_by === actor.id) throw forbidden('A payroll run is approved by someone other than the person who prepared it.');
  if (r.status !== 'SUBMITTED') throw conflict('state', 'The accountant submits the run first.');
  return db.tx(async (t) => {
    const sum = async (where: string) => (await t.one<{ s: number }>(`select coalesce(sum(amount_paise), 0)::float as s from payroll_line where run_id = $1 and ${where}`, [id])).s;
    const earnings = await sum(`kind = 'EARNING' and code not in ('GRATUITY', 'LEAVE_ENCASH')`), settlement = await sum(`code in ('GRATUITY', 'LEAVE_ENCASH')`), lop = await sum(`code = 'LOP'`);
    const pf = await sum(`code = 'PF'`), erPf = await sum(`code in ('ER_EPF', 'ER_EPS', 'ER_EDLI', 'ER_PF_ADMIN')`), esi = await sum(`code = 'ESI'`), erEsi = await sum(`code = 'ER_ESI'`);
    const pt = await sum(`code = 'PT'`), tds = await sum(`code = 'TDS'`), loan = await sum(`code = 'LOAN'`);
    const other = await sum(`kind = 'DEDUCTION' and code not in ('LOP', 'PF', 'ESI', 'PT', 'TDS', 'LOAN')`);
    const net = (await t.one<{ s: number }>('select coalesce(sum(net_paise), 0)::float as s from payroll_slip where run_id = $1', [id])).s;
    if (Math.round(earnings + settlement - lop - pf - esi - pt - tds - loan - other) !== Math.round(net)) throw conflict('totals', 'The payslips do not add up to the run total; work the run out again.');
    const lines: JLine[] = [
      signed('5300', earnings - lop, 'debit'), signed('5320', settlement, 'debit'), signed('5310', erPf, 'debit'), signed('5311', erEsi, 'debit'),
      signed('2500', net, 'credit'), signed('2510', pf + erPf, 'credit'), signed('2511', esi + erEsi, 'credit'), signed('2520', pt, 'credit'), signed('2530', tds, 'credit'),
      signed('1500', loan, 'credit'), signed('2540', other, 'credit'),
    ];
    await post(t, { schoolId: r.school_id, narration: r.title, sourceType: 'payroll_run', sourceId: id, lines });
    await t.query(`update payroll_run set status = 'LOCKED', approved_by = $2, locked_at = now() where id = $1`, [id, actor.id]);
    const people = await t.query<{ user_id: string }>('select user_id from payroll_slip where run_id = $1', [id]);
    await notify.toUsers(t, people.map((p) => p.user_id), { kind: 'PAY', title: `Payslip: ${r.title}`, body: 'Your payslip is ready in the app, with how every figure was worked out.', link: '/my/pay' });
    return { status: 'LOCKED', net };
  }, { actor: actor.label });
}

/** The bank has paid the salaries: the bank's reference is recorded and salaries payable are cleared. */
export async function markPaid(db: Db, actor: Actor, id: string, bankRef: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  if (r.status !== 'LOCKED') throw conflict('state', 'Only a locked run is paid.');
  if (bankRef.trim().length < 4) throw invalid('Give the bank’s reference for the payment.');
  return db.tx(async (t) => {
    await t.query(`update payroll_run set status = 'PAID', paid_at = now(), bank_ref = $2 where id = $1`, [id, bankRef.trim()]);
    await post(t, { schoolId: r.school_id, narration: `${r.title}: paid (${bankRef.trim()})`, sourceType: 'payroll_paid', sourceId: id,
      lines: [signed('2500', r.totals.net, 'debit'), signed('1100', r.totals.net, 'credit')] });
    return { status: 'PAID' };
  }, { actor: actor.label });
}

export async function runs(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'pay.view', schoolId);
  return db.query(
    `select r.id, r.month::text, r.kind, r.status, r.title, r.totals, jsonb_array_length(r.issues) as issue_count, p.name as prepared_by, a.name as approved_by, r.locked_at, r.paid_at, r.bank_ref, f.name as for_name
       from payroll_run r join app_user p on p.id = r.prepared_by left join app_user a on a.id = r.approved_by left join app_user f on f.id = r.for_user
      where r.school_id = $1 order by r.month desc, r.created_at desc`, [schoolId]);
}

export async function run(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.view', r.school_id);
  const slips = await db.query(
    `select s.user_id, u.name, u.designation, e.nes_staff_id, e.employment, s.days_in_month, s.paid_days::float, s.lop_days::float, s.gross_paise::float as gross, s.deduction_paise::float as deductions,
            s.net_paise::float as net, s.employer_paise::float as employer, b.account_last4, b.ifsc
       from payroll_slip s join app_user u on u.id = s.user_id join employee e on e.user_id = s.user_id left join employee_bank b on b.id = s.bank_id where s.run_id = $1 order by u.name`, [id]);
  const lines = await db.query(`select user_id, code, name, kind, amount_paise::float as amount, basis, for_month::text from payroll_line where run_id = $1 order by user_id, kind, id`, [id]);
  const p = await db.one<{ prepared: string; approved: string | null; locked_at: string | null; paid_at: string | null; bank_ref: string | null }>(
    `select p.name as prepared, a.name as approved, r.locked_at, r.paid_at, r.bank_ref from payroll_run r join app_user p on p.id = r.prepared_by left join app_user a on a.id = r.approved_by where r.id = $1`, [id]);
  return { ...r, ...p, slips: (slips as { user_id: string }[]).map((s) => ({ ...s, lines: (lines as { user_id: string }[]).filter((l) => l.user_id === s.user_id) })), canApprove: actor.id !== r.prepared_by && await can(db, actor, 'pay.approve', r.school_id) };
}

// ── Arrears and final settlement ───────────────────────────────────────────────────────────

/**
 * Arrears after a back-dated change (a DA rise from July ordered in October, a late increment):
 * each locked month from `fromMonth` is worked out again under today's rules and compared with
 * what was paid for it, line by line; the differences are paid (or recovered) in one supplementary run.
 */
export async function arrears(db: Db, actor: Actor, schoolId: string, fromMonth: string) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  const thisMonth = localToday().slice(0, 8) + '01';
  const months = (await db.query<{ month: string }>(`select distinct month::text from payroll_run where school_id = $1 and kind = 'REGULAR' and status in ('LOCKED', 'PAID') and month >= $2 and month < $3 order by 1`, [schoolId, fromMonth, thisMonth])).map((m) => m.month);
  if (!months.length) throw invalid('No locked months from that date to recompute.');
  return db.tx(async (t) => {
    const run = await t.one<{ id: string }>(`insert into payroll_run (school_id, month, kind, title, prepared_by) values ($1, $2, 'SUPPLEMENTARY', $3, $4) returning id`,
      [schoolId, thisMonth, `Arrears from ${monthName(months[0])}`, actor.id]);
    const perPerson = new Map<string, PayLine[]>();
    for (const m of months) {
      const ctx = await ctxFor(t, schoolId, m, 'SUPPLEMENTARY');
      const people = await t.query<{ user_id: string }>(`select distinct s.user_id from payroll_slip s join payroll_run r on r.id = s.run_id where r.school_id = $1 and r.month = $2 and r.kind = 'REGULAR' and r.status in ('LOCKED', 'PAID')`, [schoolId, m]);
      for (const p of people) {
        const should = (await compute(t, ctx, p.user_id, { withTax: false })).lines.filter((l) => !['TDS', 'LOAN', 'PT'].includes(l.code));
        const paid = await t.query<{ code: string; name: string; kind: PayLine['kind']; taxable: boolean; amount: number }>(
          `select l.code, max(l.name) as name, max(l.kind) as kind, bool_or(l.taxable) as taxable, sum(l.amount_paise)::float as amount from payroll_line l join payroll_run r on r.id = l.run_id
            where l.user_id = $1 and r.school_id = $2 and r.status in ('LOCKED', 'PAID') and coalesce(l.for_month, r.month) = $3 and l.code not in ('TDS', 'LOAN', 'PT') group by l.code`, [p.user_id, schoolId, m]);
        const codes = new Set([...should.map((l) => l.code), ...paid.map((l) => l.code)]);
        for (const code of codes) {
          const s = should.find((l) => l.code === code), q = paid.find((l) => l.code === code);
          const diff = Math.round((s?.amount ?? 0) - (q?.amount ?? 0));
          if (Math.abs(diff) < 100) continue;                                     // under a rupee: nothing to pay
          const ref = s ?? { code, name: q!.name, kind: q!.kind, taxable: q!.taxable };
          const list = perPerson.get(p.user_id) ?? [];
          list.push({ code: ref.code, name: `${ref.name} (${monthName(m)})`, kind: ref.kind, taxable: ref.taxable, amount: diff, basis: `Due ${rs(s?.amount ?? 0)}, paid ${rs(q?.amount ?? 0)}`, forMonth: m });
          perPerson.set(p.user_id, list);
        }
      }
    }
    const cooling = await settings.get<number>(t, schoolId, 'payroll.bank_cooling_days');
    for (const [userId, lines] of perPerson) {
      const earn = lines.filter((l) => l.kind === 'EARNING').reduce((s, l) => s + l.amount, 0) - lines.filter((l) => l.code === 'LOP').reduce((s, l) => s + l.amount, 0);
      const ded = lines.filter((l) => l.kind === 'DEDUCTION' && l.code !== 'LOP').reduce((s, l) => s + l.amount, 0);
      const emp = lines.filter((l) => l.kind === 'EMPLOYER').reduce((s, l) => s + l.amount, 0);
      const bank = await staff.bankFor(t, userId, localToday(), cooling);
      await writePerson(t, run.id, userId, { lines, slip: { daysInMonth: 0, paidDays: 0, lopDays: 0, gross: earn, deductions: ded, net: earn - ded, employer: emp }, issues: [] }, bank?.id ?? null);
    }
    const totals = await t.one(`select count(*)::int as people, coalesce(sum(gross_paise), 0)::float as gross, coalesce(sum(deduction_paise), 0)::float as deductions, coalesce(sum(net_paise), 0)::float as net, coalesce(sum(employer_paise), 0)::float as employer from payroll_slip where run_id = $1`, [run.id]);
    await t.query('update payroll_run set totals = $2 where id = $1', [run.id, JSON.stringify(totals)]);
    return { id: run.id, months, totals };
  }, { actor: actor.label });
}

/**
 * Final settlement for someone who has left: pay to the last day (if that month is not already
 * paid), gratuity after five years' service, earned leave encashed, and loans recovered in full.
 */
export async function finalSettlement(db: Db, actor: Actor, userId: string) {
  const e = await db.maybeOne<{ school_id: string; separated: string | null; joined: string; name: string }>(
    `select e.school_id, e.separated_on::text as separated, e.joined_service::text as joined, u.name from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  if (!e) throw notFound('Staff member');
  await assertCan(db, actor, 'pay.prepare', e.school_id);
  if (!e.separated) throw invalid('Record in the service book that the person has left first.');
  const month = e.separated.slice(0, 8) + '01';
  if (await db.maybeOne(`select 1 from payroll_run where kind = 'FINAL' and for_user = $1`, [userId])) throw conflict('exists', 'A final settlement already exists for this person.');
  return db.tx(async (t) => {
    const paidMonth = await t.maybeOne(`select 1 from payroll_slip s join payroll_run r on r.id = s.run_id where s.user_id = $1 and r.month = $2 and r.kind = 'REGULAR' and r.status in ('LOCKED', 'PAID')`, [userId, month]);
    const run = await t.one<{ id: string }>(`insert into payroll_run (school_id, month, kind, for_user, title, prepared_by) values ($1, $2, 'FINAL', $3, $4, $5) returning id`,
      [e.school_id, month, userId, `Final settlement: ${e.name}`, actor.id]);
    const ctx = await ctxFor(t, e.school_id, month, 'FINAL', e.separated!);
    const r = paidMonth ? { lines: [] as PayLine[], slip: null, issues: [] as Issue[] } : await compute(t, ctx, userId);
    const lines = [...r.lines];
    // Wages for gratuity and encashment: last basic + DA (the components that count as PF wages), for a full month.
    const last = await compute(t, { ...ctx, kind: 'SUPPLEMENTARY', lastDay: undefined }, userId, { withTax: false, fullMonth: true });
    const wages = last.lines.filter((l) => l.kind === 'EARNING' && l.pfWage).reduce((s, l) => s + l.amount, 0);
    const months = (Number(e.separated!.slice(0, 4)) - Number(e.joined.slice(0, 4))) * 12 + Number(e.separated!.slice(5, 7)) - Number(e.joined.slice(5, 7));
    const years = Math.floor(months / 12) + (months % 12 >= 6 ? 1 : 0);
    if (years >= ctx.rate('GRATUITY_MIN_YEARS', e.separated!) && wages > 0) {
      const g = Math.min(Math.round((wages * 15 * years) / 26), ctx.rate('GRATUITY_CEILING', e.separated!));
      lines.push({ code: 'GRATUITY', name: 'Gratuity', kind: 'EARNING', taxable: false, amount: g, basis: `${rs(wages)} × 15/26 × ${years} years of service` });
    }
    const el = (await staffLeave.balances(t, userId)).find((b) => b.code === 'EL')?.balance ?? 0;
    const elDays = Math.min(el, ctx.rate('EL_ENCASH_MAX_DAYS', e.separated!));
    if (elDays > 0 && wages > 0) lines.push({ code: 'LEAVE_ENCASH', name: 'Earned leave encashed', kind: 'EARNING', taxable: false, amount: Math.round((wages * elDays) / 30), basis: `${elDays} days × ${rs(wages)} ÷ 30` });
    if (paidMonth) {
      const loans = await t.query<{ id: string; kind: string; left: number }>(
        `select l.id, l.kind, (l.principal_paise - coalesce((select sum(pl.amount_paise) from payroll_line pl join payroll_run x on x.id = pl.run_id where pl.loan_id = l.id and x.status in ('LOCKED', 'PAID')), 0))::float as left
           from staff_loan l where l.user_id = $1 and l.status = 'SANCTIONED'`, [userId]);
      for (const l of loans) if (l.left > 0) lines.push({ code: 'LOAN', name: `Recovery: ${l.kind.toLowerCase().replace('_', ' ')}`, kind: 'DEDUCTION', taxable: false, amount: l.left, basis: 'Whole balance', loanId: l.id });
    }
    const gross = lines.filter((l) => l.kind === 'EARNING').reduce((s, l) => s + l.amount, 0) - lines.filter((l) => l.code === 'LOP').reduce((s, l) => s + l.amount, 0);
    const ded = lines.filter((l) => l.kind === 'DEDUCTION' && l.code !== 'LOP').reduce((s, l) => s + l.amount, 0);
    const emp = lines.filter((l) => l.kind === 'EMPLOYER').reduce((s, l) => s + l.amount, 0);
    const bank = await staff.bankFor(t, userId, localToday(), 0);
    const issues = [...r.issues];
    if (gross - ded < 0) issues.push({ level: 'ERROR', userId, name: e.name, message: `Recoveries are more than what is due by ${rs(ded - gross)}; collect the rest separately.` });
    if (!bank) issues.push({ level: 'ERROR', userId, name: e.name, message: 'No verified bank account.' });
    await writePerson(t, run.id, userId, { lines, slip: { daysInMonth: r.slip?.daysInMonth ?? 0, paidDays: r.slip?.paidDays ?? 0, lopDays: r.slip?.lopDays ?? 0, gross, deductions: ded, net: gross - ded, employer: emp }, issues }, bank?.id ?? null);
    const totals = { people: 1, gross, deductions: ded, net: gross - ded, employer: emp };
    await t.query('update payroll_run set totals = $2, issues = $3 where id = $1', [run.id, JSON.stringify(totals), JSON.stringify(issues)]);
    return { id: run.id, totals, issues };
  }, { actor: actor.label });
}

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────

/** The month's inputs: periods taught by guest teachers, hours, days worked. */
export async function setInputs(db: Db, actor: Actor, schoolId: string, month: string, entries: { userId: string; unit: 'PERIODS' | 'HOURS' | 'DAYS_PRESENT'; quantity: number; note?: string }[]) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  if (await db.maybeOne(`select 1 from payroll_run where school_id = $1 and month = $2 and kind = 'REGULAR' and status <> 'DRAFT'`, [schoolId, month])) throw conflict('locked', 'The month’s payroll is past draft; inputs can no longer change.');
  await db.tx(async (t) => {
    for (const e of entries) await t.query(
      `insert into payroll_input (school_id, month, user_id, unit, quantity, note, entered_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (school_id, month, user_id, unit) do update set quantity = excluded.quantity, note = excluded.note, entered_by = excluded.entered_by, entered_at = now()`,
      [schoolId, month, e.userId, e.unit, e.quantity, e.note ?? '', actor.id]);
  }, { actor: actor.label });
  return { saved: entries.length };
}

/** Who needs inputs this month: people on structures with per-period, per-hour or per-day pay. */
export async function inputsNeeded(db: Db, actor: Actor, schoolId: string, month: string) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  return db.query(
    `select distinct u.id as user_id, u.name, c.unit, c.name as component, c.amount_paise::float as rate,
            (select quantity::float from payroll_input i where i.school_id = $1 and i.month = $2 and i.user_id = u.id and i.unit = c.unit) as quantity
       from employee e join app_user u on u.id = e.user_id join employee_pay ep on ep.user_id = e.user_id and ep.valid @> $2::date
       join pay_structure_component c on c.structure_id = ep.structure_id and c.calc = 'PER_UNIT' and c.status = 'APPROVED' and c.valid @> $2::date
      where e.school_id = $1 and e.separated_on is null order by u.name`, [schoolId, month]);
}

// ── Files for the bank and the statutory returns ───────────────────────────────────────────

/** The bank's bulk payment file (beneficiary, account, IFSC, amount). Account numbers are decrypted only here, and the download is recorded. */
export async function bankFile(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  if (!['LOCKED', 'PAID'].includes(r.status)) throw conflict('state', 'The bank file is made from an approved (locked) run.');
  const rows = await db.query<{ user_id: string; holder_name: string; account_cipher: string; ifsc: string; net: number; nes_staff_id: string }>(
    `select s.user_id, b.holder_name, b.account_cipher, b.ifsc, s.net_paise::float as net, e.nes_staff_id from payroll_slip s join employee_bank b on b.id = s.bank_id join employee e on e.user_id = s.user_id
      where s.run_id = $1 and s.net_paise > 0 order by b.holder_name`, [id]);
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const total = rows.reduce((s, x) => s + x.net, 0);
  if (Math.round(total) !== Math.round(r.totals.net)) throw conflict('totals', 'The bank file does not match the run total; someone has no bank account.');
  const csv = ['Sl,Beneficiary name,Account number,IFSC,Amount (Rs),Narration',
    ...rows.map((x, i) => [String(i + 1), cell(x.holder_name), unseal(x.account_cipher), x.ifsc, (x.net / 100).toFixed(2), cell(`${r.title} ${x.nes_staff_id}`)].join(',')),
    `,,,Total,${(total / 100).toFixed(2)},${rows.length} payments`].join('\r\n') + '\r\n';
  const sha = createHash('sha256').update(csv).digest('hex');
  await db.tx(async (t) => {
    await t.query('update payroll_run set bank_file_sha = $2 where id = $1', [id, sha]);
    for (const x of rows) await t.query('insert into pii_view (user_id, field, viewed_by, purpose) values ($1, $2, $3, $4)', [x.user_id, 'BANK_ACCOUNT', actor.id, `Bank file: ${r.title}`]);
  }, { actor: actor.label });
  return { csv, sha, count: rows.length, total };
}

/** EPFO electronic challan-cum-return (ECR) text for a locked run. */
export async function pfEcr(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.prepare', r.school_id);
  const rows = await db.query<{ uan: string | null; name: string; gross: number; pf_wages: number; pf: number; eps: number; er: number; lop: number }>(
    `select e.uan, u.name, s.gross_paise::float as gross,
            coalesce((select (l.inputs->>'base')::float from payroll_line l where l.run_id = s.run_id and l.user_id = s.user_id and l.code = 'PF'), 0) as pf_wages,
            coalesce((select sum(amount_paise) from payroll_line l where l.run_id = s.run_id and l.user_id = s.user_id and l.code = 'PF'), 0)::float as pf,
            coalesce((select sum(amount_paise) from payroll_line l where l.run_id = s.run_id and l.user_id = s.user_id and l.code = 'ER_EPS'), 0)::float as eps,
            coalesce((select sum(amount_paise) from payroll_line l where l.run_id = s.run_id and l.user_id = s.user_id and l.code = 'ER_EPF'), 0)::float as er,
            s.lop_days::float as lop
       from payroll_slip s join employee e on e.user_id = s.user_id join app_user u on u.id = s.user_id where s.run_id = $1 order by u.name`, [id]);
  const pfRows = rows.filter((x) => x.pf > 0);
  const missing = pfRows.filter((x) => !x.uan).map((x) => x.name);
  const ru = (p: number) => String(Math.round(p / 100));
  const text = pfRows.map((x) => [x.uan ?? '', x.name.toUpperCase(), ru(x.gross), ru(x.pf_wages), ru(Math.min(x.pf_wages, 1500000)), ru(x.pf_wages), ru(x.pf), ru(x.eps), ru(x.er), String(Math.round(x.lop)), '0'].join('#~#')).join('\n');
  return { text, members: pfRows.length, missingUan: missing };
}

/** Statutory summary for a run: PF, ESI, professional tax and TDS by person, for the challans. */
export async function statutorySummary(db: Db, actor: Actor, id: string) {
  const r = await loadRun(db, id);
  await assertCan(db, actor, 'pay.view', r.school_id);
  const rows = await db.query(
    `select u.name, e.uan, e.esi_no, e.pan_last4, s.gross_paise::float as gross,
            ${['PF', 'ER_EPF', 'ER_EPS', 'ER_EDLI', 'ER_PF_ADMIN', 'ESI', 'ER_ESI', 'PT', 'TDS'].map((c) => `coalesce((select sum(amount_paise) from payroll_line l where l.run_id = s.run_id and l.user_id = s.user_id and l.code = '${c}'), 0)::float as "${c}"`).join(', ')}
       from payroll_slip s join employee e on e.user_id = s.user_id join app_user u on u.id = s.user_id where s.run_id = $1 order by u.name`, [id]);
  const totals: Record<string, number> = {};
  for (const x of rows as Record<string, number>[]) for (const k of ['PF', 'ER_EPF', 'ER_EPS', 'ER_EDLI', 'ER_PF_ADMIN', 'ESI', 'ER_ESI', 'PT', 'TDS']) totals[k] = (totals[k] ?? 0) + Number(x[k]);
  const challans = await db.query(`select kind, period::text, amount_paise::float as amount, reference, paid_on::text from statutory_challan where school_id = $1 and period = $2`, [r.school_id, r.month]);
  return { rows, totals, challans };
}

/** Records a statutory payment (PF, ESI, professional tax, TDS) and clears the payable. */
export async function recordChallan(db: Db, actor: Actor, schoolId: string, input: { kind: 'PF' | 'ESI' | 'PT' | 'TDS'; period: string; amountPaise: number; reference: string; paidOn: string }) {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  const account = { PF: '2510', ESI: '2511', PT: '2520', TDS: '2530' }[input.kind];
  return db.tx(async (t) => {
    const c = await t.one<{ id: string }>(`insert into statutory_challan (school_id, kind, period, amount_paise, reference, paid_on, recorded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [schoolId, input.kind, input.period, input.amountPaise, input.reference.trim(), input.paidOn, actor.id]);
    await post(t, { schoolId, narration: `${input.kind} for ${monthName(input.period)} (${input.reference.trim()})`, sourceType: 'statutory_challan', sourceId: c.id,
      lines: [signed(account, input.amountPaise, 'debit'), signed('1100', input.amountPaise, 'credit')] });
    return { id: c.id };
  }, { actor: actor.label });
}

// ── The staff app: my pay ──────────────────────────────────────────────────────────────────

export async function myPay(db: Db, actor: Actor) {
  const e = await db.maybeOne<{ school_id: string; nes_staff_id: string }>('select school_id, nes_staff_id from employee where user_id = $1', [actor.id]);
  if (!e) throw notFound('Staff record');
  const slips = await db.query(
    `select r.id as run_id, r.title, r.month::text, r.kind, r.status, s.gross_paise::float as gross, s.deduction_paise::float as deductions, s.net_paise::float as net, s.paid_days::float, s.lop_days::float, r.locked_at
       from payroll_slip s join payroll_run r on r.id = s.run_id where s.user_id = $1 and r.status in ('LOCKED', 'PAID') order by r.month desc, r.locked_at desc`, [actor.id]);
  const fy = fyOf(localToday());
  const ytd = await db.one<{ gross: number; tds: number; pf: number }>(
    `select coalesce(sum(case when l.kind = 'EARNING' then l.amount_paise when l.code = 'LOP' then -l.amount_paise else 0 end), 0)::float as gross,
            coalesce(sum(case when l.code = 'TDS' then l.amount_paise else 0 end), 0)::float as tds, coalesce(sum(case when l.code = 'PF' then l.amount_paise else 0 end), 0)::float as pf
       from payroll_line l join payroll_run r on r.id = l.run_id where l.user_id = $1 and r.status in ('LOCKED', 'PAID') and coalesce(l.for_month, r.month) between $2 and $3`, [actor.id, fy.start, fy.end]);
  const decl = await db.maybeOne('select regime, items from tax_declaration where user_id = $1 and fy = $2', [actor.id, fy.code]);
  const bank = await db.query(`select account_last4, ifsc, bank_name, status, requested_at, verified_at from employee_bank where user_id = $1 order by requested_at desc limit 3`, [actor.id]);
  return { nesStaffId: e.nes_staff_id, fy: fy.code, slips, ytd, declaration: decl ?? { regime: 'NEW', items: {} }, bank };
}

export async function setDeclaration(db: Db, actor: Actor, input: { regime: 'NEW' | 'OLD'; items?: Record<string, number> }) {
  if (!(await db.maybeOne('select 1 from employee where user_id = $1', [actor.id]))) throw notFound('Staff record');
  const fy = fyOf(localToday());
  const items = Object.fromEntries(Object.entries(input.items ?? {}).filter(([k, v]) => ['80C', '80D', 'HRA_EXEMPT', 'OTHER'].includes(k) && Number.isFinite(v) && v >= 0).map(([k, v]) => [k, Math.round(v)]));
  await db.tx((t) => t.query(`insert into tax_declaration (user_id, fy, regime, items) values ($1, $2, $3, $4)
    on conflict (user_id, fy) do update set regime = excluded.regime, items = excluded.items, updated_at = now()`, [actor.id, fy.code, input.regime, JSON.stringify(items)]), { actor: actor.label });
  return { fy: fy.code, regime: input.regime };
}

/** One payslip: the person themself (once locked) or those who handle pay at the school. */
export async function slip(db: Db, actor: Actor, runId: string, userId: string) {
  const r = await loadRun(db, runId);
  if (actor.id !== userId) await assertCan(db, actor, 'pay.view', r.school_id);
  else if (!['LOCKED', 'PAID'].includes(r.status)) throw forbidden('Your payslip is shown once the payroll is approved.');
  const s = await db.maybeOne(
    `select s.*, s.gross_paise::float as gross, s.deduction_paise::float as deductions, s.net_paise::float as net, s.paid_days::float as paid_days, s.lop_days::float as lop_days,
            u.name, u.designation, e.nes_staff_id, e.employment, e.pan_last4, e.uan, b.account_last4, b.bank_name, b.ifsc, o.name as school
       from payroll_slip s join app_user u on u.id = s.user_id join employee e on e.user_id = s.user_id join org_unit o on o.id = $3
       left join employee_bank b on b.id = s.bank_id where s.run_id = $1 and s.user_id = $2`, [runId, userId, r.school_id]);
  if (!s) throw notFound('Payslip');
  const lines = await db.query(`select code, name, kind, amount_paise::float as amount, basis, for_month::text from payroll_line where run_id = $1 and user_id = $2 order by kind, id`, [runId, userId]);
  return { run: { id: r.id, title: r.title, month: r.month, kind: r.kind, status: r.status }, slip: s, lines };
}

// ── NES and the Commands: the picture across schools ───────────────────────────────────────

export async function overview(db: Db, actor: Actor) {
  await assertCan(db, actor, 'pay.overview');
  return db.query(
    `select o.id as school_id, o.name as school,
            (select count(*) from employee e where e.school_id = o.id and e.separated_on is null)::int as staff,
            (select jsonb_object_agg(employment, n) from (select employment, count(*)::int as n from employee e where e.school_id = o.id and e.separated_on is null group by employment) x) as by_employment,
            (select count(*) from post p where p.school_id = o.id and p.sanctioned @> current_date)::int as posts,
            (select count(*) from post p where p.school_id = o.id and p.sanctioned @> current_date and not exists (select 1 from appointment a where a.post_id = p.id and a.valid @> current_date))::int as vacant,
            (select jsonb_build_object('month', r.month, 'status', r.status, 'net', r.totals->'net', 'gross', r.totals->'gross', 'employer', r.totals->'employer', 'people', r.totals->'people')
               from payroll_run r where r.school_id = o.id and r.kind = 'REGULAR' order by r.month desc limit 1) as last_run,
            (select coalesce(sum(l.debit_paise - l.credit_paise), 0) from journal_line l join journal j on j.id = l.journal_id where j.school_id = o.id and l.account_code like '53%' and j.posted_on >= (date_trunc('year', current_date - interval '3 month') + interval '3 month')::date)::float as salary_cost_fy,
            (select coalesce(sum(l.credit_paise - l.debit_paise), 0) from journal_line l join journal j on j.id = l.journal_id where j.school_id = o.id and l.account_code like '41%' and j.posted_on >= (date_trunc('year', current_date - interval '3 month') + interval '3 month')::date)::float as fee_income_fy
       from org_unit o where o.kind = 'school' and o.active and o.path <@ $1::ltree order by o.name`, [actor.scopePath]);
}

// ── The year's tax: Form 16 and the quarterly TDS return ───────────────────────────────────

const QUARTERS = [['Q1', 4, 6], ['Q2', 7, 9], ['Q3', 10, 12], ['Q4', 1, 3]] as const;
const fyMonths = (fy: string) => { const y = Number(fy.slice(0, 4)); return { start: `${y}-04-01`, end: `${y + 1}-03-31` }; };
const quarterOf = (month: string) => QUARTERS.find(([, a, b]) => Number(month.slice(5, 7)) >= a && Number(month.slice(5, 7)) <= b)![0];

/**
 * The year's salary and tax for one person, from the locked payrolls only: every rupee paid and
 * deducted, by component and by quarter, and the tax worked out under their regime. This is Part B
 * of Form 16 (Part A, the TDS certificate, is downloaded from TRACES with the same figures).
 */
export async function annualTax(db: Db, actor: Actor, userId: string, fy: string) {
  const e = await db.maybeOne<{ school_id: string; name: string; nes_staff_id: string; pan_last4: string | null; designation: string | null }>(
    `select e.school_id, u.name, e.nes_staff_id, e.pan_last4, u.designation from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  if (!e) throw notFound('Staff member');
  if (actor.id !== userId) await assertCan(db, actor, 'pay.view', e.school_id);
  if (!/^\d{4}-\d{2}$/.test(fy)) throw invalid('Choose a financial year, like 2026-27.');
  const { start, end } = fyMonths(fy);
  const lines = await db.query<{ code: string; name: string; kind: string; taxable: boolean; amount: number; month: string }>(
    `select l.code, l.name, l.kind, l.taxable, l.amount_paise::float as amount, r.month::text as month from payroll_line l join payroll_run r on r.id = l.run_id
      where l.user_id = $1 and r.status in ('LOCKED', 'PAID') and r.month between $2 and $3`, [userId, start, end]);
  const by = (f: (l: (typeof lines)[number]) => boolean) => lines.filter(f).reduce((s, l) => s + l.amount, 0);
  const comps = [...new Map(lines.filter((l) => l.kind === 'EARNING').map((l) => [l.code, l.name.replace(/ \(.*\)$/, '')])).entries()]
    .map(([code, name]) => ({ code, name, amount: by((l) => l.kind === 'EARNING' && l.code === code), taxable: lines.find((l) => l.code === code)!.taxable }));
  const lop = by((l) => l.code === 'LOP');
  const gross = comps.reduce((s, c) => s + c.amount, 0) - lop;
  const exempt = comps.filter((c) => !c.taxable).reduce((s, c) => s + c.amount, 0);
  const decl = await db.maybeOne<{ regime: 'NEW' | 'OLD'; items: Record<string, number> }>('select regime, items from tax_declaration where user_id = $1 and fy = $2', [userId, fy]);
  const regime = decl?.regime ?? 'NEW';
  const rate = await statutory(db);
  const std = Math.min(rate(regime === 'NEW' ? 'STD_DED_NEW' : 'STD_DED_OLD', end), Math.max(0, gross - exempt));
  const pt = by((l) => l.code === 'PT');
  const it = decl?.items ?? {};
  const chapterVIA = regime === 'OLD' ? Math.min(Number(it['80C'] ?? 0), 15000000) + Math.min(Number(it['80D'] ?? 0), 5000000) + Number(it.OTHER ?? 0) : 0;
  const hra = regime === 'OLD' ? Math.min(Number(it.HRA_EXEMPT ?? 0), by((l) => l.code === 'HRA')) : 0;
  const taxableIncome = Math.max(0, gross - exempt - hra - std - (regime === 'OLD' ? pt : 0) - chapterVIA);
  const tax = await taxOn(db, regime, taxableIncome, end, rate);
  const quarters = QUARTERS.map(([q]) => ({ quarter: q, paid: by((l) => quarterOf(l.month) === q && l.kind === 'EARNING') - by((l) => quarterOf(l.month) === q && l.code === 'LOP'), tds: by((l) => quarterOf(l.month) === q && l.code === 'TDS') }));
  const tds = quarters.reduce((s, q) => s + q.tds, 0);
  return { person: { ...e, userId }, fy, regime, components: comps, lossOfPay: lop, gross, exempt, hraExempt: hra, standardDeduction: std, professionalTax: pt, chapterVIA, taxableIncome, tax, tdsDeducted: tds, balance: tax - tds, quarters,
    pf: by((l) => l.code === 'PF') };
}

/** Form 16 Part B as a PDF, for the person (in the staff app) or the office. */
export async function form16Pdf(db: Db, actor: Actor, userId: string, fy: string) {
  const a = await annualTax(db, actor, userId, fy);
  const h = await printing.schoolHeader(db, a.person.school_id);
  const tan = (await db.one<{ tan: string | null }>('select tan from org_unit where id = $1', [a.person.school_id])).tan;
  let pan = a.person.pan_last4 ? `XXXXXX${a.person.pan_last4}` : 'Not given';
  const cipher = (await db.one<{ c: string | null }>('select pan_cipher as c from employee where user_id = $1', [userId])).c;
  if (cipher) {
    pan = unseal(cipher);
    if (actor.id !== userId) await db.tx((t) => t.query('insert into pii_view (user_id, field, viewed_by, purpose) values ($1, $2, $3, $4)', [userId, 'PAN', actor.id, `Form 16 ${fy}`]), { actor: actor.label });
  }
  const doc = await newDocument(`Form 16 Part B · ${a.person.name} · ${fy}`);
  const raw = await printing.assets(db, a.person.school_id);
  const logo = await embedImage(doc.doc, raw.LOGO?.data, raw.LOGO?.type);
  const s = new Sheet(doc.doc, 210, 297, doc.fonts);
  const f = doc.fonts, L = 15, W = 180;
  if (logo) s.image(logo, L, 10, 16, 16);
  s.text(h.name, L + 20, 11, { size: 13, font: f.serifBold, colour: NAVY, maxWidth: W - 20 });
  s.text(h.address ?? '', L + 20, 17.5, { size: 8, colour: GREY, maxWidth: W - 20 });
  s.text(`TAN ${tan ?? 'not recorded (add it in Settings → School details)'}`, L + 20, 21.5, { size: 8, colour: GREY });
  s.rect(L, 29, W, 0.6, { fill: NAVY });
  s.text('FORM No. 16 · PART B', L, 33, { size: 11.5, font: f.bold, colour: NAVY, maxWidth: W, align: 'centre' });
  s.text(`Details of salary paid and tax deducted · Financial year ${fy} (assessment year ${Number(fy.slice(0, 4)) + 1}-${String((Number(fy.slice(0, 4)) + 2) % 100).padStart(2, '0')}) · ${a.regime === 'NEW' ? 'New' : 'Old'} tax regime`, L, 38.5, { size: 8, colour: GREY, maxWidth: W, align: 'centre' });
  let y = 46;
  [['Employee', a.person.name], ['PAN', pan], ['Designation', a.person.designation ?? '—'], ['NES staff ID', a.person.nes_staff_id]].forEach(([k, v], i) => {
    s.text(k, L + (i % 2) * 90, y + Math.floor(i / 2) * 8, { size: 7, colour: GREY }); s.text(v, L + (i % 2) * 90, y + 3 + Math.floor(i / 2) * 8, { size: 9.5, font: i === 0 ? f.bold : f.regular, maxWidth: 86 });
  });
  y += 20;
  const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label: string, v: number | null, o: { bold?: boolean; indent?: boolean } = {}) => {
    s.text(label, L + (o.indent ? 6 : 0), y, { size: 8.8, font: o.bold ? f.bold : f.regular, maxWidth: 130 });
    if (v !== null) s.text(amt(v), L + W - 40, y, { size: 8.8, font: o.bold ? f.bold : f.regular, maxWidth: 40, align: 'right' });
    y += 5.2;
  };
  row('1. Gross salary', null, { bold: true });
  for (const c of a.components) row(`${c.name}${c.taxable ? '' : ' (exempt)'}`, c.amount, { indent: true });
  if (a.lossOfPay) row('Less: loss of pay', -a.lossOfPay, { indent: true });
  row('Total', a.gross, { bold: true });
  row('2. Allowances exempt under section 10', a.exempt + a.hraExempt);
  row('3. Standard deduction under section 16(ia)', a.standardDeduction);
  if (a.regime === 'OLD') { row('4. Professional tax under section 16(iii)', a.professionalTax); row('5. Deductions under Chapter VI-A (80C, 80D and others)', a.chapterVIA); }
  row('6. Total taxable income', a.taxableIncome, { bold: true });
  row('7. Tax on total income (after rebate under section 87A), with health and education cess', a.tax, { bold: true });
  row('8. Tax deducted at source by the school', a.tdsDeducted);
  row(a.balance >= 0 ? '9. Tax still payable by the employee' : '9. Tax deducted in excess (refund through the return)', Math.abs(a.balance), { bold: true });
  y += 4;
  s.text('Tax deducted by quarter', L, y, { size: 9, font: f.bold, colour: NAVY }); y += 5;
  for (const q of a.quarters) { s.text(`${q.quarter}  ·  salary paid ${amt(q.paid)}`, L, y, { size: 8.5 }); s.text(amt(q.tds), L + W - 40, y, { size: 8.5, maxWidth: 40, align: 'right' }); y += 4.8; }
  y += 6;
  s.paragraph('Worked out from the school’s approved and locked payrolls in NavShiksha. Part A of Form 16 (the certificate of tax deducted and deposited) is downloaded by the school from TRACES and carries the same totals. Provident fund contributed by the employee this year: Rs. ' + amt(a.pf) + '.', L, y, W, { size: 7.5, colour: GREY });
  s.line(L + W - 60, 270, L + W, 270, { width: 0.3 });
  s.text('Principal (person responsible for paying salary)', L + W - 70, 272, { size: 7.5, maxWidth: 70, align: 'right' });
  return Buffer.from(await doc.doc.save());
}

/**
 * The quarterly TDS return on salaries (Form 24Q), as data for the return preparation utility:
 * the challans paid, and every payment of salary with the tax deducted from it. In the last
 * quarter, each person's year (Annexure II) as well. Full PANs are decrypted only here, and recorded.
 */
export async function tdsReturn(db: Db, actor: Actor, schoolId: string, fy: string, quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4') {
  await assertCan(db, actor, 'pay.prepare', schoolId);
  const y = Number(fy.slice(0, 4)), [, a, b] = QUARTERS.find(([q]) => q === quarter)!;
  const yr = quarter === 'Q4' ? y + 1 : y;
  const from = `${yr}-${String(a).padStart(2, '0')}-01`, to = `${yr}-${String(b).padStart(2, '0')}-01`;
  const tan = (await db.one<{ tan: string | null }>('select tan from org_unit where id = $1', [schoolId])).tan;
  const challans = await db.query<{ period: string; amount: number; reference: string; paid_on: string }>(
    `select period::text, amount_paise::float as amount, reference, paid_on::text from statutory_challan where school_id = $1 and kind = 'TDS' and period between $2 and $3 order by period`, [schoolId, from, to]);
  const rows = await db.query<{ user_id: string; name: string; pan_cipher: string | null; month: string; paid: number; tds: number; paid_on: string }>(
    `select s.user_id, u.name, e.pan_cipher, r.month::text as month, s.gross_paise::float as paid,
            coalesce((select sum(l.amount_paise) from payroll_line l where l.run_id = r.id and l.user_id = s.user_id and l.code = 'TDS'), 0)::float as tds,
            coalesce(r.paid_at, r.locked_at)::date::text as paid_on
       from payroll_slip s join payroll_run r on r.id = s.run_id join employee e on e.user_id = s.user_id join app_user u on u.id = s.user_id
      where r.school_id = $1 and r.status in ('LOCKED', 'PAID') and r.month between $2 and $3 order by r.month, u.name`, [schoolId, from, to]);
  const panOf = new Map<string, string>();
  for (const r of rows) if (!panOf.has(r.user_id)) panOf.set(r.user_id, r.pan_cipher ? unseal(r.pan_cipher) : 'PANNOTAVBL');
  await db.tx(async (t) => { for (const [id] of panOf) await t.query('insert into pii_view (user_id, field, viewed_by, purpose) values ($1, $2, $3, $4)', [id, 'PAN', actor.id, `Form 24Q ${fy} ${quarter}`]); }, { actor: actor.label });
  const r2 = (p: number) => (p / 100).toFixed(2);
  const out: string[][] = [['Form 24Q', `TAN ${tan ?? 'MISSING'}`, `FY ${fy}`, quarter], [], ['Challans'], ['Month', 'Amount (Rs)', 'Challan / reference', 'Paid on'],
    ...challans.map((c) => [c.period.slice(0, 7), r2(c.amount), c.reference, c.paid_on]), [], ['Deductee details (Annexure I)'],
    ['PAN', 'Name', 'Month', 'Amount paid (Rs)', 'Tax deducted (Rs)', 'Date of payment', 'Date of deduction', 'Section'],
    ...rows.map((r) => [panOf.get(r.user_id)!, r.name, r.month.slice(0, 7), r2(r.paid), r2(r.tds), r.paid_on, r.paid_on, '192'])];
  if (quarter === 'Q4') {
    out.push([], ['Salary details for the year (Annexure II)'], ['PAN', 'Name', 'Regime', 'Gross salary', 'Exempt', 'Standard deduction', 'Chapter VI-A', 'Taxable income', 'Tax', 'TDS deducted', 'Balance']);
    for (const [id, pan] of panOf) {
      const x = await annualTax(db, actor, id, fy);
      out.push([pan, x.person.name, x.regime, r2(x.gross), r2(x.exempt + x.hraExempt), r2(x.standardDeduction), r2(x.chapterVIA), r2(x.taxableIncome), r2(x.tax), r2(x.tdsDeducted), r2(x.balance)]);
    }
  }
  const total = rows.reduce((s, r) => s + r.tds, 0), deposited = challans.reduce((s, c) => s + c.amount, 0);
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return { csv: out.map((r) => r.map((v) => cell(String(v ?? ''))).join(',')).join('\r\n') + '\r\n', deductees: panOf.size, tdsDeducted: total, deposited, shortfall: total - deposited, tanMissing: !tan,
    panMissing: [...panOf.entries()].filter(([, p]) => p === 'PANNOTAVBL').length };
}

// ── Payslips on paper ──────────────────────────────────────────────────────────────────────

const NAVY: [number, number, number] = [0.04, 0.18, 0.35];
const GREY: [number, number, number] = [0.38, 0.4, 0.45];
const EMPLOYMENT_LABEL = staff.EMPLOYMENT;

type SlipData = Awaited<ReturnType<typeof slip>>;

/** One payslip on half an A4 sheet (two to a page when printed in bulk): earnings left, deductions right, how each was worked out below. */
function drawSlip(s: Sheet, top: number, d: SlipData, h: Awaited<ReturnType<typeof printing.schoolHeader>>, logo: Awaited<ReturnType<typeof embedImage>>, nes: Awaited<ReturnType<typeof embedImage>>) {
  const f = s.fonts, L = 15, R = 195, W = R - L;
  const x = d.slip as Record<string, string | number | null>;
  let y = top + 8;
  if (logo) s.image(logo, L, y, 14, 14);
  if (nes) s.image(nes, R - 14, y, 14, 14);
  s.text(h.name, L + 18, y, { size: 12.5, font: f.serifBold, colour: NAVY, maxWidth: W - 36, align: 'centre' });
  if (h.address) s.text(h.address, L + 18, y + 6, { size: 7.5, font: f.serif, colour: GREY, maxWidth: W - 36, align: 'centre' });
  s.text(`PAYSLIP  ·  ${d.run.title.toUpperCase()}`, L + 18, y + 10.5, { size: 9.5, font: f.bold, colour: NAVY, maxWidth: W - 36, align: 'centre' });
  y += 17;
  s.rect(L, y, W, 0.6, { fill: NAVY });
  y += 3;
  const facts: [string, string][] = [
    ['Name', String(x.name)], ['Staff ID', String(x.nes_staff_id)], ['Designation', String(x.designation ?? '—')],
    ['Employment', EMPLOYMENT_LABEL[String(x.employment)] ?? String(x.employment)], ['PAN', x.pan_last4 ? `XXXXXX${x.pan_last4}` : '—'], ['UAN', String(x.uan ?? '—')],
    ['Days paid', `${x.paid_days} of ${x.days_in_month}${Number(x.lop_days) ? ` (${x.lop_days} loss of pay)` : ''}`], ['Bank', x.account_last4 ? `${x.bank_name} ····${x.account_last4}` : '—'], ['IFSC', String(x.ifsc ?? '—')],
  ];
  facts.forEach(([k, v], i) => {
    const col = i % 3, row = Math.floor(i / 3), cx = L + col * (W / 3), cy = y + row * 7;
    s.text(k, cx, cy, { size: 6.5, colour: GREY });
    s.text(v, cx, cy + 2.8, { size: 8.5, font: k === 'Name' ? f.bold : f.regular, maxWidth: W / 3 - 3 });
  });
  y += 22;
  const half = W / 2 - 2;
  const earn = d.lines.filter((l) => l.kind === 'EARNING' || l.code === 'LOP') as { code: string; name: string; kind: string; amount: number; basis: string }[];
  const ded = d.lines.filter((l) => l.kind === 'DEDUCTION' && l.code !== 'LOP') as typeof earn;
  const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const column = (cx: number, title: string, rows: typeof earn, total: number, totalLabel: string) => {
    s.rect(cx, y, half, 6, { fill: [0.93, 0.94, 0.97] });
    s.text(title, cx + 2, y + 1.6, { size: 8, font: f.bold });
    s.text('Rs.', cx + half - 30, y + 1.6, { size: 8, font: f.bold, maxWidth: 28, align: 'right' });
    let cy = y + 8;
    for (const r of rows) {
      const neg = r.code === 'LOP';
      s.text(r.name, cx + 2, cy, { size: 8, maxWidth: half - 34 });
      s.text(`${neg ? '−' : ''}${amt(r.amount)}`.replace('−', '-'), cx + half - 30, cy, { size: 8, maxWidth: 28, align: 'right' });
      cy += 4.6;
    }
    return { end: cy, draw: (ty: number) => { s.line(cx, ty - 1, cx + half, ty - 1, { width: 0.3 }); s.text(totalLabel, cx + 2, ty + 0.5, { size: 8.5, font: f.bold }); s.text(amt(total), cx + half - 30, ty + 0.5, { size: 8.5, font: f.bold, maxWidth: 28, align: 'right' }); } };
  };
  const a = column(L, 'Earnings', earn, Number(x.gross), 'Gross pay');
  const b = column(L + half + 4, 'Deductions', ded, Number(x.deductions), 'Total deductions');
  const ty = Math.max(a.end, b.end) + 1.5;
  a.draw(ty); b.draw(ty);
  y = ty + 7;
  s.rect(L, y, W, 9, { fill: [0.9, 0.95, 0.92] });
  s.text(`Net pay  Rs. ${amt(Number(x.net))}`, L + 3, y + 1.2, { size: 10.5, font: f.bold, colour: [0.05, 0.35, 0.18] });
  s.text(rupeesInWords(Number(x.net)), L + 3, y + 5.4, { size: 7, colour: GREY, maxWidth: W - 6 });
  y += 12;
  s.text('How each figure was worked out', L, y, { size: 7.5, font: f.bold, colour: NAVY });
  y += 3.6;
  const notes = d.lines.filter((l) => (l as { basis: string }).basis) as typeof earn;
  for (const n of notes) {
    if (y > top + 140) { s.text('… the rest is in the staff app.', L, y, { size: 6.5, colour: GREY }); break; }
    s.text(`${n.name}: ${n.basis}`, L, y, { size: 6.5, colour: GREY, maxWidth: W });
    y += 3.1;
  }
  s.text(`Computer-generated payslip from NavShiksha. Approved and locked ${d.run.status === 'PAID' ? 'and paid ' : ''}by the school. No signature is required.`, L, top + 144, { size: 6, colour: GREY, maxWidth: W, align: 'centre' });
}

async function slipsDoc(db: Db, schoolId: string, title: string, slips: SlipData[]) {
  const doc = await newDocument(title);
  const raw = await printing.assets(db, schoolId);
  const h = await printing.schoolHeader(db, schoolId);
  const logo = await embedImage(doc.doc, raw.LOGO?.data, raw.LOGO?.type), nes = await embedImage(doc.doc, raw.NES?.data, raw.NES?.type);
  for (let i = 0; i < slips.length; i += 2) {
    const s = new Sheet(doc.doc, 210, 297, doc.fonts);
    drawSlip(s, 0, slips[i], h, logo, nes);
    if (slips[i + 1]) { for (let cx = 8; cx < 202; cx += 4) s.line(cx, 148.5, cx + 2, 148.5, { width: 0.15, colour: GREY }); drawSlip(s, 148.5, slips[i + 1], h, logo, nes); }
  }
  return Buffer.from(await doc.doc.save());
}

export async function slipPdf(db: Db, actor: Actor, runId: string, userId: string) {
  const d = await slip(db, actor, runId, userId);
  const r = await loadRun(db, runId);
  return slipsDoc(db, r.school_id, `Payslip · ${d.run.title}`, [d]);
}

/** Every payslip of a run, two to an A4 sheet, for the office file. */
export async function slipsPdf(db: Db, actor: Actor, runId: string) {
  const r = await loadRun(db, runId);
  await assertCan(db, actor, 'pay.view', r.school_id);
  const people = await db.query<{ user_id: string }>('select s.user_id from payroll_slip s join app_user u on u.id = s.user_id where s.run_id = $1 order by u.name', [runId]);
  if (!people.length) throw notFound('Payslips');
  const all: SlipData[] = [];
  for (const p of people) all.push(await slip(db, actor, runId, p.user_id));
  return slipsDoc(db, r.school_id, `Payslips · ${r.title}`, all);
}

export { monthEnd, fyOf };
