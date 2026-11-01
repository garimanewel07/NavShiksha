import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, day, money, openPdf, saveFile, today, type User } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, ask } from '../ui';
import { FailedPage } from '../errors';

/**
 * Each school's own pay: its structures (as many as it needs, for permanent, contract, guest and
 * daily-wage staff), and the month's payroll. The accountant proposes and prepares; the principal
 * approves and locks. NES and the Commands see salary cost and status, never the payslips.
 */

export const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const thisMonth = () => today().slice(0, 8) + '01';
const lastMonths = (n: number) => Array.from({ length: n }, (_, i) => { const d = new Date(`${thisMonth()}T00:00:00`); d.setMonth(d.getMonth() - i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; });

/** The school the page works on: a school's own staff have one; NES and Commands choose. */
export function useSchool(): [string, ReactNode] {
  const { schools } = useSchools();
  const [id, setId] = useState('');
  useEffect(() => { if (!id && schools.length) setId(schools[0].id); }, [schools, id]);
  return [id, <SchoolPicker key="p" value={id} onChange={setId} schools={schools} />];
}

const RUN_STATUS: Record<string, [string, string]> = { DRAFT: ['Draft', 'orange'], SUBMITTED: ['Waiting for the principal', 'blue'], LOCKED: ['Approved · locked', 'green'], PAID: ['Paid', 'green'] };
const KIND: Record<string, string> = { REGULAR: 'Monthly salary', SUPPLEMENTARY: 'Arrears', FINAL: 'Final settlement' };
const CALC: Record<string, string> = { BASE: 'Base pay (amount or scale step)', PERCENT: 'Percentage of other components', FLAT: 'Fixed amount a month', PER_UNIT: 'Rate per period, hour or day' };
const UNIT: Record<string, string> = { PERIODS: 'period', HOURS: 'hour', DAYS_PRESENT: 'day present' };
const PF: Record<string, string> = { NONE: 'No PF', CEILING: 'PF on the wage ceiling', ACTUAL: 'PF on actual wages' };

// ── Pay structures ─────────────────────────────────────────────────────────────────────────

export function PayStructures({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const d = useLoad<{ structures: any[]; scales: any[] }>(schoolId ? `/schools/${schoolId}/pay-structures` : null, [schoolId]);
  const [add, setAdd] = useState<any | null>(null);
  const [newS, setNewS] = useState(false);
  const [scale, setScale] = useState(false);
  const approver = user.role === 'SCHOOL_ADMIN';
  const own = (d.data?.structures ?? []).filter((s) => !s.template);
  const templates = (d.data?.structures ?? []).filter((s) => s.template);
  const waiting = own.flatMap((s) => s.components.filter((c: any) => c.status === 'DRAFT').map((c: any) => ({ ...c, structure: s.name })));
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Pay structures</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <button className="btn quiet small" onClick={() => setScale(true)}>New pay scale</button>
        <button className="btn small" onClick={() => setNewS(true)}>New structure</button></div></div>
      <main className="page">
        <section className="tile">
          <h2>Your school’s pay</h2>
          <p className="muted" style={{ marginTop: 6 }}>Make as many structures as the school needs — regular staff on scales, contract teachers on consolidated pay, guest teachers per period, support staff by the day. Every component and rate is proposed by one person and approved by another, from a date. A rise from a past date is paid as arrears.</p>
        </section>
        {waiting.length > 0 && <section className="tile">
          <h3>Waiting for approval</h3>
          {waiting.map((c) => <PendingComponent key={c.id} c={c} approver={approver} onDone={d.reload} />)}
        </section>}
        {!d.data ? <Empty>Loading…</Empty> : !own.length ? <Empty>No structures yet. Make one, or copy an NES template.</Empty> :
          own.map((s) => <Structure key={s.id} s={s} onAdd={() => setAdd(s)} />)}
        {templates.length > 0 && <section className="tile"><h3>NES templates</h3><p className="small muted">Starting points only. Copy one into the school and change it to suit.</p>
          {templates.map((t) => <div key={t.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{t.name}</b> <span className="small muted">{t.components.length} components</span></span></div>)}</section>}
        <section className="tile">
          <h3>Pay scales</h3>
          <p className="small muted">Steps for yearly increments. A person on a scale moves up one step in the scale’s increment month, once the principal grants it.</p>
          {!(d.data?.scales ?? []).length ? <Empty>No scales yet.</Empty> : <div className="scroll-x"><table className="table">
            <thead><tr><th>Scale</th><th>Steps</th><th>Increment in</th><th>Status</th><th /></tr></thead>
            <tbody>{(d.data?.scales ?? []).map((x) => <tr key={x.id}><td><b>{x.name}</b></td>
              <td className="small">{x.steps_paise.slice(0, 4).map((p: number) => money(p)).join(' · ')}{x.steps_paise.length > 4 ? ` … ${money(x.steps_paise[x.steps_paise.length - 1])} (${x.steps_paise.length} steps)` : ''}</td>
              <td>{new Date(2026, x.increment_month - 1, 1).toLocaleDateString('en-IN', { month: 'long' })}</td>
              <td>{x.approved ? <span className="pill green">Approved</span> : <span className="pill orange">Waiting</span>}</td>
              <td>{!x.approved && approver && <ApproveScale id={x.id} onDone={d.reload} />}</td></tr>)}</tbody></table></div>}
        </section>
      </main>
      {add && <ComponentDrawer s={add} onClose={() => { setAdd(null); d.reload(); }} />}
      {newS && <StructureDrawer schoolId={schoolId} templates={[...templates, ...own]} onClose={() => { setNewS(false); d.reload(); }} />}
      {scale && <ScaleDrawer schoolId={schoolId} onClose={() => { setScale(false); d.reload(); }} />}
    </>
  );
}

const describe = (c: any) => c.calc === 'BASE' ? 'Base pay' : c.calc === 'PERCENT' ? `${c.percent}% of ${(c.of_codes ?? []).join(' + ')}` : c.calc === 'FLAT' ? `${money(c.amount_paise)} a month` : `${money(c.amount_paise)} a ${UNIT[c.unit] ?? c.unit}`;

function Structure({ s, onAdd }: { s: any; onAdd: () => void }) {
  const live = s.components.filter((c: any) => c.status === 'APPROVED');
  return (
    <section className="tile">
      <div className="tile-head"><div><h3>{s.name}</h3><p className="small muted" style={{ marginTop: 4 }}>{s.description || '—'}</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}><span className="pill">{PF[s.pf]}</span><span className="pill">{s.esi ? 'ESI where due' : 'No ESI'}</span>
          <span className="pill">{s.pt ? 'Professional tax' : 'No professional tax'}</span><span className="pill">{s.tds ? 'Income tax (TDS)' : 'No TDS'}</span><span className="pill blue">{s.people} on it</span></div></div>
        <button className="btn quiet small" onClick={onAdd}>Add or change a component</button></div>
      {!live.length ? <Empty>No approved components yet.</Empty> : <div className="scroll-x"><table className="table">
        <thead><tr><th>Code</th><th>Component</th><th>Worked out as</th><th>Counts for</th><th>From</th><th>Until</th></tr></thead>
        <tbody>{live.map((c: any) => <tr key={c.id}><td className="mono small">{c.code}</td><td><b>{c.name}</b>{c.kind === 'DEDUCTION' && <span className="pill red" style={{ marginLeft: 6 }}>Deduction</span>}</td>
          <td>{describe(c)}</td><td className="small muted">{[c.taxable ? 'tax' : null, c.pf_wage ? 'PF wages' : null, c.prorate ? 'reduced for days not paid' : null].filter(Boolean).join(', ') || '—'}</td>
          <td className="small">{day(c.from)}</td><td className="small">{c.to ? day(c.to) : '—'}</td></tr>)}</tbody></table></div>}
    </section>
  );
}

function PendingComponent({ c, approver, onDone }: { c: any; approver: boolean; onDone: () => void }) {
  const { run, busy } = useAction();
  const nav = useNavigate();
  return (
    <div className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{c.structure}: {c.name}</b> <span className="small">{describe(c)} from {day(c.from)}</span><span className="tiny muted" style={{ display: 'block' }}>Proposed by {c.created_by}{c.from < thisMonth() ? ' · back-dated: arrears will be due' : ''}</span></span>
      {approver && !c.mine ? <span style={{ display: 'flex', gap: 6 }}>
        <button className="btn small" disabled={busy} onClick={async () => {
          const r = await run(() => api<{ arrearsFrom: string | null }>(`/pay-components/${c.id}/decide`, { body: { approve: true } }), 'Approved');
          if (r?.arrearsFrom && await ask(`This applies from ${monthLabel(r.arrearsFrom)}, which is already paid. Open the payroll to pay the arrears?`)) nav(`/payroll?arrears=${r.arrearsFrom}`);
          else if (r) onDone();
        }}>Approve</button>
        <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/pay-components/${c.id}/decide`, { body: { approve: false } }), 'Not approved')) onDone(); }}>Reject</button></span>
        : <span className="tiny muted">{c.mine ? 'Another person approves your proposal.' : 'The principal approves.'}</span>}
    </div>
  );
}

function ApproveScale({ id, onDone }: { id: string; onDone: () => void }) {
  const { run, busy } = useAction();
  return <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/pay-scales/${id}/approve`, { body: {} }), 'Scale approved')) onDone(); }}>Approve</button>;
}

function ComponentDrawer({ s, onClose }: { s: any; onClose: () => void }) {
  const live = s.components.filter((c: any) => c.status === 'APPROVED');
  const [f, setF] = useState({ code: '', name: '', kind: 'EARNING', calc: 'FLAT', percent: '', ofCodes: [] as string[], amount: '', unit: 'PERIODS', taxable: true, pfWage: false, prorate: true, from: thisMonth() });
  const { run, busy } = useAction();
  const pick = (code: string) => {
    const c = live.find((x: any) => x.code === code);
    if (c) setF({ code: c.code, name: c.name, kind: c.kind, calc: c.calc, percent: String(c.percent ?? ''), ofCodes: c.of_codes ?? [], amount: c.amount_paise ? String(c.amount_paise / 100) : '', unit: c.unit ?? 'PERIODS', taxable: c.taxable, pfWage: c.pf_wage, prorate: c.prorate, from: thisMonth() });
    else setF({ ...f, code: '' });
  };
  const ok = f.code.length >= 2 && f.name.trim().length > 1 && (f.calc !== 'PERCENT' || (Number(f.percent) > 0 && f.ofCodes.length)) && (!['FLAT', 'PER_UNIT'].includes(f.calc) || Number(f.amount) > 0);
  return (
    <Drawer title={`${s.name}: component`} onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Change an existing component, or add a new one</span><select className="input" value={live.some((x: any) => x.code === f.code) ? f.code : ''} onChange={(e) => pick(e.target.value)}>
          <option value="">A new component</option>{live.map((c: any) => <option key={c.id} value={c.code}>{c.name} ({describe(c)})</option>)}</select></label>
        <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, code: live.some((x: any) => x.code === f.code) ? f.code : e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) })} placeholder="Dearness allowance" /></label>
          <label className="field"><span>Code</span><input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="DA" /></label>
          <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="EARNING">Paid to the person</option><option value="DEDUCTION">Deducted</option></select></label>
          <label className="field"><span>Worked out as</span><select className="input" value={f.calc} onChange={(e) => setF({ ...f, calc: e.target.value, prorate: e.target.value !== 'PER_UNIT' })}>{Object.entries(CALC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        {f.calc === 'PERCENT' && <div className="form-grid">
          <label className="field"><span>Percentage</span><input className="input" inputMode="decimal" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="55" /></label>
          <div className="field"><span>Of</span><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{live.filter((c: any) => c.code !== f.code && c.kind === 'EARNING').map((c: any) => <label key={c.code} className="check small">
            <input type="checkbox" checked={f.ofCodes.includes(c.code)} onChange={(e) => setF({ ...f, ofCodes: e.target.checked ? [...f.ofCodes, c.code] : f.ofCodes.filter((x) => x !== c.code) })} />{c.name}</label>)}</div></div></div>}
        {['FLAT', 'PER_UNIT'].includes(f.calc) && <div className="form-grid">
          <label className="field"><span>{f.calc === 'FLAT' ? 'Amount a month (₹)' : 'Rate (₹)'}</span><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
          {f.calc === 'PER_UNIT' && <label className="field"><span>For each</span><select className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}><option value="PERIODS">Period taught</option><option value="HOURS">Hour worked</option><option value="DAYS_PRESENT">Day present (from the staff register)</option></select></label>}</div>}
        {f.calc === 'BASE' && <p className="small muted">The amount comes from each person’s pay: a fixed amount, or their step on a pay scale.</p>}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label className="check small"><input type="checkbox" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} />Taxable</label>
          <label className="check small"><input type="checkbox" checked={f.pfWage} onChange={(e) => setF({ ...f, pfWage: e.target.checked })} />Counts as PF wages (basic, DA)</label>
          {f.calc !== 'PER_UNIT' && <label className="check small"><input type="checkbox" checked={f.prorate} onChange={(e) => setF({ ...f, prorate: e.target.checked })} />Reduced for days not paid</label>}
        </div>
        <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        {f.from < thisMonth() && <div className="callout orange small">This is back-dated. Once approved, the payroll works out the arrears for the months already paid.</div>}
        <button className="btn big" disabled={busy || !ok} onClick={async () => {
          const ordinal = live.find((c: any) => c.code === f.code)?.ordinal ?? (Math.max(0, ...live.map((c: any) => c.ordinal)) + 1);
          if (await run(() => api(`/pay-structures/${s.id}/components`, { body: { code: f.code, name: f.name, kind: f.kind, calc: f.calc, percent: f.calc === 'PERCENT' ? Number(f.percent) : null, ofCodes: f.calc === 'PERCENT' ? f.ofCodes : null,
            amountPaise: ['FLAT', 'PER_UNIT'].includes(f.calc) ? Math.round(Number(f.amount) * 100) : null, unit: f.calc === 'PER_UNIT' ? f.unit : null, taxable: f.taxable, pfWage: f.pfWage, prorate: f.calc === 'PER_UNIT' ? false : f.prorate, ordinal, from: f.from } }), 'Proposed; the principal approves')) onClose();
        }}>Propose</button>
      </section>
    </Drawer>
  );
}

function StructureDrawer({ schoolId, templates, onClose }: { schoolId: string; templates: any[]; onClose: () => void }) {
  const [f, setF] = useState({ name: '', description: '', pf: 'CEILING', esi: true, pt: true, tds: true, copyFrom: '' });
  const { run, busy } = useAction();
  return (
    <Drawer title="New pay structure" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Contract teachers" /></label>
        <label className="field"><span>Who it is for</span><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Fixed-term teachers on consolidated pay" /></label>
        <label className="field"><span>Provident fund</span><select className="input" value={f.pf} onChange={(e) => setF({ ...f, pf: e.target.value })}>{Object.entries(PF).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label className="check small"><input type="checkbox" checked={f.esi} onChange={(e) => setF({ ...f, esi: e.target.checked })} />ESI where the law requires it</label>
          <label className="check small"><input type="checkbox" checked={f.pt} onChange={(e) => setF({ ...f, pt: e.target.checked })} />Professional tax</label>
          <label className="check small"><input type="checkbox" checked={f.tds} onChange={(e) => setF({ ...f, tds: e.target.checked })} />Income tax (TDS)</label></div>
        <label className="field"><span>Start from a copy of</span><select className="input" value={f.copyFrom} onChange={(e) => setF({ ...f, copyFrom: e.target.value })}>
          <option value="">Nothing (empty)</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.template ? 'NES template: ' : ''}{t.name}</option>)}</select></label>
        {f.copyFrom && <p className="tiny muted">Copied components start as proposals for the principal to approve.</p>}
        <button className="btn big" disabled={busy || f.name.trim().length < 2} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/pay-structures`, { body: { ...f, copyFrom: f.copyFrom || null } }), 'Structure made')) onClose(); }}>Make structure</button>
      </section>
    </Drawer>
  );
}

function ScaleDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', start: '', rise: '3', steps: '12', month: '7', from: thisMonth() });
  const { run, busy } = useAction();
  const steps = Number(f.start) > 0 ? Array.from({ length: Math.min(60, Number(f.steps) || 1) }, (_, i) => Math.round((Number(f.start) * (1 + Number(f.rise) / 100) ** i) / 100) * 100) : [];
  return (
    <Drawer title="New pay scale" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Level 7 (TGT)" /></label>
        <div className="form-grid">
          <label className="field"><span>First step (₹ a month)</span><input className="input" inputMode="numeric" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value.replace(/\D/g, '') })} placeholder="44900" /></label>
          <label className="field"><span>Each step higher by (%)</span><input className="input" inputMode="decimal" value={f.rise} onChange={(e) => setF({ ...f, rise: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
          <label className="field"><span>Number of steps</span><input className="input" inputMode="numeric" value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="field"><span>Increment month</span><select className="input" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2026, i, 1).toLocaleDateString('en-IN', { month: 'long' })}</option>)}</select></label>
        </div>
        {steps.length > 0 && <p className="small muted">Steps: {steps.map((x) => `₹${x.toLocaleString('en-IN')}`).join(' · ')}</p>}
        <button className="btn big" disabled={busy || f.name.trim().length < 2 || !steps.length} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/pay-scales`, { body: { name: f.name, stepsPaise: steps.map((x) => x * 100), incrementMonth: Number(f.month), from: f.from } }), 'Scale made; the principal approves it')) onClose();
        }}>Make scale</button>
      </section>
    </Drawer>
  );
}

// ── Payroll runs ───────────────────────────────────────────────────────────────────────────

export function Payroll({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const runs = useLoad<any[]>(schoolId ? `/schools/${schoolId}/payroll` : null, [schoolId]);
  const banks = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff-banks` : null, [schoolId]);
  const loans = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff-loans` : null, [schoolId]);
  const incr = useLoad<any[]>(schoolId ? `/schools/${schoolId}/increments?month=${thisMonth()}` : null, [schoolId]);
  const [month, setMonth] = useState(thisMonth());
  const arrearsFrom = new URLSearchParams(location.search).get('arrears');
  const { run, busy } = useAction();
  const nav = useNavigate();
  const principal = user.role === 'SCHOOL_ADMIN';
  const hasRegular = (runs.data ?? []).some((r) => r.kind === 'REGULAR' && r.month === month);
  const pendingLoans = (loans.data ?? []).filter((l) => l.status === 'PROPOSED');
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Payroll</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <Link className="btn quiet small" to="/pay-structures">Pay structures</Link></div></div>
      <main className="page">
        {arrearsFrom && <section className="callout orange stack"><b>Arrears are due from {monthLabel(arrearsFrom)}.</b>
          <span className="small">Every month already locked from then is worked out again under the new rules; the differences are paid in one arrears run.</span>
          <div><button className="btn small" disabled={busy} onClick={async () => { const r = await run(() => api<{ id: string }>(`/schools/${schoolId}/payroll/arrears`, { body: { fromMonth: arrearsFrom } }), 'Arrears worked out'); if (r) nav(`/payroll/${r.id}`); }}>Work out the arrears</button></div></section>}
        <section className="tile">
          <div className="tile-head"><div><h2>Salaries</h2><p className="muted" style={{ marginTop: 6 }}>The accountant prepares the month from the staff register, leave and inputs; the principal approves, and the month locks. Payslips then reach every staff member’s app.</p></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="input" style={{ height: 36, width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">{lastMonths(6).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
              <button className="btn small" disabled={busy || hasRegular || !schoolId} onClick={async () => { const r = await run(() => api<{ id: string }>(`/schools/${schoolId}/payroll`, { body: { month } }), 'Worked out'); if (r) nav(`/payroll/${r.id}`); }}>{hasRegular ? 'Already made' : `Prepare ${monthLabel(month)}`}</button>
            </div></div>
          {!runs.data ? <Empty>Loading…</Empty> : !runs.data.length ? <Empty>No payroll yet.</Empty> : <div className="scroll-x"><table className="table">
            <thead><tr><th>Month</th><th>Run</th><th>Status</th><th className="num">People</th><th className="num">Gross</th><th className="num">Net to bank</th><th className="num">Employer’s share</th><th>Points</th></tr></thead>
            <tbody>{runs.data.map((r) => { const [l, t] = RUN_STATUS[r.status] ?? [r.status, '']; return <tr key={r.id} className="click" onClick={() => nav(`/payroll/${r.id}`)}>
              <td><b>{monthLabel(r.month)}</b></td><td>{KIND[r.kind]}{r.for_name ? `: ${r.for_name}` : ''}</td><td><span className={`pill ${t}`}>{l}</span></td>
              <td className="num">{r.totals?.people ?? 0}</td><td className="num">{money(r.totals?.gross ?? 0)}</td><td className="num"><b>{money(r.totals?.net ?? 0)}</b></td><td className="num">{money(r.totals?.employer ?? 0)}</td>
              <td>{r.issue_count > 0 && r.status === 'DRAFT' ? <span className="pill orange">{r.issue_count} to check</span> : ''}</td></tr>; })}</tbody></table></div>}
        </section>
        <section className="tile"><h3>Income-tax returns</h3>
          <p className="small muted">The quarterly return on salaries (Form 24Q) as data for the return preparation utility, from the locked payrolls and the TDS challans recorded. Form 16 Part B for each person is on their staff record and in their app.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>{['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <button key={q} className="btn quiet small" disabled={busy} onClick={() => run(async () => {
            const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0);
            await saveFile(`/schools/${schoolId}/tds-return?fy=${y}-${String((y + 1) % 100).padStart(2, '0')}&quarter=${q}`, `form24q-${q}.csv`);
          })}>{q} ({['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'][Number(q[1]) - 1]})</button>)}</div></section>
        {(banks.data ?? []).length > 0 && <section className="tile"><h3>Bank account changes to verify</h3><p className="small muted">Check each against the cancelled cheque or passbook. Someone other than the person who entered it verifies. New accounts are used after the waiting period.</p>
          {(banks.data ?? []).map((b) => <BankRow key={b.id} b={b} onDone={banks.reload} />)}</section>}
        {pendingLoans.length > 0 && <section className="tile"><h3>Advances waiting to be sanctioned</h3>
          {pendingLoans.map((l) => <LoanRow key={l.id} l={l} principal={principal} onDone={loans.reload} />)}</section>}
        {principal && (incr.data ?? []).length > 0 && <Increments rows={incr.data!} schoolId={schoolId} onDone={incr.reload} />}
        {(loans.data ?? []).some((l) => l.status === 'SANCTIONED') && <section className="tile"><h3>Advances being recovered</h3><div className="scroll-x"><table className="table">
          <thead><tr><th>Staff</th><th>Advance</th><th className="num">Amount</th><th className="num">Each month</th><th className="num">Recovered</th><th>From</th></tr></thead>
          <tbody>{(loans.data ?? []).filter((l) => l.status === 'SANCTIONED').map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.kind.toLowerCase().replace('_', ' ')}{l.note ? ` · ${l.note}` : ''}</td>
            <td className="num">{money(l.principal_paise)}</td><td className="num">{money(l.instalment_paise)}</td><td className="num">{money(l.recovered_paise)}</td><td>{monthLabel(l.first_month)}</td></tr>)}</tbody></table></div></section>}
      </main>
    </>
  );
}

function BankRow({ b, onDone }: { b: any; onDone: () => void }) {
  const { run, busy } = useAction();
  const [note, setNote] = useState('');
  return (
    <div className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{b.name}</b> <span className="small">{b.bank_name} · ····{b.account_last4} · {b.ifsc} · in the name of {b.holder_name}</span><span className="tiny muted" style={{ display: 'block' }}>Entered by {b.requested_by} on {day(b.requested_at)}</span></span>
      {b.mine ? <span className="tiny muted">You entered this; someone else verifies it.</span> : <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input className="input" style={{ height: 34, width: 160 }} placeholder="Reason, if rejecting" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/staff-banks/${b.id}/decide`, { body: { approve: true } }), 'Verified; the person is told')) onDone(); }}>Verified</button>
        <button className="btn quiet small" disabled={busy || note.trim().length < 3} onClick={async () => { if (await run(() => api(`/staff-banks/${b.id}/decide`, { body: { approve: false, note } }), 'Rejected')) onDone(); }}>Reject</button></span>}
    </div>
  );
}

function LoanRow({ l, principal, onDone }: { l: any; principal: boolean; onDone: () => void }) {
  const { run, busy } = useAction();
  return (
    <div className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{l.name}</b> <span className="small">{l.kind.toLowerCase().replace('_', ' ')} of {money(l.principal_paise)}, {money(l.instalment_paise)} a month from {monthLabel(l.first_month)}</span><span className="tiny muted" style={{ display: 'block' }}>{l.note} · proposed by {l.created_by}</span></span>
      {principal && !l.mine ? <span style={{ display: 'flex', gap: 6 }}>
        <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/staff-loans/${l.id}/decide`, { body: { approve: true } }), 'Sanctioned')) onDone(); }}>Sanction</button>
        <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/staff-loans/${l.id}/decide`, { body: { approve: false } }), 'Not sanctioned')) onDone(); }}>Refuse</button></span>
        : <span className="tiny muted">The principal sanctions.</span>}
    </div>
  );
}

function Increments({ rows, schoolId, onDone }: { rows: any[]; schoolId: string; onDone: () => void }) {
  const [pick, setPick] = useState<string[]>(rows.map((r) => r.user_id));
  const { run, busy } = useAction();
  return (
    <section className="tile"><h3>Yearly increments due this month</h3>
      {rows.map((r) => <label key={r.user_id} className="list-row check" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
        <input type="checkbox" checked={pick.includes(r.user_id)} onChange={(e) => setPick(e.target.checked ? [...pick, r.user_id] : pick.filter((x) => x !== r.user_id))} />
        <span><b>{r.name}</b> <span className="small muted">{r.scale}, step {r.step} → {r.step + 1}</span></span><span className="small">{money(r.now_paise)} → <b>{money(r.next_paise)}</b></span></label>)}
      <button className="btn small" style={{ marginTop: 10 }} disabled={busy || !pick.length} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/increments`, { body: { month: thisMonth(), userIds: pick } }), 'Increments granted; recorded in each service book')) onDone(); }}>Grant {pick.length} increment{pick.length === 1 ? '' : 's'}</button>
    </section>
  );
}

// ── One run ────────────────────────────────────────────────────────────────────────────────

export function PayrollRun({ user }: { user: User }) {
  const { id } = useParams();
  const d = useLoad<any>(`/payroll/${id}`, [id]);
  const r = d.data;
  const inputs = useLoad<any[]>(r && r.kind === 'REGULAR' && r.status === 'DRAFT' ? `/schools/${r.school_id}/payroll-inputs?month=${r.month}` : null, [r?.status, r?.month]);
  const statutory = useLoad<any>(r && ['LOCKED', 'PAID'].includes(r.status) ? `/payroll/${id}/statutory` : null, [r?.status]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [challan, setChallan] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  if (!r) return d.error ? <FailedPage error={d.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const [label, tone] = RUN_STATUS[r.status] ?? [r.status, ''];
  const errors = r.issues.filter((i: any) => i.level === 'ERROR'), warnings = r.issues.filter((i: any) => i.level === 'WARNING');
  const prep = ['SCHOOL_ADMIN', 'ACCOUNTANT'].includes(user.role);
  const act = async (path: string, msg: string, body: unknown = {}) => { if (await run(() => api(path, { body }), msg)) d.reload(); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/payroll" className="linkbtn small">‹ Payroll</Link><span className="localnav-title">{r.title}</span><span className={`pill ${tone}`}>{label}</span><span className="spacer" style={{ flex: 1 }} />
        {['LOCKED', 'PAID'].includes(r.status) && <button className="btn quiet small" onClick={() => run(() => openPdf(`/payroll/${id}/slips.pdf`))}>All payslips (PDF)</button>}</div></div>
      <main className="page">
        <section className="tile">
          <div className="kpis">
            <div><div className="kpi-label">People</div><div className="kpi-value">{r.totals.people ?? 0}</div><div className="kpi-note">{KIND[r.kind]}</div></div>
            <div><div className="kpi-label">Gross pay</div><div className="kpi-value">{money(r.totals.gross ?? 0)}</div></div>
            <div><div className="kpi-label">Deductions</div><div className="kpi-value">{money(r.totals.deductions ?? 0)}</div><div className="kpi-note">PF, ESI, professional tax, TDS, advances</div></div>
            <div><div className="kpi-label">Net to the bank</div><div className="kpi-value">{money(r.totals.net ?? 0)}</div></div>
            <div><div className="kpi-label">Employer’s share</div><div className="kpi-value">{money(r.totals.employer ?? 0)}</div><div className="kpi-note">PF, EDLI, ESI on top of pay</div></div>
          </div>
          <p className="tiny muted" style={{ marginTop: 14 }}>Prepared by {r.prepared}{r.approved ? ` · approved by ${r.approved} on ${day(r.locked_at)}` : ''}{r.bank_ref ? ` · paid ${day(r.paid_at)}, bank ref. ${r.bank_ref}` : ''}</p>
        </section>

        {r.status === 'DRAFT' && (errors.length > 0 || warnings.length > 0) && <section className="tile stack">
          <h3>To check before submitting</h3>
          {errors.map((i: any, k: number) => <div key={`e${k}`} className="callout red small"><b>{i.name}:</b> {i.message}</div>)}
          {warnings.map((i: any, k: number) => <div key={`w${k}`} className="callout orange small"><b>{i.name}:</b> {i.message}</div>)}
        </section>}
        {r.status === 'DRAFT' && (inputs.data ?? []).length > 0 && <Inputs rows={inputs.data!} schoolId={r.school_id} month={r.month} onSaved={async () => { inputs.reload(); await act(`/payroll/${id}/recompute`, 'Worked out again'); }} />}

        {prep && <section className="tile" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {r.status === 'DRAFT' && <>
            {r.kind !== 'SUPPLEMENTARY' && <button className="btn quiet" disabled={busy} onClick={() => act(`/payroll/${id}/recompute`, 'Worked out again')}>Work out again</button>}
            <button className="btn" disabled={busy || errors.length > 0} onClick={() => act(`/payroll/${id}/submit`, 'Sent to the principal')}>Submit to the principal</button>
            <button className="btn quiet danger" disabled={busy} onClick={async () => { if (await ask('Discard this draft?') && await run(() => api(`/payroll/${id}`, { method: 'DELETE' }), 'Discarded')) nav('/payroll'); }}>Discard</button>
            {errors.length > 0 && <span className="small muted">Fix the problems above first.</span>}</>}
          {r.status === 'SUBMITTED' && (r.canApprove ? <>
            <button className="btn" disabled={busy} onClick={async () => { if (await ask(`Approve and lock ${r.title}? It cannot be changed afterwards; differences are paid in a supplementary run.`)) act(`/payroll/${id}/approve`, 'Approved and locked; payslips sent'); }}>Approve and lock</button>
            <input className="input" style={{ height: 40, flex: '1 1 220px' }} placeholder="What needs changing (to send back)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn quiet" disabled={busy || note.trim().length < 3} onClick={() => act(`/payroll/${id}/send-back`, 'Sent back', { note })}>Send back</button></>
            : <span className="small muted">Waiting for the principal. {r.prepared_by === user.id ? 'You prepared it, so someone else approves.' : ''}</span>)}
          {r.status === 'LOCKED' && <>
            <button className="btn" disabled={busy} onClick={() => run(() => saveFile(`/payroll/${id}/bank-file`, `salary-${r.month.slice(0, 7)}.csv`), 'Bank file saved; account numbers seen are recorded')}>Download bank file</button>
            <input className="input" style={{ height: 40, flex: '1 1 200px' }} placeholder="Bank reference (UTR) once paid" value={ref} onChange={(e) => setRef(e.target.value)} />
            <button className="btn quiet" disabled={busy || ref.trim().length < 4} onClick={() => act(`/payroll/${id}/paid`, 'Recorded as paid', { bankRef: ref })}>Mark paid</button></>}
          {['LOCKED', 'PAID'].includes(r.status) && <>
            <button className="btn quiet" onClick={() => run(() => saveFile(`/payroll/${id}/pf-ecr`, `pf-ecr-${r.month.slice(0, 7)}.txt`))}>PF return (ECR)</button>
            <button className="btn quiet" onClick={() => setChallan(true)}>Record a statutory payment</button></>}
        </section>}

        {statutory.data && <section className="tile"><h3>Statutory dues for the month</h3>
          <div className="kpis" style={{ marginTop: 10 }}>
            <div><div className="kpi-label">Provident fund</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money((statutory.data.totals.PF ?? 0) + (statutory.data.totals.ER_EPF ?? 0) + (statutory.data.totals.ER_EPS ?? 0) + (statutory.data.totals.ER_EDLI ?? 0) + (statutory.data.totals.ER_PF_ADMIN ?? 0))}</div><div className="kpi-note">Staff {money(statutory.data.totals.PF ?? 0)} + employer</div></div>
            <div><div className="kpi-label">ESI</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money((statutory.data.totals.ESI ?? 0) + (statutory.data.totals.ER_ESI ?? 0))}</div></div>
            <div><div className="kpi-label">Professional tax</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money(statutory.data.totals.PT ?? 0)}</div></div>
            <div><div className="kpi-label">Income tax (TDS)</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money(statutory.data.totals.TDS ?? 0)}</div></div>
          </div>
          {statutory.data.challans.length > 0 && <p className="small" style={{ marginTop: 12 }}>Paid: {statutory.data.challans.map((c: any) => `${c.kind} ${money(c.amount)} on ${day(c.paid_on)} (${c.reference})`).join(' · ')}</p>}
        </section>}

        <section className="tile">
          <h3>Payslips</h3>
          <p className="small muted">Open a row to see every line and how it was worked out.</p>
          {!r.slips.length ? <Empty>Nobody is paid in this run.</Empty> : <div className="scroll-x"><table className="table">
            <thead><tr><th>Staff</th><th>Employment</th><th className="num">Days paid</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net</th><th>Bank</th></tr></thead>
            <tbody>{r.slips.map((s: any) => <SlipRows key={s.user_id} s={s} open={open === s.user_id} onToggle={() => setOpen(open === s.user_id ? null : s.user_id)} runId={r.id} locked={['LOCKED', 'PAID'].includes(r.status)} />)}</tbody></table></div>}
        </section>
      </main>
      {challan && <ChallanDrawer schoolId={r.school_id} month={r.month} totals={statutory.data?.totals ?? {}} onClose={() => { setChallan(false); statutory.reload(); }} />}
    </>
  );
}

const EMP: Record<string, string> = { PERMANENT: 'Permanent', CONTRACT: 'Contract', TEMPORARY: 'Temporary', PART_TIME: 'Part-time', GUEST: 'Guest', DAILY_WAGE: 'Daily wage', DEPUTATION: 'Deputation' };

function SlipRows({ s, open, onToggle, runId, locked }: { s: any; open: boolean; onToggle: () => void; runId: string; locked: boolean }) {
  const { run } = useAction();
  const earn = s.lines.filter((l: any) => l.kind === 'EARNING' || l.code === 'LOP'), ded = s.lines.filter((l: any) => l.kind === 'DEDUCTION' && l.code !== 'LOP'), er = s.lines.filter((l: any) => l.kind === 'EMPLOYER');
  const Line = ({ l }: { l: any }) => <div className="list-row" style={{ gridTemplateColumns: '1fr auto', padding: '8px 0' }}><span><b className="small">{l.name}</b><span className="tiny muted" style={{ display: 'block' }}>{l.basis}</span></span>
    <span className="small" style={{ whiteSpace: 'nowrap' }}>{l.code === 'LOP' ? '−' : ''}{money(l.amount, true)}</span></div>;
  return (
    <>
      <tr className="click" onClick={onToggle}><td><b>{s.name}</b><span className="tiny muted" style={{ display: 'block' }}>{s.designation ?? ''} · {s.nes_staff_id}</span></td><td>{EMP[s.employment] ?? s.employment}</td>
        <td className="num">{s.days_in_month ? `${s.paid_days}/${s.days_in_month}` : '—'}</td><td className="num">{money(s.gross)}</td><td className="num">{money(s.deductions)}</td><td className="num"><b>{money(s.net)}</b></td>
        <td className="small">{s.account_last4 ? `····${s.account_last4}` : <span className="pill red">None</span>}</td></tr>
      {open && <tr><td colSpan={7} style={{ background: 'var(--fill)' }}>
        <div className="grid" style={{ gap: 16 }}>
          <div><h4 style={{ margin: '4px 0' }}>Earnings</h4>{earn.map((l: any, i: number) => <Line key={i} l={l} />)}</div>
          <div><h4 style={{ margin: '4px 0' }}>Deductions</h4>{ded.length ? ded.map((l: any, i: number) => <Line key={i} l={l} />) : <p className="small muted">None</p>}</div>
          {er.length > 0 && <div><h4 style={{ margin: '4px 0' }}>Paid by the school on top</h4>{er.map((l: any, i: number) => <Line key={i} l={l} />)}</div>}
        </div>
        {locked && <button className="btn quiet small" style={{ marginTop: 8 }} onClick={() => run(() => openPdf(`/payroll/${runId}/slips/${s.user_id}/pdf`))}>Payslip PDF</button>}
      </td></tr>}
    </>
  );
}

function Inputs({ rows, schoolId, month, onSaved }: { rows: any[]; schoolId: string; month: string; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [`${r.user_id}:${r.unit}`, r.quantity === null ? '' : String(r.quantity)])));
  const { run, busy } = useAction();
  return (
    <section className="tile"><h3>This month’s inputs</h3><p className="small muted">Periods taught by guest teachers, hours, days worked. Days present for daily-wage staff come from the staff register unless entered here.</p>
      {rows.map((r) => { const k = `${r.user_id}:${r.unit}`; return <div key={k} className="list-row" style={{ gridTemplateColumns: '1fr 120px' }}>
        <span><b>{r.name}</b> <span className="small muted">{r.component} · {money(r.rate)} a {UNIT[r.unit]}</span></span>
        <input className="input" inputMode="decimal" aria-label={`${r.name}: ${UNIT[r.unit]}s`} placeholder={r.unit === 'DAYS_PRESENT' ? 'From register' : '0'} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/[^0-9.]/g, '') })} /></div>; })}
      <button className="btn small" style={{ marginTop: 10 }} disabled={busy} onClick={async () => {
        const entries = rows.filter((r) => v[`${r.user_id}:${r.unit}`] !== '').map((r) => ({ userId: r.user_id, unit: r.unit, quantity: Number(v[`${r.user_id}:${r.unit}`]) }));
        if (await run(() => api(`/schools/${schoolId}/payroll-inputs`, { method: 'PUT', body: { month, entries } }), 'Inputs saved')) onSaved();
      }}>Save and work out again</button>
    </section>
  );
}

function ChallanDrawer({ schoolId, month, totals, onClose }: { schoolId: string; month: string; totals: Record<string, number>; onClose: () => void }) {
  const due: Record<string, number> = { PF: (totals.PF ?? 0) + (totals.ER_EPF ?? 0) + (totals.ER_EPS ?? 0) + (totals.ER_EDLI ?? 0) + (totals.ER_PF_ADMIN ?? 0), ESI: (totals.ESI ?? 0) + (totals.ER_ESI ?? 0), PT: totals.PT ?? 0, TDS: totals.TDS ?? 0 };
  const [f, setF] = useState({ kind: 'PF', amount: String(due.PF / 100), reference: '', paidOn: today() });
  const { run, busy } = useAction();
  return (
    <Drawer title={`Statutory payment · ${monthLabel(month)}`} onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Paid</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, amount: String(due[e.target.value] / 100) })}>
          <option value="PF">Provident fund (EPFO)</option><option value="ESI">ESI (ESIC)</option><option value="PT">Professional tax</option><option value="TDS">Income tax deducted (TDS)</option></select></label>
        <div className="form-grid">
          <label className="field"><span>Amount (₹)</span><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
          <label className="field"><span>Paid on</span><input className="input" type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></label></div>
        <label className="field"><span>Challan or reference number</span><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
        <button className="btn big" disabled={busy || f.reference.trim().length < 4 || !Number(f.amount)} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/challans`, { body: { kind: f.kind, period: month, amountPaise: Math.round(Number(f.amount) * 100), reference: f.reference, paidOn: f.paidOn } }), 'Recorded')) onClose();
        }}>Record payment</button>
      </section>
    </Drawer>
  );
}

// ── NES and the Commands ───────────────────────────────────────────────────────────────────

export function PayOverview() {
  const d = useLoad<any[]>('/pay/overview');
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Staff and salaries</span></div></div>
      <main className="page">
        <section className="tile">
          <h2>Across the schools</h2>
          <p className="muted" style={{ marginTop: 6 }}>Each school keeps and pays its own staff. This shows staff strength, vacancies, the latest payroll and salary cost against fee income for the year. Payslips stay with the school.</p>
          {!d.data ? <Empty>Loading…</Empty> : <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
            <thead><tr><th>School</th><th className="num">Staff</th><th>Employment</th><th className="num">Posts</th><th className="num">Vacant</th><th>Latest payroll</th><th className="num">Salary cost (year)</th><th className="num">Fee income (year)</th></tr></thead>
            <tbody>{d.data.map((s) => <tr key={s.school_id}><td><b>{s.school}</b></td><td className="num">{s.staff}</td>
              <td className="small">{Object.entries(s.by_employment ?? {}).map(([k, n]) => `${EMP[k] ?? k} ${n}`).join(' · ') || '—'}</td>
              <td className="num">{s.posts}</td><td className="num">{s.vacant ? <span className="pill orange">{s.vacant}</span> : 0}</td>
              <td className="small">{s.last_run ? <>{monthLabel(s.last_run.month)} · <span className={`pill ${RUN_STATUS[s.last_run.status]?.[1] ?? ''}`}>{RUN_STATUS[s.last_run.status]?.[0]}</span></> : <span className="muted">Not on NavShiksha payroll yet</span>}</td>
              <td className="num">{money(s.salary_cost_fy)}</td><td className="num">{money(s.fee_income_fy)}</td></tr>)}</tbody></table></div>}
        </section>
      </main>
    </>
  );
}
