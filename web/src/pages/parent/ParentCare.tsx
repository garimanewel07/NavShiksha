import { useEffect, useState } from 'react';
import { api, apiFile, day, readBase64, time, today } from '../../api';
import { Empty, useAction, useLoad, ask } from '../../ui';
import { useChildren } from './ParentHome';
import { Screen } from './ParentModules';
import { AboutMe } from '../Holistic';

/**
 * The parent app's care pages: the child's health record (kept by the parent; the class teacher sees
 * the alert line and the nurse the rest), check-ups, immunisations and infirmary visits; and leaving
 * early: the people who may collect the child (with photo and QR card) and gate passes.
 */

export function ParentHealth() {
  const { current } = useChildren();
  const h = useLoad<any>(current ? `/students/${current.id}/health` : null, [current?.id]);
  const [f, setF] = useState<any>(null);
  const [vac, setVac] = useState({ vaccine: '', dose: '', givenOn: '' });
  const { run, busy } = useAction();
  useEffect(() => { const r = h.data?.record; setF({ allergies: r?.allergies ?? '', conditions: r?.conditions ?? '', medication: r?.medication ?? '', diet: r?.diet ?? '', alert: r?.alert ?? '', doctor: r?.doctor ?? '', doctorPhone: r?.doctor_phone ?? '' }); }, [h.data]);
  const x = h.data;
  return (
    <Screen title="Health">
      {!x || !f ? <Empty>{h.error ?? 'Loading…'}</Empty> : <>
        <section className="card stack">
          <div className="small muted">Health details{x.bloodGroup ? ` · blood group ${x.bloodGroup}` : ''}</div>
          {([['alert', 'Alert for the class teacher (one line)', 'Severe peanut allergy: EpiPen in bag'], ['allergies', 'Allergies', ''], ['conditions', 'Conditions', 'Asthma'], ['medication', 'Regular medication', ''], ['diet', 'Diet', 'Vegetarian'], ['doctor', 'Family doctor', ''], ['doctorPhone', 'Doctor’s phone', '']] as const).map(([k, l, ph]) =>
            <label key={k} className="field"><span>{l}</span><input className="input" value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/students/${current!.id}/health`, { method: 'PUT', body: f }), 'Saved; the school nurse and class teacher see it')) h.reload(); }}>Save</button>
          {x.record?.updated_at && <span className="tiny muted">Last changed {day(x.record.updated_at)} by {x.record.updated_by}</span>}
        </section>
        {x.visits.length > 0 && <section className="card stack"><div className="small muted">Visits to the school infirmary</div>
          {x.visits.map((v: any) => <div key={v.id} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><b>{time(v.at)}: {v.complaint}</b><span>{v.treatment}{v.medicines?.length ? ` · ${v.medicines.map((m: any) => m.name).join(', ')}` : ''}</span></div>)}</section>}
        <section className="card stack"><div className="small muted">Check-ups</div>
          {!x.checkups.length ? <p className="muted">No check-up recorded yet.</p> : x.checkups.map((c: any) => <div key={c.id} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><b>{day(c.on_date)}</b><span>{c.height_cm ?? '—'} cm · {c.weight_kg ?? '—'} kg{c.bmi ? ` · BMI ${c.bmi}` : ''}{c.vision_left ? ` · vision ${c.vision_left}/${c.vision_right ?? ''}` : ''}{c.dental ? ` · teeth: ${c.dental}` : ''}</span></div>)}</section>
        <section className="card stack"><div className="small muted">Immunisations</div>
          {x.immunisations.map((i: any) => <div key={i.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span>{i.vaccine} {i.dose}</span><span className={`pill ${i.given_on ? 'green' : 'orange'}`}>{i.given_on ? `Given ${day(i.given_on)}` : `Due ${day(i.due_on)}`}</span></div>)}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><input className="input" style={{ flex: '2 1 140px' }} placeholder="Vaccine" value={vac.vaccine} onChange={(e) => setVac({ ...vac, vaccine: e.target.value })} />
            <input className="input" style={{ flex: '1 1 70px' }} placeholder="Dose" value={vac.dose} onChange={(e) => setVac({ ...vac, dose: e.target.value })} />
            <input className="input" style={{ flex: '1 1 130px' }} type="date" max={today()} value={vac.givenOn} onChange={(e) => setVac({ ...vac, givenOn: e.target.value })} />
            <button className="btn quiet small" disabled={busy || vac.vaccine.trim().length < 2 || !vac.givenOn} onClick={async () => { if (await run(() => api(`/students/${current!.id}/immunisations`, { body: vac }), 'Added')) { setVac({ vaccine: '', dose: '', givenOn: '' }); h.reload(); } }}>Add</button></div></section>
      </>}
    </Screen>
  );
}

export function ParentGatePass() {
  const { current } = useChildren();
  const people = useLoad<any[]>(current ? `/students/${current.id}/pickups` : null, [current?.id]);
  const passes = useLoad<any[]>(current ? `/students/${current.id}/gate-passes` : null, [current?.id]);
  const [p, setP] = useState({ name: '', relation: '', phone: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [g, setG] = useState({ on: today(), leaveAt: '12:30', reason: '', pickupId: '' });
  const { run, busy } = useAction();
  const card = async (id: string) => { const { blob } = await apiFile(`/pickups/${id}/card`); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  return (
    <Screen title="Leaving early">
      <section className="card stack"><div className="small muted">Ask for a gate pass</div>
        <p className="tiny muted">The class teacher approves it; the guard checks the person collecting against their photo, and you are told when your child leaves.</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><input className="input" style={{ flex: '1 1 130px' }} type="date" min={today()} value={g.on} onChange={(e) => setG({ ...g, on: e.target.value })} />
          <input className="input" style={{ flex: '1 1 100px' }} type="time" value={g.leaveAt} onChange={(e) => setG({ ...g, leaveAt: e.target.value })} /></div>
        <input className="input" placeholder="Reason" value={g.reason} onChange={(e) => setG({ ...g, reason: e.target.value })} />
        <select className="input" value={g.pickupId} onChange={(e) => setG({ ...g, pickupId: e.target.value })}><option value="">I will collect my child</option>{(people.data ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.relation})</option>)}</select>
        <button className="btn" disabled={busy || g.reason.trim().length < 3} onClick={async () => { if (await run(() => api(`/students/${current!.id}/gate-passes`, { body: { ...g, pickupId: g.pickupId || null } }), 'Sent to the class teacher')) { setG({ ...g, reason: '' }); passes.reload(); } }}>Ask</button></section>
      {(passes.data ?? []).length > 0 && <section className="card stack"><div className="small muted">Gate passes</div>
        {passes.data!.map((x) => <div key={x.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{day(x.on_date)} {x.leave_at.slice(0, 5)}</b> · {x.reason}{x.pickup ? ` · ${x.pickup}` : ''}{x.decision_note ? ` · “${x.decision_note}”` : ''}</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span className={`pill ${x.status === 'APPROVED' || x.status === 'LEFT' ? 'green' : x.status === 'REJECTED' ? 'red' : ''}`}>{x.status === 'LEFT' ? `Left ${time(x.left_at)}` : x.status.toLowerCase()}</span>
            {['REQUESTED', 'APPROVED'].includes(x.status) && <button className="linkbtn tiny" disabled={busy} onClick={async () => { if (await run(() => api(`/gate-passes/${x.id}/cancel`, { body: {} }), 'Cancelled')) passes.reload(); }}>Cancel</button>}</span></div>)}</section>}
      <section className="card stack"><div className="small muted">Who may collect my child</div>
        {(people.data ?? []).filter((x) => x.active).map((x) => <div key={x.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{x.name}</b> · {x.relation}{x.phone ? ` · ${x.phone.replace('+91', '')}` : ''}</span>
          <span style={{ display: 'flex', gap: 6 }}><button className="linkbtn tiny" onClick={() => run(() => card(x.id))}>Card with QR</button><button className="linkbtn tiny" disabled={busy} onClick={async () => { if (await ask(`Stop ${x.name} collecting your child?`) && await run(() => api(`/pickups/${x.id}`, { method: 'DELETE' }), 'Removed')) people.reload(); }}>Remove</button></span></div>)}
        <input className="input" placeholder="Name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        <div style={{ display: 'flex', gap: 6 }}><input className="input" placeholder="Relation (grandmother, driver)" value={p.relation} onChange={(e) => setP({ ...p, relation: e.target.value })} /><input className="input" inputMode="tel" placeholder="Mobile" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></div>
        <label className="field"><span>A clear photo of their face</span><input type="file" accept="image/jpeg,image/png" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></label>
        <button className="btn quiet" disabled={busy || p.name.trim().length < 2 || p.relation.trim().length < 2 || !photo} onClick={async () => { if (await run(async () => api(`/students/${current!.id}/pickups`, { body: { ...p, phone: p.phone || undefined, photoBase64: await readBase64(photo!) } }), 'Added; download their card')) { setP({ name: '', relation: '', phone: '' }); setPhoto(null); people.reload(); } }}>Add</button></section>
    </Screen>
  );
}

/** Class X families choose the streams they want for Class XI, in order (allotted by merit). */
export function ParentStreams() {
  const { current } = useChildren();
  const d = useLoad<any>(current ? `/students/${current.id}/streams` : null, [current?.id]);
  const [pick, setPick] = useState<string[]>([]);
  const { run, busy } = useAction();
  useEffect(() => { setPick(d.data?.choice?.choices ?? []); }, [d.data]);
  const x = d.data;
  return (
    <Screen title="Class XI stream">
      {!x ? <Empty>{d.error ?? 'Loading…'}</Empty> : <section className="card stack">
        <p className="small">Choose the streams you would like for {x.forYear}, first choice first. Seats are allotted by merit (the board result, or this year’s result) and your choices; the school tells you the outcome.</p>
        {x.choice?.allotted && <div className="callout green small">Allotted: {x.streams[x.choice.allotted]}</div>}
        {Object.entries(x.streams).map(([k, l]) => { const i = pick.indexOf(k); return <button key={k} className={`btn ${i >= 0 ? '' : 'quiet'}`} onClick={() => setPick(i >= 0 ? pick.filter((p) => p !== k) : [...pick, k])}>{i >= 0 ? `${i + 1}. ` : ''}{String(l)}</button>; })}
        <button className="btn" disabled={busy || !pick.length} onClick={async () => { if (await run(() => api(`/students/${current!.id}/streams`, { body: { choices: pick } }), 'Saved')) d.reload(); }}>Save my choices</button>
      </section>}
    </Screen>
  );
}

/** Balvatika to Class V: the favourites and drawings on the child's Holistic Progress Card. */
export function ParentAboutMe() {
  const { current } = useChildren();
  return (
    <Screen title="All About Me">
      <section className="card stack">
        <p className="small">These go on your child’s Holistic Progress Card each term. Fill in the favourites with your child, and add a photo of their drawing of the family and of themselves.</p>
        {current ? <AboutMe studentId={current.id} /> : <Empty>Loading…</Empty>}
      </section>
    </Screen>
  );
}
