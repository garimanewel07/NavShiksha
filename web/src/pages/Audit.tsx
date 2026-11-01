import { time, words } from '../api';
import { Empty, useLoad } from '../ui';

/** The tamper-evident audit log: each entry carries the hash of the one before it. */
export default function Audit() {
  const { data } = useLoad<any[]>('/audit');
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Audit trail</span></div></div>
      <main className="page">
        <section className="tile">
          <h2>Every change, chained</h2>
          <p className="muted" style={{ marginTop: 6 }}>Each entry includes the fingerprint of the previous one. Editing any past entry breaks the chain from that point on.</p>
          {!data ? <Empty>Loading…</Empty> : (
            <div className="scroll-x" style={{ marginTop: 16 }}><table className="table">
              <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Fingerprint</th></tr></thead>
              <tbody>{data.map((a) => (
                <tr key={a.id}><td className="mono small">{a.id}</td><td className="small">{time(a.at)}</td><td className="small">{String(a.actor).split(' <')[0]}</td>
                  <td>{words(a.action)} · {words(a.entity)}</td><td className="mono tiny muted">{String(a.hash).slice(0, 16)}…</td></tr>))}</tbody>
            </table></div>
          )}
        </section>
      </main>
    </>
  );
}
