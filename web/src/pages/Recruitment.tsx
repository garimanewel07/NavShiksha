import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { allowed, api, apiFile, day, money, num, readBase64, readText, saveFile, time, today, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, ask, tell, askText } from '../ui';
import { useSchool } from './Payroll';

/**
 * Recruitment for a school (the principal and the recruitment in-charge), and the Common Written
 * Test for NES, setter schools and centres. A vacancy starts from a vacant sanctioned post with the
 * NES eligibility for that post; applications are filtered and sorted on the server, and any step
 * can be taken for one candidate or for everyone the filter matches, with email and SMS to each.
 */

const STAGE: Record<string, [string, string]> = {
  FEE_DUE: ['Fee due', 'orange'], SUBMITTED: ['New', 'blue'], SHORTLISTED: ['Shortlisted', 'blue'], CWT: ['Written test', 'blue'], INTERVIEW: ['Interview', 'blue'], SELECTED: ['Selected', 'green'],
  WAITLISTED: ['Waiting list', 'orange'], REJECTED: ['Not taken forward', ''], NOT_SELECTED: ['Not selected', ''], WITHDRAWN: ['Withdrawn', ''], APPOINTED: ['Appointed', 'green'],
};
const Stage = ({ s }: { s: string }) => { const [l, t] = STAGE[s] ?? [words(s), '']; return <span className={`pill ${t}`}>{l}</span>; };
const V_STATUS: Record<string, string> = { DRAFT: 'orange', PUBLISHED: 'green', CLOSED: '', CANCELLED: 'red', FILLED: 'blue' };
const ACTIONS: [string, string][] = [['SHORTLISTED', 'Shortlist'], ['CWT', 'Call for the written test'], ['INTERVIEW', 'Call for interview (no slot)'], ['WAITLISTED', 'Put on the waiting list'], ['SELECTED', 'Select (principal)'], ['NOT_SELECTED', 'Not selected'], ['REJECTED', 'Not taken forward']];
const SORTS: [string, string][] = [['merit', 'Merit'], ['qual', 'Qualifying %'], ['test', 'CTET/TET score'], ['experience', 'Experience'], ['cwt', 'Written test'], ['interview', 'Interview'], ['age', 'Age (youngest first)'], ['applied', 'First applied'], ['name', 'Name']];
const EMPLOYMENT: [string, string][] = [['PERMANENT', 'Permanent'], ['CONTRACT', 'Contract'], ['TEMPORARY', 'Temporary'], ['PART_TIME', 'Part-time'], ['GUEST', 'Guest'], ['DAILY_WAGE', 'Daily wage']];
const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : String(p / 100));

export function Recruitment({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/vacancies` : null, [schoolId]);
  const [add, setAdd] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Recruitment</span><span className="spacer" style={{ flex: 1 }} />{picker}{allowed(user, 'recruitment.manage', schoolId) && <button className="btn small" onClick={() => setAdd(true)}>New vacancy</button>}</div></div>
      <main className="page">
        <section className="tile"><h2>Vacancies</h2>
          <p className="muted" style={{ marginTop: 6 }}>Published vacancies appear on NavShiksha Careers for every candidate. Candidates register once and apply only if their profile meets the eligibility; each stage is sent to them by email and SMS.</p>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No vacancies yet.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Vacancy</th><th>Dates</th><th className="num">Applications</th><th>Stages</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((v) => <tr key={v.id} className="click" onClick={() => nav(`/recruitment/${v.id}`)}>
              <td><b>{v.title}</b><span className="tiny muted" style={{ display: 'block' }}>{v.code} · {words(v.employment)} · {v.positions} {v.positions === 1 ? 'post' : 'posts'}{v.cwt ? ' · written test' : ''}</span></td>
              <td className="small">{day(v.opens_on)} – {day(v.closes_on)}</td><td className="num">{num(v.applications)}</td>
              <td className="tiny">{Object.entries(v.counts ?? {}).map(([k, n]) => `${STAGE[k]?.[0] ?? k} ${n}`).join(' · ')}</td><td><span className={`pill ${V_STATUS[v.status] ?? ''}`}>{words(v.status)}</span></td></tr>)}</tbody></table></div>}
        </section>
      </main>
      {add && <VacancyDrawer schoolId={schoolId} user={user} onClose={(id) => { setAdd(false); list.reload(); if (id) nav(`/recruitment/${id}`); }} />}
    </>
  );
}

function VacancyDrawer({ schoolId, onClose }: { schoolId: string; user: User; onClose: (id?: string) => void }) {
  const posts = useLoad<any[]>(`/schools/${schoolId}/posts`, [schoolId]);
  const vacant = (posts.data ?? []).filter((p) => !p.holder);
  const [f, setF] = useState<any>({ postId: '', postType: 'TGT', subjectCode: '', employment: 'CONTRACT', positions: 1, opensOn: today(), closesOn: '', cwt: false, payText: '', description: '',
    fees: { GEN: 500, OBC: 500, EWS: 500, SC: 0, ST: 0, PWD: 0, ESM: 0, WOMEN: '' } as Record<string, any>, free: false, questions: [] as any[] });
  const tpl = useLoad<any>(`/recruitment/template?postType=${f.postType}${f.subjectCode ? `&subject=${f.subjectCode}` : ''}`, [f.postType, f.subjectCode]);
  const [rules, setRules] = useState<any>(null);
  useEffect(() => { if (tpl.data) setRules(tpl.data); }, [tpl.data]);
  const { run, busy } = useAction();
  const pick = (id: string) => { const p = vacant.find((x) => x.id === id); setF({ ...f, postId: id, ...(p ? { postType: p.post_type, subjectCode: p.subject_code ?? '', payText: p.pay_level ? `Pay level ${p.pay_level}` : f.payText } : {}) }); };
  return (
    <Drawer title="New vacancy" onClose={() => onClose()}>
      <section className="tile tight stack">
        <label className="field"><span>Against a vacant sanctioned post</span><select className="input" value={f.postId} onChange={(e) => pick(e.target.value)}>
          <option value="">Not against a sanctioned post</option>{vacant.map((p) => <option key={p.id} value={p.id}>{p.post}{p.subject ? ` · ${p.subject}` : ''}{p.pay_level ? ` · level ${p.pay_level}` : ''}</option>)}</select>
          <span className="tiny muted">The post type, subject and pay level come from the post; the selected candidate is appointed to it.</span></label>
        <div className="form-grid">
          {!f.postId && <><label className="field"><span>Post</span><select className="input" value={f.postType} onChange={(e) => setF({ ...f, postType: e.target.value })}>{['PGT', 'TGT', 'PRT', 'BALVATIKA', 'SPECIAL_EDUCATOR', 'COUNSELLOR', 'LIBRARIAN', 'PTI', 'VICE_PRINCIPAL', 'PRINCIPAL', 'OFFICE_SUPDT', 'ACCOUNTANT', 'CLERK', 'LAB_ATTENDANT', 'NURSE', 'SUPPORT'].map((k) => <option key={k} value={k}>{words(k)}</option>)}</select></label>
            <label className="field"><span>Subject code</span><input className="input mono" value={f.subjectCode} maxLength={4} onChange={(e) => setF({ ...f, subjectCode: e.target.value.toUpperCase() })} placeholder="MAT" /></label></>}
          <label className="field"><span>Employment</span><select className="input" value={f.employment} onChange={(e) => setF({ ...f, employment: e.target.value })}>{EMPLOYMENT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Number of posts</span><input className="input" type="number" min={1} value={f.positions} onChange={(e) => setF({ ...f, positions: Number(e.target.value) })} /></label>
          <label className="field"><span>Opens</span><input className="input" type="date" value={f.opensOn} onChange={(e) => setF({ ...f, opensOn: e.target.value })} /></label>
          <label className="field"><span>Closes (age reckoned on this date)</span><input className="input" type="date" value={f.closesOn} onChange={(e) => setF({ ...f, closesOn: e.target.value })} /></label>
          <label className="field"><span>Pay</span><input className="input" value={f.payText} onChange={(e) => setF({ ...f, payText: e.target.value })} placeholder="Consolidated ₹45,000 a month" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.cwt} onChange={(e) => setF({ ...f, cwt: e.target.checked })} />Selection includes the Common Written Test (NES sets the paper; weights 60 written, 30 interview, 10 academic)</label>
        <label className="field"><span>About the post</span><textarea className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        {rules && <div className="callout small"><b>Eligibility (NES norms for this post)</b>
          {(rules.education ?? []).map((r: any, i: number) => <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}><span style={{ flex: 1 }}>{r.label}</span>
            {r.minPct !== undefined && <label className="tiny">min % <input className="input" style={{ width: 70, height: 30 }} type="number" value={r.minPct} onChange={(e) => setRules({ ...rules, education: rules.education.map((x: any, j: number) => (j === i ? { ...x, minPct: Number(e.target.value) } : x)) })} /></label>}</div>)}
          {rules.tests && <div style={{ marginTop: 6 }}>{rules.tests.map((t: any) => `${t.kind}${t.paper ? ` Paper ${t.paper}` : ''}`).join(' or ')} <button className="linkbtn tiny" onClick={() => setRules({ ...rules, tests: undefined })}>not required</button></div>}
          {rules.age && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}><span style={{ flex: 1 }}>Upper age limit (relaxed by 3 years for OBC, 5 for SC/ST, 10 for PwD, 5 for ex-servicemen)</span>
            <input className="input" style={{ width: 70, height: 30 }} type="number" value={rules.age.max ?? ''} onChange={(e) => setRules({ ...rules, age: { ...rules.age, max: e.target.value ? Number(e.target.value) : undefined } })} /></div>}</div>}
        <div className="field"><span>Registration fee for applicants</span>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            <button type="button" className={!f.free ? 'on' : ''} onClick={() => setF({ ...f, free: false })}>Charge a fee</button>
            <button type="button" className={f.free ? 'on' : ''} onClick={() => setF({ ...f, free: true })}>Free</button></div>
          {f.free ? <span className="tiny muted">Candidates apply without paying anything.</span> : <>
            <span className="tiny muted">By category, in rupees; 0 means free for that category. Paid online to the school’s account; the receipt goes to the candidate.</span>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>{Object.keys(f.fees).map((k) => <label key={k} className="tiny">{k === 'GEN' ? 'General' : k === 'PWD' ? 'PwD' : k === 'ESM' ? 'Ex-serv.' : k === 'WOMEN' ? 'Women' : k}
              <input className="input" type="number" min={0} value={f.fees[k]} placeholder={k === 'WOMEN' ? 'same' : ''} onChange={(e) => setF({ ...f, fees: { ...f.fees, [k]: e.target.value } })} /></label>)}</div></>}</div>
        <div className="field"><span>Questions for applicants (optional)</span>
          {f.questions.map((q: any, i: number) => <div key={i} style={{ display: 'flex', gap: 6, marginTop: 6 }}><input className="input" value={q.label} onChange={(e) => setF({ ...f, questions: f.questions.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <select className="input" style={{ width: 120 }} value={q.type} onChange={(e) => setF({ ...f, questions: f.questions.map((x: any, j: number) => (j === i ? { ...x, type: e.target.value } : x)) })}><option value="YESNO">Yes / no</option><option value="TEXT">Text</option></select></div>)}
          <button className="linkbtn small" onClick={() => setF({ ...f, questions: [...f.questions, { id: `q${f.questions.length + 1}`, label: '', type: 'YESNO', required: true }] })}>Add a question</button></div>
        <button className="btn big" disabled={busy || !f.closesOn || f.closesOn < f.opensOn} onClick={async () => {
          const fees = f.free ? Object.fromEntries(Object.keys(f.fees).filter((k) => k !== 'WOMEN').map((k) => [k, 0])) : Object.fromEntries(Object.entries(f.fees).map(([k, v]) => [k, v === '' ? null : Math.round(Number(v) * 100)]));
          const r: any = await run(() => api(`/schools/${schoolId}/vacancies`, { body: { postId: f.postId || null, postType: f.postType, subjectCode: f.subjectCode || null, employment: f.employment, positions: f.positions, payText: f.payText, description: f.description,
            opensOn: f.opensOn, closesOn: f.closesOn, cwt: f.cwt, fees, eligibility: rules ?? undefined, questions: f.questions.filter((q: any) => q.label.trim()) } }), 'Saved as a draft; the principal publishes it');
          if (r) onClose(r.id);
        }}>Save draft</button>
      </section>
    </Drawer>
  );
}

const EMPTY_FILTER = { status: [] as string[], category: [] as string[], gender: '', minQualPct: '', minTestScore: '', minExperienceMonths: '', maxAge: '', city: '', search: '', tag: '', minCwtMarks: '', pwd: false, exServiceman: false, navy: false };
const toFilter = (f: typeof EMPTY_FILTER) => {
  const n = (v: string) => (v === '' ? undefined : Number(v));
  return { status: f.status.length ? f.status : undefined, category: f.category.length ? f.category : undefined, gender: f.gender || undefined, minQualPct: n(f.minQualPct), minTestScore: n(f.minTestScore),
    minExperienceMonths: f.minExperienceMonths === '' ? undefined : Number(f.minExperienceMonths) * 12, maxAge: n(f.maxAge), city: f.city || undefined, search: f.search || undefined, tag: f.tag || undefined,
    minCwtMarks: n(f.minCwtMarks), pwd: f.pwd || undefined, exServiceman: f.exServiceman || undefined, navyRelation: f.navy ? ['NAVY_SERVING', 'NAVY_RETIRED', 'NAVY_SPOUSE', 'NAVY_WARD'] : undefined };
};

export function VacancyConsole({ user }: { user: User }) {
  const { id } = useParams();
  const [f, setF] = useState(EMPTY_FILTER);
  const [applied, setApplied] = useState(EMPTY_FILTER);
  const [sort, setSort] = useState('merit');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const stats = useLoad<any>(`/vacancies/${id}/stats`, [id, tick]);
  const cycles = useLoad<any[]>('/cwt/cycles');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState('SHORTLISTED');
  const { run, busy } = useAction();
  const filter = toFilter(applied);
  useEffect(() => { api(`/vacancies/${id}/applications`, { body: { filter, sort, page, size: 50 } }).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)); }, [id, JSON.stringify(applied), sort, page, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = sel.size ? { ids: [...sel] } : filter;
  const count = sel.size || data?.total || 0;
  const reload = () => { setSel(new Set()); setTick((t) => t + 1); };
  const v = data?.vacancy;
  // NES and the Command follow recruitment; the school's recruitment desk runs it, and only the principal selects.
  const manage = !!v && allowed(user, 'recruitment.manage', v.schoolId);
  const toggle = (k: 'status' | 'category', x: string) => setF({ ...f, [k]: f[k].includes(x) ? f[k].filter((y) => y !== x) : [...f[k], x] });
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/recruitment" className="small">← Vacancies</Link><span className="localnav-title" style={{ marginLeft: 10 }}>{v?.title ?? 'Vacancy'}</span><span className="spacer" style={{ flex: 1 }} />
        <VacancyActions id={id!} user={user} cycles={cycles.data ?? []} onDone={reload} /></div></div>
      <main className="page">
        {stats.data && <section className="tile tight"><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{Object.entries(STAGE).filter(([k]) => stats.data.status[k]).map(([k, [l, t]]) =>
          <button key={k} className={`pill ${t}`} style={{ border: 0, cursor: 'pointer', outline: applied.status.includes(k) ? '2px solid var(--blue)' : undefined }} onClick={() => { const nf = { ...EMPTY_FILTER, status: [k] }; setF(nf); setApplied(nf); setPage(1); }}>{l} {num(stats.data.status[k])}</button>)}
          <span className="tiny muted" style={{ marginLeft: 'auto' }}>{Object.entries(stats.data.category).map(([k, n]) => `${k} ${num(n as number)}`).join(' · ')}</span></div></section>}
        <section className="tile">
          <h3>Filter</h3>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginTop: 6 }}>
            <label className="field"><span>Name, number, email, mobile</span><input className="input" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} /></label>
            <label className="field"><span>Qualifying % at least</span><input className="input" type="number" value={f.minQualPct} onChange={(e) => setF({ ...f, minQualPct: e.target.value })} /></label>
            <label className="field"><span>CTET/TET score at least</span><input className="input" type="number" value={f.minTestScore} onChange={(e) => setF({ ...f, minTestScore: e.target.value })} /></label>
            <label className="field"><span>Experience (years) at least</span><input className="input" type="number" value={f.minExperienceMonths} onChange={(e) => setF({ ...f, minExperienceMonths: e.target.value })} /></label>
            <label className="field"><span>Age at most</span><input className="input" type="number" value={f.maxAge} onChange={(e) => setF({ ...f, maxAge: e.target.value })} /></label>
            {v?.cwt && <label className="field"><span>Written test at least (of 100)</span><input className="input" type="number" value={f.minCwtMarks} onChange={(e) => setF({ ...f, minCwtMarks: e.target.value })} /></label>}
            <label className="field"><span>City</span><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
            <label className="field"><span>Gender</span><select className="input" value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">Any</option><option value="F">Women</option><option value="M">Men</option></select></label>
            <label className="field"><span>Tag</span><input className="input" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></label>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <span className="tiny muted">Stage</span>{Object.entries(STAGE).filter(([k]) => k !== 'FEE_DUE').map(([k, [l]]) => <label key={k} className="check tiny"><input type="checkbox" checked={f.status.includes(k)} onChange={() => toggle('status', k)} />{l}</label>)}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            <span className="tiny muted">Category</span>{['GEN', 'OBC', 'SC', 'ST', 'EWS'].map((k) => <label key={k} className="check tiny"><input type="checkbox" checked={f.category.includes(k)} onChange={() => toggle('category', k)} />{k}</label>)}
            <label className="check tiny"><input type="checkbox" checked={f.pwd} onChange={(e) => setF({ ...f, pwd: e.target.checked })} />PwD</label>
            <label className="check tiny"><input type="checkbox" checked={f.exServiceman} onChange={(e) => setF({ ...f, exServiceman: e.target.checked })} />Ex-servicemen</label>
            <label className="check tiny"><input type="checkbox" checked={f.navy} onChange={(e) => setF({ ...f, navy: e.target.checked })} />Navy connection</label>
            <span style={{ flex: 1 }} /><button className="btn quiet small" onClick={() => { setF(EMPTY_FILTER); setApplied(EMPTY_FILTER); setPage(1); }}>Clear</button><button className="btn small" onClick={() => { setApplied(f); setPage(1); setSel(new Set()); }}>Apply filter</button>
          </div>
        </section>
        <section className="tile">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b>{num(data?.total ?? 0)} applications</b>{sel.size > 0 && <span className="pill blue">{sel.size} chosen <button className="linkbtn tiny" onClick={() => setSel(new Set())}>clear</button></span>}
            <span style={{ flex: 1 }} />
            <label className="tiny">Sort <select className="input" style={{ height: 32, width: 170 }} value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <button className="btn quiet small" onClick={() => run(() => saveFile(`/vacancies/${id}/export`, `${v?.code ?? 'applications'}.csv`.replace(/\//g, '-'), { filter, sort }))}>Spreadsheet</button>
          </div>
          {manage && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }} className="callout">
            <span className="small">For {sel.size ? `the ${sel.size} chosen` : `all ${num(count)} matching`}:</span>
            <select className="input" style={{ height: 34, width: 230 }} value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.filter(([k]) => (k !== 'CWT' || v?.cwt) && (user.role === 'SCHOOL_ADMIN' || !['SELECTED', 'NOT_SELECTED'].includes(k))).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <button className="btn small" disabled={busy || !count} onClick={async () => { if (!await ask(`${ACTIONS.find((a) => a[0] === action)?.[1]}: ${num(count)} candidates. Each is told by email and SMS. Go ahead?`)) return; const r: any = await run(() => api(`/vacancies/${id}/bulk`, { body: { filter: target, action } })); if (r) { await tell(`${num(r.changed)} moved${r.messaged ? `, ${num(r.messaged)} emails and SMS queued` : ''}${r.skipped ? `; ${num(r.skipped)} were not at a stage this applies to` : ''}.`); reload(); } }}>Go</button>
            <button className="btn quiet small" disabled={!count} onClick={() => setDrawer('message')}>Email / SMS</button>
            <button className="btn quiet small" disabled={!count} onClick={() => setDrawer('interview')}>Schedule interview</button>
            <button className="btn quiet small" disabled={!count} onClick={async () => { const tag = await askText('Tag (e.g. "doc check", "local")'); if (tag && await run(() => api(`/vacancies/${id}/bulk`, { body: { filter: target, action: 'TAG', tag } }), 'Tagged')) reload(); }}>Tag</button>
          </div>}
          {err ? <Empty>{err}</Empty> : !data ? <Empty>Loading…</Empty> : !data.rows.length ? <Empty>No applications match.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th><input type="checkbox" aria-label="Choose all on this page" checked={data.rows.every((r: any) => sel.has(r.id))} onChange={(e) => { const s = new Set(sel); data.rows.forEach((r: any) => (e.target.checked ? s.add(r.id) : s.delete(r.id))); setSel(s); }} /></th>
              <th>Candidate</th><th className="num">Qual %</th><th className="num">CTET</th><th className="num">Exp.</th><th className="num">Age</th>{v?.cwt && <th className="num">CWT</th>}<th className="num">Interview</th><th className="num">Merit</th><th>Stage</th></tr></thead>
            <tbody>{data.rows.map((r: any) => <tr key={r.id}><td><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(r.id) : s.delete(r.id); setSel(s); }} aria-label={`Choose ${r.name}`} /></td>
              <td><button className="linkbtn" onClick={() => setOpen(r.id)}><b>{r.name}</b></button><span className="tiny muted" style={{ display: 'block' }}>{r.number} · {r.category}{r.pwd ? ' · PwD' : ''}{r.ex_serviceman ? ' · ESM' : ''}{r.navy_relation !== 'NONE' ? ' · Navy' : ''} · {r.city ?? '—'}{r.tags?.length ? ` · ${r.tags.join(', ')}` : ''}</span></td>
              <td className="num">{r.qual_pct ?? '—'}</td><td className="num">{r.test_score ?? '—'}</td><td className="num">{r.experience_months ? `${Math.floor(r.experience_months / 12)}y ${r.experience_months % 12}m` : '—'}</td><td className="num">{r.age_years}</td>
              {v?.cwt && <td className="num">{r.cwt_marks ?? '—'}</td>}<td className="num">{r.interview_marks ?? '—'}</td><td className="num"><b>{r.merit ?? '—'}</b></td><td><Stage s={r.status} /></td></tr>)}</tbody></table></div>}
          {data && data.total > data.size && <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10, alignItems: 'center' }}>
            <button className="btn quiet small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span className="small">Page {page} of {Math.ceil(data.total / data.size)}</span>
            <button className="btn quiet small" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>Next</button></div>}
        </section>
      </main>
      {drawer === 'message' && <MessageDrawer id={id!} target={target} count={count} onClose={() => setDrawer(null)} />}
      {drawer === 'interview' && <InterviewDrawer id={id!} target={target} count={count} onClose={() => { setDrawer(null); reload(); }} />}
      {open && <ApplicationDrawer id={open} user={user} onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function VacancyActions({ id, user, cycles, onDone }: { id: string; user: User; cycles: any[]; onDone: () => void }) {
  const { run, busy } = useAction();
  const [v, setV] = useState<any>(null);
  useEffect(() => { api(`/vacancies/${id}/applications`, { body: { filter: {}, size: 10 } }).then((d) => setV(d.vacancy)).catch(() => null); }, [id]);
  if (!v || !allowed(user, 'recruitment.manage', v.schoolId)) return null;
  const open = cycles.filter((c) => c.status === 'OPEN');
  return <span style={{ display: 'flex', gap: 6 }}>
    {v.status === 'DRAFT' && user.role === 'SCHOOL_ADMIN' && <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/vacancies/${id}/publish`, { body: {} }), 'Published on NavShiksha Careers')) { setV({ ...v, status: 'PUBLISHED' }); onDone(); } }}>Publish</button>}
    {v.cwt && !v.sentToCwt && open.length > 0 && <button className="btn quiet small" disabled={busy} onClick={async () => { const which = open.length === 1 ? null : await askText(`Which test? ${open.map((x) => x.code).join(', ')}`); const c = open.length === 1 ? open[0] : open.find((x) => x.code === which?.toUpperCase()); if (c && await run(() => api(`/vacancies/${id}/cwt`, { body: { cycleId: c.id } }), `Requirement sent to NES for ${c.code}`)) onDone(); }}>Send to NES for the CWT</button>}
    {v.status === 'PUBLISHED' && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await ask('Close applications now?') && await run(() => api(`/vacancies/${id}/status`, { body: { status: 'CLOSED' } }), 'Closed')) { setV({ ...v, status: 'CLOSED' }); onDone(); } }}>Close</button>}
  </span>;
}

function MessageDrawer({ id, target, count, onClose }: { id: string; target: unknown; count: number; onClose: () => void }) {
  const [f, setF] = useState({ subject: '', message: '', email: true, sms: true });
  const { run, busy } = useAction();
  return <Drawer title={`Message ${num(count)} candidates`} onClose={onClose}><section className="tile tight stack">
    <p className="small muted">Each gets it addressed to them by name, from the school. SMS go through the registered NES sender with the approved notice template.</p>
    <label className="field"><span>Subject (email)</span><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="Document verification on Monday" /></label>
    <label className="field"><span>Message</span><textarea className="input" rows={5} maxLength={2000} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /><span className="tiny muted">SMS carry the first 400 characters.</span></label>
    <div style={{ display: 'flex', gap: 14 }}><label className="check small"><input type="checkbox" checked={f.email} onChange={(e) => setF({ ...f, email: e.target.checked })} />Email</label><label className="check small"><input type="checkbox" checked={f.sms} onChange={(e) => setF({ ...f, sms: e.target.checked })} />SMS</label></div>
    <button className="btn big" disabled={busy || f.subject.trim().length < 3 || f.message.trim().length < 5 || (!f.email && !f.sms)} onClick={async () => {
      const r: any = await run(() => api(`/vacancies/${id}/message`, { body: { filter: target, subject: f.subject, message: f.message, channels: [...(f.email ? ['EMAIL'] : []), ...(f.sms ? ['SMS'] : [])] } }));
      if (r) { await tell(`${num(r.messages)} messages queued to ${num(r.candidates)} candidates.`); onClose(); }
    }}>Send</button></section></Drawer>;
}

function InterviewDrawer({ id, target, count, onClose }: { id: string; target: unknown; count: number; onClose: () => void }) {
  const [f, setF] = useState({ kind: 'INTERVIEW', title: 'Interview', date: '', start: '09:30', slotMinutes: 20, perSlot: 1, venue: '', bring: 'Original certificates, a photo ID and two photographs' });
  const { run, busy } = useAction();
  return <Drawer title={`Schedule for ${num(count)} candidates`} onClose={onClose}><section className="tile tight stack">
    <p className="small muted">Slots are given in merit order. Each candidate gets the date, time and venue by email and SMS and can confirm in their account.</p>
    <div className="form-grid">
      <label className="field"><span>What</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, title: e.target.value === 'DEMO' ? 'Demonstration class' : e.target.value === 'DOCUMENTS' ? 'Document verification' : 'Interview' })}><option value="INTERVIEW">Interview</option><option value="DEMO">Demonstration class</option><option value="DOCUMENTS">Document verification</option></select></label>
      <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>Date</span><input className="input" type="date" min={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      <label className="field"><span>First slot</span><input className="input" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
      <label className="field"><span>Minutes per slot</span><input className="input" type="number" value={f.slotMinutes} onChange={(e) => setF({ ...f, slotMinutes: Number(e.target.value) })} /></label>
      <label className="field"><span>Candidates per slot</span><input className="input" type="number" min={1} value={f.perSlot} onChange={(e) => setF({ ...f, perSlot: Number(e.target.value) })} /></label>
    </div>
    <label className="field"><span>Venue</span><input className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} placeholder="NCS Mumbai, Conference room, Colaba" /></label>
    <label className="field"><span>Bring</span><input className="input" value={f.bring} onChange={(e) => setF({ ...f, bring: e.target.value })} /></label>
    <button className="btn big" disabled={busy || !f.date || f.venue.trim().length < 3} onClick={async () => { const r: any = await run(() => api(`/vacancies/${id}/rounds`, { body: { ...f, filter: target } })); if (r) { await tell(`${num(r.invited)} candidates invited.`); onClose(); } }}>Send invitations</button>
  </section></Drawer>;
}

function ApplicationDrawer({ id, user, onClose }: { id: string; user: User; onClose: () => void }) {
  const a = useLoad<any>(`/job-applications/${id}`, [id]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [join, setJoin] = useState({ joinedService: today(), orderRef: '' });
  const { run, busy } = useAction();
  const x = a.data, p = x?.snapshot;
  const openDoc = async (docId: string) => { const { blob } = await apiFile(`/job-applications/documents/${docId}`); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  return <Drawer title={p ? `${p.name} · ${x.number}` : 'Application'} onClose={onClose}>{!x ? <Empty>{a.error ?? 'Loading…'}</Empty> : <>
    <section className="tile tight"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Stage s={x.status} /><span className="tiny muted">applied {time(x.created_at)} · declaration accepted {time(x.declared_at)}{x.fee_status === 'PAID' ? ` · fee ${money(x.fee_paise)} receipt ${x.receipt_no}` : ''}</span></div>
      <div className="form-grid" style={{ marginTop: 10 }}>{[['Candidate no.', p.candidate_no], ['Date of birth', day(p.dob)], ['Gender', p.gender === 'F' ? 'Woman' : p.gender === 'M' ? 'Man' : 'Another'], ['Category', `${p.category}${p.pwd ? ', PwD' : ''}${p.ex_serviceman ? ', ex-serviceman' : ''}`],
        ['Father', p.father_name ?? '—'], ['Mobile', p.mobile], ['Email', p.email], ['Address', [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ') || '—'], ['Navy connection', words(p.navy_relation)]].map(([k, val]) => <div key={k}><span className="tiny muted">{k}</span><div className="small">{val}</div></div>)}</div></section>
    <section className="tile tight"><h3>Eligibility at the time of applying</h3>{x.eligibility.map((c: any) => <div key={c.label} className="small" style={{ marginTop: 4 }}><span style={{ color: c.ok ? 'var(--green)' : 'var(--red)' }}>{c.ok ? '✓' : '✗'}</span> {c.label} <span className="tiny muted">· {c.detail}</span></div>)}</section>
    <section className="tile tight"><h3>Education, tests, experience</h3>
      {p.education.map((e: any, i: number) => <div key={i} className="small" style={{ marginTop: 4 }}><b>{e.degree}</b> <span className="muted">{e.year ?? ''}{e.percentage !== null ? ` · ${e.percentage}%` : ''}{e.subjects?.length ? ` · ${e.subjects.join(', ')}` : ''}{e.status === 'APPEARING' ? ' · appearing' : ''}</span></div>)}
      {p.tests.map((t: any, i: number) => <div key={i} className="small" style={{ marginTop: 4 }}><b>{t.kind} {t.paper}</b> <span className="muted">{t.year ?? ''}{t.score !== null ? ` · score ${t.score}` : ''}</span></div>)}
      {p.experience.map((e: any, i: number) => <div key={i} className="small" style={{ marginTop: 4 }}><b>{e.post}</b>, {e.organisation} <span className="muted">{day(e.from_date)} – {e.to_date ? day(e.to_date) : 'now'}</span></div>)}
      {Object.keys(x.answers ?? {}).length > 0 && <div style={{ marginTop: 8 }}>{Object.entries(x.answers).map(([k, val]) => <div key={k} className="small">{x.vacancy.questions.find((q: any) => q.id === k)?.label ?? k}: <b>{String(val)}</b></div>)}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{p.documents.map((d: any) => <button key={d.id} className="btn quiet small" onClick={() => run(() => openDoc(d.id))}>{words(d.kind)}</button>)}</div></section>
    {x.interviews.length > 0 && <section className="tile tight"><h3>Interviews</h3>{x.interviews.map((s: any) => <div key={s.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{s.title}</b> <span className="tiny muted">{time(s.starts_at)} · {words(s.status)}{s.marks !== null ? ` · ${s.marks}/100` : ''}</span></span>
      {allowed(user, 'recruitment.manage', x.vacancy.school_id) && <span style={{ display: 'flex', gap: 4 }}><input className="input" style={{ width: 70, height: 32 }} type="number" min={0} max={100} placeholder="/100" value={marks[s.id] ?? ''} onChange={(e) => setMarks({ ...marks, [s.id]: e.target.value })} />
        <button className="btn small" disabled={busy || marks[s.id] === undefined || marks[s.id] === ''} onClick={async () => { if (await run(() => api(`/interview-slots/${s.id}/mark`, { body: { status: 'ATTENDED', marks: Number(marks[s.id]) } }), 'Saved; merit updated')) a.reload(); }}>Save</button>
        <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/interview-slots/${s.id}/mark`, { body: { status: 'ABSENT', marks: null } }), 'Marked absent')) a.reload(); }}>Absent</button></span>}</div>)}</section>}
    {x.cwt_roll_no && <section className="tile tight"><h3>Written test</h3><p className="small">Roll {x.cwt_roll_no}{x.cwt_absent ? ' · absent' : x.cwt_marks !== null ? ` · ${x.cwt_raw} marks (${x.cwt_marks}/100)` : ''}</p></section>}
    <section className="tile tight"><h3>History</h3>{x.history.map((h: any, i: number) => <div key={i} className="tiny" style={{ marginTop: 3 }}>{time(h.at)} · {h.from_status ? `${STAGE[h.from_status]?.[0] ?? h.from_status} → ` : ''}{STAGE[h.to_status]?.[0] ?? h.to_status}{h.by ? ` · ${h.by}` : ''}{h.note ? ` · ${h.note}` : ''}</div>)}</section>
    {x.status === 'SELECTED' && user.role === 'SCHOOL_ADMIN' && <section className="tile tight stack"><h3>Appoint</h3>
      <p className="small muted">Makes the staff record from this application (name, mobile, email, date of birth, gender) against the vacancy’s post, as {words(x.vacancy.employment).toLowerCase()} employment. Add pay, bank and classes on the staff profile.</p>
      <div className="form-grid"><label className="field"><span>Joins on</span><input className="input" type="date" value={join.joinedService} onChange={(e) => setJoin({ ...join, joinedService: e.target.value })} /></label>
        <label className="field"><span>Appointment order no.</span><input className="input" value={join.orderRef} onChange={(e) => setJoin({ ...join, orderRef: e.target.value })} /></label></div>
      <button className="btn" disabled={busy || join.orderRef.trim().length < 2} onClick={async () => { const r: any = await run(() => api(`/job-applications/${id}/appoint`, { body: join }), 'Appointed; the staff record is ready'); if (r) a.reload(); }}>Appoint</button></section>}
  </>}</Drawer>;
}

// ── The Common Written Test: NES ──────────────────────────────────────────────────────────

const C_STATUS: Record<string, [string, string]> = { OPEN: ['Taking requirements', 'blue'], PAPERS: ['Papers being set', 'blue'], RELEASED: ['Papers with centres', 'orange'], HELD: ['Held · marking', 'orange'], RESULTS: ['Results in', 'green'], CANCELLED: ['Cancelled', 'red'] };
const CStatus = ({ s }: { s: string }) => { const [l, t] = C_STATUS[s] ?? [s, '']; return <span className={`pill ${t}`}>{l}</span>; };

export function CwtCycles() {
  const list = useLoad<any[]>('/cwt/cycles');
  const [f, setF] = useState({ title: '', examDate: '', startsAt: '10:00', durationMin: 150, requirementsBy: '', papersDue: '' });
  const [add, setAdd] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Common Written Test</span><span className="spacer" style={{ flex: 1 }} /><button className="btn small" onClick={() => setAdd(true)}>New test</button></div></div>
      <main className="page">
        <section className="tile"><h2>The CWT, start to finish</h2>
          <p className="muted" style={{ marginTop: 6 }}>Schools send their vacancies that need a written test. NES asks three or four other schools that have teachers in the post for a paper and answer key, picks the best, gives roll numbers and admit cards, and the day before the test each centre gets its papers in an AES-256 password-protected file, with the password sent to the principal by SMS. Answer keys follow after the test; centres enter marks into merit.</p>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No tests yet.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Test</th><th>Date</th><th>Requirements by</th><th>Papers due</th><th className="num">Schools</th><th className="num">Papers</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((c) => <tr key={c.id} className="click" onClick={() => nav(`/cwt/${c.id}`)}><td><b>{c.title}</b><span className="tiny muted" style={{ display: 'block' }}>{c.code}</span></td><td className="small">{day(c.exam_date)}, {c.starts_at.slice(0, 5)}</td>
              <td className="small">{day(c.requirements_by)}</td><td className="small">{day(c.papers_due)}</td><td className="num">{c.requirements}</td><td className="num">{c.papers}</td><td><CStatus s={c.status} /></td></tr>)}</tbody></table></div>}
        </section>
      </main>
      {add && <Drawer title="New Common Written Test" onClose={() => setAdd(false)}><section className="tile tight stack">
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="CWT for teachers, December 2026" /></label>
        <div className="form-grid">
          <label className="field"><span>Test date</span><input className="input" type="date" value={f.examDate} onChange={(e) => setF({ ...f, examDate: e.target.value })} /></label>
          <label className="field"><span>Starts at</span><input className="input" type="time" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
          <label className="field"><span>Minutes</span><input className="input" type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} /></label>
          <label className="field"><span>Schools send requirements by</span><input className="input" type="date" value={f.requirementsBy} onChange={(e) => setF({ ...f, requirementsBy: e.target.value })} /></label>
          <label className="field"><span>Papers due from setters</span><input className="input" type="date" value={f.papersDue} onChange={(e) => setF({ ...f, papersDue: e.target.value })} /></label>
        </div>
        <p className="tiny muted">Papers go to the centres 24 hours before the start, by themselves.</p>
        <button className="btn big" disabled={busy || f.title.trim().length < 5 || !f.examDate || !f.requirementsBy || !f.papersDue} onClick={async () => { const r: any = await run(() => api('/cwt/cycles', { body: f }), 'Created; schools can now send requirements'); if (r) { setAdd(false); nav(`/cwt/${r.id}`); } }}>Create</button>
      </section></Drawer>}
    </>
  );
}

export function CwtCycle() {
  const { id } = useParams();
  const c = useLoad<any>(`/cwt/cycles/${id}`, [id]);
  const log = useLoad<any[]>(`/cwt/cycles/${id}/downloads`, [id, c.data]);
  const [setters, setSetters] = useState<{ paper: any; list: any[] } | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const { run, busy } = useAction();
  const x = c.data;
  const review = async (r: any, which: 'question' | 'key') => { const { blob } = await apiFile(`/cwt/requests/${r.id}/${which}`); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/cwt" className="small">← Tests</Link><span className="localnav-title" style={{ marginLeft: 10 }}>{x?.code ?? 'CWT'}</span><span className="spacer" style={{ flex: 1 }} />
        {x && !x.released_at && <><button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/cwt/cycles/${id}/request-all`, { body: { per: 3 } })); if (r) { await tell(Object.entries(r).map(([k, n]) => `${k}: ${n} schools asked`).join('\n') || 'Every paper already has enough setters.'); c.reload(); } }}>Ask setters for every paper</button>
          <button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/cwt/cycles/${id}/rolls`, { body: {} })); if (r) { await tell(`${r.assigned} roll numbers given; admit cards sent.`); c.reload(); } }}>Give roll numbers</button>
          <button className="btn small" disabled={busy || x.blockers.length > 0} onClick={async () => { if (await ask('Release the papers to every centre now? Passwords go to principals by SMS.') && await run(() => api(`/cwt/cycles/${id}/release`, { body: {} }), 'Released')) c.reload(); }}>Release now</button></>}</div></div>
      <main className="page">
        {!x ? <Empty>{c.error ?? 'Loading…'}</Empty> : <>
          <section className="tile"><div className="tile-head"><div><h2>{x.title}</h2><p className="muted small" style={{ marginTop: 4 }}>{day(x.exam_date)} at {x.starts_at.slice(0, 5)} for {x.duration_min} minutes · requirements by {day(x.requirements_by)} · papers due {day(x.papers_due)} · papers to centres {time(x.release_at)}</p></div><CStatus s={x.status} /></div>
            {x.blockers.length > 0 && !x.released_at && <div className="callout orange small" style={{ marginTop: 10 }}>Before release: {x.blockers.join('; ')}.</div>}</section>
          {x.papers.map((p: any) => <section key={p.id} className="tile">
            <div className="tile-head"><div><h3>{p.code} · {p.post}{p.subject ? `, ${p.subject}` : ''}</h3><p className="small muted">{p.needed_by.map((n: any) => `${n.school} (${n.candidates})`).join(', ') || 'No school yet'} · {p.roll_numbers} roll numbers · out of {p.max_marks}</p></div>
              {!x.released_at && <button className="btn quiet small" disabled={busy} onClick={async () => { const l: any = await run(() => api(`/cwt/papers/${p.id}/setters`)); if (l) { setSetters({ paper: p, list: l }); setPick(new Set()); } }}>Choose setter schools</button>}</div>
            {!p.requests.length ? <Empty>No setter asked yet.</Empty> : p.requests.map((r: any) => <div key={r.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span><b>{r.school}</b> <span className={`pill ${r.status === 'SELECTED' ? 'green' : r.status === 'SUBMITTED' ? 'blue' : r.status === 'DECLINED' ? 'red' : ''}`}>{words(r.status)}</span>
                <span className="tiny muted" style={{ display: 'block' }}>due {day(r.dueOn)}{r.submittedAt ? ` · submitted ${time(r.submittedAt)}` : ''}{r.note ? ` · “${r.note}”` : ''}{r.score ? ` · rated ${'★'.repeat(r.score)}` : ''}{r.reviewNote ? ` · ${r.reviewNote}` : ''}</span></span>
              {['SUBMITTED', 'SELECTED', 'NOT_SELECTED'].includes(r.status) && <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button className="btn quiet small" onClick={() => run(() => review(r, 'question'))}>Paper</button><button className="btn quiet small" onClick={() => run(() => review(r, 'key'))}>Key</button>
                <button className="btn quiet small" disabled={busy} onClick={async () => { const s = await askText('Rate this paper 1 to 5, with a note after a comma'); if (!s) return; const [n, ...note] = s.split(','); if (await run(() => api(`/cwt/requests/${r.id}/score`, { body: { score: Number(n), note: note.join(',').trim() || undefined } }), 'Saved')) c.reload(); }}>Rate</button>
                {!x.released_at && r.status !== 'SELECTED' && <button className="btn small" disabled={busy} onClick={async () => { const m = await askText('Maximum marks for this paper', { initial: String(p.max_marks) }); if (m && await run(() => api(`/cwt/requests/${r.id}/select`, { body: { maxMarks: Number(m) } }), 'Selected')) c.reload(); }}>Use this paper</button>}</span>}</div>)}
          </section>)}
          {x.centres.length > 0 && <section className="tile"><h3>Centres</h3><div className="scroll-x"><table className="table"><thead><tr><th>Centre</th><th className="num">Candidates</th><th>Papers</th><th className="num">Downloads</th><th>Keys</th><th>Marks</th></tr></thead>
            <tbody>{x.centres.map((ce: any) => <tr key={ce.id}><td>{ce.school}</td><td className="num">{ce.candidates}</td><td className="small">{ce.released_at ? time(ce.released_at) : '—'}</td><td className="num">{ce.downloads}</td><td className="small">{ce.keys_released_at ? time(ce.keys_released_at) : '—'}</td><td className="small">{ce.marks_submitted_at ? `in ${time(ce.marks_submitted_at)}` : '—'}</td></tr>)}</tbody></table></div></section>}
          <section className="tile"><h3>Who opened what</h3>{!(log.data ?? []).length ? <Empty>Nothing yet.</Empty> : (log.data ?? []).map((d, i) => <div key={i} className="tiny" style={{ marginTop: 3 }}>{time(d.at)} · {d.by}{d.school ? ` (${d.school})` : ''} · {d.kind === 'REVIEW' ? 'reviewed a submitted paper' : d.kind === 'PAPERS' ? 'downloaded the question papers' : d.kind === 'KEYS' ? 'downloaded the answer keys' : 'had the password sent again'}{d.from_ip ? ` · ${d.from_ip}` : ''}</div>)}</section>
        </>}
      </main>
      {setters && <Drawer title={`Setters for ${setters.paper.code}`} onClose={() => setSetters(null)}><section className="tile tight stack">
        <p className="small muted">Schools with teachers serving in this post today, most first. Schools testing candidates on this paper are left out. Choose three or four.</p>
        {!setters.list.length ? <Empty>No school has teachers in this post.</Empty> : setters.list.map((s) => <label key={s.school_id} className="check small" style={{ alignItems: 'flex-start' }}><input type="checkbox" disabled={s.requested} checked={s.requested || pick.has(s.school_id)} onChange={(e) => { const n = new Set(pick); e.target.checked ? n.add(s.school_id) : n.delete(s.school_id); setPick(n); }} />
          <span><b>{s.school}</b> <span className="tiny muted">{s.command} · {s.teachers} teachers{s.sets_other_papers ? ` · already setting ${s.sets_other_papers} other` : ''}{s.requested ? ' · already asked' : ''}</span></span></label>)}
        <button className="btn big" disabled={busy || !pick.size} onClick={async () => { if (await run(() => api(`/cwt/papers/${setters.paper.id}/requests`, { body: { schoolIds: [...pick] } }), 'Asked; principals are told by email')) { setSetters(null); c.reload(); } }}>Ask {pick.size || ''} schools</button>
      </section></Drawer>}
    </>
  );
}

// ── The Common Written Test: setter schools and centres ───────────────────────────────────

export function CwtSetter() {
  const [schoolId, picker] = useSchool();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/cwt-setter` : null, [schoolId]);
  const [files, setFiles] = useState<Record<string, { q?: File; k?: File; note?: string }>>({});
  const { run, busy } = useAction();
  const enc = async (f: File) => ({ name: f.name, contentType: f.type || 'application/pdf', dataBase64: await readBase64(f) });
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">CWT papers to set</span><span className="spacer" style={{ flex: 1 }} />{picker}</div></div>
      <main className="page">
        <section className="tile"><p className="muted">NES asks schools that have teachers in a post to set a question paper and answer key for the Common Written Test. Upload both as PDF or Word. They are encrypted as soon as they arrive and only the NES CWT cell opens them; you can replace them until the due date.</p></section>
        {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <section className="tile"><Empty>Nothing has been asked of your school.</Empty></section> : list.data.map((r) => { const s = files[r.id] ?? {}; return <section key={r.id} className="tile">
          <div className="tile-head"><div><h3>{r.paper} · {r.post}{r.subject ? `, ${r.subject}` : ''}</h3><p className="small muted">{r.title} ({r.cycle}) · test on {day(r.exam_date)}, {r.duration_min} minutes · out of {r.max_marks} · due <b>{day(r.due_on)}</b></p></div><span className="pill">{words(r.status)}</span></div>
          {r.question_name && <p className="small" style={{ marginTop: 6 }}>Uploaded: {r.question_name} and {r.key_name} · {time(r.submitted_at)}</p>}
          {['REQUESTED', 'SUBMITTED'].includes(r.status) && r.due_on >= today() && <div className="stack" style={{ marginTop: 10 }}>
            <div className="form-grid"><label className="field"><span>Question paper</span><input type="file" accept=".pdf,.docx" onChange={(e) => setFiles({ ...files, [r.id]: { ...s, q: e.target.files?.[0] } })} /></label>
              <label className="field"><span>Answer key</span><input type="file" accept=".pdf,.docx" onChange={(e) => setFiles({ ...files, [r.id]: { ...s, k: e.target.files?.[0] } })} /></label></div>
            <input className="input" placeholder="Note for NES (optional): sections, marks, sources" value={s.note ?? ''} onChange={(e) => setFiles({ ...files, [r.id]: { ...s, note: e.target.value } })} />
            <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy || !s.q || !s.k} onClick={async () => { if (await run(async () => api(`/cwt/requests/${r.id}/submit`, { body: { question: await enc(s.q!), key: await enc(s.k!), note: s.note } }), 'Uploaded and encrypted')) list.reload(); }}>{r.status === 'SUBMITTED' ? 'Replace' : 'Upload'}</button>
              {r.status === 'REQUESTED' && <button className="btn quiet small" disabled={busy} onClick={async () => { const why = await askText('Why can your school not set this paper?'); if (why && await run(() => api(`/cwt/requests/${r.id}/decline`, { body: { note: why } }), 'NES told')) list.reload(); }}>We cannot set it</button>}</div></div>}
        </section>; })}
      </main>
    </>
  );
}

export function CwtCentre({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/cwt-centre` : null, [schoolId]);
  const [marking, setMarking] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">CWT centre</span><span className="spacer" style={{ flex: 1 }} />{picker}</div></div>
      <main className="page">
        <section className="tile"><p className="muted">Your school is the centre for its own candidates. The question papers arrive the day before the test as one password-protected file; the password is sent to the principal’s mobile by SMS. Open it with 7-Zip or WinRAR, print one paper per candidate and keep them sealed until the start. Every download is recorded. The answer keys arrive the same way after the test.</p></section>
        {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <section className="tile"><Empty>Your school has no Common Written Test.</Empty></section> : list.data.map((c) => <section key={c.cycle_id} className="tile">
          <div className="tile-head"><div><h3>{c.title}</h3><p className="small muted">{c.code} · {day(c.exam_date)} at {c.starts_at.slice(0, 5)}, {c.duration_min} minutes · {c.candidates} candidates · papers due to arrive {time(c.release_at)}</p></div><CStatus s={c.status} /></div>
          {c.papers.map((p: any) => <div key={p.code} className="small" style={{ marginTop: 4 }}><b>{p.code}</b> for {p.vacancy}: {p.candidates} candidates · {p.marked} marked · out of {p.maxMarks}</div>)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn small" disabled={busy || !c.released_at} onClick={() => run(() => saveFile(`/schools/${schoolId}/cwt/${c.cycle_id}/papers`, `${c.code} question papers.zip`))}>{c.released_at ? 'Download question papers' : 'Question papers not yet released'}</button>
            {c.released_at && user.role === 'SCHOOL_ADMIN' && <button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/schools/${schoolId}/cwt/${c.cycle_id}/password`, { body: { kind: 'PAPERS' } })); if (r) await tell(`Password sent again to ${r.sentTo}.`); }}>Send the password again</button>}
            {c.keys_released_at && <button className="btn quiet small" disabled={busy} onClick={() => run(() => saveFile(`/schools/${schoolId}/cwt/${c.cycle_id}/keys`, `${c.code} answer keys.zip`))}>Download answer keys</button>}
            {c.keys_released_at && user.role === 'SCHOOL_ADMIN' && <button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/schools/${schoolId}/cwt/${c.cycle_id}/password`, { body: { kind: 'KEYS' } })); if (r) await tell(`Password for the keys sent to ${r.sentTo}.`); }}>Keys password again</button>}
            {c.keys_released_at && <button className="btn small" onClick={() => setMarking(c)}>Enter marks</button>}
          </div></section>)}
      </main>
      {marking && <MarksDrawer schoolId={schoolId} c={marking} onClose={() => { setMarking(null); list.reload(); }} />}
    </>
  );
}

function MarksDrawer({ schoolId, c, onClose }: { schoolId: string; c: any; onClose: () => void }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/cwt/${c.cycle_id}/candidates`);
  const [m, setM] = useState<Record<string, { marks: string; absent: boolean }>>({});
  useEffect(() => { if (list.data) setM(Object.fromEntries(list.data.map((r) => [r.roll, { marks: r.raw === null ? '' : String(r.raw), absent: r.absent }]))); }, [list.data]);
  const { run, busy } = useAction();
  // The attendance sheet: Roll, Name, Application, Present (Y/N), Signature, Booklet, then the marks.
  const cells = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((x) => x[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const fromCsv = async (f?: File) => { if (!f) return; const n = { ...m }; for (const line of (await readText(f)).split(/\r?\n/).slice(1)) { const [roll, , , present, , , marks] = cells(line); if (roll && n[roll]) n[roll] = { marks: marks ?? '', absent: (present ?? '').toUpperCase() === 'N' }; } setM(n); };
  return <Drawer title={`Marks · ${c.code}`} onClose={onClose}><section className="tile tight stack">
    <p className="small muted">Out of the paper’s maximum marks; they become a score out of 100 in each candidate’s merit. You can also fill the attendance sheet from the papers file (Present Y/N, then add a seventh column with the marks) and load it here.</p>
    <label className="btn quiet small" style={{ alignSelf: 'flex-start' }}>Load the filled attendance sheet<input type="file" accept=".csv" hidden onChange={(e) => fromCsv(e.target.files?.[0])} /></label>
    {!list.data ? <Empty>Loading…</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>Roll</th><th>Name</th><th>Marks</th><th>Absent</th></tr></thead>
      <tbody>{list.data.map((r) => <tr key={r.roll}><td className="mono small">{r.roll}</td><td className="small">{r.name}</td>
        <td><input className="input" style={{ width: 80, height: 32 }} type="number" min={0} max={r.max_marks} disabled={m[r.roll]?.absent} value={m[r.roll]?.marks ?? ''} onChange={(e) => setM({ ...m, [r.roll]: { ...m[r.roll], marks: e.target.value } })} /> <span className="tiny muted">/ {r.max_marks}</span></td>
        <td><input type="checkbox" checked={!!m[r.roll]?.absent} onChange={(e) => setM({ ...m, [r.roll]: { ...m[r.roll], absent: e.target.checked } })} /></td></tr>)}</tbody></table></div>}
    <button className="btn big" disabled={busy} onClick={async () => {
      const rows = Object.entries(m).filter(([, v]) => v.absent || v.marks !== '').map(([roll, v]) => (v.absent ? { roll, absent: true } : { roll, marks: Number(v.marks) }));
      if (!rows.length) return;
      const r: any = await run(() => api(`/schools/${schoolId}/cwt/${c.cycle_id}/marks`, { body: { rows } }));
      if (r) { await tell(`${r.saved} saved${r.remaining ? `; ${r.remaining} still to mark` : '; all marked'}. Merit is updated.`); onClose(); }
    }}>Save marks</button>
  </section></Drawer>;
}
