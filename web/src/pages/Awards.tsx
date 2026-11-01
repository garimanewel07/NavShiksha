import { useEffect, useState } from 'react';
import { api, day, money, today, type User, currentYear } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools } from '../ui';

/**
 * NES awards: merit awards for toppers and the Outstanding Teacher Award. A school (or a Command,
 * or NES) nominates with a citation; a different NES officer approves; the payment is recorded
 * with its reference. Every step is kept.
 */

const STATUS: Record<string, [string, string]> = { NOMINATED: ['Waiting for NES', 'orange'], APPROVED: ['Approved', 'blue'], REJECTED: ['Not approved', 'red'], PAID: ['Paid', 'green'] };
const YEAR = currentYear();

export default function Awards({ user }: { user: User }) {
  const list = useLoad<any[]>('/awards');
  const schemes = useLoad<any[]>('/awards/schemes');
  const [nominate, setNominate] = useState(false);
  const [scheme, setScheme] = useState(false);
  const [filter, setFilter] = useState('');
  const nes = user.role === 'NES_ADMIN';
  const canNominate = ['SCHOOL_ADMIN', 'NES_ADMIN', 'COMMAND_OFFICER'].includes(user.role);
  const rows = (list.data ?? []).filter((n) => !filter || n.status === filter);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Awards</span><span className="spacer" />
        {nes && <button className="btn quiet small" onClick={() => setScheme(true)}>New award</button>}
        {canNominate && <button className="btn small" onClick={() => setNominate(true)}>Nominate</button>}</div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head"><div><h2>NES awards</h2><p className="muted" style={{ marginTop: 6 }}>A school nominates with a citation; a different NES officer approves; the payment is recorded with its bank reference, and the family or teacher is told.</p></div>
            <div className="seg">{[['', 'All'], ['NOMINATED', 'Waiting'], ['APPROVED', 'To pay'], ['PAID', 'Paid'], ['REJECTED', 'Not approved']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div></div>
          {!list.data ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No nominations here.</Empty> : <div className="stack" style={{ gap: 10 }}>
            {rows.map((n) => <Nomination key={n.id} n={n} user={user} onDone={list.reload} />)}</div>}
        </section>
        <section className="tile">
          <h3>Awards available this year</h3>
          <div className="grid" style={{ marginTop: 10 }}>{(schemes.data ?? []).map((s) => <div key={s.id} className="tile tight" style={{ background: 'var(--fill)' }}>
            <div className="tiny muted">{s.kind === 'STUDENT' ? 'For a student' : 'For a teacher'}</div><b>{s.name}</b><div className="small">{money(s.amount_paise)}</div>
            {s.criteria && <div className="tiny muted" style={{ marginTop: 4 }}>{s.criteria}</div>}</div>)}</div>
        </section>
      </main>
      {nominate && <NominateDrawer schemes={schemes.data ?? []} onClose={() => { setNominate(false); list.reload(); }} />}
      {scheme && <SchemeDrawer onClose={() => { setScheme(false); schemes.reload(); }} />}
    </>
  );
}

function Nomination({ n, user, onDone }: { n: any; user: User; onDone: () => void }) {
  const { run, busy } = useAction();
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [label, tone] = STATUS[n.status] ?? [n.status, ''];
  const nes = user.role === 'NES_ADMIN';
  const mine = n.nominated_by === user.name;
  return (
    <div className="tile tight stack small" style={{ background: 'var(--fill)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: '1rem' }}>{n.nominee}</b><span className="muted">{n.school.replace('Navy Children School, ', 'NCS ')}</span>
        <span className={`pill ${tone}`}>{label}</span><span className="spacer" style={{ flex: 1 }} /><span>{n.scheme} · <b>{money(n.amount_paise)}</b></span></div>
      <p>{n.citation}</p>
      <span className="tiny muted">Nominated by {n.nominated_by} on {day(n.nominated_at)}{n.decided_by ? ` · ${n.status === 'REJECTED' ? 'declined' : 'approved'} by ${n.decided_by}` : ''}{n.decision_note ? ` · ${n.decision_note}` : ''}{n.payment_ref ? ` · paid ${day(n.paid_at)}, ref. ${n.payment_ref}` : ''}</span>
      {nes && n.status === 'NOMINATED' && (mine ? <span className="tiny muted">You made this nomination, so another NES officer approves it.</span> : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px', height: 36 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/awards/${n.id}/decide`, { body: { approve: true, note: note || undefined } }), 'Approved')) onDone(); }}>Approve</button>
        <button className="btn danger small" disabled={busy || note.trim().length < 5} onClick={async () => { if (await run(() => api(`/awards/${n.id}/decide`, { body: { approve: false, note } }), 'Not approved')) onDone(); }}>Decline (give a note)</button>
      </div>)}
      {nes && n.status === 'APPROVED' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px', height: 36 }} placeholder="Bank transfer reference (UTR)" value={ref} onChange={(e) => setRef(e.target.value)} />
        <button className="btn small" disabled={busy || ref.trim().length < 4} onClick={async () => { if (await run(() => api(`/awards/${n.id}/pay`, { body: { paymentRef: ref } }), 'Payment recorded; the family or teacher is told')) onDone(); }}>Record payment</button>
      </div>}
    </div>
  );
}

function NominateDrawer({ schemes, onClose }: { schemes: any[]; onClose: () => void }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [schemeId, setSchemeId] = useState('');
  const s = schemes.find((x) => x.id === schemeId);
  const [q, setQ] = useState('');
  const students = useLoad<any[]>(s?.kind === 'STUDENT' && q.trim().length >= 2 ? `/students?q=${encodeURIComponent(q.trim())}&schoolId=${schoolId}` : null, [q, schoolId, s?.kind]);
  const staff = useLoad<any[]>(s?.kind === 'TEACHER' && schoolId ? `/schools/${schoolId}/staff` : null, [schoolId, s?.kind]);
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [citation, setCitation] = useState('');
  const { run, busy } = useAction();
  return (
    <Drawer title="Nominate for an NES award" onClose={onClose}>
      <section className="tile tight stack">
        {schools.length > 1 && <label className="field"><span>School</span><SchoolPicker value={schoolId} onChange={(v) => { setSchoolId(v); setWho(null); }} schools={schools} /></label>}
        <label className="field"><span>Award</span><select className="input" value={schemeId} onChange={(e) => { setSchemeId(e.target.value); setWho(null); }}>
          <option value="">Choose an award</option>{schemes.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.amount_paise)}</option>)}</select></label>
        {s && <p className="tiny muted">{s.criteria}</p>}
        {s?.kind === 'STUDENT' && (who ? <div className="callout small"><b>{who.name}</b> <button className="linkbtn small" onClick={() => setWho(null)}>Change</button></div> : <>
          <label className="field"><span>Student</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or admission number" /></label>
          {(students.data ?? []).map((x) => <button key={x.id} className="list-row" style={{ gridTemplateColumns: '1fr', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setWho({ id: x.id, name: x.name })}>
            <span><b>{x.name}</b> <span className="small muted">· {x.class_code}{x.section ? `-${x.section}` : ''} · {x.admission_no}</span></span></button>)}</>)}
        {s?.kind === 'TEACHER' && <label className="field"><span>Teacher</span><select className="input" value={who?.id ?? ''} onChange={(e) => { const t = (staff.data ?? []).find((x) => x.id === e.target.value); setWho(t ? { id: t.id, name: t.name } : null); }}>
          <option value="">Choose a teacher</option>{(staff.data ?? []).filter((x) => x.role === 'TEACHER').map((x) => <option key={x.id} value={x.id}>{x.name}{x.designation ? ` · ${x.designation}` : ''}</option>)}</select></label>}
        <label className="field"><span>Citation</span><textarea className="input" rows={4} maxLength={1500} value={citation} onChange={(e) => setCitation(e.target.value)} placeholder="Why this nomination: results, achievements, contribution (at least a sentence)." /></label>
        <button className="btn big" disabled={busy || !s || !who || citation.trim().length < 10} onClick={async () => {
          if (await run(() => api('/awards', { body: { schemeId, schoolId, year: YEAR, citation, ...(s.kind === 'STUDENT' ? { studentId: who!.id } : { teacherId: who!.id }) } }), 'Nominated; NES is told')) onClose();
        }}>Send nomination</button>
      </section>
    </Drawer>
  );
}

function SchemeDrawer({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ code: '', name: '', kind: 'STUDENT', amount: '', criteria: '' });
  const { run, busy } = useAction();
  return (
    <Drawer title="New NES award" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, code: f.code || e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) })} placeholder="NES Merit Award — Class XII topper" /></label>
        <label className="field"><span>Code</span><input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></label>
        <div className="form-grid">
          <label className="field"><span>For</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="STUDENT">A student</option><option value="TEACHER">A teacher</option></select></label>
          <label className="field"><span>Amount (₹)</span><input className="input" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        <label className="field"><span>Who qualifies</span><textarea className="input" rows={3} value={f.criteria} onChange={(e) => setF({ ...f, criteria: e.target.value })} /></label>
        <button className="btn" disabled={busy || f.name.trim().length < 3 || f.code.length < 3 || !f.amount} onClick={async () => {
          if (await run(() => api('/awards/schemes', { body: { code: f.code, name: f.name, kind: f.kind, amountPaise: Number(f.amount) * 100, criteria: f.criteria, from: today() } }), 'Award created')) onClose();
        }}>Create award</button>
      </section>
    </Drawer>
  );
}
