import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, day, openPdf, time, today, words, type User } from '../api';
import { Drawer, Empty, SchoolPicker, ask, askText, useAction, useLoad, useSchools } from '../ui';
import { Files } from '../files';
import { FailedPage } from '../errors';
import { PersonPicker } from './Governance';

/**
 * School inspections: NES and the Commands plan visits against a checklist and rate each item; the
 * principal sees the report, responds to each finding, and can assess the school against any
 * checklist themselves. Inspectors' own list shows only their visits.
 */

const TONE: Record<string, string> = { PLANNED: 'blue', IN_PROGRESS: 'orange', REPORTED: 'blue', CLOSED: 'green', CANCELLED: 'red', OPEN: 'orange', RESPONDED: 'blue',
  CRITICAL: 'red', MAJOR: 'red', MINOR: 'orange', ADVISORY: '' };
const KIND: Record<string, string> = { ANNUAL: 'Annual', SURPRISE: 'Surprise', THEMATIC: 'Thematic', SELF: 'Self-assessment' };
const Pill = ({ s }: { s: string }) => <span className={`pill ${TONE[s] ?? ''}`}>{words(s)}</span>;
const Score = ({ v }: { v: number | null }) => v === null || v === undefined ? <span className="muted">—</span>
  : <b style={{ color: v >= 75 ? 'var(--green)' : v >= 50 ? 'var(--orange)' : 'var(--red)' }}>{v}%</b>;

export function Inspections({ user }: { user: User }) {
  const inspector = ['NES_ADMIN', 'COMMAND_OFFICER'].includes(user.role);
  const head = user.role === 'SCHOOL_ADMIN';
  const [tab, setTab] = useState('open');
  const [plan, setPlan] = useState(false);
  const [tpl, setTpl] = useState<any>(null);
  const list = useLoad<any[]>(tab === 'checklists' ? null : '/inspections', [tab]);
  const templates = useLoad<any[]>(inspector || head ? '/inspections/templates' : null, [tab]);
  const nav = useNavigate();
  const rows = (list.data ?? []).filter((i) => tab === 'all' || ['PLANNED', 'IN_PROGRESS', 'REPORTED'].includes(i.status));
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Inspections</span><span className="spacer" style={{ flex: 1 }} />
        <div className="seg">{[['open', 'Open'], ['all', 'All'], ...(inspector || head ? [['checklists', 'Checklists']] : [])].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {(inspector || head) && <button className="btn small" onClick={() => setPlan(true)}>{inspector ? 'Plan an inspection' : 'Assess my school'}</button>}</div></div>
      <main className="page">
        {tab === 'checklists' ? <section className="tile">
          <div className="tile-head"><div><h3>Checklists</h3><p className="tiny muted">Each inspection keeps a copy of the checklist as it was when it was planned, so changing a checklist never changes a report already made.</p></div>
            {inspector && <button className="btn quiet small" onClick={() => setTpl({})}>New checklist</button>}</div>
          {!templates.data ? <Empty>{templates.error ?? 'Loading…'}</Empty> : !templates.data.length ? <Empty>No checklists yet.</Empty> : templates.data.map((t) => <div key={t.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', opacity: t.active ? 1 : 0.6 }}>
            <span><b>{t.name}</b> {!t.active && <span className="pill">Not in use</span>}<span className="tiny muted" style={{ display: 'block' }}>{t.unit} · {t.sections.length} sections · {t.sections.reduce((a: number, s: any) => a + s.items.length, 0)} items · rated 1 to {t.scale} · used {t.used} times</span>
              {t.purpose && <span className="small" style={{ display: 'block' }}>{t.purpose}</span>}</span>
            {t.editable ? <button className="btn quiet small" onClick={() => setTpl(t)}>Edit</button> : <button className="linkbtn small" onClick={() => setTpl({ ...t, readOnly: true })}>View</button>}</div>)}
        </section> : <section className="tile">
          {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !rows.length ? <Empty>{tab === 'open' ? 'No inspections are open.' : 'No inspections yet.'}</Empty> : rows.map((i) => <Link key={i.id} to={`/inspections/${i.id}`} className="list-row row-link" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span><b>{i.title}</b><span className="tiny muted" style={{ display: 'block' }}>{i.school} · {KIND[i.kind]} · {day(i.scheduled_on)} · led by {i.lead}</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{i.score !== null && <Score v={i.score} />}{i.overdue_findings > 0 && <span className="pill red">{i.overdue_findings} overdue</span>}{i.open_findings > 0 && <span className="pill orange">{i.open_findings} findings open</span>}<Pill s={i.status} /></span></Link>)}
        </section>}
      </main>
      {plan && <PlanDrawer user={user} templates={(templates.data ?? []).filter((t) => t.active)} onClose={(id) => { setPlan(false); if (id) nav(`/inspections/${id}`); else list.reload(); }} />}
      {tpl && <TemplateDrawer user={user} t={tpl} onClose={() => { setTpl(null); templates.reload(); }} />}
    </>
  );
}

function PlanDrawer({ user, templates, onClose }: { user: User; templates: any[]; onClose: (id?: string) => void }) {
  const self = user.role === 'SCHOOL_ADMIN';
  const { schools } = useSchools();
  const [f, setF] = useState({ schoolId: '', templateId: templates[0]?.id ?? '', kind: self ? 'SELF' : 'ANNUAL', title: '', scheduledOn: today() });
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState<any>(null);
  const { run, busy } = useAction();
  useEffect(() => { if (!f.schoolId && schools.length) setF((x) => ({ ...x, schoolId: schools[0].id })); }, [schools.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pick) { if (!team.some((t) => t.id === pick.id)) setTeam([...team, pick]); setPick(null); } }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const unit = user.scopePath ? schools.find((s) => s.id === f.schoolId)?.id ?? '' : '';
  return <Drawer title={self ? 'Assess my school' : 'Plan an inspection'} onClose={() => onClose()}><section className="tile tight stack">
    {!self && <label className="field"><span>School</span><select className="input" value={f.schoolId} onChange={(e) => setF({ ...f, schoolId: e.target.value })}>{schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
    {self && schools.length > 1 && <SchoolPicker value={f.schoolId} onChange={(v) => setF({ ...f, schoolId: v })} schools={schools} />}
    <label className="field"><span>Checklist</span><select className="input" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    {!self && <div className="seg">{['ANNUAL', 'THEMATIC', 'SURPRISE'].map((k) => <button key={k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{KIND[k]}</button>)}</div>}
    {f.kind === 'SURPRISE' && <p className="tiny muted">The school does not see a surprise inspection until the team starts it.</p>}
    <div className="form-grid">
      <label className="field"><span>Title (optional)</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>On</span><input className="input" type="date" min={self ? undefined : today()} value={f.scheduledOn} onChange={(e) => setF({ ...f, scheduledOn: e.target.value })} /></label>
    </div>
    {!self && <><span className="small"><b>Team</b> · you lead it{team.length ? `, with ${team.map((t) => t.name).join(', ')}` : ''}</span>
      {unit && <PersonPicker unitId={unit} value={pick} onChange={setPick} label="Add an inspector" optional />}</>}
    {!templates.length && <div className="callout small">No checklist is in use yet. {self ? 'NES or your Command adds checklists.' : 'Add one under Checklists.'}</div>}
    <button className="btn big" disabled={busy || !f.schoolId || !f.templateId || !f.scheduledOn} onClick={async () => {
      const r: any = await run(() => api('/inspections', { body: { schoolId: f.schoolId, templateId: f.templateId, kind: f.kind, title: f.title || undefined, scheduledOn: f.scheduledOn, teamIds: team.map((t) => t.id) } }), self ? 'Self-assessment started' : f.kind === 'SURPRISE' ? 'Planned; the school is not told' : 'Planned; the school is told');
      if (r) onClose(r.id);
    }}>{self ? 'Start' : 'Plan it'}</button>
  </section></Drawer>;
}

/** A checklist: sections, each a list of items one per line; "x2" at the end of a line counts it double. */
function TemplateDrawer({ user, t, onClose }: { user: User; t: any; onClose: () => void }) {
  const ro = !!t.readOnly;
  const { units } = useSchools();
  const own = units.find((u) => u.path === user.scopePath);
  const [f, setF] = useState({ name: t.name ?? '', purpose: t.purpose ?? '', scale: String(t.scale ?? 4), active: t.active ?? true });
  const [sections, setSections] = useState<{ title: string; lines: string }[]>((t.sections ?? [{ title: '', items: [] }]).map((s: any) => ({ title: s.title, lines: s.items.map((i: any) => `${i.text}${i.weight > 1 ? ` x${i.weight}` : ''}`).join('\n') })));
  const { run, busy } = useAction();
  const parsed = sections.map((s) => ({ title: s.title.trim(), items: s.lines.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /\s+x([1-5])$/i.exec(l); return { text: m ? l.slice(0, m.index) : l, weight: m ? Number(m[1]) : 1 }; }) }));
  const ok = f.name.trim().length >= 3 && parsed.length && parsed.every((s) => s.title && s.items.length);
  return <Drawer title={ro ? t.name : t.id ? 'Edit checklist' : 'New checklist'} onClose={onClose}><section className="tile tight stack">
    <label className="field"><span>Name</span><input className="input" disabled={ro} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Annual school inspection" /></label>
    <label className="field"><span>What it is for</span><textarea className="input" disabled={ro} rows={2} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
    <label className="field"><span>Rated from 1 to</span><select className="input" disabled={ro} value={f.scale} onChange={(e) => setF({ ...f, scale: e.target.value })}><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
    {sections.map((s, i) => <div key={i} className="callout stack small">
      <div style={{ display: 'flex', gap: 8 }}><input className="input" disabled={ro} value={s.title} placeholder={`Section ${i + 1}, for example Safety`} onChange={(e) => setSections(sections.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
        {!ro && sections.length > 1 && <button className="linkbtn tiny" onClick={() => setSections(sections.filter((_, j) => j !== i))}>Remove</button>}</div>
      <textarea className="input" disabled={ro} rows={5} value={s.lines} placeholder={'One item per line\nFire extinguishers in date x2\nEvacuation plan displayed on every floor'} onChange={(e) => setSections(sections.map((x, j) => j === i ? { ...x, lines: e.target.value } : x))} />
    </div>)}
    {!ro && <><button className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setSections([...sections, { title: '', lines: '' }])}>Add a section</button>
      <span className="tiny muted">End a line with x2 (up to x5) to make that item count more in the score.</span>
      {t.id && <label className="check small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> In use for new inspections</label>}
      <button className="btn big" disabled={busy || !ok || !own} onClick={async () => { if (await run(() => api('/inspections/templates', { body: { id: t.id, unitId: t.unit_id ?? own!.id, name: f.name, purpose: f.purpose, scale: Number(f.scale), sections: parsed, active: f.active } }), 'Checklist saved')) onClose(); }}>Save the checklist</button></>}
  </section></Drawer>;
}

export function InspectionPage() {
  const { id } = useParams();
  const d = useLoad<any>(`/inspections/${id}`, [id]);
  const { run, busy } = useAction();
  const [rate, setRate] = useState<Record<string, { rating: number | null; na: boolean; remark: string }>>({});
  const [dirty, setDirty] = useState(false);
  const [finding, setFinding] = useState<{ itemId: string; severity: string; body: string; dueOn: string } | null>(null);
  useEffect(() => {
    if (!d.data) return;
    setRate(Object.fromEntries(d.data.ratings.map((r: any) => [r.item_id, { rating: r.rating, na: r.not_applicable, remark: r.remark }])));
    setDirty(false);
  }, [d.data]);
  if (!d.data) return d.error ? <FailedPage error={d.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const x = d.data, r = x.rights, scale = x.checklist.scale;
  const save = async () => { if (await run(() => api(`/inspections/${x.id}/ratings`, { method: 'PUT', body: { entries: Object.entries(rate).map(([itemId, v]) => ({ itemId, rating: v.na ? null : v.rating, notApplicable: v.na, remark: v.remark })) } }), 'Ratings saved')) d.reload(); };
  const set = (itemId: string, v: Partial<{ rating: number | null; na: boolean; remark: string }>) => { setRate({ ...rate, [itemId]: { ...(rate[itemId] ?? { rating: null, na: false, remark: '' }), ...v } }); setDirty(true); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/inspections" className="linkbtn small">‹ Inspections</Link><span className="spacer" style={{ flex: 1 }} />
        <button className="btn quiet small" disabled={busy} onClick={() => run(() => openPdf(`/inspections/${x.id}/report.pdf`))}>Report PDF</button>
        {r.cancel && <button className="btn quiet small" disabled={busy} onClick={async () => { const why = await askText('Why is the inspection called off?'); if (why && await run(() => api(`/inspections/${x.id}/cancel`, { body: { reason: why } }), 'Called off')) d.reload(); }}>Call off</button>}
        {r.rate && x.status === 'PLANNED' && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/inspections/${x.id}/start`, { body: {} }), 'Started')) d.reload(); }}>Start</button>}
        {r.report && <button className="btn small" disabled={busy || dirty} onClick={async () => { const s = await askText(`Submit the report? Score ${x.progress.score ?? 0}%. Write a short summary for the school and NES.`, { multiline: true }); if (s && await run(() => api(`/inspections/${x.id}/report`, { body: { summary: s } }), 'Report submitted')) d.reload(); }}>Submit the report</button>}
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="eyebrow">{x.school} · {KIND[x.kind]} · {day(x.scheduled_on)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 4 }}><h2>{x.title}</h2><Pill s={x.status} /></div>
          <div className="kpis" style={{ marginTop: 10 }}>
            <div><div className="kpi-label">{x.score !== null ? 'Score' : 'Score so far'}</div><div className="kpi-value"><Score v={x.score ?? x.progress.score} /></div></div>
            <div><div className="kpi-label">Rated</div><div className="kpi-value">{x.progress.done}/{x.progress.items}</div></div>
            <div><div className="kpi-label">Findings open</div><div className="kpi-value">{x.findings.filter((f: any) => f.status !== 'CLOSED').length}</div></div>
            {x.previous.length > 0 && <div><div className="kpi-label">Last time</div><div className="kpi-value"><Score v={x.previous[0].score} /></div><div className="kpi-note">{day(x.previous[0].scheduled_on)}</div></div>}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Led by {x.lead}{x.team.length > 1 ? ` with ${x.team.filter((t: any) => t.name !== x.lead).map((t: any) => t.name).join(', ')}` : ''}.</p>
          {x.summary && <p style={{ whiteSpace: 'pre-line', marginTop: 8 }}>{x.summary}</p>}
        </section>

        {x.checklist.sections.map((s: any) => { const sc = x.progress.sections.find((p: any) => p.title === s.title)?.score; return <section key={s.title} className="tile">
          <div className="tile-head"><h3>{s.title}</h3>{sc !== null && sc !== undefined && <Score v={sc} />}</div>
          {s.items.map((it: any) => { const v = rate[it.id] ?? { rating: null, na: false, remark: '' }; return <div key={it.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <span><span className="tiny muted mono">{it.id}</span> {it.text}{it.weight > 1 && <span className="pill" style={{ marginLeft: 6 }}>counts ×{it.weight}</span>}</span>
            {r.rate ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="seg">{Array.from({ length: scale }, (_, k) => k + 1).map((n) => <button key={n} className={!v.na && v.rating === n ? 'on' : ''} onClick={() => set(it.id, { rating: n, na: false })}>{n}</button>)}
                <button className={v.na ? 'on' : ''} onClick={() => set(it.id, { na: true, rating: null })}>N/A</button></div>
              <input className="input" style={{ flex: 1, minWidth: 180, height: 34 }} value={v.remark} placeholder="Remark" onChange={(e) => set(it.id, { remark: e.target.value })} />
              <button className="linkbtn small" onClick={() => setFinding({ itemId: it.id, severity: 'MINOR', body: '', dueOn: '' })}>Finding</button></div>
              : <span className="small">{v.na ? 'Not applicable' : v.rating ? <b>{v.rating} of {scale}</b> : <span className="muted">Not rated</span>}{v.remark ? ` · ${v.remark}` : ''}</span>}
          </div>; })}
        </section>; })}
        {r.rate && <div style={{ display: 'flex', gap: 8 }}><button className="btn" disabled={busy || !dirty} onClick={save}>Save the ratings</button><button className="btn quiet" onClick={() => setFinding({ itemId: '', severity: 'MINOR', body: '', dueOn: '' })}>Record a finding</button></div>}

        <section className="tile stack">
          <h3>Findings</h3>
          {!x.findings.length ? <Empty>No findings.</Empty> : x.findings.map((f: any) => <div key={f.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <span><Pill s={f.severity} /> {f.item_id && <span className="tiny muted mono">{f.item_id}</span>} <b>{f.body}</b> <Pill s={f.status} />{f.overdue && <span className="pill red" style={{ marginLeft: 4 }}>Overdue</span>}
              <span className="tiny muted" style={{ display: 'block' }}>{f.due_on ? `To be put right by ${day(f.due_on)}` : 'Advice'}{f.closed_by ? ` · closed by ${f.closed_by}` : ''}</span>
              {f.response && <span className="small" style={{ display: 'block', whiteSpace: 'pre-line' }}>School: {f.response}{f.responded_by ? <span className="tiny muted"> ({f.responded_by}, {time(f.responded_at)})</span> : null}</span>}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {r.respond && f.status === 'OPEN' && <button className="btn small" onClick={async () => { const t = await askText('What has the school done about this finding?', { multiline: true }); if (t && await run(() => api(`/inspections/findings/${f.id}/respond`, { body: { response: t } }), 'Response sent to the inspector')) d.reload(); }}>Respond</button>}
              {r.close && f.status === 'RESPONDED' && <><button className="btn small" disabled={busy} onClick={async () => { if (await ask('Accept the school’s response and close this finding?') && await run(() => api(`/inspections/findings/${f.id}/decide`, { body: { accept: true } }), 'Closed')) d.reload(); }}>Accept</button>
                <button className="btn quiet small" disabled={busy} onClick={async () => { const n = await askText('What is still needed? The principal is told.'); if (n && await run(() => api(`/inspections/findings/${f.id}/decide`, { body: { accept: false, note: n } }), 'Sent back')) d.reload(); }}>Send back</button></>}
              {r.rate && f.status === 'OPEN' && <button className="linkbtn small" onClick={async () => { if (await ask('Withdraw this finding?') && await run(() => api(`/inspections/findings/${f.id}`, { method: 'DELETE' }), 'Withdrawn')) d.reload(); }}>Withdraw</button>}
            </div>
          </div>)}
          <Files kind="inspection" id={x.id} canAdd={r.rate || r.respond} title="Evidence" hint={r.respond ? 'Photos or documents showing what the school has done.' : 'Photos and documents seen during the visit.'} />
        </section>
      </main>
      {finding && <Drawer title="Record a finding" onClose={() => setFinding(null)}><section className="tile tight stack">
        <label className="field"><span>Checklist item</span><select className="input" value={finding.itemId} onChange={(e) => setFinding({ ...finding, itemId: e.target.value })}><option value="">General</option>
          {x.checklist.sections.flatMap((s: any) => s.items).map((it: any) => <option key={it.id} value={it.id}>{it.id} {it.text}</option>)}</select></label>
        <div className="seg">{['ADVISORY', 'MINOR', 'MAJOR', 'CRITICAL'].map((k) => <button key={k} className={finding.severity === k ? 'on' : ''} onClick={() => setFinding({ ...finding, severity: k })}>{words(k)}</button>)}</div>
        <label className="field"><span>What needs to be put right</span><textarea className="input" rows={3} value={finding.body} onChange={(e) => setFinding({ ...finding, body: e.target.value })} /></label>
        <label className="field"><span>By {finding.severity === 'ADVISORY' || x.kind === 'SELF' ? '(optional)' : ''}</span><input className="input" type="date" min={today()} value={finding.dueOn} onChange={(e) => setFinding({ ...finding, dueOn: e.target.value })} /></label>
        <button className="btn big" disabled={busy || finding.body.trim().length < 5} onClick={async () => { if (await run(() => api(`/inspections/${x.id}/findings`, { body: { itemId: finding.itemId || null, severity: finding.severity, body: finding.body, dueOn: finding.dueOn || null } }), 'Finding recorded')) { setFinding(null); d.reload(); } }}>Record</button>
      </section></Drawer>}
    </>
  );
}
