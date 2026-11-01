import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, day, openPdf, readBase64 } from '../api';
import { Empty, useAction, useLoad, ask } from '../ui';
import { AuthImg } from './Gate';
import { FailedPage } from '../errors';

/**
 * The Holistic Progress Card (Balvatika to Class V), as NES prescribes it: the class teacher rates
 * each child, part by part, every term; the parent or the teacher fills All About Me and adds the
 * child's drawings; NES keeps the template for each class.
 */

type Item = { id: string; text: string };
type Group = { id: string; title: string; items: Item[] };
type Part =
  | { kind: 'STARS' | 'GOALS'; id: string; tag: string; groups: Group[] }
  | { kind: 'SMILEYS'; id: string; title: string; groups: Group[] }
  | { kind: 'SUBJECT'; id: string; tag?: string; title: string; groups: Group[] }
  | { kind: 'CHOICE'; id: string; tag?: string; title: string; scale: string[]; items: Item[] }
  | { kind: 'YESNO' | 'TEXT'; id: string; tag?: string; title: string; items: Item[] };
type Template = { stage: string; favourites: Item[]; glimpses: string[]; parts: Part[]; custom?: boolean; version?: number };

const partName = (p: Part) => ('title' in p && p.title ? p.title : (p as { tag: string }).tag).replace(/^DEVELOPMENTAL GOAL \d+ : /, '');
const itemsOf = (p: Part) => ('groups' in p ? p.groups.flatMap((g) => g.items) : p.items);

/** The answers an item allows, with how they are shown. */
function options(p: Part): [string, string][] {
  switch (p.kind) {
    case 'STARS': return [['1', '★'], ['2', '★★'], ['3', '★★★'], ['NA', 'N/A']];
    case 'GOALS': case 'SUBJECT': return [['1', '🌱 Beginner'], ['2', '🪴 Progressing'], ['3', '🌳 Proficient'], ['NA', 'N/A']];
    case 'SMILEYS': return [['1', '☹️'], ['2', '🙂'], ['3', '😄']];
    case 'CHOICE': return p.scale.map((s) => [s, s]);
    case 'YESNO': return [['YES', 'Yes'], ['NO', 'No']];
    default: return [];
  }
}

// ── The class teacher's sheet ────────────────────────────────────────────────────────────

export function HolisticSheet() {
  const { id, sectionId } = useParams();
  const sheet = useLoad<any>(`/assessments/${id}/sections/${sectionId}/holistic`, [id, sectionId]);
  const [pick, setPick] = useState<string | null>(null);
  const { run, busy } = useAction();
  const students: any[] = sheet.data?.students ?? [];
  useEffect(() => { if (!pick && students.length) setPick(students[0].enrolment_id); }, [students.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (sheet.error) return <FailedPage error={sheet.error} />;
  if (!sheet.data) return <main className="page"><Empty>Loading…</Empty></main>;
  const d = sheet.data;
  const next = () => { const i = students.findIndex((s) => s.enrolment_id === pick); if (i >= 0 && i < students.length - 1) setPick(students[i + 1].enrolment_id); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/marks" className="small">‹ Marks</Link>
        <span className="localnav-title">{d.section} · Holistic Progress Card</span><span className="muted small">{d.assessment.name}</span><span className="spacer" />
        <button className="btn quiet small" disabled={busy} onClick={() => run(() => openPdf(`/assessments/${id}/sections/${sectionId}/report-cards`))}>{d.assessment.status === 'PUBLISHED' ? 'Print the cards' : 'Print a draft'}</button></div></div>
      <main className="page" style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        <section className="tile tight" style={{ position: 'sticky', top: 70 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>{d.items} items per card{d.favourites ? ` · ${d.favourites} favourites` : ''}</div>
          {students.map((s) => { const done = s.rated >= d.items && s.remark; return (
            <button key={s.enrolment_id} className="list-row" onClick={() => setPick(s.enrolment_id)}
              style={{ gridTemplateColumns: 'minmax(0,1fr) auto', width: '100%', background: pick === s.enrolment_id ? 'var(--blue-soft)' : 'none', border: 0, borderRadius: 8, padding: '8px 8px', textAlign: 'left', cursor: 'pointer' }}>
              <span className="small"><b>{s.roll_no ? `${s.roll_no}. ` : ''}{s.name}</b><span className="tiny muted" style={{ display: 'block' }}>{s.rated} of {d.items} rated{s.remark ? ' · remark' : ''}</span></span>
              <span className={`pill ${done ? 'green' : s.rated ? 'orange' : ''}`}>{done ? 'Done' : s.rated ? 'Started' : 'To do'}</span>
            </button>); })}
        </section>
        {pick ? <ChildCard key={pick} assessmentId={id!} enrolmentId={pick} onSaved={sheet.reload} onNext={next} /> : <Empty>No children in this class.</Empty>}
      </main>
    </>
  );
}

function ChildCard({ assessmentId, enrolmentId, onSaved, onNext }: { assessmentId: string; enrolmentId: string; onSaved: () => void; onNext: () => void }) {
  const c = useLoad<any>(`/assessments/${assessmentId}/holistic/${enrolmentId}`, [assessmentId, enrolmentId]);
  const [vals, setVals] = useState<Record<string, string | null>>({});
  const [remark, setRemark] = useState('');
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<string>('');
  const { run, busy } = useAction();
  useEffect(() => { if (c.data) { setVals(c.data.ratings); setRemark(c.data.remark); setDirty(false); setTab((t) => t || c.data.template.parts[0]?.id); } }, [c.data]);
  if (c.error) return <div className="callout red">{c.error}</div>;
  if (!c.data) return <Empty>Loading…</Empty>;
  const t: Template = c.data.template;
  const open = c.data.assessment.status === 'OPEN';
  const set = (id: string, v: string | null) => { setVals((x) => ({ ...x, [id]: v })); setDirty(true); };
  const save = async (andNext: boolean) => {
    const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => (c.data.ratings[k] ?? null) !== (v === '' ? null : v)).map(([k, v]) => [k, v === '' ? null : v]));
    const ok = await run(() => api(`/assessments/${assessmentId}/holistic/${enrolmentId}`, { method: 'PUT', body: { ratings: changed, remark } }), 'Saved');
    if (ok) { setDirty(false); c.reload(); onSaved(); if (andNext) onNext(); }
  };
  const earlier = (id: string) => (c.data.earlier as { label: string; ratings: Record<string, string> }[]).filter((e) => e.ratings[id]).map((e) => `${e.label}: ${e.ratings[id]}`).join(' · ');
  const part = t.parts.find((p) => p.id === tab) ?? t.parts[0];
  const count = (p: Part) => itemsOf(p).filter((i) => vals[i.id]).length;
  const copyEarlier = () => {
    const last = (c.data.earlier as { ratings: Record<string, string> }[]).at(-1);
    if (!last) return;
    setVals((x) => ({ ...Object.fromEntries(Object.entries(last.ratings).filter(([k]) => itemsOf(part).some((i) => i.id === k))), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v)) })); setDirty(true);
  };
  return (
    <section className="tile stack">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{c.data.student.name}</h2><span className="muted small">{c.data.student.section} · {c.data.assessment.label}</span>
        <span style={{ flex: 1 }} />{dirty && <span className="pill orange">Not saved</span>}
      </div>
      {!open && <div className="callout orange small">The {c.data.assessment.name} is {c.data.assessment.status.toLowerCase()}; the card can no longer be changed.</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {t.parts.map((p) => { const n = itemsOf(p).length, k = count(p); return (
          <button key={p.id} className={`btn small ${tab === p.id ? '' : 'quiet'}`} onClick={() => setTab(p.id)} title={partName(p)}>
            {partName(p).slice(0, 26)}{partName(p).length > 26 ? '…' : ''} <span className="tiny" style={{ opacity: 0.75 }}>{k}/{n}</span></button>); })}
        <button className={`btn small ${tab === 'ME' ? '' : 'quiet'}`} onClick={() => setTab('ME')}>All About Me</button>
      </div>
      {tab === 'ME' ? <AboutMe studentId={c.data.student.studentId} /> : <>
        {'tag' in part && part.tag && <span className="pill" style={{ background: '#FFF3A3', color: '#3A2E00', alignSelf: 'flex-start' }}>{part.tag}</span>}
        {c.data.earlier.length > 0 && open && <div><button className="linkbtn small" onClick={copyEarlier}>Start from {c.data.earlier.at(-1).label}’s ratings for the empty items</button></div>}
        {'groups' in part ? part.groups.map((g, gi) => (
          <div key={g.id} className="stack" style={{ gap: 4 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#0A5A96', color: '#fff', borderRadius: 8, padding: '6px 10px' }}>
              <b className="small" style={{ flex: 1 }}>{part.kind === 'SUBJECT' ? `CG ${gi + 1} ` : part.kind === 'STARS' || part.kind === 'GOALS' ? `${gi + 1}. ` : ''}{g.title}</b>
              {open && <select className="input" style={{ height: 28, width: 'auto', fontSize: '0.78rem' }} value="" onChange={(e) => { for (const it of g.items) set(it.id, e.target.value); }} aria-label="Set every item in this group">
                <option value="">Set all to…</option>{options(part).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
            </div>
            {g.items.map((it) => <Row key={it.id} part={part} item={it} value={vals[it.id] ?? ''} hint={earlier(it.id)} disabled={!open} onChange={(v) => set(it.id, v)} />)}
          </div>)) : part.items.map((it) => <Row key={it.id} part={part} item={it} value={vals[it.id] ?? ''} hint={earlier(it.id)} disabled={!open} onChange={(v) => set(it.id, v)} />)}
        <label className="field"><span>Teacher’s remark for {c.data.assessment.label}</span>
          <textarea className="input" rows={3} maxLength={800} disabled={!open} value={remark} onChange={(e) => { setRemark(e.target.value); setDirty(true); }} placeholder="A sentence or two on progress and what to work on" /></label>
        {open && <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={busy || !dirty} onClick={() => save(false)}>Save</button>
          <button className="btn quiet" disabled={busy} onClick={() => (dirty ? save(true) : onNext())}>{dirty ? 'Save and next child' : 'Next child'}</button></div>}
      </>}
    </section>
  );
}

function Row({ part, item, value, hint, disabled, onChange }: { part: Part; item: Item; value: string; hint: string; disabled: boolean; onChange: (v: string | null) => void }) {
  return (
    <div className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', padding: '8px 0' }}>
      <span className="small">{item.text}{hint && <span className="tiny muted" style={{ display: 'block' }}>Earlier: {hint}</span>}</span>
      {part.kind === 'TEXT'
        ? <input className="input" style={{ width: 260 }} disabled={disabled} maxLength={300} value={value} onChange={(e) => onChange(e.target.value)} />
        : <div className="seg" style={{ flexWrap: 'wrap' }}>{options(part).map(([v, l]) => <button key={v} disabled={disabled} className={value === v ? 'on' : ''} onClick={() => onChange(value === v ? null : v)} style={{ padding: '0 9px', fontSize: '0.8rem' }}>{l}</button>)}</div>}
    </div>
  );
}

// ── All About Me (parent or class teacher) ───────────────────────────────────────────────

const GLIMPSE: Record<string, string> = { FAMILY: 'A glimpse of my family (the child’s drawing)', SELF: 'A glimpse of myself (the child’s drawing)', PORTFOLIO: 'My portfolio (up to 4 pictures of work)' };

export function AboutMe({ studentId }: { studentId: string }) {
  const p = useLoad<any>(`/students/${studentId}/about-me`, [studentId]);
  const [ans, setAns] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  useEffect(() => { if (p.data?.applies) setAns(p.data.answers); }, [p.data]);
  if (p.error) return <div className="callout red small">{p.error}</div>;
  if (!p.data) return <Empty>Loading…</Empty>;
  if (!p.data.applies) return <Empty>All About Me is part of the Holistic Progress Card, for Balvatika to Class V.</Empty>;
  const add = async (kind: string, f: File | undefined) => { if (f && await run(async () => api(`/students/${studentId}/glimpses`, { body: { kind, dataBase64: await readBase64(f) } }), 'Added to the card')) p.reload(); };
  return (
    <div className="stack">
      <p className="small muted">Name, date of birth, class and parents’ names come from the school’s records; height and weight from the school’s health check-up{p.data.lastCheckup ? ` (last on ${day(p.data.lastCheckup.on_date)}: ${p.data.lastCheckup.height_cm ?? '—'} cm, ${p.data.lastCheckup.weight_kg ?? '—'} kg)` : ''}.</p>
      {p.data.favourites.length > 0 && <>
        <b className="small">My favourites</b>
        {p.data.favourites.map((f: Item) => <label key={f.id} className="field"><span>{f.text}</span>
          <input className="input" maxLength={120} value={ans[f.id] ?? ''} onChange={(e) => setAns({ ...ans, [f.id]: e.target.value })} /></label>)}
        <div><button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/students/${studentId}/about-me`, { method: 'PUT', body: { answers: ans } }), 'Saved')) p.reload(); }}>Save favourites</button>
          {p.data.updatedBy && <span className="tiny muted" style={{ marginLeft: 8 }}>Last changed by {p.data.updatedBy}</span>}</div>
      </>}
      {p.data.glimpses.map((k: string) => { const mine = p.data.photos.filter((x: any) => x.kind === k); return (
        <div key={k} className="stack" style={{ gap: 6 }}>
          <b className="small">{GLIMPSE[k]}</b>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mine.map((x: any) => <div key={x.id} style={{ position: 'relative' }}><AuthImg path={`/glimpses/${x.id}`} style={{ height: 110, borderRadius: 8, border: '1px solid var(--line)' }} />
              <button className="linkbtn tiny" disabled={busy} onClick={async () => { if (await ask('Remove this picture from the card?') && await run(() => api(`/glimpses/${x.id}`, { method: 'DELETE' }), 'Removed')) p.reload(); }} style={{ display: 'block' }}>Remove</button></div>)}
          </div>
          {(k !== 'PORTFOLIO' || mine.length < 4) && <input type="file" accept="image/jpeg,image/png" capture="environment" disabled={busy} onChange={(e) => add(k, e.target.files?.[0])} aria-label={GLIMPSE[k]} />}
        </div>); })}
    </div>
  );
}

// ── NES: the templates ───────────────────────────────────────────────────────────────────

export function HpcTemplates() {
  const list = useLoad<any[]>('/hpc/templates');
  const [cls, setCls] = useState<string | null>(null);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Holistic Progress Card templates</span></div></div>
      <main className="page">
        <section className="tile">
          <h2>What each class’s card asks</h2>
          <p className="small muted" style={{ marginTop: 6 }}>The NES default for every class is taken from the schools’ own cards (Balvatika in stars; Classes I–II in plants with self and peer assessment; Classes III–V in the PARAKH parts). Change a class here and every school prints the new version; ratings already given stay with their statements.</p>
          {!list.data ? <Empty>Loading…</Empty> : <table className="table" style={{ marginTop: 10 }}><thead><tr><th>Class</th><th>Format</th><th>Version</th><th /></tr></thead>
            <tbody>{list.data.map((t) => <tr key={t.classCode}><td><b>{t.className}</b></td><td>{t.stage.toLowerCase()}</td>
              <td>{t.custom ? `Changed by ${t.updatedBy}, ${day(t.updatedAt)} (v${t.version})` : 'NES default'}</td>
              <td className="num"><button className="btn quiet small" onClick={() => setCls(t.classCode)}>{cls === t.classCode ? 'Open below' : 'Open'}</button></td></tr>)}</tbody></table>}
        </section>
        {cls && <TemplateEditor key={cls} classCode={cls} onDone={() => { list.reload(); }} />}
      </main>
    </>
  );
}

function TemplateEditor({ classCode, onDone }: { classCode: string; onDone: () => void }) {
  const src = useLoad<Template>(`/hpc/templates/${classCode}`, [classCode]);
  const [t, setT] = useState<Template | null>(null);
  const [openPart, setOpenPart] = useState<string | null>(null);
  const { run, busy } = useAction();
  useEffect(() => { if (src.data) setT(structuredClone(src.data)); }, [src.data]);
  const changed = useMemo(() => !!t && !!src.data && JSON.stringify(t) !== JSON.stringify(src.data), [t, src.data]);
  if (!t) return <Empty>Loading…</Empty>;
  const upd = (fn: (x: Template) => void) => { const x = structuredClone(t); fn(x); setT(x); };
  const itemsEditor = (items: Item[], path: (x: Template) => Item[]) => <>
    {items.map((it, i) => <div key={it.id || `new${i}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      <span className="tiny muted" style={{ width: 52, paddingTop: 8 }}>{it.id || 'new'}</span>
      <textarea className="input" rows={1} style={{ flex: 1, minHeight: 34 }} value={it.text} onChange={(e) => upd((x) => { path(x)[i].text = e.target.value; })} />
      <button className="linkbtn tiny" style={{ paddingTop: 8 }} onClick={() => upd((x) => { path(x).splice(i, 1); })}>Remove</button></div>)}
    <div><button className="linkbtn small" onClick={() => upd((x) => { path(x).push({ id: '', text: '' }); })}>+ Add a statement</button></div>
  </>;
  return (
    <section className="tile stack">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h2 style={{ margin: 0, flex: 1 }}>Class {classCode}</h2>
        {src.data?.custom && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await ask('Go back to the NES default for this class?') && await run(() => api(`/hpc/templates/${classCode}`, { method: 'DELETE' }), 'Back to the default')) { src.reload(); onDone(); } }}>Use the NES default</button>}
        <button className="btn small" disabled={busy || !changed} onClick={async () => { if (await run(() => api(`/hpc/templates/${classCode}`, { method: 'PUT', body: { stage: t.stage, favourites: t.favourites, glimpses: t.glimpses, parts: t.parts } }), 'Saved: schools print this from now')) { src.reload(); onDone(); } }}>Save</button></div>
      {t.favourites.length > 0 && <details><summary className="small"><b>All About Me: favourites asked</b></summary><div className="stack" style={{ marginTop: 6 }}>{itemsEditor(t.favourites, (x) => x.favourites)}</div></details>}
      {t.parts.map((p, pi) => (
        <details key={p.id} open={openPart === p.id} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setOpenPart(p.id); }}>
          <summary className="small"><b>{partName(p)}</b> <span className="muted">· {p.kind.toLowerCase()} · {itemsOf(p).length} statements</span></summary>
          <div className="stack" style={{ marginTop: 8, paddingLeft: 10, borderLeft: '3px solid var(--line)' }}>
            {'title' in p && <label className="field"><span>Heading</span><input className="input" value={p.title} onChange={(e) => upd((x) => { (x.parts[pi] as { title: string }).title = e.target.value; })} /></label>}
            {'tag' in p && p.tag !== undefined && <label className="field"><span>Tag</span><input className="input" value={p.tag} onChange={(e) => upd((x) => { (x.parts[pi] as { tag: string }).tag = e.target.value; })} /></label>}
            {'groups' in p ? p.groups.map((g, gi) => <div key={g.id} className="stack" style={{ gap: 4 }}>
              <input className="input" style={{ fontWeight: 600 }} value={g.title} onChange={(e) => upd((x) => { (x.parts[pi] as { groups: Group[] }).groups[gi].title = e.target.value; })} />
              {itemsEditor(g.items, (x) => (x.parts[pi] as { groups: Group[] }).groups[gi].items)}</div>)
              : itemsEditor(p.items, (x) => (x.parts[pi] as { items: Item[] }).items)}
            {'groups' in p && <div><button className="linkbtn small" onClick={() => upd((x) => { (x.parts[pi] as { groups: Group[] }).groups.push({ id: '', title: 'New group', items: [{ id: '', text: 'New statement' }] }); })}>+ Add a group</button></div>}
          </div>
        </details>))}
    </section>
  );
}
