import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, day, hasDuty, money, type User } from '../api';
import { Empty, SchoolPicker, useAction, useLoad, useSchools } from '../ui';
import { useSchoolSections } from './Cards';

const STATUS: Record<string, [string, string]> = { PENDING: ['New', 'blue'], WAITLISTED: ['Waiting list', 'orange'], ACCEPTED: ['Seat given', 'green'],
  DECLINED: ['Declined', 'red'], CANCELLED: ['Withdrawn', ''], COMPLETED: ['Moved', 'green'] };

/**
 * Moving between Navy Children Schools and Navy Kindergartens, for a school's desk:
 * requests to join (check seats, accept, wait-list or decline), children leaving (issue the TC
 * once the other school accepts), and children who joined recently (check their section).
 */
export default function Incoming({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'in';
  const desk = user.role === 'SCHOOL_ADMIN' || hasDuty(user, 'ADMISSION_INCHARGE');
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Transfers between schools</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
      </div></div>
      <main className="page">
        <div className="seg" style={{ marginBottom: 16 }}>
          {[['in', 'Asking to join'], ['out', 'Leaving'], ['joined', 'Joined recently']].map(([k, l]) =>
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setParams(k === 'in' ? {} : { tab: k })}>{l}</button>)}
        </div>
        {schoolId && (tab === 'in' ? <Requests schoolId={schoolId} desk={desk} /> : tab === 'out' ? <Leaving schoolId={schoolId} /> : <Joined schoolId={schoolId} desk={desk} />)}
      </main>
    </>
  );
}

/** Requests from other schools' families: seats in each section, and the decision. */
function Requests({ schoolId, desk }: { schoolId: string; desk: boolean }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/transfer-requests/incoming`, [schoolId]);
  const { run, busy } = useAction();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = async (id: string, decision: string) => {
    if (await run(() => api(`/transfer-requests/${id}/decide`, { body: { decision, sectionId: pick[id] || undefined, note: note[id] || undefined } }),
      decision === 'ACCEPT' ? 'Accepted: the parent and the present school are told' : decision === 'WAITLIST' ? 'Put on the waiting list' : 'Declined')) list.reload();
  };
  if (!list.data) return <Empty>Loading…</Empty>;
  if (!list.data.length) return <section className="tile"><Empty>No requests to join this school.</Empty></section>;
  return (
    <div className="stack">
      {list.data.map((r) => {
        const [label, tone] = STATUS[r.status] ?? [r.status, ''];
        const open = ['PENDING', 'WAITLISTED'].includes(r.status);
        const free = (r.sections as any[]).filter((s) => s.free > 0);
        return (
          <section key={r.id} className="tile tight stack small">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '1.05rem' }}>{r.student}</strong><span className="mono muted">{r.nes_id}</span><span className={`pill ${tone}`}>{label}</span>
              <span className="spacer" /><span className="muted">asked {day(r.created_at)} by {r.requested_as === 'PARENT' ? 'the parent' : r.requested_by}</span>
            </div>
            <div>{r.class_name} · from <strong>{r.from_school}</strong> (adm. no. {r.admission_no}) · joining <strong>{day(r.joining_on)}</strong> · {r.reason}
              {r.attendance != null && <span className="muted"> · attendance this year {r.attendance}%</span>}</div>
            <div className="scroll-x"><table className="table">
              <thead><tr><th>{r.class_name} section</th><th>Campus</th><th className="num">Places</th><th className="num">Children</th><th className="num">Seats promised</th><th className="num">Free</th></tr></thead>
              <tbody>{(r.sections as any[]).map((s) => <tr key={s.id}><td>{s.label}</td><td className="small">{s.campus}</td><td className="num">{s.capacity}</td><td className="num">{s.strength}</td><td className="num">{s.promised}</td>
                <td className="num" style={{ fontWeight: 600, color: s.free > 0 ? 'var(--green)' : 'var(--red)' }}>{Math.max(0, s.free)}</td></tr>)}</tbody>
            </table></div>
            {r.status === 'ACCEPTED' && <span>Seat in <strong>{r.section}</strong> given by {r.decided_by}. {r.from_school} now issues the TC; the child arrives with every record.</span>}
            {r.decision_note && <span className="muted">{r.decision_note}</span>}
            {open && desk && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="input" style={{ height: 36, width: 'auto' }} value={pick[r.id] ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} aria-label="Section">
                <option value="">{free.length ? 'Choose a section' : 'No free seat'}</option>
                {free.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.free} free)</option>)}
              </select>
              <button className="btn small" disabled={busy || !pick[r.id]} onClick={() => decide(r.id, 'ACCEPT')}>Accept</button>
              <input className="input" style={{ flex: '1 1 220px', height: 36 }} placeholder="Note for the parent (needed to decline)" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
              {r.status === 'PENDING' && <button className="btn quiet small" disabled={busy} onClick={() => decide(r.id, 'WAITLIST')}>Waiting list</button>}
              <button className="btn danger small" disabled={busy || (note[r.id] ?? '').trim().length < 5} onClick={() => decide(r.id, 'DECLINE')}>Decline</button>
            </div>}
          </section>
        );
      })}
    </div>
  );
}

/** Children of this school asking to go elsewhere: the TC is issued once the other school accepts. */
function Leaving({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/transfer-requests/outgoing`, [schoolId]);
  if (!list.data) return <Empty>Loading…</Empty>;
  return (
    <section className="tile">
      <h2>Leaving for other schools</h2>
      <p className="small muted" style={{ marginTop: 6 }}>When the other school gives a seat, prepare and issue the transfer certificate from Certificates. On issue the child moves there the day after the leaving date.</p>
      {!list.data.length ? <Empty>No requests to other schools.</Empty> : <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
        <thead><tr><th>Child</th><th>Asked</th><th>Joining</th><th>Status</th><th>TC</th></tr></thead>
        <tbody>{list.data.map((r) => { const [label, tone] = STATUS[r.status] ?? [r.status, '']; return (
          <tr key={r.id}><td><Link to={`/students/${r.student_id}`}><strong>{r.student}</strong></Link><div className="tiny muted">{r.class_name} · {r.admission_no}</div></td>
            <td className="small">{r.to_school}<div className="tiny muted">{r.reason}</div></td><td>{day(r.joining_on)}</td>
            <td><span className={`pill ${tone}`}>{label}</span>{r.section && <div className="tiny muted">{r.section}</div>}{r.decision_note && <div className="tiny muted">{r.decision_note}</div>}</td>
            <td className="small">{r.tc_serial ?? (r.status === 'ACCEPTED' ? <Link to="/certificates">Issue TC</Link> : '—')}</td></tr>); })}</tbody>
      </table></div>}
    </section>
  );
}

/** Children who joined from another school in the last four months: check the section; see what was paid there. */
function Joined({ schoolId, desk }: { schoolId: string; desk: boolean }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/incoming`, [schoolId]);
  const sections = useSchoolSections(schoolId);
  const { run, busy } = useAction();
  if (!list.data) return <Empty>Loading…</Empty>;
  return (
    <section className="tile">
      <h2>Joined recently</h2>
      <p className="small muted" style={{ marginTop: 6 }}>Nothing needs typing again: the record, results, attendance and photo came with them. Fees for the quarter they arrived in were charged by the old school; this school charges from the next quarter.</p>
      {list.data.length === 0 ? <Empty>No one has joined from another school in the last four months.</Empty> : (
        <div className="scroll-x" style={{ marginTop: 16 }}><table className="table">
          <thead><tr><th>Child</th><th>From</th><th>Joined</th><th>Admission no.</th><th className="num">Paid at old school</th><th>Section</th></tr></thead>
          <tbody>{list.data.map((x) => (
            <tr key={x.enrolment_id}>
              <td><Link to={`/students/${x.student_id}`}><strong>{x.name}</strong></Link><div className="tiny muted mono">{x.nes_id}</div></td>
              <td className="small">{x.from_school}<div className="tiny muted">{x.reason}{x.tc ? ` · TC ${x.tc}` : ''}</div></td>
              <td>{day(x.joined)}</td>
              <td className="mono small">{x.admission_no}</td>
              <td className="num">{money(x.paid_before_paise)}</td>
              <td>{desk ? (
                <select className="input" style={{ height: 34, width: 'auto' }} value={x.section_id ?? ''} disabled={busy}
                  onChange={async (e) => { if (e.target.value && await run(() => api(`/enrolments/${x.enrolment_id}/section`, { body: { sectionId: e.target.value } }), 'Section changed; roll number given')) list.reload(); }}>
                  <option value="">Choose</option>
                  {sections.filter((s) => s.classCode === x.class_code).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.strength})</option>)}
                </select>) : <span>{x.section ?? '—'}</span>}
                {x.roll_no && <div className="tiny muted">roll {x.roll_no}</div>}
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
    </section>
  );
}
