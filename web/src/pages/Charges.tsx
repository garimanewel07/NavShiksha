import { useEffect, useState } from 'react';
import { api, day, money, num, time, today, words, type User, currentYear } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';

const CLASSES = ['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const STATUS: Record<string, [string, string]> = {
  IN: ['In', 'green'], AWAITING: ['No reply yet', 'blue'], DECLINED: ['Not going', ''], WAITLIST: ['Waiting list', 'orange'], NO_REPLY: ['No reply', ''],
  WITHDRAWN: ['Withdrawn', ''], EXCUSED: ['Excused', 'green'], CANCELLED: ['Cancelled', 'red'],
};
const PAID: Record<string, [string, string]> = { PAID: ['Paid', 'green'], PART: ['Part paid', 'orange'], UNPAID: ['Not paid', 'red'], REFUND_DUE: ['Credit due back', 'orange'] };

/**
 * Additional charges: CBSE registration, trips, events. The fee desk raises them, the principal
 * approves, parents reply in the app (or a teacher records a paper slip). Refunds live here too.
 */
export default function Charges({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const office = ['ACCOUNTANT', 'SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role);
  const [tab, setTab] = useState<'charges' | 'refunds'>(() => (new URLSearchParams(location.search).get('tab') === 'refunds' ? 'refunds' : 'charges'));
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/charges` : null, [schoolId]);
  const [raise, setRaise] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">{office ? 'Charges and trips' : 'Trips and activities'}</span><span className="spacer" />
        {office && <div className="seg"><button className={tab === 'charges' ? 'on' : ''} onClick={() => setTab('charges')}>Charges</button><button className={tab === 'refunds' ? 'on' : ''} onClick={() => setTab('refunds')}>Refunds</button></div>}
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
        {office && tab === 'charges' && user.role !== 'NES_ADMIN' && <button className="btn small" onClick={() => setRaise(true)}>Raise a charge</button>}
      </div></div>
      <main className="page">
        {tab === 'refunds' ? <Refunds schoolId={schoolId} /> : (
          <section className="tile">
            <div className="tile-head"><div><h2>{office ? 'Beyond the fee plan' : 'Your trips and your class'}</h2>
              <p className="muted" style={{ marginTop: 6 }}>{office ? 'CBSE registration, trips, events. Compulsory charges bill every child in the chosen classes; optional ones bill only those whose parents say yes.' : 'Who is going and who has paid. Record a paper reply from a parent here.'}</p></div></div>
            {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No charges yet.</Empty> : (
              <div className="scroll-x"><table className="table">
                <thead><tr><th>Charge</th><th>For</th><th className="num">Amount</th><th>Due</th><th>Children</th>{office && <th className="num">Collected</th>}<th>Status</th></tr></thead>
                <tbody>{list.data.map((c) => (
                  <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                    <td><div style={{ fontWeight: 600 }}>{c.title}</div><div className="tiny muted">{c.head}{c.in_charge ? ` · ${c.in_charge}` : ''}</div></td>
                    <td className="small">{c.sections?.join(', ') ?? `Class ${c.class_codes.join(', ')}`}<div className="tiny muted">{c.mode === 'OPTIONAL' ? `Optional · reply by ${day(c.respond_by)}${c.capacity ? ` · ${c.capacity} places` : ''}` : 'Compulsory'}</div></td>
                    <td className="num">{money(c.amount_paise)}</td>
                    <td className="small">{day(c.due_on)}</td>
                    <td className="small">{c.counts?.IN ?? 0} in{c.counts?.AWAITING ? ` · ${c.counts.AWAITING} to reply` : ''}{c.counts?.WAITLIST ? ` · ${c.counts.WAITLIST} waiting` : ''}</td>
                    {office && <td className="num small">{money(c.collectedPaise ?? 0)}<div className="tiny muted">of {money(c.chargedPaise ?? 0)}</div></td>}
                    <td><span className={`pill ${c.status === 'OPEN' ? 'green' : c.status === 'DRAFT' ? 'blue' : c.status === 'CANCELLED' ? 'red' : ''}`}>{c.status === 'DRAFT' ? 'Waiting for approval' : words(c.status)}</span></td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </section>
        )}
      </main>
      {raise && <RaiseDrawer schoolId={schoolId} onClose={(id) => { setRaise(false); list.reload(); if (id) setOpen(id); }} />}
      {open && <ChargeDrawer id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </>
  );
}

function RaiseDrawer({ schoolId, onClose }: { schoolId: string; onClose: (id?: string) => void }) {
  const { run, busy } = useAction();
  const { data: heads } = useLoad<any[]>('/fee-heads');
  const { data: teachers } = useLoad<any[]>(`/schools/${schoolId}/teachers`);
  const [f, setF] = useState({ head: 'TRIP', title: '', details: '', amount: '', mode: 'OPTIONAL', classes: [] as string[], dueOn: '', respondBy: '', capacity: '', refundableUntil: '', inChargeId: '' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  useEffect(() => { if (f.head === 'CBSE' || f.head === 'OTHER') set({ mode: 'COMPULSORY' }); }, [f.head]); // eslint-disable-line react-hooks/exhaustive-deps
  const optional = f.mode === 'OPTIONAL';
  return (
    <Drawer title="Raise a charge" onClose={() => onClose()}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Type</span><select className="input" value={f.head} onChange={(e) => set({ head: e.target.value })}>
            {(heads ?? []).filter((h) => h.kind === 'CHARGE').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</select></label>
          <label className="field"><span>Amount per child (₹)</span><input className="input" inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d]/g, '') })} /></label>
        </div>
        <label className="field"><span>Title (parents see this)</span><input className="input" value={f.title} placeholder={f.head === 'CBSE' ? 'CBSE registration, Class IX' : 'Educational trip to Lonavala, 14 November'} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field"><span>Details</span><textarea className="input" rows={2} value={f.details} placeholder="What it covers, timings, what to bring" onChange={(e) => set({ details: e.target.value })} /></label>
        <div className="field"><span>Classes</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{CLASSES.map((c) => (
          <label key={c} className="check small" style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '2px 8px' }}><input type="checkbox" checked={f.classes.includes(c)} onChange={(e) => set({ classes: e.target.checked ? [...f.classes, c] : f.classes.filter((x) => x !== c) })} /> {c}</label>))}</div></div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend className="small muted" style={{ marginBottom: 6 }}>Who pays</legend>
          <label className="check"><input type="radio" checked={!optional} onChange={() => set({ mode: 'COMPULSORY' })} /> Every child in these classes (for example CBSE registration)</label>
          <label className="check"><input type="radio" checked={optional} onChange={() => set({ mode: 'OPTIONAL' })} /> Only children whose parents say yes (for example a trip)</label>
        </fieldset>
        <div className="form-grid">
          <label className="field"><span>Payment due by</span><input className="input" type="date" min={today()} value={f.dueOn} onChange={(e) => set({ dueOn: e.target.value })} /></label>
          {optional && <label className="field"><span>Parents reply by</span><input className="input" type="date" min={today()} max={f.dueOn || undefined} value={f.respondBy} onChange={(e) => set({ respondBy: e.target.value })} /></label>}
          {optional && <label className="field"><span>Places (optional)</span><input className="input" inputMode="numeric" value={f.capacity} placeholder="No limit" onChange={(e) => set({ capacity: e.target.value.replace(/[^\d]/g, '') })} /></label>}
          <label className="field"><span>Money back if withdrawn by</span><input className="input" type="date" min={today()} value={f.refundableUntil} onChange={(e) => set({ refundableUntil: e.target.value })} /></label>
          <label className="field"><span>Teacher in charge</span><select className="input" value={f.inChargeId} onChange={(e) => set({ inChargeId: e.target.value })}><option value="">None</option>
            {(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        </div>
        <p className="small muted">{['CBSE', 'TRIP', 'EVENT'].includes(f.head) ? 'Money collected for CBSE or a trip operator is held separately and paid out; it is not school income.' : 'This is school income.'} The principal approves before parents see it.</p>
        <button className="btn big" disabled={busy || !f.title || !f.amount || !f.classes.length || !f.dueOn || (optional && !f.respondBy)} onClick={async () => {
          const r: any = await run(() => api('/charges', { body: { schoolId, year: currentYear(), head: f.head, title: f.title, details: f.details, amountPaise: Number(f.amount) * 100, mode: f.mode,
            classCodes: f.classes, dueOn: f.dueOn, respondBy: optional ? f.respondBy : null, capacity: optional && f.capacity ? Number(f.capacity) : null,
            refundableUntil: f.refundableUntil || null, inChargeId: f.inChargeId || null } }), 'Sent to the principal for approval');
          if (r) onClose(r.id);
        }}>Send for approval</button>
      </section>
    </Drawer>
  );
}

function ChargeDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useLoad<any>(`/charges/${id}`);
  const { run, busy } = useAction();
  const toast = useToast();
  const [excuse, setExcuse] = useState<any>(null);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [payout, setPayout] = useState(false);
  const [po, setPo] = useState({ amount: '', payee: '', reference: '', paidOn: today() });
  const [filter, setFilter] = useState('all');
  const c = d.data;
  const act = async (path: string, body: unknown, msg: string) => { if (await run(() => api(`/charges/${id}/${path}`, { body }), msg)) d.reload(); };
  const people = (c?.people ?? []).filter((p: any) => filter === 'all' || (filter === 'in' ? p.status === 'IN' : filter === 'unpaid' ? p.paid === 'UNPAID' || p.paid === 'PART' : p.status === 'AWAITING'));
  return (
    <Drawer title={c?.title ?? 'Charge'} onClose={onClose}>
      {!c ? <Empty>Loading…</Empty> : (<>
        <section className="tile tight stack">
          <div className="small muted">{c.head} · {money(c.amount_paise)} per child · due {day(c.due_on)} · {c.mode === 'OPTIONAL' ? `optional, reply by ${day(c.respond_by)}${c.capacity ? `, ${c.capacity} places` : ''}` : 'compulsory'}{c.refundable_until ? ` · refundable until ${day(c.refundable_until)}` : ''}</div>
          {c.details && <p className="small">{c.details}</p>}
          <div className="tiny muted">Raised by {c.raised_by}{c.approved_by ? `, approved by ${c.approved_by}` : ''}{c.in_charge ? ` · in charge: ${c.in_charge}` : ''}</div>
          {c.status === 'CANCELLED' && <div className="callout red small">Cancelled: {c.cancel_reason}</div>}
          {c.chargedPaise !== undefined && <div className="kpis" style={{ marginTop: 8 }}>
            <div><div className="kpi-label">Charged</div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{money(c.chargedPaise)}</div></div>
            <div><div className="kpi-label">Collected</div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{money(c.collectedPaise)}</div></div>
            <div><div className="kpi-label">Outstanding</div><div className="kpi-value" style={{ fontSize: '1.4rem', color: c.outstandingPaise ? 'var(--red)' : undefined }}>{money(c.outstandingPaise)}</div></div>
            {['2300', '2310'].includes(c.account) && <div><div className="kpi-label">Paid out</div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{money(c.paidOutPaise)}</div></div>}
          </div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {c.status === 'DRAFT' && c.canApprove && <button className="btn small" disabled={busy} onClick={() => act('approve', {}, c.mode === 'COMPULSORY' ? 'Approved. Every child is charged and parents are told.' : 'Approved. Parents are asked to reply.')}>Approve</button>}
            {c.status === 'DRAFT' && c.canManage && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/charges/${id}/discard`, { body: {} }), 'Draft discarded')) onClose(); }}>Discard draft</button>}
            {c.status === 'OPEN' && c.canManage && <button className="btn quiet small" disabled={busy} onClick={() => act('refresh', {}, 'New children in these classes added')}>Add new children</button>}
            {c.status === 'OPEN' && c.canManage && c.mode === 'OPTIONAL' && <button className="btn quiet small" disabled={busy} onClick={() => act('close', {}, 'Replies closed')}>Close replies</button>}
            {['2300', '2310'].includes(c.account) && c.canManage && c.status !== 'DRAFT' && <button className="btn quiet small" onClick={() => setPayout(!payout)}>Record a payout</button>}
            {c.canApprove && ['OPEN', 'CLOSED'].includes(c.status) && <button className="btn danger small" onClick={() => setCancel(!cancel)}>Cancel charge</button>}
          </div>
          {cancel && <div className="callout red stack small"><span>Every child's charge is reversed. Anyone who paid gets the money adjusted or refunded, as the school has set. Parents are told the reason.</span>
            <input className="input" placeholder="Reason, for example: trip called off due to heavy rain" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn danger small" disabled={busy || reason.trim().length < 5} onClick={async () => { const r: any = await run(() => api(`/charges/${id}/cancel`, { body: { reason } })); if (r) { toast(`Cancelled. ${r.paidBack} paid families will get their money back.`); setCancel(false); d.reload(); } }}>Cancel for everyone</button></div>}
          {payout && <div className="callout stack small"><div className="form-grid">
            <label className="field"><span>Paid to</span><input className="input" value={po.payee} placeholder={c.head_code === 'CBSE' ? 'CBSE' : 'Tour operator'} onChange={(e) => setPo({ ...po, payee: e.target.value })} /></label>
            <label className="field"><span>Amount (₹)</span><input className="input" inputMode="numeric" value={po.amount} onChange={(e) => setPo({ ...po, amount: e.target.value.replace(/[^\d]/g, '') })} /></label>
            <label className="field"><span>Date</span><input className="input" type="date" value={po.paidOn} onChange={(e) => setPo({ ...po, paidOn: e.target.value })} /></label>
            <label className="field"><span>Bank or challan reference</span><input className="input" value={po.reference} onChange={(e) => setPo({ ...po, reference: e.target.value })} /></label></div>
            <button className="btn small" disabled={busy || !po.amount || !po.payee || !po.reference} onClick={async () => { if (await run(() => api(`/charges/${id}/payouts`, { body: { amountPaise: Number(po.amount) * 100, paidOn: po.paidOn, payee: po.payee, reference: po.reference } }), 'Payout recorded')) { setPayout(false); d.reload(); } }}>Save payout</button>
            {c.payouts.map((p: any, i: number) => <div key={i} className="tiny muted">{day(p.paid_on)} · {money(p.amount_paise)} to {p.payee} · {p.reference}</div>)}</div>}
        </section>
        {c.status !== 'DRAFT' && <section className="tile tight">
          <div className="tile-head" style={{ marginBottom: 8 }}><h3>{num(c.people.length)} children</h3>
            <div className="seg">{[['all', 'All'], ['in', 'In'], ['unpaid', 'Not paid'], ...(c.mode === 'OPTIONAL' ? [['awaiting', 'No reply']] : [])].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div></div>
          {people.map((p: any) => {
            const [sl, st] = STATUS[p.status] ?? [p.status, ''];
            const [pl, pt] = p.paid ? PAID[p.paid] : ['', ''];
            return (
              <div key={p.enrolmentId} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div><strong>{p.name}</strong> <span className="muted">· {p.class} · {p.admissionNo}</span>
                  {p.note && <div className="tiny muted">{p.note}{p.repliedBy ? ` · ${p.repliedBy}, ${time(p.repliedAt)}` : ''}</div>}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <span className={`pill ${st}`}>{sl}</span>{pl && <span className={`pill ${pt}`}>{pl}{p.owedPaise !== undefined && p.paid !== 'PAID' ? ` · ${money(p.owedPaise - p.paidPaise)}` : ''}</span>}
                  {c.status === 'OPEN' && c.mode === 'OPTIONAL' && ['AWAITING', 'DECLINED', 'NO_REPLY'].includes(p.status) && <button className="btn quiet small" disabled={busy} onClick={() => act('reply', { studentId: p.studentId, going: true, note: 'Paper slip' }, `${p.name} added`)}>Mark going</button>}
                  {c.status === 'OPEN' && c.mode === 'OPTIONAL' && p.status === 'AWAITING' && <button className="btn quiet small" disabled={busy} onClick={() => act('reply', { studentId: p.studentId, going: false, note: 'Paper slip' }, `${p.name}: not going`)}>Not going</button>}
                  {c.canApprove && !['EXCUSED', 'CANCELLED'].includes(p.status) && c.status !== 'CANCELLED' && <button className="btn quiet small" onClick={() => { setExcuse(p); setReason(''); }}>Excuse</button>}
                </div>
              </div>);
          })}
          {!people.length && <Empty>No children in this view.</Empty>}
        </section>}
        {excuse && <section className="callout stack small"><strong>Excuse {excuse.name}</strong><span>Any charge is reversed and the reason is kept with the record.</span>
          <input className="input" placeholder="Reason, for example: exempted by CBSE, or financial hardship" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy || reason.trim().length < 5} onClick={async () => { if (await run(() => api(`/charges/${id}/excuse`, { body: { studentId: excuse.studentId, reason } }), `${excuse.name} excused`)) { setExcuse(null); d.reload(); } }}>Excuse</button>
            <button className="btn quiet small" onClick={() => setExcuse(null)}>Back</button></div></section>}
      </>)}
    </Drawer>
  );
}

function Refunds({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/refunds` : null, [schoolId]);
  const { run, busy } = useAction();
  const [pay, setPay] = useState<Record<string, { method: string; reference: string }>>({});
  return (
    <section className="tile">
      <div className="tile-head"><div><h2>Refunds</h2><p className="muted" style={{ marginTop: 6 }}>A refund that follows a rule (a cancelled trip, a withdrawal before the refund date) is ready to pay. Any other refund is approved first. Record the transfer once the money has gone.</p></div></div>
      {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No refunds.</Empty> : list.data.map((r) => {
        const f = pay[r.id] ?? { method: 'BANK_TRANSFER', reference: '' };
        return (
          <div key={r.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div><strong>{r.student}</strong> <span className="muted small">· {r.class_code} · {r.admission_no}</span>
              <div className="small">{money(r.amount_paise)} · {r.charge ?? r.bill} · {r.reason}</div>
              <div className="tiny muted">Raised by {r.requested_by}, {time(r.requested_at)}{r.paid_at ? ` · paid by ${r.paid_by}, ${time(r.paid_at)} · ${words(r.method)} ${r.reference}` : ''}</div>
              {r.status === 'APPROVED' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <select className="input" style={{ height: 34, width: 'auto' }} value={f.method} onChange={(e) => setPay({ ...pay, [r.id]: { ...f, method: e.target.value } })} aria-label="Method">
                  <option value="BANK_TRANSFER">Bank transfer</option><option value="CHEQUE">Cheque</option><option value="CASH">Cash</option></select>
                <input className="input" style={{ height: 34, flex: '1 1 160px' }} placeholder="UTR, cheque or voucher number" value={f.reference} onChange={(e) => setPay({ ...pay, [r.id]: { ...f, reference: e.target.value } })} aria-label="Reference" />
                <button className="btn small" disabled={busy || f.reference.trim().length < 3} onClick={async () => { if (await run(() => api(`/refunds/${r.id}/pay`, { body: f }), 'Refund recorded; the parent is told')) list.reload(); }}>Mark paid</button>
              </div>}
            </div>
            <span className={`pill ${r.status === 'PAID' ? 'green' : r.status === 'APPROVED' ? 'blue' : r.status === 'REJECTED' ? 'red' : 'orange'}`}>{r.status === 'APPROVED' ? 'Ready to pay' : r.status === 'PENDING' ? 'Waiting for approval' : words(r.status)}</span>
          </div>);
      })}
    </section>
  );
}
