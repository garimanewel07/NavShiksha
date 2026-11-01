import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, day, money, today } from '../../api';
import { Empty, ask, useAction, useLoad } from '../../ui';
import { ReceiptDrawer } from '../Payments';
import { ChildSwitcher, useChildren } from './ParentHome';

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/**
 * A quarter paid month by month: this month's share is a third of the quarter, less what is already
 * paid towards the months so far. Only for bills that cover more than one month.
 */
function monthlyPart(g: { kind: string; owed: number; paid: number; due: number; start: string | null; end: string | null }) {
  if (g.kind !== 'INSTALMENT' || !g.start || !g.end) return null;
  const months = (Number(g.end.slice(0, 4)) - Number(g.start.slice(0, 4))) * 12 + Number(g.end.slice(5, 7)) - Number(g.start.slice(5, 7));
  if (months < 2) return null;
  const t = today();
  const elapsed = Math.min(months, Math.max(1, (Number(t.slice(0, 4)) - Number(g.start.slice(0, 4))) * 12 + Number(t.slice(5, 7)) - Number(g.start.slice(5, 7)) + 1));
  const share = Math.ceil(g.owed / months / 100) * 100;
  let amount = Math.min(g.due, Math.max(0, share * elapsed - g.paid));
  let month = Number(g.start.slice(5, 7)) - 1 + elapsed - 1;
  if (amount <= 0) { amount = Math.min(g.due, share); month += 1; }                     // this month is paid: offer the next one
  if (amount >= g.due) return null;
  const name = MONTH[month % 12];
  return { amount, label: elapsed > 1 && share * elapsed - g.paid > share ? `up to ${name}` : name };
}

const METHODS: [string, string, number][] = [['UPI', 'UPI', 0], ['DEBIT_CARD', 'Debit card', 0], ['NET_BANKING', 'Net banking', 0], ['CREDIT_CARD', 'Credit card', 150]];

/** Pay fees: the amount is worked out by the server; the browser only says which instalments. */
export default function ParentPay() {
  const { children, current, choose } = useChildren();
  const dues = useLoad<any[]>(current ? `/students/${current.id}/dues` : null, [current?.id]);
  const extra = useLoad<any[]>(current ? `/students/${current.id}/charges` : null, [current?.id]);
  const credits = useLoad<any[]>(current ? `/students/${current.id}/credits` : null, [current?.id]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const opts = useLoad<{ monthlyParts: boolean; wholeYear: { installments: { code: string; label: string; dueDate: string; amountPaise: number }[]; totalPaise: number } | null }>(current ? `/students/${current.id}/pay-options` : null, [current?.id]);
  const fam = useLoad<any>(current ? `/students/${current.id}/family` : null, [current?.id]);
  const [partOf, setPartOf] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState('UPI');
  const [order, setOrder] = useState<any>(null);
  const [key] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<string | null>(null);
  const { run, busy } = useAction();
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; enrolmentId: string; bill: string; kind: string; label: string; detail: string | null; due_date: string; school: string; due: number; owed: number; paid: number; start: string | null; end: string | null; lines: any[] }>();
    for (const d of dues.data ?? []) {
      if (d.due_paise <= 0) continue;
      const k = `${d.enrolment_id}:${d.bill}`;
      const g = m.get(k) ?? { key: k, enrolmentId: d.enrolment_id, bill: d.bill, kind: d.kind, label: d.label, detail: d.detail, due_date: d.due_date, school: d.school, due: 0, owed: 0, paid: 0, start: d.period_start, end: d.period_end, lines: [] as any[] };
      g.due += d.due_paise; g.owed += d.owed_paise; g.paid += d.paid_paise; g.lines.push(d); m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, part: monthlyPart(g) }));
  }, [dues.data]);
  const chosen = groups.filter((g) => picked[g.key] ?? true);
  const payOf = (g: (typeof groups)[number]) => (partOf[g.key] && g.part ? g.part.amount : g.due);
  const total = chosen.reduce((s, g) => s + payOf(g), 0);
  const charge = Math.round((total * (METHODS.find((m) => m[0] === method)?.[2] ?? 0)) / 10000);
  const schools = new Set(chosen.map((g) => g.school));

  if (order) {
    return (
      <div className="app-shell">
        <section className="card stack" style={{ textAlign: 'center', padding: 28 }}>
          <span className="pill" style={{ alignSelf: 'center' }}>Sandbox bank · test payment</span>
          <div className="small muted">Paying {current?.name}'s fees</div>
          <div style={{ fontFamily: 'var(--display)', fontSize: '2.8rem', fontWeight: 600 }}>{money(order.amount_paise + order.charge_paise)}</div>
          <div className="tiny muted mono">{order.gateway_order_id}</div>
          <button className="btn big" disabled={busy} onClick={async () => {
            const r: any = await run(() => api(`/payments/orders/${order.id}/sandbox`, { body: { outcome: 'success' } }));
            if (r?.receiptNo) { setReceipt(r.receiptNo); setOrder(null); dues.reload(); }
          }}>Approve payment</button>
          <button className="btn danger" disabled={busy} onClick={async () => { await run(() => api(`/payments/orders/${order.id}/sandbox`, { body: { outcome: 'failure' } }), 'Payment declined by the bank. You were not charged.'); setOrder(null); }}>Decline</button>
        </section>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <Link to="/" className="back">‹ Home</Link>
      <h2 className="app-title">Fees</h2>
      <ChildSwitcher kids={children} current={current} choose={choose} />
      {!dues.data ? <Empty>Loading…</Empty> : groups.length === 0 ? <section className="card"><span className="pill green">Nothing due</span><p className="small muted" style={{ marginTop: 8 }}>All fees raised so far are paid.</p></section> : (
        <>
          <section className="card stack">
            <div className="due-head"><span className="small muted">Due now</span>
              <span className="due-total">{money(groups.reduce((n, g) => n + g.due, 0))}</span>
              {groups.some((g) => g.due_date < today()) && <span className="pill orange">Overdue</span>}</div>
            {groups.map((g) => (
              <label key={g.key} className="list-row" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto', cursor: 'pointer' }}>
                <input type="checkbox" checked={picked[g.key] ?? true} onChange={(e) => setPicked({ ...picked, [g.key]: e.target.checked })} style={{ width: 20, height: 20 }} />
                <span><span style={{ display: 'block', fontWeight: 600 }}>{g.kind === 'INSTALMENT' ? `${g.bill} · ` : ''}{g.label}</span><span className="tiny muted">Due {day(g.due_date)} · {g.lines.map((l) => l.head).join(', ')}{g.due_date < today() ? ' · overdue' : ''}</span>{g.detail && <span className="tiny" style={{ display: 'block', color: 'var(--ink-2)' }}>{g.detail}</span>}</span>
                <strong>{money(payOf(g))}</strong>
                {opts.data?.monthlyParts && g.part && <div style={{ gridColumn: '2 / -1' }} onClick={(e) => e.preventDefault()}>
                  <div className="seg" style={{ marginTop: 4 }}>
                    <button className={!partOf[g.key] ? 'on' : ''} onClick={() => setPartOf({ ...partOf, [g.key]: false })}>Pay in full</button>
                    <button className={partOf[g.key] ? 'on' : ''} onClick={() => setPartOf({ ...partOf, [g.key]: true })}>Pay {g.part.label} · {money(g.part.amount)}</button></div>
                  {partOf[g.key] && <div className="tiny muted" style={{ marginTop: 4 }}>{money(g.due - g.part.amount)} of this quarter stays due by {day(g.due_date)}.</div>}</div>}
              </label>
            ))}
          </section>
          <section className="card stack">
            <div className="small muted">Pay with</div>
            {METHODS.map(([code, label, bps]) => (
              <label key={code} className="list-row" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto', cursor: 'pointer' }}>
                <input type="radio" name="method" checked={method === code} onChange={() => setMethod(code)} />
                <span style={{ fontWeight: 600 }}>{label}</span>
                <span className={`pill ${bps ? 'orange' : 'green'}`}>{bps ? `${bps / 100}% charge` : 'No charge'}</span>
              </label>
            ))}
          </section>
          {schools.size > 1 && <div className="callout orange small">These instalments belong to different schools. Pay each school separately.</div>}
          <button className="btn big" disabled={busy || !chosen.length || schools.size > 1} onClick={async () => {
            const o = await run(() => api('/payments/orders', { body: { studentId: current!.id, method, idempotencyKey: `${key}:${method}:${chosen.map((g) => g.key).join(',')}`,
              items: chosen.map((g) => ({ enrolmentId: g.enrolmentId, bill: g.bill, ...(partOf[g.key] && g.part ? { amountPaise: g.part.amount } : {}) })) } }));
            if (o) setOrder(o);
          }}>Pay {money(total + charge)}{charge ? ` (incl. ${money(charge)} card charge)` : ''}</button>
        </>
      )}
      {(extra.data ?? []).length > 0 && <Activities rows={extra.data!} studentId={current!.id} onChange={() => { extra.reload(); dues.reload(); credits.reload(); }} />}
      {fam.data?.pta?.billedTo && fam.data.members.length > 1 && <div className={`callout small ${fam.data.pta.billedTo.paid ? 'green' : 'blue'}`}>
        {fam.data.pta.billedTo.studentId === current?.id
          ? <>The PTA fee of {money(fam.data.pta.billedTo.amount)} is for the whole family ({fam.data.members.map((m: any) => m.name.split(' ')[0]).join(', ')}); it is billed with {current?.name.split(' ')[0]}’s fees only{fam.data.pta.billedTo.paid ? ' and is paid.' : '.'}</>
          : <>The family’s PTA fee is billed with {fam.data.pta.billedTo.name.split(' ')[0]}’s fees{fam.data.pta.billedTo.paid ? ' and is paid' : ''}. {current?.name.split(' ')[0]} does not pay it again.</>}</div>}
      {(credits.data ?? []).map((c) => <div key={c.bill} className="callout green small">You have a credit of {money(c.credit_paise)}.{c.refund_status === 'APPROVED' ? ' A refund is on its way.' : c.refund_status === 'PENDING' ? ' A refund is waiting for approval.' : ' It will be taken off your next fees, or refunded on request to the school office.'}</div>)}
      {opts.data?.wholeYear && <section className="card stack">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><b style={{ flex: 1 }}>Pay for the whole year</b><b>{money(opts.data.wholeYear.totalPaise)}</b></div>
        <span className="tiny muted">The rest of this year’s fees ({opts.data.wholeYear.installments.map((i) => i.label).join(', ')}) are not billed yet. Add them now to pay everything together; each is charged exactly as it would be later.</span>
        <button className="btn quiet" disabled={busy} onClick={async () => {
          if (!await ask(`Add the rest of the year’s fees (${money(opts.data!.wholeYear!.totalPaise)}) to pay now?`, { ok: 'Add them' })) return;
          if (await run(() => api(`/students/${current!.id}/fees/whole-year`, { body: {} }), 'The rest of the year is added: pay it with the other dues below')) { setPicked({}); dues.reload(); opts.reload(); }
        }}>Add the rest of the year</button>
      </section>}
      {receipt && <ReceiptDrawer no={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  IN: ['Taking part', 'green'], DECLINED: ['Not taking part', ''], WAITLIST: ['On the waiting list', 'orange'], AWAITING: ['Please reply', 'blue'],
  NO_REPLY: ['No reply given', ''], WITHDRAWN: ['Withdrawn', ''], EXCUSED: ['Excused by the school', 'green'], CANCELLED: ['Cancelled', 'red'],
};

/** Trips, events and other charges: compulsory ones are listed; optional ones ask the parent. */
function Activities({ rows, studentId, onChange }: { rows: any[]; studentId: string; onChange: () => void }) {
  const { run, busy } = useAction();
  const reply = async (r: any, going: boolean) => {
    const res: any = await run(() => api(`/charges/${r.id}/reply`, { body: { studentId, going } }));
    if (!res) return;
    onChange();
  };
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="small muted">Trips, events and other charges</div>
      {rows.map((r) => {
        const [label, tone] = r.mode === 'COMPULSORY' && r.my_status === 'IN' ? ['For every child in the class', 'blue'] : STATUS[r.my_status] ?? [r.my_status, ''];
        return (
          <div key={r.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{r.title}</div>
              <div className="tiny muted">{money(r.amount_paise)} · {r.head}{r.mode === 'OPTIONAL' && r.status === 'OPEN' ? ` · reply by ${day(r.respond_by)}` : ''}{r.seatsLeft !== null && r.status === 'OPEN' ? ` · ${r.seatsLeft} places left` : ''}{r.in_charge ? ` · teacher in charge: ${r.in_charge}` : ''}</div>
              {r.details && <div className="tiny" style={{ color: 'var(--ink-2)' }}>{r.details}</div>}
              {r.status === 'CANCELLED' && <div className="tiny" style={{ color: 'var(--red)' }}>Cancelled: {r.cancel_reason}</div>}
              {r.my_status === 'IN' && r.mode === 'OPTIONAL' && r.status === 'OPEN' && <div className="tiny muted">{r.refundableNow ? `Withdraw by ${day(r.refundable_until ?? r.due_on)} to get the money back.` : 'Withdrawing now does not refund the amount.'}</div>}
              {r.canReply && confirm === r.id && <div className="callout orange small" style={{ marginTop: 8 }}>
                {r.refundableNow ? 'Your child will be taken off the list. Any amount paid is adjusted or refunded.' : 'The refund date has passed, so the amount stays due.'}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn small danger" disabled={busy} onClick={() => { setConfirm(null); reply(r, false); }}>Withdraw</button><button className="btn quiet small" onClick={() => setConfirm(null)}>Keep the place</button></div></div>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
              <span className={`pill ${tone}`}>{label}</span>
              {r.canReply && ['AWAITING', 'DECLINED', 'NO_REPLY', 'WITHDRAWN'].includes(r.my_status) && <button className="btn small" disabled={busy} onClick={() => reply(r, true)}>Yes, taking part</button>}
              {r.canReply && r.my_status === 'AWAITING' && <button className="btn quiet small" disabled={busy} onClick={() => reply(r, false)}>No</button>}
              {r.canReply && ['IN', 'WAITLIST'].includes(r.my_status) && <button className="btn quiet small" disabled={busy} onClick={() => (r.my_status === 'IN' ? setConfirm(r.id) : reply(r, false))}>{r.my_status === 'IN' ? 'Withdraw' : 'Leave the waiting list'}</button>}
            </div>
          </div>);
      })}
    </section>
  );
}
