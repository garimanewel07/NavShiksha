import { useEffect, useMemo, useRef, useState } from 'react';
import { ModerationTab, ScriptsTab, SeatingTab } from './ExamOffice';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiFile, day, hasDuty, openPdf, readBase64, type User, currentYear } from '../api';
import { AuthImg } from './Gate';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast, ask } from '../ui';
import { FailedPage } from '../errors';

/**
 * Exams and results. An exam comes from the NES plan (PT1, Half-Yearly, PT2, Annual) and moves
 * Draft → Open for marks → Locked → Published. Teachers enter marks only for the subjects they
 * teach; the class teacher fills the Holistic Progress Card and remarks; the principal publishes,
 * after which nothing can change and report cards are printed from the published results.
 */

const YEAR = currentYear();
const STATUS: Record<string, [string, string]> = { DRAFT: ['Draft: papers and dates', ''], OPEN: ['Open for marks', 'blue'], LOCKED: ['Marks locked', 'orange'], PUBLISHED: ['Results published', 'green'] };
const LEVELS: [string, string][] = [['BEGINNER', 'Beginner'], ['PROGRESSING', 'Progressing'], ['PROFICIENT', 'Proficient'], ['ADVANCED', 'Advanced']];
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const isDesk = (u: User) => u.role === 'SCHOOL_ADMIN' || u.role === 'NES_ADMIN' || hasDuty(u, 'EXAM_INCHARGE');

function Bar({ value, tone = 'var(--blue)' }: { value: number; tone?: string }) {
  return <div style={{ height: 6, background: 'var(--line-soft)', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}><div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: tone }} /></div>;
}

// ── The school's exams ───────────────────────────────────────────────────────────────────

export function Exams({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/assessments?year=${YEAR}` : null, [schoolId]);
  const plan = useLoad<any[]>(schoolId ? `/schools/${schoolId}/assessment-plan?year=${YEAR}` : null, [schoolId]);
  const { run, busy } = useAction();
  const nav = useNavigate();
  const desk = isDesk(user);
  const notYet = (plan.data ?? []).filter((p) => !p.created);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Exams</span><span className="muted small">Academic year {YEAR}</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} /></div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head"><div><h2>Exams and results</h2>
            <p className="muted" style={{ marginTop: 6 }}>Each exam goes: <b>Draft</b> (check papers, marks and dates) → <b>Open for marks</b> (teachers enter marks for their own subjects; class teachers fill the holistic card) → <b>Locked</b> (nothing missing) → <b>Published</b> (results, ranks and report cards for parents; never changed after).</p></div></div>
          {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No exams set up for this year yet.</Empty> : (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Exam</th><th>Dates</th><th className="num">Share of final result</th><th>Status</th><th>Marks entered</th></tr></thead>
              <tbody>{list.data.map((a) => { const [label, tone] = STATUS[a.status] ?? [a.status, '']; const p = pct(a.marks_entered, a.marks_expected); return (
                <tr key={a.id} className="click" onClick={() => nav(`/exams/${a.id}`)}>
                  <td><b>{a.name}</b><div className="tiny muted">{a.code} · {a.papers} papers</div></td>
                  <td className="small">{a.starts ? `${day(a.starts)} – ${day(a.ends)}` : '—'}</td>
                  <td className="num">{a.weight ? `${a.weight}%` : '—'}</td>
                  <td><span className={`pill ${tone}`}>{label}</span></td>
                  <td style={{ minWidth: 140 }}><div className="tiny muted">{a.marks_entered.toLocaleString('en-IN')} of {a.marks_expected.toLocaleString('en-IN')} ({p}%)</div><Bar value={p} tone={p === 100 ? 'var(--green)' : undefined} /></td>
                </tr>); })}</tbody>
            </table></div>)}
        </section>
        {desk && notYet.length > 0 && <section className="tile">
          <h3>Set up from the NES plan</h3>
          <p className="small muted" style={{ marginTop: 4 }}>Papers are made for every class the school teaches, with the NES maximum marks. Check them and add exam dates before opening for marks.</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            {notYet.map((p) => <button key={p.code} className="btn secondary" disabled={busy} onClick={async () => {
              const r = await run(() => api<{ id: string; papers: number }>(`/schools/${schoolId}/assessments`, { body: { year: YEAR, code: p.code } }), `${p.name} set up`);
              if (r) nav(`/exams/${r.id}`);
            }}>{p.name}<span className="tiny" style={{ marginLeft: 8, opacity: 0.7 }}>{day(p.starts)} · out of {p.maxMarks}{p.weight ? ` · ${p.weight}%` : ''}</span></button>)}
          </div>
        </section>}
      </main>
    </>
  );
}

// ── One exam ─────────────────────────────────────────────────────────────────────────────

export function ExamDetail({ user }: { user: User }) {
  const { id } = useParams();
  const exams = useLoad<any>(`/assessments/${id}`, [id]);
  const a = exams.data;
  const [tab, setTab] = useState<'papers' | 'progress' | 'results' | 'seating' | 'moderation' | 'scripts'>('papers');
  useEffect(() => { if (a) setTab(a.status === 'PUBLISHED' ? 'results' : a.status === 'DRAFT' ? 'papers' : 'progress'); }, [a?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const { run, busy } = useAction();
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState('');
  const desk = isDesk(user);
  const principal = user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN';
  if (exams.error) return <FailedPage error={exams.error} />;
  if (!a) return <main className="page"><Empty>Loading…</Empty></main>;
  const [label, tone] = STATUS[a.status] ?? [a.status, ''];
  const act = async (path: string, done: string, body?: unknown) => { if (await run(() => api(`/assessments/${id}/${path}`, { method: 'POST', body }), done)) exams.reload(); };
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <Link to="/exams" className="small">‹ Exams</Link><span className="localnav-title">{a.name}</span><span className={`pill ${tone}`}>{label}</span><span className="spacer" />
        {desk && a.status === 'DRAFT' && <button className="btn small" disabled={busy} onClick={async () => await ask('Open this exam for marks entry? Teachers will see their mark sheets.') && act('open', 'Open for marks: teachers can enter marks now')}>Open for marks</button>}
        {desk && a.status === 'OPEN' && <button className="btn small" disabled={busy} onClick={() => act('lock', 'Marks locked')}>Lock marks</button>}
        {desk && a.status === 'LOCKED' && <button className="btn quiet small" onClick={() => setReopen(true)}>Reopen for corrections</button>}
        {principal && a.status === 'LOCKED' && <button className="btn small" disabled={busy} onClick={async () => await ask('Publish the results? Parents are told at once, and results can never be changed after this.') && act('publish', 'Results published; parents are told')}>Publish results</button>}
      </div></div>
      <main className="page">
        <div className="seg">{([['papers', 'Date sheet and papers'], ...(desk ? [['seating', 'Seating and invigilation']] : []), ['progress', 'Marks progress'], ...(desk ? [['moderation', 'Moderation'], ['scripts', 'Answer scripts']] : []), ['results', 'Results']] as [typeof tab, string][]).map(([k, l]) =>
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'seating' && <SeatingTab id={id!} schoolId={a.school_id} />}
        {tab === 'moderation' && <ModerationTab schoolId={a.school_id} />}
        {tab === 'scripts' && <ScriptsTab id={id!} schoolId={a.school_id} />}
        {tab === 'papers' && <Papers id={id!} editable={desk && (a.status === 'DRAFT' || a.status === 'OPEN')} />}
        {tab === 'progress' && <Progress id={id!} status={a.status} />}
        {tab === 'results' && <Results id={id!} published={a.status === 'PUBLISHED'} />}
      </main>
      {reopen && <Drawer title="Reopen for corrections" onClose={() => setReopen(false)}>
        <section className="tile tight stack">
          <p className="small muted">Teachers can change marks again until you lock once more. The reason is kept with the exam for ever.</p>
          <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Science marks of VIII-B entered against the wrong roll numbers" /></label>
          <button className="btn" disabled={busy || reason.trim().length < 5} onClick={async () => { await act('reopen', 'Reopened for corrections', { reason }); setReopen(false); setReason(''); }}>Reopen</button>
        </section>
      </Drawer>}
    </>
  );
}

/** Papers by class: maximum marks and exam dates. The date sheet parents see in the app comes from here. */
function Papers({ id, editable }: { id: string; editable: boolean }) {
  const papers = useLoad<any[]>(`/assessments/${id}/papers`, [id]);
  const toast = useToast();
  const byClass = useMemo(() => {
    const m = new Map<string, { name: string; rows: any[] }>();
    for (const p of papers.data ?? []) { const g = m.get(p.class_code) ?? { name: p.class_name, rows: [] as any[] }; g.rows.push(p); m.set(p.class_code, g); }
    return [...m.entries()];
  }, [papers.data]);
  const save = async (p: any, patch: { maxMarks?: number | null; examDate?: string | null }) => {
    try {
      await api(`/assessments/${id}/papers`, { method: 'PUT', body: { classCode: p.class_code, subjectCode: p.subject_code, maxMarks: patch.maxMarks === undefined ? p.max_marks : patch.maxMarks, examDate: patch.examDate === undefined ? p.exam_date : patch.examDate } });
      papers.reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  if (!papers.data) return <Empty>Loading…</Empty>;
  return (
    <section className="tile">
      <p className="small muted">{editable ? 'Set the date of each paper; parents see the date sheet in the app. Maximum marks cannot change once marks are entered for a paper.' : 'Papers are fixed once marks are locked.'}</p>
      <div className="stack" style={{ marginTop: 12, gap: 18 }}>
        {byClass.map(([code, g]) => <div key={code}>
          <h3 style={{ fontSize: '1.05rem' }}>{g.name}</h3>
          <div className="scroll-x"><table className="table" style={{ marginTop: 6 }}>
            <thead><tr><th>Subject</th><th className="num">Out of</th><th>Exam date</th>{editable && <th />}</tr></thead>
            <tbody>{g.rows.map((p) => <tr key={p.subject_code}>
              <td>{p.subject}</td>
              <td className="num">{editable ? <input className="input" type="number" min={1} max={200} defaultValue={p.max_marks} style={{ width: 80, height: 34, textAlign: 'right' }}
                onBlur={(e) => { const v = Number(e.target.value); if (v && v !== p.max_marks) save(p, { maxMarks: v }); }} /> : p.max_marks}</td>
              <td>{editable ? <input className="input" type="date" defaultValue={p.exam_date ?? ''} style={{ height: 34, width: 'auto' }} onChange={(e) => save(p, { examDate: e.target.value || null })} /> : p.exam_date ? day(p.exam_date) : '—'}</td>
              {editable && <td className="num"><button className="linkbtn small" onClick={async () => await ask(`Remove ${p.subject} from ${g.name} in this exam?`) && save(p, { maxMarks: null })}>Remove</button></td>}
            </tr>)}</tbody>
          </table></div>
        </div>)}
      </div>
    </section>
  );
}

/** Who still has marks to enter, section by section. Leadership can open any sheet. */
function Progress({ id, status }: { id: string; status: string }) {
  const rows = useLoad<any[]>(`/assessments/${id}/progress`, [id]);
  const nav = useNavigate();
  if (!rows.data) return <Empty>Loading…</Empty>;
  const total = rows.data.reduce((s, r) => s + r.strength, 0), done = rows.data.reduce((s, r) => s + r.entered, 0);
  const missing = rows.data.filter((r) => r.entered < r.strength);
  return (
    <section className="tile">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div><div className="kpi-label">Marks entered</div><div className="kpi-value" style={{ fontSize: '1.8rem' }}>{pct(done, total)}%</div><div className="kpi-note">{done.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</div></div>
        <div className="small muted" style={{ flex: 1, minWidth: 220 }}>{missing.length ? `${missing.length} class papers still have marks missing. Marks can be locked only when every child has a mark or is marked absent.` : status === 'OPEN' ? 'Every mark is in. The exam can be locked.' : 'All marks are in.'}</div>
      </div>
      <div className="scroll-x" style={{ marginTop: 14 }}><table className="table">
        <thead><tr><th>Class</th><th>Subject</th><th>Teacher</th><th>Entered</th></tr></thead>
        <tbody>{rows.data.map((r) => { const p = pct(r.entered, r.strength); return (
          <tr key={`${r.section_id}-${r.subject_code}`} className="click" onClick={() => nav(`/marks/${id}/${r.section_id}/${r.subject_code}`)}>
            <td>{r.class_code}-{r.section}</td><td>{r.subject}</td><td className="small">{r.teacher ?? <span className="muted">no teacher in the timetable</span>}</td>
            <td style={{ minWidth: 130 }}><div className="tiny muted">{r.entered} of {r.strength}</div><Bar value={p} tone={p === 100 ? 'var(--green)' : p === 0 ? 'var(--red)' : undefined} /></td>
          </tr>); })}</tbody>
      </table></div>
    </section>
  );
}

/** Published results: the school's Performance Index, grades, classes, subjects, toppers; each section's list and report cards. */
function Results({ id, published }: { id: string; published: boolean }) {
  const a = useLoad<any>(published ? `/assessments/${id}/analysis` : null, [id, published]);
  const progress = useLoad<any[]>(published ? `/assessments/${id}/progress` : null, [id, published]);
  const sections = useMemo(() => [...new Map((progress.data ?? []).map((r) => [r.section_id, { id: r.section_id, label: `${r.class_code}-${r.section}` }])).values()], [progress.data]);
  const [sectionId, setSectionId] = useState('');
  const res = useLoad<any[]>(sectionId ? `/assessments/${id}/sections/${sectionId}/results` : null, [sectionId]);
  const { run, busy } = useAction();
  if (!published) return <section className="tile"><Empty>Results appear here once the principal publishes them.</Empty></section>;
  if (!a.data) return <Empty>Loading…</Empty>;
  const d = a.data;
  const maxGrade = Math.max(1, ...d.grades.map((g: any) => g.n));
  return (
    <>
      <section className="tile">
        <div className="kpis">
          <div><div className="kpi-label">Students</div><div className="kpi-value">{d.overall.students}</div></div>
          <div><div className="kpi-label">Average</div><div className="kpi-value">{d.overall.average}%</div></div>
          <div><div className="kpi-label">Performance Index</div><div className="kpi-value">{d.overall.pi}</div><div className="kpi-note">grade points as a share of the best possible</div></div>
        </div>
        <h3 style={{ marginTop: 22 }}>Grades</h3>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${d.grades.length}, 1fr)`, gap: 8, alignItems: 'end', height: 120, marginTop: 10 }}>
          {d.grades.map((g: any) => <div key={g.grade} style={{ display: 'grid', gap: 4, justifyItems: 'center', alignContent: 'end', height: '100%' }}>
            <span className="tiny muted">{g.n}</span><div style={{ width: '70%', height: `${(g.n / maxGrade) * 80}px`, minHeight: 2, background: 'var(--blue)', borderRadius: 4 }} /><b className="small">{g.grade}</b></div>)}
        </div>
      </section>
      <div className="row">
        <section className="tile" style={{ flex: '1 1 380px' }}>
          <h3>By class</h3>
          <table className="table" style={{ marginTop: 8 }}><thead><tr><th>Class</th><th className="num">Students</th><th className="num">Average</th><th className="num">PI</th></tr></thead>
            <tbody>{d.byClass.map((c: any) => <tr key={c.class_code}><td>{c.class_name}</td><td className="num">{c.students}</td><td className="num">{c.average}%</td><td className="num"><b>{c.pi}</b></td></tr>)}</tbody></table>
        </section>
        <section className="tile" style={{ flex: '1 1 380px' }}>
          <h3>By subject</h3>
          <table className="table" style={{ marginTop: 8 }}><thead><tr><th>Subject</th><th className="num">Average</th><th className="num">PI</th></tr></thead>
            <tbody>{d.bySubject.map((s: any) => <tr key={s.subject}><td>{s.subject}</td><td className="num">{s.average}%</td><td className="num"><b>{s.pi}</b></td></tr>)}</tbody></table>
        </section>
      </div>
      <section className="tile">
        <h3>First in each class</h3>
        <div className="grid" style={{ marginTop: 10 }}>{d.toppers.map((t: any, i: number) => <div key={i} className="tile tight" style={{ background: 'var(--fill)' }}>
          <div className="tiny muted">Class {t.class_code}{t.section ? `-${t.section}` : ''}</div><b>{t.name}</b><div className="small">{t.percentage}% · {t.grade}</div></div>)}</div>
      </section>
      <section className="tile">
        <div className="tile-head"><h3>A class’s results and report cards</h3>
          <select className="input" style={{ width: 'auto', height: 36 }} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            <option value="">Choose a class</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        {sectionId && (!res.data ? <Empty>Loading…</Empty> : !res.data.length ? <Empty>No results for this class.</Empty> : <>
          <div style={{ margin: '8px 0 12px' }}><button className="btn small" disabled={busy} onClick={() => run(() => openPdf(`/assessments/${id}/sections/${sectionId}/report-cards`))}>Print report cards for the class</button>
            <span className="tiny muted" style={{ marginLeft: 10 }}>One A4 page per child: every published exam so far, the holistic card and the class teacher’s remark.</span></div>
          <div className="scroll-x"><table className="table">
            <thead><tr><th className="num">Rank</th><th>Student</th>{(res.data[0]?.subjects ?? []).map((s: any) => <th key={s.code} className="num">{s.name.slice(0, 4)}</th>)}<th className="num">Total</th><th className="num">%</th><th>Grade</th></tr></thead>
            <tbody>{res.data.map((r) => <tr key={r.enrolment_id}><td className="num">{r.rank_section}</td><td>{r.name}<div className="tiny muted">{r.admission_no}</div></td>
              {r.subjects.map((s: any) => <td key={s.code} className="num">{s.absent ? 'AB' : s.marks}</td>)}
              <td className="num">{r.obtained}/{r.max_total}</td><td className="num"><b>{r.percentage}</b></td><td>{r.grade}</td></tr>)}</tbody>
          </table></div></>)}
      </section>
    </>
  );
}

// ── Teachers: marks and report cards ─────────────────────────────────────────────────────

export function Marking({ user }: { user: User }) {
  const papers = useLoad<any[]>('/my/marking');
  const cards = useLoad<any[]>('/my/report-cards');
  const nav = useNavigate();
  const { run, busy } = useAction();
  void user;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Marks and report cards</span></div></div>
      <main className="page">
        <section className="tile">
          <h2>Marks to enter</h2>
          <p className="muted small" style={{ marginTop: 6 }}>Papers for the subjects you teach, in exams open for marks. Enter a mark or tick Absent for every child; the exam in-charge can lock only when nothing is missing.</p>
          {!papers.data ? <Empty>Loading…</Empty> : !papers.data.length ? <Empty>No exam is open for marks in your subjects.</Empty> : (
            <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
              <thead><tr><th>Exam</th><th>Class</th><th>Subject</th><th>Entered</th></tr></thead>
              <tbody>{papers.data.map((p) => { const v = pct(p.entered, p.strength); return (
                <tr key={`${p.assessment_id}-${p.section_id}-${p.subject_code}`} className="click" onClick={() => nav(`/marks/${p.assessment_id}/${p.section_id}/${p.subject_code}`)}>
                  <td>{p.assessment}{p.status === 'LOCKED' && <span className="pill orange" style={{ marginLeft: 6 }}>Locked</span>}</td><td>{p.class_code}-{p.section}</td><td>{p.subject} <span className="tiny muted">out of {p.max_marks}</span></td>
                  <td style={{ minWidth: 130 }}><div className="tiny muted">{p.entered} of {p.strength}</div><Bar value={v} tone={v === 100 ? 'var(--green)' : undefined} /></td></tr>); })}</tbody>
            </table></div>)}
        </section>
        {(cards.data ?? []).length > 0 && <section className="tile">
          <h2>Your class’s report cards</h2>
          <p className="muted small" style={{ marginTop: 6 }}>As class teacher you fill the Holistic Progress Card and a remark for each child while the exam is open (for Balvatika to Class V, the full card in the NES format, every term); once results are published you can print the whole class’s report cards.</p>
          <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
            <thead><tr><th>Exam</th><th>Class</th><th>Holistic card</th><th>Remarks</th><th /></tr></thead>
            <tbody>{(cards.data ?? []).map((c) => <tr key={`${c.assessment_id}-${c.section_id}`}>
              <td>{c.assessment}<div className="tiny muted">{STATUS[c.status]?.[0]}</div></td><td>{c.class_code}-{c.section}{c.kind === 'CO' && <span className="tiny muted"> (co-class teacher)</span>}</td>
              <td>{c.cards_started} of {c.strength}</td><td>{c.remarks} of {c.strength}</td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {c.status === 'OPEN' && <Link className="btn small" to={`/marks/${c.assessment_id}/${c.section_id}/${c.holistic ? 'holistic' : 'card'}`}>Fill in</Link>}
                {c.holistic && c.status !== 'OPEN' && <Link className="btn quiet small" to={`/marks/${c.assessment_id}/${c.section_id}/holistic`} style={{ marginRight: 6 }}>View</Link>}
                {(c.status === 'PUBLISHED' || c.holistic) && <button className="btn quiet small" disabled={busy} onClick={() => run(() => openPdf(`/assessments/${c.assessment_id}/sections/${c.section_id}/report-cards`))}>{c.status === 'PUBLISHED' ? 'Print report cards' : 'Print a draft'}</button>}
              </td></tr>)}</tbody>
          </table></div>
          <MySignature />
        </section>}
      </main>
    </>
  );
}

/** One paper for one class: fast entry with the keyboard (Enter goes to the next child). */
export function MarksSheet() {
  const { id, sectionId, subject } = useParams();
  const sheet = useLoad<any>(`/assessments/${id}/sections/${sectionId}/marks/${subject}`, [id, sectionId, subject]);
  const [rows, setRows] = useState<{ enrolmentId: string; name: string; admission: string; marks: string; absent: boolean }[]>([]);
  const [dirty, setDirty] = useState(false);
  const status = useLoad<{ status: string | null }>(`/assessments/${id}/sheets/${sectionId}/${subject}/status`, [id, sectionId, subject]);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const { run, busy } = useAction();
  useEffect(() => {
    if (!sheet.data) return;
    setRows(sheet.data.students.map((s: any) => ({ enrolmentId: s.enrolment_id, name: s.name, admission: s.admission_no, marks: s.marks == null ? '' : String(s.marks), absent: !!s.absent })));
    setDirty(false);
  }, [sheet.data]);
  if (sheet.error) return <FailedPage error={sheet.error} />;
  if (!sheet.data) return <main className="page"><Empty>Loading…</Empty></main>;
  const max: number = sheet.data.maxMarks;
  const locked = !!status.data?.status && status.data.status !== 'RETURNED';
  const open = sheet.data.status === 'OPEN';
  const bad = (r: (typeof rows)[number]) => !r.absent && r.marks !== '' && (Number.isNaN(Number(r.marks)) || Number(r.marks) < 0 || Number(r.marks) > max || Math.round(Number(r.marks) * 2) !== Number(r.marks) * 2);
  const entered = rows.filter((r) => r.absent || r.marks !== '').length;
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => { setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  const save = async () => {
    if (rows.some(bad)) return;
    const ok = await run(() => api(`/assessments/${id}/sections/${sectionId}/marks/${subject}`, { method: 'PUT', body: { entries: rows.map((r) => ({ enrolmentId: r.enrolmentId, marks: r.absent || r.marks === '' ? null : Number(r.marks), absent: r.absent })) } }), 'Marks saved');
    if (ok) { setDirty(false); sheet.reload(); }
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/marks" className="small">‹ Marks</Link>
        <span className="localnav-title">{sheet.data.section} · {subject}</span><span className="muted small">{sheet.data.assessment} · out of {max}</span><span className="spacer" />
        <span className="small muted">{entered} of {rows.length} entered</span>
        {open && <button className="btn small" disabled={busy || !dirty || rows.some(bad) || locked} onClick={save}>Save marks</button>}
        {open && !locked && <button className="btn quiet small" disabled={busy || dirty || entered < rows.length} onClick={async () => { if (await ask('Submit these marks for moderation? You cannot change them afterwards unless the exam in-charge returns the sheet.') && await run(() => api(`/assessments/${id}/sheets/${sectionId}/${subject}/submit`, { body: {} }), 'Submitted for moderation')) status.reload(); }}>Submit for moderation</button>}</div></div>
      <main className="page" style={{ maxWidth: 760 }}>
        {status.data?.status && <div className={`callout ${status.data.status === 'RETURNED' ? 'orange' : 'blue'} small`}>{status.data.status === 'SUBMITTED' ? 'Submitted for moderation: the exam in-charge reviews these marks now.' : status.data.status === 'MODERATED' ? 'Moderated by the exam in-charge.' : 'Returned to you by the exam in-charge: correct and submit again.'}</div>}
        {!open && <div className="callout orange small">Marks for this exam are {sheet.data.status === 'PUBLISHED' ? 'published' : sheet.data.status.toLowerCase()}. Ask the exam in-charge to reopen it if a correction is needed.</div>}
        <section className="tile tight">
          <table className="table">
            <thead><tr><th>#</th><th>Student</th><th className="num">Marks (out of {max})</th><th>Absent</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={r.enrolmentId}>
              <td className="tiny muted">{i + 1}</td><td>{r.name}<div className="tiny muted">{r.admission}</div></td>
              <td className="num"><input ref={(el) => { inputs.current[i] = el; }} className="input" inputMode="decimal" disabled={!open || locked || r.absent} value={r.absent ? '' : r.marks}
                style={{ width: 90, height: 36, textAlign: 'right', borderColor: bad(r) ? 'var(--red)' : undefined }} aria-label={`Marks for ${r.name}`}
                onChange={(e) => set(i, { marks: e.target.value.replace(/[^0-9.]/g, '') })}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); inputs.current[i + 1]?.focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); inputs.current[i - 1]?.focus(); } }} />
                {bad(r) && <div className="tiny" style={{ color: 'var(--red)' }}>0 to {max}, in halves</div>}</td>
              <td><input type="checkbox" disabled={!open} checked={r.absent} onChange={(e) => set(i, { absent: e.target.checked, marks: '' })} aria-label={`${r.name} absent`} /></td>
            </tr>)}</tbody>
          </table>
          {open && <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}><button className="btn" disabled={busy || !dirty || rows.some(bad)} onClick={save}>Save marks</button>
            <span className="tiny muted">Enter or ↓ moves to the next child. You can save part of the class and come back.</span></div>}
        </section>
      </main>
    </>
  );
}

/** The class teacher's Holistic Progress Card and remark for each child. */
export function CardSheet() {
  const { id, sectionId } = useParams();
  const sheet = useLoad<any>(`/assessments/${id}/sections/${sectionId}/hpc`, [id, sectionId]);
  const [draft, setDraft] = useState<Record<string, { entries: Record<string, string>; remark: string }>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const { run, busy } = useAction();
  useEffect(() => {
    if (!sheet.data) return;
    const d: typeof draft = {};
    for (const s of sheet.data.students) d[s.enrolment_id] = { entries: Object.fromEntries(Object.entries(s.entries ?? {}).map(([k, v]: [string, any]) => [k, v.level])), remark: s.remark ?? '' };
    setDraft(d);
  }, [sheet.data]);
  if (sheet.error) return <FailedPage error={sheet.error} />;
  if (!sheet.data) return <main className="page"><Empty>Loading…</Empty></main>;
  const open = sheet.data.status === 'OPEN';
  const save = async (enrolmentId: string) => {
    const d = draft[enrolmentId];
    const entries = Object.entries(d.entries).filter(([, v]) => v).map(([domain, level]) => ({ domain, level }));
    if (await run(() => api(`/assessments/${id}/sections/${sectionId}/hpc/${enrolmentId}`, { method: 'PUT', body: { entries, remark: d.remark } }))) setSaved({ ...saved, [enrolmentId]: true });
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/marks" className="small">‹ Marks</Link><span className="localnav-title">{sheet.data.section} · Holistic Progress Card</span><span className="muted small">{sheet.data.assessment}</span></div></div>
      <main className="page">
        {!open && <div className="callout orange small">This exam is no longer open, so the holistic card and remarks can’t be changed.</div>}
        <p className="small muted">For each child choose a level in each area (NEP 2020) and write a short remark for the report card. Save each child as you go.</p>
        {sheet.data.students.map((s: any) => { const d = draft[s.enrolment_id]; if (!d) return null; return (
          <section key={s.enrolment_id} className="tile tight stack small">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ fontSize: '1rem' }}>{s.name}</b><span className="tiny muted">{s.admission_no}</span><span className="spacer" style={{ flex: 1 }} />{saved[s.enrolment_id] && <span className="pill green">Saved</span>}</div>
            <div className="hpc-grid">{sheet.data.domains.map((dm: any) => <div key={dm.code}>
              <div title={dm.hint}><b>{dm.name}</b><div className="tiny muted">{dm.hint}</div></div>
              <div className="seg" style={{ marginTop: 4 }}>{LEVELS.map(([v, l]) => <button key={v} disabled={!open} className={d.entries[dm.code] === v ? 'on' : ''}
                onClick={() => { setDraft({ ...draft, [s.enrolment_id]: { ...d, entries: { ...d.entries, [dm.code]: v } } }); setSaved({ ...saved, [s.enrolment_id]: false }); }}>{l}</button>)}</div>
            </div>)}</div>
            <label className="field"><span>Remark for the report card</span><textarea className="input" rows={2} maxLength={800} disabled={!open} value={d.remark}
              onChange={(e) => { setDraft({ ...draft, [s.enrolment_id]: { ...d, remark: e.target.value } }); setSaved({ ...saved, [s.enrolment_id]: false }); }} placeholder="A sentence or two on progress and what to work on" /></label>
            {open && <div><button className="btn small" disabled={busy} onClick={() => save(s.enrolment_id)}>Save {s.name.split(' ')[0]}</button></div>}
          </section>); })}
      </main>
    </>
  );
}

// ── NES and Commands: one exam across schools ────────────────────────────────────────────

export function AcrossSchools() {
  const [code, setCode] = useState('HY');
  const d = useLoad<any>(`/results/across-schools?year=${YEAR}&code=${code}`, [code]);
  const best = Math.max(1, ...((d.data?.schools ?? []).map((s: any) => s.pi ?? 0)));
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Results across schools</span><span className="spacer" />
        <div className="seg">{[['PT1', 'Periodic Test 1'], ['HY', 'Half-Yearly'], ['PT2', 'Periodic Test 2'], ['ANNUAL', 'Annual']].map(([k, l]) => <button key={k} className={code === k ? 'on' : ''} onClick={() => setCode(k)}>{l}</button>)}</div></div></div>
      <main className="page">
        {!d.data ? <Empty>Loading…</Empty> : <>
          <section className="tile">
            <h2>Schools by Performance Index</h2>
            <p className="small muted" style={{ marginTop: 6 }}>Grade points as a share of the best possible, so schools of any size compare fairly. Schools that have not published this exam show no index.</p>
            <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
              <thead><tr><th>School</th><th>Status</th><th className="num">Students</th><th className="num">Average</th><th className="num">A1/A2</th><th style={{ minWidth: 160 }}>Performance Index</th></tr></thead>
              <tbody>{d.data.schools.map((s: any) => <tr key={s.school_id}><td><b>{s.school.replace('Navy Children School, ', 'NCS ')}</b></td><td><span className={`pill ${STATUS[s.status]?.[1] ?? ''}`}>{STATUS[s.status]?.[0] ?? s.status}</span></td>
                <td className="num">{s.students || '—'}</td><td className="num">{s.average != null ? `${s.average}%` : '—'}</td><td className="num">{s.distinctions || '—'}</td>
                <td>{s.pi != null ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ width: 40 }}>{s.pi}</b><Bar value={(s.pi / best) * 100} /></div> : <span className="muted">—</span>}</td></tr>)}</tbody>
            </table></div>
          </section>
          <div className="row">
            <section className="tile" style={{ flex: '1 1 380px' }}>
              <h3>Best school in each class</h3>
              <table className="table" style={{ marginTop: 8 }}><tbody>{Object.entries(d.data.bestByClass).map(([cls, b]: [string, any]) => <tr key={cls}><td>Class {cls}</td><td>{b.school.replace('Navy Children School, ', 'NCS ')}</td><td className="num"><b>{b.pi}</b></td></tr>)}</tbody></table>
            </section>
            <section className="tile" style={{ flex: '1 1 380px' }}>
              <h3>Top three in each class, across schools</h3>
              <table className="table" style={{ marginTop: 8 }}><tbody>{d.data.toppers.map((t: any, i: number) => <tr key={i}><td className="tiny muted">{t.class_code}</td><td className="num">{t.nes_rank}</td><td>{t.name}<div className="tiny muted">{t.school.replace('Navy Children School, ', 'NCS ')}</div></td><td className="num"><b>{t.percentage}%</b></td></tr>)}</tbody></table>
            </section>
          </div>
        </>}
      </main>
    </>
  );
}

/** The class teacher's own signature, printed on the report cards they sign. */
function MySignature() {
  const [v, setV] = useState(0);
  const [has, setHas] = useState<boolean | null>(null);
  const { run, busy } = useAction();
  useEffect(() => { apiFile('/me/signature').then(() => setHas(true)).catch(() => setHas(false)); }, [v]);
  return (
    <div className="callout small" style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ flex: 1, minWidth: 220 }}><b>Your signature on the cards.</b> Sign on white paper, photograph or scan it, and crop closely. {has === false && 'Not uploaded yet: the cards print with a blank line.'}</span>
      {has && <AuthImg key={v} path="/me/signature" style={{ height: 36, background: '#fff', borderRadius: 6 }} />}
      <label className="btn quiet small" style={{ cursor: 'pointer' }}>{has ? 'Replace' : 'Upload'}<input type="file" accept="image/png,image/jpeg" hidden disabled={busy} onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        if (await run(async () => api('/me/signature', { method: 'PUT', body: { dataBase64: await readBase64(f) } }), 'Signature saved')) setV(v + 1);
      }} /></label>
    </div>
  );
}
