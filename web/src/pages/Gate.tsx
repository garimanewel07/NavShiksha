import { useEffect, useRef, useState } from 'react';
import { api, apiFile, day, hasDuty, readBase64, time, today, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad } from '../ui';
import { useSchool } from './Payroll';

/**
 * The gate, for the guard (a phone is enough): who is inside, expected visitors let in by their
 * code, walk-ins with a photo and a badge, signing out; and today's gate passes, checked by
 * scanning the pickup card or typing the pass number. Any member of staff can expect a visitor.
 */

const openFile = async (path: string) => { const { blob } = await apiFile(path); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };

/** An image the API serves to signed-in users only (an <img> cannot send the sign-in token). */
export function AuthImg({ path, style }: { path: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let u = ''; apiFile(path).then(({ blob }) => { u = URL.createObjectURL(blob); setUrl(u); }).catch(() => setUrl(null)); return () => { if (u) URL.revokeObjectURL(u); }; }, [path]);
  return url ? <img src={url} alt="" style={style} /> : null;
}

/** A text box that also scans QR codes with the camera where the browser can (BarcodeDetector). */
function ScanInput({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; placeholder: string }) {
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const can = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        const det = new (window as any).BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        while (!stop) {
          const codes = await det.detect(video.current).catch(() => []);
          if (codes[0]?.rawValue) { onChange(codes[0].rawValue); onSubmit(codes[0].rawValue); setScanning(false); break; }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch { setScanning(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="stack" style={{ gap: 6 }}>
    <div style={{ display: 'flex', gap: 6 }}><input className="input" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); }} placeholder={placeholder} />
      {can && <button className="btn quiet small" onClick={() => setScanning(!scanning)}>{scanning ? 'Stop' : 'Scan'}</button>}
      <button className="btn small" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>Check</button></div>
    {scanning && <video ref={video} style={{ width: '100%', maxWidth: 360, borderRadius: 12 }} muted playsInline />}
  </div>;
}

export function Gate({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const guard = user.role === 'SCHOOL_ADMIN' || hasDuty(user, 'GATE_SECURITY');
  const reg = useLoad<any[]>(schoolId ? `/schools/${schoolId}/gate` : null, [schoolId]);
  const passes = useLoad<any[]>(schoolId && guard ? `/schools/${schoolId}/gate-passes` : null, [schoolId]);
  const [tab, setTab] = useState(guard ? 'visitors' : 'mine');
  const [code, setCode] = useState('');
  const [scan, setScan] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [walk, setWalk] = useState(false);
  const [expect, setExpect] = useState(false);
  const { run, busy } = useAction();
  useEffect(() => { if (!guard) return; const t = setInterval(() => { reg.reload(); passes.reload(); }, 30_000); return () => clearInterval(t); }, [schoolId, guard]); // eslint-disable-line react-hooks/exhaustive-deps
  const inside = (reg.data ?? []).filter((v) => v.status === 'IN'), expected = (reg.data ?? []).filter((v) => v.status === 'EXPECTED'), done = (reg.data ?? []).filter((v) => !['IN', 'EXPECTED'].includes(v.status));
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Gate</span><span className="spacer" style={{ flex: 1 }} />{picker}
        {guard && <div className="seg">{[['visitors', `Visitors${inside.length ? ` (${inside.length} in)` : ''}`], ['passes', `Gate passes${passes.data?.filter((p) => p.status === 'APPROVED').length ? ` (${passes.data.filter((p) => p.status === 'APPROVED').length})` : ''}`]].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}
        <button className="btn quiet small" onClick={() => setExpect(true)}>Expect a visitor</button>{guard && <button className="btn small" onClick={() => setWalk(true)}>Walk-in visitor</button>}</div></div>
      <main className="page">
        {guard && tab === 'visitors' && <>
          <section className="tile"><h3>Expected visitor</h3><p className="tiny muted">The visitor shows the six-digit code they were sent by SMS.</p>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, maxWidth: 420 }}><input className="input mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Code" />
              <button className="btn small" disabled={busy || code.length !== 6} onClick={async () => { const r: any = await run(() => api(`/schools/${schoolId}/visitors/code`, { body: { code } }), 'Signed in; the host is told'); if (r) { setCode(''); reg.reload(); openFile(`/visitors/${r.id}/badge`); } }}>Let in and print badge</button></div></section>
          <section className="tile"><h3>Inside now</h3>
            {!inside.length ? <Empty>Nobody.</Empty> : inside.map((v) => <div key={v.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span><b>{v.name}</b> <span className="small muted">{v.organisation ? `${v.organisation} · ` : ''}{v.purpose}{v.host ? ` · to meet ${v.host}` : ''}</span><span className="tiny muted" style={{ display: 'block' }}>{v.number} · in at {time(v.in_at)}{v.vehicle_no ? ` · vehicle ${v.vehicle_no}` : ''}</span></span>
              <span style={{ display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => run(() => openFile(`/visitors/${v.id}/badge`))}>Badge</button>
                <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/visitors/${v.id}/out`, { body: {} }), 'Signed out')) reg.reload(); }}>Sign out</button></span></div>)}</section>
          <section className="tile"><h3>Expected today</h3>{!expected.length ? <Empty>Nobody expected.</Empty> : expected.map((v) => <div key={v.id} className="list-row small" style={{ gridTemplateColumns: '1fr' }}><span><b>{v.name}</b> · {v.purpose} · to meet {v.host}</span></div>)}</section>
          {done.length > 0 && <section className="tile"><h3>Left today</h3>{done.map((v) => <div key={v.id} className="list-row small" style={{ gridTemplateColumns: '1fr' }}><span>{v.name} · {v.purpose} · {time(v.in_at)} to {time(v.out_at)} {v.status !== 'OUT' ? `(${words(v.status)})` : ''}</span></div>)}</section>}
        </>}
        {guard && tab === 'passes' && <>
          <section className="tile"><h3>Someone has come to collect a child</h3><p className="tiny muted">Scan their pickup card, or type the gate pass number. Only a pass the class teacher approved for today shows.</p>
            <div style={{ marginTop: 8, maxWidth: 520 }}><ScanInput value={scan} onChange={setScan} placeholder="Pickup card or GP-0000001" onSubmit={async (v) => { setFound(null); const r: any = await run(() => api(`/schools/${schoolId}/gate-passes/verify?code=${encodeURIComponent(v)}`)); if (r) setFound(r); }} /></div>
            {found && found.map((g) => <div key={g.id} className="callout" style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {g.pickup_id && <AuthImg path={`/pickups/${g.pickup_id}/photo`} style={{ width: 90, height: 110, objectFit: 'cover', borderRadius: 8 }} />}
              <div style={{ flex: 1 }}><b>{g.student}</b> ({g.class})<div className="small">To be collected by <b>{g.pickup ?? 'the parent who asked'}</b>{g.relation ? ` (${g.relation})` : ''} at {g.leave_at.slice(0, 5)}</div><div className="tiny muted">{g.number}</div></div>
              {g.status === 'APPROVED' ? <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/gate-passes/${g.id}/left`, { body: {} }), 'Let go; the parent is told')) { setFound(null); setScan(''); passes.reload(); } }}>Matches the photo: let the child go</button>
                : <span className="pill green">Left</span>}</div>)}</section>
          <section className="tile"><h3>Today’s gate passes</h3>
            {!(passes.data ?? []).length ? <Empty>None today.</Empty> : passes.data!.map((g) => <div key={g.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span><b>{g.student}</b> <span className="small muted">{g.class} · at {g.leave_at.slice(0, 5)} · {g.reason}</span><span className="tiny muted" style={{ display: 'block' }}>{g.number} · collected by {g.pickup ? `${g.pickup} (${g.relation})` : g.parent}</span></span>
              <span className={`pill ${g.status === 'LEFT' ? 'green' : 'blue'}`}>{g.status === 'LEFT' ? `Left ${time(g.left_at)}` : 'Approved'}</span></div>)}</section>
        </>}
        {!guard && <section className="tile"><h3>Your visitors today</h3>
          {!(reg.data ?? []).length ? <Empty>No visitors for you today. “Expect a visitor” sends them a code to show at the gate.</Empty> : reg.data!.map((v) => <div key={v.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{v.name}</b> <span className="small muted">{v.purpose} · {v.expected_on ? day(v.expected_on) : ''}</span></span><span className={`pill ${v.status === 'IN' ? 'green' : ''}`}>{v.status === 'IN' ? `At school since ${time(v.in_at)}` : words(v.status)}</span></div>)}</section>}
      </main>
      {walk && <WalkInDrawer schoolId={schoolId} onClose={(id) => { setWalk(false); reg.reload(); if (id) openFile(`/visitors/${id}/badge`); }} />}
      {expect && <ExpectDrawer schoolId={schoolId} onClose={() => { setExpect(false); reg.reload(); }} />}
    </>
  );
}

function WalkInDrawer({ schoolId, onClose }: { schoolId: string; onClose: (id?: string) => void }) {
  const staff = useLoad<any[]>(`/schools/${schoolId}/staff`, [schoolId]);
  const [f, setF] = useState({ name: '', phone: '', purpose: '', organisation: '', hostUserId: '', idKind: '', idLast4: '', vehicleNo: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const { run, busy } = useAction();
  return <Drawer title="Walk-in visitor" onClose={() => onClose()}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label className="field"><span>Purpose</span><input className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} placeholder="Meeting, delivery, repair" /></label>
      <label className="field"><span>From (organisation)</span><input className="input" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></label>
      <label className="field"><span>To meet</span><select className="input" value={f.hostUserId} onChange={(e) => setF({ ...f, hostUserId: e.target.value })}><option value="">The office</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field"><span>Photo ID seen</span><input className="input" value={f.idKind} onChange={(e) => setF({ ...f, idKind: e.target.value })} placeholder="Aadhaar, driving licence" /></label>
      <label className="field"><span>Last 4 digits of the ID</span><input className="input" maxLength={4} value={f.idLast4} onChange={(e) => setF({ ...f, idLast4: e.target.value })} /></label>
      <label className="field"><span>Vehicle number</span><input className="input" value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} /></label>
    </div>
    <label className="field"><span>Photo (taken now)</span><input type="file" accept="image/*" capture="user" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></label>
    <button className="btn big" disabled={busy || f.name.trim().length < 2 || f.purpose.trim().length < 2} onClick={async () => {
      const r: any = await run(async () => api(`/schools/${schoolId}/visitors`, { body: { ...f, hostUserId: f.hostUserId || null, phone: f.phone || undefined, photoBase64: photo ? await readBase64(photo) : null } }), 'Signed in');
      if (r) onClose(r.id);
    }}>Sign in and print badge</button>
  </section></Drawer>;
}

function ExpectDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', purpose: '', organisation: '', on: today() });
  const [code, setCode] = useState<string | null>(null);
  const { run, busy } = useAction();
  return <Drawer title="Expect a visitor" onClose={onClose}><section className="tile tight stack">
    <p className="small muted">The visitor gets a six-digit code by SMS to show at the gate; you are told when they arrive.</p>
    <div className="form-grid">
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label className="field"><span>Purpose</span><input className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
      <label className="field"><span>Organisation</span><input className="input" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></label>
      <label className="field"><span>On</span><input className="input" type="date" min={today()} value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></label>
    </div>
    {code && <div className="callout small">Code sent. Test system: the code is <b className="mono">{code}</b>.</div>}
    <button className="btn big" disabled={busy || f.name.trim().length < 2 || f.phone.replace(/\D/g, '').length < 10 || f.purpose.trim().length < 2} onClick={async () => {
      const r: any = await run(() => api(`/schools/${schoolId}/visitors/expect`, { body: f }), 'The visitor is sent a code');
      if (r) { if (r.sandboxCode) setCode(r.sandboxCode); else onClose(); }
    }}>Send the code</button>
  </section></Drawer>;
}

/** Gate passes waiting for this class teacher (or the principal). */
export function GatePasses({ user }: { user: User }) {
  const [schoolId] = useSchool();
  const list = useLoad<any[]>(`/gate-passes/to-decide${user.role === 'SCHOOL_ADMIN' && schoolId ? `?schoolId=${schoolId}` : ''}`, [schoolId]);
  const [note, setNote] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const decide = async (g: any, approve: boolean) => { if (await run(() => api(`/gate-passes/${g.id}/decide`, { body: { approve, note: note[g.id] } }), approve ? 'Approved; the parent and the gate are told' : 'Not approved; the parent is told')) list.reload(); };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Gate passes</span></div></div>
      <main className="page"><section className="tile"><h2>Children leaving early</h2>
        <p className="muted" style={{ marginTop: 6 }}>Parents ask in the app and name who will collect the child. Once you approve, the guard sees the pass and checks the person against their photo.</p>
        {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>Nothing waiting.</Empty> : list.data.map((g) => <div key={g.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
          <div><b>{g.student}</b> <span className="small muted">{g.class} · {day(g.on_date)} at {g.leave_at.slice(0, 5)} · asked by {g.requested_by}</span></div>
          <div className="small">{g.reason} · collected by {g.pickup ? `${g.pickup} (${g.relation})` : 'the parent'}</div>
          <div style={{ display: 'flex', gap: 6 }}><input className="input" style={{ flex: 1 }} placeholder="Note (needed to refuse)" value={note[g.id] ?? ''} onChange={(e) => setNote({ ...note, [g.id]: e.target.value })} />
            <button className="btn small" disabled={busy} onClick={() => decide(g, true)}>Approve</button><button className="btn quiet small" disabled={busy || !(note[g.id] ?? '').trim()} onClick={() => decide(g, false)}>Refuse</button></div></div>)}
      </section></main>
    </>
  );
}
