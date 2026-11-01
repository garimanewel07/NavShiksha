import { useEffect, useMemo, useState } from 'react';
import { api, day, hasDuty, today, words, type User } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';
import { SectionPicker, useMySections } from './SchoolLife';

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KINDS: [string, string][] = [['PERIOD', 'Period'], ['ASSEMBLY', 'Assembly'], ['CLASS_TEACHER', 'Class teacher time'], ['BREAK', 'Break'], ['LUNCH', 'Lunch'], ['ACTIVITY', 'Activity']];
const CLASSES = ['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const plus = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface BellSlot { weekday: number; seq: number; kind: string; label: string; period_no: number | null; starts: string; ends: string }
interface Lesson { weekday: number; period: number; starts: string; ends: string; subject: string; subject_code: string; teacher?: string | null; teacher_id?: string | null; section?: string }

type Tab = 'week' | 'cover' | 'timings' | 'special' | 'generator' | 'register';

export default function Timetable({ user }: { user: User }) {
  const manager = user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN' || hasDuty(user, 'TIMETABLE_COORDINATOR');
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) || 'week');
  const tabs: [Tab, string][] = manager
    ? [['week', 'Week'], ['cover', 'Cover'], ['timings', 'School timings'], ['special', 'Special days'], ['generator', 'Generator'], ['register', 'Proxy register']]
    : [['week', 'Week']];
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Timetable</span>
        {tabs.length > 1 && <div className="seg" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}
        <span className="spacer" />
        {manager && <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />}
      </div></div>
      <main className="page">
        {tab === 'week' && <Week user={user} manager={manager} schoolId={schoolId} />}
        {tab === 'cover' && schoolId && <Cover schoolId={schoolId} />}
        {tab === 'timings' && schoolId && <Timings schoolId={schoolId} />}
        {tab === 'special' && schoolId && <SpecialDays schoolId={schoolId} />}
        {tab === 'generator' && schoolId && <Generator schoolId={schoolId} />}
        {tab === 'register' && schoolId && <Register schoolId={schoolId} />}
      </main>
    </>
  );
}

// ── Week ──────────────────────────────────────────────────────────────────────────────────

/** Days side by side; each day lists its own timings, with breaks shown as bars. */
function WeekGrid({ bell, lessons, mineId, showClass, classTeacherId }: { bell: BellSlot[] | null; lessons: Lesson[]; mineId?: string; showClass?: boolean; classTeacherId?: string | null }) {
  const days = [1, 2, 3, 4, 5, 6].filter((d) => (bell ?? []).some((b) => b.weekday === d) || lessons.some((l) => l.weekday === d));
  if (!days.length) return <Empty>No timetable yet.</Empty>;
  return (
    <div className="scroll-x"><div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(150px, 1fr))`, gap: 10, minWidth: days.length * 160 }}>
      {days.map((d) => {
        const frame = bell ? bell.filter((b) => b.weekday === d) : lessons.filter((l) => l.weekday === d).sort((a, b) => toMin(a.starts) - toMin(b.starts)).map((l) => ({ weekday: d, seq: l.period, kind: 'PERIOD', label: `Period ${l.period}`, period_no: l.period, starts: l.starts, ends: l.ends }));
        return (
          <div key={d} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="small" style={{ fontWeight: 600, padding: '0 4px 4px' }}>{DAY_NAMES[d]}</div>
            {frame.map((b, i) => {
              if (b.kind !== 'PERIOD') return <div key={i} className="tiny" style={{ background: 'var(--line-soft)', borderRadius: 8, padding: '4px 10px', color: 'var(--ink-2)', display: 'flex', justifyContent: 'space-between' }}><span>{b.label}</span><span>{b.starts}</span></div>;
              const l = lessons.find((x) => x.weekday === d && x.period === b.period_no);
              return (
                <div key={i} className={`slot${l && mineId && l.teacher_id === mineId ? ' mine' : ''}`} style={{ background: l ? (mineId && l.teacher_id === mineId ? 'var(--blue-soft)' : '#fff') : 'var(--fill)', border: '1px solid var(--line-soft)', borderRadius: 12, padding: '8px 10px', minHeight: 58 }}>
                  <div className="tiny muted">P{b.period_no}{b.starts ? ` · ${b.starts}–${b.ends}` : ''}</div>
                  {l ? <><b style={{ display: 'block', fontSize: '0.88rem' }}>{showClass ? `${l.section} · ` : ''}{l.subject}</b><span className="tiny muted">{showClass ? '' : l.teacher ?? 'No teacher'}</span>{classTeacherId && l.teacher_id === classTeacherId && <span className="tiny" style={{ color: 'var(--blue)', fontWeight: 600 }}> · Class teacher</span>}</> : <span className="tiny muted">Free</span>}
                </div>);
            })}
          </div>);
      })}
    </div></div>
  );
}

function Week({ user, manager, schoolId }: { user: User; manager: boolean; schoolId: string }) {
  const sections = useMySections();
  const [mode, setMode] = useState<'mine' | 'class'>(user.role === 'TEACHER' ? 'mine' : 'class');
  const [sectionId, setSectionId] = useState('');
  useEffect(() => { if (sections?.length && !sections.some((s) => s.id === sectionId)) setSectionId((sections.find((s) => s.has_timetable && (!schoolId || s.school_id === schoolId)) ?? sections[0]).id); }, [sections, sectionId, schoolId]);
  const mine = useLoad<Lesson[]>(mode === 'mine' ? '/my/timetable' : null, [mode]);
  const tt = useLoad<any>(mode === 'class' && sectionId ? `/sections/${sectionId}/timetable` : null, [mode, sectionId]);
  const [editing, setEditing] = useState(false);
  const secs = (sections ?? []).filter((s) => !schoolId || !manager || s.school_id === schoolId);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>{mode === 'mine' ? 'My week' : tt.data?.section ?? ''}</h2>
          {mode === 'class' && <p className="muted" style={{ marginTop: 6 }}>{tt.data?.from ? `In force from ${day(tt.data.from)}` : 'No timetable yet'}{tt.data?.bell ? ` · timings: ${tt.data.bell.name}` : ''}{tt.data?.class_teacher ? ` · class teacher ${tt.data.class_teacher}` : ' · no class teacher'}{tt.data?.co_class_teacher ? `, co-class teacher ${tt.data.co_class_teacher}` : ''}</p>}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {user.role === 'TEACHER' && <div className="seg"><button className={mode === 'mine' ? 'on' : ''} onClick={() => setMode('mine')}>My week</button><button className={mode === 'class' ? 'on' : ''} onClick={() => setMode('class')}>A class</button></div>}
          {mode === 'class' && sections && <SectionPicker sections={secs} value={sectionId} onChange={setSectionId} />}
          {mode === 'class' && manager && <button className="btn small" onClick={() => setEditing(true)}>Edit</button>}
        </div>
      </div>
      {mode === 'mine' ? (!mine.data ? <Empty>Loading…</Empty> : <WeekGrid bell={null} lessons={mine.data} showClass />)
        : (!tt.data ? <Empty>Loading…</Empty> : <WeekGrid bell={tt.data.bell?.slots ?? null} lessons={tt.data.slots} mineId={user.id} classTeacherId={tt.data.classTeacherId} />)}
      {editing && tt.data && <EditWeek data={tt.data} schoolId={secs.find((s) => s.id === sectionId)?.school_id ?? schoolId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); tt.reload(); }} />}
    </section>
  );
}

function EditWeek({ data, schoolId, onClose, onSaved }: { data: any; schoolId: string; onClose: () => void; onSaved: () => void }) {
  const { data: subjects } = useLoad<any[]>('/subjects');
  const { data: teachers } = useLoad<any[]>(`/schools/${schoolId}/teachers`);
  const [from, setFrom] = useState(plus(1));
  const [grid, setGrid] = useState<Record<string, { subjectCode: string; teacherId: string }>>(() =>
    Object.fromEntries((data.slots as Lesson[]).map((s) => [`${s.weekday}:${s.period}`, { subjectCode: s.subject_code, teacherId: s.teacher_id ?? '' }])));
  const { run, busy } = useAction();
  const bell: BellSlot[] = data.bell?.slots ?? [];
  const days = [1, 2, 3, 4, 5, 6].filter((d) => bell.some((b) => b.weekday === d && b.kind === 'PERIOD'));
  const set = (k: string, v: Partial<{ subjectCode: string; teacherId: string }>) => setGrid((g) => ({ ...g, [k]: { ...(g[k] ?? { subjectCode: '', teacherId: '' }), ...v } }));
  return (
    <Drawer title={`Edit ${data.section}`} onClose={onClose}>
      {!bell.length ? <div className="callout orange">This class has no school timings. Set them under School timings first.</div> : <>
        <p className="muted small">Times come from “{data.bell.name}”. Changes start on the date you choose; earlier days keep the old timetable. A teacher cannot be put in two classes at once.</p>
        <label className="field"><span>In force from</span><input className="input" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        {days.map((d) => (
          <div key={d} className="tile tight" style={{ padding: 14 }}>
            <b>{DAY_NAMES[d]}</b>
            {bell.filter((b) => b.weekday === d && b.kind === 'PERIOD').map((b) => { const k = `${d}:${b.period_no}`; const v = grid[k] ?? { subjectCode: '', teacherId: '' }; return (
              <div key={k} style={{ display: 'grid', gridTemplateColumns: '84px 1fr 1fr', gap: 6, marginTop: 6, alignItems: 'center' }}>
                <span className="tiny muted">P{b.period_no} · {b.starts}</span>
                <select className="input" style={{ height: 36 }} value={v.subjectCode} onChange={(e) => set(k, { subjectCode: e.target.value })} aria-label={`${DAY_NAMES[d]} period ${b.period_no} subject`}><option value="">Free</option>{(subjects ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
                <select className="input" style={{ height: 36 }} value={v.teacherId} disabled={!v.subjectCode} onChange={(e) => set(k, { teacherId: e.target.value })} aria-label={`${DAY_NAMES[d]} period ${b.period_no} teacher`}><option value="">No teacher</option>{(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </div>); })}
          </div>))}
        <button className="btn big" disabled={busy} onClick={async () => {
          const slots = Object.entries(grid).filter(([, v]) => v.subjectCode).map(([k, v]) => { const [wd, p] = k.split(':').map(Number); return { weekday: wd, period: p, subjectCode: v.subjectCode, teacherId: v.teacherId || null }; });
          if (await run(() => api(`/sections/${data.sectionId}/timetable`, { method: 'PUT', body: { from, slots } }), 'Timetable published')) onSaved();
        }}>Publish timetable</button>
      </>}
    </Drawer>
  );
}

// ── Cover ─────────────────────────────────────────────────────────────────────────────────

function Cover({ schoolId }: { schoolId: string }) {
  const [date, setDate] = useState(today());
  const { data: b, reload } = useLoad<any>(`/schools/${schoolId}/cover?date=${date}`, [schoolId, date]);
  const { data: teachers } = useLoad<any[]>(`/schools/${schoolId}/teachers`, [schoolId]);
  const [absent, setAbsent] = useState(false);
  const [limits, setLimits] = useState(false);
  const toast = useToast();
  const { run, busy } = useAction();
  const assign = async (n: any, body: Record<string, unknown>) => {
    if (await run(() => api(`/schools/${schoolId}/cover`, { body: { date, sectionId: n.section_id, period: n.period, ...body } }))) reload();
  };
  const past = date < today();
  return (
    <>
      <section className="tile">
        <div className="tile-head">
          <div><h2>Cover for {date === today() ? 'today' : day(date)}</h2>
            <p className="muted" style={{ marginTop: 6 }}>{b ? (b.holiday ? `${b.holiday} — no classes.` : b.needs.length ? `${b.needs.length} lessons need cover · ${b.covered} arranged · ${b.uncovered} open` : 'No lessons need cover.') : 'Loading…'}</p></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" type="date" style={{ height: 36, width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            <button className="btn secondary small" disabled={past} onClick={() => setAbsent(true)}>Mark a teacher absent</button>
            <button className="btn small" disabled={busy || past || !b?.uncovered} onClick={async () => {
              const r = await run(() => api<{ assigned: unknown[]; uncovered: unknown[] }>(`/schools/${schoolId}/cover/auto`, { body: { date } }));
              if (r) { toast(`${r.assigned.length} lessons covered${r.uncovered.length ? ` · ${r.uncovered.length} need you to decide` : ''}. Cover teachers have been notified.`); reload(); }
            }}>Fill all automatically</button>
          </div>
        </div>
        {b?.classTeacherCover?.length > 0 && <div className="callout small" style={{ marginBottom: 12 }}>{b.classTeacherCover.map((c: any) => <div key={c.sectionId}><strong>{c.label}</strong>: {c.classTeacher} is away. {c.acting ? `${c.acting} (co-class teacher) takes the roll and leave approvals today.` : 'No co-class teacher is free. The principal or attendance officer takes the roll.'}</div>)}</div>}
        {b?.plans?.length > 0 && <div className="callout blue small" style={{ marginBottom: 12 }}>{b.plans.map((p: any) => `${p.title} (${p.classes ? p.classes.join(', ') : 'all classes'})`).join(' · ')}</div>}
        {b?.absences?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {b.absences.map((a: any) => <span key={a.id} className="pill orange" style={{ height: 30, gap: 8 }}>{a.teacher} · {a.periods ? `periods ${a.periods.join(', ')}` : 'whole day'} · {a.reason}
              {!past && <button className="linkbtn tiny" onClick={async () => { if (await run(() => api(`/absences/${a.id}/withdraw`, { method: 'POST' }), 'Absence withdrawn')) reload(); }}>Undo</button>}</span>)}
          </div>)}
        {!b ? <Empty>Loading…</Empty> : b.needs.length === 0 ? <Empty>{b.absences.length ? 'Their lessons are already cancelled or there are none today.' : 'Mark a teacher absent to see the lessons that need cover.'}</Empty> : (
          <div className="scroll-x"><table className="table"><thead><tr><th>Time</th><th>Class</th><th>Lesson</th><th>Cover</th><th /></tr></thead><tbody>
            {b.needs.map((n: any) => (
              <tr key={`${n.section_id}:${n.period}`}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}><b>P{n.period}</b> {n.starts}–{n.ends}</td>
                <td><b>{n.label}</b></td>
                <td>{n.subject}<div className="tiny muted">{n.teacher} is absent</div></td>
                <td style={{ minWidth: 260 }}>{n.cover ? (
                  <span><span className="pill green">{n.cover.kind === 'PROXY' ? n.cover.substitute : n.cover.kind === 'MERGE' ? `Merged with ${n.cover.merged_label}` : 'Supervised study'}</span>{n.cover.auto && <span className="tiny muted" style={{ marginLeft: 6 }}>filled automatically</span>}</span>
                ) : past ? <span className="pill red">Not covered</span> : (
                  <select className="input" style={{ height: 36 }} defaultValue="" onChange={(e) => {
                    const v = e.target.value; if (!v) return;
                    if (v === 'STUDY') assign(n, { kind: 'STUDY' }); else assign(n, { kind: 'PROXY', substituteId: v });
                  }} aria-label={`Cover for ${n.label} period ${n.period}`}>
                    <option value="">Choose cover…</option>
                    {n.suggestions.map((c: any) => <option key={c.id} value={c.id}>{c.withinLimits ? '' : '⚠ '}{c.name} — {c.reasons.join(' · ')}</option>)}
                    <option value="STUDY">Supervised study (no teacher)</option>
                  </select>)}</td>
                <td className="num">{n.cover && !past && <button className="linkbtn small" onClick={async () => { if (await run(() => api(`/schools/${schoolId}/cover?date=${date}&sectionId=${n.section_id}&period=${n.period}`, { method: 'DELETE' }))) reload(); }}>Change</button>}</td>
              </tr>))}
          </tbody></table></div>)}
        <p className="tiny muted" style={{ marginTop: 12 }}>Suggestions put teachers who teach the subject or the class first, then those with the least cover this week. Limits: {b?.limits.max_proxy_day} a day, {b?.limits.max_proxy_week} a week, {b?.limits.max_periods_day} periods a day in all. <button className="linkbtn tiny" onClick={() => setLimits(true)}>Change limits</button></p>
      </section>
      {absent && <MarkAbsent schoolId={schoolId} date={date} teachers={teachers ?? []} onClose={() => setAbsent(false)} onSaved={() => { setAbsent(false); reload(); }} />}
      {limits && b && <Limits schoolId={schoolId} value={b.limits} onClose={() => setLimits(false)} onSaved={() => { setLimits(false); reload(); }} />}
    </>
  );
}

function MarkAbsent({ schoolId, date, teachers, onClose, onSaved }: { schoolId: string; date: string; teachers: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ teacherId: '', from: date, to: date, whole: true, periods: [] as number[], reason: '' });
  const { run, busy } = useAction();
  return (
    <Drawer title="Mark a teacher absent" onClose={onClose}>
      <label className="field"><span>Teacher</span><select className="input" value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value })}><option value="">Choose…</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <div className="form-grid">
        <label className="field"><span>From</span><input className="input" type="date" min={today()} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></label>
        <label className="field"><span>To</span><input className="input" type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      <div className="seg" style={{ alignSelf: 'flex-start' }}><button className={f.whole ? 'on' : ''} onClick={() => setF({ ...f, whole: true })}>Whole day</button><button className={!f.whole ? 'on' : ''} onClick={() => setF({ ...f, whole: false })}>Some periods</button></div>
      {!f.whole && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
        <label key={p} className="check" style={{ background: 'var(--tile)', borderRadius: 10, padding: '6px 10px' }}><input type="checkbox" checked={f.periods.includes(p)} onChange={(e) => setF({ ...f, periods: e.target.checked ? [...f.periods, p] : f.periods.filter((x) => x !== p) })} />P{p}</label>))}</div>}
      <label className="field"><span>Reason</span><input className="input" value={f.reason} maxLength={200} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Medical leave, training, duty…" /></label>
      <button className="btn big" disabled={busy || !f.teacherId || f.reason.trim().length < 2 || (!f.whole && !f.periods.length)} onClick={async () => {
        const r = await run(() => api<{ coverReleased: number }>(`/schools/${schoolId}/absences`, { body: { teacherId: f.teacherId, from: f.from, to: f.to, periods: f.whole ? null : f.periods, reason: f.reason } }), 'Marked absent. Their lessons are now listed for cover.');
        if (r) onSaved();
      }}>Mark absent</button>
    </Drawer>
  );
}

function Limits({ schoolId, value, onClose, onSaved }: { schoolId: string; value: any; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(value);
  const { run, busy } = useAction();
  return (
    <Drawer title="Cover limits" onClose={onClose}>
      <p className="muted small">Automatic cover never goes beyond these. You can still choose any free teacher by hand.</p>
      {([['max_proxy_day', 'Most cover lessons per teacher per day', 0, 8], ['max_proxy_week', 'Most cover lessons per teacher per week', 0, 30], ['max_periods_day', 'Most periods per teacher per day, cover included', 1, 12]] as const).map(([k, l, lo, hi]) => (
        <label key={k} className="field"><span>{l}</span><input className="input" type="number" min={lo} max={hi} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></label>))}
      <button className="btn big" disabled={busy} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/timetable-settings`, { method: 'PUT', body: v }), 'Limits saved')) onSaved(); }}>Save</button>
    </Drawer>
  );
}

// ── School timings ────────────────────────────────────────────────────────────────────────

interface EditRow { kind: string; label: string; starts: string; ends: string }

function Timings({ schoolId }: { schoolId: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/bells`, [schoolId]);
  const [editing, setEditing] = useState<any>(null);
  return (
    <>
      <section className="tile">
        <div className="tile-head">
          <div><h2>School timings</h2><p className="muted" style={{ marginTop: 6 }}>Periods, assembly, breaks and lunch for each group of classes. Changing them updates every class timetable from the date you choose.</p></div>
          <button className="btn small" onClick={() => setEditing({ name: '', class_codes: [], slots: [] })}>New timings</button>
        </div>
        {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No timings yet.</Empty> : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {data.map((b) => {
              const mon = b.slots.filter((s: BellSlot) => s.weekday === 1);
              const periods = mon.filter((s: BellSlot) => s.kind === 'PERIOD').length;
              return (
                <article key={b.id} className="tile tight" style={{ background: 'var(--fill)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{b.name}</b><button className="linkbtn small" onClick={() => setEditing(b)}>Change</button></div>
                  <div className="small muted" style={{ marginTop: 4 }}>Classes {b.class_codes.join(', ')}</div>
                  <div className="small muted">{b.from > today() ? `Starts ${day(b.from)}` : `Since ${day(b.from)}`}{b.to ? ` · until ${day(b.to)}` : ''}</div>
                  <div className="small" style={{ marginTop: 8 }}>Monday {mon[0]?.starts}–{mon[mon.length - 1]?.ends} · {periods} periods · {mon.filter((s: BellSlot) => s.kind !== 'PERIOD').map((s: BellSlot) => s.label).join(', ')}</div>
                </article>);
            })}
          </div>)}
      </section>
      {editing && <TimingsEditor schoolId={schoolId} base={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function TimingsEditor({ schoolId, base, onClose, onSaved }: { schoolId: string; base: any; onClose: () => void; onSaved: () => void }) {
  const initial = useMemo(() => {
    const byDay: Record<number, EditRow[]> = {};
    for (let d = 1; d <= 6; d++) byDay[d] = (base.slots as BellSlot[]).filter((s) => s.weekday === d).map((s) => ({ kind: s.kind, label: s.label, starts: s.starts, ends: s.ends }));
    if (!base.slots.length) for (let d = 1; d <= 5; d++) byDay[d] = [{ kind: 'ASSEMBLY', label: 'Assembly', starts: '07:40', ends: '08:00' }, ...Array.from({ length: 8 }, (_, i) => ({ kind: 'PERIOD', label: `Period ${i + 1}`, starts: fromMin(480 + i * 40), ends: fromMin(520 + i * 40) }))];
    return byDay;
  }, [base]);
  const [rows, setRows] = useState(initial);
  const [d, setD] = useState(1);
  const [name, setName] = useState(base.name || 'School timings');
  const [classes, setClasses] = useState<string[]>(base.class_codes);
  const [from, setFrom] = useState(plus(1));
  const { run, busy } = useAction();
  const toast = useToast();
  const list = rows[d] ?? [];
  const update = (i: number, k: keyof EditRow, v: string) => setRows({ ...rows, [d]: list.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  const add = (kind: string) => {
    const last = list[list.length - 1];
    const start = last ? last.ends : '08:00';
    const len = kind === 'PERIOD' ? 40 : kind === 'LUNCH' ? 30 : 15;
    setRows({ ...rows, [d]: [...list, { kind, label: kind === 'PERIOD' ? 'Period' : words(kind), starts: start, ends: fromMin(toMin(start) + len) }] });
  };
  const numbered = (r: EditRow[]) => { let n = 0; return r.map((x) => ({ ...x, periodNo: x.kind === 'PERIOD' ? ++n : null })); };
  return (
    <Drawer title={base.id ? `Change ${base.name}` : 'New school timings'} onClose={onClose}>
      <p className="muted small">The new timings start on the date below; earlier days keep the old ones. Class timetables move to the new times automatically. If a change would put a teacher in two classes at once, it is refused and nothing changes.</p>
      <div className="form-grid">
        <label className="field"><span>Name</span><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Start from</span><input className="input" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      </div>
      <div className="field"><span>Classes that follow these timings</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{CLASSES.map((c) => <label key={c} className="check" style={{ background: classes.includes(c) ? 'var(--blue-soft)' : '#fff', borderRadius: 10, padding: '5px 10px' }}>
          <input type="checkbox" checked={classes.includes(c)} onChange={(e) => setClasses(e.target.checked ? [...classes, c] : classes.filter((x) => x !== c))} />{c}</label>)}</div></div>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>{[1, 2, 3, 4, 5, 6].map((x) => <button key={x} className={d === x ? 'on' : ''} onClick={() => setD(x)}>{DAYS[x]}{!(rows[x] ?? []).length ? ' ·' : ''}</button>)}</div>
      <div className="tile tight" style={{ padding: 12, display: 'grid', gap: 6 }}>
        {list.length === 0 && <p className="small muted">No school on {DAY_NAMES[d]}. Add rows, or copy another day.</p>}
        {numbered(list).map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr) 118px 118px 32px', gap: 6, alignItems: 'center' }}>
            <select className="input" style={{ height: 36 }} value={r.kind} onChange={(e) => update(i, 'kind', e.target.value)} aria-label="Kind">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input className="input" style={{ height: 36 }} value={r.kind === 'PERIOD' ? `Period ${r.periodNo}` : r.label} disabled={r.kind === 'PERIOD'} onChange={(e) => update(i, 'label', e.target.value)} aria-label="Label" />
            <input className="input" style={{ height: 36 }} type="time" value={r.starts} onChange={(e) => update(i, 'starts', e.target.value)} aria-label="Starts" />
            <input className="input" style={{ height: 36 }} type="time" value={r.ends} onChange={(e) => update(i, 'ends', e.target.value)} aria-label="Ends" />
            <button className="icon-btn" title="Remove" onClick={() => setRows({ ...rows, [d]: list.filter((_, j) => j !== i) })}>×</button>
          </div>))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button className="btn quiet small" onClick={() => add('PERIOD')}>+ Period</button>
          <button className="btn quiet small" onClick={() => add('BREAK')}>+ Break</button>
          <button className="btn quiet small" onClick={() => add('LUNCH')}>+ Lunch</button>
          <button className="btn quiet small" onClick={() => add('ACTIVITY')}>+ Activity</button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="linkbtn small" onClick={() => { const n = { ...rows }; for (let x = 1; x <= 5; x++) n[x] = list.map((r) => ({ ...r })); setRows(n); toast(`${DAY_NAMES[d]} copied to Monday–Friday`); }}>Copy to Mon–Fri</button>
          <button className="linkbtn small" onClick={() => setRows({ ...rows, [d]: [] })}>Clear day</button>
        </div>
      </div>
      <button className="btn big" disabled={busy || !classes.length || name.trim().length < 2} onClick={async () => {
        const slots = Object.entries(rows).flatMap(([wd, r]) => numbered(r).map((x) => ({ weekday: Number(wd), kind: x.kind, label: x.kind === 'PERIOD' ? `Period ${x.periodNo}` : x.label, periodNo: x.periodNo, starts: x.starts, ends: x.ends })));
        const r = await run(() => api<{ timetablesUpdated: number; droppedPeriods: string[] }>(`/schools/${schoolId}/bells`, { body: { name, classCodes: classes, from, slots } }));
        if (r) { toast(`Timings saved from ${day(from)}. ${r.timetablesUpdated} class timetables moved to the new times.${r.droppedPeriods.length ? ` ${r.droppedPeriods.length} lessons fell outside the new periods and were removed.` : ''}`); onSaved(); }
      }}>Save timings</button>
    </Drawer>
  );
}

// ── Special days ──────────────────────────────────────────────────────────────────────────

function SpecialDays({ schoolId }: { schoolId: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/day-plans?from=${today()}`, [schoolId]);
  const [adding, setAdding] = useState(false);
  const { run } = useAction();
  const label: Record<string, string> = { EVENT: 'Event', EXAM: 'Exam', SHORT_DAY: 'Short day', NO_CLASSES: 'No classes' };
  return (
    <>
      <section className="tile">
        <div className="tile-head">
          <div><h2>Special days</h2><p className="muted" style={{ marginTop: 6 }}>Events, exams and short days that change the normal timetable. Teachers freed by them become available for cover.</p></div>
          <button className="btn small" onClick={() => setAdding(true)}>Plan a special day</button>
        </div>
        {!data ? <Empty>Loading…</Empty> : data.filter((p) => !p.withdrawn_at).length === 0 ? <Empty>Nothing planned.</Empty> : data.filter((p) => !p.withdrawn_at).map((p) => (
          <div key={p.id} className="list-row" style={{ gridTemplateColumns: '56px 1fr auto auto' }}>
            <span className="date-chip"><b>{new Date(`${p.on_date}T00:00:00`).getDate()}</b><span>{new Date(`${p.on_date}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</span></span>
            <span><b>{p.title}</b><div className="small muted">{p.class_codes ? `Classes ${p.class_codes.join(', ')}` : 'All classes'} · {p.kind === 'SHORT_DAY' ? `${p.alt_slots.length} periods, ${p.alt_slots[0].starts}–${p.alt_slots[p.alt_slots.length - 1].ends}` : p.kind === 'NO_CLASSES' ? 'no regular classes' : `periods ${p.cancelled_periods.join(', ')} replaced`}</div></span>
            <span className="pill blue">{label[p.kind]}</span>
            <button className="linkbtn small" onClick={async () => { if (await run(() => api(`/day-plans/${p.id}/withdraw`, { method: 'POST' }), 'Removed. The normal timetable applies.')) reload(); }}>Remove</button>
          </div>))}
      </section>
      {adding && <AddSpecialDay schoolId={schoolId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function AddSpecialDay({ schoolId, onClose, onSaved }: { schoolId: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ date: plus(7), all: true, classes: [] as string[], kind: 'EVENT', title: '', periods: [] as number[], firstStart: '08:00', minutes: 30, count: 6, breakAfter: 3, breakMinutes: 15, notify: true });
  const { run, busy } = useAction();
  const preview = f.kind === 'SHORT_DAY' ? (() => { const out: string[] = []; let m = toMin(f.firstStart); for (let p = 1; p <= f.count; p++) { out.push(`P${p} ${fromMin(m)}`); m += f.minutes + (p === f.breakAfter ? f.breakMinutes : 0); } return `${out.join(' · ')} · ends ${fromMin(m - (f.count === f.breakAfter ? f.breakMinutes : 0))}`; })() : '';
  return (
    <Drawer title="Plan a special day" onClose={onClose}>
      <div className="form-grid">
        <label className="field"><span>Date</span><input className="input" type="date" min={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="field"><span>What happens</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="EVENT">An event replaces some periods</option><option value="EXAM">An exam replaces some periods</option><option value="SHORT_DAY">Short day on different timings</option><option value="NO_CLASSES">No regular classes all day</option></select></label>
      </div>
      <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Annual Day rehearsal" /></label>
      <div className="field"><span>Classes</span>
        <label className="check"><input type="checkbox" checked={f.all} onChange={(e) => setF({ ...f, all: e.target.checked })} />All classes</label>
        {!f.all && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{CLASSES.map((c) => <label key={c} className="check" style={{ background: f.classes.includes(c) ? 'var(--blue-soft)' : '#fff', borderRadius: 10, padding: '5px 10px' }}>
          <input type="checkbox" checked={f.classes.includes(c)} onChange={(e) => setF({ ...f, classes: e.target.checked ? [...f.classes, c] : f.classes.filter((x) => x !== c) })} />{c}</label>)}</div>}</div>
      {(f.kind === 'EVENT' || f.kind === 'EXAM') && <div className="field"><span>Periods it replaces</span><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
        <label key={p} className="check" style={{ background: f.periods.includes(p) ? 'var(--blue-soft)' : '#fff', borderRadius: 10, padding: '5px 10px' }}><input type="checkbox" checked={f.periods.includes(p)} onChange={(e) => setF({ ...f, periods: e.target.checked ? [...f.periods, p] : f.periods.filter((x) => x !== p) })} />P{p}</label>))}</div></div>}
      {f.kind === 'SHORT_DAY' && <>
        <div className="form-grid">
          <label className="field"><span>First period starts</span><input className="input" type="time" value={f.firstStart} onChange={(e) => setF({ ...f, firstStart: e.target.value })} /></label>
          <label className="field"><span>Minutes per period</span><input className="input" type="number" min={15} max={60} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></label>
          <label className="field"><span>Periods</span><input className="input" type="number" min={1} max={12} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></label>
          <label className="field"><span>Break after period</span><input className="input" type="number" min={0} max={12} value={f.breakAfter} onChange={(e) => setF({ ...f, breakAfter: Number(e.target.value) })} /></label>
          <label className="field"><span>Break minutes</span><input className="input" type="number" min={0} max={60} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: Number(e.target.value) })} /></label>
        </div>
        <p className="small muted">{preview}</p>
      </>}
      <label className="check"><input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />Tell parents of these classes</label>
      <button className="btn big" disabled={busy || f.title.trim().length < 2 || (!f.all && !f.classes.length) || ((f.kind === 'EVENT' || f.kind === 'EXAM') && !f.periods.length)} onClick={async () => {
        const body = { date: f.date, classCodes: f.all ? null : f.classes, kind: f.kind, title: f.title, cancelledPeriods: f.periods, notifyParents: f.notify,
          shortDay: f.kind === 'SHORT_DAY' ? { firstStart: f.firstStart, minutes: f.minutes, periods: f.count, breakAfter: f.breakAfter, breakMinutes: f.breakMinutes } : undefined };
        if (await run(() => api(`/schools/${schoolId}/day-plans`, { body }), 'Special day planned')) onSaved();
      }}>Plan it</button>
    </Drawer>
  );
}

// ── Generator ─────────────────────────────────────────────────────────────────────────────

function Generator({ schoolId }: { schoolId: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/loads`, [schoolId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [from, setFrom] = useState(plus(1));
  const [proposal, setProposal] = useState<any>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const withLoad = (data ?? []).filter((s) => s.load.length);
  return (
    <>
      <section className="tile">
        <div className="tile-head">
          <div><h2>Timetable generator</h2><p className="muted" style={{ marginTop: 6 }}>Enter each class's subjects, periods a week and teacher. The generator places every lesson with no teacher in two classes at once, spreads subjects through the week and respects each teacher's daily limit. You review before anything changes.</p></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="small muted">From <input className="input" type="date" min={today()} style={{ height: 36, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <button className="btn small" disabled={busy || !picked.length} onClick={async () => { const r = await run(() => api('/schools/' + schoolId + '/generate', { body: { sectionIds: picked, from } })); if (r) setProposal(r); }}>Generate for {picked.length || 'selected'} {picked.length === 1 ? 'class' : 'classes'}</button>
          </div>
        </div>
        {!data ? <Empty>Loading…</Empty> : (
          <div className="scroll-x"><table className="table"><thead><tr><th><input type="checkbox" aria-label="Select all with a load" checked={withLoad.length > 0 && picked.length === withLoad.length} onChange={(e) => setPicked(e.target.checked ? withLoad.map((s) => s.id) : [])} /></th><th>Class</th><th>Subjects</th><th className="num">Periods a week</th><th /></tr></thead><tbody>
            {[...data].sort((a, b) => Number(b.load.length > 0) - Number(a.load.length > 0)).map((s) => (
              <tr key={s.id}>
                <td><input type="checkbox" aria-label={`Select ${s.label}`} disabled={!s.load.length} checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} /></td>
                <td style={{ whiteSpace: 'nowrap' }}><b>{s.label}</b></td>
                <td className="small">{s.load.length ? s.load.map((l: any) => `${l.subject} ${l.periods_per_week}${l.teacher ? ` (${l.teacher.replace(/^(Mrs|Mr|Ms) /, '')})` : ''}`).join(' · ') : <span className="muted">Not set</span>}</td>
                <td className="num">{s.total || '—'}</td>
                <td className="num"><button className="linkbtn small" onClick={() => setEditing(s)}>{s.load.length ? 'Edit' : 'Set load'}</button></td>
              </tr>))}
          </tbody></table></div>)}
      </section>
      {proposal && (
        <section className="tile">
          <div className="tile-head">
            <div><h2>Proposal from {day(proposal.from)}</h2><p className={proposal.complete ? 'muted' : ''} style={{ marginTop: 6, color: proposal.complete ? undefined : 'var(--orange)' }}>{proposal.note}</p>{proposal.notes?.map((n: string) => <p key={n} className="small" style={{ marginTop: 4, color: 'var(--orange)' }}>{n}</p>)}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn quiet small" onClick={() => setProposal(null)}>Discard</button>
              <button className="btn small" disabled={busy} onClick={async () => {
                const r = await run(() => api(`/schools/${schoolId}/generate/publish`, { body: { from: proposal.from, sections: proposal.sections.map((x: any) => ({ sectionId: x.sectionId, slots: x.slots.map((y: any) => ({ weekday: y.weekday, period: y.period, subjectCode: y.subjectCode, teacherId: y.teacherId })) })) } }));
                if (r) { toast(`Published ${proposal.sections.length} timetables from ${day(proposal.from)}`); setProposal(null); reload(); }
              }}>Publish these timetables</button>
            </div>
          </div>
          {proposal.sections.map((s: any) => (
            <div key={s.sectionId} style={{ marginTop: 18 }}>
              <h3 style={{ marginBottom: 8 }}>{s.label}{s.unplaced.length > 0 && <span className="pill orange" style={{ marginLeft: 8 }}>{s.unplaced.length} not placed: {s.unplaced.map((u: any) => u.subject).join(', ')}</span>}</h3>
              <WeekGrid bell={null} lessons={s.slots.map((x: any) => ({ ...x, starts: '', ends: '', subject_code: x.subjectCode, teacher_id: x.teacherId }))} classTeacherId={proposal.classTeachers?.[s.sectionId]} />
            </div>))}
        </section>)}
      {editing && <LoadEditor schoolId={schoolId} section={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function LoadEditor({ schoolId, section, onClose, onSaved }: { schoolId: string; section: any; onClose: () => void; onSaved: () => void }) {
  const { data: subjects } = useLoad<any[]>('/subjects');
  const { data: teachers } = useLoad<any[]>(`/schools/${schoolId}/teachers`);
  const [rows, setRows] = useState<{ subjectCode: string; teacherId: string | null; periodsPerWeek: number; maxPerDay: number }[]>(
    section.load.map((l: any) => ({ subjectCode: l.subject_code, teacherId: l.teacher_id, periodsPerWeek: l.periods_per_week, maxPerDay: l.max_per_day })));
  const { run, busy } = useAction();
  const total = rows.reduce((n, r) => n + (r.periodsPerWeek || 0), 0);
  const set = (i: number, v: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...v } : r)));
  return (
    <Drawer title={`Teaching load · ${section.label}`} onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="small muted">{total} periods a week</span>
        <button className="linkbtn small" onClick={async () => { const r = await run(() => api<any[]>(`/sections/${section.id}/load/from-timetable`)); if (r?.length) setRows(r); }}>Start from the current timetable</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px 70px 32px', gap: 6, fontSize: '0.75rem', color: 'var(--ink-2)' }}><span>Subject</span><span>Teacher</span><span>A week</span><span>Most a day</span><span /></div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px 70px 32px', gap: 6, alignItems: 'center' }}>
          <select className="input" style={{ height: 36 }} value={r.subjectCode} onChange={(e) => set(i, { subjectCode: e.target.value })} aria-label="Subject">{(subjects ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
          <select className="input" style={{ height: 36 }} value={r.teacherId ?? ''} onChange={(e) => set(i, { teacherId: e.target.value || null })} aria-label="Teacher"><option value="">No teacher</option>{(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <input className="input" style={{ height: 36 }} type="number" min={1} max={12} value={r.periodsPerWeek} onChange={(e) => set(i, { periodsPerWeek: Number(e.target.value) })} aria-label="Periods a week" />
          <input className="input" style={{ height: 36 }} type="number" min={1} max={4} value={r.maxPerDay} onChange={(e) => set(i, { maxPerDay: Number(e.target.value) })} aria-label="Most a day" />
          <button className="icon-btn" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>))}
      <button className="btn quiet small" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, { subjectCode: subjects?.[0]?.code ?? 'ENG', teacherId: null, periodsPerWeek: 4, maxPerDay: 1 }])}>+ Subject</button>
      <button className="btn big" disabled={busy || !rows.length} onClick={async () => { if (await run(() => api(`/sections/${section.id}/load`, { method: 'PUT', body: { rows } }), 'Teaching load saved')) onSaved(); }}>Save load</button>
    </Drawer>
  );
}

// ── Proxy register ────────────────────────────────────────────────────────────────────────

function Register({ schoolId }: { schoolId: string }) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data } = useLoad<any[]>(`/schools/${schoolId}/proxy-register?month=${month}`, [schoolId, month]);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>Proxy register</h2><p className="muted" style={{ marginTop: 6 }}>Cover taken by each teacher, so the load stays fair.</p></div>
        <input className="input" type="month" style={{ height: 36, width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
      </div>
      {!data ? <Empty>Loading…</Empty> : (
        <table className="table"><thead><tr><th>Teacher</th><th className="num">Cover taken</th><th className="num">Their lessons covered</th><th className="num">Days absent</th></tr></thead><tbody>
          {data.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num"><b>{r.cover_taken}</b></td><td className="num">{r.lessons_covered_for_them}</td><td className="num">{r.days_absent}</td></tr>)}
        </tbody></table>)}
    </section>
  );
}
