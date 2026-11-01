import { useEffect, useRef, useState } from 'react';
import { api, day, money, today, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, askText } from '../ui';
import { useSchool } from './Payroll';
import { FailedPage } from '../errors';

/**
 * School transport for the transport in-charge and the principal. Each child's stop is entered once
 * (here, or from the parent's request) and the fee, bus list, boarding register and parent app follow.
 * Routes run on stop times; the attendant's taps move the times; GPS is optional per route.
 */

export const TRACK: Record<string, [string, string]> = {
  TIMES: ['Stop times only', 'Parents see when the bus is due at their stop. Nothing is tracked and the attendant has nothing to tap. The office can still tell parents if a run is not running.'],
  TAPS: ['Stop times, with the attendant’s taps', 'The attendant taps “started”, “at this stop” or “running late”; parents further along get the revised time. No location is shared.'],
  PHONE: ['The attendant’s phone tracks the bus', 'While the run is on, the attendant’s phone shares its location. Arrival at each stop is noticed by itself and parents see how far the bus is. The phone must stay on the My bus run screen.'],
  DEVICE: ['A tracker fitted in the vehicle', 'A GPS tracker in the bus sends its position with a secret token (from Vehicles). Arrival at stops is noticed by itself.'],
};
const TRIP: Record<string, [string, string]> = { SCHEDULED: ['Not started', ''], RUNNING: ['On the way', 'blue'], DONE: ['Done', 'green'], CANCELLED: ['Not running', 'red'] };
const Trip = ({ s }: { s: string }) => { const [l, t] = TRIP[s] ?? [s, '']; return <span className={`pill ${t}`}>{l}</span>; };

export default function Transport({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const d = useLoad<any>(schoolId ? `/schools/${schoolId}/transport` : null, [schoolId]);
  const now = useLoad<any[]>(schoolId ? `/schools/${schoolId}/transport/today` : null, [schoolId]);
  const [tab, setTab] = useState('today');
  const [edit, setEdit] = useState<any>(null);
  const [stopsOf, setStopsOf] = useState<any>(null);
  const [roster, setRoster] = useState<any>(null);
  const [vehicle, setVehicle] = useState<any>(null);
  const [crew, setCrew] = useState<any>(null);
  const [fare, setFare] = useState(false);
  const [allot, setAllot] = useState(false);
  const { run, busy } = useAction();
  const [note, setNote] = useState<Record<string, string>>({});
  useEffect(() => { const t = setInterval(() => now.reload(), 60_000); return () => clearInterval(t); }, [schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const o = d.data, m = o?.canManage;
  const reload = () => { d.reload(); now.reload(); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Transport</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <div className="seg">{[['today', 'Today'], ['routes', 'Routes'], ['fleet', 'Vehicles and crew'], ['requests', `Requests${o?.requests.length ? ` (${o.requests.length})` : ''}`]].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {m && <button className="btn small" onClick={() => setAllot(true)}>Put a child on a bus</button>}</div></div>
      <main className="page">
        {(o?.alerts ?? []).length > 0 && <section className="stack">{o.alerts.map((a: any, i: number) => <div key={i} className={`callout ${a.level === 'ERROR' ? 'red' : 'orange'} small`}>{a.message}</div>)}</section>}
        {!o ? <Empty>{d.error ?? 'Loading…'}</Empty> : tab === 'today' ? <section className="tile">
          <h2>Today’s runs</h2>
          <p className="muted" style={{ marginTop: 6 }}>From the stop times, moved by the attendants’ taps (started, at a stop, running late). Parents waiting further along are told when a bus is late.</p>
          {!(now.data ?? []).length ? <Empty>No routes yet.</Empty> : <div className="scroll-x"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Route</th><th>Morning</th><th>Afternoon</th></tr></thead>
            <tbody>{(now.data ?? []).map((r) => <tr key={r.id}><td><b>{r.code}</b> {r.name}<span className="tiny muted" style={{ display: 'block' }}>{r.reg_no ?? 'No vehicle'} · {TRACK[r.tracking]?.[0] ?? r.tracking}</span></td>
              {(['MORNING', 'AFTERNOON'] as const).map((leg) => { const l = r.legs[leg]; return <td key={leg} className="small"><Trip s={l.status} />{l.delayMin > 0 && l.status !== 'CANCELLED' && <span className="pill orange" style={{ marginLeft: 4 }}>{l.delayMin} min late</span>}
                <span className="tiny muted" style={{ display: 'block' }}>{l.first ?? '—'} to {l.lastTime ?? '—'}{l.lastStop ? ` · last at ${l.lastStop}` : ''}{l.boarded ? ` · ${l.boarded} marked` : ''}</span>
                {m && l.status !== 'DONE' && l.status !== 'CANCELLED' && <span style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                  {r.tracking !== 'TIMES' && <button className="linkbtn tiny" onClick={async () => { const mins = await askText('Running late by how many minutes?'); if (mins && Number(mins) > 0 && await run(() => api(`/routes/${r.id}/events`, { body: { leg, kind: 'DELAY', minutes: Number(mins) } }), 'Parents told')) now.reload(); }}>Late…</button>}
                  <button className="linkbtn tiny" onClick={async () => { const why = await askText('Why is it not running? (sent to parents)'); if (why && await run(() => api(`/routes/${r.id}/events`, { body: { leg, kind: 'CANCELLED', note: why } }), 'Parents told')) now.reload(); }}>Not running…</button></span>}</td>; })}</tr>)}</tbody></table></div>}
        </section> : tab === 'routes' ? <>
          {m && <div style={{ display: 'flex', gap: 8 }}><button className="btn quiet small" onClick={() => setEdit({})}>New route</button><button className="btn quiet small" onClick={() => setFare(true)}>Fares</button></div>}
          <section className="tile"><h3>Fares</h3><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>{o.fares.map((f: any) => <span key={f.id} className="pill">Zone {f.zone} · {f.name} · <b>{money(f.monthly_paise)}</b> a month{f.from > today() ? ` from ${day(f.from)}` : ''}</span>)}</div>
            <p className="tiny muted" style={{ marginTop: 6 }}>The fee is billed with the instalments: each month the bus is used by the 15th, at the stop’s zone.</p></section>
          {o.routes.map((r: any) => <section key={r.id} className="tile">
            <div className="tile-head"><div><h3>{r.code} · {r.name}</h3><p className="small muted">{r.reg_no ?? 'No vehicle'} · {r.used}{r.seats ? `/${r.seats}` : ''} children · driver {r.driver ?? '—'} · attendant {r.attendant ?? '—'} · {TRACK[r.tracking]?.[0] ?? r.tracking}</p></div>
              <span style={{ display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => setRoster(r)}>Children</button>{m && <><button className="btn quiet small" onClick={() => setStopsOf(r)}>Stops and times</button><button className="btn quiet small" onClick={() => setEdit(r)}>Edit</button></>}</span></div>
            {!r.stops.length ? <Empty>No stops yet.</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>#</th><th>Stop</th><th>Morning</th><th>Afternoon</th><th>Zone</th><th className="num">Children</th></tr></thead>
              <tbody>{r.stops.map((s: any) => <tr key={s.id}><td>{s.seq}</td><td><b>{s.name}</b>{s.landmark && <span className="tiny muted" style={{ display: 'block' }}>{s.landmark}</span>}</td><td>{s.morning ?? '—'}</td><td>{s.afternoon ?? '—'}</td><td>{s.fareZone}</td><td className="num">{s.children}</td></tr>)}</tbody></table></div>}
          </section>)}
        </> : tab === 'fleet' ? <>
          <section className="tile"><div className="tile-head"><h3>Vehicles</h3>{m && <button className="btn quiet small" onClick={() => setVehicle({})}>Add a vehicle</button>}</div>
            <div className="scroll-x"><table className="table"><thead><tr><th>Vehicle</th><th>Seats</th><th>Owner</th><th>Fitness</th><th>Insurance</th><th>Permit</th><th>Pollution</th><th /></tr></thead>
              <tbody>{o.vehicles.map((v: any) => <tr key={v.id}><td><b>{v.reg_no}</b> <span className="tiny muted">{v.kind.toLowerCase()}</span></td><td>{v.seats}</td><td className="small">{v.owner === 'CONTRACTOR' ? v.contractor : v.owner.toLowerCase()}</td>
                {['fitness_until', 'insurance_until', 'permit_until', 'puc_until'].map((k) => <td key={k} className="small" style={{ color: v[k] && v[k] < today() ? 'var(--red)' : undefined }}>{v[k] ? day(v[k]) : '—'}</td>)}
                <td>{m && <button className="linkbtn small" onClick={() => setVehicle(v)}>Edit</button>}</td></tr>)}</tbody></table></div></section>
          <section className="tile"><div className="tile-head"><h3>Drivers and attendants</h3>{m && <button className="btn quiet small" onClick={() => setCrew({})}>Add</button>}</div>
            {o.crew.map((c: any) => <div key={c.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{c.name}</b> <span className="small muted">{c.role === 'DRIVER' ? 'Driver' : 'Attendant'}{c.school_staff ? ' · school staff' : ' · contractor'} · {c.phone?.replace('+91', '') ?? '—'}</span>
              <span className="tiny muted" style={{ display: 'block' }}>{c.licence_no ? `Licence ${c.licence_no}, valid to ${day(c.licence_until)} · ` : ''}{c.police_verified_on ? `police verified ${day(c.police_verified_on)}` : 'police verification not recorded'}</span></span>
              {m && <button className="linkbtn small" onClick={() => setCrew(c)}>Edit</button>}</div>)}</section>
        </> : <section className="tile"><h3>Requests from parents and the office</h3>
          {!o.requests.length ? <Empty>Nothing waiting.</Empty> : o.requests.map((q: any) => <div key={q.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{q.student}</b> <span className="small muted">{q.class}</span><span className="small" style={{ display: 'block' }}>{q.kind === 'STOP' ? 'Stop the bus' : `${q.kind === 'START' ? 'Start' : 'Change'}: ${q.pickup ?? q.drop} (route ${q.pickup_route ?? q.drop_route})`} from {day(q.from_date)}{q.now_on ? ` · now at ${q.now_on}` : ''}</span>
              <span className="tiny muted">{q.note} · asked by {q.requested_by}</span></span>
            {m && <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><input className="input" style={{ height: 34, width: 150 }} placeholder="Reason, if refusing" value={note[q.id] ?? ''} onChange={(e) => setNote({ ...note, [q.id]: e.target.value })} />
              <button className="btn small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/transport/requests/${q.id}/decide`, { body: { approve: true } }), 'Done; the parent and the fees are updated'); if (r) reload(); }}>Accept</button>
              <button className="btn quiet small" disabled={busy || (note[q.id] ?? '').trim().length < 3} onClick={async () => { if (await run(() => api(`/transport/requests/${q.id}/decide`, { body: { approve: false, note: note[q.id] } }), 'Parent told')) reload(); }}>Refuse</button></span>}</div>)}</section>}
      </main>
      {edit && <RouteDrawer schoolId={schoolId} r={edit} o={o} onClose={() => { setEdit(null); reload(); }} />}
      {stopsOf && <StopsDrawer r={stopsOf} zones={[...new Set(o.fares.map((f: any) => f.zone))] as string[]} onClose={() => { setStopsOf(null); reload(); }} />}
      {roster && <RosterDrawer r={roster} canManage={m} onClose={() => { setRoster(null); reload(); }} />}
      {vehicle && <VehicleDrawer schoolId={schoolId} v={vehicle} onClose={() => { setVehicle(null); reload(); }} />}
      {crew && <CrewDrawer schoolId={schoolId} c={crew} onClose={() => { setCrew(null); reload(); }} />}
      {fare && <FareDrawer schoolId={schoolId} onClose={() => { setFare(false); reload(); }} />}
      {allot && <AllotDrawer schoolId={schoolId} routes={o.routes} onClose={() => { setAllot(false); reload(); }} />}
    </>
  );
}

function RouteDrawer({ schoolId, r, o, onClose }: { schoolId: string; r: any; o: any; onClose: () => void }) {
  const [f, setF] = useState({ code: r.code ?? '', name: r.name ?? '', vehicleId: r.vehicle_id ?? '', driverId: r.driver_id ?? '', attendantId: r.attendant_id ?? '', tracking: r.tracking ?? 'TAPS' });
  const { run, busy } = useAction();
  return (
    <Drawer title={r.id ? `Route ${r.code}` : 'New route'} onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Code</span><input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="R1" /></label>
          <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Colaba – Cuffe Parade" /></label>
          <label className="field"><span>Vehicle</span><select className="input" value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}><option value="">None yet</option>{o.vehicles.filter((v: any) => v.active).map((v: any) => <option key={v.id} value={v.id}>{v.reg_no} · {v.seats} seats</option>)}</select></label>
          <label className="field"><span>Driver</span><select className="input" value={f.driverId} onChange={(e) => setF({ ...f, driverId: e.target.value })}><option value="">—</option>{o.crew.filter((c: any) => c.role === 'DRIVER' && c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field"><span>Attendant</span><select className="input" value={f.attendantId} onChange={(e) => setF({ ...f, attendantId: e.target.value })}><option value="">—</option>{o.crew.filter((c: any) => c.role === 'ATTENDANT' && c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="field"><span>How parents follow this bus</span>
          <div className="stack" style={{ gap: 6, marginTop: 6 }}>{(Object.entries(TRACK) as [string, [string, string]][]).map(([k, [l, help]]) => <label key={k} className="check small" style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="tracking" checked={f.tracking === k} onChange={() => setF({ ...f, tracking: k })} /><span><b>{l}</b><span className="tiny muted" style={{ display: 'block' }}>{help}</span></span></label>)}</div></div>
        <button className="btn big" disabled={busy || !f.code || f.name.trim().length < 2} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/routes`, { body: { ...(r.id ? { id: r.id } : {}), ...f, vehicleId: f.vehicleId || null, driverId: f.driverId || null, attendantId: f.attendantId || null } }), 'Saved')) onClose();
        }}>Save route</button>
      </section>
    </Drawer>
  );
}

function StopsDrawer({ r, zones, onClose }: { r: any; zones: string[]; onClose: () => void }) {
  const [rows, setRows] = useState<any[]>(r.stops.length ? r.stops.map((s: any) => ({ ...s })) : [{ name: '', morning: '', afternoon: '', fareZone: zones[0] ?? '' }]);
  const { run, busy } = useAction();
  const set = (i: number, k: string, v: string) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Drawer title={`Stops · ${r.code}`} onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">In order from the first pick-up to the last before school. Afternoon times run the other way (the nearest stop is dropped first).</p>
        {rows.map((s, i) => <div key={i} className="stack" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
          <div className="form-grid">
            <label className="field"><span>{i + 1}. Stop</span><input className="input" value={s.name} onChange={(e) => set(i, 'name', e.target.value)} /></label>
            <label className="field"><span>Landmark</span><input className="input" value={s.landmark ?? ''} onChange={(e) => set(i, 'landmark', e.target.value)} /></label>
            <label className="field"><span>Morning</span><input className="input" type="time" value={s.morning ?? ''} onChange={(e) => set(i, 'morning', e.target.value)} /></label>
            <label className="field"><span>Afternoon</span><input className="input" type="time" value={s.afternoon ?? ''} onChange={(e) => set(i, 'afternoon', e.target.value)} /></label>
            <label className="field"><span>Fare zone</span><select className="input" value={s.fareZone} onChange={(e) => set(i, 'fareZone', e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</select></label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="linkbtn small" disabled={i === 0} onClick={() => { const x = [...rows]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; setRows(x); }}>Move up</button>
            <button className="linkbtn small" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></div>
        </div>)}
        <button className="btn quiet small" onClick={() => setRows([...rows, { name: '', morning: '', afternoon: '', fareZone: zones[0] ?? '' }])}>Add a stop</button>
        <button className="btn big" disabled={busy || rows.some((s) => s.name.trim().length < 2)} onClick={async () => {
          if (await run(() => api(`/routes/${r.id}/stops`, { method: 'PUT', body: { stops: rows.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, landmark: s.landmark || null, morning: s.morning || null, afternoon: s.afternoon || null, fareZone: s.fareZone })) } }), 'Stops saved')) onClose();
        }}>Save stops</button>
      </section>
    </Drawer>
  );
}

function RosterDrawer({ r, canManage, onClose }: { r: any; canManage: boolean; onClose: () => void }) {
  const d = useLoad<any[]>(`/routes/${r.id}/roster`, [r.id]);
  const { run } = useAction();
  return (
    <Drawer title={`Children on ${r.code}`} onClose={onClose}>
      {!d.data ? <Empty>Loading…</Empty> : d.data.map((s) => <section key={s.stop_id} className="tile tight">
        <b>{s.seq}. {s.stop}</b> <span className="small muted">{s.morning ?? '—'} / {s.afternoon ?? '—'}</span>
        {!s.children.length ? <p className="small muted">Nobody.</p> : s.children.map((c: any) => <div key={c.studentId} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <span className="small"><b>{c.name}</b> · {c.class}{!c.pickup ? ' · drop only' : !c.drop ? ' · pick-up only' : ''}</span>
          {canManage && <button className="linkbtn small" onClick={async () => { const from = await askText('Off the bus from which date? (YYYY-MM-DD)', { initial: today() }); if (from && await run(() => api('/transport/stop', { body: { studentId: c.studentId, from } }), 'Done; the fee is put right')) d.reload(); }}>Take off</button>}</div>)}
      </section>)}
    </Drawer>
  );
}

function VehicleDrawer({ schoolId, v, onClose }: { schoolId: string; v: any; onClose: () => void }) {
  const [f, setF] = useState({ regNo: v.reg_no ?? '', kind: v.kind ?? 'BUS', seats: String(v.seats ?? 40), owner: v.owner ?? 'SCHOOL', contractor: v.contractor ?? '', fitnessUntil: v.fitness_until ?? '', insuranceUntil: v.insurance_until ?? '', permitUntil: v.permit_until ?? '', pucUntil: v.puc_until ?? '', gpsDevice: v.gps_device ?? '' });
  const { run, busy } = useAction();
  const set = (k: string, x: string) => setF({ ...f, [k]: x });
  return (
    <Drawer title={v.id ? v.reg_no : 'Add a vehicle'} onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Registration no.</span><input className="input mono" value={f.regNo} onChange={(e) => set('regNo', e.target.value.toUpperCase())} placeholder="MH 01 AB 1234" /></label>
          <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={(e) => set('kind', e.target.value)}><option value="BUS">Bus</option><option value="MINIBUS">Minibus</option><option value="VAN">Van</option></select></label>
          <label className="field"><span>Seats for children</span><input className="input" inputMode="numeric" value={f.seats} onChange={(e) => set('seats', e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Owned by</span><select className="input" value={f.owner} onChange={(e) => set('owner', e.target.value)}><option value="SCHOOL">The school</option><option value="NAVY">The Navy</option><option value="CONTRACTOR">A contractor</option></select></label>
          {f.owner === 'CONTRACTOR' && <label className="field"><span>Contractor</span><input className="input" value={f.contractor} onChange={(e) => set('contractor', e.target.value)} /></label>}
          {[['fitnessUntil', 'Fitness valid to'], ['insuranceUntil', 'Insurance valid to'], ['permitUntil', 'Permit valid to'], ['pucUntil', 'Pollution certificate to']].map(([k, l]) => <label key={k} className="field"><span>{l}</span><input className="input" type="date" value={(f as any)[k]} onChange={(e) => set(k, e.target.value)} /></label>)}
          <label className="field"><span>GPS tracker (optional)</span><input className="input" value={f.gpsDevice} onChange={(e) => set('gpsDevice', e.target.value)} placeholder="Device number" /></label>
        </div>
        {v.id && <TrackerToken vehicleId={v.id} />}
        <button className="btn big" disabled={busy || f.regNo.length < 6} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/vehicles`, { body: { ...(v.id ? { id: v.id } : {}), ...f, seats: Number(f.seats), contractor: f.contractor || null, fitnessUntil: f.fitnessUntil || null, insuranceUntil: f.insuranceUntil || null, permitUntil: f.permitUntil || null, pucUntil: f.pucUntil || null, gpsDevice: f.gpsDevice || null } }), 'Saved')) onClose();
        }}>Save</button>
      </section>
    </Drawer>
  );
}

/** A secret for a fitted tracker: it sends positions to NavShiksha with it. Shown once; a new one stops the old. */
function TrackerToken({ vehicleId }: { vehicleId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const { run, busy } = useAction();
  return (
    <div className="callout small stack">
      <span>Fitted tracker: give the tracker company this address and secret. Positions go to routes of this vehicle set to “A tracker fitted in the vehicle”.</span>
      <code className="tiny">POST {location.origin}/api/v1/public/tracker/position · header x-tracker-token · body {'{ "lat": …, "lng": … }'}</code>
      {token ? <code className="mono small" style={{ wordBreak: 'break-all' }}>{token}</code> : <div><button className="btn quiet small" disabled={busy} onClick={async () => { const r = await run(() => api<{ token: string }>(`/vehicles/${vehicleId}/tracker-token`, { body: {} })); if (r) setToken(r.token); }}>Make a new secret</button></div>}
      {token && <span className="tiny muted">Copy it now; it is not shown again. Any earlier secret no longer works.</span>}
    </div>
  );
}

function CrewDrawer({ schoolId, c, onClose }: { schoolId: string; c: any; onClose: () => void }) {
  const staff = useLoad<any[]>(`/schools/${schoolId}/staff-records`, [schoolId]);
  const [f, setF] = useState({ userId: c.user_id ?? '', name: c.school_staff ? '' : c.name ?? '', phone: c.school_staff ? '' : c.phone?.replace('+91', '') ?? '', role: c.role ?? 'ATTENDANT', licenceNo: c.licence_no ?? '', licenceUntil: c.licence_until ?? '', policeVerifiedOn: c.police_verified_on ?? '' });
  const { run, busy } = useAction();
  const set = (k: string, x: string) => setF({ ...f, [k]: x });
  return (
    <Drawer title={c.id ? c.name : 'Add a driver or attendant'} onClose={onClose}>
      <section className="tile tight stack">
        <div className="seg">{[['ATTENDANT', 'Attendant'], ['DRIVER', 'Driver']].map(([k, l]) => <button key={k} className={f.role === k ? 'on' : ''} onClick={() => set('role', k)}>{l}</button>)}</div>
        <label className="field"><span>On the school’s staff?</span><select className="input" value={f.userId} onChange={(e) => set('userId', e.target.value)}>
          <option value="">No, the contractor’s person</option>{(staff.data ?? []).filter((x) => x.on_record && !x.separated_on).map((x) => <option key={x.user_id} value={x.user_id}>{x.name} · {x.designation ?? ''}</option>)}</select></label>
        {f.userId ? <p className="tiny muted">Name, mobile and photo come from their staff record. They see this bus in their app and tap the run from there.</p> : <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label></div>}
        <div className="form-grid">
          {f.role === 'DRIVER' && <><label className="field"><span>Licence no.</span><input className="input mono" value={f.licenceNo} onChange={(e) => set('licenceNo', e.target.value.toUpperCase())} /></label>
            <label className="field"><span>Licence valid to</span><input className="input" type="date" value={f.licenceUntil} onChange={(e) => set('licenceUntil', e.target.value)} /></label></>}
          <label className="field"><span>Police verification on</span><input className="input" type="date" value={f.policeVerifiedOn} onChange={(e) => set('policeVerifiedOn', e.target.value)} /></label>
        </div>
        <button className="btn big" disabled={busy} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/transport-crew`, { body: { ...(c.id ? { id: c.id } : {}), role: f.role, userId: f.userId || null, name: f.userId ? null : f.name, phone: f.userId ? null : f.phone || null,
            licenceNo: f.licenceNo || null, licenceUntil: f.licenceUntil || null, policeVerifiedOn: f.policeVerifiedOn || null } }), 'Saved')) onClose();
        }}>Save</button>
      </section>
    </Drawer>
  );
}

function FareDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ zone: 'A', name: '', amount: '', from: today() });
  const { run, busy } = useAction();
  return (
    <Drawer title="Fare for a zone" onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Zone</span><input className="input mono" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value.toUpperCase().slice(0, 6) })} /></label>
          <label className="field"><span>Description</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Up to 5 km" /></label>
          <label className="field"><span>Fare a month (₹)</span><input className="input" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label></div>
        <p className="tiny muted">A new fare for a zone applies from the date; months already billed stay as they were.</p>
        <button className="btn big" disabled={busy || !f.zone || !f.amount || f.name.trim().length < 2} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/transport-fares`, { body: { zone: f.zone, name: f.name, monthlyPaise: Number(f.amount) * 100, from: f.from } }), 'Fare saved')) onClose(); }}>Save fare</button>
      </section>
    </Drawer>
  );
}

function AllotDrawer({ schoolId, routes, onClose }: { schoolId: string; routes: any[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const found = useLoad<any[]>(q.trim().length >= 2 ? `/students?q=${encodeURIComponent(q.trim())}&schoolId=${schoolId}` : null, [q]);
  const [who, setWho] = useState<any>(null);
  const [pickup, setPickup] = useState(''), [drop, setDrop] = useState(''), [same, setSame] = useState(true), [from, setFrom] = useState(today());
  const { run, busy } = useAction();
  const options = routes.flatMap((r) => r.stops.map((s: any) => ({ id: s.id, label: `${r.code} · ${s.name} (${s.morning ?? '—'} / ${s.afternoon ?? '—'})`, full: r.seats && r.used >= r.seats })));
  return (
    <Drawer title="Put a child on a bus" onClose={onClose}>
      <section className="tile tight stack">
        {who ? <div className="callout small"><b>{who.name}</b> · {who.class_code}{who.section ? `-${who.section}` : ''} <button className="linkbtn small" onClick={() => setWho(null)}>Change</button></div> : <>
          <label className="field"><span>Child</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or admission number" /></label>
          {(found.data ?? []).map((x) => <button key={x.id} className="list-row" style={{ gridTemplateColumns: '1fr', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setWho(x)}><span><b>{x.name}</b> <span className="small muted">{x.class_code}{x.section ? `-${x.section}` : ''} · {x.admission_no}</span></span></button>)}</>}
        <label className="field"><span>Pick-up stop</span><select className="input" value={pickup} onChange={(e) => setPickup(e.target.value)}><option value="">None (drop only)</option>{options.map((o) => <option key={o.id} value={o.id} disabled={o.full}>{o.label}{o.full ? ' · full' : ''}</option>)}</select></label>
        <label className="check small"><input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />Dropped at the same stop</label>
        {!same && <label className="field"><span>Drop stop</span><select className="input" value={drop} onChange={(e) => setDrop(e.target.value)}><option value="">None (pick-up only)</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
        <label className="field"><span>From</span><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <p className="tiny muted">The parent is told, the transport fee is put on the instalments by itself, and the child appears on the attendant’s list.</p>
        <button className="btn big" disabled={busy || !who || (!pickup && !(same ? '' : drop))} onClick={async () => {
          if (await run(() => api('/transport/allocate', { body: { studentId: who.id, pickupStopId: pickup || null, dropStopId: same ? pickup || null : drop || null, from } }), 'On the bus; the parent and the fees are updated')) onClose();
        }}>Put on the bus</button>
      </section>
    </Drawer>
  );
}

// ── The attendant's (or driver's) run, in the staff app ────────────────────────────────────

/**
 * The attendant's phone during a run. What it shows depends on how the route is followed:
 * stop times only (the list and the children, nothing to tap), taps, the phone's own location
 * (started once; it shares the location and notices each stop by itself while this screen is
 * open), or a fitted tracker.
 */
export function BusRun() {
  const d = useLoad<any[]>('/my/bus');
  const { run, busy } = useAction();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
  const [leg, setLeg] = useState<'MORNING' | 'AFTERNOON'>(hour < 12 ? 'MORNING' : 'AFTERNOON');
  const [sharing, setSharing] = useState<string | null>(null);           // the route whose location is being shared
  const [where, setWhere] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const watch = useRef<number | null>(null);
  const lock = useRef<any>(null);
  const last = useRef(0);
  const stopSharing = () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); watch.current = null; lock.current?.release?.().catch(() => null); lock.current = null; setSharing(null); };
  useEffect(() => stopSharing, []);
  useEffect(() => { if (!sharing) return; const t = setInterval(() => d.reload(), 30_000); return () => clearInterval(t); }, [sharing]); // eslint-disable-line react-hooks/exhaustive-deps
  const share = async (routeId: string) => {
    if (!('geolocation' in navigator)) { setGpsError('This phone cannot share its location.'); return; }
    setGpsError(null);
    // Keep the screen on, so the phone keeps sending while the run is on.
    try { lock.current = await (navigator as any).wakeLock?.request('screen'); } catch { /* not supported */ }
    watch.current = navigator.geolocation.watchPosition((p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      setWhere(pos);
      if (Date.now() - last.current < 30_000) return;
      last.current = Date.now();
      api<{ at: string | null }>(`/routes/${routeId}/position`, { body: { leg, ...pos } }).then((r) => { if (r.at) d.reload(); }).catch(() => null);
    }, (e) => { setGpsError(e.code === 1 ? 'Location is not allowed. Allow location for this site in the phone’s settings.' : 'The phone cannot find its location just now.'); }, { enableHighAccuracy: true, maximumAge: 10_000 });
    setSharing(routeId);
  };
  if (!d.data) return d.error ? <FailedPage error={d.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  if (!d.data.length) return <main className="page"><Empty>You are not the driver or attendant of any bus.</Empty></main>;
  const ev = async (routeId: string, body: any, msg: string) => {
    const withPlace = where && sharing === routeId ? { ...body, lat: where.lat, lng: where.lng } : body;
    if (await run(() => api(`/routes/${routeId}/events`, { body: withPlace }), msg)) { d.reload(); if (['REACHED', 'CANCELLED'].includes(body.kind) && sharing === routeId) stopSharing(); }
  };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">My bus run</span><span className="spacer" style={{ flex: 1 }} />
        <div className="seg">{[['MORNING', 'Morning'], ['AFTERNOON', 'Afternoon']].map(([k, l]) => <button key={k} className={leg === k ? 'on' : ''} onClick={() => setLeg(k as typeof leg)}>{l}</button>)}</div></div></div>
      <main className="page">
        {d.data.map((r) => { const l = r.legs[leg]; const marks = new Map(l.marks.map((x: any) => [x.student_id, x.status])); const over = ['DONE', 'CANCELLED'].includes(l.status);
          const mode = r.tracking as 'TIMES' | 'TAPS' | 'PHONE' | 'DEVICE'; const taps = mode !== 'TIMES'; return (
          <section key={r.id} className="tile stack">
            <div className="tile-head"><div><h2>{r.code} · {r.name}</h2><p className="small muted">{r.reg_no ?? ''} · <Trip s={l.status} />{taps && l.delayMin > 0 && ` · ${l.delayMin} min late`} · {TRACK[mode][0]}</p></div></div>
            {mode === 'TIMES' && <div className="callout small">This bus shows parents the stop times only. Nothing to tap: just mark the children as they get on and off.</div>}
            {mode === 'DEVICE' && <div className="callout small">The tracker in the bus sends its position and notices each stop. You can still tap if something happens.</div>}
            {mode === 'PHONE' && !over && (sharing === r.id
              ? <div className="callout green small">Sharing this phone’s location{where ? ` (${where.lat.toFixed(4)}, ${where.lng.toFixed(4)})` : ''}. Keep this screen open; stops are marked by themselves. <button className="linkbtn small" onClick={stopSharing}>Stop sharing</button></div>
              : <div className="callout blue small">This phone tracks the bus. Press <b>Start the run</b> when you leave; allow location when the phone asks.</div>)}
            {gpsError && <div className="callout red small">{gpsError}</div>}
            {taps && !over && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(l.status === 'SCHEDULED' || (mode === 'PHONE' && sharing !== r.id)) && <button className="btn big" disabled={busy} onClick={async () => {
                if (mode === 'PHONE') await share(r.id);
                if (l.status === 'SCHEDULED') await ev(r.id, { leg, kind: 'STARTED' }, mode === 'PHONE' ? 'Started; sharing location' : 'Started');
              }}>{mode === 'PHONE' ? (l.status === 'SCHEDULED' ? 'Start the run' : 'Share location again') : 'Started'}</button>}
              {[10, 20, 30].map((m) => <button key={m} className="btn quiet" disabled={busy} onClick={() => ev(r.id, { leg, kind: 'DELAY', minutes: m }, `Parents told: about ${m} minutes late`)}>Late {m} min</button>)}
              <button className="btn quiet" disabled={busy} onClick={() => ev(r.id, { leg, kind: 'REACHED' }, leg === 'MORNING' ? 'Reached school' : 'Run finished')}>{leg === 'MORNING' ? 'Reached school' : 'All dropped'}</button>
              <button className="btn quiet danger" disabled={busy} onClick={async () => { const why = await askText('What happened? (sent to parents)'); if (why) ev(r.id, { leg, kind: 'BREAKDOWN', note: why }, 'School and parents told'); }}>Breakdown</button>
            </div>}
            {l.stops.map((s: any) => { const kids = (r.roster.find((x: any) => x.stop_id === s.id)?.children ?? []).filter((c: any) => leg === 'MORNING' ? c.pickup : c.drop); return (
              <div key={s.id} className="list-row" style={{ gridTemplateColumns: '1fr', opacity: s.passed ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <span><b>{s.name}</b> <span className="small muted">due {s.time ?? '—'}{taps && s.eta && s.eta !== s.time ? ` · now ${s.eta}` : ''}{s.passed ? ' · passed' : ''}</span></span>
                  {taps && !over && !s.passed && <button className="btn small" disabled={busy} onClick={() => ev(r.id, { leg, kind: 'AT_STOP', stopId: s.id }, `At ${s.name}`)}>At this stop</button>}</div>
                {kids.map((c: any) => <div key={c.studentId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', paddingLeft: 12 }}>
                  <span className="small">{c.name} · {c.class}{c.parentPhone ? <> · <a href={`tel:${c.parentPhone}`}>call parent</a></> : ''}</span>
                  <div className="seg">{(leg === 'MORNING' ? [['BOARDED', 'Got on'], ['NOT_BOARDED', 'Not today']] : [['DROPPED', 'Got off'], ['HANDED_TO_PARENT', 'Handed over']]).map(([k, lb]) =>
                    <button key={k} style={{ padding: '0 9px', whiteSpace: 'nowrap', fontSize: '0.8rem' }} className={marks.get(c.studentId) === k ? 'on' : ''} disabled={busy} onClick={async () => { if (await run(() => api(`/routes/${r.id}/boarding`, { body: { leg, entries: [{ studentId: c.studentId, status: k }] } }))) d.reload(); }}>{lb}</button>)}</div></div>)}
              </div>); })}
          </section>); })}
      </main>
    </>
  );
}
