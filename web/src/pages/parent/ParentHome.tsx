import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { day, money, today, type User } from '../../api';
import { Empty, StudentPhoto, useLoad } from '../../ui';

export { StudentPhoto };

export interface Child { id: string; name: string; nes_id: string; enrolment_id: string; class_code: string; section: string | null; admission_no: string; school_id: string; school: string; campus: string }

export function useChildren() {
  const { data } = useLoad<Child[]>('/my/children');
  const [current, setCurrent] = useState<string>('');
  useEffect(() => {
    if (!current && data?.length) setCurrent(sessionStorageGet() ?? data[0].id);
  }, [data, current]);
  const choose = (id: string) => { setCurrent(id); try { sessionStorage.setItem('nes.child', id); } catch { /* ignore */ } };
  return { children: data ?? [], current: data?.find((c) => c.id === current) ?? data?.[0] ?? null, choose };
}
const sessionStorageGet = () => { try { return sessionStorage.getItem('nes.child'); } catch { return null; } };

export function ChildSwitcher({ kids, current, choose, dark = false }: { kids: Child[]; current: Child | null; choose: (id: string) => void; dark?: boolean }) {
  if (kids.length < 2) return null;
  return (
    <div role="tablist" aria-label="Choose child" className={`kids${dark ? ' dark' : ''}`}>
      {kids.map((k, i) => (
        <button key={k.id} role="tab" aria-selected={current?.id === k.id} onClick={() => choose(k.id)}>
          <StudentPhoto id={k.id} name={k.name} size={36} tone={i} />
          <span style={{ textAlign: 'left', lineHeight: 1.15, minWidth: 0 }}><span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>{k.name.split(' ')[0]}</span><span style={{ fontSize: '0.72rem', opacity: 0.8 }}>{k.class_code}{k.section ? `-${k.section}` : ''}</span></span>
        </button>
      ))}
    </div>
  );
}

/** Simple line icons for the parent app (24px grid). */
export const P = {
  results: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  homework: 'M4 4h11l5 5v11H4zM15 4v5h5M8 13h8M8 17h5',
  attendance: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4M8 15l2 2 4-4',
  timetable: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  notices: 'M4 9v6h4l6 4V5L8 9zM18 9a4 4 0 010 6',
  calendar: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4M8 14h2M14 14h2M8 17h2',
  leave: 'M5 20V5l7 3 7-3v15l-7-3zM12 8v9',
  fees: 'M3 6h18v13H3zM3 10h18M7 15h4',
  messages: 'M4 5h16v11H9l-5 4z',
  profile: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  website: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20a2 2 0 004 0',
  check: 'M5 12l5 5 9-10',
  library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.8-1 3 15.4-3.8 1z',
  certificate: 'M5 3h14v12H5zM8 7h8M8 10h5M9 15l-1 6 4-2 4 2-1-6',
  bus: 'M5 17V6a2 2 0 012-2h10a2 2 0 012 2v11M5 17h14M5 12h14M7 20v-3M17 20v-3M8 15h.01M16 15h.01',
};
export const Svg = ({ d, size = 22, stroke = 'currentColor', w = 1.9 }: { d: string; size?: number; stroke?: string; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const ATT: Record<string, [string, string]> = { P: ['Present', 'var(--green)'], A: ['Absent', 'var(--red)'], L: ['On leave', 'var(--orange)'] };

export default function ParentHome({ user }: { user: User }) {
  const { children, current, choose } = useChildren();
  const { data: o } = useLoad<any>(current ? `/students/${current.id}/overview` : null, [current?.id]);
  const { data: bus } = useLoad<any>(current ? `/students/${current.id}/bus` : null, [current?.id]);
  if (!children.length) return <div className="app-shell"><Empty>Loading…</Empty></div>;
  const s = o?.student;
  const sunday = new Date().getDay() === 0;
  const att = o?.today.attendance ? ATT[o.today.attendance] : null;
  const pct = o?.attendance.marked ? Math.round((o.attendance.present / o.attendance.marked) * 100) : null;
  const modules: [string, string, string, string, number?][] = [
    ['/homework', 'Homework', P.homework, '', o?.homework.pending],
    ['/attendance', 'Attendance', P.attendance, ''],
    ['/timetable', 'Timetable', P.timetable, ''],
    ['/notices', 'Notices', P.notices, ''],
    ['/calendar', 'Calendar', P.calendar, ''],
    ['/leave', 'Leave', P.leave, '', o?.pendingLeave],
    ['/fees', 'Fees', P.fees, '', o?.fees.duePaise > 0 ? 1 : 0],
    ['/messages', 'Messages', P.messages, ''],
    ['/results', 'Results', P.results, ''],
    ['/library', 'Library', P.library, ''],
    ['/bus', 'My bus', P.bus, 'gold'],
    ['/certificates', 'Certificates', P.certificate, ''],
    ['/health', 'Health', 'M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10z', ''],
    ['/gate-pass', 'Leaving early', 'M4 21V8l8-5 8 5v13M9 21v-6h6v6', ''],
    ...(['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V'].includes(current?.class_code ?? '') ? [['/about-me', 'All About Me', 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0', ''] as [string, string, string, string]] : []),
    ...(current?.class_code === 'X' ? [['/streams', 'Class XI stream', 'M4 19l8-14 8 14M8 13h8', ''] as [string, string, string, string]] : []),
  ];
  const short = (d: string) => day(d).replace(/ \d{4}$/, '');
  const due = o?.fees.duePaise ?? 0;
  const overdue = !!o?.fees.next && o.fees.next.dueDate < today();
  // The next run of the child's bus today (the morning pick-up until it has passed, then the drop).
  const leg = bus?.on ? (bus.legs.find((l: any) => !l.passed) ?? bus.legs[bus.legs.length - 1]) : null;
  const tone = Math.max(0, children.findIndex((k) => k.id === current?.id));
  return (
    <div className="app-shell">
      <div className="home-head">
        <header className="app-top">
          <img src="/brand/navshiksha/emblem-160.png" alt="NavShiksha" style={{ width: 44, height: 44, flex: '0 0 auto' }} />
          <div style={{ flex: 1, minWidth: 0 }}><div className="small">{greeting()}</div><h2 className="app-title">{user.name.split(' ').slice(-2, -1)[0] ?? user.name}</h2></div>
          <Link className="bell" to="/notifications" aria-label={`Notifications${o?.unread ? `, ${o.unread} unread` : ''}`}><Svg d={P.bell} />{o?.unread > 0 && <span className="badge">{o.unread > 99 ? '99+' : o.unread}</span>}</Link>
        </header>
        <ChildSwitcher kids={children} current={current} choose={choose} dark />
      </div>

      <Link to="/profile" className="child-card" aria-label="Student profile">
        {current && <StudentPhoto id={current.id} name={current.name} size={64} tone={tone} radius="18px" />}
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="child-name">{current?.name}</span>
          <span className="small muted">{s ? `${s.class_name}${s.section ? `-${s.section}` : ''} · ${s.campus}` : `${current?.class_code}`}{s?.nes_id && <> · <span style={{ whiteSpace: 'nowrap' }}>{s.nes_id}</span></>}</span>
          {s && <span className="chips">
            {s.house && <span className="pill gold"><span className="dot" style={{ background: s.house_colour }} />{s.house} House</span>}
            {s.class_teacher && <span className="pill blue">{s.class_teacher}</span>}
          </span>}
        </span>
      </Link>

      {due > 0 && <section className={`card fee-due${overdue ? ' late' : ''}`}>
        <div className="small"><b>{overdue ? 'Fees overdue' : 'Fees due'}</b><span className="muted"> · {overdue ? 'was due' : 'due'} {short(o.fees.next.dueDate)}</span></div>
        <div className="fee-amt"><span>{money(due)}</span>{o.fees.next?.label && <span className="small muted">{o.fees.next.label}</span>}</div>
        <div className="fee-actions"><Link to="/fees" className="btn big">Pay {money(due)}</Link><Link to="/fees" className="btn big secondary">See details</Link></div>
      </section>}

      <div className="today">
        <Link to="/attendance"><span className="l">{sunday ? 'Sunday' : 'Today'}</span><span className="v" style={{ color: att?.[1] }}>{att?.[0] ?? (sunday ? 'No school' : 'Not marked')}</span><span className="l">{pct !== null ? `${pct}% this year` : ''}</span></Link>
        <Link to="/homework"><span className="l">Homework</span><span className="v">{o ? (o.homework.pending ? `${o.homework.pending} to do` : 'None') : '—'}</span><span className="l">{o?.homework.next[0] ? `next due ${short(o.homework.next[0].due_on)}` : 'nothing due'}</span></Link>
        {leg ? <Link to="/bus"><span className="l">Bus {leg.route.code}</span>
          <span className="v" style={{ color: leg.delayMin > 0 ? 'var(--orange)' : undefined }}>{leg.delayMin > 0 ? `${leg.delayMin} min late` : leg.eta}</span>
          <span className="l">{leg.leg === 'MORNING' ? 'pick-up' : 'drop'}{leg.delayMin > 0 ? ` now ${leg.eta}` : leg.status === 'SCHEDULED' ? ' time' : ' · on time'}</span></Link>
          : <Link to="/fees"><span className="l">Fees</span><span className="v" style={{ color: due ? 'var(--orange)' : 'var(--green)' }}>{o ? (due ? money(due) : 'Paid') : '—'}</span><span className="l">{o?.fees.next ? `due ${short(o.fees.next.dueDate)}` : 'all clear'}</span></Link>}
      </div>

      {o?.today.classes.length > 0 && <>
        <div className="sec-head"><h3>{o.today.classDay === o.today.date ? "Today's classes" : `${new Date(`${o.today.classDay}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' })}'s classes`}</h3><Link to="/timetable" className="small">Week</Link></div>
        {o.today.plan && <div className="callout blue small">{o.today.plan.title}</div>}
        <div className="periods">{o.today.classes.filter((c: any) => c.kind === 'PERIOD').map((c: any) => (
          <div key={c.period} style={{ opacity: c.cancelled ? 0.55 : 1 }}><span className="tiny muted">P{c.period} · {c.starts}</span>
            <b style={{ textDecoration: c.cancelled ? 'line-through' : undefined }}>{c.subject ?? 'Free'}</b>
            <span className="tiny muted">{c.cancelled ? c.cancelled : c.cover?.teacher ? `Cover: ${c.cover.teacher.replace(/^(Mrs|Mr|Ms) /, '')}` : c.teacher?.replace(/^(Mrs|Mr|Ms) /, '') ?? ''}</span></div>))}</div>
      </>}

      <nav className="modules" aria-label="Modules">
        {modules.map(([to, label, d, color, n]) => (
          <Link key={to} to={to}><i className={color || undefined}><Svg d={d} /></i>{label}{n ? <span className="n">{to === '/fees' ? '!' : n}</span> : null}</Link>))}
      </nav>

      <section className="card">
        <div className="sec-head" style={{ margin: '0 0 4px' }}><h3>Coming up</h3><Link to="/calendar" className="small">Calendar</Link></div>
        {!o ? <Empty>Loading…</Empty> : o.events.length === 0 ? <p className="small muted">Nothing scheduled.</p> : o.events.map((e: any) => (
          <Link key={e.id} to="/calendar" className="row-link">
            <span className="date-chip"><b>{new Date(`${e.starts}T00:00:00`).getDate()}</b><span>{new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</span></span>
            <span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{e.title}</b><div className="tiny muted">{e.ends !== e.starts ? `until ${day(e.ends)}` : new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' })}</div></span>
          </Link>))}
      </section>

      <section className="card">
        <div className="sec-head" style={{ margin: '0 0 4px' }}><h3>Notices</h3><Link to="/notices" className="small">All</Link></div>
        {!o ? <Empty>Loading…</Empty> : o.notices.length === 0 ? <p className="small muted">No notices.</p> : o.notices.map((n: any) => (
          <Link key={n.id} to={`/notices/${n.id}`} className="row-link"><span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{n.title}</b><div className="tiny muted">{n.issued_by_unit} · {day(n.created_at)}</div></span><span className="muted">›</span></Link>))}
      </section>

      {s?.site_slug && <a className="card" href={`/s/${s.site_slug}`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--ink)', textDecoration: 'none' }}>
        <i style={{ width: 40, height: 40, borderRadius: 12, background: '#0B1F4D', display: 'grid', placeItems: 'center' }}><Svg d={P.website} stroke="#fff" size={20} /></i>
        <span style={{ flex: 1 }}><b>School website</b><div className="tiny muted">{s.school}</div></span><span className="muted">›</span></a>}
    </div>
  );
}
