import { useState } from 'react';
import { allowed, api, apiFile, day, money, today, words, type User } from '../api';
import { Drawer, Empty, useAction, useLoad, ask, tell } from '../ui';
import { useSchool } from './Payroll';

/**
 * The store (store keeper, principal, accountant): stock with low-stock and expiry warnings, issues
 * and adjustments, indents to approve and issue, purchase orders (prepared by one person and
 * approved by another), goods received into stock or onto the asset register and into the books,
 * paying suppliers, the asset register with QR tags, services due, audits by scanning, the
 * year's depreciation and writing assets off. Any member of staff raises an indent from Indents.
 */

const CATS = ['STATIONERY', 'IT', 'CONSUMABLE', 'LAB', 'SPORTS', 'MEDICINE', 'FURNITURE', 'CLEANING', 'UNIFORM', 'OTHER'];
const openFile = async (path: string, body?: unknown) => { const { blob } = await apiFile(path, body ? { body } : {}); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
const STATUS_TONE: Record<string, string> = { SUBMITTED: 'blue', APPROVED: 'green', REJECTED: 'red', ISSUED: 'green', ORDERED: 'blue', DRAFT: 'orange', PART_RECEIVED: 'blue', RECEIVED: 'green', CANCELLED: '', IN_USE: 'green', IN_REPAIR: 'orange', MISSING: 'red', DISPOSED: '' };
const Pill = ({ s }: { s: string }) => <span className={`pill ${STATUS_TONE[s] ?? ''}`}>{words(s)}</span>;

export function Stores({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const [tab, setTab] = useState('overview');
  const o = useLoad<any>(schoolId ? `/schools/${schoolId}/stores` : null, [schoolId, tab]);
  // NES, the Command and the accountant look; the store keeper and principal run the store; the accountant and principal pay.
  const may = { manage: allowed(user, 'stores.manage', schoolId), pay: allowed(user, 'stores.pay', schoolId), principal: user.role === 'SCHOOL_ADMIN' };
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Stores</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <div className="seg">{[['overview', 'Overview'], ['items', 'Stock'], ['indents', `Indents${o.data?.indentsWaiting ? ` (${o.data.indentsWaiting})` : ''}`], ['orders', 'Orders'], ['assets', 'Assets']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div></div></div>
      <main className="page">
        {!schoolId ? <Empty>Loading…</Empty> : tab === 'overview' ? <Overview o={o.data} error={o.error} />
          : tab === 'items' ? <Items schoolId={schoolId} manage={may.manage} /> : tab === 'indents' ? <IndentList schoolId={schoolId} user={user} manage={may.manage} />
          : tab === 'orders' ? <Orders schoolId={schoolId} may={may} /> : <Assets schoolId={schoolId} may={may} />}
      </main>
    </>
  );
}

function Overview({ o, error }: { o: any; error?: string | null }) {
  if (!o) return <Empty>{error ?? 'Loading…'}</Empty>;
  return <>
    <section className="tile"><div className="kpis">
      <div><div className="kpi-label">Assets in use</div><div className="kpi-value">{o.assets.in_use}</div><div className="kpi-note">{o.assets.in_repair} in repair · {o.assets.missing} missing</div></div>
      <div><div className="kpi-label">Book value of assets</div><div className="kpi-value">{money(o.assets.book_value_paise)}</div></div>
      <div><div className="kpi-label">Owed to suppliers</div><div className="kpi-value">{money(o.owedPaise)}</div></div>
      <div><div className="kpi-label">Indents waiting</div><div className="kpi-value">{o.indentsWaiting}</div></div>
    </div></section>
    <section className="tile"><h3>Running low</h3>{!o.low.length ? <Empty>Nothing below its reorder level.</Empty> : o.low.map((i: any) => <div key={i.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{i.name}</b> {i.code}</span><span className="pill orange">{i.balance} {i.unit} (reorder at {i.reorder_level})</span></div>)}</section>
    <section className="tile"><h3>Expiring in 60 days</h3>{!o.expiring.length ? <Empty>Nothing expiring.</Empty> : o.expiring.map((x: any, k: number) => <div key={k} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{x.name}</b> batch {x.batch ?? '—'} · {x.left} {x.unit}</span><span className={`pill ${x.expiry < today() ? 'red' : 'orange'}`}>{x.expiry < today() ? 'Expired ' : ''}{day(x.expiry)}</span></div>)}</section>
    <section className="tile"><h3>Services due in 30 days</h3>{!o.services.length ? <Empty>None due.</Empty> : o.services.map((x: any) => <div key={x.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{x.name}</b> {x.tag} · {x.kind} · {x.location}</span><span className={`pill ${x.overdue ? 'red' : 'orange'}`}>{day(x.due_on)}</span></div>)}</section>
  </>;
}

function Items({ schoolId, manage }: { schoolId: string; manage: boolean }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/store-items`, [schoolId]);
  const [edit, setEdit] = useState<any>(null);
  const [move, setMove] = useState<any>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [q, setQ] = useState('');
  const rows = (list.data ?? []).filter((i) => !q || `${i.name} ${i.code} ${i.category}`.toLowerCase().includes(q.toLowerCase()));
  return <section className="tile">
    <div className="tile-head"><h3>Items and stock</h3><span style={{ display: 'flex', gap: 6 }}><input className="input" style={{ height: 34 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />{manage && <button className="btn small" onClick={() => setEdit({})}>New item</button>}</span></div>
    {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : <div className="scroll-x"><table className="table">
      <thead><tr><th>Item</th><th>Category</th><th className="num">In stock</th><th className="num">Value</th><th>Next expiry</th><th /></tr></thead>
      <tbody>{rows.map((i) => <tr key={i.id}><td><b>{i.name}</b> <span className="tiny muted mono">{i.code}</span>{!i.active && <span className="pill" style={{ marginLeft: 4 }}>Not used</span>}</td><td className="small">{words(i.category)}{i.kind === 'ASSET' ? ' · asset' : ''}</td>
        <td className="num">{i.kind === 'ASSET' ? `${i.assets} on register` : <span style={{ color: i.low ? 'var(--orange)' : undefined }}>{i.balance} {i.unit}</span>}</td><td className="num">{i.kind === 'ASSET' ? '' : money(i.value_paise)}</td>
        <td className="small">{i.next_expiry ? day(i.next_expiry) : ''}</td>
        <td><span style={{ display: 'flex', gap: 4 }}>{manage && i.kind === 'CONSUMABLE' && <button className="linkbtn small" onClick={() => setMove(i)}>Issue / add</button>}<button className="linkbtn small" onClick={() => setLedger(i)}>Ledger</button>{manage && <button className="linkbtn small" onClick={() => setEdit(i)}>Edit</button>}</span></td></tr>)}</tbody></table></div>}
    {edit && <ItemDrawer schoolId={schoolId} item={edit} onClose={() => { setEdit(null); list.reload(); }} />}
    {move && <MoveDrawer schoolId={schoolId} item={move} onClose={() => { setMove(null); list.reload(); }} />}
    {ledger && <LedgerDrawer item={ledger} onClose={() => setLedger(null)} />}
  </section>;
}

function ItemDrawer({ schoolId, item, onClose }: { schoolId: string; item: any; onClose: () => void }) {
  const [f, setF] = useState({ code: item.code ?? '', name: item.name ?? '', category: item.category ?? 'STATIONERY', kind: item.kind ?? 'CONSUMABLE', unit: item.unit ?? 'nos', reorderLevel: String(item.reorder_level ?? 0), trackExpiry: !!item.track_expiry, lifeYears: String(item.life_years ?? ''), active: item.active ?? true });
  const { run, busy } = useAction();
  return <Drawer title={item.id ? item.name : 'New item'} onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Code</span><input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Category</span><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{words(c)}</option>)}</select></label>
      <label className="field"><span>Kind</span><select className="input" value={f.kind} disabled={!!item.id} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="CONSUMABLE">Used up (kept as stock)</option><option value="ASSET">Asset (on the register, with a tag)</option></select></label>
      {f.kind === 'CONSUMABLE' ? <><label className="field"><span>Unit</span><input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label>
        <label className="field"><span>Reorder below</span><input className="input" inputMode="decimal" value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })} /></label></>
        : <label className="field"><span>Useful life (years)</span><input className="input" inputMode="numeric" value={f.lifeYears} onChange={(e) => setF({ ...f, lifeYears: e.target.value })} /></label>}
    </div>
    {f.kind === 'CONSUMABLE' && <label className="check small"><input type="checkbox" checked={f.trackExpiry} onChange={(e) => setF({ ...f, trackExpiry: e.target.checked })} />Has expiry dates (medicines, lab chemicals): issued first-expiry-first-out</label>}
    {item.id && <label className="check small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />In use</label>}
    <button className="btn big" disabled={busy || !f.code || f.name.trim().length < 2} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/store-items`, { body: { ...(item.id ? { id: item.id } : {}), ...f, reorderLevel: Number(f.reorderLevel) || 0, lifeYears: f.lifeYears ? Number(f.lifeYears) : null } }), 'Saved')) onClose(); }}>Save</button>
  </section></Drawer>;
}

function MoveDrawer({ schoolId, item, onClose }: { schoolId: string; item: any; onClose: () => void }) {
  const staff = useLoad<any[]>(`/schools/${schoolId}/staff`, [schoolId]);
  const [mode, setMode] = useState('ISSUE');
  const [f, setF] = useState({ qty: '', department: '', issuedTo: '', note: '', batch: '', expiry: '', unitRupees: '' });
  const { run, busy } = useAction();
  return <Drawer title={item.name} onClose={onClose}><section className="tile tight stack">
    <p className="small">In stock: <b>{item.balance} {item.unit}</b></p>
    <div className="seg">{[['ISSUE', 'Issue'], ['RETURN', 'Returned'], ['OPENING', 'Received / opening'], ['ADJUST', 'Correct after counting']].map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>
    <div className="form-grid">
      <label className="field"><span>{mode === 'ADJUST' ? 'Change (+ or −)' : 'Quantity'}</span><input className="input" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
      {mode === 'ISSUE' && <><label className="field"><span>Department</span><input className="input" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} placeholder="Office, Chemistry lab" /></label>
        <label className="field"><span>Given to</span><select className="input" value={f.issuedTo} onChange={(e) => setF({ ...f, issuedTo: e.target.value })}><option value="">—</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></>}
      {mode === 'OPENING' && <><label className="field"><span>Rate (₹ each)</span><input className="input" inputMode="decimal" value={f.unitRupees} onChange={(e) => setF({ ...f, unitRupees: e.target.value })} /></label>
        {item.track_expiry && <><label className="field"><span>Batch</span><input className="input" value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })} /></label>
          <label className="field"><span>Expiry</span><input className="input" type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} /></label></>}</>}
    </div>
    {mode !== 'ISSUE' && <label className="field"><span>Why</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={mode === 'ADJUST' ? 'Counted on 20 Oct: 2 damaged' : 'Opening stock'} /></label>}
    <p className="tiny muted">Goods bought through a purchase order come in when you record the receipt under Orders (with the bill in the books).</p>
    <button className="btn big" disabled={busy || !Number(f.qty) || (mode === 'ISSUE' ? f.department.trim().length < 2 : f.note.trim().length < 3)} onClick={async () => {
      const r = mode === 'ISSUE'
        ? await run(() => api(`/schools/${schoolId}/stock/issue`, { body: { itemId: item.id, qty: Number(f.qty), department: f.department, issuedTo: f.issuedTo || null } }), 'Issued')
        : await run(() => api(`/schools/${schoolId}/stock/adjust`, { body: { itemId: item.id, kind: mode, qty: Number(f.qty), note: f.note, batch: f.batch || undefined, expiry: f.expiry || null, unitPaise: f.unitRupees ? Math.round(Number(f.unitRupees) * 100) : null } }), 'Saved');
      if (r) onClose();
    }}>Save</button>
  </section></Drawer>;
}

function LedgerDrawer({ item, onClose }: { item: any; onClose: () => void }) {
  const l = useLoad<any[]>(`/store-items/${item.id}/ledger`);
  return <Drawer title={`${item.name} · stock ledger`} onClose={onClose}><section className="tile tight">
    {!l.data ? <Empty>Loading…</Empty> : !l.data.length ? <Empty>No movements.</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>When</th><th>What</th><th className="num">Qty</th><th className="num">Balance</th></tr></thead>
      <tbody>{l.data.map((m, k) => <tr key={k}><td className="small">{day(m.at)}</td><td className="small">{words(m.kind)}{m.department ? ` · ${m.department}` : ''}{m.issued_to ? ` · ${m.issued_to}` : ''}{m.batch ? ` · batch ${m.batch}` : ''}{m.ref_id ? ` · ${m.ref_id}` : ''}{m.note ? ` · ${m.note}` : ''}</td>
        <td className="num" style={{ color: m.qty < 0 ? 'var(--red)' : undefined }}>{m.qty > 0 ? '+' : ''}{m.qty}</td><td className="num">{m.balance}</td></tr>)}</tbody></table></div>}
  </section></Drawer>;
}

/** Indents: any member of staff raises one; the principal approves; the store keeper issues or orders. */
export function IndentList({ schoolId: given, user, manage }: { schoolId?: string; user: User; manage?: boolean }) {
  const [picked, picker] = useSchool();
  const schoolId = given ?? picked;
  const list = useLoad<any[]>(schoolId ? `/schools/${schoolId}/indents` : null, [schoolId]);
  const [raise, setRaise] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const body = <section className="tile">
    <div className="tile-head"><div><h3>Indents</h3><p className="tiny muted">Ask the store for what your department needs. The principal approves; the store keeper issues it or orders it.</p></div><button className="btn small" onClick={() => setRaise(true)}>Raise an indent</button></div>
    {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No indents.</Empty> : list.data.map((i) => <div key={i.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{i.number}</b><span className="small">{i.department}</span><Pill s={i.status} /><span className="tiny muted">{i.requested_by} · {day(i.created_at)}{i.needed_by ? ` · needed by ${day(i.needed_by)}` : ''}{i.decided_by ? ` · ${i.status === 'REJECTED' ? 'refused' : 'approved'} by ${i.decided_by}` : ''}</span></div>
      {i.purpose && <div className="small">{i.purpose}</div>}
      <div className="small">{(i.lines ?? []).map((l: any) => `${l.description} × ${l.qty}${manage && l.itemId ? ` (${l.balance} in stock)` : ''}`).join(' · ')}</div>
      {i.decision_note && <div className="tiny muted">“{i.decision_note}”</div>}
      {user.role === 'SCHOOL_ADMIN' && i.status === 'SUBMITTED' && <div style={{ display: 'flex', gap: 6 }}><input className="input" style={{ flex: 1 }} placeholder="Note (needed to refuse)" value={note[i.id] ?? ''} onChange={(e) => setNote({ ...note, [i.id]: e.target.value })} />
        <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/indents/${i.id}/decide`, { body: { approve: true, note: note[i.id] } }), 'Approved')) list.reload(); }}>Approve</button>
        <button className="btn quiet small" disabled={busy || !(note[i.id] ?? '').trim()} onClick={async () => { if (await run(() => api(`/indents/${i.id}/decide`, { body: { approve: false, note: note[i.id] } }), 'Refused')) list.reload(); }}>Refuse</button></div>}
      {manage && i.status === 'APPROVED' && <div><button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/indents/${i.id}/issue`, { body: {} })); if (r) { await tell(r.short.length ? `Issued what was in stock. To order: ${r.short.join(', ')}` : 'Issued in full.'); list.reload(); } }}>Issue from stock</button></div>}
    </div>)}
    {raise && <RaiseIndent schoolId={schoolId} onClose={() => { setRaise(false); list.reload(); }} />}
  </section>;
  if (given) return body;
  return <><div className="localnav"><div className="localnav-in"><span className="localnav-title">Indents</span><span className="spacer" style={{ flex: 1 }} />{picker}</div></div><main className="page">{body}</main></>;
}

function RaiseIndent({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const items = useLoad<any[]>(`/schools/${schoolId}/store-items`, [schoolId]);
  const [f, setF] = useState({ department: '', purpose: '', neededBy: '' });
  const [lines, setLines] = useState<{ itemId: string; description: string; qty: string }[]>([{ itemId: '', description: '', qty: '1' }]);
  const { run, busy } = useAction();
  return <Drawer title="Raise an indent" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Department</span><input className="input" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} placeholder="Physics lab" /></label>
      <label className="field"><span>Needed by</span><input className="input" type="date" min={today()} value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></label>
    </div>
    <label className="field"><span>What for</span><input className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
    {lines.map((l, i) => <div key={i} style={{ display: 'flex', gap: 6 }}>
      <select className="input" style={{ flex: 2 }} value={l.itemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}><option value="">Something not on the list…</option>{(items.data ?? []).filter((it) => it.active !== false).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
      {!l.itemId && <input className="input" style={{ flex: 2 }} placeholder="Describe it" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />}
      <input className="input" style={{ width: 80 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></div>)}
    <button className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setLines([...lines, { itemId: '', description: '', qty: '1' }])}>Add a line</button>
    <button className="btn big" disabled={busy || f.department.trim().length < 2 || !lines.some((l) => (l.itemId || l.description.trim()) && Number(l.qty) > 0)} onClick={async () => {
      const r = await run(() => api(`/schools/${schoolId}/indents`, { body: { department: f.department, purpose: f.purpose, neededBy: f.neededBy || null, lines: lines.filter((l) => (l.itemId || l.description.trim()) && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId || null, description: l.description || undefined, qty: Number(l.qty) })) } }), 'Sent to the principal');
      if (r) onClose();
    }}>Send</button>
  </section></Drawer>;
}

type May = { manage: boolean; pay: boolean; principal: boolean };
function Orders({ schoolId, may }: { schoolId: string; may: May }) {
  const list = useLoad<any[]>(`/schools/${schoolId}/purchase-orders`, [schoolId]);
  const sup = useLoad<any[]>(`/schools/${schoolId}/suppliers`, [schoolId]);
  const [po, setPo] = useState(false);
  const [rec, setRec] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [supplier, setSupplier] = useState(false);
  const { run, busy } = useAction();
  return <>
    <section className="tile"><div className="tile-head"><h3>Purchase orders</h3>{may.manage && <span style={{ display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => setSupplier(true)}>Add a supplier</button><button className="btn small" onClick={() => setPo(true)}>New order</button></span>}</div>
      {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No orders.</Empty> : list.data.map((o) => <div key={o.id} className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{o.number}</b><span className="small">{o.supplier}</span><Pill s={o.status} /><b className="small">{money(o.total_paise)}</b>
          <span className="tiny muted">prepared by {o.prepared_by}{o.approved_by ? ` · approved by ${o.approved_by}` : ''}{o.indent ? ` · for ${o.indent}` : ''}</span></div>
        <div className="small">{(o.lines ?? []).map((l: any) => `${l.item} ${l.received}/${l.qty} ${l.unit} at ${money(l.unitPaise)}${l.gstPct ? ` + ${l.gstPct}% GST` : ''}`).join(' · ')}</div>
        {(o.receipts ?? []).map((g: any) => <div key={g.id} className="tiny">{g.number} · invoice {g.invoiceNo} · {day(g.receivedOn)} · {money(g.amount)} · paid {money(g.paid)}
          {g.paid < g.amount && may.pay && <button className="linkbtn tiny" style={{ marginLeft: 6 }} onClick={() => setPay({ ...g, supplier: o.supplier })}>Pay</button>}</div>)}
        <div style={{ display: 'flex', gap: 6 }}><button className="btn quiet small" onClick={() => run(() => openFile(`/purchase-orders/${o.id}/pdf`))}>PDF</button>
          {o.status === 'DRAFT' && may.principal && <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/purchase-orders/${o.id}/approve`, { body: {} }), 'Approved and issued')) list.reload(); }}>Approve and issue</button>}
          {may.manage && ['ISSUED', 'PART_RECEIVED'].includes(o.status) && <button className="btn small" onClick={() => setRec(o)}>Record goods received</button>}</div>
      </div>)}</section>
    <section className="tile"><h3>Suppliers</h3>{(sup.data ?? []).map((s) => <div key={s.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span><b>{s.name}</b> {s.gstin ? `GSTIN ${s.gstin}` : ''} {s.phone ?? ''}</span><span>{s.owed_paise ? `Owed ${money(s.owed_paise)}` : ''}</span></div>)}</section>
    {po && <PoDrawer schoolId={schoolId} suppliers={sup.data ?? []} onClose={() => { setPo(false); list.reload(); }} />}
    {rec && <ReceiveDrawer order={rec} onClose={() => { setRec(null); list.reload(); }} />}
    {pay && <PayDrawer grn={pay} onClose={() => { setPay(null); list.reload(); sup.reload(); }} />}
    {supplier && <SupplierDrawer schoolId={schoolId} onClose={() => { setSupplier(false); sup.reload(); }} />}
  </>;
}

function SupplierDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', gstin: '', phone: '', email: '', address: '' });
  const { run, busy } = useAction();
  return <Drawer title="Add a supplier" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">{(['name', 'gstin', 'phone', 'email', 'address'] as const).map((k) => <label key={k} className="field"><span>{k === 'gstin' ? 'GSTIN' : words(k)}</span><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: k === 'gstin' ? e.target.value.toUpperCase() : e.target.value })} /></label>)}</div>
    <button className="btn big" disabled={busy || f.name.trim().length < 2} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/suppliers`, { body: { ...f, gstin: f.gstin || null } }), 'Saved')) onClose(); }}>Save</button>
  </section></Drawer>;
}

function PoDrawer({ schoolId, suppliers, onClose }: { schoolId: string; suppliers: any[]; onClose: () => void }) {
  const items = useLoad<any[]>(`/schools/${schoolId}/store-items`, [schoolId]);
  const indents = useLoad<any[]>(`/schools/${schoolId}/indents`, [schoolId]);
  const [f, setF] = useState({ supplierId: suppliers[0]?.id ?? '', indentId: '', terms: 'Delivery within 15 days. Payment within 30 days of the invoice.' });
  const [lines, setLines] = useState<{ itemId: string; qty: string; rate: string; gst: string }[]>([{ itemId: '', qty: '1', rate: '', gst: '18' }]);
  const { run, busy } = useAction();
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0) * (1 + Number(l.gst || 0) / 100), 0);
  return <Drawer title="New purchase order" onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Supplier</span><select className="input" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Choose</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field"><span>Against an indent</span><select className="input" value={f.indentId} onChange={(e) => setF({ ...f, indentId: e.target.value })}><option value="">None (restocking)</option>{(indents.data ?? []).filter((i) => i.status === 'APPROVED').map((i) => <option key={i.id} value={i.id}>{i.number} · {i.department}</option>)}</select></label>
    </div>
    {lines.map((l, i) => <div key={i} style={{ display: 'flex', gap: 6 }}>
      <select className="input" style={{ flex: 2 }} value={l.itemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}><option value="">Item</option>{(items.data ?? []).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
      <input className="input" style={{ width: 70 }} placeholder="Qty" inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
      <input className="input" style={{ width: 100 }} placeholder="Rate ₹" inputMode="decimal" value={l.rate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
      <select className="input" style={{ width: 80 }} value={l.gst} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, gst: e.target.value } : x)))}>{['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}</select></div>)}
    <button className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => setLines([...lines, { itemId: '', qty: '1', rate: '', gst: '18' }])}>Add a line</button>
    <label className="field"><span>Terms</span><input className="input" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></label>
    <p className="small">Total with GST: <b>{money(Math.round(total * 100))}</b>. The principal approves it before it is issued.</p>
    <button className="btn big" disabled={busy || !f.supplierId || !lines.some((l) => l.itemId && Number(l.qty) > 0)} onClick={async () => {
      const r = await run(() => api(`/schools/${schoolId}/purchase-orders`, { body: { supplierId: f.supplierId, indentId: f.indentId || null, terms: f.terms, lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitPaise: Math.round(Number(l.rate) * 100), gstPct: Number(l.gst) })) } }), 'Saved as a draft for the principal');
      if (r) onClose();
    }}>Save draft</button>
  </section></Drawer>;
}

function ReceiveDrawer({ order, onClose }: { order: any; onClose: () => void }) {
  const [f, setF] = useState({ receivedOn: today(), invoiceNo: '', invoiceDate: '' });
  const [rows, setRows] = useState<Record<string, { qty: string; batch: string; expiry: string; serials: string; location: string }>>(Object.fromEntries(order.lines.map((l: any) => [l.id, { qty: String(l.qty - l.received), batch: '', expiry: '', serials: '', location: '' }])));
  const { run, busy } = useAction();
  return <Drawer title={`Goods received · ${order.number}`} onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Received on</span><input className="input" type="date" max={today()} value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} /></label>
      <label className="field"><span>Supplier’s invoice no.</span><input className="input" value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} /></label>
      <label className="field"><span>Invoice date</span><input className="input" type="date" value={f.invoiceDate} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} /></label>
    </div>
    {order.lines.filter((l: any) => l.received < l.qty).map((l: any) => { const r = rows[l.id]; const set = (k: string, v: string) => setRows({ ...rows, [l.id]: { ...r, [k]: v } }); return <div key={l.id} className="callout small stack" style={{ gap: 6 }}>
      <b>{l.item}</b><span className="tiny muted">Ordered {l.qty}, received so far {l.received}</span>
      <div className="form-grid"><label className="field"><span>Received now</span><input className="input" inputMode="decimal" value={r.qty} onChange={(e) => set('qty', e.target.value)} /></label>
        {l.kind === 'ASSET' ? <><label className="field"><span>Serial numbers (one per line)</span><textarea className="input" rows={2} value={r.serials} onChange={(e) => set('serials', e.target.value)} /></label>
          <label className="field"><span>Where it goes</span><input className="input" value={r.location} onChange={(e) => set('location', e.target.value)} placeholder="Computer lab" /></label></>
          : l.trackExpiry && <><label className="field"><span>Batch</span><input className="input" value={r.batch} onChange={(e) => set('batch', e.target.value)} /></label><label className="field"><span>Expiry</span><input className="input" type="date" value={r.expiry} onChange={(e) => set('expiry', e.target.value)} /></label></>}</div></div>; })}
    <p className="tiny muted">Consumables go into stock; assets go onto the register with tags; the invoice goes into the books as owed to the supplier.</p>
    <button className="btn big" disabled={busy || !f.invoiceNo.trim()} onClick={async () => {
      const lines = Object.entries(rows).filter(([, r]) => Number(r.qty) > 0).map(([lineId, r]) => ({ lineId, qty: Number(r.qty), batch: r.batch || undefined, expiry: r.expiry || null, serials: r.serials ? r.serials.split('\n').map((s) => s.trim()).filter(Boolean) : undefined, location: r.location || undefined }));
      const res: any = await run(() => api(`/purchase-orders/${order.id}/receive`, { body: { ...f, invoiceDate: f.invoiceDate || undefined, lines } }));
      if (res) { await tell(`${res.number}: ${money(res.amount)} received and put in the books.`); onClose(); }
    }}>Record</button>
  </section></Drawer>;
}

function PayDrawer({ grn, onClose }: { grn: any; onClose: () => void }) {
  const [f, setF] = useState({ amount: String((grn.amount - grn.paid) / 100), paidOn: today(), utr: '' });
  const { run, busy } = useAction();
  return <Drawer title={`Pay ${grn.supplier}`} onClose={onClose}><section className="tile tight stack">
    <p className="small">{grn.number} · invoice {grn.invoiceNo} · owed {money(grn.amount - grn.paid)}</p>
    <div className="form-grid">
      <label className="field"><span>Amount ₹</span><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label className="field"><span>Paid on</span><input className="input" type="date" max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></label>
      <label className="field"><span>UTR / cheque no.</span><input className="input mono" value={f.utr} onChange={(e) => setF({ ...f, utr: e.target.value.toUpperCase() })} /></label>
    </div>
    <button className="btn big" disabled={busy || f.utr.trim().length < 4 || !(Number(f.amount) > 0)} onClick={async () => { if (await run(() => api(`/goods-receipts/${grn.id}/pay`, { body: { amountPaise: Math.round(Number(f.amount) * 100), paidOn: f.paidOn, utr: f.utr } }), 'Paid; in the books')) onClose(); }}>Record payment</button>
  </section></Drawer>;
}

function Assets({ schoolId, may }: { schoolId: string; may: May }) {
  const [q, setQ] = useState('');
  const list = useLoad<any[]>(`/schools/${schoolId}/assets${q ? `?q=${encodeURIComponent(q)}` : ''}`, [schoolId, q]);
  const audits = useLoad<any[]>(`/schools/${schoolId}/stock-audits`, [schoolId]);
  const [add, setAdd] = useState(false);
  const [audit, setAudit] = useState<string | null>(null);
  const [act, setAct] = useState<any>(null);
  const { run, busy } = useAction();
  const open = (audits.data ?? []).find((a) => a.status === 'OPEN');
  const fy = (() => { const d = today(); const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; })();
  return <>
    <section className="tile"><div className="tile-head"><h3>Asset register</h3><span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <input className="input" style={{ height: 34 }} placeholder="Tag, name or place" value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn quiet small" onClick={() => run(() => openFile(`/schools/${schoolId}/asset-tags`, {}))}>Print tags</button>
      {may.manage && <button className="btn quiet small" onClick={() => setAdd(true)}>Add an existing asset</button>}
      {!may.manage ? null : open ? <button className="btn small" onClick={() => setAudit(open.id)}>Continue the audit</button> : <button className="btn quiet small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/schools/${schoolId}/stock-audits`, { body: { title: `Asset verification ${fy}` } })); if (r) { audits.reload(); setAudit(r.id); } }}>Start an audit</button>}
      {may.pay && <button className="btn quiet small" disabled={busy} onClick={async () => { if (!await ask(`Put this year's (${fy}) depreciation in the books? It can be done once a year.`)) return; const r: any = await run(() => api(`/schools/${schoolId}/depreciation`, { body: { fy } })); if (r) { await tell(`${money(r.amountPaise)} on ${r.assets} assets.`); list.reload(); } }}>Depreciation {fy}</button>}</span></div>
      {!list.data ? <Empty>{list.error ?? 'Loading…'}</Empty> : !list.data.length ? <Empty>No assets.</Empty> : <div className="scroll-x"><table className="table">
        <thead><tr><th>Tag</th><th>Asset</th><th>Where</th><th>With</th><th className="num">Cost</th><th className="num">Book value</th><th>Status</th><th /></tr></thead>
        <tbody>{list.data.map((a) => <tr key={a.id}><td className="mono small">{a.tag}</td><td><b>{a.name}</b><span className="tiny muted" style={{ display: 'block' }}>{a.serial_no ? `S/N ${a.serial_no} · ` : ''}since {day(a.acquired_on)}{a.next_service ? ` · service ${day(a.next_service)}` : ''}</span></td>
          <td className="small">{a.location}</td><td className="small">{a.custodian ?? '—'}</td><td className="num">{money(a.cost_paise)}</td><td className="num">{money(a.cost_paise - a.depreciated_paise)}</td><td><Pill s={a.status} /></td>
          <td>{may.manage && a.status !== 'DISPOSED' && <button className="linkbtn small" onClick={() => setAct(a)}>Manage</button>}</td></tr>)}</tbody></table></div>}</section>
    {(audits.data ?? []).filter((a) => a.status === 'CLOSED').length > 0 && <section className="tile"><h3>Past audits</h3>{audits.data!.filter((a) => a.status === 'CLOSED').map((a) => <div key={a.id} className="list-row small" style={{ gridTemplateColumns: '1fr auto' }}><span>{a.title} · {a.scanned} scanned · {a.by}</span><button className="linkbtn small" onClick={() => setAudit(a.id)}>Report</button></div>)}</section>}
    {add && <AddAssetDrawer schoolId={schoolId} onClose={() => { setAdd(false); list.reload(); }} />}
    {audit && <AuditDrawer id={audit} onClose={() => { setAudit(null); audits.reload(); list.reload(); }} />}
    {act && <AssetDrawer schoolId={schoolId} asset={act} principal={may.principal} onClose={() => { setAct(null); list.reload(); }} />}
  </>;
}

function AddAssetDrawer({ schoolId, onClose }: { schoolId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', serialNo: '', location: '', acquiredOn: '', cost: '', lifeYears: '5' });
  const { run, busy } = useAction();
  return <Drawer title="Add an existing asset" onClose={onClose}><section className="tile tight stack">
    <p className="tiny muted">For things the school already had (the opening register). New purchases come onto the register by themselves when the goods are received.</p>
    <div className="form-grid">
      <label className="field"><span>What</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Interactive panel 75 in" /></label>
      <label className="field"><span>Serial no.</span><input className="input" value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} /></label>
      <label className="field"><span>Where</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
      <label className="field"><span>Bought on</span><input className="input" type="date" max={today()} value={f.acquiredOn} onChange={(e) => setF({ ...f, acquiredOn: e.target.value })} /></label>
      <label className="field"><span>Cost ₹</span><input className="input" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>
      <label className="field"><span>Useful life (years)</span><input className="input" inputMode="numeric" value={f.lifeYears} onChange={(e) => setF({ ...f, lifeYears: e.target.value })} /></label>
    </div>
    <button className="btn big" disabled={busy || f.name.trim().length < 2 || !f.location || !f.acquiredOn} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/assets`, { body: { name: f.name, serialNo: f.serialNo || undefined, location: f.location, acquiredOn: f.acquiredOn, costPaise: Math.round(Number(f.cost || 0) * 100), lifeYears: Number(f.lifeYears) || 5 } }), 'Added; print its tag')) onClose(); }}>Add</button>
  </section></Drawer>;
}

function AssetDrawer({ schoolId, asset, principal, onClose }: { schoolId: string; asset: any; principal: boolean; onClose: () => void }) {
  const staff = useLoad<any[]>(`/schools/${schoolId}/staff`, [schoolId]);
  const [f, setF] = useState({ location: asset.location, custodian: asset.custodian_id ?? '', status: asset.status });
  const [svc, setSvc] = useState({ kind: '', everyMonths: '12', dueOn: '' });
  const [disp, setDisp] = useState({ on: today(), sale: '', note: '' });
  const { run, busy } = useAction();
  return <Drawer title={`${asset.tag} · ${asset.name}`} onClose={onClose}><section className="tile tight stack">
    <div className="form-grid">
      <label className="field"><span>Where</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
      <label className="field"><span>In the care of</span><select className="input" value={f.custodian} onChange={(e) => setF({ ...f, custodian: e.target.value })}><option value="">—</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field"><span>Status</span><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['IN_USE', 'IN_REPAIR', 'MISSING'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
    </div>
    <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={async () => { if (await run(() => api(`/assets/${asset.id}`, { body: { location: f.location, custodian: f.custodian || null, status: f.status } }), 'Saved')) onClose(); }}>Save</button>
    <h3 style={{ marginTop: 10 }}>Schedule a service</h3>
    <div className="form-grid">
      <label className="field"><span>What</span><input className="input" value={svc.kind} onChange={(e) => setSvc({ ...svc, kind: e.target.value })} placeholder="AMC service, calibration" /></label>
      <label className="field"><span>Every (months)</span><input className="input" inputMode="numeric" value={svc.everyMonths} onChange={(e) => setSvc({ ...svc, everyMonths: e.target.value })} /></label>
      <label className="field"><span>First due</span><input className="input" type="date" value={svc.dueOn} onChange={(e) => setSvc({ ...svc, dueOn: e.target.value })} /></label>
    </div>
    <button className="btn quiet small" style={{ alignSelf: 'flex-start' }} disabled={busy || svc.kind.trim().length < 2 || !svc.dueOn} onClick={async () => { if (await run(() => api(`/assets/${asset.id}/services`, { body: { kind: svc.kind, everyMonths: svc.everyMonths ? Number(svc.everyMonths) : null, dueOn: svc.dueOn } }), 'Scheduled')) onClose(); }}>Schedule</button>
    {principal && <><h3 style={{ marginTop: 10 }}>Write off</h3>
      <div className="form-grid"><label className="field"><span>On</span><input className="input" type="date" max={today()} value={disp.on} onChange={(e) => setDisp({ ...disp, on: e.target.value })} /></label>
        <label className="field"><span>Sold for ₹ (0 if scrapped or lost)</span><input className="input" inputMode="decimal" value={disp.sale} onChange={(e) => setDisp({ ...disp, sale: e.target.value })} /></label></div>
      <input className="input" placeholder="Reason and order reference" value={disp.note} onChange={(e) => setDisp({ ...disp, note: e.target.value })} />
      <button className="btn danger small" style={{ alignSelf: 'flex-start' }} disabled={busy || disp.note.trim().length < 5} onClick={async () => { if (!await ask('Write this asset off? The books take out its value.')) return; const r: any = await run(() => api(`/assets/${asset.id}/dispose`, { body: { on: disp.on, salePaise: Math.round(Number(disp.sale || 0) * 100), note: disp.note } })); if (r) { await tell(`Written off. Book value ${money(r.bookValue)}, ${r.gain >= 0 ? 'gain' : 'loss'} ${money(Math.abs(r.gain))}.`); onClose(); } }}>Write off</button></>}
  </section></Drawer>;
}

function AuditDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const rep = useLoad<any>(`/stock-audits/${id}`, [id]);
  const [tag, setTag] = useState('');
  const [loc, setLoc] = useState('');
  const [last, setLast] = useState<any>(null);
  const { run, busy } = useAction();
  const r = rep.data;
  const scan = async () => { const x = await run(() => api(`/stock-audits/${id}/scan`, { body: { tag: tag.trim(), location: loc || undefined } })); if (x) { setLast({ ...(x as object), tag }); setTag(''); rep.reload(); } };
  return <Drawer title={r?.title ?? 'Audit'} onClose={onClose}><section className="tile tight stack">
    {!r ? <Empty>Loading…</Empty> : <>
      <p className="small">{r.scanned} scanned · {r.missing.length} not yet found · {r.moved.length} found somewhere else</p>
      {r.status === 'OPEN' && <>
        <label className="field"><span>Room you are in (optional)</span><input className="input" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="Leave empty if it is where the register says" /></label>
        <div style={{ display: 'flex', gap: 6 }}><input className="input mono" autoFocus value={tag} onChange={(e) => setTag(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) scan(); }} placeholder="Scan or type the tag" />
          <button className="btn small" disabled={busy || !tag.trim()} onClick={scan}>Found</button></div>
        {last && <div className="callout small">{last.tag}: <b>{last.name}</b>{last.moved ? ` · registered in ${last.registered}, found in ${last.found}` : ' · in its place'}</div>}</>}
      <h3>Not found yet</h3>{!r.missing.length ? <Empty>Everything found.</Empty> : r.missing.map((m: any) => <div key={m.id} className="small">{m.tag} · {m.name} · {m.location}{m.custodian ? ` · ${m.custodian}` : ''}</div>)}
      {r.moved.length > 0 && <><h3>Found elsewhere</h3>{r.moved.map((m: any) => <div key={m.tag} className="small">{m.tag} · {m.name}: {m.registered} → {m.found}</div>)}</>}
      {r.status === 'OPEN' && <button className="btn big" disabled={busy} onClick={async () => { if (!await ask('Close the audit? Assets found elsewhere take their new place; those not found are marked missing.')) return; if (await run(() => api(`/stock-audits/${id}/close`, { body: {} }), 'Audit closed')) onClose(); }}>Close the audit</button>}
    </>}
  </section></Drawer>;
}
