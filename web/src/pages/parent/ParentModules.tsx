import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, day, money, openPdf, time, today, words, type User } from '../../api';
import { Empty, ThemeSwitch, initials, useAction, useLoad, ask } from '../../ui';
import { ChildSwitcher, P, StudentPhoto, Svg, useChildren } from './ParentHome';

const SUBJECT_COLOUR: Record<string, string> = { MAT: '#0071E3', ENG: '#FF9F0A', SCI: '#34C759', HIN: '#FF2D55', SST: '#AF52DE', SAN: '#FF6B35', CS: '#5E5CE6', PE: '#30B0C7' };
const plus = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const when = (d: string) => (d === today() ? 'Today' : d === plus(1) ? 'Tomorrow' : new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }));

export function Screen({ title, children, back = '/' }: { title: string; children: React.ReactNode; back?: string }) {
  const { children: kids, current, choose } = useChildren();
  return (
    <div className="app-shell">
      <Link to={back} className="back">‹ {back === '/' ? 'Home' : 'Back'}</Link>
      <h2 className="app-title">{title}</h2>
      <ChildSwitcher kids={kids} current={current} choose={choose} />
      {children}
    </div>
  );
}

// ── Homework ──
export function ParentHomework() {
  const { current } = useChildren();
  const { data, setData } = useLoad<any[]>(current ? `/students/${current.id}/homework` : null, [current?.id]);
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  const { run } = useAction();
  const list = (data ?? []).filter((h) => (tab === 'done' ? h.done : !h.done));
  const groups = useMemo(() => { const m = new Map<string, any[]>(); for (const h of list) m.set(h.due_on, [...(m.get(h.due_on) ?? []), h]); return [...m.entries()]; }, [list]);
  const toggle = async (h: any) => {
    const done = !h.done;
    setData((d) => d?.map((x) => (x.id === h.id ? { ...x, done } : x)) ?? null);
    if (!(await run(() => api(`/homework/${h.id}/done`, { method: 'PUT', body: { studentId: current!.id, done } })))) setData((d) => d?.map((x) => (x.id === h.id ? { ...x, done: !done } : x)) ?? null);
  };
  return (
    <Screen title="Homework">
      <div className="seg" style={{ alignSelf: 'flex-start' }}><button className={tab === 'todo' ? 'on' : ''} onClick={() => setTab('todo')}>To do</button><button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>Done</button></div>
      {!data ? <Empty>Loading…</Empty> : groups.length === 0 ? <div className="card"><p className="muted">{tab === 'todo' ? 'Nothing to do. 🎉' : 'Nothing ticked yet.'}</p></div> : groups.map(([due, items]) => (
        <section key={due} className="stack" style={{ gap: 8 }}>
          <div className="small muted" style={{ fontWeight: 600, marginTop: 4 }}>Due {when(due).toLowerCase().startsWith('to') ? when(due).toLowerCase() : when(due)}</div>
          {items.map((h) => (
            <article key={h.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: 16 }}>
              <button onClick={() => toggle(h)} aria-label={h.done ? 'Mark not done' : 'Mark done'} aria-pressed={h.done}
                style={{ width: 28, height: 28, borderRadius: '50%', flex: 'none', marginTop: 2, cursor: 'pointer', border: h.done ? 0 : '2px solid var(--line)', background: h.done ? 'var(--green)' : '#fff', display: 'grid', placeItems: 'center' }}>
                {h.done && <Svg d={P.check} stroke="#fff" size={16} w={2.6} />}</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="subject-dot" style={{ background: SUBJECT_COLOUR[h.subject_code] ?? '#8E8E93' }} /><span className="small" style={{ fontWeight: 600, color: SUBJECT_COLOUR[h.subject_code] ?? 'var(--ink-2)' }}>{h.subject}</span></div>
                <div style={{ fontWeight: 600, marginTop: 4, textDecoration: h.done ? 'line-through' : undefined, color: h.done ? 'var(--ink-2)' : undefined }}>{h.title}</div>
                {h.details && <div className="small muted" style={{ marginTop: 4 }}>{h.details}</div>}
                <div className="tiny muted" style={{ marginTop: 6 }}>Set by {h.set_by} on {day(h.assigned_on)}</div>
              </div>
            </article>))}
        </section>))}
    </Screen>
  );
}

// ── Attendance ──
export function ParentAttendance() {
  const { current } = useChildren();
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data } = useLoad<any>(current ? `/students/${current.id}/attendance?month=${month}` : null, [current?.id, month]);
  const first = new Date(`${month}-01T00:00:00`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const marks = new Map<string, string>((data?.days ?? []).map((d: any) => [d.on_date, d.status]));
  const count = (s: string) => [...marks.values()].filter((x) => x === s).length;
  const shift = (n: number) => { const d = new Date(first.getFullYear(), first.getMonth() + n, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
  const pct = data?.year.marked ? Math.round((data.year.present / data.year.marked) * 100) : null;
  return (
    <Screen title="Attendance">
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontFamily: 'var(--display)', fontSize: '2.6rem', fontWeight: 600, lineHeight: 1 }}>{pct ?? '—'}{pct !== null && '%'}</div>
        <div className="small muted">{data ? `Present ${data.year.present} of ${data.year.marked} school days this academic year` : 'Loading…'}</div>
      </div>
      <section className="card">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <b style={{ flex: 1, textAlign: 'center' }}>{first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</b>
          <button className="icon-btn" onClick={() => shift(1)} disabled={month >= today().slice(0, 7)} aria-label="Next month">›</button>
        </div>
        <div className="month">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="dow">{d}</span>)}
          {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} className="d blank" />)}
          {Array.from({ length: days }, (_, i) => { const iso = `${month}-${String(i + 1).padStart(2, '0')}`; const st = marks.get(iso);
            return <span key={iso} className={`d ${st ?? ''}${iso === today() ? ' today' : ''}`} title={st ? { P: 'Present', A: 'Absent', L: 'Leave' }[st] : undefined}>{i + 1}</span>; })}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}><span className="pill green">{count('P')} present</span><span className="pill red">{count('A')} absent</span><span className="pill orange">{count('L')} leave</span></div>
      </section>
      <Link to="/leave" className="card" style={{ color: 'var(--ink)', textDecoration: 'none', display: 'flex', alignItems: 'center' }}><span style={{ flex: 1 }}><b>Apply for leave</b><div className="tiny muted">The class teacher approves it in the app.</div></span>›</Link>
    </Screen>
  );
}

// ── Timetable ──
/** Monday of this school week (next week's on Saturday and Sunday). */
const weekDates = () => {
  const d = new Date(`${today()}T00:00:00Z`);
  const wd = ((d.getUTCDay() + 6) % 7) + 1;
  const monday = new Date(d.getTime() - (wd - 1) * 864e5 + (wd >= 6 ? 7 * 864e5 : 0));
  return [0, 1, 2, 3, 4, 5].map((i) => new Date(monday.getTime() + i * 864e5).toISOString().slice(0, 10));
};

export function ParentTimetable() {
  const { current } = useChildren();
  const dates = weekDates();
  const [date, setDate] = useState(() => (dates.includes(today()) && new Date().getDay() !== 6 ? today() : dates[0]));
  const { data } = useLoad<any>(current ? `/students/${current.id}/day?date=${date}` : null, [current?.id, date]);
  const now = new Date().toTimeString().slice(0, 5);
  const isToday = date === today();
  return (
    <Screen title="Timetable">
      <div className="seg" style={{ alignSelf: 'stretch', display: 'flex' }}>{dates.slice(0, 5).map((d) => (
        <button key={d} style={{ flex: 1, lineHeight: 1.1, height: 44 }} className={date === d ? 'on' : ''} onClick={() => setDate(d)}>
          {new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}<br /><span className="tiny muted">{new Date(`${d}T00:00:00`).getDate()}</span></button>))}</div>
      <section className="card">
        <div className="small muted" style={{ marginBottom: 4 }}>{new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}{data?.section ? ` · Class ${data.section}` : ''}</div>
        {data?.plan && <div className="callout blue small" style={{ margin: '6px 0' }}>{data.plan.title}</div>}
        {!data ? <Empty>Loading…</Empty> : data.closed ? <p className="muted" style={{ padding: '10px 0' }}>{data.closed === 'Sunday' ? 'No school on Sunday.' : `${data.closed}. No school.`}</p> : data.rows.length === 0 ? <p className="muted">No classes.</p> : data.rows.map((r: any, i: number) => {
          if (r.kind !== 'PERIOD') return <div key={i} className="tiny muted" style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--fill)', borderRadius: 10, padding: '6px 12px', margin: '6px 0' }}><span>{r.label}</span><span>{r.starts}–{r.ends}</span></div>;
          const live = isToday && r.starts <= now && now < r.ends;
          return (
            <div key={i} className="row-link" style={{ background: live ? 'var(--blue-soft)' : undefined, borderRadius: live ? 12 : 0, padding: live ? '12px 8px' : undefined, opacity: r.cancelled ? 0.6 : 1 }}>
              <span style={{ width: 52, flex: 'none' }} className="small muted">{r.starts}<br />{r.ends}</span>
              <span className="subject-dot" style={{ background: r.cancelled ? '#8E8E93' : SUBJECT_COLOUR[r.subject_code] ?? '#8E8E93' }} />
              <span style={{ flex: 1 }}>
                <b style={{ fontWeight: 600, textDecoration: r.cancelled ? 'line-through' : undefined }}>{r.subject ?? 'Free'}</b>
                <div className="tiny muted">{r.cancelled ? r.cancelled : r.cover ? (r.cover.kind === 'PROXY' ? `${r.cover.teacher} is taking this class` : r.cover.kind === 'MERGE' ? `Combined with ${r.cover.merged_with}` : 'Supervised study') : r.teacher ?? ''}</div></span>
              {live ? <span className="pill blue">Now</span> : <span className="tiny muted">P{r.period}</span>}
            </div>);
        })}
      </section>
    </Screen>
  );
}

// ── Notices ──
export function ParentNotices() {
  const { id } = useParams();
  const { current } = useChildren();
  const { data } = useLoad<any[]>(current ? `/students/${current.id}/notices` : null, [current?.id]);
  const open = id ? data?.find((n) => n.id === id) : null;
  if (id) return (
    <Screen title="Notice" back="/notices">
      {!data ? <Empty>Loading…</Empty> : !open ? <div className="card"><p className="muted">This notice is no longer available.</p></div> : (
        <article className="card stack">
          <span className={`pill ${open.kind === 'URGENT' ? 'red' : open.kind === 'CIRCULAR' ? 'blue' : ''}`} style={{ alignSelf: 'flex-start' }}>{words(open.kind)}</span>
          <h3 style={{ fontSize: '1.4rem' }}>{open.title}</h3>
          <p style={{ whiteSpace: 'pre-line' }}>{open.body}</p>
          <p className="tiny muted">{open.issued_by_unit} · {open.issued_by} · {time(open.created_at)}</p>
        </article>)}
    </Screen>
  );
  return (
    <Screen title="Notices">
      <section className="card">
        {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <p className="muted">No notices.</p> : data.map((n) => (
          <Link key={n.id} to={`/notices/${n.id}`} className="row-link">
            <span style={{ flex: 1, minWidth: 0 }}><span className="tiny muted">{n.issued_by_unit} · {day(n.created_at)}</span><div style={{ fontWeight: 600 }}>{n.title}</div><div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div></span>
            <span className="muted">›</span></Link>))}
      </section>
    </Screen>
  );
}

// ── Calendar ──
export function ParentCalendar() {
  const { current } = useChildren();
  const { data } = useLoad<any[]>(current ? `/students/${current.id}/calendar` : null, [current?.id]);
  const months = new Map<string, any[]>();
  for (const e of data ?? []) { const k = new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); months.set(k, [...(months.get(k) ?? []), e]); }
  const tone = (k: string) => (k === 'HOLIDAY' || k === 'VACATION' ? 'green' : k === 'EXAM' ? 'orange' : 'blue');
  return (
    <Screen title="Calendar">
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <div className="card"><p className="muted">Nothing scheduled.</p></div> : [...months.entries()].map(([m, list]) => (
        <section key={m} className="card">
          <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>{m}</h3>
          {list.map((e) => (
            <div key={e.id} className="row-link">
              <span className="date-chip"><b>{new Date(`${e.starts}T00:00:00`).getDate()}</b><span>{new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}</span></span>
              <span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{e.title}</b><div className="tiny muted">{e.ends !== e.starts ? `${day(e.starts)} – ${day(e.ends)}` : e.unit_kind === 'society' ? 'All NES schools' : e.unit}</div></span>
              <span className={`pill ${tone(e.kind)}`}>{e.kind === 'PTM' ? 'PTM' : words(e.kind)}</span>
            </div>))}
        </section>))}
    </Screen>
  );
}

// ── Leave ──
export function ParentLeave() {
  const { current } = useChildren();
  const { data, reload } = useLoad<any[]>(current ? `/students/${current.id}/leave` : null, [current?.id]);
  const [form, setForm] = useState<{ from: string; to: string; reason: string } | null>(null);
  const { run, busy } = useAction();
  const tone: Record<string, [string, string]> = { PENDING: ['orange', 'Waiting for class teacher'], APPROVED: ['green', 'Approved'], REJECTED: ['red', 'Not approved'], CANCELLED: ['', 'Cancelled'] };
  return (
    <Screen title="Leave">
      {form ? (
        <section className="card stack">
          <h3>Apply for leave</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label className="field"><span>From</span><input className="input" type="date" min={today()} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, to: e.target.value > form.to ? e.target.value : form.to })} /></label>
            <label className="field"><span>To</span><input className="input" type="date" min={form.from} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
          </div>
          <label className="field"><span>Reason</span><textarea className="input" maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Fever, family function…" /></label>
          <button className="btn big" disabled={busy || form.reason.trim().length < 3} onClick={async () => {
            if (await run(() => api('/leave', { body: { studentId: current!.id, ...form } }), 'Sent to the class teacher')) { setForm(null); reload(); }
          }}>Send request</button>
          <button className="btn quiet" onClick={() => setForm(null)}>Cancel</button>
        </section>
      ) : <button className="btn big" onClick={() => setForm({ from: plus(1), to: plus(1), reason: '' })}>Apply for leave</button>}
      <section className="card">
        <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Requests</h3>
        {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <p className="muted small">No leave requests yet.</p> : data.map((l) => (
          <div key={l.id} className="row-link" style={{ alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{day(l.from)}{l.days > 1 ? ` – ${day(l.to)}` : ''}</b><div className="small muted">{l.reason}</div>
              {l.decision_note && <div className="tiny muted" style={{ marginTop: 2 }}>{l.decided_by_name}: {l.decision_note}</div>}
              {(l.status === 'PENDING' || (l.status === 'APPROVED' && l.from > today())) && <button className="linkbtn small" style={{ marginTop: 6 }} onClick={async () => { if (await ask('Cancel this leave request?') && await run(() => api(`/leave/${l.id}/cancel`, { method: 'POST' }), 'Cancelled')) reload(); }}>Cancel request</button>}</span>
            <span className={`pill ${tone[l.status]?.[0] ?? ''}`}>{tone[l.status]?.[1] ?? l.status}</span>
          </div>))}
      </section>
    </Screen>
  );
}

// ── Notifications ──
export function ParentNotifications() {
  const { data, reload } = useLoad<any>('/notifications');
  const navigate = useNavigate();
  const { run } = useAction();
  const items: any[] = data?.items ?? [];
  const todayItems = items.filter((n) => n.created_at.slice(0, 10) === today());
  const earlier = items.filter((n) => n.created_at.slice(0, 10) !== today());
  const icon: Record<string, string> = { HOMEWORK: P.homework, NOTICE: P.notices, ATTENDANCE: P.attendance, LEAVE: P.leave, MESSAGE: P.messages, FEES: P.fees, EVENT: P.calendar };
  const open = async (n: any) => {
    if (!n.read_at) await api('/notifications/read', { body: { ids: [n.id] } }).catch(() => {});
    if (n.student_id) try { sessionStorage.setItem('nes.child', n.student_id); } catch { /* ignore */ }
    navigate(n.link ?? '/');
  };
  const list = (rows: any[]) => rows.map((n) => (
    <button key={n.id} className="row-link" onClick={() => open(n)} style={{ width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line-soft)', textAlign: 'left', cursor: 'pointer' }}>
      <i style={{ width: 36, height: 36, borderRadius: 11, flex: 'none', background: 'var(--blue-soft)', color: 'var(--blue)', display: 'grid', placeItems: 'center' }}><Svg d={icon[n.kind] ?? P.bell} size={18} /></i>
      <span style={{ flex: 1, minWidth: 0 }} className={n.read_at ? '' : 'unread'}><b style={{ fontWeight: n.read_at ? 500 : 700 }}>{n.title}</b>
        <div className="tiny muted">{n.student_name ? `${n.student_name.split(' ')[0]} · ` : ''}{n.body}</div></span>
      <span className="tiny muted" style={{ flex: 'none' }}>{new Date(n.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>
    </button>));
  return (
    <div className="app-shell">
      <div style={{ display: 'flex', alignItems: 'center' }}><h2 className="app-title" style={{ flex: 1 }}>Notifications</h2>
        {data?.unread > 0 && <button className="btn quiet small" onClick={async () => { await run(() => api('/notifications/read', { body: { all: true } })); reload(); }}>Mark all read</button>}</div>
      {!data ? <Empty>Loading…</Empty> : items.length === 0 ? <div className="card"><p className="muted">You're all caught up.</p></div> : <>
        {todayItems.length > 0 && <section className="card" style={{ paddingTop: 10 }}><div className="small muted" style={{ fontWeight: 600 }}>Today</div>{list(todayItems)}</section>}
        {earlier.length > 0 && <section className="card" style={{ paddingTop: 10 }}><div className="small muted" style={{ fontWeight: 600 }}>Earlier</div>{list(earlier)}</section>}
      </>}
    </div>
  );
}

// ── Profile ──
export function ParentProfile({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { children: kids, current, choose } = useChildren();
  const { data: o } = useLoad<any>(current ? `/students/${current.id}/overview` : null, [current?.id]);
  const { data: guardians } = useLoad<any[]>(current ? `/students/${current.id}/guardians` : null, [current?.id]);
  const s = o?.student;
  const row = (label: string, value?: string | null) => value ? <div className="row-link" style={{ padding: '11px 0' }}><span className="muted small" style={{ width: 130, flex: 'none' }}>{label}</span><span style={{ flex: 1, fontWeight: 500 }}>{value}</span></div> : null;
  return (
    <div className="app-shell">
      <h2 className="app-title">Profile</h2>
      <ChildSwitcher kids={kids} current={current} choose={choose} />
      <section className="card" style={{ textAlign: 'center', display: 'grid', justifyItems: 'center', gap: 8, paddingTop: 26 }}>
        {current && <StudentPhoto id={current.id} name={current.name} size={88} tone={Math.max(0, kids.findIndex((k) => k.id === current.id))} ring />}
        <h3 style={{ fontSize: '1.5rem' }}>{current?.name}</h3>
        <span className="muted">{s ? `${s.class_name}${s.section ? `-${s.section}` : ''} · ${s.school}` : ''}</span>
        {s?.house && <span className="pill"><span className="subject-dot" style={{ background: s.house_colour }} />{s.house} House</span>}
      </section>
      {!s ? <Empty>Loading…</Empty> : <>
        <section className="card" style={{ paddingTop: 8, paddingBottom: 8 }}>
          {row('Admission no.', s.admission_no)}{row('NES ID', s.nes_id)}{row('Date of birth', day(s.dob))}{row('Blood group', s.blood_group)}
          {row('Class teacher', s.class_teacher)}{row('Joined', day(s.joined))}{row('PEN', s.pen)}{row('APAAR ID', s.apaar_id)}
        </section>
        <section className="card" style={{ paddingTop: 8, paddingBottom: 8 }}>
          {row('School', s.school)}{row('Campus', s.campus)}{row('Address', s.campus_address)}
        </section>
        <section className="card">
          <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Parents and guardians</h3>
          {(guardians ?? []).map((g, i) => <div key={i} className="row-link"><span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{g.name}</b><div className="tiny muted">{words(g.relationship)}{g.is_primary ? ' · primary contact' : ''}</div></span><span className="small muted">{g.phone}</span></div>)}
          <p className="tiny muted" style={{ marginTop: 10 }}>Something wrong in these details? <Link to="/help">Tell us in Help</Link>; the school office checks and corrects it.</p>
        </section>
      </>}
      <section className="card"><ThemeSwitch /></section>
      <section className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="avatar">{initials(user.name)}</span><span style={{ flex: 1 }}><b>{user.name}</b><div className="tiny muted">Signed in to the NavShiksha parent app</div></span>
        <Link className="btn quiet small" to="/help">Help</Link><button className="btn quiet small" onClick={onSignOut}>Sign out</button>
      </section>
    </div>
  );
}

// ── Library ──
export function ParentLibrary() {
  const { current } = useChildren();
  const { data } = useLoad<any[]>(current ? `/students/${current.id}/library` : null, [current?.id]);
  const out = (data ?? []).filter((l) => !l.returned_on);
  const past = (data ?? []).filter((l) => l.returned_on);
  return (
    <Screen title="Library">
      {!data ? <Empty>Loading…</Empty> : <>
        <section className="card stack">
          <div className="small muted">Borrowed now</div>
          {!out.length ? <p className="muted">No library books at home.</p> : out.map((l, i) => (
            <div key={i} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span><strong>{l.title}</strong><span className="tiny muted" style={{ display: 'block' }}>{l.author} · borrowed {day(l.issued_on)}</span></span>
              <span className={`pill ${l.overdue ? 'red' : ''}`}>{l.overdue ? `Overdue since ${day(l.due_on)}` : `Return by ${day(l.due_on)}`}</span>
            </div>))}
        </section>
        {past.length > 0 && <section className="card stack">
          <div className="small muted">Returned</div>
          {past.slice(0, 15).map((l, i) => (
            <div key={i} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span>{l.title}<span className="tiny muted" style={{ display: 'block' }}>{day(l.issued_on)} to {day(l.returned_on)}</span></span>
              {l.lost ? <span className="pill red">Lost · {money(l.fine_paise)}</span> : l.fine_paise > 0 ? <span className="pill orange">Fine {money(l.fine_paise)}</span> : <span className="pill green">On time</span>}
            </div>))}
        </section>}
      </>}
    </Screen>
  );
}

// ── Certificates ──
const CERT_KINDS: [string, string, string][] = [
  ['BONAFIDE', 'Bonafide certificate', 'Passport, bank account, scholarship'], ['CEA', 'CEA certificate', 'Children Education Allowance claim'],
  ['FEE_PAID', 'Fee paid certificate', 'Income tax: tuition fees paid in the year'], ['STUDY', 'Study certificate', 'Years and classes studied here'],
  ['CHARACTER', 'Character certificate', 'Admission elsewhere, competitions'], ['TC', 'Transfer certificate', 'Leaving the school'],
];
const CERT_STATUS: Record<string, [string, string]> = { REQUESTED: ['Requested', 'blue'], DRAFT: ['Being prepared', 'blue'], PENDING: ['Waiting for approval', 'orange'], ISSUED: ['Ready', 'green'], REJECTED: ['Not issued', 'red'], CANCELLED: ['Cancelled', 'red'] };

const MOVE_STATUS: Record<string, [string, string]> = { PENDING: ['Asked', 'blue'], WAITLISTED: ['Waiting list', 'orange'], ACCEPTED: ['Seat given', 'green'],
  DECLINED: ['Declined', 'red'], CANCELLED: ['Withdrawn', ''], COMPLETED: ['Moved', 'green'] };

export function ParentCertificates() {
  const { current } = useChildren();
  const list = useLoad<any[]>(current ? `/students/${current.id}/certificates` : null, [current?.id]);
  const { run, busy } = useAction();
  const [f, setF] = useState({ kind: '', purpose: '', leavingDate: plus(30), reason: '', destinationSchoolId: '' });
  const options = useLoad<any>(current && f.kind === 'TC' ? `/students/${current.id}/transfer-destinations` : null, [current?.id, f.kind]);
  const moves = useLoad<any[]>(current ? `/students/${current.id}/transfer-requests` : null, [current?.id]);
  return (
    <Screen title="Certificates">
      <section className="card stack">
        <div className="small muted">Ask the school for a certificate</div>
        {CERT_KINDS.map(([k, label, hint]) => (
          <label key={k} className="list-row" style={{ gridTemplateColumns: 'auto minmax(0,1fr)', cursor: 'pointer' }}>
            <input type="radio" name="kind" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />
            <span><strong>{label}</strong><span className="tiny muted" style={{ display: 'block' }}>{hint}</span></span>
          </label>))}
        {f.kind && <>
          <label className="field"><span>What is it for?</span><input className="input" value={f.purpose} placeholder={f.kind === 'TC' ? 'Admission at the new school' : 'For example: passport application'} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
          {f.kind === 'TC' && <>
            <label className="field"><span>Last day at this school</span><input className="input" type="date" value={f.leavingDate} onChange={(e) => setF({ ...f, leavingDate: e.target.value })} /></label>
            <label className="field"><span>Reason for leaving</span><input className="input" value={f.reason} placeholder="For example: father posted to Kochi" onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            <label className="field"><span>Joining another Navy Children School or Navy Kindergarten?</span>
              <select className="input" value={f.destinationSchoolId} onChange={(e) => setF({ ...f, destinationSchoolId: e.target.value })}>
                <option value="">No, leaving the Navy schools</option>
                {(options.data?.schools ?? []).map((s: any) => <option key={s.schoolId} value={s.schoolId}>{s.name} · {s.available ? 'seats available' : 'full: waiting list'}</option>)}
              </select></label>
            <p className="tiny muted">{f.destinationSchoolId
              ? 'That school is asked for a seat in the same class. Once it accepts, this school issues the TC and your child moves there the day after the last day here, with all records, results and photo. Fees paid here are shown to the new school, which charges from its next quarter; anything paid here for later quarters is refunded.'
              : 'A TC is issued once fees up to the last day are paid and library books returned.'}</p>
          </>}
          <button className="btn big" disabled={busy || f.purpose.trim().length < 3} onClick={async () => {
            if (await run(() => api(`/students/${current!.id}/certificates`, { body: { kind: f.kind, purpose: f.purpose, leavingDate: f.kind === 'TC' ? f.leavingDate : undefined, reason: f.kind === 'TC' ? f.reason : undefined, destinationSchoolId: f.kind === 'TC' && f.destinationSchoolId ? f.destinationSchoolId : undefined } }), f.destinationSchoolId ? 'Sent to both schools' : 'Sent to the school office')) {
              setF({ kind: '', purpose: '', leavingDate: plus(30), reason: '', destinationSchoolId: '' }); list.reload(); moves.reload();
            }
          }}>Send request</button>
        </>}
      </section>
      {(moves.data ?? []).length > 0 && <section className="card stack">
        <div className="small muted">Moving to another school</div>
        {(moves.data ?? []).map((r) => (
          <div key={r.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><strong>{r.to_school}</strong>
              <span className="tiny muted" style={{ display: 'block' }}>{r.class_name}, joining {day(r.joining_on)}{r.section ? ` · Class ${r.section}` : ''}{r.decision_note ? ` · ${r.decision_note}` : ''}</span></span>
            <span className={`pill ${MOVE_STATUS[r.status]?.[1] ?? ''}`}>{MOVE_STATUS[r.status]?.[0] ?? r.status}</span>
          </div>))}
      </section>}
      {!list.data ? <Empty>Loading…</Empty> : list.data.length > 0 && <section className="card stack">
        <div className="small muted">Your requests and certificates</div>
        {list.data.map((c) => {
          const [label, tone] = CERT_STATUS[c.status] ?? [c.status, ''];
          return (
            <div key={c.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span><strong>{c.title.replace('Consolidated Certificate from Head of School for Claiming Children Educational Allowance', 'CEA certificate')}</strong>
                <span className="tiny muted" style={{ display: 'block' }}>{c.serial_no ? `${c.serial_no} · issued ${day(c.issued_on)}` : `Asked ${day(c.created_at)}`}{c.purpose ? ` · ${c.purpose}` : ''}</span>
                {c.note && c.status === 'REJECTED' && <span className="tiny" style={{ display: 'block', color: 'var(--red)' }}>{c.note}</span>}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                <span className={`pill ${tone}`}>{label}</span>
                {c.status === 'ISSUED' && <button className="btn small" disabled={busy} onClick={() => run(() => openPdf(`/certificates/${c.id}/pdf`))}>Download</button>}
              </span>
            </div>);
        })}
        <p className="tiny muted">A downloaded certificate is marked as a digital copy and carries a QR code anyone can scan to check it. Collect the signed original from the school office if one is needed.</p>
      </section>}
    </Screen>
  );
}

const LEVEL: Record<string, string> = { BEGINNER: 'Beginner', PROGRESSING: 'Progressing', PROFICIENT: 'Proficient', ADVANCED: 'Advanced' };

/** Published results, the report card, the holistic card, remarks, awards, and the coming exams' date sheet. */
export function ParentResults() {
  const { current } = useChildren();
  const r = useLoad<any>(current ? `/students/${current.id}/results` : null, [current?.id]);
  const exams = useLoad<any[]>(current ? `/students/${current.id}/exam-schedule` : null, [current?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const { run, busy } = useAction();
  const upcoming = (exams.data ?? []).filter((x) => x.date);
  const latest = r.data?.results?.at(-1);
  useEffect(() => { if (latest && open === null) setOpen(latest.assessment_id); }, [latest?.assessment_id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Screen title="Results">
      {!r.data ? <Empty>Loading…</Empty> : <>
        {r.data.running && <section className="card stack">
          <div className="small muted">Result so far this year</div>
          <div style={{ fontSize: '2.2rem', fontWeight: 700, letterSpacing: '-0.02em' }}>{r.data.running.percentage}%</div>
          <div className="tiny muted">Weighted by the NES plan: {r.data.running.basedOn.join(', ')} so far ({r.data.running.weightCovered}% of the final result).</div>
        </section>}
        {r.data.board?.map((b: any) => <section key={`${b.year}${b.class_code}`} className="card stack">
          <div className="small muted">CBSE Class {b.class_code} result {b.year} · roll no. {b.roll_no}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><b style={{ fontSize: '1.8rem' }}>{b.percentage}%</b><span className={`pill ${b.result === 'PASS' ? 'green' : 'orange'}`}>{b.result}</span><span className="tiny muted">best five</span></div>
          <table className="table small"><thead><tr><th>Subject</th><th className="num">Marks</th><th>Grade</th></tr></thead>
            <tbody>{b.subjects.map((s: any) => <tr key={s.code}><td>{s.name} <span className="tiny muted">{s.code}</span></td><td className="num">{s.marks ?? 'Absent'}</td><td>{s.grade}</td></tr>)}</tbody></table>
        </section>)}
        {r.data.holistic?.length > 0 && <section className="card stack">
          <div className="small muted">Holistic Progress Card</div>
          {r.data.holistic.map((x: any) => <div key={x.assessment_id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{x.name}</b><span className="tiny muted" style={{ display: 'block' }}>Published {day(x.published_at)}</span></span>
            <button className="btn small" disabled={busy} onClick={() => run(() => openPdf(`/students/${current!.id}/report-card/${x.assessment_id}`))}>Download</button></div>)}
          <Link to="/about-me" className="small">All About Me: favourites and drawings for the card ›</Link>
        </section>}
        {!r.data.results.length && !r.data.holistic?.length && !r.data.board?.length && <section className="card"><Empty>No results published yet this year.</Empty></section>}
        {[...r.data.results].reverse().map((x: any) => (
          <section key={x.assessment_id} className="card stack">
            <button className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(open === x.assessment_id ? null : x.assessment_id)}>
              <span><b>{x.name}</b><span className="tiny muted" style={{ display: 'block' }}>Published {day(x.published_at)}{x.rank_section ? ` · rank ${x.rank_section} of ${x.section_size} in the class` : ''}</span></span>
              <span style={{ textAlign: 'right' }}><b style={{ fontSize: '1.3rem' }}>{x.percentage}%</b><span className="tiny muted" style={{ display: 'block' }}>Grade {x.grade}</span></span>
            </button>
            {open === x.assessment_id && <>
              <table className="table small"><thead><tr><th>Subject</th><th className="num">Marks</th><th>Grade</th></tr></thead>
                <tbody>{x.subjects.map((sj: any) => <tr key={sj.code}><td>{sj.name}</td><td className="num">{sj.absent ? 'Absent' : `${sj.marks} / ${sj.max}`}</td><td>{sj.grade}</td></tr>)}
                  <tr><td><b>Total</b></td><td className="num"><b>{x.obtained} / {x.max_total}</b></td><td><b>{x.grade}</b></td></tr></tbody></table>
              <button className="btn" disabled={busy} onClick={() => run(() => openPdf(`/students/${current!.id}/report-card/${x.assessment_id}`))}>Download the report card</button>
            </>}
          </section>))}
        {r.data.hpc.length > 0 && <section className="card stack">
          <div className="small muted">Holistic Progress Card · {r.data.hpc.at(-1).assessment}</div>
          {r.data.hpc.filter((h: any) => h.assessment === r.data.hpc.at(-1).assessment).map((h: any) => (
            <div key={h.domain} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span>{h.domain}<span className="tiny muted" style={{ display: 'block' }}>{h.hint}</span></span><b className="small">{LEVEL[h.level] ?? h.level}</b></div>))}
        </section>}
        {r.data.remarks.length > 0 && <section className="card stack">
          <div className="small muted">From the class teacher</div>
          {r.data.remarks.map((m: any, i: number) => <div key={i}><p>“{m.remark}”</p><span className="tiny muted">{m.by} · {m.assessment}</span></div>)}
        </section>}
        {r.data.awards?.length > 0 && <section className="card stack">
          <div className="small muted">Awards</div>
          {r.data.awards.map((a: any, i: number) => <div key={i} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span>🏅 <b>{a.scheme}</b><span className="tiny muted" style={{ display: 'block' }}>{a.academic_year} · {a.status === 'PAID' ? `paid ${day(a.paid_at)}` : 'approved'}</span></span><b>{money(a.amount_paise)}</b></div>)}
        </section>}
      </>}
      {upcoming.length > 0 && <section className="card stack">
        <div className="small muted">Coming exams</div>
        {upcoming.map((x, i) => <div key={i} className="list-row" style={{ gridTemplateColumns: '64px minmax(0,1fr)' }}><b className="small">{new Date(`${x.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</b>
          <span>{x.subject}<span className="tiny muted" style={{ display: 'block' }}>{x.assessment} · out of {x.max_marks}</span></span></div>)}
      </section>}
    </Screen>
  );
}

// ── My bus ──
const LEG: Record<string, string> = { MORNING: 'Morning pick-up', AFTERNOON: 'Afternoon drop' };
const TRIP: Record<string, [string, string]> = { SCHEDULED: ['Not started yet', ''], RUNNING: ['On the way', 'blue'], DONE: ['Finished', 'green'], CANCELLED: ['Not running', 'red'] };

/**
 * The child's bus: the stop, today's times (moved when the bus is late, from the attendant's taps;
 * no GPS needed), whether the child got on, the attendant's number, and a request to start, change or stop.
 */
export function ParentBus() {
  const { current } = useChildren();
  const d = useLoad<any>(current ? `/students/${current.id}/bus` : null, [current?.id]);
  const [ask, setAsk] = useState(false);
  useEffect(() => { const t = setInterval(() => d.reload(), 60_000); return () => clearInterval(t); }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = d.data;
  return (
    <Screen title="My bus">
      {!b ? <Empty>Loading…</Empty> : <>
        {b.pending && <section className="card"><span className="pill orange">Request waiting</span> <span className="small">{words(b.pending.kind)} from {day(b.pending.from_date)}</span></section>}
        {!b.on ? <section className="card stack"><p>{current?.name.split(' ')[0]} does not use the school bus.</p>
          <button className="btn" onClick={() => setAsk(true)} disabled={!!b.pending}>Ask for the school bus</button></section> : <>
          {b.legs.map((l: any) => { const [label, tone] = TRIP[l.status] ?? [l.status, '']; const timesOnly = l.tracking === 'TIMES'; return (
            <section key={l.leg} className="card stack">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><b>{LEG[l.leg]}</b>
                {timesOnly && l.status !== 'CANCELLED' ? <span className="pill">Usual time</span> : <span className={`pill ${tone}`}>{label}</span>}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: '2rem', fontWeight: 700 }}>{l.eta ?? '—'}</span>
                {l.delayMin > 0 && l.status !== 'CANCELLED' && <span className="small" style={{ color: 'var(--orange)' }}>{l.delayMin} min late · usually {l.scheduled}</span>}
              </div>
              <div className="small">At <b>{l.stop}</b> · Bus {l.route.code} ({l.route.reg_no ?? 'vehicle to be assigned'})</div>
              {l.note && <div className="callout small">{l.note}</div>}
              {l.boarding && <div className="small"><span className="pill green">{words(l.boarding.status)}</span> at {time(l.boarding.at)}</div>}
              {l.stopsBefore.length > 0 && l.status === 'RUNNING' && <div className="tiny muted">Before your stop: {l.stopsBefore.map((s: any) => `${s.name} ${s.passed ? '✓' : s.eta ?? ''}`).join(' · ')}</div>}
              {l.position && l.status === 'RUNNING' && <div className="small">{l.distanceM !== null && !l.passed ? <b>{l.distanceM < 1000 ? `About ${Math.max(50, Math.round(l.distanceM / 50) * 50)} m from your stop` : `About ${(l.distanceM / 1000).toFixed(1)} km from your stop`}</b> : null}
                {' '}<a href={`https://www.google.com/maps?q=${l.position.lat},${l.position.lng}`} target="_blank" rel="noreferrer">See the bus on the map</a> <span className="tiny muted">· {l.tracking === 'DEVICE' ? 'from the bus’s tracker' : 'from the attendant’s phone'}, {time(l.position.at)}</span></div>}
              {timesOnly && <div className="tiny muted">This bus is not tracked; it is due at about this time every day. The school tells you if a run is not running.</div>}
              {l.route.attendant && <div className="small muted">Attendant: {l.route.attendant}{l.route.attendant_phone ? <> · <a href={`tel:${l.route.attendant_phone}`}>{l.route.attendant_phone.replace('+91', '')}</a></> : ''}</div>}
            </section>); })}
          <section className="card stack small"><span className="muted">On the bus from {day(b.from)}{b.to ? ` to ${day(b.to)}` : ''}.</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn quiet small" disabled={!!b.pending} onClick={() => setAsk(true)}>Change stop or stop the bus</button></div></section>
        </>}
        {ask && current && <BusRequest studentId={current.id} on={b.on} routes={b.routes} fares={b.fares} onDone={() => { setAsk(false); d.reload(); }} />}
      </>}
    </Screen>
  );
}

function BusRequest({ studentId, on, routes, fares, onDone }: { studentId: string; on: boolean; routes: any[]; fares: any[]; onDone: () => void }) {
  const [kind, setKind] = useState(on ? 'CHANGE' : 'START');
  const [stop, setStop] = useState('');
  const [from, setFrom] = useState(today());
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const fare = (zone: string) => fares.find((f: any) => f.zone === zone);
  return (
    <section className="card stack">
      {on && <div className="seg">{[['CHANGE', 'Change stop'], ['STOP', 'Stop the bus']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>}
      {kind !== 'STOP' && <label className="field"><span>Stop</span><select className="input" value={stop} onChange={(e) => setStop(e.target.value)}>
        <option value="">Choose the stop</option>{routes.map((r: any) => <optgroup key={r.id} label={`Bus ${r.code} · ${r.name}`}>{r.stops.map((s: any) => <option key={s.id} value={s.id}>{s.name} · {s.morning ?? '—'} / {s.afternoon ?? '—'}{fare(s.zone) ? ` · ${money(fare(s.zone).monthly_paise)} a month` : ''}</option>)}</optgroup>)}</select></label>}
      <label className="field"><span>From</span><input className="input" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="field"><span>Note for the school (optional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="tiny muted">The transport fee follows by itself: a month is charged if the bus is used by the 15th.</p>
      <button className="btn" disabled={busy || (kind !== 'STOP' && !stop)} onClick={async () => {
        if (await run(() => api('/transport/requests', { body: { studentId, kind, pickupStopId: kind === 'STOP' ? null : stop, dropStopId: kind === 'STOP' ? null : stop, fromDate: from, note } }), 'Sent to the school')) onDone();
      }}>Send request</button>
    </section>
  );
}
