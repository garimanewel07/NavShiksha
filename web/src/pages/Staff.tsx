import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { allowed, api, day, money, openPdf, today, type User } from '../api';
import { Drawer, Empty, initials, useAction, useLoad } from '../ui';
import { useSchool } from './Payroll';
import { ReportRecord } from './Help';
import { FailedPage } from '../errors';

/**
 * Staff, entered once. The "add a member of staff" form asks everything in one go: the person,
 * their post, the classes and subjects they teach, their class, duties, pay, bank and identity
 * numbers. From that one record the timetable, marks sheets, report cards, cover, ID card,
 * payroll, leave and chat all follow. The profile shows all of it, linked, in one place.
 */

const EMP: Record<string, [string, string]> = {
  PERMANENT: ['Permanent', 'green'], CONTRACT: ['Contract', 'blue'], TEMPORARY: ['Temporary', 'blue'], PART_TIME: ['Part-time', ''],
  GUEST: ['Guest', 'orange'], DAILY_WAGE: ['Daily wage', 'orange'], DEPUTATION: ['Deputation', ''],
};
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const EVENT: Record<string, string> = {
  JOINED: 'Joined', PROBATION: 'Probation', CONFIRMED: 'Confirmed', CONTRACT_RENEWED: 'Contract renewed', MADE_PERMANENT: 'Made permanent', INCREMENT: 'Increment', PROMOTION: 'Promotion',
  PAY_FIXED: 'Pay fixed', TRANSFER: 'Transfer', LEAVE: 'Leave', TRAINING: 'Training', AWARD: 'Award', PENALTY: 'Penalty', SEPARATION: 'Left', CORRECTION: 'Correction', NOTE: 'Note',
};
const fyNow = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };
const Emp = ({ e }: { e: string }) => { const [l, t] = EMP[e] ?? [e, '']; return <span className={`pill ${t}`}>{l}</span>; };

// ── The staff list ─────────────────────────────────────────────────────────────────────────

export function StaffList({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff-records` : null, [schoolId]);
  const due = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff-records/due` : null, [schoolId]);
  const [add, setAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const canAdd = allowed(user, 'staff.manage', schoolId);
  const rows = (list.data ?? []).filter((r) => r.on_record && !r.separated_on).filter((r) => !filter || r.employment === filter || r.category === filter)
    .filter((r) => !q.trim() || `${r.name} ${r.designation ?? ''} ${r.nes_staff_id ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const notOnRecord = (list.data ?? []).filter((r) => !r.on_record);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Staff</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <Link className="btn quiet small" to="/staff-register">Staff register</Link>{allowed(user, 'staff.view', schoolId) && <Link className="btn quiet small" to="/staff-leave">Staff leave</Link>}
        {canAdd && <button className="btn small" onClick={() => setAdd(true)}>Add a member of staff</button>}</div></div>
      <main className="page">
        {(due.data ?? []).length > 0 && <section className="callout orange stack small">
          <b>Coming up</b>{(due.data ?? []).map((d) => <span key={d.user_id}><Link to={`/staff/${d.user_id}`}>{d.name}</Link>: {d.what === 'TERM_ENDS' ? `${EMP[d.employment]?.[0]} term ends ${day(d.contract_until)}. Renew it or record that they are leaving.` : `probation ends ${day(d.probation_until)}. Confirm in the service book.`}</span>)}</section>}
        {notOnRecord.length > 0 && canAdd && <section className="callout blue small">
          {notOnRecord.length} {notOnRecord.length === 1 ? 'person signs' : 'people sign'} in at this school without a staff record ({notOnRecord.map((r) => r.name).join(', ')}). Add them with the form; their sign-in is kept.</section>}
        <section className="tile">
          <div className="tile-head"><div><h2>Everyone on the staff</h2><p className="muted" style={{ marginTop: 6 }}>Open a person to see everything about them in one place: classes, timetable, pay, bank, leave and service book.</p></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" style={{ height: 36, width: 200 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" />
              <div className="seg">{[['', 'All'], ['TEACHING', 'Teaching'], ['NON_TEACHING', 'Office and support'], ['CONTRACT', 'Contract'], ['GUEST', 'Guest']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div></div></div>
          {!list.data ? <Empty>Loading…</Empty> : !rows.length ? <Empty>Nobody here.</Empty> : <div className="scroll-x"><table className="table">
            <thead><tr><th>Name</th><th>Employment</th><th>Joined</th><th>Pay</th><th>Bank</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.user_id} className="click" onClick={() => nav(`/staff/${r.user_id}`)}>
              <td><span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="avatar">{initials(r.name)}</span><span><b>{r.name}</b><span className="tiny muted" style={{ display: 'block' }}>{r.designation ?? '—'} · {r.nes_staff_id}</span></span></span></td>
              <td><Emp e={r.employment} />{r.contract_until && <span className="tiny muted" style={{ display: 'block' }}>until {day(r.contract_until)}</span>}</td>
              <td className="small">{day(r.joined_service)}</td>
              <td className="small">{r.structure ?? <span className="muted">—</span>}</td>
              <td>{r.bank === 'VERIFIED' ? <span className="pill green">Verified</span> : r.bank === 'PENDING' ? <span className="pill orange">To verify</span> : r.bank === null && r.structure !== null ? <span className="pill red">None</span> : ''}</td></tr>)}</tbody></table></div>}
        </section>
      </main>
      {add && <AddStaff schoolId={schoolId} existing={notOnRecord} onClose={(id) => { setAdd(false); list.reload(); if (id) nav(`/staff/${id}`); }} />}
    </>
  );
}

// ── Add a member of staff: one form, every module ──────────────────────────────────────────

function AddStaff({ schoolId, existing, onClose }: { schoolId: string; existing: any[]; onClose: (id?: string) => void }) {
  const o = useLoad<any>(`/schools/${schoolId}/staff-records/form`, [schoolId]);
  const opt = o.data;
  const [f, setF] = useState<any>({ userId: '', name: '', gender: 'F', category: 'TEACHING', employment: 'PERMANENT', joinedService: today(), contractUntil: '', probationUntil: '', orderRef: '',
    phone: '', email: '', dob: '', bloodGroup: '', emergencyContact: '', title: '', postId: '', teaches: [] as { sectionId: string; subjectCode: string; label: string; subject: string }[],
    classTeacher: '', duties: [] as string[], structureId: '', scaleId: '', step: '1', base: '', account: '', ifsc: '', bankName: '', pan: '', aadhaar: '', uan: '' });
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const { run, busy } = useAction();
  const [pick, setPick] = useState({ sectionId: '', subjectCode: '' });
  const post = opt?.posts.find((p: any) => p.id === f.postId);
  const scale = opt?.scales.find((s: any) => s.id === f.scaleId);
  useEffect(() => { if (post?.category) set('category', post.category); }, [post?.category]);
  // Pay suggested from the school's records: the same post's pay, or what staff on this kind of employment are paid on. Change it if needed.
  useEffect(() => {
    if (!opt?.canPay) return;
    if (post?.suggest) { set('structureId', post.suggest.structureId); set('scaleId', post.suggest.scaleId ?? ''); return; }
    const lvl = post?.pay_level ? opt.scales.find((x: any) => new RegExp(`level ${post.pay_level}\\b`, 'i').test(x.name)) : null;
    const st = opt.byEmployment[f.employment];
    if (st) set('structureId', st);
    if (lvl) set('scaleId', lvl.id);
  }, [post?.id, f.employment, opt?.canPay]); // eslint-disable-line react-hooks/exhaustive-deps
  const teaching = f.category === 'TEACHING';
  const term = ['CONTRACT', 'TEMPORARY'].includes(f.employment);
  const ok = (f.userId || f.name.trim().length >= 3) && f.joinedService && f.orderRef.trim().length >= 2 && (!term || f.contractUntil);
  const addTeach = () => {
    const s = opt.sections.find((x: any) => x.id === pick.sectionId), sj = opt.subjects.find((x: any) => x.code === pick.subjectCode);
    if (!s || !sj || f.teaches.some((t: any) => t.sectionId === s.id && t.subjectCode === sj.code)) return;
    set('teaches', [...f.teaches, { sectionId: s.id, subjectCode: sj.code, label: s.label, subject: sj.name }]); setPick({ sectionId: pick.sectionId, subjectCode: '' });
  };
  const secPick = opt?.sections.find((x: any) => x.id === pick.sectionId);
  const submit = async () => {
    const body: any = {
      ...(f.userId ? { userId: f.userId } : { name: f.name }), category: f.category, employment: f.employment, gender: f.gender, joinedService: f.joinedService,
      contractUntil: term ? f.contractUntil : null, probationUntil: f.employment === 'PERMANENT' && f.probationUntil ? f.probationUntil : null, orderRef: f.orderRef,
      phone: f.phone || null, email: f.email || null, dob: f.dob || null, bloodGroup: f.bloodGroup || null, emergencyContact: f.emergencyContact || null, title: f.title || undefined,
      postId: f.postId || null, teaches: teaching ? f.teaches.map((t: any) => ({ sectionId: t.sectionId, subjectCode: t.subjectCode })) : [],
      classTeacherOf: teaching && f.classTeacher ? { sectionId: f.classTeacher.split(':')[0], kind: f.classTeacher.split(':')[1] } : null, duties: f.duties,
    };
    if (opt.canPay && f.structureId) body.pay = { structureId: f.structureId, scaleId: f.scaleId || null, step: f.scaleId ? Number(f.step) : null, basePaise: !f.scaleId && f.base ? Math.round(Number(f.base) * 100) : null };
    if (opt.canPay && f.account) body.bank = { account: f.account, ifsc: f.ifsc, bankName: f.bankName };
    if (opt.canPay && (f.pan || f.aadhaar || f.uan)) body.identity = { pan: f.pan || undefined, aadhaar: f.aadhaar || undefined, uan: f.uan || null };
    const r = await run(() => api<{ userId: string; nesStaffId: string; missing: string[] }>(`/schools/${schoolId}/staff-records`, { body }),
      'Added. Sign-in, ID card, timetable, payroll, leave and chat are set up.');
    if (r) onClose(r.userId);
  };
  return (
    <Drawer title="Add a member of staff" onClose={() => onClose()}>
      {!opt ? <Empty>{o.error ?? 'Loading…'}</Empty> : <div className="stack">
        <p className="small muted">Fill in what you have; only the first part is required. Everything else in NavShiksha (timetable, marks, report cards, ID card, payroll, leave, chat) is set up from this one form, and nothing needs entering again.</p>

        <section className="tile tight stack">
          <h4 style={{ margin: 0 }}>1 · The person</h4>
          {existing.length > 0 && <label className="field"><span>Already signs in here?</span><select className="input" value={f.userId} onChange={(e) => set('userId', e.target.value)}>
            <option value="">No, someone new</option>{existing.map((x) => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</select></label>}
          {!f.userId && <label className="field"><span>Full name</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Mrs Anita Deshpande" /></label>}
          <div className="form-grid">
            <label className="field"><span>Mobile (signs in with it)</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98201 55443" /></label>
            <label className="field"><span>Email</span><input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
            <label className="field"><span>Gender</span><select className="input" value={f.gender} onChange={(e) => set('gender', e.target.value)}><option value="F">Female</option><option value="M">Male</option><option value="X">Other</option></select></label>
            <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(e) => set('dob', e.target.value)} /></label>
            <label className="field"><span>Blood group</span><select className="input" value={f.bloodGroup} onChange={(e) => set('bloodGroup', e.target.value)}><option value="">—</option>{BLOOD.map((b) => <option key={b}>{b}</option>)}</select></label>
            <label className="field"><span>Emergency contact</span><input className="input" value={f.emergencyContact} onChange={(e) => set('emergencyContact', e.target.value)} placeholder="Husband, 98201 55444" /></label>
          </div>
        </section>

        <section className="tile tight stack">
          <h4 style={{ margin: 0 }}>2 · Appointment</h4>
          <div className="form-grid">
            <label className="field"><span>Employment</span><select className="input" value={f.employment} onChange={(e) => set('employment', e.target.value)}>{Object.entries(opt.employment).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="field"><span>Joined on</span><input className="input" type="date" value={f.joinedService} onChange={(e) => set('joinedService', e.target.value)} /></label>
            {term && <label className="field"><span>Term ends</span><input className="input" type="date" value={f.contractUntil} onChange={(e) => set('contractUntil', e.target.value)} /></label>}
            {f.employment === 'PERMANENT' && <label className="field"><span>Probation until (if any)</span><input className="input" type="date" value={f.probationUntil} onChange={(e) => set('probationUntil', e.target.value)} /></label>}
            <label className="field"><span>Appointment order no.</span><input className="input" value={f.orderRef} onChange={(e) => set('orderRef', e.target.value)} placeholder="NCS-MB/EST/2026/14" /></label>
          </div>
          <label className="field"><span>Sanctioned post</span><select className="input" value={f.postId} onChange={(e) => set('postId', e.target.value)}>
            <option value="">{opt.posts.length ? 'Not against a post (guest, daily wage…)' : 'No vacant posts'}</option>
            {opt.posts.map((p: any) => <option key={p.id} value={p.id}>{p.post}{p.subject ? ` · ${p.subject}` : ''}{p.pay_level ? ` · level ${p.pay_level}` : ''}</option>)}</select></label>
          {(!f.postId || post?.category === 'NON_TEACHING') && <div className="form-grid">
            {!f.postId && <label className="field"><span>Teaching or other</span><select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}><option value="TEACHING">Teaching</option><option value="NON_TEACHING">Office or support</option></select></label>}
            <label className="field"><span>Title (shown on the ID card)</span><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={f.category === 'TEACHING' ? 'Guest teacher, Music' : 'Gardener'} /></label></div>}
          <p className="tiny muted">The designation is worked out from the post, the subject taught and the class, e.g. “TGT Science, class teacher X-B”. It updates by itself when any of these change.</p>
        </section>

        {teaching && <section className="tile tight stack">
          <h4 style={{ margin: 0 }}>3 · Classes and subjects</h4>
          <p className="tiny muted">The timetable, marks sheets, report cards and cover all follow this list. Lessons with no teacher in the timetable now in force are given to them at once.</p>
          <div className="form-grid">
            <label className="field"><span>Class</span><select className="input" value={pick.sectionId} onChange={(e) => setPick({ sectionId: e.target.value, subjectCode: '' })}>
              <option value="">Choose a class</option>{opt.sections.map((s: any) => <option key={s.id} value={s.id}>{s.label}{s.load.some((l: any) => !l.teacher) ? ' · needs a teacher' : ''}</option>)}</select></label>
            <label className="field"><span>Subject</span><select className="input" value={pick.subjectCode} onChange={(e) => setPick({ ...pick, subjectCode: e.target.value })} disabled={!pick.sectionId}>
              <option value="">Choose a subject</option>
              {secPick && secPick.load.map((l: any) => <option key={l.subject_code} value={l.subject_code}>{l.subject} · {l.teacher ? `now ${l.teacher}` : 'no teacher'}</option>)}
              {secPick && opt.subjects.filter((x: any) => !secPick.load.some((l: any) => l.subject_code === x.code)).map((x: any) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>
          </div>
          <div><button className="btn quiet small" disabled={!pick.sectionId || !pick.subjectCode} onClick={addTeach}>Add</button></div>
          {f.teaches.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{f.teaches.map((t: any, i: number) => <span key={i} className="pill blue">{t.label} {t.subject}
            <button className="linkbtn tiny" aria-label="Remove" onClick={() => set('teaches', f.teaches.filter((_: any, j: number) => j !== i))}>✕</button></span>)}</div>}
          <label className="field"><span>Class teacher of</span><select className="input" value={f.classTeacher} onChange={(e) => set('classTeacher', e.target.value)}>
            <option value="">None</option>
            {opt.sections.filter((s: any) => !s.class_teacher).map((s: any) => <option key={`${s.id}c`} value={`${s.id}:CLASS`}>Class teacher of {s.label}</option>)}
            {opt.sections.filter((s: any) => !s.co_class_teacher).map((s: any) => <option key={`${s.id}o`} value={`${s.id}:CO`}>Co-class teacher of {s.label}</option>)}</select></label>
        </section>}

        <section className="tile tight stack">
          <h4 style={{ margin: 0 }}>{teaching ? 4 : 3} · Duties</h4>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{Object.entries(opt.duties).map(([k, d]: [string, any]) => <label key={k} className="check small">
            <input type="checkbox" checked={f.duties.includes(k)} onChange={(e) => set('duties', e.target.checked ? [...f.duties, k] : f.duties.filter((x: string) => x !== k))} />{d.label}</label>)}</div>
        </section>

        {opt.canPay ? <section className="tile tight stack">
          <h4 style={{ margin: 0 }}>{teaching ? 5 : 4} · Pay, bank and identity</h4>
          <div className="form-grid">
            <label className="field"><span>Pay structure{post?.suggest || opt.byEmployment[f.employment] ? ' (suggested)' : ''}</span><select className="input" value={f.structureId} onChange={(e) => set('structureId', e.target.value)}>
              <option value="">Later</option>{opt.structures.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            {f.structureId && opt.structures.find((s: any) => s.id === f.structureId)?.has_base && <>
              <label className="field"><span>Pay scale</span><select className="input" value={f.scaleId} onChange={(e) => set('scaleId', e.target.value)}>
                <option value="">A fixed amount</option>{opt.scales.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              {f.scaleId ? <label className="field"><span>Step</span><select className="input" value={f.step} onChange={(e) => set('step', e.target.value)}>
                {scale?.steps_paise.map((p: number, i: number) => <option key={i} value={i + 1}>Step {i + 1} · {money(p)}</option>)}</select></label>
                : <label className="field"><span>Amount a month (₹)</span><input className="input" inputMode="numeric" value={f.base} onChange={(e) => set('base', e.target.value.replace(/\D/g, ''))} /></label>}</>}
          </div>
          <div className="form-grid">
            <label className="field"><span>Salary account no.</span><input className="input" inputMode="numeric" value={f.account} onChange={(e) => set('account', e.target.value.replace(/\D/g, ''))} /></label>
            <label className="field"><span>IFSC</span><input className="input mono" value={f.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} placeholder="SBIN0000534" /></label>
            <label className="field"><span>Bank and branch</span><input className="input" value={f.bankName} onChange={(e) => set('bankName', e.target.value)} /></label>
          </div>
          {f.account && <p className="tiny muted">Someone other than you verifies the account against a cancelled cheque before salary goes to it.</p>}
          <div className="form-grid">
            <label className="field"><span>PAN</span><input className="input mono" value={f.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} maxLength={10} /></label>
            <label className="field"><span>Aadhaar</span><input className="input mono" inputMode="numeric" value={f.aadhaar} onChange={(e) => set('aadhaar', e.target.value.replace(/\D/g, ''))} maxLength={12} /></label>
            <label className="field"><span>UAN (PF)</span><input className="input mono" inputMode="numeric" value={f.uan} onChange={(e) => set('uan', e.target.value.replace(/\D/g, ''))} maxLength={12} /></label>
          </div>
          <p className="tiny muted">PAN, Aadhaar and account numbers are stored encrypted; only the last four digits are shown, and every full view is recorded.</p>
        </section> : <p className="callout small">Pay, bank and identity numbers are added by the accountant on the person’s record; they are told when you save.</p>}

        <button className="btn big" disabled={busy || !ok} onClick={submit}>Add to the staff</button>
      </div>}
    </Drawer>
  );
}

// ── One person, everything in one place ────────────────────────────────────────────────────

export function StaffProfile({ user }: { user: User }) {
  const { id } = useParams();
  const d = useLoad<any>(`/staff/${id}`, [id]);
  const [edit, setEdit] = useState(false);
  const [event, setEvent] = useState(false);
  const [bank, setBank] = useState(false);
  const [teach, setTeach] = useState(false);
  const { run } = useAction();
  const p = d.data;
  if (!p) return d.error ? <FailedPage error={d.error} /> : <main className="page"><Empty>Loading…</Empty></main>;
  const e = p.employee;
  const manage = allowed(user, 'staff.manage', e.school_id);
  const payPerson = allowed(user, 'pay.prepare', e.school_id);
  const curPay = (p.pay ?? []).find((x: any) => !x.to || x.to > today());
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/staff" className="linkbtn small">‹ Staff</Link><span className="localnav-title">{p.user.name}</span><Emp e={e.employment} />
        {e.separated_on && <span className="pill red">Left {day(e.separated_on)}</span>}<span className="spacer" style={{ flex: 1 }} />
        {!manage && <ReportRecord entityType="STAFF" entityId={p.user.id} label={p.user.name} />}
        {manage && <button className="btn quiet small" onClick={() => setEdit(true)}>Correct details</button>}
        {manage && <button className="btn small" onClick={() => setEvent(true)}>Add to service book</button>}</div></div>
      <main className="page">
        <section className="tile">
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="avatar" style={{ width: 56, height: 56, fontSize: '1.2rem' }}>{initials(p.user.name)}</span>
            <div style={{ flex: 1, minWidth: 220 }}><h2 style={{ margin: 0 }}>{p.user.designation ?? '—'}</h2>
              <p className="small muted" style={{ marginTop: 4 }}>{e.nes_staff_id}{e.employee_no ? ` · school no. ${e.employee_no}` : ''} · {e.school} · joined {day(e.joined_service)}{e.contract_until ? ` · term ends ${day(e.contract_until)}` : ''}</p></div>
          </div>
          <div className="form-grid small" style={{ marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            {[['Mobile', e.phone], ['Email', e.email], ['Date of birth', e.dob ? day(e.dob) : null], ['Blood group', e.blood_group], ['Emergency contact', e.emergency_contact],
              ['PAN', e.pan_last4 ? e.pan : null], ['UAN', e.uan], ['Retires', e.retirement_on ? day(e.retirement_on) : null]].map(([k, v]) => <div key={k as string}><div className="tiny muted">{k}</div><div>{v ?? '—'}</div></div>)}
          </div>
          {p.missing.length > 0 && !e.separated_on && <div className="callout orange small" style={{ marginTop: 14 }}><b>Still to fill in:</b> {p.missing.join(' · ')}</div>}
        </section>

        {e.category === 'TEACHING' && <section className="tile">
          <div className="tile-head"><h3>Teaching</h3>{manage && !e.separated_on && <button className="btn quiet small" onClick={() => setTeach(true)}>Change classes</button>}</div>
          {p.classTeacher.map((c: any) => <p key={c.id} className="small"><b>{c.kind === 'CLASS' ? 'Class teacher' : 'Co-class teacher'} of {c.section}</b> from {day(c.from)}</p>)}
          {!p.teaching.length ? <Empty>No classes yet.</Empty> : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {p.teaching.map((t: any) => <span key={`${t.section_id}${t.subject_code}`} className="pill blue">{t.class_code}-{t.section} {t.subject} · {t.periods_per_week}/week</span>)}</div>}
          {(user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN') && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Link className="btn quiet small" to="/timetable">Timetable</Link><Link className="btn quiet small" to="/marks">Marks and report cards</Link>
            {p.classTeacher[0] && <Link className="btn quiet small" to="/attendance">Class attendance</Link>}<Link className="btn quiet small" to="/cards">ID card</Link></div>}
        </section>}

        {p.pay !== null && <section className="tile">
          <div className="tile-head"><h3>Pay</h3>{allowed(user, 'pay.view', e.school_id) && <Link className="btn quiet small" to="/payroll">Payroll</Link>}</div>
          {curPay ? <p><b>{curPay.structure}</b> · {curPay.scale ? `${curPay.scale}, step ${curPay.step} (${money(curPay.step_paise)})` : curPay.base_paise ? money(curPay.base_paise) : 'paid by the period or day'} · from {day(curPay.from)}</p> : <Empty>No pay fixed yet.</Empty>}
          {(p.pay ?? []).length > 1 && <details className="small"><summary>Earlier pay</summary>{p.pay.slice(1).map((x: any) => <div key={x.id}>{x.structure} · {x.scale ? `step ${x.step}` : money(x.base_paise ?? 0)} · {day(x.from)} to {x.to ? day(x.to) : '—'}</div>)}</details>}
          <h4 style={{ margin: '14px 0 4px' }}>Salary account</h4>
          {(p.bank ?? []).length ? (p.bank ?? []).slice(0, 2).map((b: any) => <p key={b.id} className="small">{b.bank_name} · ····{b.account_last4} · {b.ifsc} · <span className={`pill ${b.status === 'VERIFIED' ? 'green' : b.status === 'PENDING' ? 'orange' : 'red'}`}>{b.status === 'PENDING' ? 'To verify' : b.status === 'VERIFIED' ? 'Verified' : 'Rejected'}</span>
            <span className="tiny muted"> entered by {b.requested_by}{b.verified_by ? `, checked by ${b.verified_by}` : ''}</span></p>) : <p className="small muted">None yet.</p>}
          {payPerson && !e.separated_on && <button className="btn quiet small" onClick={() => setBank(true)}>New salary account</button>}
          {payPerson && <button className="btn quiet small" style={{ marginLeft: 8 }} onClick={() => run(() => openPdf(`/staff/${id}/form16/${fyNow()}`))}>Form 16 ({fyNow()})</button>}
          {payPerson && e.separated_on && <button className="btn small" style={{ marginLeft: 8 }} onClick={() => run(() => api(`/staff/${id}/final-settlement`, { body: {} }), 'Final settlement worked out; open it under Payroll')}>Work out final settlement</button>}
        </section>}

        <section className="tile">
          <h3>Leave</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>{(p.leave ?? []).filter((b: any) => b.balance > 0 || ['CL', 'EL'].includes(b.code)).map((b: any) => <span key={b.code} className="pill">{b.name}: <b>{b.balance}</b></span>)}</div>
          {p.duties.length > 0 && <p className="small" style={{ marginTop: 10 }}>Duties: {p.duties.map((x: any) => x.code.replaceAll('_', ' ').toLowerCase()).join(', ')}</p>}
        </section>

        <section className="tile">
          <h3>Service book</h3>
          <p className="small muted">Nothing is edited; a mistake is corrected by a new entry.</p>
          {p.service.map((s: any) => <div key={s.id} className="list-row" style={{ gridTemplateColumns: '110px 1fr' }}><span className="small">{day(s.on_date)}</span>
            <span><b className="small">{EVENT[s.kind] ?? s.kind}</b> <span className="small">{s.summary}</span><span className="tiny muted" style={{ display: 'block' }}>{s.order_ref ? `${s.order_ref} · ` : ''}{s.school} · recorded by {s.recorded_by}</span></span></div>)}
        </section>
      </main>
      {edit && <EditDetails p={p} onClose={() => { setEdit(false); d.reload(); }} />}
      {event && <EventDrawer id={id!} e={e} onClose={() => { setEvent(false); d.reload(); }} />}
      {bank && <BankDrawer id={id!} name={p.user.name} onClose={() => { setBank(false); d.reload(); }} />}
      {teach && <TeachDrawer id={id!} schoolId={p.user.schoolId} current={p.teaching} onClose={() => { setTeach(false); d.reload(); }} />}
    </>
  );
}

function EditDetails({ p, onClose }: { p: any; onClose: () => void }) {
  const e = p.employee;
  const [f, setF] = useState({ name: p.user.name, phone: e.phone?.replace('+91', '') ?? '', email: e.email ?? '', dob: e.dob ?? '', bloodGroup: e.blood_group ?? '', emergencyContact: e.emergency_contact ?? '', title: e.title ?? '', employeeNo: e.employee_no ?? '', uan: e.uan ?? '' });
  const { run, busy } = useAction();
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <Drawer title="Correct details" onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">Corrected here, corrected everywhere: ID card, chat, payslips and service book read from this record.</p>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(x) => set('name', x.target.value)} /></label>
        <div className="form-grid">
          <label className="field"><span>Mobile</span><input className="input" value={f.phone} onChange={(x) => set('phone', x.target.value)} /></label>
          <label className="field"><span>Email</span><input className="input" value={f.email} onChange={(x) => set('email', x.target.value)} /></label>
          <label className="field"><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={(x) => set('dob', x.target.value)} /></label>
          <label className="field"><span>Blood group</span><select className="input" value={f.bloodGroup} onChange={(x) => set('bloodGroup', x.target.value)}><option value="">—</option>{BLOOD.map((b) => <option key={b}>{b}</option>)}</select></label>
          <label className="field"><span>Emergency contact</span><input className="input" value={f.emergencyContact} onChange={(x) => set('emergencyContact', x.target.value)} /></label>
          <label className="field"><span>Title (if no teaching post)</span><input className="input" value={f.title} onChange={(x) => set('title', x.target.value)} /></label>
          <label className="field"><span>School staff no.</span><input className="input" value={f.employeeNo} onChange={(x) => set('employeeNo', x.target.value)} /></label>
          <label className="field"><span>UAN</span><input className="input" value={f.uan} onChange={(x) => set('uan', x.target.value.replace(/\D/g, ''))} /></label>
        </div>
        <button className="btn" disabled={busy} onClick={async () => {
          if (await run(() => api(`/staff/${p.user.id}`, { method: 'PUT', body: { name: f.name, phone: f.phone || null, email: f.email || null, dob: f.dob || null, bloodGroup: f.bloodGroup || null,
            emergencyContact: f.emergencyContact || null, title: f.title || null, employeeNo: f.employeeNo || null, ...(f.uan ? { uan: f.uan } : {}) } }), 'Saved')) onClose();
        }}>Save</button>
      </section>
    </Drawer>
  );
}

function EventDrawer({ id, e, onClose }: { id: string; e: any; onClose: () => void }) {
  const { schools } = useSchoolsLite();
  const [f, setF] = useState({ kind: 'NOTE', onDate: today(), summary: '', orderRef: '', contractUntil: '', toSchoolId: '', reason: '' });
  const { run, busy } = useAction();
  const kinds = ['NOTE', 'TRAINING', 'AWARD', 'CONFIRMED', 'CONTRACT_RENEWED', 'MADE_PERMANENT', 'PROMOTION', 'PENALTY', 'TRANSFER', 'SEPARATION'].filter((k) =>
    (k !== 'CONFIRMED' || e.employment === 'PERMANENT') && (k !== 'CONTRACT_RENEWED' || ['CONTRACT', 'TEMPORARY'].includes(e.employment)) && (k !== 'MADE_PERMANENT' || e.employment !== 'PERMANENT'));
  return (
    <Drawer title="Add to the service book" onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Entry</span><select className="input" value={f.kind} onChange={(x) => setF({ ...f, kind: x.target.value })}>{kinds.map((k) => <option key={k} value={k}>{EVENT[k]}</option>)}</select></label>
          <label className="field"><span>Date</span><input className="input" type="date" value={f.onDate} onChange={(x) => setF({ ...f, onDate: x.target.value })} /></label>
          <label className="field"><span>Order no.</span><input className="input" value={f.orderRef} onChange={(x) => setF({ ...f, orderRef: x.target.value })} /></label>
          {f.kind === 'CONTRACT_RENEWED' && <label className="field"><span>New term ends</span><input className="input" type="date" value={f.contractUntil} onChange={(x) => setF({ ...f, contractUntil: x.target.value })} /></label>}
          {f.kind === 'TRANSFER' && <label className="field"><span>To school</span><select className="input" value={f.toSchoolId} onChange={(x) => setF({ ...f, toSchoolId: x.target.value })}>
            <option value="">Choose</option>{schools.filter((s) => s.id !== e.school_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          {f.kind === 'SEPARATION' && <label className="field"><span>Reason</span><select className="input" value={f.reason} onChange={(x) => setF({ ...f, reason: x.target.value })}>
            <option value="">Choose</option>{['Retired on superannuation', 'Resigned', 'Contract ended', 'Voluntary retirement', 'Dismissed', 'Died in service'].map((r) => <option key={r}>{r}</option>)}</select></label>}
        </div>
        <label className="field"><span>What happened</span><textarea className="input" rows={3} value={f.summary} onChange={(x) => setF({ ...f, summary: x.target.value })} /></label>
        {['TRANSFER', 'SEPARATION'].includes(f.kind) && <div className="callout orange small">From that day their class-teacher role ends, their classes are marked as needing a teacher and their lessons are covered day by day until the timetable is re-published. The principal is told. They keep their sign-in for payslips only.</div>}
        <button className="btn" disabled={busy || f.summary.trim().length < 3} onClick={async () => {
          if (await run(() => api(`/staff/${id}/events`, { body: { kind: f.kind, onDate: f.onDate, summary: f.summary, orderRef: f.orderRef || null, contractUntil: f.contractUntil || null, toSchoolId: f.toSchoolId || null, reason: f.reason || null } }), 'Recorded')) onClose();
        }}>Record</button>
      </section>
    </Drawer>
  );
}

function useSchoolsLite() {
  const { data } = useLoad<any[]>('/org/tree');
  return { schools: (data ?? []).filter((u) => u.kind === 'school' && u.active) as { id: string; name: string }[] };
}

function BankDrawer({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [f, setF] = useState({ account: '', ifsc: '', bankName: '', holderName: name.replace(/^(Mr|Mrs|Ms|Dr) /, '') });
  const { run, busy } = useAction();
  return (
    <Drawer title="New salary account" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Account number</span><input className="input" inputMode="numeric" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value.replace(/\D/g, '') })} /></label>
        <div className="form-grid">
          <label className="field"><span>IFSC</span><input className="input mono" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Bank and branch</span><input className="input" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} /></label></div>
        <label className="field"><span>In the name of</span><input className="input" value={f.holderName} onChange={(e) => setF({ ...f, holderName: e.target.value })} /></label>
        <p className="tiny muted">The person is told at once. Someone else verifies it against a cancelled cheque; salary goes to it after the waiting period.</p>
        <button className="btn" disabled={busy || f.account.length < 9 || f.ifsc.length !== 11} onClick={async () => { if (await run(() => api(`/staff/${id}/bank`, { body: f }), 'Sent for verification')) onClose(); }}>Send for verification</button>
      </section>
    </Drawer>
  );
}

function TeachDrawer({ id, schoolId, current, onClose }: { id: string; schoolId: string; current: any[]; onClose: () => void }) {
  const o = useLoad<any>(`/schools/${schoolId}/staff-records/form`, [schoolId]);
  const [rows, setRows] = useState(current.map((t) => ({ sectionId: t.section_id, subjectCode: t.subject_code, label: `${t.class_code}-${t.section}`, subject: t.subject, periodsPerWeek: t.periods_per_week })));
  const [pick, setPick] = useState({ sectionId: '', subjectCode: '' });
  const { run, busy } = useAction();
  const sec = o.data?.sections.find((s: any) => s.id === pick.sectionId);
  return (
    <Drawer title="Classes and subjects" onClose={onClose}>
      {!o.data ? <Empty>Loading…</Empty> : <section className="tile tight stack">
        <p className="small muted">Adds to what they teach; the timetable generator, marks sheets and cover follow. To take a class away, give it to another teacher from their record or in the timetable.</p>
        <div className="form-grid">
          <label className="field"><span>Class</span><select className="input" value={pick.sectionId} onChange={(e) => setPick({ sectionId: e.target.value, subjectCode: '' })}><option value="">Choose</option>{o.data.sections.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <label className="field"><span>Subject</span><select className="input" value={pick.subjectCode} onChange={(e) => setPick({ ...pick, subjectCode: e.target.value })} disabled={!sec}><option value="">Choose</option>
            {sec?.load.map((l: any) => <option key={l.subject_code} value={l.subject_code}>{l.subject} · {l.teacher ?? 'no teacher'}</option>)}
            {sec && o.data.subjects.filter((x: any) => !sec.load.some((l: any) => l.subject_code === x.code)).map((x: any) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label></div>
        <div><button className="btn quiet small" disabled={!sec || !pick.subjectCode} onClick={() => { const sj = o.data.subjects.find((x: any) => x.code === pick.subjectCode); setRows([...rows.filter((r) => !(r.sectionId === sec.id && r.subjectCode === sj.code)), { sectionId: sec.id, subjectCode: sj.code, label: sec.label, subject: sj.name, periodsPerWeek: sec.load.find((l: any) => l.subject_code === sj.code)?.periods ?? 6 }]); }}>Add</button></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{rows.map((r, i) => <span key={i} className="pill blue">{r.label} {r.subject}</span>)}</div>
        <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api<{ lessonsFilled: number }>(`/staff/${id}/teaching`, { method: 'PUT', body: { schoolId, rows: rows.map((x) => ({ sectionId: x.sectionId, subjectCode: x.subjectCode, periodsPerWeek: x.periodsPerWeek })) } }));
          if (r) onClose(); }}>Save</button>
      </section>}
    </Drawer>
  );
}

// ── Staff register and staff leave (principal and office) ──────────────────────────────────

export function StaffRegister({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  // Everyone with staff records looks; the office keeping the service books marks the register.
  const mark = allowed(user, 'staff.manage', schoolId);
  const [date, setDate] = useState(today());
  const d = useLoad<any>(schoolId ? `/schools/${schoolId}/staff-register?date=${date}` : null, [schoolId, date]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  useEffect(() => { if (d.data) setMarks(Object.fromEntries(d.data.staff.map((s: any) => [s.user_id, s.status ?? 'P']))); }, [d.data]);
  const { run, busy } = useAction();
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/staff" className="linkbtn small">‹ Staff</Link><span className="localnav-title">Staff register</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <input className="input" type="date" style={{ height: 36, width: 'auto' }} max={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></div></div>
      <main className="page">
        <section className="tile">
          {!d.data ? <Empty>Loading…</Empty> : <>
            {d.data.holiday && <div className="callout blue small">A holiday or Sunday. Mark only those who were on duty.</div>}
            <p className="small muted">Leave already sanctioned shows by itself. Absence without leave becomes loss of pay in the payroll; days present pay daily-wage staff.</p>
            {d.data.staff.map((s: any) => <div key={s.user_id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span><b>{s.name}</b> <span className="tiny muted">{s.designation}</span></span>
              {s.source === 'LEAVE' ? <span className="pill blue">On leave</span> : <div className="seg">{[['P', 'Present'], ['H', 'Half day'], ['A', 'Absent'], ['D', 'On duty out']].map(([k, l]) => <button key={k} disabled={!mark} className={marks[s.user_id] === k ? 'on' : ''} onClick={() => setMarks({ ...marks, [s.user_id]: k })}>{l}</button>)}</div>}</div>)}
            {mark && <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={async () => {
              const entries = d.data.staff.filter((s: any) => s.source !== 'LEAVE').map((s: any) => ({ userId: s.user_id, status: marks[s.user_id] ?? 'P' }));
              if (await run(() => api(`/schools/${schoolId}/staff-register`, { method: 'PUT', body: { date, entries } }), 'Register saved')) d.reload();
            }}>Save the register</button>}</>}
        </section>
      </main>
    </>
  );
}

export function StaffLeaveDesk({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const d = useLoad<any[]>(schoolId ? `/schools/${schoolId}/staff-leave` : null, [schoolId]);
  const { run, busy } = useAction();
  const [note, setNote] = useState<Record<string, string>>({});
  const principal = user.role === 'SCHOOL_ADMIN';
  const pending = (d.data ?? []).filter((r) => r.status === 'PENDING'), rest = (d.data ?? []).filter((r) => r.status !== 'PENDING');
  return (
    <>
      <div className="localnav"><div className="localnav-in"><Link to="/staff" className="linkbtn small">‹ Staff</Link><span className="localnav-title">Staff leave</span><span className="spacer" style={{ flex: 1 }} />{picker}</div></div>
      <main className="page">
        <section className="tile">
          <h3>Waiting for the principal</h3>
          <p className="small muted">Sanctioned leave comes off the balance, marks the register and, for a teacher, arranges cover for their lessons.</p>
          {!pending.length ? <Empty>Nothing waiting.</Empty> : pending.map((r) => <div key={r.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{r.name}</b> <span className="small">{r.leave} · {day(r.from)}{r.to !== r.from ? ` to ${day(r.to)}` : ''} · {r.days} day{r.days === 1 ? '' : 's'}</span>
              <span className="tiny muted" style={{ display: 'block' }}>{r.reason} · balance {r.balance}</span></span>
            {principal && r.user_id !== user.id ? <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input className="input" style={{ height: 34, width: 150 }} placeholder="Reason, if refusing" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
              <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/staff-leave/${r.id}/decide`, { body: { approve: true } }), 'Sanctioned')) d.reload(); }}>Sanction</button>
              <button className="btn quiet small" disabled={busy || (note[r.id] ?? '').trim().length < 3} onClick={async () => { if (await run(() => api(`/staff-leave/${r.id}/decide`, { body: { approve: false, note: note[r.id] } }), 'Refused')) d.reload(); }}>Refuse</button></span>
              : <span className="tiny muted">{r.user_id === user.id ? 'Your own leave goes to someone else.' : 'The principal decides.'}</span>}</div>)}
        </section>
        <section className="tile"><h3>Recent</h3>
          {rest.slice(0, 40).map((r) => <div key={r.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span className="small"><b>{r.name}</b> · {r.leave} · {day(r.from)}{r.to !== r.from ? ` to ${day(r.to)}` : ''}</span>
            <span className={`pill ${r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : ''}`}>{r.status === 'APPROVED' ? 'Sanctioned' : r.status === 'REJECTED' ? 'Refused' : 'Withdrawn'}</span></div>)}</section>
      </main>
    </>
  );
}

// ── My work: payslips, tax, leave, service book (every member of staff) ───────────────────

export function MyWork({ user }: { user: User }) {
  const pay = useLoad<any>('/my/pay');
  const leave = useLoad<any>('/staff-leave/mine');
  const [allLeave, setAllLeave] = useState(false);
  const me = useLoad<any>(`/staff/${user.id}`);
  const [apply, setApply] = useState(false);
  const { run, busy } = useAction();
  const [regime, setRegime] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, string>>({});
  useEffect(() => { if (pay.data) { setRegime(pay.data.declaration.regime); setItems(Object.fromEntries(Object.entries(pay.data.declaration.items ?? {}).map(([k, v]) => [k, String(Number(v) / 100)]))); } }, [pay.data]);
  if (pay.error && leave.error) return <main className="page"><Empty>You have no staff record yet; ask the school office.</Empty></main>;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">My pay and leave</span><span className="spacer" style={{ flex: 1 }} />
        <button className="btn small" onClick={() => setApply(true)}>Apply for leave</button></div></div>
      <main className="page">
        {pay.data && <section className="tile">
          {/* Until the first salary run there is nothing to total: say so instead of showing three zeros. */}
          {pay.data.slips.length || pay.data.ytd.gross ? <div className="kpis">
            <div><div className="kpi-label">Paid this year ({pay.data.fy})</div><div className="kpi-value">{money(pay.data.ytd.gross)}</div></div>
            <div><div className="kpi-label">Income tax deducted</div><div className="kpi-value">{money(pay.data.ytd.tds)}</div></div>
            <div><div className="kpi-label">Provident fund</div><div className="kpi-value">{money(pay.data.ytd.pf)}</div></div>
          </div> : <div><h3>Pay for {pay.data.fy}</h3><p className="muted" style={{ marginTop: 6 }}>Nothing paid through NavShiksha yet this year. Your payslips, tax and provident fund appear here after the first salary run.</p></div>}
          {pay.data.slips.length > 0 && <h3 style={{ marginTop: 18 }}>Payslips</h3>}
          {!pay.data.slips.length ? null : pay.data.slips.map((s: any) => <div key={s.run_id} className="list-row" style={{ gridTemplateColumns: '1fr auto auto' }}>
            <span><b>{s.title}</b><span className="tiny muted" style={{ display: 'block' }}>Gross {money(s.gross)} · deductions {money(s.deductions)}{s.lop_days ? ` · ${s.lop_days} day${s.lop_days === 1 ? '' : 's'} loss of pay` : ''}</span></span>
            <b>{money(s.net)}</b><button className="btn quiet small" onClick={() => run(() => openPdf(`/payroll/${s.run_id}/slips/${user.id}/pdf`))}>PDF</button></div>)}
        </section>}
        {pay.data && <section className="tile stack">
          <h3>Income tax for {pay.data.fy}</h3>
          <div className="seg">{[['NEW', 'New regime'], ['OLD', 'Old regime']].map(([k, l]) => <button key={k} className={regime === k ? 'on' : ''} onClick={() => setRegime(k)}>{l}</button>)}</div>
          {regime === 'OLD' && <div className="form-grid">{[['80C', 'PF, PPF, LIC, ELSS, tuition (80C, up to ₹1.5 lakh)'], ['80D', 'Health insurance (80D)'], ['HRA_EXEMPT', 'HRA exemption'], ['OTHER', 'Other deductions']].map(([k, l]) =>
            <label key={k} className="field"><span>{l}</span><input className="input" inputMode="numeric" value={items[k] ?? ''} onChange={(e) => setItems({ ...items, [k]: e.target.value.replace(/\D/g, '') })} placeholder="₹" /></label>)}</div>}
          <div><button className="btn small" disabled={busy || !regime} onClick={async () => {
            if (await run(() => api('/my/tax-declaration', { method: 'PUT', body: { regime, items: Object.fromEntries(Object.entries(items).filter(([, v]) => v).map(([k, v]) => [k, Number(v) * 100])) } }), 'Saved; next month’s tax is worked out on it')) pay.reload();
          }}>Save</button></div>
          <p className="tiny muted">Tax each month is the year’s tax on your projected pay, less what is already deducted, spread over the months left.</p>
          <div><button className="btn quiet small" onClick={() => run(() => openPdf(`/staff/${user.id}/form16/${pay.data.fy}`))}>Form 16 Part B for {pay.data.fy}</button></div>
        </section>}
        {leave.data && <section className="tile">
          <h3>Leave</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>{leave.data.balances.filter((b: any) => b.balance > 0 || ['CL', 'EL'].includes(b.code)).map((b: any) => <span key={b.code} className="pill">{b.name}: <b>{b.balance}</b></span>)}</div>
          {leave.data.requests.slice(0, allLeave ? undefined : 10).map((r: any) => <div key={r.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span className="small">{r.leave} · {day(r.from)}{r.to !== r.from ? ` to ${day(r.to)}` : ''} · {r.reason}</span>
            <span className={`pill ${r.status === 'APPROVED' ? 'green' : r.status === 'PENDING' ? 'orange' : r.status === 'REJECTED' ? 'red' : ''}`}>{r.status === 'APPROVED' ? 'Sanctioned' : r.status === 'PENDING' ? 'Waiting' : r.status === 'REJECTED' ? 'Refused' : 'Withdrawn'}</span></div>)}
          {leave.data.requests.length > 10 && <button className="linkbtn small" onClick={() => setAllLeave(!allLeave)}>{allLeave ? 'Show fewer' : `Show all ${leave.data.requests.length} requests`}</button>}
        </section>}
        {me.data && <section className="tile">
          <h3>My record</h3>
          <p className="small">{me.data.user.designation} · {me.data.employee.nes_staff_id} · joined {day(me.data.employee.joined_service)}</p>
          {(me.data.bank ?? [])[0] && <p className="small">Salary to {me.data.bank[0].bank_name} ····{me.data.bank[0].account_last4} ({me.data.bank[0].status === 'VERIFIED' ? 'verified' : 'being verified'})</p>}
          <details className="small" style={{ marginTop: 8 }}><summary>Service book</summary>{me.data.service.map((s: any) => <div key={s.id} style={{ padding: '4px 0' }}>{day(s.on_date)} · <b>{EVENT[s.kind] ?? s.kind}</b> · {s.summary}</div>)}</details>
        </section>}
      </main>
      {apply && leave.data && <ApplyLeave balances={leave.data.balances} onClose={() => { setApply(false); leave.reload(); }} />}
    </>
  );
}

function ApplyLeave({ balances, onClose }: { balances: any[]; onClose: () => void }) {
  const [f, setF] = useState({ leaveCode: 'CL', from: today(), to: today(), halfDay: false, reason: '' });
  const { run, busy } = useAction();
  return (
    <Drawer title="Apply for leave" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Leave</span><select className="input" value={f.leaveCode} onChange={(e) => setF({ ...f, leaveCode: e.target.value })}>{balances.map((b) => <option key={b.code} value={b.code}>{b.name}{b.pay !== 'NONE' ? ` · ${b.balance} left` : ''}</option>)}</select></label>
        <div className="form-grid">
          <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></label>
          <label className="field"><span>To</span><input className="input" type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></div>
        {f.from === f.to && <label className="check small"><input type="checkbox" checked={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.checked })} />Half a day</label>}
        <label className="field"><span>Reason</span><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <p className="tiny muted">The principal is told. Once sanctioned, the register is marked and your lessons are covered.</p>
        <button className="btn" disabled={busy || f.reason.trim().length < 3} onClick={async () => { if (await run(() => api('/staff-leave', { body: f }), 'Sent to the principal')) onClose(); }}>Apply</button>
      </section>
    </Drawer>
  );
}

