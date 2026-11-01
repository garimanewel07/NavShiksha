import { useState } from 'react';
import { api, apiFile, day, readText, saveFile, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, ask, tell, askText } from '../ui';
import { useSchool } from './Payroll';

/**
 * The exam office: seating plans and invigilation for each exam day, moderation of submitted marks
 * sheets, answer-script bundles, rooms; the board (CBSE registration data from the records, roll
 * numbers, the result file and its analysis); and promoting the school to the next year.
 */

const openPdf = async (path: string) => { const { blob } = await apiFile(path); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };

export function SeatingTab({ id, schoolId }: { id: string; schoolId: string }) {
  const d = useLoad<any[]>(`/assessments/${id}/days`, [id]);
  const [view, setView] = useState<{ date: string; session: string } | null>(null);
  const [rooms, setRooms] = useState(false);
  const { run, busy } = useAction();
  return <section className="tile">
    <div className="tile-head"><div><h3>Seating and invigilation</h3><p className="tiny muted">For each exam day: children seated across the exam rooms with classes mixed, and invigilators who do not teach a paper written that day, shared out evenly.</p></div><button className="btn quiet small" onClick={() => setRooms(true)}>Rooms</button></div>
    {!d.data ? <Empty>{d.error ?? 'Loading…'}</Empty> : !d.data.length ? <Empty>Give the papers their dates first (Date sheet).</Empty> : d.data.map((x) => <div key={`${x.exam_date}${x.session}`} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{day(x.exam_date)}</b> {x.session.toLowerCase()} <span className="small muted">· {x.papers.map((p: any) => `${p.class} ${p.subject}`).join(', ')} · {x.candidates} children</span>
        <span className="tiny muted" style={{ display: 'block' }}>{x.seated ? `${x.seated} seated · ${x.invigilators} invigilators` : 'No plan yet'}</span></span>
      <span style={{ display: 'flex', gap: 6 }}><button className="btn small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/assessments/${id}/seating`, { body: { examDate: x.exam_date, session: x.session } })); if (r) { if (r.shortOfInvigilators) await tell(`Seated ${r.seated} in ${r.rooms} rooms. ${r.shortOfInvigilators} more invigilators are needed: there are not enough free teachers.`); d.reload(); } }}>{x.seated ? 'Make again' : 'Make the plan'}</button>
        {x.seated > 0 && <><button className="btn quiet small" onClick={() => setView({ date: x.exam_date, session: x.session })}>See</button><button className="btn quiet small" onClick={() => run(() => openPdf(`/assessments/${id}/seating.pdf?date=${x.exam_date}&session=${x.session}`))}>Room sheets</button></>}</span></div>)}
    {view && <SeatView id={id} {...view} onClose={() => setView(null)} />}
    {rooms && <RoomsDrawer schoolId={schoolId} onClose={() => { setRooms(false); d.reload(); }} />}
  </section>;
}

function SeatView({ id, date, session, onClose }: { id: string; date: string; session: string; onClose: () => void }) {
  const s = useLoad<any>(`/assessments/${id}/seating?date=${date}&session=${session}`);
  return <Drawer title={`Seating · ${day(date)} ${session.toLowerCase()}`} onClose={onClose}><section className="tile tight">
    {!s.data ? <Empty>Loading…</Empty> : s.data.rooms.map((r: any) => <div key={r.room_id} style={{ marginBottom: 14 }}><h3>Room {r.room}</h3><p className="tiny muted">Invigilators: {r.invigilators.join(', ') || 'none free'}</p>
      {r.seats.map((x: any) => <div key={x.seat_no} className="small">{x.seat_no}. {x.name} · {x.class} · {x.subject}</div>)}</div>)}
  </section></Drawer>;
}

function RoomsDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/rooms`, [schoolId]);
  const campuses = useLoad<any[]>(`/org/schools/${schoolId}/campuses`, [schoolId]);
  const [f, setF] = useState({ campusId: '', name: '', kind: 'CLASSROOM', capacity: '40', examSeats: '30' });
  const { run, busy } = useAction();
  return <Drawer title="Rooms" onClose={onClose}><section className="tile tight stack">
    {(list.data ?? []).map((r) => <div key={r.id} className="small">{r.name} · {words(r.kind)} · {r.capacity} seats, {r.exam_seats} for exams · {r.campus}</div>)}
    <div className="form-grid">
      <label className="field"><span>Campus</span><select className="input" value={f.campusId} onChange={(e) => setF({ ...f, campusId: e.target.value })}><option value="">Choose</option>{(campuses.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Room 101" /></label>
      <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['CLASSROOM', 'LAB', 'HALL', 'LIBRARY', 'OTHER'].map((k) => <option key={k} value={k}>{words(k)}</option>)}</select></label>
      <label className="field"><span>Seats</span><input className="input" inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></label>
      <label className="field"><span>Seats in exams</span><input className="input" inputMode="numeric" value={f.examSeats} onChange={(e) => setF({ ...f, examSeats: e.target.value })} /></label>
    </div>
    <button className="btn" disabled={busy || !f.campusId || !f.name.trim()} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/rooms`, { body: { campusId: f.campusId, name: f.name, kind: f.kind, capacity: Number(f.capacity), examSeats: Number(f.examSeats) } }), 'Added')) { setF({ ...f, name: '' }); list.reload(); } }}>Add room</button>
  </section></Drawer>;
}

export function ModerationTab({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/moderation`, [schoolId]);
  const [open, setOpen] = useState<any>(null);
  return <section className="tile"><h3>Marks sheets to moderate</h3>
    <p className="tiny muted">Subject teachers submit their class’s marks. Compare the class with the rest of the class level, change any mark with the reason (kept for ever), then accept the sheet or return it to the teacher.</p>
    {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>Nothing waiting.</Empty> : list.data.map((m) => <div key={`${m.section_id}${m.subject_code}`} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <span><b>{m.section} · {m.subject}</b> <span className="small muted">{m.assessment} · {m.teacher}</span><span className="tiny muted" style={{ display: 'block' }}>Average {m.average ?? '—'}% (class level {m.class_average ?? '—'}%)</span></span>
      <button className="btn small" onClick={() => setOpen(m)}>Moderate</button></div>)}
    {open && <ModerateDrawer m={open} onClose={() => { setOpen(null); list.reload(); }} />}
  </section>;
}

function ModerateDrawer({ m, onClose }: { m: any; onClose: () => void }) {
  const sheet = useLoad<any>(`/assessments/${m.assessment_id}/sections/${m.section_id}/marks/${m.subject_code}`);
  const [chg, setChg] = useState<Record<string, { marks: string; reason: string }>>({});
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const changes = Object.entries(chg).filter(([, c]) => c.marks !== '').map(([enrolmentId, c]) => ({ enrolmentId, marks: Number(c.marks), reason: c.reason }));
  const send = async (accept: boolean) => { if (await run(() => api(`/assessments/${m.assessment_id}/sheets/${m.section_id}/${m.subject_code}/moderate`, { body: { accept, changes, note: note || undefined } }), accept ? 'Moderated' : 'Returned to the teacher')) onClose(); };
  return <Drawer title={`Moderate · ${m.section} ${m.subject}`} onClose={onClose}><section className="tile tight stack">
    {!sheet.data ? <Empty>Loading…</Empty> : <table className="table"><thead><tr><th>Child</th><th className="num">Marks / {sheet.data.maxMarks}</th><th>Change to</th><th>Reason</th></tr></thead>
      <tbody>{sheet.data.students.map((s: any) => <tr key={s.enrolment_id}><td className="small">{s.name}</td><td className="num">{s.absent ? 'Absent' : s.marks}</td>
        <td><input className="input" style={{ width: 70, height: 32 }} inputMode="decimal" value={chg[s.enrolment_id]?.marks ?? ''} onChange={(e) => setChg({ ...chg, [s.enrolment_id]: { marks: e.target.value, reason: chg[s.enrolment_id]?.reason ?? '' } })} /></td>
        <td><input className="input" style={{ height: 32 }} value={chg[s.enrolment_id]?.reason ?? ''} onChange={(e) => setChg({ ...chg, [s.enrolment_id]: { marks: chg[s.enrolment_id]?.marks ?? '', reason: e.target.value } })} /></td></tr>)}</tbody></table>}
    <input className="input" placeholder="Note to the teacher (needed to return the sheet)" value={note} onChange={(e) => setNote(e.target.value)} />
    <div style={{ display: 'flex', gap: 8 }}><button className="btn" disabled={busy || changes.some((c) => c.reason.trim().length < 4)} onClick={() => send(true)}>Accept{changes.length ? ` with ${changes.length} changes` : ''}</button>
      <button className="btn quiet" disabled={busy || !note.trim()} onClick={() => send(false)}>Return to the teacher</button></div>
  </section></Drawer>;
}

export function ScriptsTab({ id, schoolId }: { id: string; schoolId: string }) {
  const list = useLoad<any[]>(`/assessments/${id}/bundles`, [id]);
  const progress = useLoad<any[]>(`/assessments/${id}/progress`, [id]);
  const staff = useLoad<any[]>(`/schools/${schoolId}/staff`, [schoolId]);
  const [f, setF] = useState({ key: '', scripts: '', evaluator: '' });
  const { run, busy } = useAction();
  return <section className="tile"><h3>Answer scripts</h3>
    <p className="tiny muted">Bundles issued to evaluators and returned, with any shortfall explained.</p>
    {(list.data ?? []).map((b) => <div key={b.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{b.section} {b.subject}</b> · {b.scripts} scripts · {b.evaluator} · issued {day(b.issued_at)}{b.returned_at ? ` · returned ${day(b.returned_at)} (${b.returned_count})` : ''}{b.note ? ` · ${b.note}` : ''}</span>
      {!b.returned_at && <button className="linkbtn small" disabled={busy} onClick={async () => { const n = await askText('How many scripts came back?', { initial: String(b.scripts) }); if (n === null) return; const note = Number(n) !== b.scripts ? (await askText('What happened to the rest?') ?? '') : ''; const ok = await run(() => api(`/bundles/${b.id}/return`, { body: { count: Number(n), note } }), 'Returned'); if (ok) list.reload(); }}>Returned</button>}</div>)}
    <div className="form-grid" style={{ marginTop: 10 }}>
      <label className="field"><span>Class and paper</span><select className="input" value={f.key} onChange={(e) => { const p = (progress.data ?? []).find((x) => `${x.section_id}|${x.subject_code}` === e.target.value); setF({ ...f, key: e.target.value, scripts: p ? String(p.strength) : '' }); }}><option value="">Choose</option>{(progress.data ?? []).map((p) => <option key={`${p.section_id}|${p.subject_code}`} value={`${p.section_id}|${p.subject_code}`}>{p.class_code}-{p.section} {p.subject}</option>)}</select></label>
      <label className="field"><span>Scripts</span><input className="input" inputMode="numeric" value={f.scripts} onChange={(e) => setF({ ...f, scripts: e.target.value })} /></label>
      <label className="field"><span>Evaluator</span><select className="input" value={f.evaluator} onChange={(e) => setF({ ...f, evaluator: e.target.value })}><option value="">Choose</option>{(staff.data ?? []).filter((s) => s.role === 'TEACHER').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    </div>
    <button className="btn small" disabled={busy || !f.key || !f.evaluator || !(Number(f.scripts) > 0)} onClick={async () => { const [sectionId, subjectCode] = f.key.split('|'); if (await run(() => api(`/assessments/${id}/bundles`, { body: { sectionId, subjectCode, scripts: Number(f.scripts), evaluator: f.evaluator } }), 'Issued')) list.reload(); }}>Issue bundle</button>
  </section>;
}

export function MyInvigilation() {
  const d = useLoad<any[]>('/my/invigilation');
  return <><div className="localnav"><div className="localnav-in"><span className="localnav-title">My invigilation duties</span></div></div>
    <main className="page"><section className="tile">{!d.data ? <Empty>Loading…</Empty> : !d.data.length ? <Empty>No duties coming up.</Empty> : d.data.map((x, i) => <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{day(x.exam_date)}</b> {x.session.toLowerCase()} · Room {x.room} · {x.assessment}</span><span className="small">{x.candidates} children</span></div>)}</section></main></>;
}

// ── The board ─────────────────────────────────────────────────────────────────────────────

export function Board() {
  const [schoolId, picker] = useSchool();
  const [cls, setCls] = useState('X');
  const rows = useLoad<any[]>(schoolId ? `/schools/${schoolId}/board/${cls}` : null, [schoolId, cls]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const an = useLoad<any>(schoolId && ['X', 'XII'].includes(cls) ? `/schools/${schoolId}/board/results/${year}/${cls}` : null, [schoolId, cls, year]);
  const { run, busy } = useAction();
  const missing = (rows.data ?? []).filter((r) => r.missing.length);
  const loadNumbers = async (f?: File) => { if (!f) return; const lines = (await readText(f)).split(/\r?\n/).slice(1).map((l) => l.split(',').map((c) => c.trim())).filter((c) => c[0]);
    const r: any = await run(() => api(`/schools/${schoolId}/board/numbers`, { body: { rows: lines.map(([admissionNo, regNo, rollNo]) => ({ admissionNo, regNo: regNo || undefined, rollNo: rollNo || undefined })) } }));
    if (r) { await tell(`${r.updated} updated${r.unknown.length ? `; not found: ${r.unknown.slice(0, 5).join(', ')}` : ''}.`); rows.reload(); } };
  const [preview, setPreview] = useState<{ name: string; text: string; r: any } | null>(null);
  const uploads = useLoad<any[]>(schoolId ? `/schools/${schoolId}/board/uploads` : null, [schoolId]);
  const readResults = async (f?: File) => { if (!f) return; const text = await readText(f); const r: any = await run(() => api(`/schools/${schoolId}/board/results`, { body: { year: Number(year), classCode: cls, content: text, fileName: f.name, dryRun: true } })); if (r) setPreview({ name: f.name, text, r }); };
  const saveResults = async () => { if (!preview) return; const r: any = await run(() => api(`/schools/${schoolId}/board/results`, { body: { year: Number(year), classCode: cls, content: preview.text, fileName: preview.name } }), 'Results loaded; publish them when checked'); if (r) { setPreview(null); an.reload(); uploads.reload(); } };
  const mine = (uploads.data ?? []).filter((u) => u.class_code === cls && String(u.year) === year);
  return <>
    <div className="localnav"><div className="localnav-in"><span className="localnav-title">Board (CBSE)</span><span className="spacer" style={{ flex: 1 }} />{picker}
      <div className="seg">{['IX', 'X', 'XI', 'XII'].map((c) => <button key={c} className={cls === c ? 'on' : ''} onClick={() => setCls(c)}>Class {c}</button>)}</div></div></div>
    <main className="page">
      <section className="tile"><div className="tile-head"><div><h3>{['IX', 'XI'].includes(cls) ? 'Registration' : 'List of candidates'} · Class {cls}</h3><p className="tiny muted">From the children’s records and the subjects their class is taught, with CBSE codes. Correct a missing detail on the child’s record; it is never typed here.</p></div>
        <span style={{ display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => run(() => saveFile(`/schools/${schoolId}/board/${cls}?format=csv`, `cbse-${cls}.csv`))}>Spreadsheet</button>
          <label className="btn quiet small">Load numbers from CBSE<input type="file" accept=".csv" hidden onChange={(e) => loadNumbers(e.target.files?.[0])} /></label></span></div>
        {missing.length > 0 && <div className="callout orange small" style={{ marginTop: 8 }}>{missing.length} of {rows.data?.length} children have something missing.</div>}
        {!rows.data ? <Empty>{rows.error ?? 'Loading…'}</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}><thead><tr><th>Child</th><th>Mother / father</th><th>Born</th><th>APAAR</th><th>Subjects</th><th>Reg. / roll</th><th>Missing</th></tr></thead>
          <tbody>{rows.data.map((r) => <tr key={r.enrolment_id}><td><b>{r.name}</b><span className="tiny muted" style={{ display: 'block' }}>{r.admission_no} · {r.section}</span></td><td className="small">{r.mother_name ?? '—'} / {r.father_name ?? '—'}</td><td className="small">{day(r.dob)}</td>
            <td className="small mono">{r.apaar_id ?? '—'}</td><td className="small mono">{(r.codes ?? []).join(' ')}</td><td className="small">{r.board_reg_no ?? '—'} / {r.board_roll_no ?? '—'}</td><td className="tiny" style={{ color: r.missing.length ? 'var(--orange)' : undefined }}>{r.missing.join(', ')}</td></tr>)}</tbody></table></div>}
      </section>
      {['X', 'XII'].includes(cls) && <section className="tile"><div className="tile-head"><h3>Board results</h3><span style={{ display: 'flex', gap: 6 }}><input className="input" style={{ width: 90, height: 34 }} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year of the examination" />
        <label className="btn small">Upload the CBSE result file<input type="file" accept=".txt,.csv,text/plain" hidden onChange={(e) => { readResults(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {mine.length > 0 && mine[0].published < mine[0].rows && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await ask(`Publish the Class ${cls} ${year} board results? Parents of the matched children see them in the app and are told.`) && await run(() => api(`/schools/${schoolId}/board/results/${year}/${cls}/publish`, { body: {} }), 'Published to parents')) uploads.reload(); }}>Publish to parents</button>}</span></div>
        <p className="tiny muted">Upload the result file CBSE sends the school (the .TXT file) as it is; a CSV (roll, name, then code, marks and grade per subject, then the result) also works. You see what was read before anything is saved. The X and XII Performance Index is worked out from these grades.</p>
        {mine.length > 0 && <p className="tiny muted">Last loaded: {mine[0].file_name}, {day(mine[0].uploaded_at)} by {mine[0].by} · {mine[0].rows} candidates, {mine[0].matched} matched · {mine[0].published ? `${mine[0].published} published` : 'not published to parents yet'}</p>}
        {preview && <div className="callout blue small stack" style={{ marginTop: 8 }}>
          <b>{preview.name}: {preview.r.rows} candidates read ({preview.r.format === 'CBSE_TXT' ? 'CBSE text file' : 'CSV'}), {preview.r.passed} passed, {preview.r.matched} matched to the children’s records.</b>
          {preview.r.supplementary && <span>Supplementary examination: it updates {preview.r.updates} result{preview.r.updates === 1 ? '' : 's'} already loaded, only in the subjects taken again (for improvement, the better marks are kept). Families already shown the result are told.</span>}
          {preview.r.skipped.length > 0 && <span style={{ color: 'var(--orange)' }}>Lines not understood: {preview.r.skipped.slice(0, 5).map((x: any) => `line ${x.line} (${x.text})`).join('; ')}</span>}
          <div className="scroll-x" style={{ maxHeight: 320 }}><table className="table"><thead><tr><th>Roll</th><th>Name in the file</th><th>Matched to</th><th>Subjects (marks, grade)</th><th className="num">Best 5 %</th><th>Result</th></tr></thead>
            <tbody>{preview.r.preview.map((x: any) => <tr key={x.roll}><td className="mono">{x.roll}</td><td>{x.name}</td><td>{x.matchedTo ?? <span style={{ color: 'var(--orange)' }}>not matched</span>}</td>
              <td className="tiny mono">{x.changes?.length ? x.changes.map((c: any) => `${c.code}: ${c.from} → ${c.to}`).join(' · ') : x.update ? 'no change (earlier marks better)' : x.subjects.map((s: any) => `${s.code} ${s.marks ?? 'AB'} ${s.grade}`).join(' · ')}</td><td className="num">{x.percentage}</td><td>{x.result}</td></tr>)}</tbody></table></div>
          <p className="tiny">Unmatched candidates are kept too; give the child’s record the CBSE roll number (Load numbers from CBSE) and upload again to link them.</p>
          <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy} onClick={saveResults}>Save these results</button><button className="btn quiet small" onClick={() => setPreview(null)}>Cancel</button></div>
        </div>}
        {!an.data?.candidates ? <Empty>No results loaded for {year}.</Empty> : <>
          <div className="kpis" style={{ marginTop: 10 }}><div><div className="kpi-label">Passed</div><div className="kpi-value">{an.data.passPct}%</div><div className="kpi-note">{an.data.passed} of {an.data.candidates}</div></div>
            <div><div className="kpi-label">Average (Best 5)</div><div className="kpi-value">{an.data.average}%</div></div><div><div className="kpi-label">90% and above</div><div className="kpi-value">{an.data.above90}</div></div></div>
          <h3 style={{ marginTop: 12 }}>Toppers</h3>{an.data.toppers.map((t: any, i: number) => <div key={t.roll_no} className="small">{i + 1}. {t.name} · {t.percentage}%</div>)}
          <h3 style={{ marginTop: 12 }}>Subjects</h3><table className="table"><thead><tr><th>Subject</th><th className="num">Average</th><th className="num">Highest</th><th className="num">Below 33</th></tr></thead><tbody>{an.data.subjects.map((s: any) => <tr key={s.code}><td>{s.name} <span className="tiny muted">{s.code}</span></td><td className="num">{s.average}</td><td className="num">{s.highest}</td><td className="num">{s.below33}</td></tr>)}</tbody></table>
          {an.data.compartment.length > 0 && <><h3 style={{ marginTop: 12 }}>Compartment and not passed</h3>{an.data.compartment.map((c: any) => <div key={c.roll_no} className="small">{c.roll_no} · {c.name} · {c.result}</div>)}</>}
        </>}</section>}
    </main>
  </>;
}

// ── Promotion ─────────────────────────────────────────────────────────────────────────────

const DECISION: Record<string, [string, string]> = { PROMOTE: ['Promoted', 'green'], DETAIN: ['Held back', 'orange'], COMPLETE: ['Completes school', 'blue'], LEAVE: ['Leaves', ''] };

export function Promotion({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const v = useLoad<any>(schoolId ? `/schools/${schoolId}/promotion` : null, [schoolId]);
  const [edit, setEdit] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const { run, busy } = useAction();
  const x = v.data;
  const lines = (x?.lines ?? []).filter((l: any) => !filter || l.from_class === filter);
  const classes = [...new Set((x?.lines ?? []).map((l: any) => l.from_class))] as string[];
  return <>
    <div className="localnav"><div className="localnav-in"><span className="localnav-title">Promotion to next year</span><span className="spacer" style={{ flex: 1 }} />{picker}
      {x && x.run?.status !== 'APPLIED' && <button className="btn quiet small" disabled={busy || (!x.run && !x.nextYearOpen)} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/promotion`, { body: {} }), 'Prepared from the year’s results')) v.reload(); }}>{x.run ? 'Prepare again' : 'Prepare the list'}</button>}
      {x?.run?.status === 'DRAFT' && user.role === 'SCHOOL_ADMIN' && <button className="btn small" disabled={busy} onClick={async () => { if (!await ask(`Move the school on to ${x.run.to_year}? Every child’s class is kept in their history; families are told.`)) return; const r: any = await run(() => api(`/promotion/${x.run.id}/apply`, { body: {} })); if (r) { await tell(`${r.promoted} promoted, ${r.detained} held back, ${r.completed} completed school.`); v.reload(); } }}>Apply</button>}</div></div>
    <main className="page">
      {!x ? <Empty>{v.error ?? 'Loading…'}</Empty> : !x.run ? <section className="tile"><h2>Moving on to {x.nextYear}</h2><p className="muted" style={{ marginTop: 6 }}>{x.nextYearOpen ? 'Prepare the list: each child’s decision is worked out from the year’s published results and their section next year follows. You can change any line before applying it.' : `NES has not opened ${x.nextYear} yet.`}</p>
        {!x.nextYearOpen && user.role === 'NES_ADMIN' && <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={async () => { if (await ask(`Open the academic year ${x.nextYear} (1 April to 31 March) for every school?`) && await run(() => api('/academic-years', { body: { code: x.nextYear } }), `${x.nextYear} opened`)) v.reload(); }}>Open {x.nextYear}</button>}</section> : <>
        <section className="tile"><p className="small">{x.run.from_year} → {x.run.to_year} · {x.run.status === 'APPLIED' ? `applied ${day(x.run.applied_at)}` : 'not applied yet'} · {x.lines.length} children</p>
          <p className="tiny muted" style={{ marginTop: 4 }}>No detention up to Class VII. Below 33% in VIII, IX and XI is held back. Class X goes on to XI (stream by merit and the family’s choice where XI sections have streams). Class XII completes school.</p>
          {(x.sections ?? []).filter((s: any) => s.class_code === 'XI').length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>{x.sections.filter((s: any) => s.class_code === 'XI').map((s: any) => <span key={s.id} className="pill">XI-{s.name}:
            {x.run.status === 'DRAFT' ? <select style={{ border: 0, background: 'transparent', font: 'inherit' }} value={s.stream ?? ''} onChange={async (e) => { if (await run(() => api(`/sections/${s.id}/stream`, { body: { stream: e.target.value || null } }), 'Saved; prepare again to allot')) v.reload(); }}><option value="">no stream</option>{Object.entries(x.streams).map(([k, l]) => <option key={k} value={k}>{String(l)}</option>)}</select> : ` ${s.stream ? x.streams[s.stream] : 'no stream'}`} · {s.allotted}/{s.capacity}</span>)}</div>}
          <div className="seg" style={{ marginTop: 10 }}><button className={!filter ? 'on' : ''} onClick={() => setFilter('')}>All</button>{classes.map((c) => <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>{c}</button>)}</div></section>
        <section className="tile"><div className="scroll-x"><table className="table"><thead><tr><th>Child</th><th>Now</th><th className="num">Result</th><th>Decision</th><th>Next year</th><th /></tr></thead>
          <tbody>{lines.map((l: any) => <tr key={l.enrolment_id}><td><b>{l.name}</b><span className="tiny muted" style={{ display: 'block' }}>{l.admission_no}{l.choices ? ` · wants ${l.choices.map((c: string) => x.streams[c]).join(', ')}` : ''}</span></td><td className="small">{l.from_class}-{l.from_section}</td>
            <td className="num">{l.percentage ?? '—'}</td><td><span className={`pill ${DECISION[l.decision][1]}`}>{DECISION[l.decision][0]}</span><span className="tiny muted" style={{ display: 'block' }}>{l.reason}</span></td>
            <td className="small" style={{ color: ['PROMOTE', 'DETAIN'].includes(l.decision) && !l.to_section ? 'var(--red)' : undefined }}>{l.to_section_name ? `${l.to_class}-${l.to_section_name}${l.stream ? ` · ${x.streams[l.stream]}` : ''}` : ['PROMOTE', 'DETAIN'].includes(l.decision) ? 'Choose a section' : '—'}</td>
            <td>{x.run.status === 'DRAFT' && <button className="linkbtn small" onClick={() => setEdit(l)}>Change</button>}</td></tr>)}</tbody></table></div></section>
      </>}
    </main>
    {edit && <LineDrawer runId={x.run.id} line={edit} sections={x.sections} streams={x.streams} onClose={() => { setEdit(null); v.reload(); }} />}
  </>;
}

function LineDrawer({ runId, line, sections, streams, onClose }: { runId: string; line: any; sections: any[]; streams: Record<string, string>; onClose: () => void }) {
  const [f, setF] = useState({ decision: line.decision, toSection: line.to_section ?? '', reason: '' });
  const { run, busy } = useAction();
  const ORD = ['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const target = f.decision === 'DETAIN' ? line.from_class : ORD[ORD.indexOf(line.from_class) + 1];
  return <Drawer title={line.name} onClose={onClose}><section className="tile tight stack">
    <div className="seg">{Object.entries(DECISION).map(([k, [l]]) => <button key={k} className={f.decision === k ? 'on' : ''} onClick={() => setF({ ...f, decision: k, toSection: '' })}>{l}</button>)}</div>
    {['PROMOTE', 'DETAIN'].includes(f.decision) && <label className="field"><span>Section next year (Class {target})</span><select className="input" value={f.toSection} onChange={(e) => setF({ ...f, toSection: e.target.value })}><option value="">Choose</option>
      {sections.filter((s) => s.class_code === target).map((s) => <option key={s.id} value={s.id}>{s.class_code}-{s.name}{s.stream ? ` · ${streams[s.stream]}` : ''} ({s.allotted}/{s.capacity})</option>)}</select></label>}
    {f.decision !== 'PROMOTE' && <label className="field"><span>Reason</span><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>}
    <button className="btn" disabled={busy || (['PROMOTE', 'DETAIN'].includes(f.decision) && !f.toSection) || (f.decision !== 'PROMOTE' && f.reason.trim().length < 3)} onClick={async () => { if (await run(() => api(`/promotion/${runId}/lines/${line.enrolment_id}`, { body: { decision: f.decision, toSection: f.toSection || null, reason: f.reason || undefined } }), 'Changed')) onClose(); }}>Save</button>
  </section></Drawer>;
}
