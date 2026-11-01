import { useEffect, useState } from 'react';
import { api, apiFile, openPdf, readBase64, time, type User } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools } from '../ui';
import { PRINT_NOTE } from './Library';

/** "Moves left 0.3 mm, down 1 mm" rather than signed numbers. */
export function correction(p: { offsetX: number; offsetY: number; scale: number }) {
  const parts = [
    p.offsetX ? `${p.offsetX > 0 ? 'right' : 'left'} ${Math.abs(p.offsetX)} mm` : '',
    p.offsetY ? `${p.offsetY > 0 ? 'down' : 'up'} ${Math.abs(p.offsetY)} mm` : '',
  ].filter(Boolean);
  const scale = p.scale !== 100 ? `scale ${p.scale}%` : '';
  if (!parts.length && !scale) return 'No correction yet';
  return [parts.length ? `Moves ${parts.join(', ')}` : '', scale].filter(Boolean).join(', ');
}

const PURPOSE: Record<string, string> = { DOCUMENTS: 'Certificates and documents (A4)', LABELS: 'Library labels', CARDS: 'ID cards' };

/**
 * Printing set-up for a school: each printer with its calibration, the label and card stationery
 * it uses, and the logo, signature and stamp printed on cards and certificates.
 */
export default function Printing({ user }: { user: User }) {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Printing</span><span className="spacer" /><SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} /></div></div>
      <main className="page">
        {schoolId && <Printers schoolId={schoolId} />}
        {schoolId && <Sheets schoolId={schoolId} />}
        {schoolId && <Images schoolId={schoolId} principal={user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN'} />}
      </main>
    </>
  );
}

function Printers({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/printers`, [schoolId]);
  const [edit, setEdit] = useState<any>(null);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>Printers</h2><p className="muted" style={{ marginTop: 6 }}>Every printer places the page slightly differently. Print its calibration page once, measure two lines with a ruler, and enter the difference. Every label, card and certificate sent to that printer is then corrected.</p></div>
        <button className="btn small" onClick={() => setEdit({ name: '', purpose: 'DOCUMENTS', offsetX: 0, offsetY: 0, scale: 100, notes: '' })}>Add a printer</button>
      </div>
      {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No printers yet. Add each printer the school uses.</Empty> : list.data.map((p) => (
        <div key={p.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
          <div><strong>{p.name}</strong> <span className="small muted">· {PURPOSE[p.purpose]}</span>
            <div className="small">{correction(p)}{p.notes ? ` · ${p.notes}` : ''}</div></div>
          <button className="btn quiet small" onClick={() => setEdit(p)}>Calibrate</button>
        </div>))}
      {edit && <PrinterDrawer schoolId={schoolId} p={edit} onClose={() => { setEdit(null); list.reload(); }} />}
    </section>
  );
}

function PrinterDrawer({ schoolId, p, onClose }: { schoolId: string; p: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const sheets = useLoad<any[]>(`/schools/${schoolId}/label-sheets`, [schoolId]);
  const [f, setF] = useState({ ...p });
  const [sheetId, setSheetId] = useState('');
  const save = async () => run(() => api<any>(`/schools/${schoolId}/printers`, { body: { id: f.id, version: f.version, name: f.name, purpose: f.purpose, offsetX: Number(f.offsetX), offsetY: Number(f.offsetY), scale: Number(f.scale), notes: f.notes } }), 'Saved');
  const paper = f.purpose === 'CARDS' ? 'CARD' : f.purpose === 'LABELS' ? 'LABEL' : 'A4';
  return (
    <Drawer title={p.id ? `Calibrate ${p.name}` : 'Add a printer'} onClose={onClose}>
      <section className="tile tight stack">
        <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={f.name} placeholder="For example: Office laser, room 4" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Used for</span><select className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{Object.entries(PURPOSE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Move right (mm, minus moves left)</span><input className="input" type="number" step="0.1" value={f.offsetX} onChange={(e) => setF({ ...f, offsetX: e.target.value })} /></label>
          <label className="field"><span>Move down (mm, minus moves up)</span><input className="input" type="number" step="0.1" value={f.offsetY} onChange={(e) => setF({ ...f, offsetY: e.target.value })} /></label>
          <label className="field"><span>Scale (%)</span><input className="input" type="number" step="0.1" value={f.scale} onChange={(e) => setF({ ...f, scale: e.target.value })} /></label>
          <label className="field"><span>Notes</span><input className="input" value={f.notes} placeholder="Model, tray, paper type" onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        </div>
        <button className="btn" disabled={busy || f.name.trim().length < 2} onClick={async () => { const r: any = await save(); if (r && !f.id) setF({ ...f, id: r.id }); }}>Save</button>
      </section>
      {f.id && <section className="tile tight stack">
        <h3>Calibration page</h3>
        <ol className="small" style={{ paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>Print the page below on the paper this printer uses. {PRINT_NOTE}</li>
          <li>{paper === 'A4' ? 'Measure from the left edge of the paper to the vertical line (should be 20 mm), and from the top edge to the horizontal line (should be 20 mm). Measure the long line (should be 150 mm).' : paper === 'CARD' ? 'On the card, the frame should sit 2 mm inside every edge and the thin lines should be 10 mm from the left and top edges.' : 'Each box should sit 1 mm inside its label.'}</li>
          <li>If a line is 22 mm instead of 20 mm, enter −2; if 18 mm, enter +2. Save, print again, and check.</li>
        </ol>
        {paper === 'LABEL' && <label className="field"><span>Label stationery</span><select className="input" value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
          <option value="">Choose</option>{(sheets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        <div><button className="btn quiet" disabled={busy || (paper === 'LABEL' && !sheetId)} onClick={() => run(() => openPdf(`/schools/${schoolId}/printers/${f.id}/calibration?paper=${paper}${sheetId ? `&sheetId=${sheetId}` : ''}`))}>Print calibration page</button></div>
      </section>}
      {f.id && <section className="tile tight"><button className="btn danger small" disabled={busy} onClick={async () => { if (await run(() => api(`/printers/${f.id}`, { method: 'DELETE' }), 'Printer removed')) onClose(); }}>Remove this printer</button></section>}
    </Drawer>
  );
}

function Sheets({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/label-sheets`, [schoolId]);
  const [adding, setAdding] = useState(false);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>Labels, card sheets and trays</h2><p className="muted" style={{ marginTop: 6 }}>The common A4 label sheets and roll labels are ready. Add any other stationery with its measurements: a different label sheet, a pre-cut PVC card sheet, or an inkjet card tray.</p></div>
        <button className="btn small" onClick={() => setAdding(true)}>Add stationery</button>
      </div>
      {!list.data ? <Empty>Loading…</Empty> : (
        <div className="scroll-x"><table className="table">
          <thead><tr><th>Name</th><th>Page (mm)</th><th>Layout</th><th>Each (mm)</th><th /></tr></thead>
          <tbody>{list.data.map((s) => (
            <tr key={s.id}><td style={{ fontWeight: 600 }}>{s.name}</td><td className="small">{s.page_w} × {s.page_h}</td><td className="small">{s.cols} × {s.rows} = {s.cols * s.rows}</td>
              <td className="small">{s.label_w} × {s.label_h}</td><td>{s.own ? <span className="pill">This school</span> : <span className="pill green">Standard</span>}</td></tr>))}</tbody>
        </table></div>
      )}
      {adding && <SheetDrawer schoolId={schoolId} onClose={() => { setAdding(false); list.reload(); }} />}
    </section>
  );
}

function SheetDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState<Record<string, string>>({ name: '', page_w: '210', page_h: '297', cols: '2', rows: '5', label_w: '85.6', label_h: '54', margin_left: '15', margin_top: '13.5', gap_x: '8', gap_y: '0' });
  const n = (k: string) => Number(f[k]);
  const fits = n('margin_left') + n('cols') * n('label_w') + (n('cols') - 1) * n('gap_x') <= n('page_w') + 0.5 && n('margin_top') + n('rows') * n('label_h') + (n('rows') - 1) * n('gap_y') <= n('page_h') + 0.5;
  const field = (k: string, label: string) => <label className="field"><span>{label}</span><input className="input" inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') })} /></label>;
  return (
    <Drawer title="Add stationery" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Name</span><input className="input" value={f.name} placeholder="For example: Epson PVC card tray (2 cards)" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <p className="small muted">Measure the sheet with a ruler, in millimetres. Margins are from the paper's left and top edges to the first label or card.</p>
        <div className="form-grid">
          {field('page_w', 'Page width')}{field('page_h', 'Page height')}{field('cols', 'Across')}{field('rows', 'Down')}
          {field('label_w', 'Each: width')}{field('label_h', 'Each: height')}{field('margin_left', 'Left margin')}{field('margin_top', 'Top margin')}
          {field('gap_x', 'Gap across')}{field('gap_y', 'Gap down')}
        </div>
        {!fits && <div className="callout orange small">These do not fit on the page. Check the measurements.</div>}
        <button className="btn big" disabled={busy || !fits || f.name.trim().length < 3} onClick={async () => {
          if (await run(() => api(`/schools/${schoolId}/label-sheets`, { body: { name: f.name, ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [k, Number(v)])) } }), 'Saved')) onClose();
        }}>Save</button>
      </section>
    </Drawer>
  );
}

function Images({ schoolId, principal }: { schoolId: string; principal: boolean }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/print-assets`, [schoolId]);
  const { run, busy } = useAction();
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const a of list.data ?? []) { try { const { blob } = await apiFile(`/schools/${schoolId}/print-assets/${a.kind}/file`); out[a.kind] = URL.createObjectURL(blob); } catch { /* not shown */ } }
      if (!cancelled) setUrls(out);
    })();
    return () => { cancelled = true; };
  }, [list.data, schoolId]);
  const KINDS: [string, string, string, boolean][] = [['LOGO', 'School logo', 'On ID cards and certificates.', false], ['SIGNATURE', "Principal's signature", 'On issued certificates and ID cards. Sign on white paper, scan, and crop closely.', true], ['STAMP', 'School stamp', 'Beside the signature on issued certificates.', true], ['HPC_COVER', 'Report card cover picture', 'Optional: artwork behind the cover of every report card (A4 portrait). Without it a drawn park scene is used.', false]];
  return (
    <section className="tile">
      <h2>School images</h2>
      <p className="muted" style={{ marginTop: 6 }}>PNG with a transparent background looks best; JPEG works. Up to 1 MB.</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 16 }}>
        {KINDS.map(([k, label, help, needsPrincipal]) => {
          const a = list.data?.find((x) => x.kind === k);
          return (
            <div key={k} className="callout stack small">
              <strong>{label}</strong><span className="muted">{help}</span>
              <div style={{ height: 80, display: 'grid', placeItems: 'center', background: '#fff', borderRadius: 10 }}>{urls[k] ? <img src={urls[k]} alt={label} style={{ maxHeight: 72, maxWidth: '90%' }} /> : <span className="tiny muted">None yet</span>}</div>
              {a && <span className="tiny muted">{a.uploaded_by}, {time(a.uploaded_at)}</span>}
              {(!needsPrincipal || principal) ? <label className="btn quiet small" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>{a ? 'Replace' : 'Upload'}<input type="file" accept="image/png,image/jpeg" hidden disabled={busy} onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const data = await readBase64(f);
                if (await run(() => api(`/schools/${schoolId}/print-assets/${k}`, { method: 'PUT', body: { dataBase64: data } }), `${label} saved`)) list.reload();
              }} /></label> : <span className="tiny muted">Uploaded by the principal.</span>}
            </div>);
        })}
      </div>
    </section>
  );
}
