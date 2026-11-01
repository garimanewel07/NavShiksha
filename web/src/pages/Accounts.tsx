import { useEffect, useState } from 'react';
import { api, day, money, readText, saveFile, today, type User } from '../api';
import { Empty, useAction, useLoad, useSchools, tell } from '../ui';

/**
 * The school's books. Every receipt, refund, salary and statutory payment is already in them when
 * it happens; here the bank statement is matched to those entries, the few things only the bank
 * shows (gateway settlements, charges, interest, cash paid in) are posted, and the reports are read.
 * NES and the Commands see the same reports added up across their schools.
 */

const FY_START = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };
const BOOKS: [string, string][] = [['1100', 'Bank book'], ['1160', 'Cash book (fee counter)'], ['1150', 'Online fees awaiting settlement'], ['1200', 'Fees receivable'], ['2100', 'Fees received in advance'],
  ['2500', 'Salaries payable'], ['2510', 'Provident fund payable'], ['2511', 'ESI payable'], ['2520', 'Professional tax payable'], ['2530', 'TDS payable'], ['1500', 'Staff advances']];
const HOW: Record<string, string> = { GATEWAY: 'Gateway settlement', CHARGES: 'Bank charges', INTEREST: 'Interest', CASH_DEPOSIT: 'Cash paid in' };

export default function Accounts({ user }: { user: User }) {
  const { units } = useSchools();
  const scope = user.scopePath ?? '';
  const choices = units.filter((u) => ['society', 'command', 'school'].includes(u.kind) && u.active && (u.path === scope || u.path.startsWith(`${scope}.`)));
  const [unitId, setUnitId] = useState('');
  useEffect(() => { if (!unitId && choices.length) setUnitId((choices.find((u) => u.kind === 'school') && ['SCHOOL_ADMIN', 'ACCOUNTANT'].includes(user.role) ? choices.find((u) => u.kind === 'school') : choices[0])!.id); }, [choices, unitId, user.role]);
  const unit = choices.find((u) => u.id === unitId);
  const isSchool = unit?.kind === 'school';
  const [tab, setTab] = useState('bank');
  useEffect(() => { if (unit && !isSchool) setTab('reports'); }, [unit, isSchool]);
  const keeps = ['SCHOOL_ADMIN', 'ACCOUNTANT'].includes(user.role);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Accounts</span><span className="spacer" style={{ flex: 1 }} />
        {choices.length > 1 && <select className="input" style={{ height: 36, width: 'auto' }} value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="School or group">
          {choices.map((u) => <option key={u.id} value={u.id}>{u.kind === 'society' ? 'All NES schools' : u.kind === 'command' ? `${u.name} (all its schools)` : u.name}</option>)}</select>}
        <div className="seg">{[...(isSchool ? [['bank', 'Bank']] : []), ['reports', 'Reports'], ...(isSchool ? [['books', 'Books']] : [])].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div></div></div>
      <main className="page">
        {!unit ? <Empty>Loading…</Empty> : tab === 'bank' && isSchool ? <Bank schoolId={unit.id} keeps={keeps} /> : tab === 'books' && isSchool ? <Books schoolId={unit.id} /> : <Reports unitId={unit.id} group={!isSchool} />}
      </main>
    </>
  );
}

function Bank({ schoolId, keeps }: { schoolId: string; keeps: boolean }) {
  const d = useLoad<any>(`/schools/${schoolId}/bank-lines`, [schoolId]);
  const rec = useLoad<any>(`/schools/${schoolId}/reconciliation`, [schoolId]);
  const { run, busy } = useAction();
  const [label, setLabel] = useState('State Bank of India');
  const [charges, setCharges] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const reload = () => { d.reload(); rec.reload(); };
  const r = rec.data;
  return (
    <>
      <section className="tile">
        <div className="tile-head"><div><h2>Bank reconciliation</h2><p className="muted" style={{ marginTop: 6 }}>Import the statement exactly as net banking gives it (CSV). Entries already in the books — fee receipts, refunds, salaries, PF, ESI, TDS — are matched by themselves; only what the bank alone shows is left for you.</p></div>
          {keeps && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" style={{ height: 36, width: 180 }} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Bank account" />
            <label className="btn small" style={{ cursor: 'pointer' }}>Import statement<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              const csv = await readText(f);
              const x: any = await run(() => api(`/schools/${schoolId}/bank-statements`, { body: { bankLabel: label, csv } }));
              if (x) { await tell(`${x.added} lines added (${x.skipped} already imported), ${x.matched} matched to the books.`); reload(); }
              e.target.value = '';
            }} /></label></div>}</div>
        {r && <div className="kpis" style={{ marginTop: 12 }}>
          <div><div className="kpi-label">Bank balance in the books</div><div className="kpi-value" style={{ fontSize: '1.7rem' }}>{money(r.bookBalance)}</div></div>
          <div><div className="kpi-label">Balance on the statement</div><div className="kpi-value" style={{ fontSize: '1.7rem' }}>{r.bankBalance === null ? '—' : money(r.bankBalance)}</div><div className="kpi-note">{r.bankBalanceOn ? `on ${day(r.bankBalanceOn)}` : 'No statement yet'}</div></div>
          <div><div className="kpi-label">Still to explain</div><div className="kpi-value" style={{ fontSize: '1.7rem' }}>{r.unexplained.length}</div><div className="kpi-note">statement lines</div></div>
          <div><div className="kpi-label">Not yet through the bank</div><div className="kpi-value" style={{ fontSize: '1.7rem' }}>{r.notInBank.length + r.unpresented.length}</div><div className="kpi-note">entries in the books</div></div>
        </div>}
        {r && r.difference !== null && <div className={`callout ${r.difference === 0 ? 'green' : 'orange'} small`} style={{ marginTop: 12 }}>{r.difference === 0 ? 'The statement and the books agree.' : `Difference of ${money(Math.abs(r.difference), true)} still to explain (usually the opening balance from before NavShiksha, or a line set aside).`}</div>}
      </section>
      {d.data && (d.data.awaitingSettlement > 0 || d.data.cashInHand > 0) && <section className="callout blue small">
        {d.data.awaitingSettlement > 0 && <div>Online fees of {money(d.data.awaitingSettlement, true)} are with the payment gateway, waiting to reach the bank.</div>}
        {d.data.cashInHand > 0 && <div>The fee counter holds {money(d.data.cashInHand, true)} in cash not yet paid into the bank.</div>}</section>}
      <section className="tile">
        <h3>Statement lines to explain</h3>
        {!d.data ? <Empty>Loading…</Empty> : !d.data.lines.length ? <Empty>Nothing to explain. Every line is matched to the books.</Empty> : d.data.lines.map((l: any) => <div key={l.id} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <span><b className={l.amount < 0 ? '' : ''}>{l.amount > 0 ? '+' : '−'}{money(Math.abs(l.amount), true)}</b> <span className="small">{day(l.on_date)} · {l.narration}{l.reference ? ` · ${l.reference}` : ''}</span>
            {l.looksLike && <span className="tiny muted" style={{ display: 'block' }}>Looks like: {HOW[l.looksLike]}</span>}</span>
          {keeps && <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {l.candidates.map((c: any) => <button key={c.id} className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/match`, { body: { journalId: c.id } }), 'Matched')) reload(); }}>Is: {c.narration.slice(0, 40)} ({day(c.on_date)})</button>)}
            {l.amount > 0 && <><input className="input" style={{ height: 34, width: 110 }} placeholder="Gateway fee ₹" value={charges[l.id] ?? ''} onChange={(e) => setCharges({ ...charges, [l.id]: e.target.value.replace(/[^0-9.]/g, '') })} />
              <button className={`btn small ${l.looksLike === 'GATEWAY' ? '' : 'quiet'}`} disabled={busy} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/post`, { body: { kind: 'GATEWAY', chargesPaise: Math.round(Number(charges[l.id] || 0) * 100) } }), 'Posted')) reload(); }}>Gateway settlement</button>
              <button className={`btn small ${l.looksLike === 'INTEREST' ? '' : 'quiet'}`} disabled={busy} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/post`, { body: { kind: 'INTEREST' } }), 'Posted')) reload(); }}>Interest</button>
              <button className={`btn small ${l.looksLike === 'CASH_DEPOSIT' ? '' : 'quiet'}`} disabled={busy} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/post`, { body: { kind: 'CASH_DEPOSIT' } }), 'Posted')) reload(); }}>Cash paid in</button></>}
            {l.amount < 0 && <button className={`btn small ${l.looksLike === 'CHARGES' ? '' : 'quiet'}`} disabled={busy} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/post`, { body: { kind: 'CHARGES' } }), 'Posted')) reload(); }}>Bank charges</button>}
            <input className="input" style={{ height: 34, width: 150 }} placeholder="Or set aside: why" value={note[l.id] ?? ''} onChange={(e) => setNote({ ...note, [l.id]: e.target.value })} />
            <button className="btn quiet small" disabled={busy || (note[l.id] ?? '').trim().length < 4} onClick={async () => { if (await run(() => api(`/bank-lines/${l.id}/ignore`, { body: { note: note[l.id] } }), 'Set aside')) reload(); }}>Set aside</button>
          </span>}
        </div>)}
      </section>
      {r && (r.notInBank.length > 0 || r.unpresented.length > 0) && <section className="tile"><h3>In the books, not yet in the bank</h3>
        {[...r.notInBank, ...r.unpresented].map((x: any, i: number) => <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span className="small">{day(x.on_date)} · {x.narration}</span><b className="small">{x.amount > 0 ? '+' : '−'}{money(Math.abs(x.amount), true)}</b></div>)}</section>}
    </>
  );
}

function Reports({ unitId, group }: { unitId: string; group: boolean }) {
  const [from, setFrom] = useState(FY_START()), [to, setTo] = useState(today());
  const ie = useLoad<any>(`/units/${unitId}/income-expenditure?from=${from}&to=${to}`, [unitId, from, to]);
  const bs = useLoad<any>(`/units/${unitId}/balance-sheet?on=${to}`, [unitId, to]);
  const { run } = useAction();
  const Rows = ({ rows }: { rows: any[] }) => <>{rows.map((a) => <tr key={a.code}><td className="mono small">{a.code}</td><td>{a.name}</td>
    {group && ie.data.schools.length > 1 && ie.data.schools.map((s: any) => <td key={s.id} className="num small">{money(a.bySchool?.[s.id] ?? 0)}</td>)}<td className="num">{money(a.total ?? a.amount)}</td></tr>)}</>;
  return (
    <>
      <section className="tile">
        <div className="tile-head"><div><h2>{group ? 'The schools’ books, added up' : 'Reports'}</h2>{group && <p className="muted" style={{ marginTop: 6 }}>Each school keeps its own books and its own money; these are their figures side by side and in total.</p>}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" type="date" style={{ height: 36, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className="input" type="date" style={{ height: 36, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button className="btn quiet small" onClick={() => run(() => saveFile(`/units/${unitId}/income-expenditure?from=${from}&to=${to}&format=csv`, `income-expenditure-${from}-${to}.csv`))}>Spreadsheet</button></div></div>
        {!ie.data ? <Empty>{ie.error ?? 'Loading…'}</Empty> : <div className="scroll-x" style={{ marginTop: 12 }}><table className="table">
          <thead><tr><th /><th>Income and expenditure</th>{group && ie.data.schools.length > 1 && ie.data.schools.map((s: any) => <th key={s.id} className="num">{s.name.replace('Navy Children School, ', 'NCS ')}</th>)}<th className="num">Total</th></tr></thead>
          <tbody>
            <tr><td colSpan={99}><b>Income</b></td></tr><Rows rows={ie.data.income} />
            <tr><td /><td><b>Total income</b></td>{group && ie.data.schools.length > 1 && ie.data.schools.map((s: any) => <td key={s.id} />)}<td className="num"><b>{money(ie.data.totalIncome)}</b></td></tr>
            <tr><td colSpan={99}><b>Expenditure</b></td></tr><Rows rows={ie.data.expenditure} />
            <tr><td /><td><b>Total expenditure</b></td>{group && ie.data.schools.length > 1 && ie.data.schools.map((s: any) => <td key={s.id} />)}<td className="num"><b>{money(ie.data.totalExpenditure)}</b></td></tr>
            <tr><td /><td><b>{ie.data.surplus >= 0 ? 'Surplus' : 'Deficit'}</b></td>{group && ie.data.schools.length > 1 && ie.data.schools.map((s: any) => <td key={s.id} />)}<td className="num"><b>{money(Math.abs(ie.data.surplus))}</b></td></tr>
          </tbody></table></div>}
      </section>
      <section className="tile">
        <h3>Balance sheet on {day(to)}</h3>
        {!bs.data ? <Empty>Loading…</Empty> : <div className="grid" style={{ marginTop: 10 }}>
          <div><h4 style={{ margin: '0 0 6px' }}>What the {group ? 'schools have' : 'school has'}</h4><table className="table"><tbody>{bs.data.assets.map((a: any) => <tr key={a.code}><td>{a.name}</td><td className="num">{money(a.amount)}</td></tr>)}
            <tr><td><b>Total</b></td><td className="num"><b>{money(bs.data.totalAssets)}</b></td></tr></tbody></table></div>
          <div><h4 style={{ margin: '0 0 6px' }}>What {group ? 'they owe' : 'it owes'}, and the surplus</h4><table className="table"><tbody>{bs.data.liabilities.map((a: any) => <tr key={a.code}><td>{a.name}</td><td className="num">{money(a.amount)}</td></tr>)}
            <tr><td>Surplus to date</td><td className="num">{money(bs.data.surplus)}</td></tr><tr><td><b>Total</b></td><td className="num"><b>{money(bs.data.totalLiabilities)}</b></td></tr></tbody></table></div>
        </div>}
        {bs.data && <p className={`small ${bs.data.balanced ? 'muted' : ''}`} style={{ marginTop: 8 }}>{bs.data.balanced ? 'The two sides agree.' : 'The two sides do not agree; tell NES.'}</p>}
      </section>
    </>
  );
}

function Books({ schoolId }: { schoolId: string }) {
  const [code, setCode] = useState('1100');
  const [from, setFrom] = useState(FY_START()), [to, setTo] = useState(today());
  const d = useLoad<any>(`/schools/${schoolId}/books/${code}?from=${from}&to=${to}`, [schoolId, code, from, to]);
  const { run } = useAction();
  return (
    <section className="tile">
      <div className="tile-head"><div><h2>{BOOKS.find(([c]) => c === code)?.[1]}</h2></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="input" style={{ height: 36, width: 'auto' }} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Book">{BOOKS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select>
          <input className="input" type="date" style={{ height: 36, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <input className="input" type="date" style={{ height: 36, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          <button className="btn quiet small" onClick={() => run(() => saveFile(`/schools/${schoolId}/books/${code}?from=${from}&to=${to}&format=csv`, `${code}-${from}-${to}.csv`))}>Spreadsheet</button></div></div>
      {!d.data ? <Empty>Loading…</Empty> : <div className="scroll-x"><table className="table">
        <thead><tr><th>Date</th><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody><tr><td /><td className="muted">Opening balance</td><td /><td /><td className="num">{money(d.data.opening, true)}</td></tr>
          {d.data.lines.map((l: any, i: number) => <tr key={i}><td className="small">{day(l.on_date)}</td><td className="small">{l.narration}</td><td className="num small">{l.debit ? money(l.debit, true) : ''}</td><td className="num small">{l.credit ? money(l.credit, true) : ''}</td><td className="num small">{money(l.balance, true)}</td></tr>)}
          <tr><td /><td><b>Closing balance</b></td><td /><td /><td className="num"><b>{money(d.data.closing, true)}</b></td></tr></tbody></table></div>}
    </section>
  );
}
