import { useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, day, session, setSession, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, tell } from '../ui';
import { useSchool } from './Payroll';
import { FailedPage } from '../errors';

/**
 * Alumni. For the school (the alumni coordinator or principal): registrations to verify (those
 * matching the school's records are verified by themselves), the list, and reunions and newsletters
 * sent by email. For former pupils (/alumni): register once, sign in with a code, keep their
 * details, see the school's directory (only those who agreed to be listed) and reply to invitations.
 */

export function AlumniDesk() {
  const [schoolId, picker] = useSchool();
  const [q, setQ] = useState({ status: 'PENDING', year: '', search: '' });
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/alumni?${qs}` : null, [schoolId, qs]);
  const ev = useLoad<any[]>(schoolId ? `/schools/${schoolId}/alumni-events` : null, [schoolId]);
  const [check, setCheck] = useState<any>(null);
  const [send, setSend] = useState(false);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Alumni</span><span className="spacer" style={{ flex: 1 }} />{picker}<button className="btn small" onClick={() => setSend(true)}>Reunion or newsletter</button></div></div>
      <main className="page">
        <section className="tile">
          <p className="muted">Former pupils register at <b>/alumni</b>. Those found in the school’s records (same name and date of birth) are verified by themselves; check the rest here.</p>
          <div className="form-grid" style={{ marginTop: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <label className="field"><span>Show</span><select className="input" value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}><option value="PENDING">To check</option><option value="VERIFIED">Verified</option><option value="REJECTED">Not verified</option><option value="">All</option></select></label>
            <label className="field"><span>Left in</span><input className="input" inputMode="numeric" value={q.year} onChange={(e) => setQ({ ...q, year: e.target.value })} placeholder="Any year" /></label>
            <label className="field"><span>Search</span><input className="input" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} /></label>
          </div>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>Nobody here.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Name</th><th>Left</th><th>Now</th><th>Contact</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.map((a) => <tr key={a.id}><td><b>{a.name}</b><span className="tiny muted" style={{ display: 'block' }}>{a.number}{a.dob ? ` · born ${day(a.dob)}` : ''}{a.matched_record ? ` · record ${a.matched_record}` : ''}</span></td><td className="small">{a.left_year}{a.last_class ? ` (Class ${a.last_class})` : ''}</td>
              <td className="small">{[a.occupation, a.organisation, a.city].filter(Boolean).join(', ') || '—'}</td><td className="small">{a.email}<span className="tiny muted" style={{ display: 'block' }}>{a.mobile}</span></td>
              <td><span className={`pill ${a.status === 'VERIFIED' ? 'green' : a.status === 'PENDING' ? 'orange' : ''}`}>{a.status === 'PENDING' ? 'To check' : a.status === 'VERIFIED' ? 'Verified' : 'Not verified'}</span>{a.in_directory && <span className="tiny muted" style={{ display: 'block' }}>In the directory</span>}</td>
              <td>{a.status === 'PENDING' && <button className="linkbtn small" onClick={() => setCheck(a)}>Check</button>}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="tile"><h3>Reunions and newsletters</h3>{!(ev.data ?? []).length ? <Empty>None sent yet.</Empty> : ev.data!.map((e) => <div key={e.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <span><b>{e.title}</b> <span className="small muted">{e.kind.toLowerCase()}{e.on_date ? ` · ${day(e.on_date)}` : ''}{e.venue ? ` · ${e.venue}` : ''} · {e.batches?.length ? `batches ${e.batches.join(', ')}` : 'all batches'}</span></span>
          <span className="small">{e.replies ? Object.entries(e.replies).map(([k, n]) => `${k === 'YES' ? 'Coming' : k === 'NO' ? 'Not coming' : 'Maybe'} ${n}`).join(' · ') : ''}</span></div>)}</section>
      </main>
      {check && <CheckDrawer a={check} onClose={() => { setCheck(null); list.reload(); }} />}
      {send && <SendDrawer schoolId={schoolId} onClose={() => { setSend(false); ev.reload(); }} />}
    </>
  );
}

function CheckDrawer({ a, onClose }: { a: any; onClose: () => void }) {
  const m = useLoad<any[]>(`/alumni/${a.id}/matches`);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  return <Drawer title={`Check ${a.name}`} onClose={onClose}><section className="tile tight stack">
    <p className="small">Says they left in {a.left_year}{a.last_class ? ` from Class ${a.last_class}` : ''}{a.dob ? `, born ${day(a.dob)}` : ''}.</p>
    <h3>Former pupils with a similar name</h3>
    {!m.data ? <Empty>Loading…</Empty> : !m.data.length ? <Empty>None in the records (perhaps before the records start).</Empty> : m.data.map((s) => <label key={s.id} className="check small"><input type="radio" name="m" checked={pick === s.id} onChange={() => setPick(s.id)} />{s.name} · born {day(s.dob)} · Class {s.last_class} · left {day(s.left_on)} · {s.nes_id}</label>)}
    <input className="input" placeholder="Note (needed if not verifying)" value={note} onChange={(e) => setNote(e.target.value)} />
    <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/alumni/${a.id}/verify`, { body: { approve: true, studentId: pick || null, note: note || undefined } }), 'Verified; they are told by email')) onClose(); }}>Verify</button>
      <button className="btn quiet small" disabled={busy || note.trim().length < 3} onClick={async () => { if (await run(() => api(`/alumni/${a.id}/verify`, { body: { approve: false, note } }), 'Done')) onClose(); }}>Cannot verify</button></div>
  </section></Drawer>;
}

function SendDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ title: '', kind: 'REUNION', onDate: '', venue: '', body: '', batches: '' });
  const { run, busy } = useAction();
  return <Drawer title="Reunion or newsletter" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="REUNION">Reunion</option><option value="TALK">Talk to pupils</option><option value="NEWSLETTER">Newsletter</option><option value="OTHER">Other</option></select></label>
      {f.kind !== 'NEWSLETTER' && <><label className="field"><span>Date</span><input className="input" type="date" value={f.onDate} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
        <label className="field"><span>Venue</span><input className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></label></>}
      <label className="field"><span>Batches (years left, comma separated; empty for all)</span><input className="input" value={f.batches} onChange={(e) => setF({ ...f, batches: e.target.value })} placeholder="2016, 2017" /></label>
    </div>
    <label className="field"><span>Message</span><textarea className="input" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
    <button className="btn big" disabled={busy || f.title.trim().length < 3 || f.body.trim().length < 10} onClick={async () => {
      const r: any = await run(() => api(`/schools/${schoolId}/alumni-events`, { body: { title: f.title, kind: f.kind, onDate: f.onDate || null, venue: f.venue || undefined, body: f.body, batches: f.batches.split(',').map((x) => Number(x.trim())).filter((x) => x > 1900) } }));
      if (r) { await tell(`Sent to ${r.sent} verified alumni.`); onClose(); }
    }}>Send by email</button>
  </section></Drawer>;
}

// ── The alumni portal (/alumni) ───────────────────────────────────────────────────────────

const alumnus = (): User | null => { const s = session(); return s?.user.role === 'ALUMNUS' ? s.user : null; };

export function AlumniPortal() {
  const me = alumnus();
  const nav = useNavigate();
  return <>
    <header className="globalnav"><div className="globalnav-in">
      <Link to="/alumni" className="brand"><img className="brand-logo" src="/brand/navshiksha/horizontal-dark.png" alt="NavShiksha" /></Link><span className="small muted" style={{ marginLeft: 8 }}>Alumni</span><span className="spacer" />
      {me ? <button className="linkbtn small" onClick={() => { setSession(null); nav('/alumni'); }}>Sign out</button> : <Link className="small" to="/alumni/sign-in">Sign in</Link>}
    </div></header>
    <Routes>
      <Route path="/" element={me ? <AlumniHome /> : <AlumniRegister />} />
      <Route path="/sign-in" element={<AlumniSignIn />} />
      <Route path="*" element={<Navigate to="/alumni" />} />
    </Routes>
  </>;
}

function Codes({ purpose, dests, sent, setSent }: { purpose: string; dests: [string, string][]; sent: Record<string, string>; setSent: (s: Record<string, string>) => void }) {
  const { run, busy } = useAction();
  return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{dests.map(([k, d]) => <button key={k} className="btn quiet small" disabled={busy || d.trim().length < 5} onClick={async () => { const r: any = await run(() => api('/public/alumni/code', { body: { destination: d, purpose } })); if (r) setSent({ ...sent, [k]: r.sandboxCode ?? 'sent' }); }}>{sent[k] ? `Code sent to the ${k}${sent[k] !== 'sent' ? ` (test: ${sent[k]})` : ''}` : `Send a code to the ${k}`}</button>)}</div>;
}

async function signIn(token: string) {
  setSession({ token, user: { id: '', name: '', role: 'ALUMNUS', designation: null, scopePath: null, guardianId: null } });
  setSession({ token, user: await api<User>('/me') });
  window.location.href = '/alumni';
}

function AlumniRegister() {
  const schools = useLoad<any[]>('/public/alumni/schools');
  const [f, setF] = useState({ schoolId: '', name: '', email: '', mobile: '', dob: '', leftYear: '', lastClass: '', city: '', occupation: '', organisation: '', inDirectory: true, emailCode: '', mobileCode: '' });
  const [sent, setSent] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  return <main className="page"><section className="tile" style={{ maxWidth: 760 }}>
    <h1 style={{ fontSize: '1.8rem' }}>Once a Navy Children School pupil…</h1>
    <p className="muted" style={{ marginTop: 6 }}>Register with your school to hear about reunions and to find your batchmates. If your school’s records show you, you are verified at once. Already registered? <Link to="/alumni/sign-in">Sign in</Link>.</p>
    <div className="form-grid" style={{ marginTop: 12 }}>
      <label className="field"><span>Your school</span><select className="input" value={f.schoolId} onChange={(e) => setF({ ...f, schoolId: e.target.value })}><option value="">Choose</option>{(schools.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field"><span>Full name (as at school)</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></label>
      <label className="field"><span>Year you left</span><input className="input" inputMode="numeric" value={f.leftYear} onChange={(e) => setF({ ...f, leftYear: e.target.value })} /></label>
      <label className="field"><span>Last class</span><input className="input" value={f.lastClass} onChange={(e) => setF({ ...f, lastClass: e.target.value.toUpperCase() })} placeholder="XII" /></label>
      <label className="field"><span>City now</span><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
      <label className="field"><span>What you do</span><input className="input" value={f.occupation} onChange={(e) => setF({ ...f, occupation: e.target.value })} /></label>
      <label className="field"><span>Where</span><input className="input" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></label>
      <label className="field"><span>Email</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></label>
    </div>
    <div style={{ marginTop: 10 }}><Codes purpose="ALUMNI_REGISTER" dests={[['email', f.email], ['mobile', f.mobile]]} sent={sent} setSent={setSent} /></div>
    <div className="form-grid" style={{ marginTop: 10 }}>
      <label className="field"><span>Code from the email</span><input className="input mono" maxLength={6} value={f.emailCode} onChange={(e) => setF({ ...f, emailCode: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field"><span>Code from the SMS</span><input className="input mono" maxLength={6} value={f.mobileCode} onChange={(e) => setF({ ...f, mobileCode: e.target.value.replace(/\D/g, '') })} /></label>
    </div>
    <label className="check small" style={{ marginTop: 8 }}><input type="checkbox" checked={f.inDirectory} onChange={(e) => setF({ ...f, inDirectory: e.target.checked })} />List me in my school’s alumni directory (name, batch, city and work; never my email or mobile)</label>
    <button className="btn big" style={{ marginTop: 12 }} disabled={busy || !f.schoolId || f.name.trim().length < 3 || !f.leftYear || f.emailCode.length !== 6 || f.mobileCode.length !== 6} onClick={async () => {
      const r: any = await run(() => api('/public/alumni/register', { body: { ...f, dob: f.dob || null, leftYear: Number(f.leftYear) } }));
      if (r) await signIn(r.token);
    }}>Register</button>
  </section></main>;
}

function AlumniSignIn() {
  const [d, setD] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  return <main className="page"><section className="tile" style={{ maxWidth: 480 }}><h2>Sign in</h2>
    <label className="field" style={{ marginTop: 10 }}><span>Email or mobile you registered with</span><input className="input" value={d} onChange={(e) => setD(e.target.value)} /></label>
    <div style={{ marginTop: 8 }}><Codes purpose="ALUMNI_LOGIN" dests={[['email or mobile', d]]} sent={sent} setSent={setSent} /></div>
    <label className="field" style={{ marginTop: 8 }}><span>Code</span><input className="input mono" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
    <button className="btn big" style={{ marginTop: 10 }} disabled={busy || code.length !== 6} onClick={async () => { const r: any = await run(() => api('/public/alumni/login', { body: { destination: d, code } })); if (r) await signIn(r.token); }}>Sign in</button>
  </section></main>;
}

function AlumniHome() {
  const p = useLoad<any>('/alumni-me');
  const [q, setQ] = useState({ year: '', search: '' });
  const qs = new URLSearchParams(Object.entries({ year: q.year, q: q.search }).filter(([, v]) => v)).toString();
  const verified = p.data?.status === 'VERIFIED';
  const dir = useLoad<any[]>(verified ? `/alumni-me/directory?${qs}` : null, [verified, qs]);
  const ev = useLoad<any[]>(verified ? '/alumni-me/events' : null, [verified]);
  const { run, busy } = useAction();
  if (!p.data) return p.error ? <FailedPage error={p.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const a = p.data;
  return <main className="page">
    <section className="tile"><h2>{a.name}</h2><p className="muted">{a.school} · left {a.left_year}{a.last_class ? ` from Class ${a.last_class}` : ''} · {a.number}</p>
      {!verified && <div className="callout orange small" style={{ marginTop: 10 }}>{a.status === 'PENDING' ? 'Your school is checking your registration; you will be told by email.' : 'Your school could not verify you. Contact the school office.'}</div>}
      <label className="check small" style={{ marginTop: 10 }}><input type="checkbox" checked={a.in_directory} disabled={busy} onChange={async (e) => { if (await run(() => api('/alumni-me', { method: 'PUT', body: { inDirectory: e.target.checked } }), 'Saved')) p.reload(); }} />List me in the alumni directory</label></section>
    {verified && <>
      <section className="tile"><h3>Invitations and news</h3>{!(ev.data ?? []).length ? <Empty>Nothing yet.</Empty> : ev.data!.map((e) => <div key={e.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
        <b>{e.title}</b><span className="small muted">{e.on_date ? day(e.on_date) : ''}{e.venue ? ` · ${e.venue}` : ''}</span><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.body}</p>
        {e.kind !== 'NEWSLETTER' && <div style={{ display: 'flex', gap: 6 }}>{[['YES', 'I’ll come'], ['MAYBE', 'Maybe'], ['NO', 'Can’t come']].map(([k, l]) => <button key={k} className={`btn small ${e.answer === k ? '' : 'quiet'}`} disabled={busy} onClick={async () => { if (await run(() => api(`/alumni-me/events/${e.id}/rsvp`, { body: { answer: k } }), 'Thank you')) ev.reload(); }}>{l}</button>)}</div>}</div>)}</section>
      <section className="tile"><h3>Directory</h3>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><input className="input" inputMode="numeric" style={{ width: 120 }} placeholder="Year" value={q.year} onChange={(e) => setQ({ ...q, year: e.target.value })} /><input className="input" placeholder="Name, city or organisation" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} /></div>
        {(dir.data ?? []).map((d, k) => <div key={k} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{d.name}</b> · {[d.occupation, d.organisation, d.city].filter(Boolean).join(', ')}</span><span className="muted">{d.left_year}</span></div>)}</section>
    </>}
  </main>;
}
