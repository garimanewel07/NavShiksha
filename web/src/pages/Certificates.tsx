import { useEffect, useState } from 'react';
import { api, day, num, openPdf, saveFile, words, type User, today } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';
import { PRINT_NOTE, PrinterPicker } from './Library';
import { useSchoolSections } from './Cards';

/** Labels for the fields each certificate prints (the TC's come from the server, in CBSE order). */
const LABELS: Record<string, string> = {
  prefix: 'Master / Kumari', name: 'Name', relation: 'son / daughter / ward', relationWord: 'Son / Daughter of', parentLine: 'Parents', father: "Father's / guardian's name",
  dob: 'Date of birth', dobWords: 'Date of birth in words', className: 'Class', year: 'Academic year', admissionNo: 'Admission number', purpose: 'Purpose',
  from: 'Studied from', to: 'Studied to', studying: 'Still studying here (yes / no)', conduct: 'Conduct', firstClass: 'Joined in class',
  fy: 'Financial year', tuition: 'Tuition fee paid', tuitionWords: 'Tuition fee in words', other: 'Other fees paid', total: 'Total paid', totalWords: 'Total in words', breakdown: 'Details',
  yearFrom: 'Academic year from', yearTo: 'Academic year to', place: 'Place', leavingDate: 'Leaving date (YYYY-MM-DD)',
  s1From: '1.1 From', s1To: '1.1 To', s1School: '1.1 School', s1Affiliation: '1.1 Affiliation / Regn code', s1Class: '1.1 Class', s1Roll: '1.1 Roll No', s1Admission: '1.1 Admission / Regn No', s1Board: '1.1 Curriculum',
  s2From: '1.2 From', s2To: '1.2 To', s2School: '1.2 School', s2Affiliation: '1.2 Affiliation / Regn code', s2Class: '1.2 Class', s2Roll: '1.2 Roll No', s2Admission: '1.2 Admission / Regn No', s2Board: '1.2 Curriculum',
  s3From: '1.3 From', s3To: '1.3 To', s3School: '1.3 School', s3Affiliation: '1.3 Affiliation / Regn code', s3Class: '1.3 Class', s3Roll: '1.3 Roll No', s3Admission: '1.3 Admission / Regn No', s3Board: '1.3 Curriculum',
};
const KIND_FIELDS: Record<string, string[]> = {
  BONAFIDE: ['name', 'relation', 'parentLine', 'className', 'year', 'admissionNo', 'dob', 'dobWords', 'purpose'],
  CHARACTER: ['name', 'relation', 'parentLine', 'className', 'from', 'to', 'studying', 'conduct', 'admissionNo', 'purpose'],
  STUDY: ['name', 'relation', 'parentLine', 'firstClass', 'className', 'from', 'to', 'studying', 'admissionNo', 'dob', 'purpose'],
  FEE_PAID: ['name', 'relation', 'parentLine', 'className', 'admissionNo', 'fy', 'tuition', 'tuitionWords', 'other', 'total', 'totalWords', 'breakdown'],
  CEA: ['prefix', 'name', 'relationWord', 'father', 'dob', 'className', 'yearFrom', 'yearTo', 's1From', 's1To', 's1School', 's1Affiliation', 's1Class', 's1Roll', 's1Admission', 's1Board',
    's2From', 's2To', 's2School', 's2Affiliation', 's2Class', 's2Roll', 's2Admission', 's2Board',
    's3From', 's3To', 's3School', 's3Affiliation', 's3Class', 's3Roll', 's3Admission', 's3Board', 'place'],
};
const STATUS: Record<string, [string, string]> = { REQUESTED: ['Requested by parent', 'blue'], DRAFT: ['Draft', ''], PENDING: ['Waiting for approval', 'orange'], ISSUED: ['Issued', 'green'], REJECTED: ['Not issued', 'red'], CANCELLED: ['Cancelled', 'red'] };

export default function Certificates({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<CertFilter>({ period: 'ALL' });
  const qs = filterQuery(filter, status);
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/certificates?${qs}` : null, [schoolId, qs]);
  const [download, setDownload] = useState(false);
  const { data: kinds } = useLoad<Record<string, string>>('/certificates/kinds');
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [newOne, setNewOne] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [printerId, setPrinterId] = useState('');
  const { run, busy } = useAction();
  const toast = useToast();
  const principal = user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN';
  const rows = list.data ?? [];
  const pickedRows = rows.filter((r) => picked.includes(r.id));
  const issuable = pickedRows.filter((r) => r.status === 'DRAFT' && r.kind !== 'TC').map((r) => r.id);
  const printable = pickedRows.filter((r) => ['DRAFT', 'PENDING', 'ISSUED'].includes(r.status)).map((r) => r.id);
  const counts: Record<string, number> = rows.reduce((m: Record<string, number>, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Certificates</span><span className="spacer" />
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
        <button className="btn quiet small" onClick={() => setDownload(true)}>Download</button>
        <button className="btn quiet small" onClick={() => setBulk(true)}>For a whole class</button>
        <button className="btn small" onClick={() => setNewOne(true)}>New certificate</button>
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head">
            <div><h2>Register</h2><p className="muted" style={{ marginTop: 6 }}>Requests from parents, drafts being checked, and every certificate issued, with its serial number. An issued certificate is never edited: cancel it and issue a new one.</p></div>
            <div className="seg">{[['', 'All'], ['REQUESTED', `Requests${counts.REQUESTED ? ` (${counts.REQUESTED})` : ''}`], ['DRAFT', 'Drafts'], ['PENDING', 'Waiting'], ['ISSUED', 'Issued']].map(([k, l]) =>
              <button key={k} className={status === k ? 'on' : ''} onClick={() => { setStatus(k); setPicked([]); }}>{l}</button>)}</div>
          </div>
          <FilterBar schoolId={schoolId} kinds={kinds} value={filter} onChange={(f) => { setFilter(f); setPicked([]); }} />
          {picked.length > 0 && <div className="callout stack small" style={{ marginBottom: 12 }}>
            <strong>{picked.length} chosen</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ minWidth: 240 }}><PrinterPicker schoolId={schoolId} purpose="DOCUMENTS" value={printerId} onChange={setPrinterId} /></div>
              {principal && issuable.length > 0 && <button className="btn small" disabled={busy} onClick={async () => {
                const r: any = await run(() => api(`/schools/${schoolId}/certificates/issue`, { body: { ids: issuable } }));
                if (r) { toast(`${r.issued} issued: ${r.first}${r.issued > 1 ? ` to ${r.last}` : ''}`); list.reload(); }
              }}>Issue {issuable.length}</button>}
              {printable.length > 0 && <button className="btn quiet small" disabled={busy} onClick={async () => {
                if (await run(() => openPdf(`/schools/${schoolId}/certificates/print`, { ids: printable, printerId: printerId || null }))) list.reload();
              }}>Print {printable.length}</button>}
              <button className="linkbtn small" onClick={() => setPicked([])}>Clear</button>
            </div>
            <span className="tiny muted">{PRINT_NOTE} Drafts print marked "Draft - not valid" for checking.</span>
          </div>}
          {!list.data ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No certificates here.</Empty> : (
            <div className="scroll-x"><table className="table">
              <thead><tr><th><input type="checkbox" aria-label="Choose all" checked={picked.length === rows.length && rows.length > 0} onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])} /></th>
                <th>Certificate</th><th>Student</th><th>Serial</th><th>Status</th><th>Asked for</th></tr></thead>
              <tbody>{rows.map((r) => {
                const [label, tone] = STATUS[r.status] ?? [r.status, ''];
                return (
                  <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Choose ${r.student}`} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                    <td style={{ fontWeight: 600 }}>{kinds?.[r.kind]?.replace('Consolidated Certificate from Head of School for Claiming Children Educational Allowance', 'CEA certificate') ?? words(r.kind)}<div className="tiny muted">{r.purpose}</div></td>
                    <td>{r.student}<div className="tiny muted">{r.class} · {r.admission_no}</div></td>
                    <td className="mono small">{r.serial_no ?? ''}{r.copies_printed > 0 ? <div className="tiny muted">printed {r.copies_printed}×</div> : null}</td>
                    <td><span className={`pill ${tone}`}>{label}</span></td>
                    <td className="small">{r.by_parent ? 'Parent' : r.requested_by}<div className="tiny muted">{day(r.created_at)}</div></td>
                  </tr>);
              })}</tbody>
            </table></div>
          )}
        </section>
      </main>
      {open && <CertDrawer id={open} schoolId={schoolId} principal={principal} onClose={() => { setOpen(null); list.reload(); }} />}
      {newOne && kinds && <NewCertificate kinds={kinds} onClose={(id) => { setNewOne(false); list.reload(); if (id) setOpen(id); }} />}
      {download && <DownloadDrawer schoolId={schoolId} kinds={kinds ?? {}} initial={filter} onClose={() => setDownload(false)} />}
      {bulk && <BulkDrawer schoolId={schoolId} onClose={() => { setBulk(false); setStatus('DRAFT'); list.reload(); }} />}
    </>
  );
}

function NewCertificate({ kinds, onClose }: { kinds: Record<string, string>; onClose: (id?: string) => void }) {
  const [q, setQ] = useState('');
  const results = useLoad<any[]>(q.trim().length >= 2 ? `/students?q=${encodeURIComponent(q.trim())}` : null, [q]);
  const [student, setStudent] = useState<any>(null);
  const [f, setF] = useState({ kind: 'BONAFIDE', purpose: '', leavingDate: today(), reason: '', year: '', fy: '' });
  const moving = useLoad<any[]>(student && f.kind === 'TC' ? `/students/${student.id}/transfer-requests` : null, [student?.id, f.kind]);
  const openReq = (moving.data ?? []).find((r) => ['PENDING', 'WAITLISTED', 'ACCEPTED'].includes(r.status));
  const { run, busy } = useAction();
  return (
    <Drawer title="New certificate" onClose={() => onClose()}>
      <section className="tile tight stack">
        {!student ? <>
          <label className="field"><span>Student</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, admission number or NES ID" autoFocus /></label>
          {(results.data ?? []).map((s) => <button key={s.id} className="list-row" style={{ gridTemplateColumns: '1fr', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setStudent(s)}>
            <span><strong>{s.name}</strong> <span className="small muted">· {s.class_code}{s.section ? `-${s.section}` : ''} · {s.admission_no} · {s.school}</span></span></button>)}
        </> : <div className="callout small"><strong>{student.name}</strong> · {student.class_code}{student.section ? `-${student.section}` : ''} · {student.admission_no} <button className="linkbtn small" onClick={() => setStudent(null)}>Change</button></div>}
        <label className="field"><span>Certificate</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(kinds).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        {f.kind === 'TC' ? <div className="form-grid">
          <label className="field"><span>Leaving date</span><input className="input" type="date" value={f.leavingDate} onChange={(e) => setF({ ...f, leavingDate: e.target.value })} /></label>
          <label className="field"><span>Reason for leaving</span><input className="input" value={f.reason} placeholder="For example: father posted to Kochi" onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          {student && <p className="tiny muted" style={{ gridColumn: '1 / -1' }}>{openReq
            ? <>Going to <strong>{openReq.to_school}</strong>: {openReq.status === 'ACCEPTED' ? `seat given in Class ${openReq.section}. On issue the child moves there the day after the leaving date, with every record.` : 'that school has not accepted yet; the TC can be prepared now and issued once it does.'}</>
            : <>Leaving the Navy schools. If the child is moving to another Navy Children School or Navy Kindergarten, ask that school first from the student's record (Move to another school).</>}</p>}
        </div> : f.kind === 'CEA' ? <label className="field"><span>Academic year (leave empty for the current one)</span><input className="input" value={f.year} placeholder="2025-26" onChange={(e) => setF({ ...f, year: e.target.value })} /></label>
          : f.kind === 'FEE_PAID' ? <label className="field"><span>Financial year (leave empty for the current one)</span><input className="input" value={f.fy} placeholder="2025-26" onChange={(e) => setF({ ...f, fy: e.target.value })} /></label>
            : <label className="field"><span>Purpose</span><input className="input" value={f.purpose} placeholder="For example: passport application" onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>}
        <p className="small muted">Every field is filled from the school's records. You can check and correct them before sending it for approval.</p>
        <button className="btn big" disabled={busy || !student} onClick={async () => {
          const r: any = await run(() => api('/certificates/prepare', { body: { studentId: student.id, kind: f.kind, purpose: f.purpose || undefined, leavingDate: f.kind === 'TC' ? f.leavingDate : undefined,
            reason: f.reason || undefined, year: f.year || undefined, fy: f.fy || undefined } }));
          if (r) onClose(r.id);
        }}>Prepare</button>
      </section>
    </Drawer>
  );
}

function CertDrawer({ id, schoolId, principal, onClose }: { id: string; schoolId: string; principal: boolean; onClose: () => void }) {
  const c = useLoad<any>(`/certificates/${id}`);
  const { run, busy } = useAction();
  const toast = useToast();
  const [data, setData] = useState<Record<string, string> | null>(null);
  const [reason, setReason] = useState('');
  const [printerId, setPrinterId] = useState('');
  useEffect(() => { if (c.data) setData(c.data.data); }, [c.data]);
  const d = c.data;
  if (!d || !data) return <Drawer title="Certificate" onClose={onClose}><Empty>Loading…</Empty></Drawer>;
  const editable = d.status === 'DRAFT';
  const fields: [string, string][] = d.fields ? [...d.fields.filter(([k]: [string, string]) => k !== 'issueDate'), ['leavingDate', LABELS.leavingDate]] : (KIND_FIELDS[d.kind] ?? []).map((k) => [k, LABELS[k] ?? k]);
  const save = async () => run(() => api(`/certificates/${id}`, { method: 'PUT', body: { data } }));
  const verify = d.verify_code ? `${location.origin}/verify/${d.verify_code}` : null;
  return (
    <Drawer title={d.title} onClose={onClose}>
      <section className="tile tight stack small">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`pill ${STATUS[d.status]?.[1] ?? ''}`}>{STATUS[d.status]?.[0] ?? d.status}</span>
          <strong>{d.student}</strong><span className="muted">{d.class} · {d.admission_no}</span>{d.serial_no && <span className="mono">{d.serial_no}</span>}
        </div>
        {d.data?.returned && d.status === 'DRAFT' && <div className="callout orange">Returned: {d.data.returned}</div>}
        {d.cancel_reason && <div className="callout red">Cancelled: {d.cancel_reason}</div>}
        {d.kind === 'TC' && d.data?.destination && d.status !== 'ISSUED' && d.status !== 'CANCELLED' && <div className="callout">
          Going to <strong>{d.data.destination}</strong>. The TC can be issued once that school has given a seat; on issue the child moves there the day after the leaving date, with every record. Quarters here after the leaving date are reversed and anything paid for them is refunded by this school; the new school charges from its next quarter.</div>}
        {d.progress && <div className="tiny muted">{d.progress.steps.map((s: any) => `${s.label}: ${s.done ? `${s.done.decision === 'APPROVE' ? 'approved' : 'returned'} by ${s.done.by}` : s.current ? 'waiting' : '—'}`).join(' · ')}</div>}
        {verify && d.status === 'ISSUED' && <div className="tiny">Anyone can check it at <a href={verify} target="_blank" rel="noreferrer">{verify}</a></div>}
      </section>
      {d.status === 'REQUESTED' ? (
        <section className="tile tight stack">
          <p>{d.by_parent ? 'The parent asked for this' : 'Requested'}{d.purpose ? ` for: ${d.purpose}` : ''}.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api('/certificates/prepare', { body: { requestId: id } }), 'Filled from the records. Check the fields.')) c.reload(); }}>Prepare from the records</button>
            <input className="input" style={{ flex: '1 1 200px' }} placeholder="Or the reason for not issuing" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn danger small" disabled={busy || reason.trim().length < 5} onClick={async () => { if (await run(() => api(`/certificates/${id}/reject`, { body: { reason } }), 'The parent is told')) onClose(); }}>Do not issue</button>
          </div>
        </section>
      ) : (
        <section className="tile tight stack">
          <h3>{editable ? 'Check and correct' : 'Printed details'}</h3>
          {fields.map(([k, label]) => (
            <label key={k} className="field"><span>{label}</span>
              {editable ? <input className="input" value={data[k] ?? ''} onChange={(e) => setData({ ...data, [k]: e.target.value })} /> : <div className="small" style={{ fontWeight: 600 }}>{data[k] || '—'}</div>}</label>))}
          {editable && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn quiet" disabled={busy} onClick={async () => { if (await save()) toast('Saved'); }}>Save</button>
            <button className="btn" disabled={busy} onClick={async () => {
              if (!(await save())) return;
              const r: any = await run(() => api(`/certificates/${id}/submit`, { body: {} }));
              if (r) { toast(r.status === 'ISSUED' ? `Issued: ${r.serial}` : `Sent to ${r.steps.join(', then ')}`); c.reload(); }
            }}>{principal ? 'Issue' : 'Send for approval'}</button>
          </div>}
        </section>
      )}
      {['DRAFT', 'PENDING', 'ISSUED'].includes(d.status) && <section className="tile tight stack">
        <PrinterPicker schoolId={schoolId} purpose="DOCUMENTS" value={printerId} onChange={setPrinterId} />
        <p className="tiny muted">{d.status === 'ISSUED' ? (d.copies_printed ? `Printed ${d.copies_printed} time${d.copies_printed === 1 ? '' : 's'} before; this copy will say "Duplicate copy".` : 'The first print is the original.') : 'A draft prints marked "Draft - not valid".'} {PRINT_NOTE}</p>
        <div><button className="btn quiet" disabled={busy} onClick={async () => { if (await run(() => openPdf(`/certificates/${id}/pdf${printerId ? `?printerId=${printerId}` : ''}`))) c.reload(); }}>Print</button></div>
      </section>}
      {principal && d.status === 'ISSUED' && <section className="tile tight stack">
        <h3>Cancel</h3>
        <p className="small muted">For a certificate issued with a mistake. Anyone checking it will see that it is cancelled.{d.kind === 'TC' ? ' The child stays withdrawn; to bring them back, admit them again.' : ''}</p>
        <input className="input" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div><button className="btn danger small" disabled={busy || reason.trim().length < 5} onClick={async () => { if (await run(() => api(`/certificates/${id}/cancel`, { body: { reason } }), 'Cancelled')) c.reload(); }}>Cancel certificate</button></div>
      </section>}
    </Drawer>
  );
}

function BulkDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const sections = useSchoolSections(schoolId);
  const [f, setF] = useState({ kind: 'CEA', sectionIds: [] as string[], year: '', purpose: '' });
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <Drawer title="Certificates for a whole class" onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">Prepares a draft for every child in the chosen classes who does not already have one for that year. Check them in the register, then the principal issues them together and you print one file.</p>
        <label className="field"><span>Certificate</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="CEA">CEA (Children Education Allowance)</option><option value="BONAFIDE">Bonafide</option></select></label>
        {f.kind === 'CEA' ? <label className="field"><span>Academic year (leave empty for the current one)</span><input className="input" value={f.year} placeholder="2025-26" onChange={(e) => setF({ ...f, year: e.target.value })} /></label>
          : <label className="field"><span>Purpose</span><input className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>}
        <div className="field"><span>Classes</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{sections.map((x) => (
          <label key={x.id} className="check small" style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '2px 8px' }}>
            <input type="checkbox" checked={f.sectionIds.includes(x.id)} onChange={(e) => setF({ ...f, sectionIds: e.target.checked ? [...f.sectionIds, x.id] : f.sectionIds.filter((i) => i !== x.id) })} /> {x.label} <span className="muted">({x.strength})</span></label>))}</div></div>
        <button className="btn big" disabled={busy || !f.sectionIds.length} onClick={async () => {
          const r: any = await run(() => api(`/schools/${schoolId}/certificates/bulk`, { body: { kind: f.kind, sectionIds: f.sectionIds, year: f.year || undefined, purpose: f.purpose || undefined } }));
          if (r) { toast(`${num(r.prepared)} drafts prepared${r.alreadyHad ? `; ${r.alreadyHad} already had one` : ''}`); onClose(); }
        }}>Prepare drafts</button>
      </section>
    </Drawer>
  );
}

// ── Filters and downloads ───────────────────────────────────────────────────────────────

type Period = 'ALL' | 'WEEK' | 'MONTH' | 'LAST_MONTH' | 'YEAR' | 'CUSTOM';
interface CertFilter { kind?: string; year?: string; classCode?: string; period: Period; from?: string; to?: string; includeCancelled?: boolean }

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
/** The academic year (April to March) a date falls in, as "2026-27". */
const yearOf = (d: Date) => { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };
const YEARS = Array.from({ length: 12 }, (_, i) => { const y = Number(yearOf(new Date()).slice(0, 4)) - i; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; });

/** Turns a period choice into issue dates: this week (from Monday), this month, last month, this academic year. */
function range(f: CertFilter): { from?: string; to?: string } {
  const now = new Date();
  if (f.period === 'WEEK') { const m = new Date(now); m.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return { from: iso(m), to: iso(now) }; }
  if (f.period === 'MONTH') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  if (f.period === 'LAST_MONTH') return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (f.period === 'YEAR') { const y = Number(yearOf(now).slice(0, 4)); return { from: `${y}-04-01`, to: iso(now) }; }
  if (f.period === 'CUSTOM') return { from: f.from || undefined, to: f.to || undefined };
  return {};
}
const apiFilter = (f: CertFilter) => ({ kind: f.kind || undefined, year: f.year || undefined, classCode: f.classCode || undefined, ...range(f), includeCancelled: !!f.includeCancelled });
function filterQuery(f: CertFilter, status: string) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(apiFilter(f))) if (v && typeof v === 'string') p.set(k, v);
  if (status) p.set('status', status);
  return p.toString();
}
const PERIODS: [Period, string][] = [['ALL', 'All time'], ['WEEK', 'This week'], ['MONTH', 'This month'], ['LAST_MONTH', 'Last month'], ['YEAR', 'This academic year'], ['CUSTOM', 'Dates…']];

function FilterBar({ schoolId, kinds, value: f, onChange }: { schoolId: string; kinds?: Record<string, string> | null; value: CertFilter; onChange: (f: CertFilter) => void }) {
  const sections = useSchoolSections(schoolId);
  const classes = [...new Set(sections.map((s) => s.classCode))];
  const sel = { height: 34, width: 'auto' } as const;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
      <select className="input" style={sel} aria-label="Certificate" value={f.kind ?? ''} onChange={(e) => onChange({ ...f, kind: e.target.value || undefined })}>
        <option value="">Every certificate</option>
        {Object.entries(kinds ?? {}).map(([k, t]) => <option key={k} value={k}>{t.replace('Consolidated Certificate from Head of School for Claiming Children Educational Allowance', 'CEA certificate')}</option>)}
      </select>
      <select className="input" style={sel} aria-label="Academic year" value={f.year ?? ''} onChange={(e) => onChange({ ...f, year: e.target.value || undefined })}>
        <option value="">Every academic year</option>{YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <select className="input" style={sel} aria-label="Class" value={f.classCode ?? ''} onChange={(e) => onChange({ ...f, classCode: e.target.value || undefined })}>
        <option value="">Every class</option>{classes.map((c) => <option key={c} value={c}>Class {c}</option>)}
      </select>
      <select className="input" style={sel} aria-label="Issued" value={f.period} onChange={(e) => onChange({ ...f, period: e.target.value as Period })}>
        {PERIODS.map(([k, l]) => <option key={k} value={k}>{k === 'ALL' ? 'Issued: any date' : `Issued: ${l.toLowerCase()}`}</option>)}
      </select>
      {f.period === 'CUSTOM' && <>
        <input className="input" style={sel} type="date" aria-label="From" value={f.from ?? ''} onChange={(e) => onChange({ ...f, from: e.target.value })} />
        <span className="small muted">to</span>
        <input className="input" style={sel} type="date" aria-label="To" value={f.to ?? ''} onChange={(e) => onChange({ ...f, to: e.target.value })} />
      </>}
      {(f.kind || f.year || f.classCode || f.period !== 'ALL') && <button className="linkbtn small" onClick={() => onChange({ period: 'ALL' })}>Clear filters</button>}
    </div>
  );
}

/** Every issued certificate matching the filters, in one PDF (with a register in front) or as a spreadsheet register. */
function DownloadDrawer({ schoolId, kinds, initial, onClose }: { schoolId: string; kinds: Record<string, string>; initial: CertFilter; onClose: () => void }) {
  const [f, setF] = useState<CertFilter>({ kind: 'TC', ...initial, ...(initial.kind ? {} : { kind: 'TC' }) });
  const body = { filter: apiFilter(f) };
  const key = JSON.stringify(body);
  const [count, setCount] = useState<{ count: number; max: number } | null>(null);
  useEffect(() => { let live = true; setCount(null); api<{ count: number; max: number }>(`/schools/${schoolId}/certificates/archive`, { body: { ...body, format: 'COUNT' } }).then((r) => live && setCount(r)).catch(() => {}); return () => { live = false; }; }, [schoolId, key]);
  const { run, busy } = useAction();
  const name = [f.kind ?? 'certificates', f.year, f.classCode && `class-${f.classCode}`, range(f).from].filter(Boolean).join('_').toLowerCase();
  return (
    <Drawer title="Download certificates" onClose={onClose}>
      <section className="tile tight stack">
        <p className="small muted">Issued certificates in one file: all of them, or a kind (for example every TC), for a class, an academic year, this week or month, or any dates. The PDF starts with a register of what is inside; each page is marked "Office copy" and does not count as a printed copy.</p>
        <FilterBar schoolId={schoolId} kinds={kinds} value={f} onChange={setF} />
        <label className="check small"><input type="checkbox" checked={!!f.includeCancelled} onChange={(e) => setF({ ...f, includeCancelled: e.target.checked })} /> Include cancelled certificates (marked "Cancelled")</label>
        <div className="callout small">{count == null ? 'Counting…' : count.count === 0 ? 'No issued certificates match.' : <><strong>{num(count.count)}</strong> certificate{count.count === 1 ? '' : 's'} match.{count.count > count.max ? ` Download at most ${num(count.max)} as PDF at a time: choose a year, a class or dates. The spreadsheet has no limit.` : ''}</>}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy || !count?.count || count.count > count.max} onClick={() => run(() => openPdf(`/schools/${schoolId}/certificates/archive`, { ...body, format: 'PDF' }))}>Open PDF</button>
          <button className="btn quiet" disabled={busy || !count?.count} onClick={() => run(() => saveFile(`/schools/${schoolId}/certificates/archive`, `${name}-register.csv`, { ...body, format: 'CSV' }))}>Register as spreadsheet</button>
        </div>
      </section>
    </Drawer>
  );
}
