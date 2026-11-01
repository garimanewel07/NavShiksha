import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, apiFile, day, money, readBase64, session, setSession, time, words, type User } from '../api';
import { Empty, useAction, useLoad, ask } from '../ui';
import Help from './Help';
import { FailedPage } from '../errors';

/**
 * Careers at Navy Children Schools and Navy Kindergartens: open vacancies for anyone to read, and,
 * for a registered candidate, one profile kept for life and every application in one place.
 * Registering once (email and mobile verified by codes) is enough for every later year: to apply,
 * a candidate checks they are eligible, confirms the declaration and pays the school's fee.
 */

const STATUS: Record<string, [string, string]> = {
  FEE_DUE: ['Fee due', 'orange'], SUBMITTED: ['Submitted', 'blue'], SHORTLISTED: ['Shortlisted', 'blue'], CWT: ['Written test', 'blue'], INTERVIEW: ['Interview', 'blue'],
  SELECTED: ['Selected', 'green'], WAITLISTED: ['Waiting list', 'orange'], REJECTED: ['Not taken forward', ''], NOT_SELECTED: ['Not selected', ''], WITHDRAWN: ['Withdrawn', ''], APPOINTED: ['Appointed', 'green'],
};
const Stage = ({ s }: { s: string }) => { const [l, t] = STATUS[s] ?? [words(s), '']; return <span className={`pill ${t}`}>{l}</span>; };
const LEVELS: [string, string][] = [['SECONDARY', 'Class X'], ['SR_SECONDARY', 'Class XII'], ['DIPLOMA', 'Diploma'], ['GRADUATION', 'Graduation'], ['POST_GRADUATION', 'Post-graduation'], ['BED', 'B.Ed.'], ['DELED', 'D.El.Ed.'],
  ['NTT', 'Nursery teacher training / ECCE'], ['MED', 'M.Ed.'], ['MPHIL', 'M.Phil.'], ['PHD', 'Ph.D.'], ['OTHER', 'Other']];
const POSTS: [string, string][] = [['', 'Any post'], ['PGT', 'Post Graduate Teacher'], ['TGT', 'Trained Graduate Teacher'], ['PRT', 'Primary Teacher'], ['BALVATIKA', 'Balvatika teacher'], ['SPECIAL_EDUCATOR', 'Special educator'], ['COUNSELLOR', 'Counsellor'],
  ['LIBRARIAN', 'Librarian'], ['PTI', 'Physical training instructor'], ['PRINCIPAL', 'Principal'], ['VICE_PRINCIPAL', 'Vice Principal'], ['OFFICE_SUPDT', 'Office superintendent'], ['ACCOUNTANT', 'Accountant'], ['CLERK', 'Office clerk'], ['NURSE', 'Nurse']];

const candidate = (): User | null => { const s = session(); return s?.user.role === 'CANDIDATE' ? s.user : null; };

function Header() {
  const me = candidate();
  const nav = useNavigate();
  return (
    <header className="globalnav"><div className="globalnav-in">
      <Link to="/careers" className="brand" aria-label="NavShiksha Careers"><img className="brand-logo" src="/brand/navshiksha/horizontal-dark.png" alt="NavShiksha" /></Link>
      <span className="small muted" style={{ marginLeft: 8 }}>Careers</span><span className="spacer" />
      {me ? <span className="who"><NavLink className="small" to="/careers/my">My applications</NavLink><NavLink className="small" to="/careers/profile">My profile</NavLink><NavLink className="small" to="/careers/help">Help</NavLink>
        <button className="linkbtn small" onClick={() => { setSession(null); nav('/careers'); }}>Sign out</button></span>
        : <span className="who"><Link className="small" to="/careers/login">Sign in</Link><Link className="btn small" to="/careers/register">Register</Link></span>}
    </div></header>
  );
}

export default function Careers() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<Openings />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<SignIn />} />
        <Route path="/my" element={<Need><MyApplications /></Need>} />
        <Route path="/profile" element={<Need><MyProfile /></Need>} />
        <Route path="/help/*" element={<Need><HelpRoutes /></Need>} />
        <Route path="/:id" element={<Opening />} />
      </Routes>
    </>
  );
}
const HelpRoutes = () => <Routes><Route path="/" element={<Help user={candidate()!} />} /><Route path="/:number" element={<Help user={candidate()!} />} /></Routes>;
const Need = ({ children }: { children: JSX.Element }) => (candidate() ? children : <Navigate to="/careers/login" />);

function Openings() {
  const [q, setQ] = useState({ postType: '', q: '' });
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const list = useLoad<any[]>(`/public/careers?${qs}`, [qs]);
  return (
    <main className="page">
      <section className="tile">
        <h1 style={{ fontSize: '1.9rem' }}>Teach at a Navy Children School.</h1>
        <p className="muted" style={{ marginTop: 8, maxWidth: 720 }}>Vacancies at Navy Children Schools and Navy Kindergartens across India, run by the Navy Education Society. Register once: your profile is kept, and in later years you only choose a post, confirm and pay the fee.</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 240 }} value={q.postType} onChange={(e) => setQ({ ...q, postType: e.target.value })} aria-label="Post">{POSTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className="input" style={{ flex: '1 1 240px' }} placeholder="School, city or subject" value={q.q} onChange={(e) => setQ({ ...q, q: e.target.value })} />
        </div>
      </section>
      {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No vacancies are open just now. Register to be told when one opens.</Empty> : list.data.map((v) => (
        <Link key={v.id} to={`/careers/${v.id}`} className="tile" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
          <div className="tile-head"><div><h3>{v.title}</h3><p className="small muted">{v.school}{v.city ? `, ${v.city}` : ''} · {words(v.employment)} · {v.positions} {v.positions === 1 ? 'post' : 'posts'}{v.pay_text ? ` · ${v.pay_text}` : ''}{v.cwt ? ' · written test' : ''}</p></div>
            <span className="small">Apply by <b>{day(v.closes_on)}</b></span></div>
          <p className="tiny muted" style={{ marginTop: 4 }}>{v.code} · {Object.values(v.fees ?? {}).every((x: any) => !x) ? 'free to apply' : `fee ${money(v.fees.GEN ?? 0)}${v.fees?.SC === 0 ? ', no fee for SC, ST, PwD and ex-servicemen' : ''}`}</p>
        </Link>))}
    </main>
  );
}

function Opening() {
  const { id } = useParams();
  const v = useLoad<any>(`/public/careers/${id}`, [id]);
  const me = candidate();
  const chk = useLoad<any>(me ? `/candidate/vacancies/${id}/check` : null, [id]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [declared, setDeclared] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  const x = v.data, c = chk.data;
  return (
    <main className="page">
      {!x ? <Empty>{v.error ?? 'Loading…'}</Empty> : <>
        <section className="tile">
          <Link to="/careers" className="small">← All vacancies</Link>
          <h1 style={{ fontSize: '1.7rem', marginTop: 8 }}>{x.title}</h1>
          <p className="muted" style={{ marginTop: 4 }}>{x.school} · {words(x.employment)} · {x.code}</p>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div><span className="tiny muted">Applications</span><div>{day(x.opens_on)} to <b>{day(x.closes_on)}</b></div></div>
            <div><span className="tiny muted">Age reckoned on</span><div>{day(x.age_as_on)}</div></div>
            <div><span className="tiny muted">Selection</span><div>{[x.cwt && 'Common Written Test', 'interview'].filter(Boolean).join(', ')}</div></div>
            <div><span className="tiny muted">Fee</span><div>{['GEN', 'OBC', 'EWS', 'SC', 'ST', 'PWD', 'ESM', 'WOMEN'].filter((k) => x.fees?.[k] !== null && x.fees?.[k] !== undefined).map((k) => [k, x.fees[k]] as const).map(([k, p]) => `${k === 'GEN' ? 'General' : k === 'ESM' ? 'Ex-servicemen' : k === 'PWD' ? 'PwD' : k === 'WOMEN' ? 'Women' : k} ${p ? money(p as number) : 'nil'}`).join(' · ')}</div></div>
          </div>
          {x.description && <p style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{x.description}</p>}
          <h3 style={{ marginTop: 14 }}>Who can apply</h3>
          <ul className="small" style={{ marginTop: 6, paddingLeft: 18 }}>{x.rules.map((r: string) => <li key={r}>{r}</li>)}</ul>
        </section>
        {!x.open ? <section className="tile"><Empty>Applications for this vacancy are closed.</Empty></section> : !me ? <section className="tile"><h3>Apply</h3>
          <p className="small" style={{ marginTop: 6 }}>Register once with your email and mobile number, or sign in if you have registered before (in any year).</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><Link className="btn" to={`/careers/register?next=${id}`}>Register</Link><Link className="btn quiet" to={`/careers/login?next=${id}`}>Sign in</Link></div></section>
          : !c ? <section className="tile"><Empty>{chk.error ?? 'Checking your profile…'}</Empty></section> : c.applied ? <section className="tile"><h3>You have applied</h3><p className="small">Application {c.applied.number} · <Stage s={c.applied.status} /> · <Link to="/careers/my">see it</Link></p></section> : <section className="tile">
            <h3>Your eligibility</h3>
            <p className="tiny muted">Checked from your profile. If something is missing, add it to <Link to="/careers/profile">your profile</Link> once; it is used for every application.</p>
            {c.checks.map((k: any) => <div key={k.label} className="list-row" style={{ gridTemplateColumns: '24px 1fr' }}><span aria-label={k.ok ? 'Met' : 'Not met'} style={{ color: k.ok ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{k.ok ? '✓' : '✗'}</span><span><b>{k.label}</b><span className="tiny muted" style={{ display: 'block' }}>{k.detail}</span></span></div>)}
            {c.missingDocuments.length > 0 && <div className="callout orange small" style={{ marginTop: 10 }}>Before applying, upload these in <Link to="/careers/profile">your profile</Link>: {c.missingDocuments.join('; ')}.</div>}
            {c.eligible && !c.missingDocuments.length && <div className="stack" style={{ marginTop: 12 }}>
              {c.questions.map((q: any) => <label key={q.id} className="field"><span>{q.label}{q.required ? '' : ' (optional)'}</span>
                {q.type === 'YESNO' ? <select className="input" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">Choose</option><option>Yes</option><option>No</option></select>
                  : q.type === 'CHOICE' ? <select className="input" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">Choose</option>{(q.options ?? []).map((o: string) => <option key={o}>{o}</option>)}</select>
                  : <textarea className="input" rows={3} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />}</label>)}
              <div className="callout small"><b>Declaration</b><p style={{ marginTop: 6 }}>{c.declaration}</p>
                <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />I agree, and confirm the details in my profile are correct.</label></div>
              <button className="btn big" disabled={busy || !declared} onClick={async () => {
                const r: any = await run(() => api(`/candidate/vacancies/${id}/apply`, { body: { answers, declaration: true } }), 'Application saved');
                if (r) nav(r.status === 'FEE_DUE' ? `/careers/my?pay=${r.id}` : '/careers/my');
              }}>{c.fee ? `Apply and pay ${money(c.fee)}` : 'Apply (no fee)'}</button></div>}
          </section>}
      </>}
    </main>
  );
}

function OtpFlow({ purpose, onDone }: { purpose: 'REGISTER' | 'LOGIN'; onDone: (token: string) => void }) {
  const [f, setF] = useState({ name: '', email: '', mobile: '', dob: '', gender: 'F', category: 'GEN', destination: '', emailCode: '', mobileCode: '', code: '' });
  const [sent, setSent] = useState<Record<string, { to: string; sandboxCode?: string }>>({});
  const { run, busy } = useAction();
  const ask = async (k: string, destination: string) => { const r: any = await run(() => api('/public/careers/otp', { body: { destination, purpose } })); if (r) setSent((s) => ({ ...s, [k]: r })); };
  const hint = (k: string) => sent[k] && <span className="tiny muted">Code sent to {sent[k].to}.{sent[k].sandboxCode && <> Test system: the code is <b className="mono">{sent[k].sandboxCode}</b>.</>}</span>;
  if (purpose === 'LOGIN') return (
    <div className="stack">
      <label className="field"><span>Registered email or mobile</span><input className="input" value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></label>
      {!sent.login ? <button className="btn" disabled={busy || f.destination.trim().length < 5} onClick={() => ask('login', f.destination)}>Send a code</button> : <>
        {hint('login')}
        <label className="field"><span>Code</span><input className="input mono" inputMode="numeric" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></label>
        <button className="btn big" disabled={busy || f.code.length !== 6} onClick={async () => { const r: any = await run(() => api('/public/careers/login', { body: { destination: f.destination, code: f.code } })); if (r) onDone(r.token); }}>Sign in</button></>}
    </div>
  );
  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field"><span>Full name (as in your Class X certificate)</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></label>
        <label className="field"><span>Gender</span><select className="input" value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="F">Woman</option><option value="M">Man</option><option value="X">Another gender</option></select></label>
        <label className="field"><span>Category</span><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{[['GEN', 'General'], ['OBC', 'OBC (non-creamy layer)'], ['SC', 'SC'], ['ST', 'ST'], ['EWS', 'EWS']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      <div className="form-grid">
        <div className="field"><span>Email</span><div style={{ display: 'flex', gap: 6 }}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /><button className="btn quiet small" disabled={busy || !f.email.includes('@')} onClick={() => ask('email', f.email)}>{sent.email ? 'Resend' : 'Send code'}</button></div>{hint('email')}
          {sent.email && <input className="input mono" style={{ marginTop: 6 }} placeholder="Code from the email" inputMode="numeric" maxLength={6} value={f.emailCode} onChange={(e) => setF({ ...f, emailCode: e.target.value.replace(/\D/g, '') })} />}</div>
        <div className="field"><span>Mobile</span><div style={{ display: 'flex', gap: 6 }}><input className="input" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="10 digits" /><button className="btn quiet small" disabled={busy || f.mobile.replace(/\D/g, '').length < 10} onClick={() => ask('mobile', f.mobile)}>{sent.mobile ? 'Resend' : 'Send code'}</button></div>{hint('mobile')}
          {sent.mobile && <input className="input mono" style={{ marginTop: 6 }} placeholder="Code from the SMS" inputMode="numeric" maxLength={6} value={f.mobileCode} onChange={(e) => setF({ ...f, mobileCode: e.target.value.replace(/\D/g, '') })} />}</div>
      </div>
      <button className="btn big" disabled={busy || f.name.trim().length < 3 || !f.dob || f.emailCode.length !== 6 || f.mobileCode.length !== 6} onClick={async () => {
        const r: any = await run(() => api('/public/careers/register', { body: { name: f.name.trim(), email: f.email.trim(), mobile: f.mobile, dob: f.dob, gender: f.gender, category: f.category, emailCode: f.emailCode, mobileCode: f.mobileCode } }), 'Registered');
        if (r) onDone(r.token);
      }}>Register</button>
    </div>
  );
}

function useSignIn() {
  const nav = useNavigate();
  const next = new URLSearchParams(location.search).get('next');
  return async (token: string) => {
    setSession({ token, user: { id: '', name: '', role: 'CANDIDATE', designation: null, scopePath: null, guardianId: null } });
    const me = await api<User>('/me');
    setSession({ token, user: me });
    nav(next ? `/careers/${next}` : '/careers/profile');
  };
}

function Register() {
  const done = useSignIn();
  return <main className="page"><section className="tile" style={{ maxWidth: 760 }}><h2>Register once</h2>
    <p className="muted" style={{ marginTop: 6 }}>One registration for every Navy Children School and Navy Kindergarten, this year and later. We send a code to your email and to your mobile to confirm they are yours.</p>
    <div style={{ marginTop: 14 }}><OtpFlow purpose="REGISTER" onDone={done} /></div>
    <p className="small" style={{ marginTop: 10 }}>Registered before? <Link to={`/careers/login${location.search}`}>Sign in</Link>.</p></section></main>;
}
function SignIn() {
  const done = useSignIn();
  return <main className="page"><section className="tile" style={{ maxWidth: 520 }}><h2>Sign in</h2><p className="muted" style={{ marginTop: 6 }}>With the email or mobile you registered with. There is no password to remember.</p>
    <div style={{ marginTop: 14 }}><OtpFlow purpose="LOGIN" onDone={done} /></div>
    <p className="small" style={{ marginTop: 10 }}>New here? <Link to={`/careers/register${location.search}`}>Register</Link>.</p></section></main>;
}

function MyApplications() {
  const list = useLoad<any[]>('/candidate/applications');
  const { run, busy } = useAction();
  const [pay, setPay] = useState<any>(null);
  const want = new URLSearchParams(location.search).get('pay');
  useEffect(() => { if (want) run(() => api(`/candidate/applications/${want}/pay`, { body: {} })).then((o) => o && setPay(o)); }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  const download = async (a: any) => { const { blob } = await apiFile(`/candidate/applications/${a.id}/admit-card`); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  return (
    <main className="page">
      {pay && <section className="tile"><h3>Pay the application fee</h3><p className="small" style={{ marginTop: 6 }}>{money(pay.amount_paise)} to the school, by UPI, card or net banking. (Test system: choose the result.)</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api(`/candidate/payments/${pay.id}/sandbox`, { body: { outcome: 'success' } }), 'Paid; your application is submitted'); if (r) { setPay(null); history.replaceState(null, '', '/careers/my'); list.reload(); } }}>Payment succeeds</button>
          <button className="btn quiet" disabled={busy} onClick={async () => { await run(() => api(`/candidate/payments/${pay.id}/sandbox`, { body: { outcome: 'failure' } }), 'Payment failed; nothing was charged'); setPay(null); list.reload(); }}>Payment fails</button></div></section>}
      <section className="tile"><h2>My applications</h2>
        <p className="muted" style={{ marginTop: 6 }}>Every stage is also sent to you by email and SMS.</p>
        {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No applications yet. <Link to="/careers">See open vacancies</Link>.</Empty> : list.data.map((a) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{a.post}</b><span className="small muted">{a.school}</span><Stage s={a.status} /></div>
          <span className="tiny muted">{a.number} · applied {day(a.created_at)}{a.receipt_no ? ` · fee receipt ${a.receipt_no}` : ''}{a.cwt_roll_no ? ` · CWT roll ${a.cwt_roll_no}` : ''}{a.cwt_marks !== null && a.cwt_marks !== undefined ? ` · CWT ${a.cwt_marks}/100` : ''}</span>
          {a.interviews.map((i: any) => <div key={i.id} className="callout blue small"><b>{i.title}</b>: {time(i.startsAt)}, {i.venue}{i.bring ? `. Bring: ${i.bring}` : ''}.
            {i.status === 'INVITED' ? <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={async () => { if (await run(() => api(`/candidate/interviews/${i.id}/confirm`, { body: {} }), 'Confirmed')) list.reload(); }}>I will attend</button> : <span className="pill" style={{ marginLeft: 8 }}>{words(i.status)}</span>}</div>)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {a.status === 'FEE_DUE' && <button className="btn small" disabled={busy} onClick={async () => { const o = await run(() => api(`/candidate/applications/${a.id}/pay`, { body: {} })); if (o) setPay(o); }}>Pay {money(a.fee_paise)}</button>}
            {a.cwt_roll_no && <button className="btn quiet small" onClick={() => run(() => download(a))}>Admit card</button>}
            {!['SELECTED', 'APPOINTED', 'REJECTED', 'NOT_SELECTED', 'WITHDRAWN'].includes(a.status) && <button className="linkbtn small" disabled={busy} onClick={async () => { if (await ask('Withdraw this application? The fee is not refunded.') && await run(() => api(`/candidate/applications/${a.id}/withdraw`, { body: {} }), 'Withdrawn')) list.reload(); }}>Withdraw</button>}
          </div></div>)}
      </section>
    </main>
  );
}

function MyProfile() {
  const p = useLoad<any>('/candidate/profile');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(null);
  const [q, setQ] = useState<any>(null);
  useEffect(() => { if (p.data && !f) {
    const d = p.data;
    setF({ name: d.name, fatherName: d.father_name ?? '', motherName: d.mother_name ?? '', dob: d.dob, gender: d.gender, category: d.category, pwd: d.pwd, exServiceman: d.ex_serviceman, navyRelation: d.navy_relation, address: d.address ?? '', city: d.city ?? '', state: d.state ?? '', pincode: d.pincode ?? '', aadhaar: '' });
    setQ({ education: d.education.map((e: any) => ({ ...e, subjects: e.subjects.join(', ') })), tests: d.tests, experience: d.experience.map((x: any) => ({ organisation: x.organisation, post: x.post, subject: x.subject ?? '', fromDate: x.from_date, toDate: x.to_date ?? '', teaching: x.teaching, cbse: x.cbse })) });
  } }, [p.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p.data || !f || !q) return p.error ? <FailedPage error={p.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const d = p.data;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const rows = (k: string, i: number, patch: any) => setQ({ ...q, [k]: q[k].map((r: any, j: number) => (j === i ? { ...r, ...patch } : r)) });
  const upload = async (kind: string, file?: File, refKey?: string) => { if (!file) return; if (await run(async () => api('/candidate/documents', { body: { kind, refKey, name: file.name, contentType: file.type, dataBase64: await readBase64(file) } }), 'Uploaded')) p.reload(); };
  const levelName = (k: string) => LEVELS.find(([x]) => x === k)?.[1] ?? k;
  // Every document the school needs: fixed ones, one certificate per qualification and test listed, and any status claimed.
  const docRows: { kind: string; ref?: string; label: string; help: string; required: boolean; image?: boolean }[] = [
    { kind: 'PHOTO', label: 'Photograph', help: 'A recent passport-size colour photo, face clearly visible. JPG or PNG.', required: true, image: true },
    { kind: 'SIGNATURE', label: 'Signature', help: 'Sign in black or blue ink on white paper, photograph it and crop closely. JPG or PNG.', required: true, image: true },
    { kind: 'THUMB', label: 'Left thumb impression', help: 'Press your left thumb on an ink pad, then on white paper; photograph and crop. JPG or PNG.', required: true, image: true },
    { kind: 'ID_PROOF', label: 'Photo ID', help: 'Aadhaar, passport, voter ID or driving licence.', required: true },
    ...(d.education ?? []).filter((e: any) => e.status !== 'APPEARING').map((e: any) => ({ kind: 'EDUCATION', ref: e.level, label: `${levelName(e.level)}: ${e.degree || 'certificate'}`, help: 'Mark sheet and degree or passing certificate (one PDF, or a clear photo).', required: true })),
    ...(d.tests ?? []).map((t: any) => ({ kind: 'TEST', ref: t.kind, label: `${t.kind} certificate`, help: 'The qualifying certificate or score card.', required: true })),
    ...(!['GEN', 'UR'].includes(d.category) ? [{ kind: 'CATEGORY', label: `${d.category} certificate`, help: 'Caste or EWS certificate issued by the competent authority.', required: true }] : []),
    ...(d.pwd ? [{ kind: 'PWD', label: 'Disability certificate', help: 'Certificate of disability.', required: true }] : []),
    ...(d.ex_serviceman ? [{ kind: 'ESM', label: 'Ex-serviceman certificate', help: 'Discharge book or certificate.', required: true }] : []),
    { kind: 'EXPERIENCE', label: 'Experience certificates', help: 'From each school or organisation you worked at (optional).', required: false },
  ];
  return (
    <main className="page">
      <section className="tile"><h2>My profile</h2><p className="muted" style={{ marginTop: 6 }}>{d.candidate_no} · {d.email} · {d.mobile}. Kept for every application; each application keeps a copy as it was when you applied.</p></section>
      <section className="tile stack"><h3>About you</h3>
        <div className="form-grid">
          <label className="field"><span>Full name</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field"><span>Father’s name</span><input className="input" value={f.fatherName} onChange={(e) => set('fatherName', e.target.value)} /></label>
          <label className="field"><span>Mother’s name</span><input className="input" value={f.motherName} onChange={(e) => set('motherName', e.target.value)} /></label>
          <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(e) => set('dob', e.target.value)} /></label>
          <label className="field"><span>Category</span><select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>{[['GEN', 'General'], ['OBC', 'OBC (non-creamy layer)'], ['SC', 'SC'], ['ST', 'ST'], ['EWS', 'EWS']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Navy connection</span><select className="input" value={f.navyRelation} onChange={(e) => set('navyRelation', e.target.value)}>{[['NONE', 'None'], ['NAVY_SERVING', 'Serving in the Navy'], ['NAVY_RETIRED', 'Retired from the Navy'], ['NAVY_SPOUSE', 'Spouse of Navy personnel'], ['NAVY_WARD', 'Ward of Navy personnel'], ['DEF_CIVILIAN', 'Defence civilian']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Address</span><input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
          <label className="field"><span>City</span><input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} /></label>
          <label className="field"><span>State</span><input className="input" value={f.state} onChange={(e) => set('state', e.target.value)} /></label>
          <label className="field"><span>PIN code</span><input className="input" inputMode="numeric" maxLength={6} value={f.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Aadhaar {d.aadhaar_last4 ? `(ends ${d.aadhaar_last4})` : '(optional)'}</span><input className="input" inputMode="numeric" maxLength={14} value={f.aadhaar} onChange={(e) => set('aadhaar', e.target.value)} placeholder={d.aadhaar_last4 ? 'Leave blank to keep' : '12 digits'} /></label>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}><label className="check small"><input type="checkbox" checked={f.pwd} onChange={(e) => set('pwd', e.target.checked)} />Person with disability (40% or more)</label>
          <label className="check small"><input type="checkbox" checked={f.exServiceman} onChange={(e) => set('exServiceman', e.target.checked)} />Ex-serviceman</label></div>
        <button className="btn" disabled={busy} onClick={async () => { const { aadhaar, pincode, ...rest } = f; if (await run(() => api('/candidate/profile', { method: 'PUT', body: { ...rest, ...(pincode ? { pincode } : {}), ...(aadhaar ? { aadhaar } : {}) } }), 'Saved')) p.reload(); }}>Save</button>
      </section>
      <section className="tile stack"><h3>Education</h3>
        {q.education.map((e: any, i: number) => <div key={i} className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
          <label className="field"><span>Level</span><select className="input" value={e.level} onChange={(x) => rows('education', i, { level: x.target.value })}>{LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Degree or board</span><input className="input" value={e.degree} onChange={(x) => rows('education', i, { degree: x.target.value })} placeholder="M.Sc. Mathematics" /></label>
          <label className="field"><span>Subjects</span><input className="input" value={e.subjects} onChange={(x) => rows('education', i, { subjects: x.target.value })} placeholder="Mathematics, Physics" /></label>
          <label className="field"><span>Year</span><input className="input" inputMode="numeric" value={e.year ?? ''} onChange={(x) => rows('education', i, { year: x.target.value ? Number(x.target.value) : null })} /></label>
          <label className="field"><span>Percentage</span><input className="input" inputMode="decimal" value={e.percentage ?? ''} onChange={(x) => rows('education', i, { percentage: x.target.value === '' ? null : Number(x.target.value) })} /></label>
          <label className="field"><span>Result</span><select className="input" value={e.status ?? 'PASSED'} onChange={(x) => rows('education', i, { status: x.target.value })}><option value="PASSED">Passed</option><option value="APPEARING">Appearing</option></select></label>
          <button className="linkbtn small" onClick={() => setQ({ ...q, education: q.education.filter((_: unknown, j: number) => j !== i) })}>Remove</button></div>)}
        <button className="btn quiet small" onClick={() => setQ({ ...q, education: [...q.education, { level: 'GRADUATION', degree: '', subjects: '', year: null, percentage: null, status: 'PASSED' }] })}>Add a qualification</button>
        <h3 style={{ marginTop: 10 }}>Teacher eligibility tests</h3>
        {q.tests.map((t: any, i: number) => <div key={i} className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <label className="field"><span>Test</span><select className="input" value={t.kind} onChange={(x) => rows('tests', i, { kind: x.target.value })}>{['CTET', 'STET', 'TET', 'NET', 'SET', 'OTHER'].map((k) => <option key={k}>{k}</option>)}</select></label>
          <label className="field"><span>Paper</span><input className="input" value={t.paper ?? ''} onChange={(x) => rows('tests', i, { paper: x.target.value })} placeholder="I or II" /></label>
          <label className="field"><span>Year</span><input className="input" inputMode="numeric" value={t.year ?? ''} onChange={(x) => rows('tests', i, { year: x.target.value ? Number(x.target.value) : null })} /></label>
          <label className="field"><span>Score</span><input className="input" inputMode="decimal" value={t.score ?? ''} onChange={(x) => rows('tests', i, { score: x.target.value === '' ? null : Number(x.target.value) })} /></label>
          <button className="linkbtn small" onClick={() => setQ({ ...q, tests: q.tests.filter((_: unknown, j: number) => j !== i) })}>Remove</button></div>)}
        <button className="btn quiet small" onClick={() => setQ({ ...q, tests: [...q.tests, { kind: 'CTET', paper: 'II', year: null, score: null, qualified: true }] })}>Add a test</button>
        <h3 style={{ marginTop: 10 }}>Experience</h3>
        {q.experience.map((x: any, i: number) => <div key={i} className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <label className="field"><span>School or organisation</span><input className="input" value={x.organisation} onChange={(e) => rows('experience', i, { organisation: e.target.value })} /></label>
          <label className="field"><span>Post</span><input className="input" value={x.post} onChange={(e) => rows('experience', i, { post: e.target.value })} /></label>
          <label className="field"><span>From</span><input className="input" type="date" value={x.fromDate} onChange={(e) => rows('experience', i, { fromDate: e.target.value })} /></label>
          <label className="field"><span>To (blank if now)</span><input className="input" type="date" value={x.toDate} onChange={(e) => rows('experience', i, { toDate: e.target.value })} /></label>
          <label className="check small"><input type="checkbox" checked={x.teaching} onChange={(e) => rows('experience', i, { teaching: e.target.checked })} />Teaching</label>
          <button className="linkbtn small" onClick={() => setQ({ ...q, experience: q.experience.filter((_: unknown, j: number) => j !== i) })}>Remove</button></div>)}
        <button className="btn quiet small" onClick={() => setQ({ ...q, experience: [...q.experience, { organisation: '', post: '', fromDate: '', toDate: '', teaching: true, cbse: false }] })}>Add experience</button>
        <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api('/candidate/qualifications', { method: 'PUT', body: {
          education: q.education.map((e: any) => ({ level: e.level, degree: e.degree, subjects: String(e.subjects).split(',').map((s) => s.trim()).filter(Boolean), institution: e.institution ?? undefined, year: e.year ?? undefined, percentage: e.percentage, status: e.status ?? 'PASSED' })),
          tests: q.tests.map((t: any) => ({ kind: t.kind, paper: t.paper, year: t.year ?? undefined, score: t.score, qualified: t.qualified ?? true, validUntil: t.valid_until ?? null })),
          experience: q.experience.filter((x: any) => x.organisation && x.fromDate).map((x: any) => ({ organisation: x.organisation, post: x.post, subject: x.subject || undefined, fromDate: x.fromDate, toDate: x.toDate || null, teaching: x.teaching, cbse: x.cbse })) } }), 'Saved')) p.reload(); }}>Save qualifications</button>
      </section>
      <section className="tile"><h3>Documents</h3><p className="tiny muted">JPG, PNG or PDF, up to 2 MB each. Everything marked required must be uploaded before you can apply. Add your qualifications above first: each one asks for its own certificate here.</p>
        {docRows.map((r) => {
          const have = d.documents.filter((x: any) => x.kind === r.kind && (!r.ref || x.ref_key === r.ref));
          return <div key={`${r.kind}-${r.ref ?? ''}`} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{r.label}</b> {r.required && <span className={`pill ${have.length ? 'green' : 'orange'}`}>{have.length ? 'Uploaded' : 'Required'}</span>}
            <span className="tiny muted" style={{ display: 'block' }}>{have.length ? have.map((x: any) => x.name).join(', ') : r.help}</span></span>
            <label className="btn quiet small">{have.length && !['EXPERIENCE'].includes(r.kind) ? 'Replace' : 'Upload'}<input type="file" accept={r.image ? 'image/jpeg,image/png' : 'image/jpeg,image/png,application/pdf'} hidden onChange={(e) => { upload(r.kind, e.target.files?.[0], r.ref); e.target.value = ''; }} /></label></div>;
        })}</section>
    </main>
  );
}
