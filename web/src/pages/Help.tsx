import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, time, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, ask } from '../ui';

/**
 * Tickets for everyone (staff, parents, candidates): report a fault, a wrong detail in a record,
 * something the school needs, or an access problem; then follow its progress and the resolution.
 * There is no chat. The helpdesk works each ticket by hand from the desk (NES may also switch on
 * the AI assistant for faults and wrong records); a wrong detail is corrected only after the office
 * that keeps the record approves, and new features go to the developer first.
 */

const CATEGORY: Record<string, [string, string]> = {
  PROBLEM: ['Something is not working', 'A screen, report or figure is wrong, or something fails.'],
  DATA: ['A detail in a record is wrong', 'A name, date of birth, phone number or similar is wrong.'],
  REQUEST: ['The school needs something extra', 'A new report, a change to a screen, or something new.'],
  ACCESS: ['Signing in or access', 'You cannot sign in, or cannot open a screen you need for your work.'],
  QUESTION: ['Question', 'Older tickets only.'],
};
const TONE: Record<string, string> = { NEW: 'blue', TRIAGED: 'blue', IN_PROGRESS: 'blue', AWAITING_USER: 'orange', AWAITING_APPROVAL: 'orange', AWAITING_DEVELOPER: 'orange', RESOLVED: 'green', CLOSED: '', REJECTED: 'red',
  PROPOSED: 'orange', DEVELOPER_REVIEW: 'orange', APPROVED: 'blue', APPLIED: 'green', FAILED: 'red' };
const LABEL: Record<string, string> = { NEW: 'Received', TRIAGED: 'Being looked at', IN_PROGRESS: 'Being worked on', AWAITING_APPROVAL: 'Fix waiting for the school office', AWAITING_DEVELOPER: 'With the developer',
  AWAITING_USER: 'Waiting', RESOLVED: 'Resolved', CLOSED: 'Closed', REJECTED: 'Closed', PROPOSED: 'Waiting for approval', DEVELOPER_REVIEW: 'Developer review', APPROVED: 'Accepted', APPLIED: 'Done', FAILED: 'Failed' };
const OPEN = 'NEW,TRIAGED,IN_PROGRESS,AWAITING_USER,AWAITING_APPROVAL,AWAITING_DEVELOPER';
const StatusPill = ({ s }: { s: string }) => <span className={`pill ${TONE[s] ?? ''}`}>{LABEL[s] ?? words(s)}</span>;
const RAISE = ['PROBLEM', 'DATA', 'REQUEST', 'ACCESS'];

/** The correctable details of each kind of record (the same list the server checks). */
export const FIELDS: Record<string, [string, string][]> = {
  STUDENT: [['name', 'Name'], ['dob', 'Date of birth'], ['gender', 'Gender'], ['bloodGroup', 'Blood group'], ['apaarId', 'APAAR ID'], ['pen', 'PEN'], ['previousSchool', 'Previous school']],
  GUARDIAN: [['name', 'Name'], ['phone', 'Mobile'], ['email', 'Email'], ['address', 'Address']],
  STAFF: [['name', 'Name'], ['phone', 'Mobile'], ['email', 'Email'], ['dob', 'Date of birth'], ['bloodGroup', 'Blood group'], ['emergencyContact', 'Emergency contact'], ['title', 'Title'], ['employeeNo', 'School staff number'], ['uan', 'UAN']],
};

export default function Help({ user }: { user: User }) {
  const { number } = useParams();
  const mine = useLoad<any[]>('/help/tickets', [number]);
  // "Report the problem" on an error page opens a ticket with the error's number and reference filled in.
  const about = new URLSearchParams(useLocation().search).get('about')?.slice(0, 120) ?? '';
  const [raise, setRaise] = useState<string | null>(about ? 'PROBLEM' : null);
  const nav = useNavigate();
  const base = user.role === 'CANDIDATE' ? '/careers/help' : '/help';
  if (number) return <UserTicket number={number} back={base} />;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Help</span><span className="spacer" style={{ flex: 1 }} /><button className="btn small" onClick={() => setRaise('PROBLEM')}>Raise a ticket</button></div></div>
      <main className="page">
        <section className="tile">
          <h2>Report a problem</h2>
          <p className="muted" style={{ marginTop: 6 }}>Raise a ticket and follow it here; you are told when it moves on and when it is resolved. The helpdesk never sees names, phone numbers or other personal details in your ticket. If a detail in a record is wrong, the office that keeps the record checks the correction before it is made.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 12 }}>{RAISE.map((k) => <button key={k} className="tile tight" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setRaise(k)}><b>{CATEGORY[k][0]}</b><span className="tiny muted" style={{ display: 'block', marginTop: 4 }}>{CATEGORY[k][1]}</span></button>)}</div>
        </section>
        <section className="tile"><h3>Your tickets</h3>
          {!mine.data ? <Empty>Loading…</Empty> : !mine.data.length ? <Empty>You have not raised any tickets.</Empty> : mine.data.map((t) => <button key={t.number} className="list-row" style={{ gridTemplateColumns: '1fr auto', width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => nav(`${base}/${t.number}`)}>
            <span><b>{t.title}</b><span className="tiny muted" style={{ display: 'block' }}>{t.number} · {CATEGORY[t.category]?.[0]} · updated {time(t.updated_at)}</span></span><StatusPill s={t.status} /></button>)}</section>
      </main>
      {raise && <RaiseTicket category={raise} title={about ? `Error ${about}` : undefined} onClose={(n) => { setRaise(null); mine.reload(); if (n) nav(`${base}/${n}`); }} />}
    </>
  );
}

/** Raising a ticket, from anywhere: the page it was raised from decides the module. */
export function RaiseTicket({ onClose, refs, category: initial, title: initialTitle }: { onClose: (number?: string) => void; refs?: { entityType: string; entityId: string; label: string }[]; category?: string; title?: string }) {
  const loc = useLocation();
  const [f, setF] = useState({ category: initial ?? 'PROBLEM', title: initialTitle ?? '', description: '', severity: 'NORMAL', field: '', correctValue: '' });
  const { run, busy } = useAction();
  const ref = refs?.[0];
  const fields = ref ? FIELDS[ref.entityType] ?? [] : [];
  return (
    <Drawer title={ref ? `Report a problem: ${ref.label}` : 'Raise a ticket'} onClose={() => onClose()}>
      <section className="tile tight stack">
        {!ref && <div className="field"><span>What is it about</span><div className="stack" style={{ gap: 6, marginTop: 6 }}>{RAISE.map((k) => <label key={k} className="check small" style={{ alignItems: 'flex-start' }}>
          <input type="radio" name="cat" checked={f.category === k} onChange={() => setF({ ...f, category: k })} /><span><b>{CATEGORY[k][0]}</b><span className="tiny muted" style={{ display: 'block' }}>{CATEGORY[k][1]}</span></span></label>)}</div></div>}
        {ref && fields.length > 0 && <div className="form-grid">
          <label className="field"><span>Which detail is wrong</span><select className="input" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="">Something else</option>{fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {f.field && <label className="field"><span>What it should be</span><input className="input" type={f.field === 'dob' ? 'date' : 'text'} value={f.correctValue} onChange={(e) => setF({ ...f, correctValue: e.target.value })} /></label>}
        </div>}
        <label className="field"><span>In a line</span><input className="input" value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={ref ? 'Date of birth is wrong' : f.category === 'REQUEST' ? 'A report of fees due by class' : 'The fee receipt does not open'} /></label>
        <label className="field"><span>Details</span><textarea className="input" rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What you did, what you expected and what happened, so the helpdesk can find it without asking. Do not write Aadhaar, bank or card numbers here." /></label>
        {f.category === 'PROBLEM' && <label className="field"><span>How urgent</span><select className="input" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
          <option value="LOW">Not urgent</option><option value="NORMAL">Normal</option><option value="HIGH">It stops my work today</option><option value="URGENT">Fees, salaries, exams or safety are blocked for many people</option></select></label>}
        <button className="btn big" disabled={busy || f.title.trim().length < 4 || f.description.trim().length < 10 || (!!f.field && !f.correctValue.trim())} onClick={async () => {
          const r: any = await run(() => api('/help/tickets', { body: { category: ref ? 'DATA' : f.category, title: f.title.trim(), description: f.description.trim(), severity: f.category === 'PROBLEM' ? f.severity : undefined, page: loc.pathname,
            refs: ref ? [{ entityType: ref.entityType, entityId: ref.entityId, ...(f.field ? { field: f.field, correctValue: f.correctValue.trim() } : {}) }] : undefined } }), 'Ticket raised; you will be told when it moves on');
          if (r) onClose(r.number);
        }}>Raise the ticket</button>
      </section>
    </Drawer>
  );
}

/** "Report a problem with this record", for record screens (a child, a guardian, a staff member). */
export function ReportRecord({ entityType, entityId, label }: { entityType: 'STUDENT' | 'GUARDIAN' | 'STAFF'; entityId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="linkbtn small" onClick={() => setOpen(true)}>Report a problem with this record</button>
    {open && <RaiseTicket refs={[{ entityType, entityId, label }]} onClose={() => setOpen(false)} />}
  </>;
}

/** The person who raised a ticket: what they wrote, its progress, any fix, the resolution. */
function UserTicket({ number, back }: { number: string; back: string }) {
  const t = useLoad<any>(`/help/tickets/${number}`, [number]);
  const [why, setWhy] = useState<string | null>(null);
  const { run, busy } = useAction();
  const k = t.data;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to={back} className="small">← Help</Link><span className="localnav-title" style={{ marginLeft: 10 }}>{number}</span></div></div>
      <main className="page">
        {!k ? <Empty>{t.error ?? 'Loading…'}</Empty> : <>
          <section className="tile">
            <div className="tile-head"><div><h2>{k.title}</h2><p className="small muted" style={{ marginTop: 4 }}>{CATEGORY[k.category]?.[0]} · raised {time(k.created_at)}</p></div><StatusPill s={k.status} /></div>
            <p style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{k.description}</p>
            {k.resolution && <div className={`callout ${k.status === 'REJECTED' ? '' : 'green'} small`} style={{ marginTop: 10 }}><b>{k.status === 'REJECTED' ? 'Closed' : 'Resolved'}:</b> {k.resolution}</div>}
          </section>
          <section className="tile"><h3>Progress</h3>
            {k.progress.map((m: any) => <div key={m.id} className="list-row" style={{ gridTemplateColumns: '130px 1fr' }}><span className="tiny muted">{time(m.created_at)}</span><span className="small">{m.body}</span></div>)}
            {k.fixes.map((f: any) => <div key={f.number} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span className="small">{f.summary}</span><StatusPill s={f.status} /></div>)}
            {k.status === 'RESOLVED' && <div style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small">Is it fixed?</span>
              {[1, 2, 3, 4, 5].map((n) => <button key={n} className="btn quiet small" disabled={busy} aria-label={`${n} of 5`} onClick={async () => { if (await run(() => api(`/help/tickets/${number}/rate`, { body: { rating: n } }), 'Thank you')) t.reload(); }}>{'★'.repeat(n)}</button>)}
              <button className="linkbtn small" onClick={() => setWhy('')}>No, it is still wrong</button></div>}
            {why !== null && <div className="stack" style={{ marginTop: 10 }}><textarea className="input" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What is still wrong?" />
              <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={busy || why.trim().length < 5} onClick={async () => { if (await run(() => api(`/help/tickets/${number}/reopen`, { body: { reason: why.trim() } }), 'Reopened')) { setWhy(null); t.reload(); } }}>Reopen the ticket</button></div>}
          </section>
        </>}
      </main>
    </>
  );
}

// ── The support desk ──────────────────────────────────────────────────────────────────────

export function Desk({ user }: { user: User }) {
  const { number } = useParams();
  const [q, setQ] = useState({ status: 'open', category: '', module: '', agent: '', sort: 'due', search: '' });
  const qs = new URLSearchParams(Object.entries({ ...q, status: q.status === 'open' ? OPEN : q.status === 'developer' ? 'AWAITING_DEVELOPER' : q.status, search: '', q: q.search }).filter(([, v]) => v)).toString();
  const list = useLoad<any[]>(number ? null : `/support/tickets?${qs}`, [qs, number]);
  const stats = useLoad<any[]>(number ? null : '/support/agent-stats', [number]);
  const mods = useLoad<Record<string, string>>('/help/modules');
  const ai = useLoad<{ on: boolean }>('/support/ai');
  const nav = useNavigate();
  if (number) return <DeskTicket number={number} user={user} />;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Support desk</span><span className="spacer" style={{ flex: 1 }} />
        {user.role === 'DEVELOPER' && <button className={`btn small ${q.status === 'developer' ? '' : 'quiet'}`} onClick={() => setQ({ ...q, status: q.status === 'developer' ? 'open' : 'developer' })}>Waiting for me</button>}
        <Link className="btn quiet small" to="/support/agents">Agents and AI</Link></div></div>
      <main className="page">
        <div className={`callout ${ai.data?.on ? 'blue' : ''} small`}>{ai.data?.on ? 'The AI assistant is on: it sorts faults and wrong records and proposes fixes. The helpdesk handles everything else and can take over any ticket.' : 'The AI assistant is off: the helpdesk handles every ticket by hand. Take a ticket, sort it, propose a fix for the school office to approve, then resolve or close it.'}</div>
        <section className="tile"><h3>Resolutions by agent</h3><p className="tiny muted">How many each resolved, how fast, and the users’ ratings. Choose an agent to see their tickets.</p>
          <div className="scroll-x"><table className="table" style={{ marginTop: 8 }}><thead><tr><th>Agent</th><th className="num">Open</th><th className="num">Resolved</th><th className="num">Avg hours</th><th className="num">Rating</th><th className="num">Fixes applied</th><th>Last seen</th></tr></thead>
            <tbody>{(stats.data ?? []).map((a) => <tr key={a.name} style={{ cursor: 'pointer', background: q.agent === a.name ? 'var(--fill)' : undefined }} onClick={() => setQ({ ...q, agent: q.agent === a.name ? '' : a.name })}>
              <td><b>{a.name}</b> <span className="tiny muted">{a.kind === 'AI' ? 'AI assistant' : words(a.kind)}{a.active ? '' : ' · off'}</span></td><td className="num">{a.open}</td><td className="num">{a.resolved}</td><td className="num">{a.avg_hours ?? '—'}</td><td className="num">{a.avg_rating ?? '—'}</td><td className="num">{a.fixes_applied}</td><td className="small">{time(a.last_seen_at)}</td></tr>)}</tbody></table></div></section>
        <section className="tile">
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <label className="field"><span>Show</span><select className="input" value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}><option value="open">Open</option><option value="NEW">Not yet taken</option><option value="developer">Waiting for the developer</option><option value="AWAITING_APPROVAL">Fix waiting for approval</option><option value="RESOLVED,CLOSED">Resolved</option><option value="">All</option></select></label>
            <label className="field"><span>Kind</span><select className="input" value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })}><option value="">Any</option>{RAISE.map((k) => <option key={k} value={k}>{CATEGORY[k][0]}</option>)}</select></label>
            <label className="field"><span>Module</span><select className="input" value={q.module} onChange={(e) => setQ({ ...q, module: e.target.value })}><option value="">Any</option>{Object.entries(mods.data ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field"><span>Agent</span><input className="input" value={q.agent} onChange={(e) => setQ({ ...q, agent: e.target.value })} placeholder="Any" /></label>
            <label className="field"><span>Sort</span><select className="input" value={q.sort} onChange={(e) => setQ({ ...q, sort: e.target.value })}><option value="due">Due first</option><option value="newest">Newest</option><option value="severity">Severity</option><option value="agent">Agent</option><option value="updated">Recently updated</option></select></label>
            <label className="field"><span>Search</span><input className="input" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} placeholder="Number or words" /></label>
          </div>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No tickets.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Ticket</th><th>Module</th><th>Severity</th><th>School</th><th>Agent</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((t) => <tr key={t.number} className="click" onClick={() => nav(`/support/${t.number}`)}>
              <td><b>{t.title}</b><span className="tiny muted" style={{ display: 'block' }}>{t.number} · {CATEGORY[t.category]?.[0]}{t.open_fixes ? ` · ${t.open_fixes} fix waiting` : ''}{t.needs_developer ? ' · developer' : ''}</span></td>
              <td className="small">{mods.data?.[t.module] ?? t.module ?? '—'}</td><td className="small">{words(t.severity)}</td><td className="small">{t.school_code ?? '—'}</td><td className="small">{t.resolved_by ?? t.assigned_to ?? '—'}</td>
              <td className="small" style={{ color: t.overdue ? 'var(--red)' : undefined }}>{time(t.due_at)}</td><td><StatusPill s={t.status} /></td></tr>)}</tbody></table></div>}
        </section>
      </main>
    </>
  );
}

/** One ticket at the desk: the manual workflow (take, note, sort, propose a fix, resolve or close). */
function DeskTicket({ number, user }: { number: string; user: User }) {
  const t = useLoad<any>(`/support/tickets/${number}`, [number]);
  const cat = useLoad<any>('/support/catalog');
  const [note, setNote] = useState('');
  const [devNote, setDevNote] = useState('');
  const [panel, setPanel] = useState<'' | 'triage' | 'fix' | 'resolve' | 'close'>('');
  const { run, busy } = useAction();
  const k = t.data;
  const closed = k && ['RESOLVED', 'CLOSED', 'REJECTED'].includes(k.status);
  const act = async (path: string, body: unknown, done: string) => { if (await run(() => api(`/support/tickets/${number}/${path}`, { body }), done)) { setPanel(''); t.reload(); } };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/support" className="small">← Desk</Link><span className="localnav-title" style={{ marginLeft: 10 }}>{number}</span><span className="spacer" style={{ flex: 1 }} />
        {k && !closed && <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!k.assigned_to && <button className="btn small" disabled={busy} onClick={() => act('take', {}, 'Taken')}>Take it</button>}
          <button className="btn quiet small" onClick={() => setPanel('triage')}>Sort</button>
          <button className="btn quiet small" onClick={() => setPanel('fix')}>Propose a fix</button>
          <button className="btn quiet small" onClick={() => setPanel('resolve')}>Resolve</button>
          <button className="btn quiet small" onClick={() => setPanel('close')}>Close</button></span>}</div></div>
      <main className="page">
        {!k ? <Empty>{t.error ?? 'Loading…'}</Empty> : <>
          <section className="tile">
            <div className="tile-head"><div><h2>{k.title}</h2><p className="small muted" style={{ marginTop: 4 }}>{CATEGORY[k.category]?.[0]} · {k.module ? words(k.module) : 'module not set'} · {words(k.severity)} · raised {time(k.created_at)} by {k.raised_by} ({words(k.raised_by_role)}){k.school ? ` · ${k.school}` : ''} · {k.assigned_to ? `with ${k.assigned_to}` : 'not yet taken'} · due {time(k.due_at)}</p></div><StatusPill s={k.status} /></div>
            <p style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{k.description}</p>
            {k.page && <p className="tiny muted" style={{ marginTop: 6 }}>Raised from {k.page}</p>}
            {k.ai_summary && <div className="callout small" style={{ marginTop: 10 }}><b>Summary:</b> {k.ai_summary}</div>}
            {k.refs.length > 0 && <div style={{ marginTop: 10 }}>{k.refs.map((r: any) => <div key={r.ref} className="small">{words(r.entity_type)} <span className="mono">{r.ref}</span>{r.userSaysWrong ? ` · the user says the ${r.correctableFields?.[r.userSaysWrong]?.toLowerCase() ?? r.userSaysWrong} is wrong${r.userGaveCorrectValue ? ' and gave the correct value (only the approver sees it)' : ''}` : ''}</div>)}</div>}
            {k.resolution && <div className="callout green small" style={{ marginTop: 10 }}><b>{k.status === 'REJECTED' ? 'Closed' : 'Resolved'}{k.resolved_by ? ` by ${k.resolved_by}` : ''}:</b> {k.resolution}</div>}
          </section>
          {panel === 'triage' && <Triage k={k} busy={busy} mods={cat.data?.modules ?? {}} onSave={(b) => act('triage', b, 'Saved')} onCancel={() => setPanel('')} />}
          {panel === 'fix' && <ProposeFix k={k} cat={cat.data} busy={busy} onSave={(b) => act('proposals', b, 'Proposed; the responsible office or the developer is told')} onCancel={() => setPanel('')} />}
          {(panel === 'resolve' || panel === 'close') && <Closing kind={panel} busy={busy} onSave={(text) => act(panel === 'resolve' ? 'resolve' : 'reject', panel === 'resolve' ? { resolution: text } : { reason: text }, panel === 'resolve' ? 'Resolved; the user is told' : 'Closed; the user is told')} onCancel={() => setPanel('')} />}
          {k.needs_developer && <section className="tile"><h3>Developer</h3>
            <p className="small">{k.developer_decision ? `${k.developer_decision === 'APPROVED' ? 'Accepted' : 'Declined'} by the developer${k.developer_note ? `: “${k.developer_note}”` : ''}` : 'This needs the developer’s go-ahead before anything is changed.'}</p>
            {user.role === 'DEVELOPER' && !k.developer_decision && <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}><input className="input" style={{ flex: '1 1 260px' }} placeholder="Reason (the user sees it)" value={devNote} onChange={(e) => setDevNote(e.target.value)} />
              <button className="btn small" disabled={busy || devNote.trim().length < 4} onClick={async () => { if (await run(() => api(`/support/tickets/${number}/developer`, { body: { approve: true, note: devNote } }), 'Accepted')) t.reload(); }}>Accept the work</button>
              <button className="btn quiet small" disabled={busy || devNote.trim().length < 4} onClick={async () => { if (await run(() => api(`/support/tickets/${number}/developer`, { body: { approve: false, note: devNote } }), 'Declined')) t.reload(); }}>Decline</button></div>}</section>}
          {k.fixes.length > 0 && <section className="tile"><h3>Fixes</h3>{k.fixes.map((f: any) => <div key={f.number} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{f.summary}</b><span className="tiny muted" style={{ display: 'block' }}>{f.number} · {words(f.kind)}{f.decision_note ? ` · “${f.decision_note}”` : ''}{f.result ? ` · ${typeof f.result === 'string' ? f.result : JSON.stringify(f.result)}` : ''}</span></span><StatusPill s={f.status} /></div>)}</section>}
          <section className="tile"><h3>Notes and progress</h3>
            <p className="tiny muted">Notes are for the helpdesk and the developer only. The user sees the progress lines and the resolution.</p>
            {!k.notes.length ? <Empty>Nothing yet.</Empty> : k.notes.map((m: any) => <div key={m.id} className="list-row" style={{ gridTemplateColumns: '1fr', background: m.internal ? 'var(--fill)' : undefined }}>
              <span className="tiny muted">{m.author_kind === 'SYSTEM' ? 'Progress (the user sees this)' : `${m.author}${m.author_kind === 'USER' ? ' (the user)' : ''} · note`} · {time(m.created_at)}</span><span className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span></div>)}
            {!closed && <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note: what you checked, what you found" />
              <button className="btn small" style={{ alignSelf: 'flex-end' }} disabled={busy || note.trim().length < 2} onClick={async () => { if (await run(() => api(`/support/tickets/${number}/note`, { body: { body: note.trim() } }), 'Noted')) { setNote(''); t.reload(); } }}>Add note</button></div>}
          </section>
        </>}
      </main>
    </>
  );
}

function Triage({ k, mods, busy, onSave, onCancel }: { k: any; mods: Record<string, string>; busy: boolean; onSave: (b: unknown) => void; onCancel: () => void }) {
  const [f, setF] = useState({ category: k.category === 'QUESTION' ? 'PROBLEM' : k.category, module: k.module ?? 'other', severity: k.severity, summary: k.ai_summary ?? '', needsDeveloper: false, reason: '' });
  return <section className="tile stack"><h3>Sort the ticket</h3>
    <div className="form-grid">
      <label className="field"><span>Kind</span><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{RAISE.map((c) => <option key={c} value={c}>{CATEGORY[c][0]}</option>)}</select></label>
      <label className="field"><span>Module</span><select className="input" value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })}>{Object.entries(mods).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
      <label className="field"><span>Severity</span><select className="input" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
    </div>
    <label className="field"><span>Summary for the desk</span><input className="input" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
    <label className="check small"><input type="checkbox" checked={f.needsDeveloper} onChange={(e) => setF({ ...f, needsDeveloper: e.target.checked })} />Send to the developer first (new feature, code change, anything risky or affecting many schools)</label>
    {f.needsDeveloper && <input className="input" placeholder="Why" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
    <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy || (f.needsDeveloper && f.reason.trim().length < 4)} onClick={() => onSave({ ...f, needsDeveloper: f.needsDeveloper || undefined, reason: f.reason || undefined, summary: f.summary || undefined })}>Save</button><button className="btn quiet small" onClick={onCancel}>Cancel</button></div>
  </section>;
}

function ProposeFix({ k, cat, busy, onSave, onCancel }: { k: any; cat: any; busy: boolean; onSave: (b: unknown) => void; onCancel: () => void }) {
  const firstRef = k.refs.find((r: any) => r.correctableFields && Object.keys(r.correctableFields).length);
  const [f, setF] = useState({ kind: firstRef ? 'DATA_CORRECTION' : 'REPAIR', ref: firstRef?.ref ?? k.refs[0]?.ref ?? '', field: firstRef?.userSaysWrong ?? '', useUser: !!firstRef?.userGaveCorrectValue, newValue: '', action: '', summary: '', details: '', risk: 'LOW' });
  const ref = k.refs.find((r: any) => r.ref === f.ref);
  const repairs: [string, { label: string; needs: string }][] = Object.entries(cat?.repairs ?? {});
  const body = f.kind === 'DATA_CORRECTION' ? { kind: f.kind, ref: f.ref, field: f.field, newValue: f.useUser ? 'USER_VALUE' : f.newValue, summary: f.summary, details: f.details || undefined }
    : f.kind === 'REPAIR' ? { kind: f.kind, action: f.action, ref: f.ref || undefined, summary: f.summary }
    : f.kind === 'SETTING' ? { kind: f.kind, field: f.field, newValue: f.newValue, summary: f.summary }
    : { kind: f.kind, summary: f.summary, details: f.details, risk: f.risk };
  return <section className="tile stack"><h3>Propose a fix</h3>
    <p className="tiny muted">Nothing changes until it is approved: a correction or repair by the school office that keeps the record, a code change by the developer. Then NavShiksha applies it through the usual rules.</p>
    <div className="seg">{[['DATA_CORRECTION', 'Correct a detail'], ['REPAIR', 'Repair'], ['SETTING', 'Setting'], ['CODE_CHANGE', 'Code change']].map(([v, l]) => <button key={v} className={f.kind === v ? 'on' : ''} onClick={() => setF({ ...f, kind: v })}>{l}</button>)}</div>
    {f.kind === 'DATA_CORRECTION' && (!k.refs.length ? <Empty>No record is attached to this ticket.</Empty> : <div className="form-grid">
      <label className="field"><span>Record</span><select className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })}>{k.refs.map((r: any) => <option key={r.ref} value={r.ref}>{words(r.entity_type)} {r.ref}</option>)}</select></label>
      <label className="field"><span>Detail</span><select className="input" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="">Choose</option>{Object.entries(ref?.correctableFields ?? {}).map(([v, l]) => <option key={v} value={v}>{String(l)}</option>)}</select></label>
      {ref?.userGaveCorrectValue && <label className="check small"><input type="checkbox" checked={f.useUser} onChange={(e) => setF({ ...f, useUser: e.target.checked })} />Use the value the user gave</label>}
      {!f.useUser && <label className="field"><span>New value</span><input className="input" value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} /></label>}
    </div>)}
    {f.kind === 'REPAIR' && <div className="form-grid">
      <label className="field"><span>Repair</span><select className="input" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, summary: f.summary || (cat?.repairs?.[e.target.value]?.label ?? '') })}><option value="">Choose</option>{repairs.map(([v, r]) => <option key={v} value={v}>{r.label}</option>)}</select></label>
      {f.action && cat?.repairs?.[f.action]?.needs !== 'SCHOOL' && <label className="field"><span>For the record</span><select className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })}><option value="">Choose</option>{k.refs.map((r: any) => <option key={r.ref} value={r.ref}>{words(r.entity_type)} {r.ref}</option>)}</select></label>}
    </div>}
    {f.kind === 'SETTING' && <div className="form-grid"><label className="field"><span>Setting key</span><input className="input mono" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })} placeholder="attendance.correction_days" /></label>
      <label className="field"><span>New value (from today)</span><input className="input mono" value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} placeholder="3" /></label></div>}
    {f.kind === 'CODE_CHANGE' && <><label className="field"><span>What is wrong, where, the fix and how to test it</span><textarea className="input" rows={5} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
      <label className="field"><span>Risk</span><select className="input" value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label></>}
    <label className="field"><span>In a line (the approver and the user see this)</span><input className="input" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
    {f.kind === 'DATA_CORRECTION' && <label className="field"><span>Note for the approver (optional)</span><input className="input" value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="Please check the birth certificate in the admission file" /></label>}
    <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy || f.summary.trim().length < 5} onClick={() => onSave(body)}>Propose</button><button className="btn quiet small" onClick={onCancel}>Cancel</button></div>
  </section>;
}

function Closing({ kind, busy, onSave, onCancel }: { kind: 'resolve' | 'close'; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  return <section className="tile stack"><h3>{kind === 'resolve' ? 'Resolve' : 'Close without a fix'}</h3>
    <p className="tiny muted">{kind === 'resolve' ? 'One line on what was done. The user sees it, by email too, and can reopen the ticket if it is still wrong.' : 'Not a fault, or not something NavShiksha will do. The user sees the reason.'}</p>
    <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'resolve' ? 'The date of birth was corrected by the school office.' : 'This is how the screen is meant to work: …'} />
    <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy || text.trim().length < 5} onClick={() => onSave(text.trim())}>{kind === 'resolve' ? 'Resolve' : 'Close'}</button><button className="btn quiet small" onClick={onCancel}>Cancel</button></div>
  </section>;
}

export function Agents({ user }: { user: User }) {
  const list = useLoad<any[]>('/support/agents');
  const ai = useLoad<{ on: boolean }>('/support/ai');
  const [f, setF] = useState({ name: '', kind: 'AI' });
  const [secret, setSecret] = useState<any>(null);
  const { run, busy } = useAction();
  const nes = user.role === 'NES_ADMIN';
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/support" className="small">← Desk</Link><span className="localnav-title" style={{ marginLeft: 10 }}>Agents and AI</span></div></div>
      <main className="page">
        <section className="tile"><div className="tile-head"><div><h2>The AI assistant is {ai.data?.on ? 'on' : 'off'}</h2>
          <p className="muted" style={{ marginTop: 6, maxWidth: 760 }}>Off (the default), the helpdesk handles every ticket by hand. On, the AI assistant also works on faults and wrong records: it sorts them, leaves notes for the helpdesk and proposes fixes, which the school office or the developer still approves. It never writes to users, never sees a school’s records, and each ticket it works on is a paid call to the AI service.</p></div>
          {nes ? <button className={`btn ${ai.data?.on ? 'quiet' : ''}`} disabled={busy || !ai.data} onClick={async () => { if (await run(() => api('/support/ai', { body: { on: !ai.data!.on } }), ai.data!.on ? 'Switched off' : 'Switched on')) ai.reload(); }}>{ai.data?.on ? 'Switch off' : 'Switch on'}</button> : <span className="tiny muted">NES switches it on or off.</span>}</div></section>
        <section className="tile"><h3>Who works on tickets</h3>
          <p className="tiny muted">Each person at the helpdesk is listed the first time they act on a ticket. The AI assistant has its own key, used by the assistant’s program; agents reach NavShiksha only through the signed agent API and every call is logged.</p>
          {nes && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}><input className="input" style={{ flex: '1 1 220px' }} placeholder="Name, e.g. NavShiksha Assistant" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <select className="input" style={{ width: 180 }} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="AI">AI assistant</option><option value="HUMAN">Outside helpdesk</option></select>
            <button className="btn small" disabled={busy || f.name.trim().length < 2} onClick={async () => { const r = await run(() => api('/support/agents', { body: { name: f.name.trim(), kind: f.kind } })); if (r) { setSecret(r); setF({ name: '', kind: 'AI' }); list.reload(); } }}>Add with a key</button></div>}
          {secret && <div className="callout orange small" style={{ marginTop: 10 }}><b>Copy this now; the secret is not shown again.</b><div className="mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>NS_AGENT_KEY={secret.keyId}<br />NS_AGENT_SECRET={secret.secret}</div>
            <button className="linkbtn small" onClick={() => setSecret(null)}>Done</button></div>}
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : list.data.map((a) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{a.name}</b> <span className="tiny muted">{a.kind === 'AI' ? 'AI assistant' : words(a.kind)}{a.signs_in_as ? ` · signs in as ${a.signs_in_as}` : ` · key ${a.key_id}`} · {a.calls_today} API calls today · last seen {time(a.last_seen_at)}{a.active ? '' : ' · switched off'}</span></span>
            {nes && <span style={{ display: 'flex', gap: 6 }}>{!a.signs_in_as && <button className="btn quiet small" disabled={busy} onClick={async () => { if (!await ask('Issue a new secret? The old one stops working at once.')) return; const r = await run(() => api(`/support/agents/${a.id}/rotate`, { body: {} })); if (r) setSecret(r); }}>New secret</button>}
              <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/support/agents/${a.id}/active`, { body: { active: !a.active } }))) list.reload(); }}>{a.active ? 'Switch off' : 'Switch on'}</button></span>}</div>)}</section>
      </main>
    </>
  );
}

/** Fixes proposed from tickets that wait for this person (shown on the Approvals screen). */
export function FixApprovals() {
  const list = useLoad<any[]>('/fixes/pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  if (!list.data?.length) return null;
  const decide = async (f: any, approve: boolean) => { if (await run(() => api(`/fixes/${f.number}/decide`, { body: { approve, note: notes[f.number] ?? '' } }), approve ? 'Applied' : 'Rejected')) { list.reload(); window.dispatchEvent(new Event('nes:approvals')); } };
  return (
    <section className="tile">
      <div className="tile-head"><div><h2>Fixes from the helpdesk</h2><p className="muted" style={{ marginTop: 6 }}>Proposed from a ticket. Nothing changes until you approve; then NavShiksha makes the change itself, through the usual screens’ rules, in your name.</p></div></div>
      {list.data.map((f) => <div key={f.number} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}><strong>{f.summary}</strong><span className="pill blue">{f.stage === 'DEVELOPER' ? 'Developer review' : words(f.kind)}</span>
          <span className="tiny muted">{f.number} · from {f.agent} · ticket {f.ticket}{f.school ? ` · ${f.school}` : ''} · {time(f.created_at)}</span></div>
        {f.kind === 'DATA_CORRECTION' && <div className="small">{f.record}: <b>{f.fieldLabel}</b> from <span className="mono">{f.currentValue ?? '—'}</span> to <span className="mono">{f.new_value}</span></div>}
        {f.kind === 'REPAIR' && <div className="small">{f.repairLabel}</div>}
        {f.kind === 'SETTING' && <div className="small">Setting <span className="mono">{f.field}</span> to <span className="mono">{f.new_value}</span> from today</div>}
        {f.details && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{f.details}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input className="input" style={{ flex: '1 1 240px' }} placeholder="Note (needed to reject)" value={notes[f.number] ?? ''} onChange={(e) => setNotes({ ...notes, [f.number]: e.target.value })} aria-label="Note" />
          <button className="btn small" disabled={busy} onClick={() => decide(f, true)}>{f.stage === 'DEVELOPER' ? 'Accept' : 'Approve and apply'}</button>
          <button className="btn danger small" disabled={busy} onClick={() => decide(f, false)}>Reject</button></div>
      </div>)}
    </section>
  );
}

/** Every email and SMS NavShiksha has sent or will send, with its state. */
export function MessageLog() {
  const [q, setQ] = useState({ context: '', status: '', to: '' });
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const list = useLoad<any[]>(`/message-log?${qs}`, [qs]);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Email and SMS log</span></div></div>
      <main className="page">
        <section className="tile">
          <p className="muted">Every email and SMS sent by NavShiksha: codes, admission and fee messages, recruitment stages, CWT passwords (never shown here), ticket updates. Failed messages are tried again at 1, 4, 9 and 16 minutes.</p>
          <div className="form-grid" style={{ marginTop: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <label className="field"><span>About</span><select className="input" value={q.context} onChange={(e) => setQ({ ...q, context: e.target.value })}><option value="">Everything</option>{['ACCOUNT', 'RECRUITMENT', 'CWT', 'SUPPORT', 'FEES', 'ADMISSIONS'].map((c) => <option key={c} value={c}>{words(c)}</option>)}</select></label>
            <label className="field"><span>State</span><select className="input" value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}><option value="">Any</option>{['QUEUED', 'SENT', 'FAILED'].map((c) => <option key={c} value={c}>{words(c)}</option>)}</select></label>
            <label className="field"><span>To</span><input className="input" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} placeholder="Email or mobile" /></label>
          </div>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No messages.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>When</th><th>To</th><th>Message</th><th>State</th></tr></thead>
            <tbody>{list.data.map((m) => <tr key={m.id}><td className="small">{time(m.created_at)}</td><td className="small mono">{m.to_address}<span className="tiny muted" style={{ display: 'block' }}>{m.channel}</span></td>
              <td className="small"><b>{m.subject ?? words(m.template_code)}</b><span className="tiny muted" style={{ display: 'block', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.body}</span></td>
              <td><span className={`pill ${m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : 'blue'}`}>{words(m.status)}</span>{m.last_error && <span className="tiny muted" style={{ display: 'block' }}>{m.last_error}</span>}</td></tr>)}</tbody></table></div>}
        </section>
      </main>
    </>
  );
}
