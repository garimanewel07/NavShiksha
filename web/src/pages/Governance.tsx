import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, day, openPdf, time, today, words, type User } from '../api';
import { Drawer, Empty, ask, askText, useAction, useLoad, useSchools, type OrgUnit } from '../ui';
import { Files } from '../files';
import { FailedPage } from '../errors';

/**
 * Committees, meetings and decisions (NES, Command and school committees, working groups and the
 * NES Conference). Everyone sees "Waiting for me"; NES, Commands and principals also see the
 * decisions dashboard for their part of the tree and set up committees.
 */

export const KINDS: Record<string, string> = {
  EXECUTIVE: 'Executive Committee', MANAGEMENT_ADVISORY: 'Management Advisory Committee', ACADEMIC_ADVISORY: 'Academic Advisory Committee',
  SCHOOL_MANAGING: 'School Managing Committee', ACADEMIC_MONITORING: 'Academic Monitoring Committee', PURCHASE: 'Purchase Committee',
  CHILD_PROTECTION: 'Child Protection Committee', SAFETY: 'Safety Committee', WORKING_GROUP: 'Working group', CONFERENCE: 'NES Conference', OTHER: 'Other committee',
};
const NES_ONLY = ['EXECUTIVE', 'MANAGEMENT_ADVISORY', 'ACADEMIC_ADVISORY', 'CONFERENCE'];
const TONE: Record<string, string> = { PROPOSED: 'blue', DECIDED: 'blue', IN_PROGRESS: 'orange', IMPLEMENTED: 'green', CLOSED: '', DEFERRED: '', NEEDS_MEETING: 'orange', NOT_ADOPTED: 'red',
  SCHEDULED: 'blue', HELD: 'green', CANCELLED: 'red', DRAFT: 'orange', CIRCULATED: 'blue', CONFIRMED: 'green', SUBMITTED: 'blue', ACCEPTED: 'green' };
const STATUS_WORD: Record<string, string> = { PROPOSED: 'Proposed', DECIDED: 'Decided', IN_PROGRESS: 'In progress', IMPLEMENTED: 'Implemented', CLOSED: 'Closed', DEFERRED: 'Deferred',
  NEEDS_MEETING: 'Needs another meeting', NOT_ADOPTED: 'Not adopted' };
const Pill = ({ s }: { s: string }) => <span className={`pill ${TONE[s] ?? ''}`}>{STATUS_WORD[s] ?? words(s)}</span>;
const MANAGERS = ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'];
const Progress = ({ value }: { value: number | null }) => value === null || value === undefined ? null
  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="bar" style={{ width: 90 }}><span style={{ width: `${value}%`, background: value === 100 ? 'var(--green)' : undefined }} /></span><span className="tiny muted">{value}%</span></span>;
const local = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function Governance({ user }: { user: User }) {
  const manager = MANAGERS.includes(user.role);
  const [tab, setTab] = useState(manager ? 'decisions' : 'mine');
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Committees and decisions</span><span className="spacer" style={{ flex: 1 }} />
        <div className="seg">{[['mine', 'Waiting for me'], ...(manager ? [['decisions', 'Decisions']] : []), ['committees', 'Committees'], ['search', 'Search']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {manager && <button className="btn small" onClick={() => setCreating(true)}>New committee</button>}</div></div>
      <main className="page">
        {tab === 'mine' ? <MyWork /> : tab === 'decisions' ? <Dashboard /> : tab === 'committees' ? <CommitteeList /> : <Search />}
      </main>
      {creating && <NewCommittee user={user} onClose={(id) => { setCreating(false); if (id) nav(`/governance/committees/${id}`); }} />}
    </>
  );
}

function DecisionRows({ rows, empty }: { rows: any[]; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return <>{rows.map((d) => <Link key={d.id} to={`/governance/decisions/${d.id}`} className="list-row row-link" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', color: 'inherit', textDecoration: 'none' }}>
    <span><b>{d.title}</b> {d.confidential && <span className="pill">Confidential</span>}
      <span className="tiny muted" style={{ display: 'block' }}>{d.ref} · {d.committee}{d.owner ? ` · ${d.owner}` : ''}{d.due_on ? ` · due ${day(d.due_on)}` : ''}{d.schools ? ` · ${d.reported} of ${d.schools} schools reported` : ''}</span></span>
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}><Progress value={d.progress} />{(d.overdue || d.overdue_actions > 0) && <span className="pill red">Overdue</span>}<Pill s={d.status} /></span>
  </Link>)}</>;
}

function MyWork() {
  const m = useLoad<any>('/governance/mine');
  const [upd, setUpd] = useState<any>(null);
  if (!m.data) return <Empty>{m.error ?? 'Loading…'}</Empty>;
  const x = m.data;
  const nothing = !x.actions.length && !x.owned.length && !x.meetings.length && !x.votes.length && !x.toConfirm.length && !x.toTriage.length && !x.forSchool.length;
  return <>
    {nothing && <section className="tile"><Empty>Nothing is waiting for you. Meetings, votes, actions and decisions for your school will appear here.</Empty></section>}
    {x.votes.length > 0 && <section className="tile"><h3>Your vote is needed</h3>{x.votes.map((v: any) => <Link key={v.id} to={`/governance/decisions/${v.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{v.title}</b><span className="tiny muted" style={{ display: 'block' }}>{v.ref} · {v.committee}</span></span><span className="pill orange">Closes {day(v.circulation_closes)}</span></Link>)}</section>}
    {x.toConfirm.length > 0 && <section className="tile"><h3>Minutes to confirm</h3>{x.toConfirm.map((g: any) => <Link key={g.id} to={`/governance/meetings/${g.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr' }}><span><b>{g.title}</b><span className="tiny muted" style={{ display: 'block' }}>{g.committee}</span></span></Link>)}</section>}
    {x.toTriage.length > 0 && <section className="tile"><h3>Agenda items to sort</h3>{x.toTriage.map((c: any) => <Link key={c.id} to={`/governance/committees/${c.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr auto' }}><b>{c.name}</b><span className="pill blue">{c.items} new</span></Link>)}</section>}
    {x.forSchool.length > 0 && <section className="tile"><h3>Decisions for your school</h3><p className="tiny muted">Acknowledge each, then report what the school has done.</p>
      {x.forSchool.map((d: any) => <Link key={`${d.id}${d.school_id}`} to={`/governance/decisions/${d.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr auto' }}>
        <span><b>{d.title}</b><span className="tiny muted" style={{ display: 'block' }}>{d.ref} · {d.committee}</span></span><span className={`pill ${d.acknowledged_at ? 'blue' : 'orange'}`}>{d.acknowledged_at ? 'Report due' : 'To acknowledge'}</span></Link>)}</section>}
    {x.actions.length > 0 && <section className="tile"><h3>Your actions</h3>{x.actions.map((a: any) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      <span><b>{a.title}</b><span className="tiny muted" style={{ display: 'block' }}><Link to={`/governance/decisions/${a.decision_id}`}>{a.ref}</Link> {a.decision} · due {day(a.due_on)}</span></span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Progress value={a.percent} />{a.overdue && <span className="pill red">Overdue</span>}<button className="btn quiet small" onClick={() => setUpd(a)}>Update</button></span></div>)}</section>}
    {x.owned.length > 0 && <section className="tile"><h3>Decisions you own</h3><DecisionRows rows={x.owned} empty="" /></section>}
    {x.meetings.length > 0 && <section className="tile"><h3>Your meetings</h3>{x.meetings.map((g: any) => <Link key={g.id} to={`/governance/meetings/${g.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{g.title}</b><span className="tiny muted" style={{ display: 'block' }}>{g.committee} · {g.venue || 'Online'}</span></span><span className="small">{time(g.starts_at)}</span></Link>)}</section>}
    {upd && <UpdateAction action={upd} onClose={() => { setUpd(null); m.reload(); }} />}
  </>;
}

function Dashboard() {
  const d = useLoad<any>('/governance/dashboard');
  const [show, setShow] = useState('overdue');
  const list = useLoad<any[]>(show === 'overdue' ? null : `/governance/decisions${show === 'all' ? '' : `?status=${show}`}`, [show]);
  if (!d.data) return <Empty>{d.error ?? 'Loading…'}</Empty>;
  const t = d.data.totals;
  const rows = show === 'overdue' ? d.data.overdue : (list.data ?? []).filter((x) => x.status !== 'PROPOSED');
  return <>
    <section className="tile"><div className="kpis">
      <div><div className="kpi-label">Open</div><div className="kpi-value">{t.open}</div><div className="kpi-note">decided, being carried out</div></div>
      <div><div className="kpi-label">Overdue</div><div className="kpi-value" style={{ color: t.overdue ? 'var(--red)' : undefined }}>{t.overdue}</div><div className="kpi-note">past a due date</div></div>
      <div><div className="kpi-label">Implemented</div><div className="kpi-value">{t.implemented}</div><div className="kpi-note">waiting to be closed</div></div>
      <div><div className="kpi-label">Closed</div><div className="kpi-value">{t.closed}</div></div>
      <div><div className="kpi-label">Back to committee</div><div className="kpi-value">{t.waiting}</div><div className="kpi-note">deferred or needing a meeting</div></div>
    </div></section>
    <section className="tile">
      <div className="tile-head"><h3>Decisions</h3><div className="seg">{[['overdue', 'Overdue'], ['IN_PROGRESS', 'In progress'], ['DECIDED', 'Not started'], ['IMPLEMENTED', 'Implemented'], ['all', 'All']].map(([k, l]) => <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>)}</div></div>
      {show !== 'overdue' && !list.data ? <Empty>Loading…</Empty> : <DecisionRows rows={rows} empty={show === 'overdue' ? 'Nothing is overdue.' : 'No decisions here.'} />}
    </section>
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      <section className="tile"><h3>By committee</h3>{!d.data.byCommittee.length ? <Empty>No decisions yet.</Empty> : <table className="table"><thead><tr><th>Committee</th><th className="num">Open</th><th className="num">Overdue</th><th className="num">Closed</th></tr></thead>
        <tbody>{d.data.byCommittee.map((g: any) => <tr key={g.name}><td>{g.name}</td><td className="num">{g.open}</td><td className="num" style={{ color: g.overdue ? 'var(--red)' : undefined }}>{g.overdue}</td><td className="num">{g.closed}</td></tr>)}</tbody></table>}</section>
      <section className="tile"><h3>Action-taken reports from schools</h3>{!d.data.atr.length ? <Empty>No decisions have been sent to schools.</Empty> : <table className="table"><thead><tr><th>School</th><th className="num">Sent</th><th className="num">Acknowledged</th><th className="num">Reported</th></tr></thead>
        <tbody>{d.data.atr.map((s: any) => <tr key={s.school}><td>{s.school}</td><td className="num">{s.sent}</td><td className="num">{s.acknowledged}</td><td className="num" style={{ color: s.reported < s.sent ? 'var(--orange)' : undefined }}>{s.reported}</td></tr>)}</tbody></table>}</section>
      <section className="tile"><h3>By owner</h3>{!d.data.byOwner.length ? <Empty>No owners yet.</Empty> : <table className="table"><thead><tr><th>Owner</th><th className="num">Open</th><th className="num">Overdue</th></tr></thead>
        <tbody>{d.data.byOwner.slice(0, 15).map((g: any) => <tr key={g.name}><td>{g.name}</td><td className="num">{g.open}</td><td className="num" style={{ color: g.overdue ? 'var(--red)' : undefined }}>{g.overdue}</td></tr>)}</tbody></table>}</section>
      <section className="tile"><h3>Coming meetings</h3>{!d.data.upcoming.length ? <Empty>No meetings scheduled.</Empty> : d.data.upcoming.map((g: any) => <Link key={g.id} to={`/governance/meetings/${g.id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr auto' }}>
        <span><b>{g.title}</b><span className="tiny muted" style={{ display: 'block' }}>{g.committee}</span></span><span className="small">{time(g.starts_at)}</span></Link>)}</section>
    </div>
  </>;
}

function CommitteeList() {
  const l = useLoad<any[]>('/governance/committees');
  if (!l.data) return <Empty>{l.error ?? 'Loading…'}</Empty>;
  if (!l.data.length) return <section className="tile"><Empty>You are not on any committee.</Empty></section>;
  return <section className="tile">{l.data.map((c) => <Link key={c.id} to={`/governance/committees/${c.id}`} className="list-row row-link" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', opacity: c.active ? 1 : 0.6 }}>
    <span><b>{c.name}</b> {c.confidential && <span className="pill">Confidential</span>} {!c.active && <span className="pill">Dissolved</span>}
      <span className="tiny muted" style={{ display: 'block' }}>{KINDS[c.kind]} · {c.unit} · {c.members} members{c.my_role ? ` · you are ${c.my_role.toLowerCase()}` : ''}{c.ends_on ? ` · until ${day(c.ends_on)}` : ''}</span></span>
    <span className="small" style={{ textAlign: 'right' }}>{c.next_meeting ? <>Next meeting<br /><b>{time(c.next_meeting)}</b></> : <span className="muted">No meeting set</span>}{c.open_decisions ? <span className="tiny muted" style={{ display: 'block' }}>{c.open_decisions} open decisions</span> : null}</span>
  </Link>)}</section>;
}

function Search() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const r = useLoad<any>(term.length > 1 ? `/governance/search?q=${encodeURIComponent(term)}` : null, [term]);
  return <section className="tile stack">
    <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} style={{ display: 'flex', gap: 8 }}>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A topic, a decision number, a word from the minutes" aria-label="Search" />
      <button className="btn">Search</button></form>
    {term.length > 1 && (!r.data ? <Empty>{r.error ?? 'Searching…'}</Empty> : <>
      <h3>Decisions</h3><DecisionRows rows={r.data.decisions.filter((d: any) => d.status !== 'PROPOSED')} empty="No decisions match." />
      <h3>In confirmed minutes</h3>{!r.data.items.length ? <Empty>Nothing in the minutes matches.</Empty> : r.data.items.map((i: any) => <Link key={i.id} to={`/governance/meetings/${i.meeting_id}`} className="list-row row-link" style={{ gridTemplateColumns: '1fr' }}>
        <span><b>{i.title}</b><span className="tiny muted" style={{ display: 'block' }}>{i.meeting} · {i.committee} · {day(i.starts_at)}</span>{i.discussion && <span className="small" style={{ display: 'block' }}>{i.discussion}</span>}</span></Link>)}
    </>)}
  </section>;
}

// ── People ───────────────────────────────────────────────────────────────────────────────────

type Person = { id: string; name: string; designation?: string | null; unit?: string };

/** Finds a member of staff under a unit, by name or post. */
export function PersonPicker({ unitId, value, onChange, label, optional }: { unitId: string; value: Person | null; onChange: (p: Person | null) => void; label: string; optional?: boolean }) {
  const [q, setQ] = useState('');
  const found = useLoad<Person[]>(unitId && !value ? `/governance/people?unitId=${unitId}&q=${encodeURIComponent(q)}` : null, [unitId, q, !!value]);
  return <div className="field"><span>{label}{optional ? ' (optional)' : ''}</span>
    {value ? <div className="callout small" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span><b>{value.name}</b>{value.designation ? ` · ${value.designation}` : ''}</span><button type="button" className="linkbtn small" onClick={() => onChange(null)}>Change</button></div>
      : <><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or post" />
        {(found.data ?? []).length > 0 && <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--line-soft)', borderRadius: 10, marginTop: 4 }}>
          {found.data!.slice(0, 12).map((p) => <button type="button" key={p.id} className="list-row" style={{ gridTemplateColumns: '1fr', width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', padding: '6px 10px' }} onClick={() => onChange(p)}>
            <span className="small"><b>{p.name}</b> <span className="muted">{p.designation} · {p.unit}</span></span></button>)}</div>}</>}
  </div>;
}

function NewCommittee({ user, onClose }: { user: User; onClose: (id?: string) => void }) {
  const { units } = useSchools();
  const choices = units.filter((u) => u.kind !== 'campus' && u.active && (user.role === 'NES_ADMIN' || (user.role === 'COMMAND_OFFICER' ? u.kind !== 'society' : u.kind === 'school')) && (!user.scopePath || u.path.startsWith(user.scopePath)));
  const [unitId, setUnitId] = useState('');
  useEffect(() => { if (!unitId && choices.length) setUnitId(choices[0].id); }, [choices.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const unit = units.find((u) => u.id === unitId);
  const kinds = Object.keys(KINDS).filter((k) => unit?.kind === 'society' ? k !== 'SCHOOL_MANAGING' : !NES_ONLY.includes(k) && (k !== 'SCHOOL_MANAGING' || unit?.kind === 'school'));
  const [f, setF] = useState({ kind: '', name: '', purpose: '', quorum: '3', endsOn: '', confidential: false });
  const [chair, setChair] = useState<Person | null>(null);
  const [convener, setConvener] = useState<Person | null>(null);
  const [members, setMembers] = useState<Person[]>([]);
  const [outside, setOutside] = useState<{ name: string; detail: string; email: string; role: string }[]>([]);
  const [pick, setPick] = useState<Person | null>(null);
  const { run, busy } = useAction();
  useEffect(() => { if (!kinds.includes(f.kind)) setF((x) => ({ ...x, kind: kinds[0] ?? '' })); }, [unitId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pick) { if (![chair?.id, convener?.id, ...members.map((m) => m.id)].includes(pick.id)) setMembers([...members, pick]); setPick(null); } }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const list = [{ userId: chair!.id, role: 'CHAIR' }, { userId: convener!.id, role: 'CONVENER' }, ...members.map((m) => ({ userId: m.id, role: 'MEMBER' })),
      ...outside.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), detail: o.detail.trim(), email: o.email.trim() || undefined, role: o.role }))];
    const r: any = await run(() => api('/governance/committees', { body: { unitId, kind: f.kind, name: f.name.trim() || undefined, purpose: f.purpose, quorum: Number(f.quorum), endsOn: f.endsOn || null, confidential: f.confidential || undefined, members: list } }), 'Committee set up; members are told');
    if (r) onClose(r.id);
  };
  return <Drawer title="New committee" onClose={() => onClose()}>
    <section className="tile tight stack">
      <div className="form-grid">
        <label className="field"><span>At</span><select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>{choices.map((u: OrgUnit) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}</select></label>
      </div>
      <label className="field"><span>Name (optional)</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === 'WORKING_GROUP' ? 'Working group on …' : `${KINDS[f.kind] ?? ''}${unit && unit.kind !== 'society' ? `, ${unit.name}` : ''}`} /></label>
      <label className="field"><span>{f.kind === 'WORKING_GROUP' ? 'The topic and what the group must deliver' : 'Terms of reference'}</span><textarea className="input" rows={3} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
      <div className="form-grid">
        <label className="field"><span>Quorum (members present)</span><input className="input" type="number" min={1} max={100} value={f.quorum} onChange={(e) => setF({ ...f, quorum: e.target.value })} /></label>
        {['WORKING_GROUP', 'CONFERENCE'].includes(f.kind) && <label className="field"><span>{f.kind === 'WORKING_GROUP' ? 'Deadline' : 'Last day'}</span><input className="input" type="date" min={today()} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></label>}
      </div>
      <label className="check small"><input type="checkbox" checked={f.confidential || f.kind === 'CHILD_PROTECTION'} disabled={f.kind === 'CHILD_PROTECTION'} onChange={(e) => setF({ ...f, confidential: e.target.checked })} /> Confidential: only members see its agenda, minutes and decisions</label>
    </section>
    <section className="tile tight stack">
      <h3>Members</h3>
      <PersonPicker unitId={unitId} value={chair} onChange={setChair} label="Chair" />
      <PersonPicker unitId={unitId} value={convener} onChange={setConvener} label="Convener (runs the meetings in NavShiksha)" />
      {members.map((m) => <div key={m.id} className="small" style={{ display: 'flex', justifyContent: 'space-between' }}><span>{m.name} <span className="muted">{m.designation}</span></span><button className="linkbtn tiny" onClick={() => setMembers(members.filter((x) => x.id !== m.id))}>Remove</button></div>)}
      <PersonPicker unitId={unitId} value={pick} onChange={setPick} label="Add a member" />
      {outside.map((o, i) => <div key={i} className="form-grid">
        <label className="field"><span>Outside member</span><input className="input" value={o.name} onChange={(e) => setOutside(outside.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Name" /></label>
        <label className="field"><span>Post or organisation</span><input className="input" value={o.detail} onChange={(e) => setOutside(outside.map((x, j) => j === i ? { ...x, detail: e.target.value } : x))} placeholder="Parent representative" /></label>
      </div>)}
      <button type="button" className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setOutside([...outside, { name: '', detail: '', email: '', role: 'MEMBER' }])}>Add someone outside NavShiksha (a parent representative, a nominee)</button>
    </section>
    <button className="btn big" disabled={busy || !unitId || !f.kind || !chair || !convener || chair.id === convener.id || !(Number(f.quorum) >= 1) || (f.kind === 'WORKING_GROUP' && !f.endsOn)} onClick={save}>Set up the committee</button>
    {chair && convener && chair.id === convener.id && <p className="tiny muted">The chair and the convener are different people.</p>}
  </Drawer>;
}

// ── A committee ──────────────────────────────────────────────────────────────────────────────

export function CommitteePage({ user }: { user: User }) {
  const { id } = useParams();
  const c = useLoad<any>(`/governance/committees/${id}`, [id]);
  const [drawer, setDrawer] = useState<string | null>(null);
  const { run, busy } = useAction();
  const nav = useNavigate();
  if (!c.data) return c.error ? <FailedPage error={c.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const x = c.data, r = x.rights;
  const upcoming = x.meetings.filter((g: any) => g.status === 'SCHEDULED');
  const triage = async (item: any, action: string) => {
    let note: string | null = '';
    let meetingId: string | null = null;
    if (action === 'REJECT') { note = await askText('Why is it not taken up? The person who raised it is told.'); if (!note) return; }
    if (action === 'ACCEPT') meetingId = upcoming.length ? upcoming[upcoming.length - 1].id : null;
    if (await run(() => api(`/governance/agenda/${item.id}/triage`, { body: { action, meetingId, note: note || undefined } }), action === 'ACCEPT' ? (meetingId ? 'On the next meeting’s agenda' : 'Accepted for the next meeting') : 'Done')) c.reload();
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/governance" className="linkbtn small">‹ Committees</Link><span className="localnav-title" style={{ marginLeft: 8 }}>{x.name}</span><span className="spacer" style={{ flex: 1 }} />
        {r.submit && x.active && <button className="btn quiet small" onClick={() => setDrawer('item')}>{x.kind === 'CONFERENCE' && user.role === 'SCHOOL_ADMIN' && !r.myRole ? 'Submit a topic' : 'Submit an agenda item'}</button>}
        {r.run && x.active && <button className="btn quiet small" onClick={() => setDrawer('vote')}>Put a resolution to vote</button>}
        {r.run && x.active && <button className="btn small" onClick={() => setDrawer('meeting')}>{x.kind === 'CONFERENCE' ? 'Add a session' : 'Schedule a meeting'}</button>}</div></div>
      <main className="page">
        <section className="tile">
          <div className="eyebrow">{KINDS[x.kind]} · {x.unit}{x.confidential ? ' · confidential' : ''}{!x.active ? ' · dissolved' : ''}</div>
          {x.purpose && <p style={{ marginTop: 6, whiteSpace: 'pre-line' }}>{x.purpose}</p>}
          <p className="small muted" style={{ marginTop: 6 }}>Quorum {x.quorum}{x.ends_on ? ` · ${x.kind === 'WORKING_GROUP' ? 'deadline' : 'until'} ${day(x.ends_on)}` : ''}{r.myRole ? ` · you are ${r.myRole.toLowerCase()}` : ''}</p>
          {r.manage && <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn quiet small" onClick={() => setDrawer('member')}>Add a member</button>
            {x.active ? <button className="btn quiet small" disabled={busy} onClick={async () => { if (await ask(`Dissolve the ${x.name}? Its record stays; no new meetings can be held.`) && await run(() => api(`/governance/committees/${x.id}`, { method: 'PATCH', body: { active: false } }), 'Dissolved')) c.reload(); }}>Dissolve</button>
              : <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/governance/committees/${x.id}`, { method: 'PATCH', body: { active: true } }), 'Active again')) c.reload(); }}>Make active again</button>}</div>}
          {!r.see && <div className="callout small" style={{ marginTop: 10 }}>This committee is confidential: its meetings and decisions are for its members only.</div>}
        </section>
        {r.see && <>
          {x.agenda.length > 0 && <section className="tile"><h3>Agenda items waiting</h3>{x.agenda.map((a: any) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{a.title}</b> <span className={`pill ${TONE[a.status] ?? ''}`}>{a.status === 'ACCEPTED' ? 'For the next meeting' : words(a.status)}</span>
              <span className="tiny muted" style={{ display: 'block' }}>{a.raised_by}{a.for_school ? `, ${a.for_school}` : ''} · {time(a.created_at)}{a.triage_note ? ` · ${a.triage_note}` : ''}</span>{a.details && <span className="small" style={{ display: 'block' }}>{a.details}</span>}</span>
            {r.run && a.status !== 'ACCEPTED' && <span style={{ display: 'flex', gap: 6 }}><button className="btn small" disabled={busy} onClick={() => triage(a, 'ACCEPT')}>Accept</button>
              {a.status !== 'DEFERRED' && <button className="btn quiet small" disabled={busy} onClick={() => triage(a, 'DEFER')}>Defer</button>}<button className="btn quiet small" disabled={busy} onClick={() => triage(a, 'REJECT')}>Not taken up</button></span>}
          </div>)}</section>}
          <section className="tile"><h3>{x.kind === 'CONFERENCE' ? 'Sessions' : 'Meetings'}</h3>{!x.meetings.length ? <Empty>No meetings yet.</Empty> : x.meetings.map((g: any) => <Link key={g.id} to={`/governance/meetings/${g.id}`} className="list-row row-link" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{g.title}</b><span className="tiny muted" style={{ display: 'block' }}>{time(g.starts_at)} · {g.venue || 'Online'} · {g.items} items</span></span>
            <span style={{ display: 'flex', gap: 6 }}><span className={`pill ${TONE[g.status] ?? ''}`}>{words(g.status)}</span>{g.minutes_status !== 'NONE' && <span className={`pill ${TONE[g.minutes_status] ?? ''}`}>Minutes {g.minutes_status.toLowerCase()}</span>}</span></Link>)}</section>
          <section className="tile"><h3>Decisions</h3><DecisionRows rows={x.decisions.filter((d: any) => d.status !== 'PROPOSED' || d.by_circulation)} empty="No decisions yet." /></section>
        </>}
        <section className="tile"><h3>Members</h3>{x.members.map((m: any) => <div key={m.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', opacity: m.current ? 1 : 0.55 }}>
          <span><b>{m.name}</b> <span className="small muted">{m.detail}</span>{m.external && <span className="pill" style={{ marginLeft: 6 }}>Outside NavShiksha</span>}
            <span className="tiny muted" style={{ display: 'block' }}>{words(m.role)} · from {day(m.from)}{m.until ? ` to ${day(m.until)}` : ''}</span></span>
          {r.manage && m.current && <button className="linkbtn small" onClick={async () => { const on = await askText(`End ${m.name}'s term on which date? (YYYY-MM-DD)`, { initial: today() }); if (on && await run(() => api(`/governance/members/${m.id}/end`, { body: { on } }), 'Term ended')) c.reload(); }}>End term</button>}
        </div>)}</section>
      </main>
      {drawer === 'meeting' && <ScheduleMeeting committee={x} onClose={(gid) => { setDrawer(null); if (gid) nav(`/governance/meetings/${gid}`); }} />}
      {drawer === 'item' && <SubmitItem committeeId={x.id} meetings={upcoming} onClose={() => { setDrawer(null); c.reload(); }} />}
      {drawer === 'vote' && <DecisionForm unitId={x.unit_id} unitPath={x.unit_path} circulation onSave={async (b) => { const d: any = await run(() => api(`/governance/committees/${x.id}/circulation`, { body: b }), 'Sent to members to vote'); if (d) nav(`/governance/decisions/${d.id}`); return !!d; }} onClose={() => setDrawer(null)} />}
      {drawer === 'member' && <AddMember committee={x} onClose={() => { setDrawer(null); c.reload(); }} />}
    </>
  );
}

function AddMember({ committee, onClose }: { committee: any; onClose: () => void }) {
  const [p, setP] = useState<Person | null>(null);
  const [outside, setOutside] = useState({ name: '', detail: '' });
  const [role, setRole] = useState('MEMBER');
  const { run, busy } = useAction();
  return <Drawer title={`Add to the ${committee.name}`} onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>As</span><select className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="MEMBER">Member</option><option value="INVITEE">Special invitee (attends, does not vote)</option><option value="CHAIR">Chair (after the present chair’s term ends)</option><option value="CONVENER">Convener (after the present convener’s term ends)</option></select></label>
    <PersonPicker unitId={committee.unit_id} value={p} onChange={setP} label="Someone with a NavShiksha sign-in" />
    {!p && <div className="form-grid"><label className="field"><span>Or someone outside NavShiksha</span><input className="input" value={outside.name} onChange={(e) => setOutside({ ...outside, name: e.target.value })} placeholder="Name" /></label>
      <label className="field"><span>Post or organisation</span><input className="input" value={outside.detail} onChange={(e) => setOutside({ ...outside, detail: e.target.value })} /></label></div>}
    <button className="btn big" disabled={busy || (!p && outside.name.trim().length < 2)} onClick={async () => { if (await run(() => api(`/governance/committees/${committee.id}/members`, { body: p ? { userId: p.id, role } : { name: outside.name.trim(), detail: outside.detail.trim(), role } }), 'Added')) onClose(); }}>Add</button>
  </section></Drawer>;
}

function ScheduleMeeting({ committee, onClose }: { committee: any; onClose: (id?: string) => void }) {
  const [f, setF] = useState({ title: '', startsAt: '', venue: '', videoLink: '', agendaCloses: '' });
  const { run, busy } = useAction();
  return <Drawer title={committee.kind === 'CONFERENCE' ? 'Add a session' : 'Schedule a meeting'} onClose={() => onClose()}><section className="tile tight stack">
    <label className="field"><span>Title (optional)</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={committee.kind === 'CONFERENCE' ? 'Session on assessment reforms' : 'Numbered automatically'} /></label>
    <div className="form-grid">
      <label className="field"><span>Starts</span><input className="input" type="datetime-local" min={local(new Date().toISOString())} value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
      <label className="field"><span>Agenda closes (optional)</span><input className="input" type="datetime-local" value={f.agendaCloses} onChange={(e) => setF({ ...f, agendaCloses: e.target.value })} /></label>
    </div>
    <span className="tiny muted">If left blank, the agenda closes three days before the meeting.</span>
    <label className="field"><span>Venue</span><input className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} placeholder="Conference room, NES HQ" /></label>
    <label className="field"><span>Video link (optional)</span><input className="input" value={f.videoLink} onChange={(e) => setF({ ...f, videoLink: e.target.value })} placeholder="https://…" /></label>
    <p className="small muted">Members are told now and reminded the day before. Accepted agenda items go onto this meeting.</p>
    <button className="btn big" disabled={busy || !f.startsAt || (!f.venue.trim() && !f.videoLink.trim())} onClick={async () => {
      const r: any = await run(() => api(`/governance/committees/${committee.id}/meetings`, { body: { title: f.title || undefined, startsAt: new Date(f.startsAt).toISOString(), venue: f.venue, videoLink: f.videoLink, agendaCloses: f.agendaCloses ? new Date(f.agendaCloses).toISOString() : null } }), 'Scheduled; members are told');
      if (r) onClose(r.id);
    }}>Schedule</button>
  </section></Drawer>;
}

function SubmitItem({ committeeId, meetings, onClose }: { committeeId: string; meetings: any[]; onClose: () => void }) {
  const open = meetings.filter((g) => new Date(g.agenda_closes) > new Date());
  const [f, setF] = useState({ title: '', details: '', meetingId: open[open.length - 1]?.id ?? '', confidential: false });
  const { run, busy } = useAction();
  return <Drawer title="Submit an agenda item" onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>Topic</span><input className="input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
    <label className="field"><span>Background and what is proposed</span><textarea className="input" rows={5} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
    <label className="field"><span>For</span><select className="input" value={f.meetingId} onChange={(e) => setF({ ...f, meetingId: e.target.value })}>
      <option value="">The next meeting the convener chooses</option>{open.map((g) => <option key={g.id} value={g.id}>{g.title} · {time(g.starts_at)} (agenda closes {time(g.agenda_closes)})</option>)}</select></label>
    <label className="check small"><input type="checkbox" checked={f.confidential} onChange={(e) => setF({ ...f, confidential: e.target.checked })} /> Confidential: only members see it</label>
    <button className="btn big" disabled={busy || f.title.trim().length < 3} onClick={async () => { if (await run(() => api(`/governance/committees/${committeeId}/agenda`, { body: { ...f, meetingId: f.meetingId || null } }), 'Submitted; the convener will put it on the agenda')) onClose(); }}>Submit</button>
  </section></Drawer>;
}

// ── A decision form (in the minutes, or put to a vote) ─────────────────────────────────────────

export function DecisionForm({ unitId, unitPath, items, circulation, initial, onSave, onClose }: { unitId: string; unitPath: string; items?: any[]; circulation?: boolean; initial?: any; onSave: (b: any) => Promise<boolean>; onClose: () => void }) {
  const { schools } = useSchools();
  const under = schools.filter((s) => s.path.startsWith(unitPath));
  const [f, setF] = useState({ agendaItemId: initial?.agenda_item_id ?? items?.[0]?.id ?? '', title: initial?.title ?? items?.[0]?.title ?? '', body: initial?.body ?? '', reason: initial?.reason ?? '',
    outcome: initial?.outcome ?? 'DECIDED', dueOn: initial?.due_on ?? '', closesOn: '', confidential: !!initial?.confidential });
  const [owner, setOwner] = useState<Person | null>(initial?.owner_id ? { id: initial.owner_id, name: initial.owner } : null);
  const [schoolIds, setSchoolIds] = useState<string[]>([]);
  const [actions, setActions] = useState<{ title: string; owner: Person | null; dueOn: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const decided = f.outcome === 'DECIDED';
  const ok = f.title.trim().length >= 3 && f.body.trim().length >= 5 && (!circulation || f.closesOn) && actions.every((a) => a.title.trim().length >= 3 && a.owner && a.dueOn);
  return <Drawer title={initial ? `Change ${initial.ref}` : circulation ? 'Put a resolution to vote' : 'Record a decision'} onClose={onClose}>
    <section className="tile tight stack">
      {items && !initial && <label className="field"><span>Agenda item</span><select className="input" value={f.agendaItemId} onChange={(e) => { const it = items.find((i) => i.id === e.target.value); setF({ ...f, agendaItemId: e.target.value, title: it?.title ?? f.title }); }}>
        {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}<option value="">Not under an agenda item</option></select></label>}
      {!circulation && <div className="seg">{[['DECIDED', 'Decided'], ['DEFERRED', 'Deferred'], ['NEEDS_MEETING', 'Needs another meeting']].map(([k, l]) => <button type="button" key={k} className={f.outcome === k ? 'on' : ''} onClick={() => setF({ ...f, outcome: k })}>{l}</button>)}</div>}
      <label className="field"><span>Heading</span><input className="input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>{decided ? 'The decision, as it should be carried out' : 'What was said and what is still needed'}</span><textarea className="input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <label className="field"><span>Reason (optional)</span><textarea className="input" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      {circulation && <label className="field"><span>Voting closes</span><input className="input" type="date" min={today()} value={f.closesOn} onChange={(e) => setF({ ...f, closesOn: e.target.value })} /></label>}
      <label className="check small"><input type="checkbox" checked={f.confidential} onChange={(e) => setF({ ...f, confidential: e.target.checked })} /> Confidential: only members see it, and it is not sent to schools</label>
    </section>
    {decided && <section className="tile tight stack">
      <h3>Carrying it out</h3>
      <div className="form-grid"><PersonPicker unitId={unitId} value={owner} onChange={setOwner} label="Owner" optional />
        <label className="field"><span>Due by (optional)</span><input className="input" type="date" min={today()} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></label></div>
      {!initial && <>{actions.map((a, i) => <div key={i} className="callout stack small">
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Action {i + 1}</b><button type="button" className="linkbtn tiny" onClick={() => setActions(actions.filter((_, j) => j !== i))}>Remove</button></div>
        <input className="input" value={a.title} placeholder="What is to be done" onChange={(e) => setActions(actions.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
        <div className="form-grid"><PersonPicker unitId={unitId} value={a.owner} onChange={(p) => setActions(actions.map((x, j) => j === i ? { ...x, owner: p } : x))} label="By" />
          <label className="field"><span>Due</span><input className="input" type="date" min={today()} value={a.dueOn} onChange={(e) => setActions(actions.map((x, j) => j === i ? { ...x, dueOn: e.target.value } : x))} /></label></div>
      </div>)}
      <button type="button" className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setActions([...actions, { title: '', owner: null, dueOn: '' }])}>Add an action</button></>}
      {!initial && !f.confidential && under.length > 0 && <div className="field"><span>Send to schools (each acknowledges it and reports the action taken)</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <button type="button" className="linkbtn small" onClick={() => setSchoolIds(schoolIds.length === under.length ? [] : under.map((s) => s.id))}>{schoolIds.length === under.length ? 'None' : 'All'}</button>
          {under.map((s) => <label key={s.id} className="check small"><input type="checkbox" checked={schoolIds.includes(s.id)} onChange={(e) => setSchoolIds(e.target.checked ? [...schoolIds, s.id] : schoolIds.filter((x) => x !== s.id))} />{s.name}</label>)}</div></div>}
    </section>}
    <button className="btn big" disabled={busy || !ok} onClick={async () => {
      setBusy(true);
      const body: any = { title: f.title, body: f.body, reason: f.reason, confidential: f.confidential, ownerId: decided ? owner?.id ?? null : null, dueOn: decided && f.dueOn ? f.dueOn : null };
      if (!circulation) body.outcome = f.outcome;
      if (!initial) { body.agendaItemId = f.agendaItemId || null; body.schoolIds = decided && !f.confidential ? schoolIds : []; body.actions = decided ? actions.map((a) => ({ title: a.title, ownerId: a.owner!.id, dueOn: a.dueOn })) : []; }
      if (circulation) body.closesOn = f.closesOn;
      const done = await onSave(body);
      setBusy(false);
      if (done) onClose();
    }}>{initial ? 'Save' : circulation ? 'Send to members' : 'Record in the minutes'}</button>
  </Drawer>;
}

// ── A meeting ────────────────────────────────────────────────────────────────────────────────

export function MeetingPage() {
  const { id } = useParams();
  const m = useLoad<any>(`/governance/meetings/${id}`, [id]);
  const { run, busy } = useAction();
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [minutes, setMinutes] = useState<{ note: string; items: Record<string, string> }>({ note: '', items: {} });
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<any>(null);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (!m.data) return;
    setMarks(Object.fromEntries(m.data.attendance.map((a: any) => [a.member_id, a.status ?? (a.role === 'INVITEE' ? 'ABSENT' : 'PRESENT')])));
    setMinutes({ note: m.data.minutes_note, items: Object.fromEntries(m.data.items.map((i: any) => [i.id, i.discussion])) });
    setDirty(false);
  }, [m.data]);
  if (!m.data) return m.error ? <FailedPage error={m.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const g = m.data, r = g.rights;
  const editable = r.run && ['DRAFT', 'CIRCULATED'].includes(g.minutes_status);
  const canMark = r.run && g.status !== 'CANCELLED' && g.minutes_status !== 'CONFIRMED' && new Date(g.starts_at).getTime() <= Date.now() + 2 * 36e5;
  const saveMinutes = async () => { if (await run(() => api(`/governance/meetings/${g.id}/minutes`, { method: 'PUT', body: { note: minutes.note, items: Object.entries(minutes.items).map(([iid, discussion]) => ({ id: iid, discussion })) } }), 'Minutes saved')) m.reload(); };
  const decisionsFor = (itemId: string | null) => g.decisions.filter((d: any) => (d.agenda_item_id ?? null) === itemId);
  const showDecision = (d: any) => <div key={d.id} className="callout small" style={{ marginTop: 6 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><span><b>{d.ref}</b> · {d.title}</span><span>{d.status === 'PROPOSED' ? <span className="pill blue">{STATUS_WORD[d.outcome]} (on confirmation)</span> : <Pill s={d.status} />}</span></div>
    <div style={{ whiteSpace: 'pre-line', marginTop: 4 }}>{d.body}</div>
    <div className="tiny muted" style={{ marginTop: 4 }}>{d.owner ? `Owner ${d.owner}` : ''}{d.due_on ? ` · due ${day(d.due_on)}` : ''}{d.schools ? ` · to ${d.schools} school(s)` : ''}{d.open_actions ? ` · ${d.open_actions} action(s)` : ''}</div>
    <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>{d.status !== 'PROPOSED' && <Link to={`/governance/decisions/${d.id}`} className="small">Open</Link>}
      {editable && d.status === 'PROPOSED' && <><button className="linkbtn small" onClick={() => setForm({ edit: d })}>Change</button>
        <button className="linkbtn small" onClick={async () => { if (await ask(`Take ${d.ref} out of the minutes?`) && await run(() => api(`/governance/decisions/${d.id}`, { method: 'DELETE' }), 'Taken out')) m.reload(); }}>Take out</button></>}</div>
  </div>;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to={`/governance/committees/${g.committee.id}`} className="linkbtn small">‹ {g.committee.name}</Link><span className="spacer" style={{ flex: 1 }} />
        {g.minutes_status !== 'NONE' && <button className="btn quiet small" disabled={busy} onClick={() => run(() => openPdf(`/governance/meetings/${g.id}/minutes.pdf`))}>Minutes PDF</button>}
        {r.run && g.minutes_status === 'DRAFT' && <button className="btn small" disabled={busy || dirty} onClick={async () => { if (await ask('Circulate the minutes to members for comments? They can still be corrected until the chair confirms them.') && await run(() => api(`/governance/meetings/${g.id}/circulate`, { body: {} }), 'Circulated')) m.reload(); }}>Circulate to members</button>}
        {r.chair && g.minutes_status === 'CIRCULATED' && <button className="btn small" disabled={busy || dirty} onClick={async () => { if (await ask('Confirm the minutes? They are then locked; decisions take effect, go to the schools and owners are told.') && await run(() => api(`/governance/meetings/${g.id}/confirm`, { body: {} }), 'Minutes confirmed')) m.reload(); }}>Confirm the minutes</button>}
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="eyebrow">{g.committee.name} · {g.committee.unit}</div>
          <h2 style={{ marginTop: 4 }}>{g.title}</h2>
          <p className="small" style={{ marginTop: 6 }}>{time(g.starts_at)} · {g.venue || 'Online'}{g.video_link && <> · <a href={g.video_link} target="_blank" rel="noopener noreferrer">Join the video call</a></>}</p>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}><span className={`pill ${TONE[g.status] ?? ''}`}>{words(g.status)}</span>{g.minutes_status !== 'NONE' && <span className={`pill ${TONE[g.minutes_status] ?? ''}`}>Minutes {g.minutes_status.toLowerCase()}</span>}
            {g.status === 'SCHEDULED' && <span className="pill">Agenda {new Date(g.agenda_closes) > new Date() ? `closes ${time(g.agenda_closes)}` : 'closed'}</span>}
            {g.quorum_met !== null && <span className={`pill ${g.quorum_met ? 'green' : 'red'}`}>{g.present} present · quorum {g.committee.quorum} {g.quorum_met ? 'met' : 'not met'}</span>}</div>
          {g.status === 'CANCELLED' && <div className="callout red small" style={{ marginTop: 10 }}>Cancelled: {g.cancel_reason}</div>}
          {g.minutes_status === 'CONFIRMED' && <p className="tiny muted" style={{ marginTop: 8 }}>Confirmed by {g.confirmed_by}, {time(g.confirmed_at)}. The minutes are locked.</p>}
          {r.run && g.status === 'SCHEDULED' && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn quiet small" onClick={async () => { const v = await askText('Move the meeting to which date and time? (YYYY-MM-DD HH:MM)', { initial: local(g.starts_at).replace('T', ' ') }); if (v && await run(() => api(`/governance/meetings/${g.id}`, { method: 'PATCH', body: { startsAt: new Date(v.replace(' ', 'T')).toISOString() } }), 'Moved; members are told')) m.reload(); }}>Move</button>
            <button className="btn quiet small" onClick={async () => { const why = await askText('Why is the meeting cancelled? Members are told.'); if (why && await run(() => api(`/governance/meetings/${g.id}/cancel`, { body: { reason: why } }), 'Cancelled')) m.reload(); }}>Cancel the meeting</button></div>}
        </section>

        <section className="tile stack">
          <div className="tile-head"><h3>Agenda</h3>{r.submit && <Link className="btn quiet small" to={`/governance/committees/${g.committee.id}`}>Submit an item</Link>}</div>
          {g.minutes_status !== 'NONE' && <label className="field"><span>Opening</span>{editable ? <textarea className="input" rows={2} value={minutes.note} onChange={(e) => { setMinutes({ ...minutes, note: e.target.value }); setDirty(true); }} placeholder="The chair welcomed members…" />
            : <p className="small" style={{ whiteSpace: 'pre-line' }}>{g.minutes_note || '—'}</p>}</label>}
          {!g.items.length ? <Empty>No items on the agenda yet.</Empty> : g.items.map((it: any, n: number) => <div key={it.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <span><b>{n + 1}. {it.title}</b> {it.confidential && <span className="pill">Confidential</span>} {it.from_decision && <span className="pill orange">Carried forward</span>}
              <span className="tiny muted" style={{ display: 'block' }}>Raised by {it.raised_by}{it.for_school ? `, ${it.for_school}` : ''}</span>{it.details && <span className="small" style={{ display: 'block', whiteSpace: 'pre-line' }}>{it.details}</span>}</span>
            {g.minutes_status !== 'NONE' && (editable ? <textarea className="input" rows={3} value={minutes.items[it.id] ?? ''} onChange={(e) => { setMinutes({ ...minutes, items: { ...minutes.items, [it.id]: e.target.value } }); setDirty(true); }} placeholder="What was discussed" />
              : it.discussion && <p className="small" style={{ whiteSpace: 'pre-line' }}>{it.discussion}</p>)}
            {decisionsFor(it.id).map(showDecision)}
            {editable && <button className="linkbtn small" style={{ justifySelf: 'start' }} onClick={() => setForm({ itemId: it.id })}>Record a decision on this item</button>}
          </div>)}
          {decisionsFor(null).length > 0 && <div><h4>Other decisions</h4>{decisionsFor(null).map(showDecision)}</div>}
          {editable && <div style={{ display: 'flex', gap: 8 }}><button className="btn" disabled={busy || !dirty} onClick={saveMinutes}>Save the minutes</button><button className="btn quiet" onClick={() => setForm({ itemId: null })}>Record another decision</button></div>}
          <Files kind="meeting" id={g.id} canAdd={r.run && g.minutes_status !== 'CONFIRMED'} title="Meeting papers" hint="Agenda notes, reports and presentations for members." />
        </section>

        {(canMark || g.quorum_met !== null) && <section className="tile">
          <div className="tile-head"><h3>Attendance</h3>{canMark && <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/governance/meetings/${g.id}/attendance`, { method: 'PUT', body: { marks: Object.entries(marks).map(([memberId, status]) => ({ memberId, status })) } }), 'Attendance saved')) m.reload(); }}>{g.quorum_met === null ? 'Save attendance and start the minutes' : 'Save attendance'}</button>}</div>
          {g.attendance.map((a: any) => <div key={a.member_id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{a.name}</b> <span className="small muted">{a.detail}</span><span className="tiny muted" style={{ display: 'block' }}>{words(a.role)}</span></span>
            {canMark ? <div className="seg">{[['PRESENT', 'Present'], ['LEAVE', 'Leave'], ['ABSENT', 'Absent']].map(([k, l]) => <button key={k} className={marks[a.member_id] === k ? 'on' : ''} onClick={() => setMarks({ ...marks, [a.member_id]: k })}>{l}</button>)}</div>
              : <span className={`pill ${a.status === 'PRESENT' ? 'green' : ''}`}>{a.status ? words(a.status) : '—'}</span>}</div>)}
        </section>}

        {g.minutes_status === 'CIRCULATED' || g.comments.length ? <section className="tile stack"><h3>Members’ comments on the minutes</h3>
          {!g.comments.length ? <Empty>No comments yet.</Empty> : g.comments.map((k: any) => <div key={k.id} className="small"><b>{k.name}</b> <span className="tiny muted">{time(k.at)}</span><div style={{ whiteSpace: 'pre-line' }}>{k.body}</div></div>)}
          {r.comment && <div style={{ display: 'flex', gap: 8 }}><textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="A correction or a point to add" />
            <button className="btn quiet" disabled={busy || comment.trim().length < 2} onClick={async () => { if (await run(() => api(`/governance/meetings/${g.id}/comments`, { body: { body: comment } }), 'Comment sent')) { setComment(''); m.reload(); } }}>Send</button></div>}
        </section> : null}
      </main>
      {form && <DecisionForm unitId={g.committee.unit_id} unitPath={g.committee.unit_path} items={form.edit ? undefined : g.items.filter((i: any) => form.itemId === null || i.id === form.itemId)} initial={form.edit}
        onSave={async (b) => {
          if (dirty) await api(`/governance/meetings/${g.id}/minutes`, { method: 'PUT', body: { note: minutes.note, items: Object.entries(minutes.items).map(([iid, discussion]) => ({ id: iid, discussion })) } }).catch(() => null);
          const r2 = await run(() => form.edit ? api(`/governance/decisions/${form.edit.id}`, { method: 'PATCH', body: b }) : api(`/governance/meetings/${g.id}/decisions`, { body: b }), form.edit ? 'Saved' : 'Recorded in the draft minutes');
          if (r2) m.reload();
          return !!r2;
        }} onClose={() => setForm(null)} />}
    </>
  );
}

// ── A decision ───────────────────────────────────────────────────────────────────────────────

function UpdateAction({ action, onClose }: { action: any; onClose: () => void }) {
  const [f, setF] = useState({ percent: String(action.percent ?? 0), note: '' });
  const { run, busy } = useAction();
  const send = async (status?: string) => { if (await run(() => api(`/governance/actions/${action.id}/update`, { body: { percent: status === 'DONE' ? 100 : Number(f.percent), note: f.note, status } }), 'Progress updated')) onClose(); };
  return <Drawer title={action.title} onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>How far along: {f.percent}%</span><input type="range" min={0} max={100} step={5} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></label>
    <label className="field"><span>What has been done</span><textarea className="input" rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
    <Files kind="action" id={action.id} canAdd title="Evidence" hint="A photo, an order, a report: anything that shows the work." />
    <div style={{ display: 'flex', gap: 8 }}><button className="btn" disabled={busy || f.note.trim().length < 2} onClick={() => send()}>Save progress</button>
      <button className="btn quiet" disabled={busy || f.note.trim().length < 2} onClick={() => send('DONE')}>Done</button></div>
  </section></Drawer>;
}

export function DecisionPage({ user }: { user: User }) {
  const { id } = useParams();
  const d = useLoad<any>(`/governance/decisions/${id}`, [id]);
  const { run, busy } = useAction();
  const [upd, setUpd] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [report, setReport] = useState<Record<string, string>>({});
  if (!d.data) return d.error ? <FailedPage error={d.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const x = d.data, r = x.rights;
  const live = ['DECIDED', 'IN_PROGRESS', 'IMPLEMENTED'].includes(x.status);
  const status = async (s: string, q: string) => { const note = s === 'NEEDS_MEETING' ? await askText(q) : (await ask(q)) ? '' : null; if (note !== null && await run(() => api(`/governance/decisions/${x.id}/status`, { body: { status: s, note: note || undefined } }), 'Done')) d.reload(); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/governance" className="linkbtn small">‹ Decisions</Link><span className="localnav-title" style={{ marginLeft: 8 }}>{x.ref}</span><span className="spacer" style={{ flex: 1 }} />
        {r.progress && x.status !== 'IMPLEMENTED' && <button className="btn quiet small" disabled={busy} onClick={() => status('IMPLEMENTED', 'Mark this decision implemented?')}>Mark implemented</button>}
        {r.close && <button className="btn quiet small" disabled={busy} onClick={() => status('NEEDS_MEETING', 'What should the committee look at again?')}>Back to the committee</button>}
        {r.close && <button className="btn small" disabled={busy} onClick={() => status('CLOSED', 'Close this decision? It leaves the open list.')}>Close</button>}</div></div>
      <main className="page">
        <section className="tile">
          <div className="eyebrow">{x.committee} · {x.unit}{x.by_circulation ? ' · by circulation' : ''}{x.confidential ? ' · confidential' : ''}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 4 }}><h2>{x.title}</h2><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Progress value={x.progress} />{(x.overdue || x.overdue_actions > 0) && <span className="pill red">Overdue</span>}<Pill s={x.status} /></span></div>
          <p style={{ whiteSpace: 'pre-line', marginTop: 8 }}>{x.body}</p>
          {x.reason && <p className="small muted" style={{ whiteSpace: 'pre-line', marginTop: 6 }}>Reason: {x.reason}</p>}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div><div className="kpi-label">Owner</div><div>{x.owner ?? '—'} {r.progress && <button className="linkbtn tiny" onClick={async () => { const due = await askText('New due date (YYYY-MM-DD)', { initial: x.due_on ?? today() }); if (due && await run(() => api(`/governance/decisions/${x.id}/status`, { body: { dueOn: due } }), 'Due date changed')) d.reload(); }}>Change due date</button>}</div></div>
            <div><div className="kpi-label">Due</div><div>{x.due_on ? day(x.due_on) : '—'}</div></div>
            {x.meeting_id && <div><div className="kpi-label">Minutes</div><Link to={`/governance/meetings/${x.meeting_id}`}>The meeting</Link></div>}
          </div>
        </section>

        {x.by_circulation && <section className="tile stack"><h3>Votes{x.circulation_closes ? ` · closes ${day(x.circulation_closes)}` : ''}</h3>
          {r.vote && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{[['YES', 'For'], ['NO', 'Against'], ['ABSTAIN', 'Abstain']].map(([k, l]) => <button key={k} className={k === 'YES' ? 'btn' : 'btn quiet'} disabled={busy} onClick={async () => { if (await ask(`Vote ${l.toLowerCase()}? A vote cannot be changed.`) && await run(() => api(`/governance/decisions/${x.id}/vote`, { body: { vote: k } }), 'Vote recorded')) d.reload(); }}>{l}</button>)}</div>}
          {r.myVote && <p className="small">You voted <b>{r.myVote === 'YES' ? 'for' : r.myVote === 'NO' ? 'against' : 'to abstain'}</b>.</p>}
          {!x.votes.length ? <Empty>No votes yet.</Empty> : x.votes.map((v: any, i: number) => <div key={i} className="small">{v.name}: <b>{v.vote === 'YES' ? 'for' : v.vote === 'NO' ? 'against' : 'abstained'}</b> <span className="tiny muted">{time(v.at)}</span></div>)}
          {r.count && <button className="btn quiet small" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={async () => { if (await run(() => api(`/governance/decisions/${x.id}/count`, { body: {} }), 'Result declared')) d.reload(); }}>Declare the result</button>}
        </section>}

        {(x.actions.length > 0 || (r.progress && live)) && <section className="tile stack">
          <div className="tile-head"><h3>Actions</h3>{r.progress && live && <button className="btn quiet small" onClick={() => setAdding(true)}>Add an action</button>}</div>
          {!x.actions.length && <Empty>No actions yet. Break the decision into actions with an owner and a date each.</Empty>}
          {x.actions.map((a: any) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{a.title}</b> {a.status !== 'OPEN' && <span className={`pill ${a.status === 'DONE' ? 'green' : ''}`}>{words(a.status)}</span>}
              <span className="tiny muted" style={{ display: 'block' }}>{a.owner} · due {day(a.due_on)}</span>
              {a.updates.slice(0, 3).map((u: any, i: number) => <span key={i} className="tiny" style={{ display: 'block' }}>{u.percent}% · {u.note} <span className="muted">({u.by}, {time(u.at)})</span></span>)}
              <Files kind="action" id={a.id} canAdd={false} title="Evidence" /></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Progress value={a.status === 'DONE' ? 100 : a.percent} />{a.overdue && <span className="pill red">Overdue</span>}
              {a.status === 'OPEN' && live && (a.owner_id === user.id || r.progress) && <button className="btn quiet small" onClick={() => setUpd(a)}>Update</button>}
              {a.status === 'OPEN' && live && r.progress && a.owner_id !== user.id && <button className="linkbtn tiny" onClick={async () => { const why = await askText('Why is this action dropped?'); if (why && await run(() => api(`/governance/actions/${a.id}/update`, { body: { percent: a.percent, note: why, status: 'DROPPED' } }), 'Dropped')) d.reload(); }}>Drop</button>}</span>
          </div>)}
        </section>}

        {x.schools.length > 0 && <section className="tile"><h3>Schools</h3>
          {x.schools.map((s: any) => <div key={s.school_id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <span><b>{s.school}</b> <span className={`pill ${s.reported_at ? 'green' : s.acknowledged_at ? 'blue' : 'orange'}`}>{s.reported_at ? 'Reported' : s.acknowledged_at ? 'Acknowledged' : 'Not yet acknowledged'}</span>
              {s.report && <span className="small" style={{ display: 'block', whiteSpace: 'pre-line' }}>{s.report} <span className="tiny muted">({s.reported_by}, {time(s.reported_at)})</span></span>}</span>
            {s.mine && live && !s.reported_at && <div className="stack" style={{ gap: 6 }}>
              {!s.acknowledged_at && <button className="btn quiet small" style={{ justifySelf: 'start' }} disabled={busy} onClick={async () => { if (await run(() => api(`/governance/decisions/${x.id}/schools/${s.school_id}/acknowledge`, { body: {} }), 'Acknowledged')) d.reload(); }}>Acknowledge</button>}
              <textarea className="input" rows={2} value={report[s.school_id] ?? ''} onChange={(e) => setReport({ ...report, [s.school_id]: e.target.value })} placeholder="What the school has done about it" />
              <button className="btn small" style={{ justifySelf: 'start' }} disabled={busy || (report[s.school_id] ?? '').trim().length < 10} onClick={async () => { if (await run(() => api(`/governance/decisions/${x.id}/schools/${s.school_id}/report`, { body: { report: report[s.school_id] } }), 'Action-taken report sent')) d.reload(); }}>Send the action-taken report</button>
            </div>}
          </div>)}</section>}

        <section className="tile"><h3>History</h3>{x.events.map((e: any, i: number) => <div key={i} className="small">{time(e.at)} · <b>{STATUS_WORD[e.to_status] ?? words(e.to_status)}</b>{e.note ? ` · ${e.note}` : ''}{e.by ? ` · ${e.by}` : ''}</div>)}</section>
      </main>
      {upd && <UpdateAction action={upd} onClose={() => { setUpd(null); d.reload(); }} />}
      {adding && <AddAction decision={x} onClose={() => { setAdding(false); d.reload(); }} />}
    </>
  );
}

function AddAction({ decision, onClose }: { decision: any; onClose: () => void }) {
  const [f, setF] = useState({ title: '', dueOn: '' });
  const [owner, setOwner] = useState<Person | null>(null);
  const { run, busy } = useAction();
  return <Drawer title="Add an action" onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>What is to be done</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
    <PersonPicker unitId={decision.committeeUnitId} value={owner} onChange={setOwner} label="By" />
    <label className="field"><span>Due</span><input className="input" type="date" min={today()} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></label>
    <button className="btn big" disabled={busy || f.title.trim().length < 3 || !owner || !f.dueOn} onClick={async () => { if (await run(() => api(`/governance/decisions/${decision.id}/actions`, { body: { title: f.title, ownerId: owner!.id, dueOn: f.dueOn } }), 'Action added; the owner is told')) onClose(); }}>Add</button>
  </section></Drawer>;
}
