import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, day, time, today, words, type User, currentYear } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';
import { FixApprovals } from './Help';

function useSchoolId() {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  return { schools, schoolId, setSchoolId };
}

// ── Class teachers ─────────────────────────────────────────────────────────────────────────

export function ClassTeachers({ user }: { user: User }) {
  const { schools, schoolId, setSchoolId } = useSchoolId();
  const board = useLoad<any>(schoolId ? `/schools/${schoolId}/class-teachers` : null, [schoolId]);
  const [edit, setEdit] = useState<{ section: any; kind: 'CLASS' | 'CO' } | null>(null);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const canEdit = ['SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role);
  const b = board.data;
  const attention = (b?.sections ?? []).filter((s: any) => s.warnings.length);
  const rows = filter === 'attention' ? attention : b?.sections ?? [];
  const free = (b?.teachers ?? []).filter((t: any) => !t.holds.some((h: any) => h.kind === 'CLASS'));
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Class teachers</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head">
            <div><h2>{currentYear().replace('-', '–')}</h2><p className="muted" style={{ marginTop: 6 }}>The class teacher takes the roll, approves leave first, knows the families and gets Period 1 with the class. The co-class teacher stands in while they are away.</p></div>
            <div className="seg" role="group" aria-label="Show">
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All classes</button>
              <button className={filter === 'attention' ? 'on' : ''} onClick={() => setFilter('attention')}>Needs attention ({attention.length})</button>
            </div>
          </div>
          {!b ? <Empty>Loading…</Empty> : !rows.length ? <Empty>Every class has a class teacher who teaches it.</Empty> : (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Class</th><th className="num">Students</th><th>Class teacher</th><th>Co-class teacher</th><th>Attention</th></tr></thead>
              <tbody>{rows.map((s: any) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{s.label}</td>
                  <td className="num">{s.strength}</td>
                  <td>{s.classTeacher ? <><div style={{ fontWeight: 600 }}>{s.classTeacher.name}</div><div className="tiny muted">{s.classTeacher.periods ? `${s.classTeacher.periods} periods a week · ${s.classTeacher.subjects}` : 'No lessons with the class'} · since {day(s.classTeacher.from)}</div></> : <span className="muted">None</span>}
                    {s.upcoming.filter((u: any) => u.kind === 'CLASS').map((u: any) => <div key={u.from} className="tiny" style={{ color: 'var(--blue)' }}>{u.name} from {day(u.from)}</div>)}
                    {canEdit && <div style={{ marginTop: 6 }}><button className="btn quiet small" onClick={() => setEdit({ section: s, kind: 'CLASS' })}>{s.classTeacher ? 'Change' : 'Allot'}</button></div>}</td>
                  <td>{s.coClassTeacher ? <><div style={{ fontWeight: 600 }}>{s.coClassTeacher.name}</div><div className="tiny muted">{s.coClassTeacher.periods ? `${s.coClassTeacher.periods} periods a week` : 'No lessons with the class'}</div></> : <span className="muted">None</span>}
                    {s.upcoming.filter((u: any) => u.kind === 'CO').map((u: any) => <div key={u.from} className="tiny" style={{ color: 'var(--blue)' }}>{u.name} from {day(u.from)}</div>)}
                    {canEdit && <div style={{ marginTop: 6, display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => setEdit({ section: s, kind: 'CO' })}>{s.coClassTeacher ? 'Change' : 'Allot'}</button>
                      {s.coClassTeacher && <EndButton id={s.coClassTeacher.row} label="Remove" onDone={board.reload} />}</div>}</td>
                  <td>{s.warnings.length ? s.warnings.map((w: string) => <div key={w} className="small" style={{ color: 'var(--orange)' }}>{w}</div>) : <span className="pill green">Ready</span>}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </section>
        {b && <section className="tile">
          <div className="tile-head"><h2>Teachers without a class</h2><span className="muted small">{free.length} of {b.teachers.length}</span></div>
          {free.length ? <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {free.map((t: any) => <div key={t.id} className="callout"><div style={{ fontWeight: 600 }}>{t.name}</div><div className="tiny muted">{t.designation} · {t.periodsPerWeek} periods a week{t.holds.length ? ` · co-class teacher of ${t.holds.map((h: any) => h.label).join(', ')}` : ''}</div></div>)}
          </div> : <Empty>Every teacher has a class.</Empty>}
        </section>}
      </main>
      {edit && b && <AllotDrawer section={edit.section} kind={edit.kind} teachers={b.teachers} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); board.reload(); }} />}
    </>
  );
}

function EndButton({ id, label, onDone }: { id: string; label: string; onDone: () => void }) {
  const { run, busy } = useAction();
  return <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/class-teachers/${id}/end`, { body: { on: today() } }), 'Removed from today')) onDone(); }}>{label}</button>;
}

function AllotDrawer({ section, kind, teachers, onClose, onSaved }: { section: any; kind: 'CLASS' | 'CO'; teachers: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(today());
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const role = kind === 'CLASS' ? 'class teacher' : 'co-class teacher';
  // Teachers of this class first, then the rest; each with what they already hold.
  const withClass = new Map<string, any>(section.teachers.map((t: any) => [t.id, t]));
  const sorted = [...teachers].sort((a, b) => Number(withClass.has(b.id)) - Number(withClass.has(a.id)) || a.name.localeCompare(b.name));
  const chosen = teachers.find((t) => t.id === userId);
  const save = async (move = false) => {
    setBusy(true);
    try {
      const r = await api<any>('/class-teachers', { body: { sectionId: section.id, userId, kind, from, move } });
      toast(r.moved ? `Allotted. ${r.moved} now needs a class teacher.` : `${chosen?.name} is ${role} of ${section.label} from ${day(from)}`);
      onSaved();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'holds_other') setConfirmMove(err.message); else toast(err.message, 'error');
    } finally { setBusy(false); }
  };
  return (
    <Drawer title={`${words(role)}, ${section.label}`} onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Teacher</span>
          <select className="input" value={userId} onChange={(e) => { setUserId(e.target.value); setConfirmMove(null); }}>
            <option value="">Choose a teacher</option>
            {sorted.map((t) => {
              const w = withClass.get(t.id);
              const holds = t.holds.map((h: any) => `${h.kind === 'CLASS' ? 'class teacher' : 'co-class'} ${h.label}`).join(', ');
              return <option key={t.id} value={t.id}>{t.name}{w ? ` · teaches ${w.subjects} (${w.periods}/wk)` : ' · does not teach this class'}{holds ? ` · ${holds}` : ''}</option>;
            })}
          </select></label>
        {chosen && !withClass.has(chosen.id) && <div className="callout orange small">{chosen.name} has no lessons with {section.label}. A class teacher should meet the class every day; give them a subject in the teaching load, or choose a teacher of the class.</div>}
        <label className="field"><span>From</span><input className="input" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <p className="small muted">{kind === 'CLASS' && section.classTeacher ? `${section.classTeacher.name}'s allotment ends on the day before. ` : ''}The allotment runs to the end of the academic year. Past allotments stay in the record.</p>
        {confirmMove ? (
          <div className="callout orange stack small"><strong>{confirmMove}</strong>
            <div style={{ display: 'flex', gap: 8 }}><button className="btn small" disabled={busy} onClick={() => save(true)}>Move them</button><button className="btn quiet small" onClick={() => setConfirmMove(null)}>Choose someone else</button></div></div>
        ) : <button className="btn big" disabled={busy || !userId} onClick={() => save()}>Allot {role}</button>}
      </section>
    </Drawer>
  );
}

// ── Duties ─────────────────────────────────────────────────────────────────────────────────

export function Duties({ user }: { user: User }) {
  const { schools, schoolId, setSchoolId } = useSchoolId();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/duties` : null, [schoolId]);
  const { data: catalogue } = useLoad<Record<string, { label: string; gives: string }>>('/duties/catalogue');
  const { data: staff } = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff` : null, [schoolId]);
  const { run, busy } = useAction();
  const [f, setF] = useState({ userId: '', code: '', from: today(), to: '' });
  const canEdit = ['SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Duties</span><span className="spacer" /><SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} /></div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head"><div><h2>Who does what</h2><p className="muted" style={{ marginTop: 6 }}>A duty gives a staff member one job's powers at this school, for a period, without a principal's access.</p></div></div>
          {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No duties given yet.</Empty> : (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Duty</th><th>Held by</th><th>From</th><th>Until</th><th /></tr></thead>
              <tbody>{list.data.map((d) => (
                <tr key={d.id}><td><div style={{ fontWeight: 600 }}>{catalogue?.[d.code]?.label ?? words(d.code)}</div><div className="tiny muted">{catalogue?.[d.code]?.gives}</div></td>
                  <td>{d.name}<div className="tiny muted">{d.designation}</div></td><td>{day(d.from)}</td><td>{d.to ? day(d.to) : 'Until ended'}</td>
                  <td>{canEdit && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/duties/${d.id}/end`, { body: { on: today() } }), 'Duty ended')) list.reload(); }}>End today</button>}</td></tr>))}</tbody>
            </table></div>
          )}
        </section>
        {canEdit && <section className="tile">
          <h2>Give a duty</h2>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <label className="field"><span>Duty</span><select className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}><option value="">Choose</option>
              {Object.entries(catalogue ?? {}).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label className="field"><span>Staff member</span><select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Choose</option>
              {(staff ?? []).filter((s) => s.role !== 'SCHOOL_ADMIN').map((s) => <option key={s.id} value={s.id}>{s.name} · {s.designation}</option>)}</select></label>
            <label className="field"><span>From</span><input className="input" type="date" min={today()} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            <label className="field"><span>Until (optional)</span><input className="input" type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          </div>
          {f.code && <p className="small muted" style={{ marginTop: 10 }}>Gives: {catalogue?.[f.code]?.gives}.</p>}
          <div style={{ marginTop: 16 }}><button className="btn" disabled={busy || !f.code || !f.userId} onClick={async () => {
            if (await run(() => api(`/schools/${schoolId}/duties`, { body: { userId: f.userId, code: f.code, from: f.from, to: f.to || null } }), 'Duty given')) { setF({ ...f, userId: '', code: '' }); list.reload(); }
          }}>Give duty</button></div>
        </section>}
      </main>
    </>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────

const APPROVERS: [string, string][] = [['CLASS_TEACHER', 'Class teacher'], ['PRINCIPAL', 'Principal'], ['NES_ADMIN', 'NES headquarters'], ['DUTY:EXAM_INCHARGE', 'Exam in-charge'],
  ['DUTY:ADMISSION_INCHARGE', 'Admission in-charge'], ['DUTY:ATTENDANCE_OFFICER', 'Attendance officer'], ['DUTY:TIMETABLE_COORDINATOR', 'Timetable coordinator']];
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th'];

function show(s: any, v: any) {
  if (v === null || v === undefined) return '—';
  if (s.kind === 'bool') return v ? 'Yes' : 'No';
  if (s.kind === 'choice') return s.options?.find((o: [string, string]) => o[0] === v)?.[1] ?? v;
  if (s.kind === 'days') return v.length ? v.map((d: number) => ORD[d]).join(', ') : 'None';
  if (s.kind === 'chain') return v.map((x: any) => `${x.label}${x.when?.gte ? ` (${x.when.gte[1]}+ ${x.when.gte[0]})` : ''}`).join(' → ');
  if (s.kind === 'text') return String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v);
  return String(v);
}

/**
 * The school's official details, kept once: the website, certificates, report cards, ID cards and
 * payslips all read them from here. Used on Settings and inside the website builder.
 */
export function SchoolDetailsPanel({ schoolId, compact, onSaved }: { schoolId: string; compact?: boolean; onSaved?: (d: any) => void }) {
  const d = useLoad<any>(schoolId ? `/schools/${schoolId}/details` : null, [schoolId]);
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (d.data) setF({ name: d.data.name, address: d.data.address ?? '', phone: d.data.phone ?? '', email: d.data.email ?? '', website: d.data.website ?? '', city: d.data.city ?? '',
    affiliationNo: d.data.affiliation_no ?? '', udiseCode: d.data.udise_code ?? '', schoolNo: d.data.school_no ?? '', tan: d.data.tan ?? '', campuses: d.data.campuses }); }, [d.data]);
  const { run, busy } = useAction();
  if (!d.data || !f) return <Empty>{d.error ?? 'Loading…'}</Empty>;
  const ro = !d.data.canEdit;
  const field = (k: string, label: string, opts: { wide?: boolean; disabled?: boolean } = {}) => <label key={k} className="field" style={opts.wide ? { gridColumn: '1 / -1' } : undefined}><span>{label}</span>
    <input className="input" value={f[k]} disabled={ro || opts.disabled} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <div className="stack">
      <p className="tiny muted">Kept once for the whole ERP: the website, certificates, report cards, ID cards and payslips show these. {d.data.canRename ? '' : 'The official name is set by NES.'}</p>
      <div className="form-grid">
        {field('name', 'Official name', { wide: true, disabled: !d.data.canRename })}
        {field('address', 'Address', { wide: true })}
        {field('phone', 'Phone')}{field('email', 'Email')}
        {!compact && <>{field('website', 'Website')}{field('city', 'City')}{field('affiliationNo', 'CBSE affiliation no.')}{field('schoolNo', 'CBSE school no.')}{field('udiseCode', 'UDISE code')}{field('tan', 'TAN (for TDS and Form 16)')}</>}
      </div>
      {!compact && f.campuses.length > 1 && f.campuses.map((c: any, i: number) => <label key={c.id} className="field"><span>{c.name} address</span>
        <input className="input" value={c.address} disabled={ro} onChange={(e) => setF({ ...f, campuses: f.campuses.map((x: any, j: number) => j === i ? { ...x, address: e.target.value } : x) })} /></label>)}
      {!ro && <div><button className="btn small" disabled={busy} onClick={async () => {
        const body: any = { address: f.address || null, phone: f.phone || null, email: f.email || null };
        if (!compact) Object.assign(body, { website: f.website || null, city: f.city || null, affiliationNo: f.affiliationNo || null, udiseCode: f.udiseCode || null, schoolNo: f.schoolNo || null, tan: f.tan || null,
          campuses: f.campuses.map((c: any) => ({ id: c.id, address: c.address })) });
        if (d.data.canRename && f.name !== d.data.name) body.name = f.name;
        const r = await run(() => api(`/schools/${schoolId}/details`, { method: 'PUT', body }), 'Saved; shown everywhere from now');
        if (r) { d.setData(r); onSaved?.(r); }
      }}>Save school details</button></div>}
    </div>
  );
}

export function Settings({ user }: { user: User }) {
  const { units } = useSchools();
  const levels = units.filter((u) => ['society', 'command', 'school'].includes(u.kind) && u.active);
  const [unitId, setUnitId] = useState('');
  useEffect(() => { if (!unitId && levels.length) setUnitId((levels.find((u) => u.kind === (user.role === 'SCHOOL_ADMIN' ? 'school' : user.role === 'COMMAND_OFFICER' ? 'command' : 'society')) ?? levels[0]).id); }, [levels, unitId, user.role]);
  const data = useLoad<any>(unitId ? `/settings/${unitId}` : null, [unitId]);
  const [edit, setEdit] = useState<any>(null);
  const groups = new Map<string, any[]>();
  for (const s of data.data?.settings ?? []) (groups.get(s.category) ?? groups.set(s.category, []).get(s.category)!).push(s);
  const source = (s: any) => s.own ? 'Set here' : s.source ? `From ${s.source}` : 'NES default';
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Settings</span><span className="spacer" />
        {levels.length > 1 && <select className="input" style={{ height: 36, width: 'auto' }} value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Level">
          {levels.map((u) => <option key={u.id} value={u.id}>{u.kind === 'society' ? 'All of NES' : u.kind === 'command' ? `${u.name} (Command)` : u.name}</option>)}</select>}
      </div></div>
      <main className="page">
        {data.data?.kind === 'school' && <section className="tile"><h2>School details</h2><SchoolDetailsPanel schoolId={unitId} /></section>}
        <p className="muted" style={{ maxWidth: '68ch' }}>Each setting applies from a date. Schools follow their Command, and Commands follow NES, unless they set their own value. A value locked above cannot be changed below it.</p>
        {!data.data ? <Empty>Loading…</Empty> : [...groups].map(([cat, list]) => (
          <section key={cat} className="tile">
            <h2>{cat}</h2>
            {list.map((s) => (
              <div key={s.key} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,auto) auto' }}>
                <div><div style={{ fontWeight: 600 }}>{s.label}</div><div className="small muted">{s.help}</div>
                  {s.upcoming.map((u: any) => <div key={u.from} className="tiny" style={{ color: 'var(--blue)' }}>Changes to {show(s, u.value)} from {day(u.from)}</div>)}</div>
                <div style={{ textAlign: 'right' }}><div style={{ fontWeight: 600 }}>{show(s, s.value)}</div><div className="tiny muted">{source(s)}{s.own?.locked ? ' · locked for all below' : ''}{s.lockedBy ? ` · fixed by ${s.lockedBy}` : ''}</div></div>
                <div>{s.canSet ? <button className="btn quiet small" onClick={() => setEdit(s)}>Change</button> : <span className="tiny muted">{s.lockedBy ? 'Fixed' : 'View only'}</span>}</div>
              </div>))}
          </section>))}
      </main>
      {edit && <SettingDrawer s={edit} unitId={unitId} unitKind={data.data.kind} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); data.reload(); }} />}
    </>
  );
}

function SettingDrawer({ s, unitId, unitKind, onClose, onSaved }: { s: any; unitId: string; unitKind: string; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [value, setValue] = useState<any>(structuredClone(s.value));
  const [from, setFrom] = useState(today());
  const [locked, setLocked] = useState(!!s.own?.locked);
  const [note, setNote] = useState('');
  const hist = useLoad<any[]>(`/settings/${unitId}/${s.key}/history`);
  return (
    <Drawer title={s.label} onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">{s.help}</p>
        {s.kind === 'int' && <label className="field"><span>Value</span><input className="input" type="number" value={value} onChange={(e) => setValue(Number(e.target.value))} /></label>}
        {s.kind === 'time' && <label className="field"><span>Time</span><input className="input" type="time" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
        {s.kind === 'text' && <label className="field"><span>Text</span><textarea className="input" rows={4} value={value} onChange={(e) => setValue(e.target.value)} /></label>}
        {s.kind === 'bool' && <label className="check"><input type="checkbox" checked={!!value} onChange={(e) => setValue(e.target.checked)} /> Yes</label>}
        {s.kind === 'choice' && <label className="field"><span>Choose</span><select className="input" value={value} onChange={(e) => setValue(e.target.value)}>{s.options.map(([k, l]: [string, string]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        {s.kind === 'days' && <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>{[1, 2, 3, 4, 5].map((d) => (
          <label key={d} className="check"><input type="checkbox" checked={value.includes(d)} onChange={(e) => setValue(e.target.checked ? [...value, d].sort() : value.filter((x: number) => x !== d))} /> {ORD[d]}</label>))}</div>}
        {s.kind === 'chain' && <ChainEditor value={value} onChange={setValue} />}
        <label className="field"><span>From</span><input className="input" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        {unitKind !== 'school' && <label className="check"><input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} /> Lock it, so schools {unitKind === 'society' ? 'and Commands ' : ''}below cannot change it</label>}
        <label className="field"><span>Reason (kept in the history)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: decided in the staff meeting of 14 October" /></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn big" disabled={busy} onClick={async () => { if (await run(() => api(`/settings/${unitId}`, { method: 'PUT', body: { key: s.key, value, from, locked, note: note || undefined } }), from === today() ? 'Saved. It applies from today.' : `Saved. It applies from ${day(from)}.`)) onSaved(); }}>Save</button>
          {s.own && <button className="btn quiet big" disabled={busy} onClick={async () => { if (await run(() => api(`/settings/${unitId}/${s.key}?from=${from}`, { method: 'DELETE' }), 'This level now follows the level above.')) onSaved(); }}>Follow the level above</button>}
        </div>
      </section>
      <section className="tile tight">
        <h3>History</h3>
        {!hist.data?.length ? <p className="small muted">Never changed at this level.</p> : hist.data.map((h, i) => (
          <div key={i} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div><strong>{show(s, h.value)}</strong>{h.locked ? ' · locked' : ''}<div className="tiny muted">{h.set_by} · {time(h.set_at)}{h.note ? ` · ${h.note}` : ''}</div></div>
            <div className="tiny muted">{day(h.from)} to {h.to ? day(h.to) : 'now'}</div></div>))}
      </section>
    </Drawer>
  );
}

function ChainEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const set = (i: number, patch: any) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack">
      <span className="small muted">Steps, in order. A step can apply only to longer requests.</span>
      {value.map((st, i) => (
        <div key={i} className="callout stack small">
          <div className="form-grid">
            <label className="field"><span>Step {i + 1}: approved by</span><select className="input" value={st.who} onChange={(e) => set(i, { who: e.target.value, label: APPROVERS.find((a) => a[0] === e.target.value)![1] })}>
              {APPROVERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field"><span>Applies</span><select className="input" value={st.when ? 'days' : 'always'} onChange={(e) => set(i, { when: e.target.value === 'days' ? { gte: ['days', 4] } : undefined })}>
              <option value="always">Always</option><option value="days">Only for longer requests</option></select></label>
            {st.when && <label className="field"><span>When the request is at least (days)</span><input className="input" type="number" min={1} value={st.when.gte[1]} onChange={(e) => set(i, { when: { gte: ['days', Number(e.target.value)] } })} /></label>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {i > 0 && <button className="btn quiet small" onClick={() => { const v = [...value]; [v[i - 1], v[i]] = [v[i], v[i - 1]]; onChange(v); }}>Move up</button>}
            {value.length > 1 && <button className="btn quiet small" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        </div>))}
      {value.length < 5 && <button className="btn quiet small" onClick={() => onChange([...value, { who: 'PRINCIPAL', label: 'Principal' }])}>Add a step</button>}
    </div>
  );
}

// ── Approvals inbox ────────────────────────────────────────────────────────────────────────

/** Requests waiting for this person; the helpdesk and developers see only fixes waiting for them. */
export function Approvals({ deskOnly = false }: { deskOnly?: boolean }) {
  const inbox = useLoad<any[]>(deskOnly ? null : '/approvals');
  const { run, busy } = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = async (r: any, approve: boolean) => {
    const res = await run(() => api<any>(`/approvals/${r.id}/decide`, { body: { approve, note: notes[r.id] ?? '' } }));
    if (res) { inbox.reload(); window.dispatchEvent(new Event('nes:approvals')); }
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Approvals</span></div></div>
      <main className="page">
        <FixApprovals />
        {!deskOnly && <section className="tile">
          <div className="tile-head"><div><h2>Waiting for you</h2><p className="muted" style={{ marginTop: 6 }}>Each request moves through its steps in order. Your decision is recorded with your name and cannot be changed.</p></div></div>
          {!inbox.data ? <Empty>{inbox.error ? "Nothing is waiting for you." : "Loading…"}</Empty> : !inbox.data.length ? <Empty>Nothing is waiting for you.</Empty> : inbox.data.map((r) => (
            <div key={r.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                <strong>{r.title}</strong><span className="pill blue">{r.step.label}, step {r.current_step} of {r.steps.length}</span><span className="tiny muted">{r.school} · from {r.requester} · {time(r.requested_at)}</span>
              </div>
              {r.summary && <div className="small">{r.summary}</div>}
              {r.decisions.map((d: any) => <div key={d.step_no} className="tiny muted">Step {d.step_no}: {d.decision === 'APPROVE' ? 'approved' : 'rejected'} by {d.by}{d.note ? ` · “${d.note}”` : ''}</div>)}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <input className="input" style={{ flex: '1 1 240px' }} placeholder="Note (optional)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} aria-label="Note" />
                <button className="btn small" disabled={busy} onClick={() => decide(r, true)}>{r.current_step < r.steps.length ? `Approve, send to ${r.steps[r.current_step].label.toLowerCase()}` : 'Approve'}</button>
                <button className="btn danger small" disabled={busy} onClick={() => decide(r, false)}>Reject</button>
                {r.link && <Link className="small" to={r.link}>Open</Link>}
              </div>
            </div>))}
        </section>}
      </main>
    </>
  );
}
