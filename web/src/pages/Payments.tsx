import { useEffect, useState } from 'react';
import { day, money, num, time, words } from '../api';
import { Drawer, Empty, SchoolPicker, useLoad, useSchools } from '../ui';

export default function Payments() {
  const { schools } = useSchools();
  const [schoolId, setSchoolId] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => { if (!schoolId && schools.length) setSchoolId(schools[0].id); }, [schools, schoolId]);
  const { data } = useLoad<any>(schoolId ? `/payments/collections?schoolId=${schoolId}` : null, [schoolId]);
  const tb = useLoad<any[]>(schoolId ? `/ledger/trial-balance?schoolId=${schoolId}` : null, [schoolId]);
  const debit = (tb.data ?? []).reduce((s, r) => s + Number(r.debit), 0);
  const credit = (tb.data ?? []).reduce((s, r) => s + Number(r.credit), 0);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Payments</span><span className="spacer" /><SchoolPicker value={schoolId} onChange={setSchoolId} schools={schools} /></div></div>
      <main className="page">
        <div className="row">
          <section className="tile" style={{ flex: '2 1 560px' }}>
            <h2>Recent receipts</h2>
            {!data ? <Empty>Loading…</Empty> : data.recent.length ? (
              <div className="scroll-x" style={{ marginTop: 14 }}><table className="table">
                <thead><tr><th>Receipt</th><th>Student</th><th>Method</th><th className="num">Amount</th><th>When</th></tr></thead>
                <tbody>{data.recent.map((r: any) => (
                  <tr key={r.receipt_no} className="click" onClick={() => setReceipt(r.receipt_no)}>
                    <td className="mono">{r.receipt_no}</td><td>{r.student}<div className="tiny muted mono">{r.nes_id}</div></td><td>{words(r.method)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(r.amount_paise)}</td><td className="small muted">{time(r.captured_at)}</td>
                  </tr>))}</tbody>
              </table></div>
            ) : <Empty>No payments yet.</Empty>}
          </section>
          <section className="tile" style={{ flex: '1 1 340px' }}>
            <h2>Ledger check</h2>
            <p className="muted" style={{ marginTop: 6 }}>Every journal balances; the database refuses any that does not.</p>
            <div className="kpis" style={{ marginTop: 18 }}>
              <div><div className="kpi-label">Debits</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money(debit)}</div></div>
              <div><div className="kpi-label">Credits</div><div className="kpi-value" style={{ fontSize: '1.6rem' }}>{money(credit)}</div></div>
            </div>
            <div className={`callout ${debit === credit ? 'green' : 'red'}`} style={{ marginTop: 16 }}>{debit === credit ? 'Balanced.' : 'Out of balance. Report this immediately.'}</div>
            {(tb.data ?? []).filter((r) => Number(r.debit) || Number(r.credit)).map((r) => (
              <div key={r.code} className="list-row small" style={{ gridTemplateColumns: '48px minmax(0,1fr) auto' }}><span className="mono muted">{r.code}</span><span>{r.name}</span><span className="mono">{money(Number(r.debit) - Number(r.credit))}</span></div>
            ))}
            {data && <><h3 style={{ marginTop: 24 }}>By day</h3>{data.byDay.slice(0, 6).map((d: any, i: number) => (
              <div key={i} className="list-row small" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span>{day(d.day)} · {words(d.method)} · {num(d.receipts)} receipts</span><strong>{money(Number(d.amount_paise))}</strong></div>))}</>}
          </section>
        </div>
      </main>
      {receipt && <ReceiptDrawer no={receipt} onClose={() => setReceipt(null)} />}
    </>
  );
}

export function ReceiptDrawer({ no, onClose }: { no: string; onClose: () => void }) {
  const { data: r } = useLoad<any>(`/payments/receipts/${encodeURIComponent(no)}`);
  return (
    <Drawer title="Receipt" onClose={onClose}>
      {!r ? <Empty>Loading…</Empty> : (
        <section className="tile tight stack">
          <div><div style={{ fontWeight: 600 }}>{r.school}</div><div className="small muted">{r.campus_address}</div></div>
          <div className="form-grid">
            <div><div className="kpi-label">Receipt</div><div className="mono">{r.receipt_no}</div></div>
            <div><div className="kpi-label">Date</div><div>{time(r.captured_at)}</div></div>
            <div><div className="kpi-label">Student</div><div>{r.student} <span className="mono muted small">{r.nes_id}</span></div></div>
            <div><div className="kpi-label">Paid by</div><div>{words(r.method)} · <span className="mono small">{r.gateway_payment_id}</span></div></div>
          </div>
          <table className="table"><tbody>{r.lines.map((l: any, i: number) => <tr key={i}><td>{l.installment_code} · {l.head}</td><td className="num">{money(l.amount_paise, true)}</td></tr>)}
            <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{money(r.amount_paise, true)}</td></tr></tbody></table>
        </section>
      )}
    </Drawer>
  );
}
