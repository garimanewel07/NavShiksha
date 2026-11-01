import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, num, type User, currentYear } from '../api';
import { CatChip, ask, useAction, useLoad, useSchools } from '../ui';
import { FailedPage } from '../errors';

interface Muster {
  totals: { students: number; schools: number; provisional: number; tc_overdue: number; cat1: number };
  byCategory: { code: string; n: number }[];
  byClass: { class_code: string; name: string; ordinal: number; code: string; n: number }[];
  movement: { cat1_in: number; cat1_out: number; transfers: number; left_nes: number };
  flows: { from_school: string; to_school: string; n: number }[];
  seatPressure: { school: string; full: string[]; free: number }[];
  highlights: { tone: string; text: string; link: string }[];
}

const CATS = ['1', '1A', '2', '2B', '3', '3B', '3C', '4A', '4B'];
const TONE: Record<string, string> = { strength: 'var(--link)', action: 'var(--red)', watch: 'var(--orange)' };
const TAG: Record<string, string> = { strength: 'Strength', action: 'Needs action', watch: 'Watch' };
const short = (s: string) => s.replace('Navy Children School, ', 'NCS ').replace('Naval Kindergarten, ', 'NKG ');

/** The Muster: NES's daily roll call. Live from the database, scoped to the signed-in person. */
export default function Overview({ user }: { user: User }) {
  const { data, error } = useLoad<Muster>(`/dashboard/muster?year=${currentYear()}`);
  if (error) return <FailedPage error={error} />;
  if (!data) return <main className="page"><div className="empty">Loading the muster…</div></main>;
  const t = data.totals;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Muster</span><span className="spacer" /><span className="muted small">Academic year {currentYear().replace('-', '–')} · {user.designation}</span>
        {user.role === 'SCHOOL_ADMIN' && <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link to="/notices" className="btn small secondary">Send a notice</Link><Link to="/admissions" className="btn small">New admission</Link></span>}</div></div>
      <main className="page">
        <section className="tile muster-hero">
          <div className="eyebrow">Live · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <h1 className="muster-title">{num(t.students)} children.<br />{t.schools === 1 ? 'One school.' : `${t.schools} schools.`} One muster.</h1>
          <p style={{ marginTop: 14, fontSize: '1.24rem', maxWidth: '44ch' }}>
            {num(t.cat1)} are Cat 1. Postings brought {data.movement.cat1_in} Cat 1 children in and took {data.movement.cat1_out} out this year.
          </p>
          <div className="kpis" style={{ marginTop: 40, paddingTop: 28, borderTop: '1px solid var(--line)' }}>
            <Kpi label="Students" value={num(t.students)} note="on the rolls today" />
            <Kpi label="Cat 1 students" value={num(t.cat1)} note={`${((t.cat1 / Math.max(1, t.students)) * 100).toFixed(1)}% of strength`} />
            <Kpi label="Transfers within NES" value={num(data.movement.transfers)} note="on postings, this year" />
            <Kpi label="Left NES" value={num(data.movement.left_nes)} note="withdrawn with TC" />
            <Kpi label="Provisional" value={num(t.provisional)} note={t.tc_overdue ? `${t.tc_overdue} past TC due date` : 'awaiting original TC'} color={t.tc_overdue ? 'var(--red)' : undefined} />
          </div>
        </section>

        {user.role === 'SCHOOL_ADMIN' && <SchoolToday />}
        {['NES_ADMIN', 'COMMAND_OFFICER'].includes(user.role) && <SchoolsToday nes={user.role === 'NES_ADMIN'} />}

        <div className="grid">
          {data.highlights.map((h, i) => (
            <section key={i} className="tile tight" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 600, color: TONE[h.tone] }}>{TAG[h.tone]}</div>
              <p style={{ fontFamily: 'var(--display)', fontSize: '1.45rem', fontWeight: 600, lineHeight: 1.18 }}>{h.text}</p>
            </section>
          ))}
        </div>

        <section className="tile">
          <div className="tile-head"><div><h2>Posting flow</h2><p className="muted" style={{ marginTop: 6 }}>Children moving between NES schools on parents' postings.</p></div></div>
          {data.flows.length ? <Sankey flows={data.flows} /> : <div className="empty">No transfers yet this year.</div>}
        </section>

        <div className="row">
          <section className="tile" style={{ flex: '1.35 1 560px' }}>
            <h2>Class pyramid</h2>
            <p className="muted" style={{ marginTop: 6 }}>Every class by admission category. Deeper blue means higher priority.</p>
            <Pyramid byClass={data.byClass} byCategory={data.byCategory} />
          </section>
          <section className="tile" style={{ flex: '1 1 380px' }}>
            <h2>Seat pressure</h2>
            <p className="muted" style={{ marginTop: 6 }}>Cat 1 children cannot be refused. Schools with full classes first.</p>
            <div style={{ marginTop: 18 }}>
              {data.seatPressure.map((s) => (
                <div key={s.school} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <div><div style={{ fontWeight: 600 }}>{short(s.school)}</div><div className="small muted">{s.full.length ? `Full: Class ${s.full.join(', ')}` : 'No full classes'}</div></div>
                  <span className={`pill ${s.full.length ? 'red' : 'green'}`}>{num(s.free)} seats free</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

interface RollDay { sections: number; marked: number; present: number; absent: number; leave: number; noSchool: boolean }
interface Waiting { id: string; title: string; summary: string | null; requester: string | null; current_step: number; steps: { label: string }[] }
const STAFF_IN = ['P', 'H', 'D'];

/** The principal's day under the muster: the roll, the staff, fees and what is waiting for them. */
function SchoolToday() {
  const { schools } = useSchools();
  const id = schools[0]?.id;
  const roll = useLoad<RollDay>(id ? `/schools/${id}/attendance/day` : null, [id]);
  const register = useLoad<{ holiday: boolean; staff: { status: string | null }[] }>(id ? `/schools/${id}/staff-register` : null, [id]);
  const cover = useLoad<{ holiday: string | null; uncovered: number; absences: { id: string; teacher: string; periods: number[] | null; reason: string }[] }>(id ? `/schools/${id}/cover` : null, [id]);
  const buses = useLoad<{ id: string; code: string; name: string; legs: Record<string, { status: string; delayMin: number; note: string | null }> }[]>(id ? `/schools/${id}/transport/today` : null, [id]);
  const insights = useLoad<{ schools: { id: string; feesDue: number; feesPaid: number; collection: number | null }[] }>(id ? '/insights' : null, [id]);
  const waiting = useLoad<Waiting[]>('/approvals');
  const { run, busy } = useAction();
  if (!id) return null;
  // The same decision as on Approvals: recorded with the principal's name, and it cannot be changed afterwards.
  const decide = async (a: Waiting, approve: boolean) => {
    const next = a.current_step < a.steps.length ? a.steps[a.current_step].label.toLowerCase() : null;
    const text = approve ? (next ? `Approve “${a.title}” and send it to ${next}?` : `Approve “${a.title}”?`) : `Reject “${a.title}”?`;
    if (!await ask(`${text} Your decision is recorded with your name and cannot be changed.`, { ok: approve ? 'Approve' : 'Reject', danger: !approve })) return;
    if (await run(() => api(`/approvals/${a.id}/decide`, { body: { approve, note: '' } }), approve ? 'Approved' : 'Rejected')) { waiting.reload(); window.dispatchEvent(new Event('nes:approvals')); }
  };

  const r = roll.data;
  const counted = r ? r.present + r.absent + r.leave : 0;
  const unmarked = r ? r.sections - r.marked : 0;
  const staff = register.data?.staff ?? [];
  const staffIn = staff.filter((x) => x.status && STAFF_IN.includes(x.status)).length;
  const staffLeave = staff.filter((x) => x.status === 'L').length;
  const staffAway = staff.filter((x) => x.status === 'A').length;
  const staffOpen = staff.filter((x) => !x.status).length;
  const fees = insights.data?.schools.find((x) => x.id === id);
  const late = (buses.data ?? []).flatMap((b) => Object.entries(b.legs).filter(([, l]) => l.delayMin > 0).map(([leg, l]) => ({ key: `${b.id}:${leg}`, text: `Bus ${b.code} is ${l.delayMin} minutes late`, note: `${leg === 'MORNING' ? 'Morning pick-up' : 'Afternoon drop'} · ${b.name}${l.note ? ` · ${l.note}` : ''}` })));
  const absent = cover.data?.absences ?? [];
  const items = waiting.data ?? [];

  return (
    <>
      <div className="day-tiles">
        <Link to="/attendance" className="day-tile">
          <span className="kpi-label">Attendance today</span>
          <span className="day-value">{r && counted ? `${((r.present / counted) * 100).toFixed(1)}%` : r?.noSchool ? 'No school' : '—'}</span>
          <span className="small muted">{!r ? 'Loading…' : counted ? `${num(r.present)} of ${num(counted)} present · ${r.absent} absent · ${r.leave} on leave` : r.noSchool ? 'Sunday or a holiday: no roll today' : 'No class has taken the roll yet'}</span>
          {r && r.sections > 0 && !(r.noSchool && !counted) && (unmarked > 0 ? <span className="pill orange">{unmarked} {unmarked === 1 ? 'class' : 'classes'} not marked yet</span> : <span className="pill green">Every class marked</span>)}
        </Link>
        <Link to="/staff-register" className="day-tile">
          <span className="kpi-label">Staff today</span>
          <span className="day-value">{!staff.length ? '—' : staffOpen === staff.length ? <>{staff.length} <small>on the staff</small></> : <>{staffIn} <small>of {staff.length} in</small></>}</span>
          <span className="small muted">{register.data?.holiday ? 'Holiday' : !staff.length ? 'Loading…' : staffOpen === staff.length ? 'Nobody is marked in or out yet' : `${staffLeave} on leave · ${staffAway} absent${staffOpen ? ` · ${staffOpen} not marked` : ''}`}</span>
          {(cover.data?.uncovered ?? 0) > 0 ? <span className="pill red">{cover.data!.uncovered} {cover.data!.uncovered === 1 ? 'period needs' : 'periods need'} cover</span>
            : staff.length > 0 && staffOpen === staff.length && !register.data?.holiday ? <span className="pill orange">Register not marked yet</span> : null}
        </Link>
        <Link to="/insights" className="day-tile">
          <span className="kpi-label">Fees collected this year</span>
          <span className="day-value">{fees ? money(fees.feesPaid) : '—'}</span>
          <span className="small muted">{fees ? `${fees.collection ?? 0}% of ${money(fees.feesDue)} due so far` : 'Loading…'}</span>
          {fees && <span className="bar" style={{ marginTop: 8 }}><span style={{ width: `${Math.min(100, fees.collection ?? 0)}%` }} /></span>}
        </Link>
        <Link to="/approvals" className="day-tile">
          <span className="kpi-label">Waiting for you</span>
          <span className="day-value">{waiting.data ? items.length : '—'}</span>
          <span className="small muted">{items.length ? 'Leave, corrections and other requests' : 'Nothing to approve'}</span>
          {items.length > 0 && <span className="pill blue">Open approvals ›</span>}
        </Link>
      </div>

      <div className="row">
        <section className="tile tight" style={{ flex: '2 1 480px' }}>
          <div className="tile-head" style={{ marginBottom: 6 }}><h3>Needs you today</h3><Link to="/approvals" className="small">All approvals</Link></div>
          {!waiting.data ? <p className="small muted">Loading…</p> : items.length === 0 ? <p className="small muted">Nothing is waiting for you.</p> : (
            <div className="day-list">
              {items.slice(0, 5).map((a) => (
                <div key={a.id}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{a.title}</div>
                    <div className="small muted">{[a.summary, a.requester && `from ${a.requester}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button className="btn small" disabled={busy} onClick={() => decide(a, true)}>Approve</button>
                    <button className="btn small danger" disabled={busy} onClick={() => decide(a, false)}>Reject</button>
                  </span>
                </div>))}
            </div>)}
        </section>
        <section className="tile tight" style={{ flex: '1 1 300px' }}>
          <div className="tile-head" style={{ marginBottom: 6 }}><h3>Today on campus</h3></div>
          {cover.data?.holiday ? <p className="small muted">Holiday: {cover.data.holiday}</p> : late.length === 0 && absent.length === 0 ? <p className="small muted">No buses running late and no teachers absent.</p> : (
            <div className="day-list">
              {late.map((l) => <div key={l.key}><span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600 }}>{l.text}</b><div className="small muted">{l.note}</div></span><span className="pill orange">Late</span></div>)}
              {absent.map((a) => <div key={a.id}><span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600 }}>{a.teacher} is absent</b><div className="small muted">{a.periods ? `Periods ${a.periods.join(', ')}` : 'All day'}{a.reason ? ` · ${a.reason}` : ''}</div></span></div>)}
              {(cover.data?.uncovered ?? 0) > 0 && <div><Link to="/timetable?tab=cover" className="btn small">Arrange cover</Link></div>}
            </div>)}
        </section>
      </div>
    </>
  );
}

interface SchoolFigures { id: string; name: string; command: string; students: number; attendance: number | null; collection: number | null; flags: { level: string; text: string }[] }

/** NES and the Commands: every school in one table under the muster, worst first, with today's roll beside the month's. */
function SchoolsToday({ nes }: { nes: boolean }) {
  const { data, error } = useLoad<{ schools: SchoolFigures[] }>('/insights');
  if (error) return null;
  return (
    <section className="tile tight">
      <div className="tile-head" style={{ marginBottom: 6 }}><h3>Schools today</h3><Link to="/insights" className="small">Insights</Link></div>
      {!data ? <p className="small muted">Loading…</p> : (
        <div className="scroll-x"><table className="table compact">
          <thead><tr><th>School</th><th className="num">Students</th><th>Roll today</th><th className="num">Attendance, 30 days</th><th className="num">Fees collected</th><th>Needs attention</th></tr></thead>
          <tbody>{data.schools.map((x) => <SchoolRow key={x.id} x={x} nes={nes} />)}</tbody>
        </table></div>)}
    </section>
  );
}

function SchoolRow({ x, nes }: { x: SchoolFigures; nes: boolean }) {
  const { data: r } = useLoad<RollDay>(`/schools/${x.id}/attendance/day`, [x.id]);
  const counted = r ? r.present + r.absent + r.leave : 0;
  return (
    <tr>
      <td><b style={{ fontWeight: 600 }}>{short(x.name)}</b>{nes && <div className="tiny muted">{x.command}</div>}</td>
      <td className="num">{num(x.students)}</td>
      <td className="small">{!r ? '…' : r.sections === 0 ? <span className="muted">No classes</span> : r.marked === 0 && r.noSchool ? <span className="muted">No school today</span> : r.marked === 0 ? <span className="pill orange">Not taken</span>
        : <>{((r.present / Math.max(1, counted)) * 100).toFixed(1)}% <span className="muted">· {r.marked} of {r.sections} classes</span></>}</td>
      <td className="num">{x.attendance === null ? <span className="muted">—</span> : `${x.attendance}%`}</td>
      <td className="num">{x.collection === null ? <span className="muted">—</span> : `${x.collection}%`}</td>
      <td>{x.flags.length === 0 ? <span className="pill green">All well</span> : <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {x.flags.slice(0, 2).map((f, i) => <span key={i} className={`pill ${f.level === 'red' ? 'red' : 'orange'}`}>{f.text}</span>)}
        {x.flags.length > 2 && <span className="pill">+{x.flags.length - 2} more</span>}</span>}</td>
    </tr>
  );
}

const Kpi = ({ label, value, note, color }: { label: string; value: string; note: string; color?: string }) => (
  <div><div className="kpi-label">{label}</div><div className="kpi-value" style={{ color }}>{value}</div><div className="kpi-note">{note}</div></div>
);

function Pyramid({ byClass, byCategory }: { byClass: Muster['byClass']; byCategory: Muster['byCategory'] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { name: string; ordinal: number; total: number; cats: Record<string, number> }>();
    for (const r of byClass) {
      const x = m.get(r.class_code) ?? { name: r.name, ordinal: r.ordinal, total: 0, cats: {} };
      x.total += r.n; x.cats[r.code] = (x.cats[r.code] ?? 0) + r.n; m.set(r.class_code, x);
    }
    return [...m.values()].sort((a, b) => b.ordinal - a.ordinal);
  }, [byClass]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const total = byCategory.reduce((s, c) => s + c.n, 0) || 1;
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', margin: '18px 0 16px', fontSize: '0.78rem' }}>
        {CATS.map((c) => <span key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: `var(--cat-${c})` }} />Cat {c} <span className="muted">{Math.round(((byCategory.find((x) => x.code === c)?.n ?? 0) / total) * 100)}%</span></span>)}
      </div>
      <div role="table" aria-label="Students by class and category">
        {rows.map((r) => (
          <div role="row" key={r.name} style={{ display: 'grid', gridTemplateColumns: '92px minmax(0,1fr) 120px', gap: 14, alignItems: 'center', padding: '3px 0' }}>
            <span role="rowheader" className="small" style={{ fontWeight: 600 }}>{r.name}</span>
            <span role="cell" style={{ display: 'flex', justifyContent: 'center' }}>
              <span style={{ display: 'flex', height: 22, width: `${(r.total / max) * 100}%`, borderRadius: 5, overflow: 'hidden', gap: 1, background: 'var(--tile)' }}>
                {CATS.filter((c) => r.cats[c]).map((c) => <span key={c} title={`${r.name} · Cat ${c} · ${r.cats[c]} students`} style={{ width: `${(r.cats[c] / r.total) * 100}%`, background: `var(--cat-${c})` }} />)}
              </span>
            </span>
            <span role="cell" className="small" style={{ textAlign: 'right' }}><strong>{num(r.total)}</strong> <span className="muted">· {Math.round(((r.cats['1'] ?? 0) / r.total) * 100)}% Cat 1</span></span>
          </div>
        ))}
      </div>
    </>
  );
}

function Sankey({ flows }: { flows: Muster['flows'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 900, H = 340, k = Math.min(6, (H - 80) / flows.reduce((s, f) => s + f.n, 0) * 2.2);
  const srcs = [...new Set(flows.map((f) => f.from_school))];
  const dsts = [...new Set(flows.map((f) => f.to_school))];
  const tot = (names: string[], key: 'from_school' | 'to_school') => names.map((n) => flows.filter((f) => f[key] === n).reduce((s, f) => s + f.n, 0));
  const outT = tot(srcs, 'from_school'), inT = tot(dsts, 'to_school');
  const place = (t: number[]) => { let y = 4; return t.map((v) => { const n = { y, h: v * k }; y += v * k + 18; return n; }); };
  const L = place(outT), R = place(inT);
  const lOff = L.map((n) => n.y), rOff = R.map((n) => n.y);
  const shades = ['#0B1F4D', '#0F3A86', '#0A56C2', '#0071E3', '#2E8BF0', '#5AA5F5', '#86BEF8'];
  const ribbons = flows.map((f, i) => {
    const si = srcs.indexOf(f.from_school), di = dsts.indexOf(f.to_school), h = f.n * k;
    const a = lOff[si], b = rOff[di]; lOff[si] += h; rOff[di] += h;
    const x0 = 190, x1 = 710, xm = 450;
    return { i, f, c: shades[si % shades.length], d: `M${x0} ${a} C${xm} ${a} ${xm} ${b} ${x1} ${b} L${x1} ${b + h} C${xm} ${b + h} ${xm} ${a + h} ${x0} ${a + h} Z` };
  });
  const shown = hover == null ? flows[0] : flows[hover];
  const height = Math.max(L.at(-1)!.y + L.at(-1)!.h, R.at(-1)!.y + R.at(-1)!.h) + 6;
  return (
    <>
      <div aria-live="polite" className="pill" style={{ minHeight: 34, height: 'auto', padding: '6px 16px', fontSize: '0.9rem', whiteSpace: 'normal', maxWidth: '100%', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontWeight: 400 }}>{hover == null ? 'Busiest route' : 'Route'}</span>{short(shown.from_school)} → {short(shown.to_school)} · {shown.n} children
      </div>
      <div className="scroll-x" style={{ marginTop: 16 }}>
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" style={{ minWidth: 640, display: 'block' }} role="img" aria-label="Transfers between NES schools">
          {ribbons.map((r) => (
            <path key={r.i} d={r.d} fill={r.c} fillOpacity={hover == null ? (r.i === 0 ? 0.9 : 0.4) : hover === r.i ? 0.95 : 0.12}
              onMouseEnter={() => setHover(r.i)} onMouseLeave={() => setHover(null)} style={{ transition: 'fill-opacity .2s' }} />
          ))}
          {L.map((n, i) => <g key={`l${i}`}><rect x={180} y={n.y} width={10} height={n.h} rx={2} fill={shades[i % shades.length]} /><text x={172} y={n.y + n.h / 2 + 4} textAnchor="end" fontSize="13" fontWeight="600" style={{ fill: 'var(--ink)' }}>{short(srcs[i])}</text></g>)}
          {R.map((n, i) => <g key={`r${i}`}><rect x={710} y={n.y} width={10} height={n.h} rx={2} style={{ fill: 'var(--ink)' }} /><text x={728} y={n.y + n.h / 2 + 4} fontSize="13" fontWeight="600" style={{ fill: 'var(--ink)' }}>{short(dsts[i])}</text></g>)}
        </svg>
      </div>
    </>
  );
}

export { CatChip };
