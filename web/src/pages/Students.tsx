import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CatChip, Empty, Status, useLoad } from '../ui';

const CLASSES: [string, string][] = [['BV1', 'Balvatika 1'], ['BV2', 'Balvatika 2'], ['BV3', 'Balvatika 3'],
  ...['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].map((c) => [c, `Class ${c}`] as [string, string])];
const PAGE = 100;

export default function Students() {
  // A search can arrive in the address (/students?q=…), from the search in the top bar.
  const [params] = useSearchParams();
  const asked = params.get('q') ?? '';
  const [q, setQ] = useState(asked);
  const [query, setQuery] = useState(asked);
  const [cls, setCls] = useState('');
  const [sec, setSec] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { setQ(asked); setQuery(asked); setOffset(0); }, [asked]);
  const navigate = useNavigate();
  const path = `/students?q=${encodeURIComponent(query)}&classCode=${cls}&section=${sec}&status=${status}&offset=${offset}`;
  const { data, loading } = useLoad<any[]>(path, [path]);
  useEffect(() => { if (data) setRows((r) => (offset === 0 ? data : [...r, ...data])); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Any change of search or filter starts again from the first page.
  const change = (set: (v: string) => void) => (v: string) => { setOffset(0); set(v); };
  const filtered = !!(query || cls || sec || status);
  const manySchools = new Set(rows.map((s) => s.school)).size > 1;
  const manyCampuses = new Set(rows.map((s) => s.campus)).size > 1;
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Students</span><span className="spacer" />
        <form onSubmit={(e) => { e.preventDefault(); setOffset(0); setQuery(q.trim()); }} style={{ display: 'flex', gap: 8, flex: '1 1 280px', maxWidth: 420 }}>
          <input className="input" type="search" style={{ height: 36, flex: 1, minWidth: 0 }} placeholder="Name, NES ID or admission number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" enterKeyHint="search" />
          <button className="btn small">Search</button>
        </form>
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head">
            <h2>{query ? `Results for “${query}”` : 'Students'}</h2>
            <div className="filters">
              <select className="input" value={cls} onChange={(e) => change(setCls)(e.target.value)} aria-label="Class">
                <option value="">All classes</option>{CLASSES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select>
              <select className="input" value={sec} onChange={(e) => change(setSec)(e.target.value)} aria-label="Section">
                <option value="">All sections</option>{['A', 'B', 'C', 'D', 'E'].map((x) => <option key={x} value={x}>Section {x}</option>)}</select>
              <select className="input" value={status} onChange={(e) => change(setStatus)(e.target.value)} aria-label="Status">
                <option value="">Any status</option><option value="ACTIVE">Active</option><option value="PROVISIONAL">Provisional</option></select>
              {filtered && <button type="button" className="linkbtn small" onClick={() => { setOffset(0); setQ(''); setQuery(''); setCls(''); setSec(''); setStatus(''); }}>Clear</button>}
            </div>
          </div>
          {loading && !rows.length ? <Empty>Searching…</Empty> : rows.length ? (
            <>
              <div className="scroll-x"><table className="table compact">
                <thead><tr><th>Name</th><th>Class</th><th className="hide-sm">NES ID</th><th className="hide-sm">Admission no.</th><th>Category</th>{manySchools && <th className="hide-sm">School</th>}{!manySchools && manyCampuses && <th className="hide-sm">Campus</th>}<th>Status</th></tr></thead>
                <tbody>{rows.map((s) => (
                  <tr key={s.id} className="click" onClick={() => navigate(`/students/${s.id}`)}>
                    <td style={{ fontWeight: 600 }}>{s.name}<div className="tiny muted mono show-sm" style={{ fontWeight: 400 }}>{s.admission_no}</div></td><td style={{ whiteSpace: 'nowrap' }}>{s.class_code}{s.section ? `-${s.section}` : ''}</td>
                    <td className="mono hide-sm">{s.nes_id}</td><td className="mono hide-sm">{s.admission_no}</td>
                    <td>{s.admission_category ? <CatChip code={s.admission_category} /> : null}</td>
                    {manySchools && <td className="small hide-sm">{s.school.replace('Navy Children School, ', 'NCS ')}<div className="tiny muted">{s.campus}</div></td>}
                    {!manySchools && manyCampuses && <td className="small hide-sm">{s.campus}</td>}
                    <td><Status s={s.status} /></td>
                  </tr>))}</tbody>
              </table></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                <span className="small muted">{rows.length} shown</span>
                {data?.length === PAGE && <button className="btn small secondary" disabled={loading} onClick={() => setOffset(rows.length)}>Show {PAGE} more</button>}
              </div>
            </>
          ) : <Empty>{filtered ? 'No students match. Try another class or section, or part of a name.' : 'No students yet.'}</Empty>}
        </section>
      </main>
    </>
  );
}
