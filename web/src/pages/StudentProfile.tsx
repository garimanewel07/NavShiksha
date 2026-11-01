import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { api, day, hasDuty, money, openPdf, today, words, type User } from '../api';
import { CatChip, Drawer, Empty, Status, StudentPhoto, useAction, useLoad } from '../ui';
import { ReportRecord } from './Help';
import { FailedPage } from '../errors';

export default function StudentProfile({ user }: { user: User }) {
  const { id } = useParams();
  const { data: p, reload, error } = useLoad<any>(`/students/${id}`, [id]);
  const [transfer, setTransfer] = useState(false);
  const [service, setService] = useState<any>(null);
  const [fix, setFix] = useState(false);
  const [family, setFamily] = useState<any>(null);
  if (error) return <FailedPage error={error} />;
  if (!p) return <main className="page"><Empty>Loading…</Empty></main>;
  const cur = p.enrolments.find((e: any) => ['ACTIVE', 'PROVISIONAL'].includes(e.status));
  const g = new Set<string>(p.grants ?? []);
  const due = (p.dues ?? []).reduce((s: number, d: any) => s + Math.max(0, d.due_paise), 0);
  const canManage = ['NES_ADMIN', 'SCHOOL_ADMIN', 'COMMAND_OFFICER'].includes(user.role);
  // Asking another school is for the school's own desk: the principal or the admission in-charge.
  const canMove = user.role === 'SCHOOL_ADMIN' || hasDuty(user, 'ADMISSION_INCHARGE');
  const hidden = HIDDEN_LABELS.filter(([k]) => !g.has(k)).map(([, l]) => l);
  const kpis = [
    g.has('category') && cur && <div key="cat"><div className="kpi-label">Admission category</div><div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}><CatChip code={cur.admission_category} /><span className="small">{cur?.category_snapshot?.admission?.label}</span></div></div>,
    g.has('category') && <div key="band"><div className="kpi-label">Fee band today</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{p.feeBand ? words(p.feeBand.code) : '—'}</div><div className="kpi-note">{p.feeBand?.because?.join(', ')}</div></div>,
    g.has('fees') && <div key="due"><div className="kpi-label">Fees due</div><div className="kpi-value" style={{ color: due ? 'var(--red)' : undefined }}>{money(due)}</div><div className="kpi-note">across all instalments</div></div>,
    !g.has('fees') && p.feeStatus && <div key="fs"><div className="kpi-label">Fees</div><div className="kpi-value" style={{ fontSize: '1.6rem', color: p.feeStatus === 'OVERDUE' ? 'var(--red)' : 'var(--green)' }}>{p.feeStatus === 'OVERDUE' ? 'Overdue' : 'Clear'}</div><div className="kpi-note">The accountant has the details</div></div>,
    p.attendance && <div key="att"><div className="kpi-label">Attendance this month</div><div className="kpi-value">{p.attendance.marked ? `${Math.round((p.attendance.present / p.attendance.marked) * 100)}%` : '—'}</div><div className="kpi-note">{p.attendance.present} of {p.attendance.marked} days</div></div>,
    cur?.class_teacher && <div key="ct"><div className="kpi-label">Class teacher</div><div className="kpi-value" style={{ fontSize: '1.3rem' }}>{cur.class_teacher}</div></div>,
    g.has('health') && <div key="bg"><div className="kpi-label">Blood group</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{p.student.blood_group ?? '—'}</div></div>,
  ].filter(Boolean);
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">{p.student.name}</span><span className="mono muted small">{p.student.nes_id}</span><span className="spacer" />
        {!canMove && <ReportRecord entityType="STUDENT" entityId={p.student.id} label={p.student.name} />}
        {canMove && cur && <button className="btn quiet small" onClick={() => setFix(true)}>Correct details</button>}
        {canMove && cur && <button className="btn small" onClick={() => setTransfer(true)}>Move to another school</button>}
      </div></div>
      <main className="page">
        <section className="tile">
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <StudentPhoto id={p.student.id} name={p.student.name} size={88} radius="22px" />
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div className="eyebrow">{cur ? `${cur.school} · ${cur.campus}` : 'Not currently enrolled'}</div>
              <h1 style={{ marginTop: 6 }}>{p.student.name}</h1>
              {cur && <p style={{ fontSize: '1.24rem', marginTop: 8 }}>{cur.class_name}{cur.section ? `-${cur.section}` : ''} · Admission no. <span className="mono">{cur.admission_no}</span></p>}
            </div>
          </div>
          {kpis.length > 0 && <div className="kpis" style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--line)' }}>{kpis}</div>}
          {cur?.status === 'PROVISIONAL' && <div className="callout orange" style={{ marginTop: 20 }}>Provisional admission. Original TC due by {day(cur.tc_due_date)}.</div>}
          {hidden.length > 0 && <p className="small muted" style={{ marginTop: 20 }}>Not shown to your role: {hidden.join(', ')}.</p>}
        </section>

        <div className="row">
          <section className="tile" style={{ flex: '1 1 420px' }}>
            <h2>Family</h2>
            {p.guardians.map((x: any) => (
              <div key={x.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{x.name} <span className="muted small">· {words(x.relationship)}{x.is_primary ? ', primary' : ''}</span></div>
                  {x.phone && <div className="small muted">{x.phone}{x.email ? ` · ${x.email}` : ''}</div>}
                  {x.address && <div className="small muted">{x.address}</div>}
                  {g.has('service') && <div className="small" style={{ marginTop: 4 }}>{words(x.service)} · {words(x.status)}{x.rank_name ? ` · ${x.rank_name}` : ''}{x.posted_in_station ? ' · posted in station' : ''} <span className="muted">since {day(x.since)}</span></div>}
                </div>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{canMove && g.has('contact') && <button className="btn quiet small" onClick={() => setFamily(x)}>Correct</button>}
                {canManage && g.has('service') && <button className="btn quiet small" onClick={() => setService(x)}>Record a change</button>}</span>
              </div>
            ))}
            {!g.has('contact') && <p className="small muted">Contact the family through Messages. Phone numbers are kept with the class teacher and the office.</p>}
            <Siblings studentId={p.student.id} />
          </section>
          <section className="tile" style={{ flex: '1 1 420px' }}>
            <h2>History</h2>
            {p.enrolments.map((e: any) => (
              <div key={e.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div><div style={{ fontWeight: 600 }}>{e.school}</div><div className="small muted">{e.class_name}{e.section ? `-${e.section}` : ''} · {e.campus} · {day(e.from)} to {e.to ? day(e.to) : 'today'}</div>
                  {e.category_snapshot?.reason && <div className="tiny muted">{e.category_snapshot.reason}</div>}</div>
                <Status s={e.status} />
              </div>
            ))}
          </section>
        </div>

        {g.has('academics') && <StudentResults studentId={p.student.id} />}

        {p.dues && <section className="tile">
          <div className="tile-head"><h2>Fees</h2></div>
          {p.dues.length ? (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Instalment</th><th>School</th><th>Head</th><th className="num">Charged</th><th className="num">Paid</th><th className="num">Due</th></tr></thead>
              <tbody>{p.dues.map((d: any, i: number) => (
                <tr key={i}><td>{d.kind === 'INSTALMENT' ? `${d.bill} · ` : ''}{d.label}<div className="tiny muted">Due {day(d.due_date)}{d.detail ? ` · ${d.detail}` : ''}</div></td><td className="small">{d.school.replace('Navy Children School, ', 'NCS ')}</td><td>{d.head}</td>
                  <td className="num">{money(d.owed_paise)}</td><td className="num">{money(d.paid_paise)}</td>
                  <td className="num" style={{ fontWeight: 600, color: d.due_paise > 0 ? 'var(--red)' : 'var(--green)' }}>{d.due_paise > 0 ? money(d.due_paise) : 'Paid'}</td></tr>))}</tbody>
            </table></div>
          ) : <Empty>No fees raised yet.</Empty>}
        </section>}
        {p.payments && <section className="tile">
          <div className="tile-head"><h2>Receipts</h2><span className="small muted">Every NES school the child has studied at</span></div>
          {p.payments.length ? (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Receipt</th><th>Date</th><th>School</th><th>Method</th><th className="num">Amount</th></tr></thead>
              <tbody>{p.payments.map((x: any) => (
                <tr key={x.receipt_no}><td className="mono small">{x.receipt_no}</td><td>{day(x.captured_at)}</td><td className="small">{x.school.replace('Navy Children School, ', 'NCS ')}</td><td>{words(x.method)}</td><td className="num">{money(x.amount_paise)}</td></tr>))}</tbody>
            </table></div>
          ) : <Empty>No payments yet.</Empty>}
        </section>}
      </main>
      {transfer && <TransferDrawer studentId={p.student.id} onClose={() => { setTransfer(false); reload(); }} />}
      {service && <ServiceDrawer guardian={service} onClose={() => { setService(null); reload(); }} />}
      {fix && <ChildDrawer s={p.student} onClose={() => { setFix(false); reload(); }} />}
      {family && <FamilyDrawer g={family} onClose={() => { setFamily(null); reload(); }} />}
    </>
  );
}

const HIDDEN_LABELS: [string, string][] = [['fees', 'fees'], ['category', 'admission category and fee band'], ['contact', 'family contacts'], ['service', 'service details'], ['health', 'health notes'], ['attendance', 'attendance'], ['academics', 'marks']];

const REQUEST_STATUS: Record<string, [string, string]> = { PENDING: ['Waiting for the school', 'orange'], WAITLISTED: ['On its waiting list', 'orange'], ACCEPTED: ['Seat given', 'green'],
  DECLINED: ['Declined', 'red'], CANCELLED: ['Withdrawn', ''], COMPLETED: ['Moved', 'green'] };

/**
 * Moving to another Navy Children School or Navy Kindergarten: the school is asked, checks its
 * seats and accepts; this school then issues the TC and the child moves with every record.
 */
function TransferDrawer({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const { run, busy } = useAction();
  const options = useLoad<any>(`/students/${studentId}/transfer-destinations`);
  const requests = useLoad<any[]>(`/students/${studentId}/transfer-requests`);
  const [to, setTo] = useState('');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('Parent posted to a new station');
  const [withdraw, setWithdraw] = useState('');
  const open = (requests.data ?? []).find((r) => ['PENDING', 'WAITLISTED', 'ACCEPTED'].includes(r.status));
  return (
    <Drawer title="Move to another school" onClose={onClose}>
      {open ? <section className="tile tight stack small">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><strong>{open.to_school}</strong><span className={`pill ${REQUEST_STATUS[open.status][1]}`}>{REQUEST_STATUS[open.status][0]}</span></div>
        <span>{open.class_name}, joining {day(open.joining_on)} · {open.reason}</span>
        {open.status === 'ACCEPTED' && <div className="callout green">Seat in Class {open.section}. Issue the transfer certificate (Certificates → New certificate → Transfer certificate). On issue the child moves there the next day with every record.</div>}
        {open.decision_note && <span className="muted">{open.decision_note}</span>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: '1 1 200px' }} placeholder="Reason for withdrawing" value={withdraw} onChange={(e) => setWithdraw(e.target.value)} />
          <button className="btn quiet small" disabled={busy || withdraw.trim().length < 3} onClick={async () => { if (await run(() => api(`/transfer-requests/${open.id}/cancel`, { body: { reason: withdraw } }), 'Request withdrawn')) requests.reload(); }}>Withdraw request</button>
        </div>
      </section> : <section className="tile tight stack">
        <p className="small muted">The school chosen is asked for a seat in {options.data?.className ?? 'the same class'}. It checks its seats and accepts, puts the child on its waiting list, or declines. Nothing changes here until it accepts; then this school issues the TC and the child moves with the record, results, attendance, photo and documents.</p>
        <label className="field"><span>Ask</span>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a Navy Children School or Navy Kindergarten</option>
            {(options.data?.schools ?? []).map((s: any) => <option key={s.schoolId} value={s.schoolId}>{s.name}{s.command ? ` (${s.command.replace(' Naval Command', '')})` : ''} · {s.free > 0 ? `${s.free} seat${s.free === 1 ? '' : 's'} free` : 'full: waiting list'}</option>)}
          </select></label>
        {options.data && options.data.schools.length === 0 && <span className="small muted">No other school teaches {options.data.className} this year.</span>}
        <label className="field"><span>First day at the new school</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="btn big" disabled={busy || !to} onClick={async () => { if (await run(() => api(`/students/${studentId}/transfer-requests`, { body: { toSchoolId: to, joiningOn: date, reason } }), 'The school has been asked')) requests.reload(); }}>Ask the school</button>
        <p className="tiny muted">Fees: each school charges only for its own time; no money passes between schools. This school keeps the quarter in progress and refunds anything paid for later quarters; the new school sees every receipt and charges from its next quarter.</p>
      </section>}
      {(requests.data ?? []).filter((r) => r !== open).length > 0 && <section className="tile tight stack small">
        <strong>Earlier requests</strong>
        {(requests.data ?? []).filter((r) => r !== open).map((r) => <div key={r.id}>{r.to_school} · {day(r.created_at)} · <span className={`pill ${REQUEST_STATUS[r.status]?.[1] ?? ''}`}>{REQUEST_STATUS[r.status]?.[0] ?? r.status}</span>{r.decision_note ? <span className="muted"> · {r.decision_note}</span> : null}</div>)}
      </section>}
    </Drawer>
  );
}

function ServiceDrawer({ guardian, onClose }: { guardian: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const { data: ranks } = useLoad<any[]>('/ranks');
  const [f, setF] = useState({ from: today(), service: guardian.service ?? 'NAVY', status: guardian.status ?? 'SERVING', rankCode: guardian.rank_code, postedInStation: !!guardian.posted_in_station });
  const uniformed = ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD'].includes(f.service);
  return (
    <Drawer title={`Service change · ${guardian.name}`} onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">Postings, promotions and retirement apply from their date. Categories and fee bands follow automatically for instalments that start after it; earlier ones are not touched.</p>
        <div className="form-grid">
          <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="field"><span>Status</span><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {['SERVING', 'DEPUTATION_NAVY', 'ESM_PENSION', 'ESM_NO_PENSION', 'RETIRED', 'DIED_IN_SERVICE', 'NONE'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
          {uniformed && <label className="field"><span>Rank</span><select className="input" value={f.rankCode ?? ''} onChange={(e) => setF({ ...f, rankCode: e.target.value })}>
            {(ranks ?? []).filter((r) => r.service === f.service).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>}
        </div>
        <label className="check"><input type="checkbox" checked={f.postedInStation} onChange={(e) => setF({ ...f, postedInStation: e.target.checked })} /> Posted in this station</label>
        <button className="btn big" disabled={busy} onClick={async () => { if (await run(() => api(`/guardians/${guardian.id}/service`, { body: { ...f, rankCode: uniformed ? f.rankCode : null } }), 'Service record updated')) onClose(); }}>Save change</button>
      </section>
    </Drawer>
  );
}

/** Published results for staff who may see the child's marks, with the report card for each exam. */
function StudentResults({ studentId }: { studentId: string }) {
  const r = useLoad<any>(`/students/${studentId}/results`, [studentId]);
  const { run, busy } = useAction();
  if (!r.data) return null;
  return (
    <section className="tile">
      <div className="tile-head"><h2>Results</h2>{r.data.running && <span className="small muted">Weighted so far: <b>{r.data.running.percentage}%</b> ({r.data.running.basedOn.join(', ')})</span>}</div>
      {!r.data.results.length ? <Empty>No published results this year.</Empty> : <div className="scroll-x"><table className="table">
        <thead><tr><th>Exam</th><th className="num">Total</th><th className="num">%</th><th>Grade</th><th className="num">Rank</th><th /></tr></thead>
        <tbody>{r.data.results.map((x: any) => <tr key={x.assessment_id}><td>{x.name}<div className="tiny muted">{x.subjects.map((sj: any) => `${sj.name.slice(0, 4)} ${sj.absent ? 'AB' : sj.marks}`).join(' · ')}</div></td>
          <td className="num">{x.obtained}/{x.max_total}</td><td className="num"><b>{x.percentage}</b></td><td>{x.grade}</td><td className="num">{x.rank_section ? `${x.rank_section}/${x.section_size}` : '—'}</td>
          <td className="num"><button className="btn quiet small" disabled={busy} onClick={() => run(() => openPdf(`/students/${studentId}/report-card/${x.assessment_id}`))}>Report card</button></td></tr>)}</tbody>
      </table></div>}
    </section>
  );
}

/** The one place a child's details are corrected; certificates, ID cards and the parent app read them from here. */
function ChildDrawer({ s, onClose }: { s: any; onClose: () => void }) {
  const [f, setF] = useState({ name: s.name, dob: s.dob, bloodGroup: s.blood_group ?? '', apaarId: s.apaar_id ?? '', pen: s.pen ?? '', previousSchool: s.previous_school ?? '' });
  const { run, busy } = useAction();
  return (
    <Drawer title="Correct the child’s details" onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">Corrected here, corrected everywhere: certificates, ID cards, report cards and the parent app.</p>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></label>
          <label className="field"><span>Blood group</span><select className="input" value={f.bloodGroup} onChange={(e) => setF({ ...f, bloodGroup: e.target.value })}><option value="">—</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}</select></label>
          <label className="field"><span>APAAR ID</span><input className="input mono" value={f.apaarId} maxLength={12} onChange={(e) => setF({ ...f, apaarId: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="field"><span>PEN</span><input className="input mono" value={f.pen} maxLength={11} onChange={(e) => setF({ ...f, pen: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        <label className="field"><span>Previous school</span><input className="input" value={f.previousSchool} onChange={(e) => setF({ ...f, previousSchool: e.target.value })} /></label>
        <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/students/${s.id}/details`, { method: 'PUT', body: { name: f.name, dob: f.dob, bloodGroup: f.bloodGroup || null, apaarId: f.apaarId || null, pen: f.pen || null, previousSchool: f.previousSchool || null } }), 'Saved')) onClose(); }}>Save</button>
      </section>
    </Drawer>
  );
}

/** A parent's details, kept once and shared by all their children in any NES school. */
function FamilyDrawer({ g, onClose }: { g: any; onClose: () => void }) {
  const [f, setF] = useState({ name: g.name, phone: g.phone ?? '+91', email: g.email ?? '', address: g.address ?? '' });
  const { run, busy } = useAction();
  return (
    <Drawer title={`Correct · ${g.name}`} onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">This parent’s details are shared by all their children, in any NES school.</p>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field"><span>Mobile</span><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="field"><span>Email</span><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label></div>
        <label className="field"><span>Home address</span><textarea className="input" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/guardians/${g.id}`, { method: 'PUT', body: { name: f.name, phone: f.phone, email: f.email || null, address: f.address || null } }), 'Saved')) onClose(); }}>Save</button>
      </section>
    </Drawer>
  );
}

/** Brothers and sisters (children sharing a parent), found from the parents, and the family's PTA fee. */
function Siblings({ studentId }: { studentId: string }) {
  const { data } = useLoad<any>(`/students/${studentId}/family`, [studentId]);
  if (!data) return null;
  const others = data.members.filter((m: any) => m.id !== studentId);
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ margin: '0 0 6px' }}>Brothers and sisters</h3>
      {!others.length ? <p className="small muted">None at any Navy school.</p> : others.map((m: any) => <div key={m.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
        <Link to={`/students/${m.id}`}><b>{m.name}</b></Link><span className="small muted">{m.class_code ? `${m.class_code}${m.section ? `-${m.section}` : ''} · ${m.school?.replace('Navy Children School, ', 'NCS ')}` : 'Not at a Navy school now'}</span></div>)}
      {data.pta && data.pta.amount > 0 && <p className="small" style={{ marginTop: 8 }}>PTA fee {money(data.pta.amount)} ({data.pta.frequency === 'ONCE' ? 'once' : 'a year'} per family){data.pta.billedTo ? <> · billed with <b>{data.pta.billedTo.name}</b>’s fees ({data.pta.billedTo.year}), {data.pta.billedTo.paid ? <span className="pill green">paid</span> : <span className="pill orange">not paid yet</span>}</> : ' · billed with the eldest child’s first bill'}</p>}
    </div>
  );
}
