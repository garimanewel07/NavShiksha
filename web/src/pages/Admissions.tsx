import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { allowed, api, day, num, today, words, type User, currentYear } from '../api';
import { CatChip, Drawer, Empty, SchoolPicker, Status, useAction, useLoad, useSchools } from '../ui';

const STAGES = ['SUBMITTED', 'VERIFIED', 'OFFERED', 'WAITLISTED', 'PROVISIONAL', 'ADMITTED', 'REJECTED'];

interface App { id: string; ref_no: string; child_name: string; class_code: string; status: string; admission_category: string; fee_band: string; submitted_at: string; campus: string; guardian_name: string; docs_pending: number }

export default function Admissions({ user }: { user: User }) {
  const { schools, campuses } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  const [stage, setStage] = useState<string>('SUBMITTED');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [seatsFor, setSeatsFor] = useState<string | null>(null);
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const list = useLoad<App[]>(schoolId ? `/admissions?schoolId=${schoolId}` : null, [schoolId]);
  const mine = campuses.filter((c) => c.parent_id === schoolId);
  const counts = Object.fromEntries(STAGES.map((s) => [s, (list.data ?? []).filter((a) => a.status === s).length]));
  const rows = (list.data ?? []).filter((a) => a.status === stage);
  // The Command and NES (outside a duty) follow admissions; the school's admission desk processes them.
  const manage = allowed(user, 'admissions.manage', schoolId);
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Admissions</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
        {mine.map((c) => <button key={c.id} className="btn quiet small" onClick={() => setSeatsFor(c.id)}>Seats · {c.name}</button>)}
        {manage && <button className="btn small" onClick={() => setCreating(true)}>New application</button>}
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head">
            <div><h2>Applications</h2><p className="muted" style={{ marginTop: 6 }}>Ordered by admission priority, then date. Cat 1 first.</p></div>
            <div className="seg" role="tablist" aria-label="Stage">
              {STAGES.map((s) => <button key={s} role="tab" aria-selected={stage === s} className={stage === s ? 'on' : ''} onClick={() => setStage(s)}>{words(s)} {counts[s] ? `· ${counts[s]}` : ''}</button>)}
            </div>
          </div>
          {rows.length ? (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Ref</th><th>Child</th><th>Class</th><th>Category</th><th>Fee band</th><th>Parent</th><th>Documents</th><th>Submitted</th></tr></thead>
              <tbody>{rows.map((a) => (
                <tr key={a.id} className="click" onClick={() => setOpen(a.id)}>
                  <td className="mono">{a.ref_no}</td><td style={{ fontWeight: 600 }}>{a.child_name}<div className="tiny muted">{a.campus}</div></td>
                  <td>{a.class_code}</td><td><CatChip code={a.admission_category} /></td><td>{words(a.fee_band)}</td><td>{a.guardian_name}</td>
                  <td>{a.docs_pending ? <span className="pill orange">{a.docs_pending} to verify</span> : <span className="pill green">Verified</span>}</td>
                  <td className="small muted">{day(a.submitted_at)}</td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>No applications at this stage.</Empty>}
        </section>
      </main>
      {open && <ApplicationDrawer id={open} manage={manage} onClose={() => { setOpen(null); list.reload(); }} />}
      {creating && <NewApplication campuses={mine} schoolId={schoolId} onClose={() => { setCreating(false); list.reload(); }} />}
      {seatsFor && <SeatMatrix campusId={seatsFor} onClose={() => setSeatsFor(null)} />}
    </>
  );
}

function ApplicationDrawer({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const { data: a, reload } = useLoad<any>(`/admissions/${id}`);
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [needsReason, setNeedsReason] = useState(false);
  const [provisional, setProvisional] = useState(false);
  const [tcDue, setTcDue] = useState('');
  if (!a) return <Drawer title="Application" onClose={onClose}><Empty>Loading…</Empty></Drawer>;
  const exp = a.category_explanation;
  const act = async (fn: () => Promise<unknown>, msg: string) => { const r = await run(fn, msg); if (r) reload(); return r; };
  return (
    <Drawer title={`${a.child_name} · ${a.ref_no}`} onClose={onClose}>
      <section className="tile tight stack">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Status s={a.status} /><span className="muted small">{a.class_name} · {a.campus}</span></div>
        <div className="form-grid">
          <div><div className="kpi-label">Parent</div><div style={{ fontWeight: 600 }}>{a.guardian_name}</div><div className="small muted">{words(a.relationship)} · {a.phone}</div></div>
          <div><div className="kpi-label">Date of birth</div><div>{day(a.child_dob)}</div></div>
        </div>
      </section>
      <section className="tile tight stack">
        <h3>How the category was decided</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><CatChip code={exp.admission.code} /><strong>{exp.admission.label}</strong></div>
        <p className="small muted">Because {exp.admission.because.join(', ')}. Scheme: {exp.admission.schemeName} v{exp.admission.schemeVersion}.</p>
        <div><span className="pill">Fee band: {exp.feeBand.label}</span></div>
      </section>
      <section className="tile tight stack">
        <h3>Documents</h3>
        {a.documents.map((d: any) => (
          <div key={d.doc_type} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div><div style={{ fontWeight: 600 }}>{words(d.doc_type)}</div>{d.verified_by && <div className="tiny muted">{words(d.status)} by {d.verified_by}</div>}</div>
            {manage && d.status === 'PENDING' && ['SUBMITTED', 'VERIFIED'].includes(a.status)
              ? <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn small" disabled={busy} onClick={() => act(() => api(`/admissions/${id}/documents`, { body: { docType: d.doc_type, status: 'VERIFIED' } }), 'Document verified')}>Verify</button>
                  <button className="btn danger small" disabled={busy} onClick={() => act(() => api(`/admissions/${id}/documents`, { body: { docType: d.doc_type, status: 'REJECTED', note: 'Not legible' } }), 'Document rejected')}>Reject</button>
                </span>
              : <Status s={d.status} />}
          </div>
        ))}
      </section>
      <section className="tile tight stack">
        <h3>Decision</h3>
        {manage && ['VERIFIED', 'WAITLISTED'].includes(a.status) && (
          <>
            {needsReason && (
              <label className="field"><span>The class is full. Cat 1 cannot be refused; record why this child is admitted over capacity.</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Father posted to station; Cat 1" /></label>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy} onClick={async () => {
                try { await api(`/admissions/${id}/offer`, { body: needsReason ? { overCapacityReason: reason } : {} }); reload(); }
                catch (e: any) { if (e.code === 'needs_reason') setNeedsReason(true); else await run(() => Promise.reject(e)); }
              }}>Offer a seat</button>
              {a.status !== 'WAITLISTED' && <button className="btn quiet" disabled={busy} onClick={() => act(() => api(`/admissions/${id}/status`, { body: { status: 'WAITLISTED' } }), 'Moved to waitlist')}>Waitlist</button>}
              <button className="btn danger" disabled={busy} onClick={() => act(() => api(`/admissions/${id}/status`, { body: { status: 'REJECTED', note: 'Not eligible' } }), 'Application rejected')}>Reject</button>
            </div>
          </>
        )}
        {manage && a.status === 'OFFERED' && (
          <>
            <label className="check"><input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} /> Provisional admission (original TC awaited)</label>
            {provisional && <label className="field"><span>Original TC due by</span><input className="input" type="date" value={tcDue} onChange={(e) => setTcDue(e.target.value)} /></label>}
            <button className="btn big" disabled={busy || (provisional && !tcDue)} onClick={async () => {
              const r: any = await act(() => api(`/admissions/${id}/admit`, { body: provisional ? { provisional: true, tcDueDate: tcDue } : {} }), 'Admitted');
              if (r) navigate(`/students/${r.studentId}`);
            }}>Admit {a.child_name.split(' ')[0]}</button>
          </>
        )}
        {manage && a.status === 'PROVISIONAL' && <button className="btn" disabled={busy} onClick={() => act(() => api(`/admissions/${id}/confirm`, { body: {} }), 'Admission confirmed')}>Original TC received: confirm admission</button>}
        {a.over_capacity_reason && <div className="callout orange small">Admitted over capacity: {a.over_capacity_reason}</div>}
        {a.student_id && <button className="btn secondary" onClick={() => navigate(`/students/${a.student_id}`)}>Open student profile</button>}
        {['ADMITTED', 'REJECTED', 'WITHDRAWN', 'SUBMITTED'].includes(a.status) && !a.student_id && <p className="small muted">{a.status === 'SUBMITTED' ? 'Verify every document to move this application forward.' : 'No further decision needed.'}</p>}
      </section>
    </Drawer>
  );
}

const SERVICES = ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD', 'DEF_CIV_NAVY', 'DEF_CIV_ARMY_AF', 'NES_STAFF', 'CIVILIAN'];
const STATUSES = ['SERVING', 'DEPUTATION_NAVY', 'ESM_PENSION', 'ESM_NO_PENSION', 'RETIRED', 'DIED_IN_SERVICE', 'NONE'];
const CLASSES = ['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

function NewApplication({ campuses, schoolId, onClose }: { campuses: { id: string; name: string }[]; schoolId: string; onClose: () => void }) {
  const { data: ranks } = useLoad<{ code: string; service: string; name: string }[]>('/ranks');
  const { run, busy } = useAction();
  const [f, setF] = useState({ campusId: campuses[0]?.id ?? '', classCode: 'I', childName: '', dob: '', gender: 'F', guardianName: '', phone: '+91', relationship: 'FATHER',
    service: 'NAVY', status: 'SERVING', rankCode: 'N_PO', postedInStation: true, civilOfficer: false,
    bloodGroup: '', apaarId: '', pen: '', previousSchool: '', address: '', otherName: '', otherPhone: '+91', otherRelationship: 'MOTHER' });
  const [preview, setPreview] = useState<any>(null);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const uniformed = ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD'].includes(f.service);
  const service = { service: f.service, status: f.status, rankCode: uniformed ? f.rankCode : null, postedInStation: f.postedInStation, civilOfficer: f.civilOfficer };
  useEffect(() => {
    const t = setTimeout(() => api('/categories/evaluate', { body: { schoolId, relationship: f.relationship, service } }).then(setPreview).catch(() => setPreview(null)), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.service, f.status, f.rankCode, f.postedInStation, f.civilOfficer, f.relationship, schoolId]);
  const rankOptions = (ranks ?? []).filter((r) => r.service === f.service);
  useEffect(() => { if (uniformed && rankOptions.length && !rankOptions.find((r) => r.code === f.rankCode)) set('rankCode', rankOptions[0].code); }, [f.service, ranks]); // eslint-disable-line
  const submit = async () => {
    const r = await run(() => api('/admissions', { body: {
      campusId: f.campusId, academicYear: currentYear(), classCode: f.classCode,
      child: { name: f.childName, dob: f.dob, gender: f.gender, bloodGroup: f.bloodGroup || null, apaarId: f.apaarId || null, pen: f.pen || null },
      guardian: { name: f.guardianName, phone: f.phone }, relationship: f.relationship, service,
      address: f.address || null, previousSchool: f.previousSchool || null,
      otherParent: f.otherName.trim().length > 1 && f.otherPhone.length > 4 ? { name: f.otherName, phone: f.otherPhone, relationship: f.otherRelationship } : null,
    } }), 'Application submitted. On admission these details fill the child’s record and both parents get the app.');
    if (r) onClose();
  };
  return (
    <Drawer title="New application" onClose={onClose}>
      <section className="tile tight stack">
        <h3>Child</h3>
        <div className="form-grid">
          <label className="field"><span>Full name</span><input className="input" value={f.childName} onChange={(e) => set('childName', e.target.value)} /></label>
          <label className="field"><span>Date of birth</span><input className="input" type="date" max={today()} value={f.dob} onChange={(e) => set('dob', e.target.value)} /></label>
          <label className="field"><span>Gender</span><select className="input" value={f.gender} onChange={(e) => set('gender', e.target.value)}><option value="F">Girl</option><option value="M">Boy</option><option value="X">Other</option></select></label>
          <label className="field"><span>Class</span><select className="input" value={f.classCode} onChange={(e) => set('classCode', e.target.value)}>{CLASSES.map((c) => <option key={c}>{c}</option>)}</select></label>
          {campuses.length > 1 && <label className="field"><span>Campus</span><select className="input" value={f.campusId} onChange={(e) => set('campusId', e.target.value)}>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label className="field"><span>Blood group</span><select className="input" value={f.bloodGroup} onChange={(e) => set('bloodGroup', e.target.value)}><option value="">—</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}</select></label>
          <label className="field"><span>APAAR ID</span><input className="input mono" inputMode="numeric" maxLength={12} value={f.apaarId} onChange={(e) => set('apaarId', e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>PEN</span><input className="input mono" inputMode="numeric" maxLength={11} value={f.pen} onChange={(e) => set('pen', e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Previous school</span><input className="input" value={f.previousSchool} onChange={(e) => set('previousSchool', e.target.value)} /></label>
        </div>
      </section>
      <section className="tile tight stack">
        <h3>Parent and service</h3>
        <div className="form-grid">
          <label className="field"><span>Parent's name</span><input className="input" value={f.guardianName} onChange={(e) => set('guardianName', e.target.value)} /></label>
          <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          <label className="field"><span>Relationship</span><select className="input" value={f.relationship} onChange={(e) => set('relationship', e.target.value)}>{['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT'].map((r) => <option key={r} value={r}>{words(r)}</option>)}</select></label>
          <label className="field"><span>Service</span><select className="input" value={f.service} onChange={(e) => set('service', e.target.value)}>{SERVICES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
          <label className="field"><span>Status</span><select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
          {uniformed && <label className="field"><span>Rank (at retirement for ex-servicemen)</span><select className="input" value={f.rankCode} onChange={(e) => set('rankCode', e.target.value)}>{rankOptions.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>}
        </div>
        <label className="check"><input type="checkbox" checked={f.postedInStation} onChange={(e) => set('postedInStation', e.target.checked)} /> Posted in this station</label>
        {f.service.startsWith('DEF_CIV') && <label className="check"><input type="checkbox" checked={f.civilOfficer} onChange={(e) => set('civilOfficer', e.target.checked)} /> Defence civilian officer</label>}
        <label className="field"><span>Home address</span><textarea className="input" rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Kept once for the family; brothers and sisters share it" /></label>
      </section>
      <section className="tile tight stack">
        <h3>Second parent</h3>
        <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={f.otherName} onChange={(e) => set('otherName', e.target.value)} /></label>
          <label className="field"><span>Mobile</span><input className="input" inputMode="tel" value={f.otherPhone} onChange={(e) => set('otherPhone', e.target.value)} /></label>
          <label className="field"><span>Relationship</span><select className="input" value={f.otherRelationship} onChange={(e) => set('otherRelationship', e.target.value)}>{['MOTHER', 'FATHER', 'GUARDIAN', 'GRANDPARENT'].map((r) => <option key={r} value={r}>{words(r)}</option>)}</select></label>
        </div>
        <p className="tiny muted">Both parents get the parent app on admission. Certificates, ID cards and report cards take their names from here.</p>
      </section>
      {preview && (
        <section className="callout blue stack">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><CatChip code={preview.admission.code} /><strong>{preview.admission.label}</strong></div>
          <span className="small">Fee band: {preview.feeBand.label}. Because {preview.admission.because.join(', ')}.</span>
          {preview.admission.requiredDocs.length > 0 && <span className="small">Documents needed: birth certificate, {preview.admission.requiredDocs.map(words).join(', ').toLowerCase()}.</span>}
        </section>
      )}
      <button className="btn big" disabled={busy || !f.childName || !f.dob || !f.guardianName} onClick={submit}>Submit application</button>
    </Drawer>
  );
}

function SeatMatrix({ campusId, onClose }: { campusId: string; onClose: () => void }) {
  const { data } = useLoad<any[]>(`/campuses/${campusId}/seats?year=${currentYear()}`);
  return (
    <Drawer title="Seats by class" onClose={onClose}>
      <section className="tile tight">
        {!data ? <Empty>Loading…</Empty> : (
          <table className="table">
            <thead><tr><th>Class</th><th className="num">Seats</th><th className="num">Filled</th><th className="num">Offered</th><th>Free</th></tr></thead>
            <tbody>{data.map((r) => {
              const free = r.capacity - r.filled - r.offered;
              return (
                <tr key={r.class_code}><td style={{ fontWeight: 600 }}>{r.class_name}</td><td className="num">{num(r.capacity)}</td><td className="num">{num(r.filled)}</td><td className="num">{num(r.offered)}</td>
                  <td><span className={`pill ${free <= 0 ? 'red' : free < 5 ? 'orange' : 'green'}`}>{free <= 0 ? `Full${free < 0 ? ` (+${-free})` : ''}` : `${free} free`}</span></td></tr>
              );
            })}</tbody>
          </table>
        )}
      </section>
    </Drawer>
  );
}
