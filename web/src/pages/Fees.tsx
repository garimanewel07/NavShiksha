import { useEffect, useMemo, useState } from 'react';
import { api, day, money, num, words, type User, today, currentYear } from '../api';
import { Drawer, Empty, SchoolPicker, Status, useAction, useLoad, useSchools, useToast, ask } from '../ui';

const BANDS = ['OFFICER', 'CPO_AND_ABOVE', 'PO_AND_BELOW', 'NES_STAFF', 'OTHERS'];
const CLASS_BANDS = ['PRE', 'PRIMARY', 'MIDDLE', 'SECONDARY', 'SENIOR'];
const CLASS_LABEL: Record<string, string> = { PRE: 'Balvatika', PRIMARY: 'I–V', MIDDLE: 'VI–VIII', SECONDARY: 'IX–X', SENIOR: 'XI–XII' };

export default function Fees({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  const [head, setHead] = useState('TUITION');
  const [revise, setRevise] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const plan = useLoad<any>(schoolId ? `/fees/plans?schoolId=${schoolId}&year=${currentYear()}` : null, [schoolId]);
  const { run, busy } = useAction();
  const toast = useToast();
  const [inst, setInst] = useState('');
  // The bill for the period we are in, until the office picks another.
  useEffect(() => { const list = plan.data?.installments ?? []; if (list.length && !list.some((i: any) => i.code === inst)) setInst((list.find((i: any) => i.start <= today() && today() < i.end) ?? list[0]).code); }, [plan.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const monthly = (plan.data?.installments ?? []).filter((i: any) => /^M/.test(i.code) && i.end > today()).length > 0;
  const canSchedule = ['SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role);
  const rate = (cb: string, fb: string) => plan.data?.rates.find((r: any) => r.class_band === cb && r.fee_band === fb && r.head_code === head);
  const drafts = (plan.data?.versions ?? []).filter((v: any) => v.status === 'DRAFT');
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Fees</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
        <button className="btn small" onClick={() => setRevise(true)}>Revise fees</button>
      </div></div>
      <main className="page">
        {!plan.data ? <Empty>Loading…</Empty> : (<>
          <section className="tile">
            <div className="tile-head">
              <div><h2>Rates in force</h2><p className="muted" style={{ marginTop: 6 }}>Per quarter, by class and fee band (a monthly bill is a third of the quarter). Changing a rate creates a new dated version; nothing already charged is edited.</p></div>
              <div className="seg">{['TUITION', 'COMPUTER', 'ANNUAL'].map((h) => <button key={h} className={head === h ? 'on' : ''} onClick={() => setHead(h)}>{words(h)}</button>)}</div>
            </div>
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Class</th>{BANDS.map((b) => <th key={b} className="num">{words(b)}</th>)}</tr></thead>
              <tbody>{CLASS_BANDS.map((cb) => (
                <tr key={cb}><td style={{ fontWeight: 600 }}>{CLASS_LABEL[cb]}</td>{BANDS.map((fb) => <td key={fb} className="num">{rate(cb, fb) ? money(rate(cb, fb).amount_paise) : '—'}</td>)}</tr>))}
              </tbody>
            </table></div>
          </section>
          <div className="row">
            <section className="tile" style={{ flex: '1 1 380px' }}>
              <h2>Raise dues</h2>
              <p className="muted" style={{ marginTop: 6 }}>Safe to run again: each child is charged once per instalment.</p>
              <div className="callout small" style={{ marginTop: 12 }}>
                <b>Billed {monthly ? 'by the month' : 'by the quarter'}.</b> {monthly ? 'Twelve bills a year, each a third of the quarter; annual charges on the first.' : 'Four bills a year. Parents may still pay a quarter month by month in the app (Settings → Fees).'}
                {canSchedule && <div style={{ marginTop: 8 }}><button className="btn quiet small" disabled={busy} onClick={async () => {
                  const to = monthly ? 'QUARTERLY' : 'MONTHLY';
                  if (!await ask(`Bill the months not billed yet ${to === 'MONTHLY' ? 'by the month' : 'by the quarter'}? Bills already raised stay as they are.`)) return;
                  const r: any = await run(() => api('/fees/schedule', { body: { schoolId, year: currentYear(), schedule: to } }));
                  if (r) { toast(`From ${day(r.from)}: ${r.installments.map((i: any) => i.label).join(', ')}.`); plan.reload(); }
                }}>{monthly ? 'Go back to quarterly bills' : 'Bill by the month instead'}</button></div>}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                <select className="input" style={{ height: 40, width: 'auto' }} value={inst} onChange={(e) => setInst(e.target.value)} aria-label="Instalment">{plan.data.installments.map((i: any) => <option key={i.code} value={i.code}>{i.label}{/^Q/.test(i.code) ? ` (${i.code})` : ''} · due {day(i.due_date)}</option>)}</select>
                <button className="btn" disabled={busy} onClick={async () => {
                  const r: any = await run(() => api('/fees/generate', { body: { schoolId, year: currentYear(), installment: inst } }));
                  if (r) { plan.reload(); toast(`${inst}: ${num(r.created)} children charged, ${num(r.skipped)} already charged.`); }
                }}>Raise {plan.data.installments.find((i: any) => i.code === inst)?.label ?? inst}</button>
              </div>
            </section>
            <section className="tile" style={{ flex: '1 1 480px' }}>
              <h2>Versions</h2>
              {plan.data.versions.map((v: any) => (
                <div key={v.id} className="list-row" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto' }}>
                  <span className="pill">v{v.version}</span>
                  <div><div style={{ fontWeight: 600 }}>{v.note}</div><div className="small muted">From {day(v.valid_from)}{v.valid_to ? ` to ${day(v.valid_to)}` : ''} · {words(v.policy)} · drafted by {v.created_by.split(' <')[0]}{v.approved_by ? `, approved by ${v.approved_by.split(' <')[0]}` : ''}</div></div>
                  {v.status === 'DRAFT' ? <button className="btn small" onClick={() => setReview(v.id)}>Review</button> : v.status === 'SUPERSEDED' ? <span className="pill">Replaced from its first day</span> : <Status s={v.status === 'PUBLISHED' ? 'ACTIVE' : v.status} />}
                </div>
              ))}
              {drafts.length > 0 && <div className="callout blue small" style={{ marginTop: 12 }}>A draft needs approval by someone other than the person who drafted it.</div>}
            </section>
          </div>
        </>)}
      </main>
      {revise && plan.data && <ReviseDrawer plan={plan.data} onClose={(id) => { setRevise(false); plan.reload(); if (id) setReview(id); }} />}
      {review && <ReviewDrawer id={review} user={user} onClose={() => { setReview(null); plan.reload(); }} />}
    </>
  );
}

function ReviseDrawer({ plan, onClose }: { plan: any; onClose: (draftId?: string) => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ effectiveFrom: today(), policy: 'FUTURE_ONLY', note: '', classBand: 'SECONDARY', feeBand: 'PO_AND_BELOW', head: 'TUITION', amount: '', arrears: 'WITH_NEXT', arrearsDue: '' });
  const backdated = f.effectiveFrom < today();
  const current = plan.rates.find((r: any) => r.class_band === f.classBand && r.fee_band === f.feeBand && r.head_code === f.head);
  return (
    <Drawer title="Revise fees" onClose={() => onClose()}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Class</span><select className="input" value={f.classBand} onChange={(e) => setF({ ...f, classBand: e.target.value })}>{CLASS_BANDS.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}</select></label>
          <label className="field"><span>Fee band</span><select className="input" value={f.feeBand} onChange={(e) => setF({ ...f, feeBand: e.target.value })}>{BANDS.map((b) => <option key={b} value={b}>{words(b)}</option>)}</select></label>
          <label className="field"><span>Head</span><select className="input" value={f.head} onChange={(e) => setF({ ...f, head: e.target.value })}>{['TUITION', 'COMPUTER', 'ANNUAL'].map((h) => <option key={h} value={h}>{words(h)}</option>)}</select></label>
          <label className="field"><span>New amount per quarter (₹){current ? ` · now ${money(current.amount_paise)}` : ''}</span><input className="input" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d]/g, '') })} /></label>
          <label className="field"><span>Effective from</span><input className="input" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend className="small muted" style={{ marginBottom: 8 }}>Quarters already raised that start on or after this date</legend>
          <label className="check"><input type="radio" checked={f.policy === 'FUTURE_ONLY'} onChange={() => setF({ ...f, policy: 'FUTURE_ONLY' })} /> Re-price only what is still unpaid</label>
          <label className="check"><input type="radio" checked={f.policy === 'DIFFERENCE_ON_PAID'} onChange={() => setF({ ...f, policy: 'DIFFERENCE_ON_PAID' })} /> Also charge the difference on quarters already paid (arrears)</label>
        </fieldset>
        {backdated && <div className="callout blue small">This takes effect from a past date. The difference on quarters that are already due or paid is billed separately as arrears, so it is not overdue the day it is raised.</div>}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend className="small muted" style={{ marginBottom: 8 }}>Arrears are due</legend>
          <label className="check"><input type="radio" checked={f.arrears === 'WITH_NEXT'} onChange={() => setF({ ...f, arrears: 'WITH_NEXT' })} /> With the next instalment</label>
          <label className="check"><input type="radio" checked={f.arrears === 'SPREAD'} onChange={() => setF({ ...f, arrears: 'SPREAD' })} /> Spread over the instalments still to come</label>
          <label className="check"><input type="radio" checked={f.arrears === 'ON_DATE'} onChange={() => setF({ ...f, arrears: 'ON_DATE' })} /> By a date
            {f.arrears === 'ON_DATE' && <input className="input" type="date" style={{ height: 34, width: 'auto', marginLeft: 8 }} value={f.arrearsDue} onChange={(e) => setF({ ...f, arrearsDue: e.target.value })} />}</label>
        </fieldset>
        <label className="field"><span>Reason (parents see it with any arrears)</span><input className="input" value={f.note} placeholder="For example: NES order 14/2026, tuition revised for 2026–27" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <button className="btn big" disabled={busy || !f.amount} onClick={async () => {
          const r: any = await run(() => api(`/fees/plans/${plan.planId}/revisions`, { body: { effectiveFrom: f.effectiveFrom, policy: f.policy, note: f.note,
            arrears: { mode: f.arrears, due: f.arrears === 'ON_DATE' ? f.arrearsDue || null : null },
            changes: [{ classBand: f.classBand, feeBand: f.feeBand, head: f.head, amountPaise: Number(f.amount) * 100 }] } }), 'Draft saved. Review the impact next.');
          if (r) onClose(r.versionId);
        }}>Save draft and preview impact</button>
      </section>
    </Drawer>
  );
}

function ReviewDrawer({ id, user, onClose }: { id: string; user: User; onClose: () => void }) {
  const { data: p } = useLoad<any>(`/fees/revisions/${id}/preview`);
  const { run, busy } = useAction();
  const byInst = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of p?.changes ?? []) m[c.installment] = (m[c.installment] ?? 0) + c.delta;
    return m;
  }, [p]);
  return (
    <Drawer title="Review fee change" onClose={onClose}>
      {!p ? <Empty>Working out the impact…</Empty> : (<>
        <section className="tile tight">
          <div className="kpis">
            <div><div className="kpi-label">Students affected</div><div className="kpi-value">{num(p.studentsAffected)}</div></div>
            <div><div className="kpi-label">Extra demand</div><div className="kpi-value">{money(p.extraDemandPaise)}</div></div>
            <div><div className="kpi-label">Paid quarters affected</div><div className="kpi-value">{num(p.paidInstallmentsAffected)}</div></div>
            <div><div className="kpi-label">Arrears</div><div className="kpi-value">{money(p.arrearsPaise)}</div><div className="kpi-note">{num(p.arrearsStudents)} families · highest {money(p.largestArrearsPaise)}</div></div>
          </div>
          {p.arrearsPaise !== 0 && <p className="small" style={{ marginTop: 14 }}>Arrears due {p.arrearsSchedule.length > 1 ? `in ${p.arrearsSchedule.length} parts: ${p.arrearsSchedule.map((s: any) => day(s.dueOn)).join(', ')}` : `by ${day(p.arrearsSchedule[0].dueOn)}`}. {p.arrearsPaise < 0 ? 'Credits are used for other dues first.' : ''} Parents are told the amount, the reason and the due date.</p>}
          <p className="small muted" style={{ marginTop: 16 }}>Effective {day(p.effectiveFrom)} · {words(p.policy)}. Quarters {p.untouchedInstallments.join(', ') || 'none'} are not touched. Quarters not yet raised will use the new rate automatically.</p>
          {Object.entries(byInst).map(([k, v]) => <div key={k} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span>{k}{(p.changes ?? []).some((c: any) => c.installment === k && c.arrears) ? ' · as arrears' : ' · added to the instalment'}</span><strong>{money(v as number)}</strong></div>)}
        </section>
        {['SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role) ? <>
        <div className="callout blue small">Approving publishes the new version and adds the difference lines in one step. It must be someone other than the person who drafted it.</div>
        <button className="btn big" disabled={busy} onClick={async () => { if (await run(() => api(`/fees/revisions/${id}/approve`, { body: {} }), 'Fee change published')) onClose(); }}>Approve and publish</button></> : <div className="callout blue small">The principal (or NES) checks this impact and approves it; parents are told only then.</div>}
      </>)}
    </Drawer>
  );
}

