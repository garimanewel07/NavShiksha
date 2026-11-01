import { useEffect, useState } from 'react';
import { api, day, num, openPdf, readBase64, readText, today } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';
import { PRINT_NOTE, PrinterPicker } from './Library';

type Kind = 'STUDENT' | 'STAFF';
const FIELDS: [string, string, Kind[]][] = [['photo', 'Photo', ['STUDENT', 'STAFF']], ['class', 'Class and section', ['STUDENT']], ['admissionNo', 'Admission number', ['STUDENT']],
  ['dob', 'Date of birth', ['STUDENT', 'STAFF']], ['bloodGroup', 'Blood group', ['STUDENT', 'STAFF']], ['house', 'House', ['STUDENT']], ['parent', 'Parent (on the back)', ['STUDENT']],
  ['phone', 'Phone (students: on the back)', ['STUDENT', 'STAFF']], ['barcode', 'Barcode (library and gate)', ['STUDENT', 'STAFF']]];

/** Sections of a school, for choosing who to print for. */
export function useSchoolSections(schoolId: string) {
  const { data } = useLoad<any>(schoolId ? `/schools/${schoolId}/class-teachers` : null, [schoolId]);
  return (data?.sections ?? []) as { id: string; label: string; classCode: string; strength: number }[];
}

/**
 * Student and staff ID cards. Cards come straight from the records, so anyone admitted or
 * joining during the year is there; the year's status shows who still has no card.
 */
export default function Cards() {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [kind, setKind] = useState<Kind>('STUDENT');
  const [tab, setTab] = useState<'print' | 'photos' | 'staff'>('print');
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">ID cards</span><span className="spacer" />
        <div className="seg"><button className={kind === 'STUDENT' ? 'on' : ''} onClick={() => { setKind('STUDENT'); if (tab === 'staff') setTab('print'); }}>Students</button><button className={kind === 'STAFF' ? 'on' : ''} onClick={() => setKind('STAFF')}>Staff</button></div>
        <div className="seg"><button className={tab === 'print' ? 'on' : ''} onClick={() => setTab('print')}>Design and print</button><button className={tab === 'photos' ? 'on' : ''} onClick={() => setTab('photos')}>Photos</button>
          {kind === 'STAFF' && <button className={tab === 'staff' ? 'on' : ''} onClick={() => setTab('staff')}>Staff details</button>}</div>
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
      </div></div>
      <main className="page">
        {schoolId && tab === 'print' && <Print schoolId={schoolId} kind={kind} />}
        {schoolId && tab === 'photos' && <Photos schoolId={schoolId} kind={kind} />}
        {schoolId && tab === 'staff' && kind === 'STAFF' && <StaffDetails schoolId={schoolId} />}
      </main>
    </>
  );
}

function Print({ schoolId, kind }: { schoolId: string; kind: Kind }) {
  const status = useLoad<any>(`/schools/${schoolId}/cards/${kind}/status`, [schoolId, kind]);
  const sections = useSchoolSections(schoolId);
  const sheets = useLoad<any[]>(`/schools/${schoolId}/label-sheets`, [schoolId]);
  const [design, setDesign] = useState(false);
  const { run, busy } = useAction();
  const toast = useToast();
  const [f, setF] = useState({ who: 'without', sectionIds: [] as string[], layout: 'CARD_PRINTER', sheetId: '', sides: 'BOTH', printerId: '' });
  const s = status.data;
  const print = async () => {
    const body = { layout: f.layout, sides: f.sides, printerId: f.printerId || null, sheetId: f.layout === 'SHEET' ? f.sheetId : null,
      sectionIds: kind === 'STUDENT' && f.who !== 'all' && f.sectionIds.length ? f.sectionIds : undefined, onlyWithoutCard: f.who === 'without' };
    const h = await run(() => openPdf(`/schools/${schoolId}/cards/${kind}/print`, body));
    if (h) { toast(`${h.get('x-count')} cards${Number(h.get('x-without-photo')) ? `; ${h.get('x-without-photo')} without a photo` : ''}`); status.reload(); }
  };
  return (
    <>
      <section className="tile">
        <div className="tile-head">
          <div><h2>{s ? s.year : 'This year'}</h2>
            <p className="muted" style={{ marginTop: 6 }}>{s ? `${num(s.withCard)} of ${num(s.total)} ${kind === 'STUDENT' ? 'students' : 'staff'} have a card for this academic year. Cards are valid until ${day(s.validUntil)}.` : 'Loading…'}</p></div>
          <button className="btn quiet small" onClick={() => setDesign(true)}>Card design</button>
        </div>
        {s?.without?.length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>{num(s.total - s.withCard)} without a card yet (new admissions, new staff, or everyone after the year changes)</summary>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6, marginTop: 10 }}>{s.without.map((p: any) => <div key={p.id} className="small">{p.name} <span className="muted tiny">· {p.detail}</span></div>)}</div></details>}
      </section>
      <section className="tile stack">
        <h2>Print cards</h2>
        <div className="form-grid">
          <label className="field"><span>Who</span><select className="input" value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
            <option value="without">Only those without a card this year</option><option value="chosen">{kind === 'STUDENT' ? 'Chosen classes (everyone in them)' : 'All staff'}</option>{kind === 'STUDENT' && <option value="all">The whole school</option>}</select></label>
          <label className="field"><span>Printing on</span><select className="input" value={f.layout} onChange={(e) => setF({ ...f, layout: e.target.value })}>
            <option value="CARD_PRINTER">Plastic (PVC) cards, card printer: one card per page</option><option value="A4">Plain A4 paper with crop marks</option><option value="SHEET">A pre-cut card sheet or tray</option></select></label>
          {f.layout === 'SHEET' && <label className="field"><span>Sheet or tray</span><select className="input" value={f.sheetId} onChange={(e) => setF({ ...f, sheetId: e.target.value })}>
            <option value="">Choose</option>{(sheets.data ?? []).filter((x) => x.label_w > 45).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
          <label className="field"><span>Sides</span><select className="input" value={f.sides} onChange={(e) => setF({ ...f, sides: e.target.value })}>
            <option value="BOTH">Front and back</option><option value="FRONT">Front only</option><option value="BACK">Back only</option></select></label>
          <PrinterPicker schoolId={schoolId} purpose="CARDS" value={f.printerId} onChange={(v) => setF((x) => ({ ...x, printerId: v }))} />
        </div>
        {kind === 'STUDENT' && f.who !== 'all' && <div className="field"><span>Classes {f.who === 'without' ? '(leave empty for the whole school)' : ''}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{sections.map((x) => (
            <label key={x.id} className="check small" style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '2px 8px' }}>
              <input type="checkbox" checked={f.sectionIds.includes(x.id)} onChange={(e) => setF({ ...f, sectionIds: e.target.checked ? [...f.sectionIds, x.id] : f.sectionIds.filter((i) => i !== x.id) })} /> {x.label}</label>))}</div></div>}
        <p className="small muted">{f.layout === 'A4' ? 'Back pages are mirrored, so with double-sided printing (flip on the long edge) each back lands behind its front. ' : ''}{PRINT_NOTE}</p>
        <div><button className="btn big" disabled={busy || (f.layout === 'SHEET' && !f.sheetId) || (kind === 'STUDENT' && f.who === 'chosen' && !f.sectionIds.length)} onClick={print}>Make cards</button></div>
      </section>
      {design && <DesignDrawer schoolId={schoolId} kind={kind} onClose={() => { setDesign(false); status.reload(); }} />}
    </>
  );
}

function DesignDrawer({ schoolId, kind, onClose }: { schoolId: string; kind: Kind; onClose: () => void }) {
  const d = useLoad<any>(`/schools/${schoolId}/cards/${kind}/design`);
  const { run, busy } = useAction();
  const [v, setV] = useState<any>(null);
  useEffect(() => { if (d.data && !v) setV(d.data.design); }, [d.data, v]);
  const sample = useLoad<any>(`/schools/${schoolId}/cards/${kind}/status`);
  // A preview draws the saved design on one real person in a new tab; it is not recorded as a card issued.
  const preview = async () => {
    const id = sample.data?.sampleId;
    if (id) await run(() => openPdf(`/schools/${schoolId}/cards/${kind}/print`, { ids: [id], layout: 'CARD_PRINTER', sides: 'BOTH', preview: true }));
  };
  if (!v) return <Drawer title="Card design" onClose={onClose}><Empty>Loading…</Empty></Drawer>;
  const set = (p: any) => setV({ ...v, ...p });
  return (
    <Drawer title={`${kind === 'STUDENT' ? 'Student' : 'Staff'} card design`} onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Layout</span><select className="input" value={v.orientation} onChange={(e) => set({ orientation: e.target.value })}><option value="PORTRAIT">Portrait (upright)</option><option value="LANDSCAPE">Landscape (wide)</option></select></label>
          <label className="field"><span>Card size</span><select className="input" value={v.size ?? 'CR80'} onChange={(e) => set({ size: e.target.value })}>
            <option value="CR80">CR80, 85.6 × 54 mm (standard plastic ID card)</option><option value="CR79">CR79, 84 × 52 mm (adhesive-backed)</option><option value="CUSTOM">Another size</option></select></label>
          {v.size === 'CUSTOM' && <>
            <label className="field"><span>Long side (mm)</span><input className="input" inputMode="decimal" value={v.customW ?? ''} onChange={(e) => set({ customW: Number(e.target.value) || undefined })} /></label>
            <label className="field"><span>Short side (mm)</span><input className="input" inputMode="decimal" value={v.customH ?? ''} onChange={(e) => set({ customH: Number(e.target.value) || undefined })} /></label>
          </>}
          <label className="field"><span>Band colour</span><input className="input" type="color" value={v.colour} onChange={(e) => set({ colour: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Text on the band</span><input className="input" type="color" value={v.textColour} onChange={(e) => set({ textColour: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Valid until</span><select className="input" value={v.validUntil === 'AUTO' ? 'AUTO' : 'DATE'} onChange={(e) => set({ validUntil: e.target.value === 'AUTO' ? 'AUTO' : today() })}>
            <option value="AUTO">End of the academic year (automatic)</option><option value="DATE">A fixed date</option></select></label>
          {v.validUntil !== 'AUTO' && <label className="field"><span>Date</span><input className="input" type="date" value={v.validUntil} onChange={(e) => set({ validUntil: e.target.value })} /></label>}
        </div>
        <label className="field"><span>School name on the card</span><input className="input" value={v.heading} onChange={(e) => set({ heading: e.target.value })} /></label>
        <label className="field"><span>Line under it</span><input className="input" value={v.subheading} onChange={(e) => set({ subheading: e.target.value })} /></label>
        <div className="field"><span>Show</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{FIELDS.filter(([, , k]) => k.includes(kind)).map(([k, l]) => (
          <label key={k} className="check small"><input type="checkbox" checked={!!v.show[k]} onChange={(e) => set({ show: { ...v.show, [k]: e.target.checked } })} /> {l}</label>))}</div></div>
        <label className="field"><span>Back of the card (one line each)</span><textarea className="input" rows={4} value={v.backLines.join('\n')} onChange={(e) => set({ backLines: e.target.value.split('\n').slice(0, 6) })} /></label>
        <label className="field"><span>Signature label</span><input className="input" value={v.signatureLabel} onChange={(e) => set({ signatureLabel: e.target.value })} /></label>
        <p className="small muted">The school logo and the principal's signature come from Printing → School images.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={async () => {
            const design = { ...v, backLines: v.backLines.map((l: string) => l.trim()).filter(Boolean) };
            const r: any = await run(() => api(`/schools/${schoolId}/cards/${kind}/design`, { method: 'PUT', body: { design, version: d.data.version } }), 'Design saved');
            if (r) { await d.reload(); setV(null); preview(); }
          }}>Save and preview</button>
          <button className="btn quiet" onClick={onClose}>Close</button>
        </div>
      </section>
    </Drawer>
  );
}

function Photos({ schoolId, kind }: { schoolId: string; kind: Kind }) {
  const sections = useSchoolSections(schoolId);
  const [sectionId, setSectionId] = useState('');
  const missing = useLoad<any[]>(`/schools/${schoolId}/cards/${kind}/missing-photos${kind === 'STUDENT' && sectionId ? `?sectionIds=${sectionId}` : ''}`, [schoolId, kind, sectionId]);
  const { run, busy } = useAction();
  const [report, setReport] = useState<any>(null);
  const bulk = async (files: FileList) => {
    const all = Array.from(files);
    const sum = { saved: 0, unmatched: [] as string[], failed: [] as any[] };
    for (let i = 0; i < all.length; i += 20) {
      const chunk = await Promise.all(all.slice(i, i + 20).map(async (f) => ({ name: f.name, dataBase64: await readBase64(f) })));
      const r: any = await run(() => api(`/schools/${schoolId}/photos/bulk`, { body: { kind, files: chunk } }));
      if (!r) break;
      sum.saved += r.saved; sum.unmatched.push(...r.unmatched); sum.failed.push(...r.failed);
    }
    setReport(sum); missing.reload();
  };
  return (
    <section className="tile stack">
      <h2>Photos</h2>
      <p className="muted">Upload many at once: name each photo file with the {kind === 'STUDENT' ? 'admission number (use _ for /, for example NCS-MB_2026_0138.jpg)' : 'staff number (for example MB-101.jpg)'}. JPEG or PNG, up to 1 MB each, passport style.{kind === 'STUDENT' ? ' Class teachers can also add photos for their own class.' : ''}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="btn" style={{ cursor: 'pointer' }}>Upload photos<input type="file" accept="image/jpeg,image/png" multiple hidden disabled={busy} onChange={(e) => e.target.files && bulk(e.target.files)} /></label>
        {kind === 'STUDENT' && <select className="input" style={{ width: 'auto', height: 36 }} value={sectionId} onChange={(e) => setSectionId(e.target.value)} aria-label="Class">
          <option value="">All classes</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>}
      </div>
      {report && <div className={`callout ${report.unmatched.length || report.failed.length ? 'orange' : 'green'} small`}>{report.saved} photos saved.
        {report.unmatched.length > 0 && <> No one matched: {report.unmatched.slice(0, 10).join(', ')}{report.unmatched.length > 10 ? '…' : ''}.</>}
        {report.failed.map((f: any) => <div key={f.name}>{f.name}: {f.reason}</div>)}</div>}
      <h3>Without a photo ({missing.data?.length ?? '…'})</h3>
      {!missing.data ? <Empty>Loading…</Empty> : !missing.data.length ? <Empty>Everyone has a photo.</Empty> : (<>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
          {missing.data.slice(0, 300).map((p) => <OnePhoto key={p.id} kind={kind} person={p} onDone={missing.reload} />)}</div>
        {missing.data.length > 300 && <p className="small muted" style={{ marginTop: 8 }}>Showing 300 of {missing.data.length} without a photo. Add these, or use bulk upload, and the next ones appear.</p>}
      </>)}
    </section>
  );
}

function OnePhoto({ kind, person, onDone }: { kind: Kind; person: any; onDone: () => void }) {
  const { run, busy } = useAction();
  return (
    <div className="callout small" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span><strong>{person.name}</strong><br /><span className="tiny muted">{person.detail}</span></span>
      <label className="btn quiet small" style={{ cursor: 'pointer' }}>Add<input type="file" accept="image/jpeg,image/png" hidden disabled={busy} onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const data = await readBase64(f);
        if (await run(() => api(`/photos/${kind}/${person.id}`, { method: 'PUT', body: { dataBase64: data } }), 'Photo saved')) onDone();
      }} /></label>
    </div>
  );
}

function StaffDetails({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/staff-details`, [schoolId]);
  const { run, busy } = useAction();
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>Staff details</h2><p className="muted" style={{ marginTop: 6 }}>Cards are printed from each person’s staff record; a correction here is made to that record. Bringing staff over from the old ERP? Import a spreadsheet (staff number, name, designation, mobile, blood group, date of birth, date of joining): each row becomes a staff record.</p></div>
        <label className="btn small" style={{ cursor: 'pointer' }}>Import CSV<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const csv = await readText(f);
          const r: any = await run(() => api(`/schools/${schoolId}/staff-details/import`, { body: { csv } }));
          if (r) { toast(`${r.updated} updated, ${r.added} added`); list.reload(); }
        }} /></label>
      </div>
      {!list.data ? <Empty>Loading…</Empty> : (
        <div className="scroll-x"><table className="table">
          <thead><tr><th>Name</th><th>Staff no.</th><th>Blood group</th><th>Mobile</th><th>Photo</th><th /></tr></thead>
          <tbody>{list.data.map((s) => (
            <tr key={s.id}><td style={{ fontWeight: 600 }}>{s.name}<div className="tiny muted">{s.designation}</div></td><td className="mono">{s.employee_no ?? <span style={{ color: 'var(--orange)' }}>Missing</span>}</td>
              <td>{s.blood_group ?? ''}</td><td>{s.phone?.replace('+91', '') ?? ''}</td><td>{s.has_photo ? <span className="pill green">Yes</span> : <span className="pill">No</span>}</td>
              <td><button className="btn quiet small" onClick={() => setEdit({ ...s, phone: s.phone?.replace('+91', '') ?? '' })}>Edit</button></td></tr>))}</tbody>
        </table></div>
      )}
      {edit && <Drawer title={edit.name} onClose={() => setEdit(null)}>
        <section className="tile tight stack">
          <div className="form-grid">
            <label className="field"><span>Staff number</span><input className="input" value={edit.employee_no ?? ''} onChange={(e) => setEdit({ ...edit, employee_no: e.target.value })} /></label>
            <label className="field"><span>Blood group</span><select className="input" value={edit.blood_group ?? ''} onChange={(e) => setEdit({ ...edit, blood_group: e.target.value })}>
              <option value="">Not known</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}</select></label>
            <label className="field"><span>Mobile</span><input className="input" inputMode="numeric" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
            <label className="field"><span>Date of birth</span><input className="input" type="date" value={edit.dob ?? ''} onChange={(e) => setEdit({ ...edit, dob: e.target.value })} /></label>
            <div className="field"><span>Date of joining</span><div className="small" style={{ paddingTop: 10 }}>{edit.joined_on ? new Date(`${edit.joined_on}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'} <span className="tiny muted">(from the service book)</span></div></div>
            <label className="field"><span>Emergency contact</span><input className="input" value={edit.emergency_contact ?? ''} placeholder="Name and phone" onChange={(e) => setEdit({ ...edit, emergency_contact: e.target.value })} /></label>
          </div>
          <OnePhoto kind="STAFF" person={{ id: edit.id, name: 'Photo', detail: edit.has_photo ? 'Replace the photo' : 'No photo yet' }} onDone={list.reload} />
          <a className="linkbtn small" href={`/staff/${edit.id}`}>Open the full staff record</a>
          <button className="btn big" disabled={busy || !edit.employee_no} onClick={async () => {
            if (await run(() => api(`/schools/${schoolId}/staff-details/${edit.id}`, { method: 'PUT', body: { employeeNo: edit.employee_no, bloodGroup: edit.blood_group || null, phone: edit.phone || null,
              dob: edit.dob || null, emergencyContact: edit.emergency_contact || null } }), 'Saved to the staff record')) { setEdit(null); list.reload(); }
          }}>Save</button>
        </section>
      </Drawer>}
    </section>
  );
}
