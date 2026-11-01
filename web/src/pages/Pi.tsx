import { useState } from 'react';
import { api, readText, saveFile, time, type User, recentYears } from '../api';
import { Empty, useAction, useLoad, ask, tell } from '../ui';
import { useSchool } from './Payroll';

/**
 * A school's Performance Index sheet, laid out like the NES workbook (Part A: VI–IX and XI on the
 * 7-point scale; Part B: X and XII from CBSE grades), worked out from the published Common Final
 * Examination and the CBSE result files; the principal reports it to NES. NES also loads earlier
 * years from its consolidation sheets so comparisons start from the first year.
 */

const INTERNAL = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E'], BOARD = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E'];
const YEARS = recentYears(4);

function Part({ title, rows, grades, scale }: { title: string; rows: any[]; grades: string[]; scale: number }) {
  return (
    <section className="tile tight">
      <h3>{title}</h3>
      <p className="tiny muted" style={{ marginTop: 4 }}>PI = [Σ(Wi × Ni) ÷ ΣNi] × 100 ÷ {scale}. Weightage {grades.map((g, i) => `${g} ${scale - i}`).join(', ')}.</p>
      {!rows.length ? <Empty>No results yet.</Empty> : <div className="scroll-x" style={{ marginTop: 10 }}><table className="table small">
        <thead><tr><th>Class / stream</th><th>Topper</th>{grades.map((g) => <th key={g} className="num">{g}</th>)}<th className="num">ΣNi</th><th className="num">Students</th><th>Check</th><th className="num">Σ(Wi×Ni)</th><th className="num">PI</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.classKey}>
          <td><b>{r.label}</b><div className="tiny muted">{r.counted}</div></td>
          <td className="small">{r.topper ? <>{r.topper.name}<div className="tiny muted">{r.topper.category ? `Cat - ${r.topper.category} · ` : ''}{r.topper.total}/{r.topper.max} · {(r.topper.pct * 100).toFixed(2)}%</div></> : '—'}</td>
          {grades.map((g) => <td key={g} className="num">{r.counts?.[g] ?? 0}</td>)}
          <td className="num">{r.sumNi}</td><td className="num">{r.students}</td>
          <td><span className={`pill ${r.check === 'OK' ? 'green' : r.source === 'IMPORTED' ? '' : 'orange'}`}>{r.check}</span></td>
          <td className="num">{r.sumWNi}</td><td className="num"><b>{r.pi?.toFixed(2) ?? '—'}</b></td></tr>)}</tbody></table></div>}
    </section>
  );
}

export function SchoolPi({ user }: { user: User }) {
  const [schoolId, picker] = useSchool();
  const [year, setYear] = useState(YEARS[0]);
  const [code, setCode] = useState('ANNUAL');
  const s = useLoad<any>(schoolId ? `/schools/${schoolId}/pi?year=${year}&code=${code}` : null, [schoolId, year, code]);
  const { run, busy } = useAction();
  const x = s.data;
  const principal = user.role === 'SCHOOL_ADMIN' || user.role === 'NES_ADMIN';
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Performance Index</span><span className="spacer" style={{ flex: 1 }} />{picker}
        <select className="input" style={{ width: 'auto', height: 34 }} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Academic year">{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
        <select className="input" style={{ width: 'auto', height: 34 }} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Examination"><option value="ANNUAL">Common Final (Annual)</option><option value="HY">Half-Yearly</option></select>
        {x && <button className="btn quiet small" disabled={busy} onClick={() => run(() => saveFile(`/schools/${schoolId}/pi?year=${year}&code=${code}&format=csv`, `pi-${year}.csv`))}>Spreadsheet</button>}
        {x && principal && <button className="btn small" disabled={busy} onClick={async () => { const r: any = await run(() => api(`/schools/${schoolId}/pi/report?code=${code}`, { body: { year } })); if (r) { await tell(`Reported to NES: ${r.classes} classes.${r.warnings.length ? `\nCheck: ${r.warnings.join('; ')}` : ''}`); s.reload(); } }}>{x.frozen ? 'Report again' : 'Report to NES'}</button>}</div></div>
      <main className="page">
        {!x ? <Empty>{s.error ?? 'Loading…'}</Empty> : <>
          <p className="small muted">{x.school} · {x.year} · CBSE {x.boardYear}. Worked out from the published {code === 'ANNUAL' ? 'Common Final Examination' : 'Half-Yearly'} marks (internal assessment not included) and the CBSE result files, per the NES policy letter. {x.frozen ? `Reported to NES ${time(x.frozen.at)} by ${x.frozen.by}; these are the reported figures.` : 'Not reported to NES yet.'}</p>
          {x.frozen && principal && <button className="linkbtn small" disabled={busy} onClick={async () => { if (await ask('Take back the reported figures so they are worked out again (for example after a corrected CBSE file)?') && await run(() => api(`/schools/${schoolId}/pi/reopen`, { body: { year } }), 'Working figures restored')) s.reload(); }}>Take back the report</button>}
          <Part title="Part A · Classes VI to IX and XI" rows={x.partA} grades={INTERNAL} scale={7} />
          <Part title="Part B · Classes X and XII (CBSE grades)" rows={x.partB} grades={BOARD} scale={8} />
        </>}
        {user.role === 'NES_ADMIN' && <EarlierYears />}
      </main>
    </>
  );
}

/** NES loads earlier years' PI from the consolidation sheet (saved as CSV). */
function EarlierYears() {
  const [year, setYear] = useState('2025-26');
  const { run, busy } = useAction();
  return (
    <section className="tile tight">
      <h3>Earlier years</h3>
      <p className="tiny muted" style={{ marginTop: 4 }}>Load a past year’s HQ consolidation sheet (save it as CSV from Excel): a row per school, with the school’s name or code and a PI under each class column (VI, VII, VIII, IX, X, XI (Science) … XII (Humanities)). The dashboard then compares against it.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input className="input" style={{ width: 110 }} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year of the sheet" placeholder="2024-25" />
        <label className="btn quiet small">Load the sheet<input type="file" accept=".csv" hidden disabled={busy} onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const r: any = await run(async () => api('/pi/history', { body: { year, csv: await readText(f) } }));
          if (r) await tell(`${r.saved} figures loaded for ${year}.${r.unknown.length ? `\nSchools not recognised: ${r.unknown.join(', ')}` : ''}`);
          e.target.value = '';
        }} /></label>
      </div>
    </section>
  );
}
