import { useState } from 'react';
import { api, day, hasDuty, time, today, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad } from '../ui';
import { useSchool } from './Payroll';

/**
 * Health and safety at school. The nurse's infirmary register (find the child, see their alert,
 * record what was done; medicines come off the infirmary's stock and the parent is told), medical
 * alerts, class check-ups and immunisations due; and for every member of staff, reporting an
 * incident, with the principal and safety officer following it up and recording drills.
 */

const OUTCOME: Record<string, string> = { BACK_TO_CLASS: 'Back to class', RESTED: 'Rested in the infirmary', SENT_HOME: 'Sent home', HOSPITAL: 'Taken to hospital' };

export function Health() {
  const [schoolId, picker] = useSchool();
  const o = useLoad<any>(schoolId ? `/schools/${schoolId}/health` : null, [schoolId]);
  const [tab, setTab] = useState('infirmary');
  const [visit, setVisit] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const x = o.data;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Health</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <div className="seg">{[['infirmary', 'Infirmary'], ['alerts', 'Medical alerts'], ['checkups', 'Check-ups'], ['immunisation', 'Immunisations']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        <button className="btn small" onClick={() => setVisit(true)}>Record a visit</button></div></div>
      <main className="page">
        {!x ? <Empty>{o.error ?? 'Loading…'}</Empty> : tab === 'infirmary' ? <section className="tile">
          <h2>Today in the infirmary</h2>
          <p className="muted" style={{ marginTop: 6 }}>Every visit is kept. The parent is told when a child is sent home or to hospital (and whenever you choose). Medicines from the infirmary’s stock come off it in Stores.</p>
          {!x.today.length ? <Empty>No visits today.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Time</th><th>Who</th><th>Complaint</th><th>Treatment</th><th>Outcome</th></tr></thead>
            <tbody>{x.today.map((v: any) => <tr key={v.id}><td className="small">{time(v.at)}</td><td><b>{v.who}</b><span className="tiny muted" style={{ display: 'block' }}>{v.class}{v.alert ? ` · ⚠ ${v.alert}` : ''}</span></td>
              <td className="small">{v.complaint}{v.temperature_c ? ` · ${v.temperature_c}°C` : ''}</td><td className="small">{v.treatment}{v.medicines?.length ? ` · ${v.medicines.map((m: any) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join(', ')}` : ''}</td>
              <td><span className={`pill ${['SENT_HOME', 'HOSPITAL'].includes(v.outcome) ? 'orange' : ''}`}>{OUTCOME[v.outcome]}</span>{v.parent_told_at && <span className="tiny muted" style={{ display: 'block' }}>Parent told</span>}</td></tr>)}</tbody></table></div>}
        </section> : tab === 'alerts' ? <section className="tile"><h3>Children with a medical alert</h3>
          <p className="tiny muted">The alert line is what the class teacher sees. Parents keep allergies and medication up to date in the parent app.</p>
          {!x.alerts.length ? <Empty>No alerts.</Empty> : x.alerts.map((a: any) => <div key={a.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{a.name}</b> <span className="small muted">{a.class}</span><span className="small" style={{ display: 'block' }}>⚠ {a.alert}</span>{a.allergies && <span className="tiny muted">Allergies: {a.allergies}</span>}</span></div>)}
        </section> : tab === 'checkups' ? <section className="tile"><h3>Yearly check-ups</h3>
          <p className="small muted">{x.checkupsDone.done} of {x.checkupsDone.total} children checked this year. Choose a class to enter its check-up in one sheet.</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>{x.sections.map((s: any) => <button key={s.id} className="btn quiet small" onClick={() => setSheet(s.id)}>{s.name}</button>)}</div>
        </section> : <section className="tile"><h3>Immunisations due in the next 30 days</h3>
          {!x.immunisationsDue.length ? <Empty>None due.</Empty> : x.immunisationsDue.map((i: any, k: number) => <div key={k} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{i.name}</b> <span className="small muted">{i.vaccine} {i.dose}</span></span><span className={`pill ${i.due_on < today() ? 'red' : 'orange'}`}>{day(i.due_on)}</span></div>)}
        </section>}
      </main>
      {visit && <VisitDrawer schoolId={schoolId} onClose={() => { setVisit(false); o.reload(); }} />}
      {sheet && <CheckupDrawer sectionId={sheet} schoolId={schoolId} onClose={() => { setSheet(null); o.reload(); }} />}
    </>
  );
}

function VisitDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const found = useLoad<any[]>(q.trim().length >= 2 ? `/schools/${schoolId}/health/find?q=${encodeURIComponent(q.trim())}` : null, [q]);
  const meds = useLoad<any[]>(`/schools/${schoolId}/store-items`, [schoolId]);
  const [child, setChild] = useState<any>(null);
  const [f, setF] = useState({ complaint: '', temperatureC: '', treatment: '', outcome: 'BACK_TO_CLASS', tellParent: false, med: '', medQty: '1', dose: '' });
  const { run, busy } = useAction();
  const medicines = (meds.data ?? []).filter((m) => m.category === 'MEDICINE' && m.kind === 'CONSUMABLE');
  return <Drawer title="Infirmary visit" onClose={onClose}><section className="tile tight stack">
    {!child ? <>
      <label className="field"><span>Child (name or admission number)</span><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {(found.data ?? []).map((c) => <button key={c.id} className="list-row" style={{ gridTemplateColumns: '1fr', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setChild(c)}>
        <span><b>{c.name}</b> <span className="small muted">{c.class} · {c.admission_no}{c.blood_group ? ` · ${c.blood_group}` : ''}</span>{c.alert && <span className="small" style={{ display: 'block', color: 'var(--red)' }}>⚠ {c.alert}</span>}</span></button>)}
    </> : <>
      <div className="callout small"><b>{child.name}</b> · {child.class}{child.blood_group ? ` · blood group ${child.blood_group}` : ''}{child.alert && <div style={{ color: 'var(--red)', marginTop: 4 }}>⚠ {child.alert}</div>}{child.allergies && <div className="tiny">Allergies: {child.allergies}</div>}
        <button className="linkbtn tiny" onClick={() => setChild(null)}>Change</button></div>
      <div className="form-grid">
        <label className="field"><span>Complaint</span><input className="input" value={f.complaint} onChange={(e) => setF({ ...f, complaint: e.target.value })} placeholder="Headache, fever" /></label>
        <label className="field"><span>Temperature °C</span><input className="input" inputMode="decimal" value={f.temperatureC} onChange={(e) => setF({ ...f, temperatureC: e.target.value })} /></label>
      </div>
      <label className="field"><span>What was done</span><input className="input" value={f.treatment} onChange={(e) => setF({ ...f, treatment: e.target.value })} placeholder="Rested for 20 minutes; cold compress" /></label>
      <div className="form-grid">
        <label className="field"><span>Medicine from the infirmary</span><select className="input" value={f.med} onChange={(e) => setF({ ...f, med: e.target.value })}><option value="">None</option>{medicines.map((m) => <option key={m.id} value={m.id}>{m.name}{m.balance !== undefined ? ` (${m.balance} left)` : ''}</option>)}</select></label>
        {f.med && <><label className="field"><span>How many</span><input className="input" inputMode="decimal" value={f.medQty} onChange={(e) => setF({ ...f, medQty: e.target.value })} /></label>
          <label className="field"><span>Dose</span><input className="input" value={f.dose} onChange={(e) => setF({ ...f, dose: e.target.value })} placeholder="1 tablet" /></label></>}
      </div>
      <label className="field"><span>Outcome</span><select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{Object.entries(OUTCOME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      {['BACK_TO_CLASS', 'RESTED'].includes(f.outcome) ? <label className="check small"><input type="checkbox" checked={f.tellParent} onChange={(e) => setF({ ...f, tellParent: e.target.checked })} />Tell the parent</label>
        : <p className="tiny muted">The parent is told{f.outcome === 'HOSPITAL' ? ', and the principal' : ''}.</p>}
      <button className="btn big" disabled={busy || f.complaint.trim().length < 2} onClick={async () => {
        const med = medicines.find((m) => m.id === f.med);
        const r = await run(() => api(`/schools/${schoolId}/infirmary`, { body: { studentId: child.id, complaint: f.complaint, temperatureC: f.temperatureC ? Number(f.temperatureC) : null, treatment: f.treatment, outcome: f.outcome, tellParent: f.tellParent,
          medicines: med ? [{ name: med.name, dose: f.dose || undefined, itemId: med.id, qty: Number(f.medQty) || 1 }] : [] } }), 'Recorded');
        if (r) onClose();
      }}>Save</button>
    </>}
  </section></Drawer>;
}

function CheckupDrawer({ sectionId, schoolId, onClose }: { sectionId: string; schoolId: string; onClose: () => void }) {
  const s = useLoad<any>(`/sections/${sectionId}/health-sheet`);
  const [rows, setRows] = useState<Record<string, any>>({});
  const [on, setOn] = useState(today());
  const { run, busy } = useAction();
  const set = (id: string, k: string, v: string) => setRows({ ...rows, [id]: { ...rows[id], [k]: v } });
  return <Drawer title={`Check-up · ${s.data?.section ?? ''}`} onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>Date of the check-up</span><input className="input" type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} /></label>
    {!s.data ? <Empty>Loading…</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>Child</th><th>Height cm</th><th>Weight kg</th><th>Vision L / R</th><th>Teeth</th></tr></thead>
      <tbody>{s.data.rows.map((r: any) => <tr key={r.id}><td className="small"><b>{r.name}</b>{r.last && <span className="tiny muted" style={{ display: 'block' }}>Last: {r.last.height_cm ?? '—'} cm, {r.last.weight_kg ?? '—'} kg{r.last.bmi ? `, BMI ${r.last.bmi}` : ''}</span>}</td>
        <td><input className="input" style={{ width: 70, height: 32 }} inputMode="decimal" value={rows[r.id]?.h ?? ''} onChange={(e) => set(r.id, 'h', e.target.value)} /></td>
        <td><input className="input" style={{ width: 70, height: 32 }} inputMode="decimal" value={rows[r.id]?.w ?? ''} onChange={(e) => set(r.id, 'w', e.target.value)} /></td>
        <td><input className="input" style={{ width: 55, height: 32 }} placeholder="6/6" value={rows[r.id]?.vl ?? ''} onChange={(e) => set(r.id, 'vl', e.target.value)} /> <input className="input" style={{ width: 55, height: 32 }} placeholder="6/6" value={rows[r.id]?.vr ?? ''} onChange={(e) => set(r.id, 'vr', e.target.value)} /></td>
        <td><input className="input" style={{ width: 110, height: 32 }} value={rows[r.id]?.d ?? ''} onChange={(e) => set(r.id, 'd', e.target.value)} /></td></tr>)}</tbody></table></div>}
    <button className="btn big" disabled={busy || !Object.keys(rows).length} onClick={async () => {
      const list = Object.entries(rows).map(([studentId, r]) => ({ studentId, heightCm: r.h ? Number(r.h) : null, weightKg: r.w ? Number(r.w) : null, visionLeft: r.vl || undefined, visionRight: r.vr || undefined, dental: r.d || undefined }));
      if (await run(() => api(`/schools/${schoolId}/checkups`, { body: { onDate: on, rows: list } }), 'Saved; BMI worked out')) onClose();
    }}>Save the class</button>
  </section></Drawer>;
}

// ── Safety: incidents and drills ──────────────────────────────────────────────────────────

const KINDS: [string, string][] = [['INJURY', 'Injury'], ['ILLNESS', 'Illness'], ['BEHAVIOUR', 'Behaviour'], ['BULLYING', 'Bullying'], ['SAFETY', 'Safety hazard'], ['PROPERTY', 'Damage or loss'], ['CHILD_PROTECTION', 'Child protection (confidential)'], ['OTHER', 'Other']];

export function Safety({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const [status, setStatus] = useState('OPEN');
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/incidents?status=${status}` : null, [schoolId, status]);
  const dr = useLoad<any>(schoolId ? `/schools/${schoolId}/drills` : null, [schoolId]);
  const [allDrills, setAllDrills] = useState(false);
  const [report, setReport] = useState(false);
  const [drill, setDrill] = useState(false);
  const [follow, setFollow] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const lead = user.role === 'SCHOOL_ADMIN' || hasDuty(user, 'SAFETY_OFFICER');
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Safety</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <button className="btn small" onClick={() => setReport(true)}>Report an incident</button>{lead && <button className="btn quiet small" onClick={() => setDrill(true)}>Record a drill</button>}</div></div>
      <main className="page">
        {dr.data && <section className="tile"><h3>Safety drills</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>{dr.data.due.map((d: any) => <span key={d.kind} className={`pill ${d.overdue ? 'red' : 'green'}`}>{words(d.kind)}: {d.last ? `last ${day(d.last)}` : 'never recorded'}{d.overdue ? ' · due' : ''}</span>)}</div>
          {dr.data.drills.slice(0, allDrills ? undefined : 5).map((d: any) => <div key={d.id} className="list-row small" style={{ gridTemplateColumns: '1fr' }}><span><b>{words(d.kind)}</b> {day(d.on_date)}{d.minutes_to_clear ? ` · cleared in ${d.minutes_to_clear} min` : ''}{d.participants ? ` · ${d.participants} people` : ''}{d.observations ? ` · ${d.observations}` : ''}</span></div>)}
          {dr.data.drills.length > 5 && <button className="linkbtn small" onClick={() => setAllDrills(!allDrills)}>{allDrills ? 'Show fewer' : `Show all ${dr.data.drills.length} drills`}</button>}</section>}
        <section className="tile"><div className="tile-head"><div><h2>Incidents</h2><p className="muted" style={{ marginTop: 6 }}>Any member of staff reports an incident here; the principal and the safety officer follow it up. Child-protection reports are seen only by them.</p></div>
          <div className="seg">{[['OPEN', 'Open'], ['CLOSED', 'Closed'], ['ALL', 'All']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div></div>
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No incidents{lead ? '' : ' that you reported'}.</Empty> : list.data.map((i) => <div key={i.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{i.number}</b><span className={`pill ${i.severity === 'SERIOUS' ? 'red' : i.severity === 'MODERATE' ? 'orange' : ''}`}>{words(i.severity)} · {words(i.kind)}</span>{i.confidential && <span className="pill red">Confidential</span>}
              <span className="tiny muted">{time(i.at)} · {i.place} · reported by {i.reported_by}</span><span className={`pill ${i.status === 'OPEN' ? 'blue' : 'green'}`}>{words(i.status)}</span></div>
            {i.description && <div className="small">{i.description}</div>}
            {i.students?.length > 0 && <div className="tiny muted">Children: {i.students.join(', ')}</div>}
            {i.updates.map((u: any, k: number) => <div key={k} className="tiny">↳ {u.note} <span className="muted">· {u.by}, {time(u.at)}</span></div>)}
            {lead && i.status === 'OPEN' && <div style={{ display: 'flex', gap: 6 }}><input className="input" style={{ flex: 1 }} placeholder="Follow-up: what was done" value={follow[i.id] ?? ''} onChange={(e) => setFollow({ ...follow, [i.id]: e.target.value })} />
              <button className="btn quiet small" disabled={busy || (follow[i.id] ?? '').trim().length < 3} onClick={async () => { if (await run(() => api(`/incidents/${i.id}/updates`, { body: { note: follow[i.id] } }), 'Added')) { setFollow({ ...follow, [i.id]: '' }); list.reload(); } }}>Add</button>
              <button className="btn small" disabled={busy || (follow[i.id] ?? '').trim().length < 3} onClick={async () => { if (await run(() => api(`/incidents/${i.id}/updates`, { body: { note: follow[i.id], close: true } }), 'Closed')) list.reload(); }}>Close</button></div>}
          </div>)}
        </section>
      </main>
      {report && <IncidentDrawer schoolId={schoolId} onClose={() => { setReport(false); list.reload(); }} />}
      {drill && <DrillDrawer schoolId={schoolId} onClose={() => { setDrill(false); dr.reload(); }} />}
    </>
  );
}

function IncidentDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const now = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16);
  const [f, setF] = useState({ at: now, kind: 'INJURY', severity: 'MINOR', place: '', description: '', actionTaken: '', tellParents: false });
  const [q, setQ] = useState('');
  const [kids, setKids] = useState<any[]>([]);
  const found = useLoad<any[]>(q.trim().length >= 2 ? `/students?q=${encodeURIComponent(q.trim())}` : null, [q]);
  const { run, busy } = useAction();
  const cp = f.kind === 'CHILD_PROTECTION';
  return <Drawer title="Report an incident" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>When</span><input className="input" type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></label>
      <label className="field"><span>What kind</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="field"><span>How serious</span><select className="input" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="MINOR">Minor</option><option value="MODERATE">Moderate</option><option value="SERIOUS">Serious</option></select></label>
      <label className="field"><span>Where</span><input className="input" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder="Playground, near the swings" /></label>
    </div>
    <label className="field"><span>What happened</span><textarea className="input" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
    <label className="field"><span>What was done at once</span><input className="input" value={f.actionTaken} onChange={(e) => setF({ ...f, actionTaken: e.target.value })} placeholder="First aid by the nurse; class teacher informed" /></label>
    <label className="field"><span>Children involved</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" /></label>
    {Array.isArray(found.data) && found.data.slice(0, 6).map((c: any) => <button key={c.id} className="linkbtn small" style={{ textAlign: 'left' }} onClick={() => { if (!kids.some((k) => k.id === c.id)) setKids([...kids, c]); setQ(''); }}>+ {c.name} ({c.class_code}{c.section ? `-${c.section}` : ''})</button>)}
    {kids.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{kids.map((k) => <span key={k.id} className="pill">{k.name} <button className="linkbtn tiny" onClick={() => setKids(kids.filter((x) => x.id !== k.id))}>×</button></span>)}</div>}
    {cp ? <p className="callout orange small">Child-protection reports are confidential: only the principal and the safety officer see them, and parents are not told from here.</p>
      : kids.length > 0 && <label className="check small"><input type="checkbox" checked={f.tellParents} onChange={(e) => setF({ ...f, tellParents: e.target.checked })} />Tell the parents of these children (a short note, without other children’s names)</label>}
    <button className="btn big" disabled={busy || f.place.trim().length < 2 || f.description.trim().length < 10} onClick={async () => {
      const r = await run(() => api(`/schools/${schoolId}/incidents`, { body: { ...f, at: new Date(`${f.at}:00+05:30`).toISOString(), studentIds: kids.map((k) => k.id) } }), 'Reported; the principal is told');
      if (r) onClose();
    }}>Report</button>
  </section></Drawer>;
}

function DrillDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ kind: 'FIRE', onDate: today(), startedAt: '', minutesToClear: '', participants: '', observations: '', actions: '' });
  const { run, busy } = useAction();
  return <Drawer title="Record a safety drill" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Drill</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['FIRE', 'EARTHQUAKE', 'LOCKDOWN', 'EVACUATION', 'FIRST_AID', 'OTHER'].map((k) => <option key={k} value={k}>{words(k)}</option>)}</select></label>
      <label className="field"><span>Date</span><input className="input" type="date" max={today()} value={f.onDate} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
      <label className="field"><span>Started at</span><input className="input" type="time" value={f.startedAt} onChange={(e) => setF({ ...f, startedAt: e.target.value })} /></label>
      <label className="field"><span>Minutes to clear</span><input className="input" inputMode="decimal" value={f.minutesToClear} onChange={(e) => setF({ ...f, minutesToClear: e.target.value })} /></label>
      <label className="field"><span>People</span><input className="input" inputMode="numeric" value={f.participants} onChange={(e) => setF({ ...f, participants: e.target.value })} /></label>
    </div>
    <label className="field"><span>Observations</span><textarea className="input" rows={3} value={f.observations} onChange={(e) => setF({ ...f, observations: e.target.value })} /></label>
    <label className="field"><span>Actions to take</span><input className="input" value={f.actions} onChange={(e) => setF({ ...f, actions: e.target.value })} /></label>
    <button className="btn big" disabled={busy} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/drills`, { body: { kind: f.kind, onDate: f.onDate, startedAt: f.startedAt || undefined, minutesToClear: f.minutesToClear ? Number(f.minutesToClear) : null, participants: f.participants ? Number(f.participants) : null, observations: f.observations, actions: f.actions } }), 'Recorded')) onClose(); }}>Save</button>
  </section></Drawer>;
}

/** The class teacher's medical alerts for their class (shown on My day). */
export function ClassAlerts({ sectionId }: { sectionId: string }) {
  const a = useLoad<any[]>(`/sections/${sectionId}/medical-alerts`, [sectionId]);
  if (!a.data?.length) return null;
  return <section className="tile"><h3>Medical alerts in your class</h3>{a.data.map((x) => <div key={x.id} className="list-row small" style={{ gridTemplateColumns: '1fr' }}><span><b>{x.name}</b>{x.blood_group ? ` · ${x.blood_group}` : ''} · ⚠ {x.alert || `Allergies: ${x.allergies}`}{x.medication ? ` · ${x.medication}` : ''}</span></div>)}</section>;
}
