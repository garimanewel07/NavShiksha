import { useState } from 'react';
import { day, money, num, saveFile, type User } from '../api';
import { Empty, useAction, useLoad } from '../ui';

/**
 * Hierarchy insights. NES: the network by Command, then every school, with early warnings. A
 * Command: its schools. A principal: their school beside the network average and where it stands
 * ("4th of 12"), without other schools' names. The MIS pack is the same figures as a PDF.
 */

const pct = (v: number | null | undefined, suffix = '%') => (v === null || v === undefined ? '—' : `${v}${suffix}`);
const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] ?? 'th'}`;

/** A figure against the network average: green when better, orange when behind. */
function Versus({ v, avg, suffix = '%', lowerBetter = false }: { v: number | null; avg: number | null; suffix?: string; lowerBetter?: boolean }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  const better = avg === null ? null : lowerBetter ? v <= avg : v >= avg;
  return <span style={{ color: better === null ? undefined : better ? 'var(--green)' : 'var(--orange)', fontWeight: 600 }}>{v}{suffix}</span>;
}

export function Insights(_props: { user: User }) {
  const [unitId, setUnitId] = useState<string | null>(null);
  const d = useLoad<any>(`/insights${unitId ? `?unitId=${unitId}` : ''}`, [unitId]);
  const { run, busy } = useAction();
  const [only, setOnly] = useState(false);
  if (!d.data) return <main className="page"><Empty>{d.error ?? 'Loading…'}</Empty></main>;
  const x = d.data, net = x.network;
  if (x.level === 'school') return <SchoolView data={x} />;
  const s = x.scope;
  const schools = (x.schools as any[]).filter((r) => !only || r.flags.length);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Insights</span>{unitId && <button className="linkbtn small" style={{ marginLeft: 10 }} onClick={() => setUnitId(null)}>‹ All Commands</button>}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn quiet small" disabled={busy} onClick={() => run(() => saveFile(`/insights/mis.pdf${unitId ? `?unitId=${unitId}` : ''}`, `MIS pack ${new Date().toISOString().slice(0, 7)}.pdf`))}>MIS pack (PDF)</button></div></div>
      <main className="page">
        <section className="tile">
          <h2>{x.level === 'network' ? 'The network today' : `${x.commands[0]?.name ?? 'Your schools'} today`}</h2>
          <p className="muted small" style={{ marginTop: 6 }}>Read live. Attendance over 30 days, roll over 14 days, fees of instalments already due this year, PI the latest year reported. {x.level !== 'network' ? 'Colours compare with the network average.' : ''}</p>
          <div className="kpis" style={{ marginTop: 12 }}>
            <div><div className="kpi-label">Students</div><div className="kpi-value">{num(s.students)}</div><div className="kpi-note">{s.schools} schools</div></div>
            <div><div className="kpi-label">Attendance</div><div className="kpi-value"><Versus v={s.attendance} avg={x.level === 'network' ? null : net.attendance} /></div><div className="kpi-note">network {pct(net.attendance)}</div></div>
            <div><div className="kpi-label">Roll taken</div><div className="kpi-value"><Versus v={s.rollCoverage} avg={x.level === 'network' ? null : net.rollCoverage} /></div><div className="kpi-note">of classes, each school day</div></div>
            <div><div className="kpi-label">Fees collected</div><div className="kpi-value"><Versus v={s.collection} avg={x.level === 'network' ? null : net.collection} /></div><div className="kpi-note">{money(s.feesPaid)} of {money(s.feesDue)} due</div></div>
            <div><div className="kpi-label">Performance Index</div><div className="kpi-value"><Versus v={s.pi} avg={x.level === 'network' ? null : net.pi} suffix="" /></div></div>
            <div><div className="kpi-label">Posts vacant</div><div className="kpi-value">{s.vacancies}</div><div className="kpi-note">of {s.posts} sanctioned</div></div>
            <div><div className="kpi-label">Staff using NavShiksha</div><div className="kpi-value">{pct(s.staffActive)}</div><div className="kpi-note">signed in this week</div></div>
            <div><div className="kpi-label">Schools with red flags</div><div className="kpi-value" style={{ color: s.flagged ? 'var(--red)' : undefined }}>{s.flagged}</div></div>
          </div>
        </section>
        {x.level === 'network' && <section className="tile"><h3>By Command</h3><div className="scroll-x"><table className="table">
          <thead><tr><th>Command</th><th className="num">Schools</th><th className="num">Students</th><th className="num">Attendance</th><th className="num">Roll</th><th className="num">Fees</th><th className="num">PI</th><th className="num">Vacant</th><th className="num">Inspection</th><th className="num">Red flags</th></tr></thead>
          <tbody>{x.commands.map((c: any) => <tr key={c.id ?? c.name} className={c.id ? 'click' : ''} onClick={() => c.id && setUnitId(c.id)}>
            <td><b>{c.name}</b>{c.id && <span className="tiny muted"> · open</span>}</td><td className="num">{c.schools}</td><td className="num">{num(c.students)}</td>
            <td className="num"><Versus v={c.attendance} avg={net.attendance} /></td><td className="num"><Versus v={c.rollCoverage} avg={net.rollCoverage} /></td><td className="num"><Versus v={c.collection} avg={net.collection} /></td>
            <td className="num"><Versus v={c.pi} avg={net.pi} suffix="" /></td><td className="num">{c.vacancies}/{c.posts}</td><td className="num"><Versus v={c.inspection} avg={net.inspection} /></td>
            <td className="num" style={{ color: c.flagged ? 'var(--red)' : undefined }}>{c.flagged}</td></tr>)}</tbody></table></div></section>}
        <section className="tile">
          <div className="tile-head"><h3>Schools</h3><label className="check small"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only schools needing attention</label></div>
          {!schools.length ? <Empty>{only ? 'No school needs attention.' : 'No schools.'}</Empty> : <div className="scroll-x"><table className="table">
            <thead><tr><th>School</th><th className="num">Students</th><th className="num">Attendance</th><th className="num">Roll</th><th className="num">Fees</th><th className="num">PI</th><th className="num">Vacant</th><th className="num">Staff on</th><th className="num">Inspection</th><th>Needs attention</th></tr></thead>
            <tbody>{schools.map((r: any) => <tr key={r.id}>
              <td><b>{r.name}</b><span className="tiny muted" style={{ display: 'block' }}>{r.command}</span></td><td className="num">{num(r.students)}</td>
              <td className="num"><Versus v={r.attendance} avg={net.attendance} /></td><td className="num"><Versus v={r.rollCoverage} avg={net.rollCoverage} /></td><td className="num"><Versus v={r.collection} avg={net.collection} /></td>
              <td className="num"><Versus v={r.pi} avg={net.pi} suffix="" /></td><td className="num">{r.vacancies}/{r.posts}</td><td className="num">{pct(r.staffActive)}</td>
              <td className="num"><Versus v={r.inspection} avg={net.inspection} /></td>
              <td>{r.flags.length ? r.flags.map((f: any, i: number) => <span key={i} className={`pill ${f.level === 'red' ? 'red' : 'orange'}`} style={{ margin: '0 4px 4px 0', display: 'inline-block' }}>{f.text}</span>) : <span className="tiny muted">—</span>}</td>
            </tr>)}</tbody></table></div>}
        </section>
      </main>
    </>
  );
}

function SchoolView({ data }: { data: any }) {
  const s = data.schools[0], net = data.network;
  if (!s) return <main className="page"><Empty>Your school has no figures yet.</Empty></main>;
  const rank = (k: string) => s.rank?.[k] ? `${ord(s.rank[k].place)} of ${s.rank[k].of}` : '';
  const Row = ({ label, k, v, avg, suffix = '%', note }: { label: string; k?: string; v: number | null; avg: number | null; suffix?: string; note?: string }) => <div className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto auto' }}>
    <span><b>{label}</b>{note && <span className="tiny muted" style={{ display: 'block' }}>{note}</span>}</span>
    <span className="num" style={{ fontSize: '1.2rem' }}><Versus v={v} avg={avg} suffix={suffix} /></span><span className="small muted num">network {pct(avg, suffix)}</span><span className="small num" style={{ minWidth: 80, textAlign: 'right' }}>{k ? rank(k) : ''}</span></div>;
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">{s.name} against the network</span></div></div>
      <main className="page">
        <section className="tile"><p className="muted small">Your school beside the average of all {net.schools} schools, and where it stands among them. Other schools are not named.</p>
          <Row label="Attendance" k="attendance" v={s.attendance} avg={net.attendance} note="Last 30 days" />
          <Row label="Roll taken" k="rollCoverage" v={s.rollCoverage} avg={net.rollCoverage} note="Classes with the roll taken, last 14 days" />
          <Row label="Fees collected" k="collection" v={s.collection} avg={net.collection} note={`${money(s.feesPaid)} of ${money(s.feesDue)} due so far`} />
          <Row label="Performance Index" k="pi" v={s.pi} avg={net.pi} suffix="" note={s.piYear ? `Reported for ${s.piYear}` : 'Not reported yet'} />
          <Row label="Latest inspection" k="inspection" v={s.inspection} avg={net.inspection} note={s.inspectedOn ? `On ${day(s.inspectedOn)}` : 'Not inspected yet'} />
          <Row label="Staff using NavShiksha" v={s.staffActive} avg={net.staffActive} note="Signed in this week" />
        </section>
        <section className="tile"><h3>Needs attention</h3>{!s.flags.length ? <Empty>Nothing is flagged for your school.</Empty> : s.flags.map((f: any, i: number) => <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr' }}><span><span className={`pill ${f.level === 'red' ? 'red' : 'orange'}`}>{f.level === 'red' ? 'Act now' : 'Watch'}</span> {f.text}</span></div>)}</section>
        <section className="tile"><div className="kpis">
          <div><div className="kpi-label">Students</div><div className="kpi-value">{num(s.students)}</div></div>
          <div><div className="kpi-label">Posts vacant</div><div className="kpi-value">{s.vacancies}</div><div className="kpi-note">of {s.posts}</div></div>
          <div><div className="kpi-label">Inspection findings open</div><div className="kpi-value">{s.openFindings}</div></div>
          <div><div className="kpi-label">Decisions awaiting your report</div><div className="kpi-value">{s.reportsPending}</div></div>
        </div></section>
      </main>
    </>
  );
}
