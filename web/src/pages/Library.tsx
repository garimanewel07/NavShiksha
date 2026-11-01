import { useEffect, useRef, useState } from 'react';
import { api, day, money, num, openPdf, readText, saveFile, words, today } from '../api';
import { Drawer, Empty, SchoolPicker, useAction, useLoad, useSchools, useToast } from '../ui';

type Tab = 'desk' | 'catalogue' | 'overdue' | 'labels' | 'import';

/**
 * The library. A USB barcode or QR scanner types like a keyboard and presses Enter, so the desk
 * works by scanning: an ID card then books to issue, or a book on its own to return it.
 */
export default function Library() {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const [tab, setTab] = useState<Tab>('desk');
  const summary = useLoad<any>(schoolId ? `/schools/${schoolId}/library/summary` : null, [schoolId, tab]);
  const s = summary.data;
  const tabs: [Tab, string][] = [['desk', 'Issue and return'], ['catalogue', 'Catalogue'], ['overdue', `Overdue${s?.overdue ? ` (${s.overdue})` : ''}`], ['labels', `Labels${s?.labels_to_print ? ` (${s.labels_to_print})` : ''}`], ['import', 'Import from old ERP']];
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Library</span><span className="spacer" />
        <div className="seg" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        <SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} />
      </div></div>
      <main className="page">
        {s && <section className="tile tight"><div className="kpis">
          <div><div className="kpi-label">Titles</div><div className="kpi-value">{num(s.titles)}</div></div>
          <div><div className="kpi-label">Copies</div><div className="kpi-value">{num(s.copies)}</div></div>
          <div><div className="kpi-label">On loan</div><div className="kpi-value">{num(s.on_loan)}</div><div className="kpi-note">{num(s.issued_today)} issued today</div></div>
          <div><div className="kpi-label">Overdue</div><div className="kpi-value" style={{ color: s.overdue ? 'var(--red)' : undefined }}>{num(s.overdue)}</div></div>
        </div></section>}
        {schoolId && tab === 'desk' && <Desk schoolId={schoolId} onChange={summary.reload} />}
        {schoolId && tab === 'catalogue' && <Catalogue schoolId={schoolId} />}
        {schoolId && tab === 'overdue' && <Overdue schoolId={schoolId} />}
        {schoolId && tab === 'labels' && <Labels schoolId={schoolId} onPrinted={summary.reload} />}
        {schoolId && tab === 'import' && <Import schoolId={schoolId} onDone={summary.reload} />}
      </main>
    </>
  );
}

// ── Desk ─────────────────────────────────────────────────────────────────────────────────

interface Log { kind: 'ok' | 'error' | 'info'; text: string }

function Desk({ schoolId, onChange }: { schoolId: string; onChange: () => void }) {
  const [scan, setScan] = useState('');
  const [borrower, setBorrower] = useState<any>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [log, setLog] = useState<Log[]>([]);
  const [waive, setWaive] = useState<{ barcode: string; reason: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();
  const add = (l: Log) => setLog((x) => [l, ...x].slice(0, 30));
  useEffect(() => { input.current?.focus(); }, [borrower, queue.length]);

  const handle = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setScan('');
    // While a borrower is open, scans are books to lend; otherwise try a person first, then a return.
    if (borrower) { if (!queue.includes(c)) setQueue((q) => [...q, c]); return; }
    try {
      const b = await api<any>(`/schools/${schoolId}/library/borrower?code=${encodeURIComponent(c)}`);
      setBorrower(b); setQueue([]);
      return;
    } catch { /* not a person: a book being returned */ }
    try {
      const r = await api<any>(`/schools/${schoolId}/library/return`, { body: { barcode: c } });
      add({ kind: 'ok', text: `Returned "${r.title}" from ${r.borrower}${r.daysLate ? `, ${r.daysLate} days late${r.finePaise ? `: fine ${money(r.finePaise)}${r.staff ? ' (collect at the desk)' : ' added to fees'}` : ''}` : ''}.` });
      onChange();
    } catch (e) { add({ kind: 'error', text: (e as Error).message }); }
  };

  const issue = async () => {
    const r: any = await run(() => api(`/schools/${schoolId}/library/issue`, { body: { borrower: borrower.kind === 'STUDENT' ? borrower.studentId : borrower.userId, barcodes: queue } }));
    if (r) { add({ kind: 'ok', text: `Issued to ${r.borrower}: ${r.issued.map((i: any) => `"${i.title}"`).join(', ')}. Due ${day(r.dueOn)}.` }); setBorrower(null); setQueue([]); onChange(); }
  };
  const renew = async (loanId: string) => {
    const r: any = await run(() => api(`/schools/${schoolId}/library/loans/${loanId}/renew`, { body: {} }));
    if (r) { add({ kind: 'ok', text: `Renewed until ${day(r.dueOn)}.` }); setBorrower(await api(`/schools/${schoolId}/library/borrower?code=${encodeURIComponent(borrower.kind === 'STUDENT' ? borrower.studentId : borrower.userId)}`)); }
  };

  return (
    <div className="row">
      <section className="tile" style={{ flex: '2 1 520px' }}>
        <h2>{borrower ? `Lending to ${borrower.name}` : 'Scan a card or a book'}</h2>
        <p className="muted" style={{ marginTop: 6 }}>{borrower ? 'Scan each book, then press Issue. Scan nothing more to cancel.' : 'Scan a student or staff ID card to lend books. Scan a book on its own to return it. You can also type an admission number, NES ID, staff number, barcode or accession number.'}</p>
        <form onSubmit={(e) => { e.preventDefault(); handle(scan); }} style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <input ref={input} className="input" style={{ fontSize: '1.2rem', height: 52 }} value={scan} onChange={(e) => setScan(e.target.value)} placeholder={borrower ? 'Scan a book' : 'Scan here'} aria-label="Scan" autoComplete="off" />
          <button className="btn big" type="submit">Enter</button>
        </form>
        {borrower && <div className="callout stack" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div><strong>{borrower.name}</strong> <span className="muted small">· {borrower.detail}</span></div>
            <span className={`pill ${borrower.overdue ? 'red' : ''}`}>{borrower.loans.length} of {borrower.limit} books{borrower.overdue ? ` · ${borrower.overdue} overdue` : ''}</span>
          </div>
          {borrower.loans.map((l: any) => (
            <div key={l.id} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
              <span>{l.title} <span className="muted mono tiny">{l.barcode}</span></span>
              <span style={{ color: l.due_on < today() ? 'var(--red)' : undefined }}>Due {day(l.due_on)}</span>
              <button className="btn quiet small" disabled={busy} onClick={() => renew(l.id)}>Renew</button>
            </div>))}
          {queue.length > 0 && <div className="stack small"><strong>To lend now</strong>{queue.map((q) => <div key={q} style={{ display: 'flex', justifyContent: 'space-between' }}><span className="mono">{q}</span><button className="linkbtn small" onClick={() => setQueue(queue.filter((x) => x !== q))}>Remove</button></div>)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={busy || !queue.length} onClick={issue}>Issue {queue.length || ''} book{queue.length === 1 ? '' : 's'}</button>
            <button className="btn quiet" onClick={() => { setBorrower(null); setQueue([]); }}>Cancel</button>
          </div>
        </div>}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn quiet small" onClick={() => setWaive({ barcode: '', reason: '' })}>Return without a fine</button>
          <LostButton schoolId={schoolId} onDone={(t) => { add({ kind: 'info', text: t }); onChange(); }} />
        </div>
        {waive && <div className="callout stack small" style={{ marginTop: 12 }}>
          <span>Return a late book without a fine, for example when the child was ill. The reason is kept.</span>
          <div className="form-grid">
            <label className="field"><span>Book barcode</span><input className="input" value={waive.barcode} onChange={(e) => setWaive({ ...waive, barcode: e.target.value })} /></label>
            <label className="field"><span>Reason</span><input className="input" value={waive.reason} onChange={(e) => setWaive({ ...waive, reason: e.target.value })} /></label>
          </div>
          <div><button className="btn small" disabled={busy || !waive.barcode || waive.reason.trim().length < 3} onClick={async () => {
            const r: any = await run(() => api(`/schools/${schoolId}/library/return`, { body: { barcode: waive.barcode, waive: waive.reason } }));
            if (r) { add({ kind: 'ok', text: `Returned "${r.title}" from ${r.borrower}; fine waived.` }); setWaive(null); onChange(); }
          }}>Return</button></div>
        </div>}
      </section>
      <section className="tile" style={{ flex: '1 1 300px' }}>
        <h3>At the desk today</h3>
        {!log.length ? <p className="small muted" style={{ marginTop: 8 }}>Issues and returns appear here.</p> : log.map((l, i) => (
          <div key={i} className="small" style={{ padding: '8px 0', borderTop: '1px solid var(--line-soft)', color: l.kind === 'error' ? 'var(--red)' : undefined }}>{l.text}</div>))}
      </section>
    </div>
  );
}

function LostButton({ schoolId, onDone }: { schoolId: string; onDone: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ barcode: '', note: '' });
  const { run, busy } = useAction();
  if (!open) return <button className="btn quiet small" onClick={() => setOpen(true)}>Mark a borrowed book lost</button>;
  return (
    <div className="callout stack small" style={{ width: '100%' }}>
      <span>The loan closes and the book's price is added to the student's fees.</span>
      <div className="form-grid">
        <label className="field"><span>Book barcode</span><input className="input" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></label>
        <label className="field"><span>Note</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn danger small" disabled={busy || !f.barcode} onClick={async () => {
          const r: any = await run(() => api(`/schools/${schoolId}/library/lost`, { body: f }));
          if (r) { onDone(`"${r.title}" marked lost${r.billedPaise ? `; ${money(r.billedPaise)} added to fees` : ''}.`); setOpen(false); setF({ barcode: '', note: '' }); }
        }}>Mark lost</button>
        <button className="btn quiet small" onClick={() => setOpen(false)}>Back</button>
      </div>
    </div>
  );
}

// ── Catalogue ────────────────────────────────────────────────────────────────────────────

function Catalogue({ schoolId }: { schoolId: string }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const list = useLoad<any[]>(`/schools/${schoolId}/library/books?q=${encodeURIComponent(term)}`, [schoolId, term]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setTerm(q), 300); return () => clearTimeout(t); }, [q]);
  return (
    <section className="tile">
      <div className="tile-head">
        <div><h2>Catalogue</h2><p className="muted" style={{ marginTop: 6 }}>Search by title, author, ISBN, subject, call number, barcode or accession number.</p></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn quiet small" onClick={() => saveFile(`/schools/${schoolId}/library/register`, 'accession-register.csv')}>Accession register</button>
          <button className="btn small" onClick={() => setAdding(true)}>Add books</button>
        </div>
      </div>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the catalogue" />
      {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>No books found.</Empty> : (
        <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
          <thead><tr><th>Title</th><th>Author</th><th>Call no.</th><th className="num">Copies</th><th className="num">Available</th><th className="num">On loan</th></tr></thead>
          <tbody>{list.data.map((b) => (
            <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
              <td style={{ fontWeight: 600 }}>{b.title}<div className="tiny muted">{[b.publisher, b.edition, b.year].filter(Boolean).join(' · ')}</div></td>
              <td className="small">{b.author}</td><td className="small mono">{b.call_number}</td>
              <td className="num">{b.copies}</td><td className="num">{b.available}</td><td className="num">{b.on_loan}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {adding && <AddBook schoolId={schoolId} onClose={() => { setAdding(false); list.reload(); }} />}
      {open && <BookDrawer id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </section>
  );
}

function AddBook({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const [f, setF] = useState({ title: '', author: '', publisher: '', edition: '', year: '', isbn: '', subject: '', language: 'English', callNumber: '', price: '', copies: '1', location: '', source: 'PURCHASE' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Drawer title="Add books" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field"><span>Author</span><input className="input" value={f.author} onChange={(e) => set({ author: e.target.value })} /></label>
          <label className="field"><span>Publisher</span><input className="input" value={f.publisher} onChange={(e) => set({ publisher: e.target.value })} /></label>
          <label className="field"><span>Edition</span><input className="input" value={f.edition} onChange={(e) => set({ edition: e.target.value })} /></label>
          <label className="field"><span>Year</span><input className="input" inputMode="numeric" value={f.year} onChange={(e) => set({ year: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
          <label className="field"><span>ISBN</span><input className="input" value={f.isbn} onChange={(e) => set({ isbn: e.target.value })} /></label>
          <label className="field"><span>Subject</span><input className="input" value={f.subject} onChange={(e) => set({ subject: e.target.value })} /></label>
          <label className="field"><span>Language</span><input className="input" value={f.language} onChange={(e) => set({ language: e.target.value })} /></label>
          <label className="field"><span>Call number</span><input className="input" value={f.callNumber} placeholder="For example 920 KAL" onChange={(e) => set({ callNumber: e.target.value })} /></label>
          <label className="field"><span>Price per copy (₹)</span><input className="input" inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value.replace(/[^\d.]/g, '') })} /></label>
          <label className="field"><span>Copies</span><input className="input" inputMode="numeric" value={f.copies} onChange={(e) => set({ copies: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="field"><span>Shelf / rack</span><input className="input" value={f.location} onChange={(e) => set({ location: e.target.value })} /></label>
          <label className="field"><span>Came by</span><select className="input" value={f.source} onChange={(e) => set({ source: e.target.value })}><option value="PURCHASE">Purchase</option><option value="DONATION">Donation</option><option value="OTHER">Other</option></select></label>
        </div>
        <p className="small muted">Each copy gets the next accession number and a barcode. Print the labels from the Labels tab.</p>
        <button className="btn big" disabled={busy || !f.title.trim() || !Number(f.copies)} onClick={async () => {
          const r: any = await run(() => api(`/schools/${schoolId}/library/books`, { body: { title: f.title, author: f.author, publisher: f.publisher, edition: f.edition, year: f.year ? Number(f.year) : null,
            isbn: f.isbn || null, subject: f.subject, language: f.language, callNumber: f.callNumber, pricePaise: Math.round(Number(f.price || 0) * 100), copies: Number(f.copies), location: f.location, source: f.source } }));
          if (r) { toast(`Added ${r.copies.length} cop${r.copies.length === 1 ? 'y' : 'ies'}: accession ${r.copies[0].accessionNo}${r.copies.length > 1 ? `–${r.copies[r.copies.length - 1].accessionNo}` : ''}`); onClose(); }
        }}>Add to the catalogue</button>
      </section>
    </Drawer>
  );
}

function BookDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const b = useLoad<any>(`/library/books/${id}`);
  const { run, busy } = useAction();
  const [more, setMore] = useState('1');
  const d = b.data;
  return (
    <Drawer title={d?.title ?? 'Book'} onClose={onClose}>
      {!d ? <Empty>Loading…</Empty> : (<>
        <section className="tile tight stack small">
          <div>{[d.author, d.publisher, d.edition, d.year].filter(Boolean).join(' · ')}</div>
          <div className="muted">{[d.isbn ? `ISBN ${d.isbn}` : '', d.call_number ? `Call no. ${d.call_number}` : '', d.subject, d.language, d.price_paise ? money(d.price_paise) : ''].filter(Boolean).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input" style={{ width: 80 }} inputMode="numeric" value={more} onChange={(e) => setMore(e.target.value.replace(/\D/g, ''))} aria-label="Copies to add" />
            <button className="btn quiet small" disabled={busy || !Number(more)} onClick={async () => { if (await run(() => api(`/library/books/${id}/copies`, { body: { copies: Number(more) } }), 'Copies added')) b.reload(); }}>Add copies</button>
          </div>
        </section>
        <section className="tile tight">
          <h3>Copies</h3>
          {d.copies.map((c: any) => (
            <div key={c.id} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <div><strong>Acc. {c.accession_no}</strong> <span className="mono muted">{c.barcode}</span>
                <div className="tiny muted">{c.status === 'ON_LOAN' ? `With ${c.borrower}, due ${day(c.due_on)}` : words(c.status)}{c.location ? ` · ${c.location}` : ''}{c.label_printed_at ? '' : ' · label not printed'}</div></div>
              <div style={{ display: 'flex', gap: 6 }}>
                {c.status !== 'ON_LOAN' && c.status !== 'AVAILABLE' && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/library/copies/${c.id}/status`, { body: { status: 'AVAILABLE' } }), 'Back on the shelf')) b.reload(); }}>On shelf</button>}
                {c.status === 'AVAILABLE' && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/library/copies/${c.id}/status`, { body: { status: 'DAMAGED' } }), 'Marked damaged')) b.reload(); }}>Damaged</button>}
                {['AVAILABLE', 'DAMAGED'].includes(c.status) && <button className="btn quiet small" disabled={busy} onClick={async () => { if (await run(() => api(`/library/copies/${c.id}/status`, { body: { status: 'WITHDRAWN' } }), 'Withdrawn from stock')) b.reload(); }}>Withdraw</button>}
              </div>
            </div>))}
        </section>
      </>)}
    </Drawer>
  );
}

// ── Overdue ──────────────────────────────────────────────────────────────────────────────

function Overdue({ schoolId }: { schoolId: string }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/library/overdue`, [schoolId]);
  return (
    <section className="tile">
      <h2>Overdue</h2>
      {!list.data ? <Empty>Loading…</Empty> : !list.data.length ? <Empty>Nothing is overdue.</Empty> : (
        <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
          <thead><tr><th>Borrower</th><th>Book</th><th>Due</th><th className="num">Days late</th></tr></thead>
          <tbody>{list.data.map((l) => (
            <tr key={l.id}><td style={{ fontWeight: 600 }}>{l.borrower}<div className="tiny muted">{l.detail}</div></td><td>{l.title}<div className="tiny muted mono">{l.barcode}</div></td>
              <td>{day(l.due_on)}</td><td className="num" style={{ color: 'var(--red)', fontWeight: 600 }}>{l.days_late}</td></tr>))}</tbody>
        </table></div>
      )}
    </section>
  );
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────

export function usePrinters(schoolId: string, purpose: string) {
  const { data } = useLoad<any[]>(schoolId ? `/schools/${schoolId}/printers` : null, [schoolId]);
  return (data ?? []).filter((p) => p.purpose === purpose);
}

export function PrinterPicker({ schoolId, purpose, value, onChange }: { schoolId: string; purpose: string; value: string; onChange: (v: string) => void }) {
  const printers = usePrinters(schoolId, purpose);
  useEffect(() => { if (!value && printers.length) onChange(printers[0].id); }, [printers, value, onChange]);
  return (
    <label className="field"><span>Printer</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No correction</option>
        {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
  );
}

export const PRINT_NOTE = 'In the print dialog choose "Actual size" (100%), not "Fit to page", so everything lands where it should.';

function Labels({ schoolId, onPrinted }: { schoolId: string; onPrinted: () => void }) {
  const sheets = useLoad<any[]>(`/schools/${schoolId}/label-sheets`, [schoolId]);
  const { run, busy } = useAction();
  const toast = useToast();
  const [f, setF] = useState({ which: 'unprinted', from: '', to: '', sheetId: '', startAt: '1', printerId: '' });
  useEffect(() => { if (!f.sheetId && sheets.data?.length) setF((x) => ({ ...x, sheetId: sheets.data![0].id })); }, [sheets.data, f.sheetId]);
  const sheet = sheets.data?.find((s) => s.id === f.sheetId);
  const per = sheet ? sheet.cols * sheet.rows : 0;
  return (
    <section className="tile stack">
      <h2>Barcode labels</h2>
      <p className="muted">Labels carry the school, call number, barcode, accession number and title. Copies brought over from the old ERP keep their old labels and are not reprinted.</p>
      <div className="form-grid">
        <label className="field"><span>Which copies</span><select className="input" value={f.which} onChange={(e) => setF({ ...f, which: e.target.value })}>
          <option value="unprinted">Every copy without a label yet</option><option value="range">A range of accession numbers (reprint)</option></select></label>
        {f.which === 'range' && <>
          <label className="field"><span>From accession</span><input className="input" inputMode="numeric" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="field"><span>To accession</span><input className="input" inputMode="numeric" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value.replace(/\D/g, '') })} /></label>
        </>}
        <label className="field"><span>Label stationery</span><select className="input" value={f.sheetId} onChange={(e) => setF({ ...f, sheetId: e.target.value, startAt: '1' })}>
          {(sheets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {per > 1 && <label className="field"><span>Start at label (1–{per})</span><input className="input" inputMode="numeric" value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value.replace(/\D/g, '') })} /></label>}
        <PrinterPicker schoolId={schoolId} purpose="LABELS" value={f.printerId} onChange={(v) => setF((x) => ({ ...x, printerId: v }))} />
      </div>
      {per > 1 && <p className="small muted">On a part-used sheet, count across then down: label {f.startAt || 1} is row {Math.ceil(Number(f.startAt || 1) / sheet.cols)}, column {((Number(f.startAt || 1) - 1) % sheet.cols) + 1}.</p>}
      <p className="small muted">{PRINT_NOTE}</p>
      <div><button className="btn big" disabled={busy || !f.sheetId || (f.which === 'range' && (!f.from || !f.to))} onClick={async () => {
        const h = await run(() => openPdf(`/schools/${schoolId}/library/labels`, { sheetId: f.sheetId, startAt: Number(f.startAt || 1), printerId: f.printerId || null,
          ...(f.which === 'range' ? { fromAccession: Number(f.from), toAccession: Number(f.to) } : { unprinted: true }) }));
        if (h) { toast(`${h.get('x-count')} labels on ${h.get('x-pages')} page${h.get('x-pages') === '1' ? '' : 's'}`); onPrinted(); }
      }}>Make labels</button></div>
    </section>
  );
}

// ── Import from the old ERP ──────────────────────────────────────────────────────────────

function Import({ schoolId, onDone }: { schoolId: string; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useAction();
  const check = async (text: string, map?: Record<string, number | null>) => {
    const p: any = await run(() => api(`/schools/${schoolId}/library/import/preview`, { body: { csv: text, mapping: map } }));
    if (p) { setPreview(p); setMapping(p.mapping); }
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="tile stack">
        <h2>Books from the old ERP</h2>
        <p className="muted">Export the book list from the old system as a spreadsheet and save it as CSV (in Excel: File → Save As → CSV). Each copy keeps its accession number and the barcode or QR code already on its label, so no book needs relabelling. Copies without a code get a new barcode label.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="btn quiet" style={{ cursor: 'pointer' }}>Choose the CSV file<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return; const text = await readText(file); setCsv(text); setName(file.name); setResult(null); await check(text);
          }} /></label>
          {name && <span className="small muted">{name}</span>}
          <button className="btn quiet small" onClick={() => saveFile('/library/import-template', 'library-import-template.csv')}>Example layout</button>
        </div>
        {preview && <>
          <div className="kpis">
            <div><div className="kpi-label">Copies</div><div className="kpi-value">{num(preview.copies)}</div><div className="kpi-note">{num(preview.books)} titles</div></div>
            <div><div className="kpi-label">Keep their label</div><div className="kpi-value">{num(preview.keepLabels)}</div></div>
            <div><div className="kpi-label">Need a new label</div><div className="kpi-value">{num(preview.needLabels)}</div></div>
            <div><div className="kpi-label">Rows with problems</div><div className="kpi-value" style={{ color: preview.withErrors ? 'var(--red)' : 'var(--green)' }}>{num(preview.withErrors)}</div></div>
          </div>
          <h3 style={{ marginTop: 8 }}>Columns</h3>
          <p className="small muted">Matched by their names. Change any that are wrong, then check again.</p>
          <div className="form-grid">{Object.entries(preview.fields).map(([k, def]: [string, any]) => (
            <label key={k} className="field"><span>{def.label}{def.required ? ' (needed)' : ''}</span>
              <select className="input" value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">Not in the file</option>{preview.headers.map((h: string, i: number) => <option key={i} value={i}>{h}</option>)}</select></label>))}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn quiet" disabled={busy} onClick={() => check(csv, mapping)}>Check again</button>
            <button className="btn" disabled={busy || preview.withErrors > 0} onClick={async () => {
              const r = await run(() => api(`/schools/${schoolId}/library/import`, { body: { csv, mapping } }));
              if (r) { setResult(r); setPreview(null); onDone(); }
            }}>Import {num(preview.copies)} copies</button>
          </div>
          {preview.rows.length > 0 && <div className="scroll-x"><table className="table">
            <thead><tr><th>Line</th><th>Title</th><th>Accession</th><th>Code</th><th>What to look at</th></tr></thead>
            <tbody>{preview.rows.map((r: any) => (
              <tr key={r.line}><td>{r.line}</td><td>{r.title}</td><td>{r.accession ?? ''}</td><td className="mono tiny">{r.code ?? ''}</td>
                <td className="small">{r.errors.map((e: string) => <div key={e} style={{ color: 'var(--red)' }}>{e}</div>)}{r.warnings.map((w: string) => <div key={w} className="muted">{w}</div>)}</td></tr>))}</tbody>
          </table></div>}
        </>}
        {result && <div className="callout green">Imported {num(result.copies)} copies of {num(result.books)} titles. {num(result.keptLabels)} keep their old labels; {num(result.labelsToPrint)} need new labels (Labels tab). The next new book will be accession {result.nextAccession}.</div>}
      </section>
      <LoanImport schoolId={schoolId} onDone={onDone} />
    </div>
  );
}

function LoanImport({ schoolId, onDone }: { schoolId: string; onDone: () => void }) {
  const { run, busy } = useAction();
  const [done, setDone] = useState<number | null>(null);
  return (
    <section className="tile stack">
      <h2>Books on loan in the old ERP</h2>
      <p className="muted">After the book list, import who has which book: a CSV with the borrower (admission number, NES ID or staff number), the book (its label code or accession number), the issue date and the due date.</p>
      <div><label className="btn quiet" style={{ cursor: 'pointer' }}>Choose the loans CSV<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        const text = await readText(file);
        const r: any = await run(() => api(`/schools/${schoolId}/library/import-loans`, { body: { csv: text } }));
        if (r) { setDone(r.loans); onDone(); }
      }} /></label></div>
      {done !== null && <div className="callout green">{num(done)} loans brought over. Their due dates and any overdue books now show on the desk.</div>}
    </section>
  );
}
