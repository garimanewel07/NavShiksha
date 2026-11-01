import { Link } from 'react-router-dom';
import { day, money, today, words, type User } from '../api';
import { Empty, useLoad, useSchools } from '../ui';

interface Standing { due: number; paid: number; overdue_children: number }
interface Collections { byDay: { day: string; method: string; receipts: number; amount_paise: number }[]; recent: { receipt_no: string; amount_paise: number; method: string; captured_at: string; student: string; nes_id: string }[] }
interface Refund { id: string; amount_paise: number; status: string; student: string; class_code: string; charge: string | null; reason: string | null }
interface Run { id: string; month: string; kind: string; status: string; title: string }
interface Charge { id: string; title: string; due_on: string | null; status: string; amount_paise: number }

const RUN_NEXT: Record<string, string> = { DRAFT: 'Draft: enter the month’s inputs and submit to the principal', SUBMITTED: 'Waiting for the principal to approve', LOCKED: 'Approved: send the bank file' };

/** The accountant's home: what came in today, where the year stands, and the work waiting. */
export default function FinanceHome({ user }: { user: User }) {
  const { schools } = useSchools();
  const id = schools[0]?.id;
  const standing = useLoad<Standing>(id ? `/schools/${id}/fees/standing` : null, [id]);
  const col = useLoad<Collections>(id ? `/payments/collections?schoolId=${id}` : null, [id]);
  const refunds = useLoad<Refund[]>(id ? `/schools/${id}/refunds` : null, [id]);
  const runs = useLoad<Run[]>(id ? `/schools/${id}/payroll` : null, [id]);
  const charges = useLoad<Charge[]>(id ? `/schools/${id}/charges` : null, [id]);
  const rec = useLoad<{ unexplained: unknown[]; notInBank: unknown[] }>(id ? `/schools/${id}/reconciliation` : null, [id]);

  const t = today();
  const todays = (col.data?.byDay ?? []).filter((d) => d.day === t);
  const inToday = todays.reduce((n, d) => n + Number(d.amount_paise), 0);
  const receiptsToday = todays.reduce((n, d) => n + d.receipts, 0);
  const s = standing.data;
  const due = Number(s?.due ?? 0), paid = Number(s?.paid ?? 0);
  const pct = due ? Math.round((paid / due) * 1000) / 10 : 0;
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const todo = [
    ...(refunds.data ?? []).filter((r) => r.status === 'PENDING' || r.status === 'APPROVED').map((r) => ({
      key: r.id, tone: r.status === 'APPROVED' ? 'orange' : 'blue', tag: r.status === 'APPROVED' ? 'Pay out' : 'Waiting',
      title: `Refund ${money(r.amount_paise)} to ${r.student} (${r.class_code})`, note: r.charge ?? r.reason ?? '', to: '/charges' })),
    ...(runs.data ?? []).filter((r) => RUN_NEXT[r.status]).map((r) => ({ key: r.id, tone: r.status === 'DRAFT' ? 'orange' : 'blue', tag: words(r.status), title: r.title, note: RUN_NEXT[r.status], to: `/payroll/${r.id}` })),
    ...((rec.data?.unexplained.length ?? 0) > 0 ? [{ key: 'bank', tone: 'orange', tag: 'Bank', title: `${rec.data!.unexplained.length} bank lines to explain`, note: 'Match them in Accounts → Bank', to: '/accounts' }] : []),
    ...(charges.data ?? []).filter((c) => c.status === 'OPEN' && c.due_on && c.due_on >= t && c.due_on <= soon).map((c) => ({
      key: c.id, tone: '', tag: 'Due soon', title: c.title, note: `${money(c.amount_paise)} a child · due ${day(c.due_on)}`, to: `/charges` })),
  ];
  const first = user.name.split(' ').slice(1).join(' ') || user.name;

  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Finance today</span><span className="spacer" />
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link to="/fees" className="btn small secondary">Fee rates</Link><Link to="/payments" className="btn small">Payments</Link></span></div></div>
      <main className="page">
        <p className="muted" style={{ margin: '4px 2px 0' }}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} · {first}</p>
        <div className="day-tiles">
          <Link to="/payments" className="day-tile">
            <span className="kpi-label">Received today</span>
            <span className="day-value">{!col.data ? '—' : receiptsToday ? money(inToday) : 'None yet'}</span>
            <span className="small muted">{receiptsToday ? `${receiptsToday} receipt${receiptsToday === 1 ? '' : 's'}` : 'Payments appear here as parents pay'}</span>
          </Link>
          <Link to="/payments" className="day-tile">
            <span className="kpi-label">Collected this year</span>
            <span className="day-value">{s ? money(paid) : '—'}</span>
            <span className="small muted">{s ? `${pct}% of ${money(due)} due so far` : 'Loading…'}</span>
            {s && <span className="bar" style={{ marginTop: 8 }}><span style={{ width: `${Math.min(100, pct)}%` }} /></span>}
          </Link>
          <div className="day-tile">
            <span className="kpi-label">Outstanding</span>
            <span className="day-value">{s ? money(Math.max(0, due - paid)) : '—'}</span>
            <span className="small muted">{s ? 'Fallen due and not yet paid' : 'Loading…'}</span>
            {s && s.overdue_children > 0 && <span className="pill orange">{s.overdue_children} children behind</span>}
          </div>
          <div className="day-tile">
            <span className="kpi-label">Waiting for you</span>
            <span className="day-value">{todo.length}</span>
            <span className="small muted">{todo.length ? 'Refunds, salaries, bank and charges' : 'Nothing waiting'}</span>
          </div>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <section className="tile tight" style={{ flex: '1 1 420px' }}>
            <div className="tile-head" style={{ marginBottom: 6 }}><h3>To do</h3></div>
            {todo.length === 0 ? <p className="small muted">Nothing is waiting: no refunds to pay, no salary run open and no charges falling due in the next 30 days.</p> : (
              <div className="day-list">{todo.map((x) => (
                <div key={x.key}>
                  {x.tag && <span className={`pill ${x.tone}`}>{x.tag}</span>}
                  <span style={{ flex: '1 1 220px', minWidth: 0 }}><b style={{ fontWeight: 600 }}>{x.title}</b>{x.note && <div className="small muted">{x.note}</div>}</span>
                  <Link to={x.to} className="btn small secondary">Open</Link>
                </div>))}</div>)}
          </section>
          <section className="tile tight" style={{ flex: '1 1 420px' }}>
            <div className="tile-head" style={{ marginBottom: 6 }}><h3>Latest receipts</h3><Link to="/payments" className="small">All payments</Link></div>
            {!col.data ? <Empty>Loading…</Empty> : col.data.recent.length === 0 ? <p className="small muted">No receipts yet.</p> : (
              <div className="day-list">{col.data.recent.slice(0, 6).map((r) => (
                <div key={r.receipt_no}>
                  <span style={{ flex: '1 1 180px', minWidth: 0 }}><b style={{ fontWeight: 600 }}>{r.student}</b><div className="tiny muted mono">{r.receipt_no}</div></span>
                  <span className="small muted">{words(r.method)} · {new Date(r.captured_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  <b className="num" style={{ minWidth: 84 }}>{money(r.amount_paise)}</b>
                </div>))}</div>)}
          </section>
        </div>
      </main>
    </>
  );
}
