import { useEffect, useMemo, useState } from 'react';
import { ClassAlerts } from './Health';
import { Link } from 'react-router-dom';
import { api, day, time, today, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, useSchools, ask, tell, askText } from '../ui';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (d: string) => ((new Date(`${d}T00:00:00`).getDay() + 6) % 7) + 1;
const plus = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

export function useMySections() {
  const { data } = useLoad<any[]>('/my/sections');
  return data ?? null;
}

export function SectionPicker({ sections, value, onChange }: { sections: any[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className="input" style={{ height: 36, width: 'auto' }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Class">
      {sections.map((s) => <option key={s.id} value={s.id}>{s.class_code}-{s.name} · {s.campus}{s.is_class_teacher ? ' (my class)' : ''}</option>)}
    </select>
  );
}

// ── Teacher: My day ─────────────────────────────────────────────────────────────────────────

export function MyDay({ user }: { user: User }) {
  const t = today();
  const wd = weekdayOf(t);
  const showDate = wd === 7 ? plus(1) : t;
  const { data: dayData } = useLoad<any>(`/my/day?date=${showDate}`);
  const sections = useMySections();
  const { data: leaves } = useLoad<any[]>('/leave');
  const { data: notes } = useLoad<any>('/notifications');
  const rows: any[] = dayData?.rows ?? [];
  const lessons = rows.filter((r) => r.kind === 'LESSON');
  const covers = rows.filter((r) => r.kind === 'COVER');
  const pending = (leaves ?? []).filter((l) => l.status === 'PENDING');
  const now = new Date().toTimeString().slice(0, 5);
  const isToday = showDate === t;
  const summary = dayData?.holiday ? `${dayData.holiday}: no classes.` : dayData?.absent ? 'You are marked absent today; your lessons are being covered.'
    : `${wd === 7 ? 'No school today. Monday: ' : ''}${lessons.length} lessons${covers.length ? ` and ${covers.length} cover` : ''}`;
  return (
    <main className="page">
      <section className="tile">
        <p className="eyebrow" style={{ color: 'var(--ink-2)' }}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1 style={{ marginTop: 6 }}>{greeting()}, {user.name.split(' ').slice(1).join(' ') || user.name}</h1>
        <p className="muted" style={{ marginTop: 8, fontSize: '1.1rem' }}>{dayData ? summary : 'Loading…'}{pending.length ? ` · ${pending.length} leave request${pending.length > 1 ? 's' : ''} waiting` : ''}{notes?.unread ? ` · ${notes.unread} unread` : ''}</p>
        {dayData?.classTeacherOf?.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{dayData.classTeacherOf.map((c: any) => (
          <span key={c.sectionId} className={`pill ${c.kind === 'CO' && c.acting ? 'orange' : 'blue'}`}>{c.kind === 'CLASS' ? `Class teacher of ${c.label}` : c.acting ? `Acting class teacher of ${c.label} today` : `Co-class teacher of ${c.label}`}</span>))}</div>}
        {dayData?.plans?.length > 0 && <div className="callout blue small" style={{ marginTop: 12 }}>{dayData.plans.map((p: any) => p.title).join(' · ')}: some periods are replaced.</div>}
        {isToday && !dayData?.holiday && (dayData?.classTeacherOf ?? []).some((c: any) => c.kind === 'CLASS' || c.acting) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {dayData.classTeacherOf.filter((c: any) => c.kind === 'CLASS' || c.acting).map((c: any) => <RollButton key={c.sectionId} sectionId={c.sectionId} label={c.label} />)}</div>}
      </section>
      {(dayData?.classTeacherOf ?? []).map((c: any) => <ClassAlerts key={c.sectionId} sectionId={c.sectionId} />)}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <section className="tile" style={{ flex: '2 1 520px' }}>
          <div className="tile-head"><h3>{isToday ? 'Today' : 'Monday'}</h3><Link to="/timetable" className="small">Full week</Link></div>
          {!dayData ? <Empty>Loading…</Empty> : rows.length === 0 ? <p className="muted">{dayData.holiday ? `${dayData.holiday}: no classes.` : `No lessons ${isToday ? 'today' : 'on Monday'}.`} <Link to="/timetable">See your week</Link></p> : rows.map((p) => {
            const live = isToday && p.starts <= now && now < p.ends;
            const coverRow = p.kind === 'COVER';
            const ctRow = p.kind === 'CLASS_TEACHER';
            const roll = coverRow || ctRow || (dayData.classTeacherOf ?? []).some((c: any) => c.sectionId === p.section_id && c.acting);
            return (
              <div key={`${p.kind}${p.section_id}${p.period ?? p.starts}`} className="list-row" style={{ gridTemplateColumns: '92px 1fr auto auto', background: live ? 'var(--blue-soft)' : coverRow ? 'var(--orange-soft)' : undefined, borderRadius: live || coverRow ? 12 : 0, padding: live || coverRow ? '14px 10px' : undefined }}>
                <span className="small muted">{ctRow ? p.starts : `P${p.period} · ${p.starts}`}</span>
                <span><b>{p.subject}</b> <span className="muted">· {p.label}</span>
                  {ctRow && <span className="pill blue" style={{ marginLeft: 8 }}>Your class</span>}
                  {coverRow && <span className="pill orange" style={{ marginLeft: 8 }}>Cover{p.teacher ? ` for ${p.teacher}` : ''}</span>}
                  {p.coveredBy && <span className="pill" style={{ marginLeft: 8 }}>Covered by {p.coveredBy}</span>}
                  {live && <span className="pill blue" style={{ marginLeft: 8 }}>Now</span>}</span>
                {roll ? <Link className="btn quiet small" to={`/attendance?section=${p.section_id}`}>Take roll</Link> : <span />}
                <Link className="btn quiet small" to={`/homework?section=${p.section_id}`}>Homework</Link>
              </div>);
          })}
        </section>
        <div className="stack" style={{ flex: '1 1 300px', gap: 20 }}>
          <section className="tile tight">
            <div className="tile-head" style={{ marginBottom: 8 }}><h3>Leave requests</h3><Link to="/leave" className="small">All</Link></div>
            {!leaves ? <Empty>Loading…</Empty> : pending.length === 0 ? <p className="muted small">Nothing waiting.</p> : pending.slice(0, 4).map((l) => (
              <div key={l.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{l.student_name}</b><div className="tiny muted">{day(l.from)}{l.days > 1 ? ` – ${day(l.to)}` : ''} · {l.reason}</div></span><Link className="btn small" to="/leave">Review</Link></div>))}
          </section>
          <section className="tile tight">
            <h3 style={{ marginBottom: 8 }}>My classes</h3>
            {!sections ? <Empty>Loading…</Empty> : sections.map((s) => (
              <div key={s.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{s.class_code}-{s.name}</b> <span className="muted small">· {s.strength} students</span></span>{s.is_class_teacher && <span className="pill blue">Class teacher</span>}</div>))}
          </section>
        </div>
      </div>
    </main>
  );
}

/** A class teacher's roll for today: one tap to take it, and a plain confirmation once it is taken. */
function RollButton({ sectionId, label }: { sectionId: string; label: string }) {
  const { data } = useLoad<{ markedAt: string | null }>(`/sections/${sectionId}/attendance`, [sectionId]);
  if (!data) return null;
  return data.markedAt
    ? <Link to={`/attendance?section=${sectionId}`} className="pill green" style={{ height: 36, padding: '0 14px' }}>Roll taken for {label} · {new Date(data.markedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</Link>
    : <Link to={`/attendance?section=${sectionId}`} className="btn">Take today’s roll for {label}</Link>;
}

// ── Homework ──────────────────────────────────────────────────────────────────────────────

export function Homework() {
  const sections = useMySections();
  const initial = new URLSearchParams(location.search).get('section') ?? '';
  const [sectionId, setSectionId] = useState(initial);
  useEffect(() => { if (!sectionId && sections?.length) setSectionId((sections.find((s) => s.has_timetable) ?? sections[0]).id); }, [sections, sectionId]);
  const list = useLoad<any[]>(sectionId ? `/sections/${sectionId}/homework` : null, [sectionId]);
  const { data: subjects } = useLoad<any[]>('/subjects');
  const [form, setForm] = useState({ subjectCode: 'MAT', title: '', details: '', dueOn: plus(1) });
  const { run, busy } = useAction();
  const section = sections?.find((s) => s.id === sectionId);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Homework</span><span className="spacer" />{sections && <SectionPicker sections={sections} value={sectionId} onChange={setSectionId} />}</div></div>
      <main className="page">
        {sections?.length === 0 && <div className="callout">You have no classes on your timetable yet.</div>}
        <div className="row">
          <section className="tile" style={{ flex: '1 1 340px' }}>
            <h3>Set homework{section ? ` for ${section.class_code}-${section.name}` : ''}</h3>
            <p className="muted small" style={{ marginTop: 4 }}>Every parent in the class gets it in the app straight away.</p>
            <div className="stack" style={{ marginTop: 16 }}>
              <label className="field"><span>Subject</span><select className="input" value={form.subjectCode} onChange={(e) => setForm({ ...form, subjectCode: e.target.value })}>{(subjects ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
              <label className="field"><span>What to do</span><input className="input" value={form.title} maxLength={160} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Exercise 6.3, questions 1–12" /></label>
              <label className="field"><span>Details (optional)</span><textarea className="input" value={form.details} maxLength={4000} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
              <label className="field"><span>Due</span><input className="input" type="date" min={today()} value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} /></label>
              <button className="btn" disabled={busy || form.title.trim().length < 3 || !sectionId} onClick={async () => {
                const r = await run(() => api<{ notified: number }>('/homework', { body: { sectionId, ...form } }));
                if (r) { setForm({ ...form, title: '', details: '' }); list.reload(); }
              }}>Send to parents</button>
            </div>
          </section>
          <section className="tile" style={{ flex: '2 1 520px' }}>
            <h3>Set for this class</h3>
            {!list.data ? <Empty>Loading…</Empty> : list.data.length === 0 ? <Empty>No homework yet.</Empty> : list.data.map((h) => (
              <div key={h.id} className="list-row" style={{ gridTemplateColumns: '1fr auto', opacity: h.withdrawn_at ? 0.5 : 1 }}>
                <span><span className="pill" style={{ marginRight: 8 }}>{h.subject}</span><b>{h.title}</b>
                  <div className="small muted" style={{ marginTop: 4 }}>Due {day(h.due_on)} · set {day(h.assigned_on)} by {h.set_by}{h.withdrawn_at ? ' · withdrawn' : ''}</div>
                  {h.details && <div className="small" style={{ marginTop: 4 }}>{h.details}</div>}
                  {!h.withdrawn_at && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><div className="bar" style={{ width: 160 }}><span style={{ width: `${(h.done / Math.max(1, h.strength)) * 100}%`, background: 'var(--green)' }} /></div><span className="tiny muted">{h.done} of {h.strength} ticked done by parents</span></div>}
                </span>
                {!h.withdrawn_at && <button className="btn quiet small" onClick={async () => { if (await ask('Withdraw this homework? Parents will no longer see it.') && await run(() => api(`/homework/${h.id}/withdraw`, { method: 'POST' }), 'Withdrawn')) list.reload(); }}>Withdraw</button>}
              </div>))}
          </section>
        </div>
      </main>
    </>
  );
}

// ── Timetable ─────────────────────────────────────────────────────────────────────────────

export const LeaveStatus = ({ s }: { s: string }) => {
  const [tone, label] = ({ PENDING: ['orange', 'Waiting'], APPROVED: ['green', 'Approved'], REJECTED: ['red', 'Not approved'], CANCELLED: ['', 'Cancelled'] } as Record<string, [string, string]>)[s] ?? ['', s];
  return <span className={`pill ${tone}`}>{label}</span>;
};

// ── Leave requests ────────────────────────────────────────────────────────────────────────

export function LeaveRequests({ user }: { user: User }) {
  const { schools } = useSchools();
  const schoolId = schools[0]?.id;
  const { data, reload } = useLoad<any[]>(user.role === 'TEACHER' ? '/leave' : schoolId ? `/leave?schoolId=${schoolId}` : null, [schoolId]);
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const { run, busy } = useAction();
  const rows = (data ?? []).filter((l) => filter === 'ALL' || l.status === 'PENDING');
  const decide = async (id: string, approve: boolean) => {
    const note = approve ? '' : await askText('Reason for not approving (the parent will see this)') ?? undefined;
    if (note === undefined) return;
    if (await run(() => api(`/leave/${id}/decide`, { body: { approve, note: note || undefined } }), approve ? 'Approved. The parent has been told.' : 'Not approved. The parent has been told.')) reload();
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Leave requests</span><span className="spacer" />
        <div className="seg"><button className={filter === 'PENDING' ? 'on' : ''} onClick={() => setFilter('PENDING')}>Waiting</button><button className={filter === 'ALL' ? 'on' : ''} onClick={() => setFilter('ALL')}>All</button></div></div></div>
      <main className="page">
        <section className="tile">
          <p className="muted" style={{ marginBottom: 12 }}>{user.role === 'TEACHER' ? 'Requests from parents in your class. Approved leave is marked L in attendance automatically.' : 'All leave requests in the school.'}</p>
          {!data ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>{filter === 'PENDING' ? 'Nothing waiting.' : 'No leave requests.'}</Empty> : (
            <div className="scroll-x"><table className="table"><thead><tr><th>Student</th><th>Dates</th><th>Reason</th><th>Status</th><th /></tr></thead><tbody>
              {rows.map((l) => <tr key={l.id}><td><b>{l.student_name}</b><div className="tiny muted">{l.class_code}-{l.section} · {l.admission_no}</div></td>
                <td>{day(l.from)}{l.days > 1 ? ` – ${day(l.to)}` : ''}<div className="tiny muted">{l.days} day{l.days > 1 ? 's' : ''}</div></td>
                <td style={{ maxWidth: 320 }}>{l.reason}{l.decision_note && <div className="tiny muted">Note: {l.decision_note}</div>}</td>
                <td><LeaveStatus s={l.status} /></td>
                <td className="num">{l.status === 'PENDING' && <span style={{ display: 'inline-flex', gap: 6 }}><button className="btn small" disabled={busy} onClick={() => decide(l.id, true)}>Approve</button><button className="btn quiet small" disabled={busy} onClick={() => decide(l.id, false)}>Decline</button></span>}</td></tr>)}
            </tbody></table></div>)}
        </section>
      </main>
    </>
  );
}

// ── Notices and circulars ─────────────────────────────────────────────────────────────────

const KIND_TONE: Record<string, string> = { CIRCULAR: 'blue', NOTICE: '', EVENT: 'green', URGENT: 'red', HOLIDAY: 'green', VACATION: 'green', EXAM: 'orange', PTM: 'blue' };

function useIssuingUnits(user: User) {
  const { units } = useSchools();
  return useMemo(() => units.filter((u) => (user.role === 'SCHOOL_ADMIN' ? u.kind === 'school' : u.kind !== 'campus')).filter((u) => u.active), [units, user.role]);
}

export function Notices({ user }: { user: User }) {
  const { data, reload } = useLoad<any[]>('/notices');
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const canIssue = ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(user.role);
  const { run } = useAction();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Notices and circulars</span><span className="spacer" />{canIssue && <button className="btn small" onClick={() => setComposing(true)}>New notice</button>}</div></div>
      <main className="page">
        <section className="tile">
          <p className="muted" style={{ marginBottom: 8 }}>{user.role === 'NES_ADMIN' ? 'Circulars from NES reach every school. Command and school notices reach their own schools.' : 'Notices from NES, your Command and your school.'}</p>
          {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No notices yet.</Empty> : data.map((n) => (
            <button key={n.id} className="list-row" onClick={() => setOpen(n)} style={{ gridTemplateColumns: '1fr auto', width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line-soft)', textAlign: 'left', cursor: 'pointer', opacity: n.withdrawn_at ? 0.5 : 1 }}>
              <span><span className={`pill ${KIND_TONE[n.kind] ?? ''}`} style={{ marginRight: 8 }}>{words(n.kind)}</span><b>{n.title}</b>
                <div className="small muted" style={{ marginTop: 4 }}>{n.issued_by_unit} · {n.issued_by} · {time(n.created_at)} · to {words(n.audience)}{n.class_codes ? ` (${n.class_codes.join(', ')})` : ''}{n.is_public ? ' · on website' : ''}{n.withdrawn_at ? ' · withdrawn' : ''}</div></span>
              <span className="muted">›</span>
            </button>))}
        </section>
      </main>
      {open && <Drawer title={open.title} onClose={() => setOpen(null)}>
        <div className="tile tight"><p style={{ whiteSpace: 'pre-line' }}>{open.body}</p><p className="small muted" style={{ marginTop: 12 }}>{open.issued_by_unit} · {open.issued_by} · {time(open.created_at)}</p></div>
        {canIssue && !open.withdrawn_at && <button className="btn danger" onClick={async () => { if (await ask('Withdraw this notice? Parents will no longer see it. It cannot be edited; publish a new one if needed.') && await run(() => api(`/notices/${open.id}/withdraw`, { method: 'POST' }), 'Withdrawn')) { setOpen(null); reload(); } }}>Withdraw notice</button>}
      </Drawer>}
      {composing && <ComposeNotice user={user} onClose={() => setComposing(false)} onSent={() => { setComposing(false); reload(); }} />}
    </>
  );
}

function ComposeNotice({ user, onClose, onSent }: { user: User; onClose: () => void; onSent: () => void }) {
  const units = useIssuingUnits(user);
  const [f, setF] = useState({ unitId: '', title: '', body: '', kind: 'NOTICE', audience: 'ALL', classCodes: '', isPublic: false });
  useEffect(() => { if (!f.unitId && units.length) setF((x) => ({ ...x, unitId: units[0].id })); }, [units, f.unitId]);
  const { run, busy } = useAction();
  return (
    <Drawer title="New notice" onClose={onClose}>
      <p className="muted small">A notice cannot be edited after it is sent — only withdrawn. Parents and staff are notified at once.</p>
      <label className="field"><span>From</span><select className="input" value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <div className="form-grid">
        <label className="field"><span>Type</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['NOTICE', 'CIRCULAR', 'EVENT', 'URGENT'].map((k) => <option key={k} value={k}>{words(k)}</option>)}</select></label>
        <label className="field"><span>For</span><select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="ALL">Parents and staff</option><option value="PARENTS">Parents only</option><option value="STAFF">Staff only</option></select></label>
      </div>
      <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>Notice</span><textarea className="input" rows={7} value={f.body} maxLength={8000} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <label className="field"><span>Only these classes (optional, e.g. VI, VII, VIII)</span><input className="input" value={f.classCodes} onChange={(e) => setF({ ...f, classCodes: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} />Also show on the school website</label>
      <button className="btn big" disabled={busy || f.title.trim().length < 3 || !f.body.trim()} onClick={async () => {
        const classCodes = f.classCodes.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
        const r = await run(() => api<{ notified: { parents: number; staff: number } }>('/notices', { body: { unitId: f.unitId, title: f.title, body: f.body, kind: f.kind, audience: f.audience, classCodes: classCodes.length ? classCodes : undefined, isPublic: f.isPublic } }));
        if (r) { await tell(`Sent. ${r.notified.parents} parents and ${r.notified.staff} staff notified.`); onSent(); }
      }}>Send notice</button>
    </Drawer>
  );
}

// ── Academic calendar ─────────────────────────────────────────────────────────────────────

export function CalendarPage({ user }: { user: User }) {
  const { data, reload } = useLoad<any[]>(`/calendar?from=${today()}&to=${plus(270)}`);
  const [adding, setAdding] = useState(false);
  const canEdit = ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(user.role);
  // An event can be removed only at its own level or below: a principal cannot remove NES's or the Command's events.
  const canRemove = (e: { unit_kind: string }) => user.role === 'NES_ADMIN' || (user.role === 'COMMAND_OFFICER' && e.unit_kind !== 'society') || (user.role === 'SCHOOL_ADMIN' && ['school', 'campus'].includes(e.unit_kind));
  const { run } = useAction();
  const months = new Map<string, any[]>();
  for (const e of data ?? []) { const k = new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); months.set(k, [...(months.get(k) ?? []), e]); }
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Calendar</span><span className="spacer" />{canEdit && <button className="btn small" onClick={() => setAdding(true)}>Add event</button>}</div></div>
      <main className="page">
        {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <section className="tile"><Empty>Nothing scheduled.</Empty></section> : [...months.entries()].map(([m, list]) => (
          <section key={m} className="tile tight">
            <h3 style={{ marginBottom: 6 }}>{m}</h3>
            {list.map((e) => (
              <div key={e.id} className="list-row" style={{ gridTemplateColumns: '56px 1fr auto auto' }}>
                <span className="date-chip"><b>{new Date(`${e.starts}T00:00:00`).getDate()}</b><span>{new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}</span></span>
                <span><b>{e.title}</b><div className="small muted">{e.ends !== e.starts ? `${day(e.starts)} – ${day(e.ends)} · ` : ''}{e.unit}</div></span>
                <span className={`pill ${KIND_TONE[e.kind] ?? ''}`}>{words(e.kind)}</span>
                {canRemove(e) ? <button className="linkbtn small" onClick={async () => { if (await ask(`Remove “${e.title}”?`) && await run(() => api(`/calendar/${e.id}`, { method: 'DELETE' }), 'Removed')) reload(); }}>Remove</button> : <span />}
              </div>))}
          </section>))}
      </main>
      {adding && <AddEvent user={user} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function AddEvent({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const units = useIssuingUnits(user);
  const [f, setF] = useState({ unitId: '', title: '', kind: 'HOLIDAY', from: plus(7), to: plus(7), notify: true });
  useEffect(() => { if (!f.unitId && units.length) setF((x) => ({ ...x, unitId: units[0].id })); }, [units, f.unitId]);
  const { run, busy } = useAction();
  return (
    <Drawer title="Add to the calendar" onClose={onClose}>
      <label className="field"><span>For</span><select className="input" value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>Type</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['HOLIDAY', 'VACATION', 'EXAM', 'EVENT', 'PTM'].map((k) => <option key={k} value={k}>{k === 'PTM' ? 'Parent–teacher meeting' : words(k)}</option>)}</select></label>
      <div className="form-grid">
        <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></label>
        <label className="field"><span>To</span><input className="input" type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />Notify parents</label>
      <button className="btn big" disabled={busy || f.title.trim().length < 2} onClick={async () => { if (await run(() => api('/calendar', { body: f }), 'Added to the calendar')) onSaved(); }}>Add</button>
    </Drawer>
  );
}

// ── Notifications (staff) ─────────────────────────────────────────────────────────────────

export function StaffNotifications() {
  const { data, reload } = useLoad<any>('/notifications');
  const { run } = useAction();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Notifications</span><span className="spacer" />{data?.unread > 0 && <button className="btn quiet small" onClick={async () => { await run(() => api('/notifications/read', { body: { all: true } })); reload(); }}>Mark all read</button>}</div></div>
      <main className="page"><section className="tile">
        {!data ? <Empty>Loading…</Empty> : data.items.length === 0 ? <Empty>No notifications.</Empty> : data.items.map((n: any) => (
          <Link key={n.id} to={n.link ?? '#'} className="row-link" onClick={() => !n.read_at && api('/notifications/read', { body: { ids: [n.id] } })}>
            <span className={!n.read_at ? 'unread' : ''} style={{ flex: 1 }}><b>{n.title}</b><div className="small muted">{n.body}</div></span>
            <span className="tiny muted">{time(n.created_at)}</span>
          </Link>))}
      </section></main>
    </>
  );
}
