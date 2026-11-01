import { Link } from 'react-router-dom';
import { day, money, type User } from '../api';
import { Icon, useLoad } from '../ui';

export interface Work { to: string; label: string; icon: string }

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

/** Home for support staff (office, gate, grounds, laboratory, infirmary, buses): their work first, then leave, pay and notices. */
export default function StaffHome({ user, work }: { user: User; work: Work[] }) {
  const leave = useLoad<{ balances: { code: string; name: string; balance: number }[]; requests: { id: string; leave: string; from: string; to: string; status: string }[] }>('/staff-leave/mine');
  const pay = useLoad<{ slips: { run_id: string; title: string; net: number }[] }>('/my/pay');
  const notices = useLoad<{ id: string; title: string; created_at: string; issued_by_unit: string }[]>('/notices');
  const slip = pay.data?.slips[0];
  const waiting = (leave.data?.requests ?? []).filter((r) => r.status === 'PENDING');
  const balances = (leave.data?.balances ?? []).filter((b) => b.balance > 0 || ['CL', 'EL'].includes(b.code));
  return (
    <main className="page">
      <section className="tile">
        <div className="small muted" style={{ fontWeight: 600 }}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1 style={{ marginTop: 6 }}>{greeting()}, {user.name.split(' ').slice(1).join(' ') || user.name}</h1>
        <p className="muted" style={{ marginTop: 6 }}>{user.designation}</p>
      </section>

      {work.length > 0 && <section aria-label="Your work" className="work-grid">
        {work.map((w) => <Link key={w.to} to={w.to} className="work-tile"><span className="work-icon"><Icon d={w.icon} size={24} /></span>{w.label}</Link>)}
      </section>}

      <div className="row">
        <section className="tile tight" style={{ flex: '1 1 300px' }}>
          <div className="tile-head" style={{ marginBottom: 8 }}><h3>Leave</h3><Link to="/my/pay" className="btn small">Apply for leave</Link></div>
          {!leave.data ? <p className="small muted">Loading…</p> : <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{balances.map((b) => <span key={b.code} className="pill">{b.name}: <b>{b.balance}</b></span>)}</div>
            {waiting.length > 0 && <p className="small" style={{ marginTop: 10 }}>{waiting.length} request{waiting.length === 1 ? ' is' : 's are'} waiting: {waiting.map((r) => `${r.leave} from ${day(r.from)}`).join('; ')}</p>}
          </>}
        </section>
        <section className="tile tight" style={{ flex: '1 1 300px' }}>
          <div className="tile-head" style={{ marginBottom: 8 }}><h3>Pay</h3><Link to="/my/pay" className="small">Payslips and tax</Link></div>
          {!pay.data ? <p className="small muted">Loading…</p> : slip
            ? <p><span className="small muted">{slip.title}</span><br /><b style={{ fontSize: '1.4rem', color: 'var(--navy)' }}>{money(slip.net)}</b> <span className="small muted">paid to your bank</span></p>
            : <p className="small muted">Your payslips appear here after the first salary run of the year.</p>}
        </section>
      </div>

      <section className="tile tight">
        <div className="tile-head" style={{ marginBottom: 6 }}><h3>Notices</h3><Link to="/notices" className="small">All</Link></div>
        {!notices.data ? <p className="small muted">Loading…</p> : notices.data.length === 0 ? <p className="small muted">No notices.</p> : (
          <div className="day-list">{notices.data.slice(0, 4).map((n) => (
            <Link key={n.id} to={`/notices/${n.id}`} style={{ color: 'var(--ink)', textDecoration: 'none' }}>
              <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600 }}>{n.title}</b><div className="small muted">{n.issued_by_unit} · {day(n.created_at)}</div></span><span className="muted">›</span>
            </Link>))}</div>)}
      </section>
    </main>
  );
}
