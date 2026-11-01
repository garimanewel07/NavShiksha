import { useMemo, useState, type ReactNode } from 'react';
import { saveFile } from '../api';
import { Empty, useAction, useLoad } from '../ui';

/**
 * The NES results dashboard: the Performance Index (NES policy) and results across Commands,
 * schools, classes and subjects, compared with any earlier year. One row of filters scopes every
 * view; clicking a school or a heat-map cell narrows the rest to it. Every chart has a table view.
 */

type PiRow = { year: string; schoolId: string; classKey: string; scale: 7 | 8; students: number; counts: Record<string, number>; pi: number | null; sumNi: number; sumWNi: number; topper: { name: string; pct: number } | null; source: string };
type SubjectRow = { year: string; schoolId: string; classCode: string; subject: string; entries: number; average: number; counts: Record<string, number>; scale: 7 | 8 };
type BoardRow = { year: string; schoolId: string; classCode: string; candidates: number; passed: number; average: number; above90: number; above95: number; highest: number };
type Data = { years: string[]; known: string[]; classKeys: string[]; labels: Record<string, string>; schools: { id: string; name: string; code: string; type: string; command: string | null }[]; pi: PiRow[]; subjects: SubjectRow[]; board: BoardRow[] };

// Validated (dataviz validator, light, white surface): current year = slot 1 blue, comparison = slot 2 orange.
const NOW = '#2a78d6', THEN = '#eb6834', DOWN = '#e34948', MID = '#f0efec';
const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
// Text and rules follow the light or dark theme; the data colours stay the same in both.
const INK2 = 'var(--ink-2)', MUTED = 'var(--ink-3)', GRID = 'var(--line-soft)', BASE = 'var(--line)';
const INTERNAL = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E'], BOARD = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E'];

const short = (n: string) => n.replace('Navy Children School, ', 'NCS ').replace('Navy Kindergarten, ', 'NKG ').replace('Naval Kindergarten, ', 'NKG ');
const r2 = (n: number) => Math.round(n * 100) / 100;

/** PI of several classes together: Σ(Wi×Ni ÷ scale) ÷ ΣNi × 100 where counts are known, else the mean. */
function aggPi(rows: PiRow[]) {
  const withN = rows.filter((r) => r.sumNi > 0);
  if (withN.length && withN.length === rows.filter((r) => r.pi != null).length) return r2((withN.reduce((t, r) => t + r.sumWNi / r.scale, 0) / withN.reduce((t, r) => t + r.sumNi, 0)) * 100);
  const v = rows.map((r) => r.pi).filter((x): x is number => x != null);
  return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

// ── A tooltip shared by every chart ──────────────────────────────────────────────────────

type Tip = { x: number; y: number; title: string; rows: [string, string, string?][] } | null;
function TipBox({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div role="status" style={{ position: 'fixed', left: Math.min(tip.x + 14, window.innerWidth - 240), top: tip.y + 14, zIndex: 50, background: 'var(--tile)', border: '1px solid rgba(11,11,11,0.1)', borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,0.12)', padding: '8px 10px', fontSize: 12, pointerEvents: 'none', minWidth: 160 }}>
      <div style={{ color: INK2, marginBottom: 4 }}>{tip.title}</div>
      {tip.rows.map(([v, l, c], i) => <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {c && <span style={{ width: 12, height: 2, background: c, display: 'inline-block', borderRadius: 1 }} />}<b style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</b><span style={{ color: INK2 }}>{l}</span></div>)}
    </div>
  );
}

function Card({ title, note, children, table, wide }: { title: string; note?: string; children: ReactNode; table?: ReactNode; wide?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="tile tight" style={{ flex: wide ? '1 1 100%' : '1 1 460px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
        {table && <button className="linkbtn small" onClick={() => setAsTable(!asTable)}>{asTable ? 'Chart' : 'Table'}</button>}
      </div>
      {note && <p className="tiny muted" style={{ margin: '4px 0 10px' }}>{note}</p>}
      {asTable ? <div className="scroll-x">{table}</div> : children}
    </section>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return <div style={{ display: 'flex', gap: 14, fontSize: 12, color: INK2, margin: '2px 0 8px' }}>{items.map(([c, l]) => <span key={l} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span style={{ width: 10, height: 10, background: c, borderRadius: 2 }} />{l}</span>)}</div>;
}

// ── Charts ───────────────────────────────────────────────────────────────────────────────

/** Paired horizontal bars, one row per school: this year and the year compared. */
function SchoolBars({ rows, selected, onPick, setTip, yNow, yThen }: { rows: { id: string; name: string; now: number | null; then: number | null }[]; selected: string | null; onPick: (id: string) => void; setTip: (t: Tip) => void; yNow: string; yThen: string | null }) {
  const W = 640, L = 150, R = 50, bh = yThen ? 9 : 14, gap = 2, rowH = yThen ? 2 * bh + gap + 12 : bh + 12;
  const max = Math.max(100, ...rows.flatMap((r) => [r.now ?? 0, r.then ?? 0]));
  const x = (v: number) => (v / max) * (W - L - R);
  const H = rows.length * rowH + 22;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Performance Index by school">
      {[0, 25, 50, 75, 100].map((t) => <g key={t}><line x1={L + x(t)} x2={L + x(t)} y1={0} y2={H - 18} stroke={GRID} strokeWidth={1} />
        <text x={L + x(t)} y={H - 4} fontSize={10} fill={MUTED} textAnchor="middle">{t}</text></g>)}
      {rows.map((r, i) => {
        const y = i * rowH + 4, on = !selected || selected === r.id;
        const tip = (e: React.PointerEvent | React.FocusEvent) => setTip({ x: 'clientX' in e ? e.clientX : 200, y: 'clientY' in e ? e.clientY : 200, title: r.name,
          rows: [[r.now == null ? '—' : String(r.now), `PI ${yNow}`, NOW], ...(yThen ? [[r.then == null ? '—' : String(r.then), `PI ${yThen}`, THEN] as [string, string, string]] : []),
            ...(yThen && r.now != null && r.then != null ? [[`${r.now - r.then >= 0 ? '+' : ''}${r2(r.now - r.then)}`, 'change'] as [string, string]] : [])] });
        return (
          <g key={r.id} style={{ cursor: 'pointer', opacity: on ? 1 : 0.35 }} tabIndex={0} onPointerMove={tip} onFocus={tip} onPointerLeave={() => setTip(null)} onBlur={() => setTip(null)}
            onClick={() => onPick(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onPick(r.id); }}>
            <rect x={0} y={y - 4} width={W} height={rowH} fill="transparent" />
            <text x={L - 8} y={y + (yThen ? bh + 4 : bh - 3)} fontSize={11.5} fill={selected === r.id ? 'var(--ink)' : INK2} fontWeight={selected === r.id ? 700 : 400} textAnchor="end">{r.name.length > 24 ? `${r.name.slice(0, 23)}…` : r.name}</text>
            {r.now != null && <path d={bar(L, y, x(r.now), bh)} fill={NOW} />}
            {yThen && r.then != null && <path d={bar(L, y + bh + gap, x(r.then), bh)} fill={THEN} />}
            {r.now != null && <text x={L + x(r.now) + 5} y={y + bh - 1} fontSize={10.5} fill={INK2} style={{ fontVariantNumeric: 'tabular-nums' }}>{r.now}</text>}
          </g>);
      })}
    </svg>
  );
}
/** A horizontal bar with 4px rounded data end, square at the baseline. */
const bar = (x0: number, y: number, w: number, h: number) => { const r = Math.min(4, w / 2, h / 2); return w <= 0 ? '' : `M${x0} ${y} H${x0 + w - r} Q${x0 + w} ${y} ${x0 + w} ${y + r} V${y + h - r} Q${x0 + w} ${y + h} ${x0 + w - r} ${y + h} H${x0} Z`; };
/** A vertical bar with a rounded top, anchored at the baseline. */
const vbar = (x: number, base: number, w: number, h: number) => { const r = Math.min(4, w / 2, h); return h <= 0 ? '' : `M${x} ${base} V${base - h + r} Q${x} ${base - h} ${x + r} ${base - h} H${x + w - r} Q${x + w} ${base - h} ${x + w} ${base - h + r} V${base} Z`; };

/** Schools × classes: each cell's PI in a single-hue scale, its value written in. */
function Heatmap({ schools, keys, labels, value, selected, onPick, setTip }: { schools: { id: string; name: string }[]; keys: string[]; labels: Record<string, string>; value: (s: string, k: string) => { now: number | null; then: number | null }; selected: { school: string | null; key: string | null }; onPick: (s: string, k: string) => void; setTip: (t: Tip) => void }) {
  const L = 176, cw = 52, ch = 22, top = 46, W = L + keys.length * cw, H = top + schools.length * ch + 4;
  const all = schools.flatMap((s) => keys.map((k) => value(s.id, k).now)).filter((v): v is number => v != null);
  const lo = Math.min(...all, 100), hi = Math.max(...all, 0);
  const fill = (v: number) => SEQ[Math.max(0, Math.min(SEQ.length - 1, Math.round(((v - lo) / Math.max(hi - lo, 1)) * (SEQ.length - 1))))];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 560, height: 'auto' }} role="img" aria-label="Performance Index by school and class">
      {keys.map((k, j) => <text key={k} x={L + j * cw + cw / 2} y={top - 8} fontSize={10} fill={INK2} textAnchor="middle">{labels[k].replace(' (', ' ').replace(')', '').replace('Science', 'Sci').replace('Commerce', 'Com').replace('Humanities', 'Hum')}</text>)}
      {schools.map((s, i) => <g key={s.id}>
        <text x={L - 8} y={top + i * ch + ch / 2 + 4} fontSize={11} fill={selected.school === s.id ? 'var(--ink)' : INK2} fontWeight={selected.school === s.id ? 700 : 400} textAnchor="end">{s.name.length > 24 ? `${s.name.slice(0, 23)}…` : s.name}</text>
        {keys.map((k, j) => {
          const v = value(s.id, k), x0 = L + j * cw, y0 = top + i * ch;
          const tip = (e: React.PointerEvent | React.FocusEvent) => setTip({ x: 'clientX' in e ? e.clientX : 200, y: 'clientY' in e ? e.clientY : 200, title: `${s.name} · ${labels[k]}`,
            rows: [[v.now == null ? 'no result' : String(v.now), 'PI'], ...(v.then != null ? [[String(v.then), 'compared year'] as [string, string]] : [])] });
          const dark = v.now != null && SEQ.indexOf(fill(v.now)) >= 7;
          return <g key={k} tabIndex={v.now == null ? -1 : 0} style={{ cursor: v.now == null ? 'default' : 'pointer' }} onPointerMove={tip} onFocus={tip} onPointerLeave={() => setTip(null)} onBlur={() => setTip(null)}
            onClick={() => v.now != null && onPick(s.id, k)} onKeyDown={(e) => { if (e.key === 'Enter' && v.now != null) onPick(s.id, k); }}>
            <rect x={x0 + 1} y={y0 + 1} width={cw - 2} height={ch - 2} rx={3} fill={v.now == null ? 'var(--fill)' : fill(v.now)} stroke={selected.school === s.id && selected.key === k ? '#0b0b0b' : 'none'} strokeWidth={1.5} />
            <text x={x0 + cw / 2} y={y0 + ch / 2 + 4} fontSize={10.5} textAnchor="middle" fill={v.now == null ? MUTED : dark ? '#fff' : '#0b0b0b'} style={{ fontVariantNumeric: 'tabular-nums' }}>{v.now == null ? '·' : v.now.toFixed(1)}</text>
          </g>;
        })}
      </g>)}
    </svg>
  );
}

/** PI over the years: NES (or the Command) and the chosen school. Crosshair snaps to a year. */
function Trend({ years, series, setTip }: { years: string[]; series: { name: string; colour: string; values: (number | null)[] }[]; setTip: (t: Tip) => void }) {
  const W = 560, H = 220, L = 34, R = 16, T = 12, B = 26;
  const [at, setAt] = useState<number | null>(null);
  const vals = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  if (!vals.length) return <Empty>No results for these years.</Empty>;
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 5) * 5), hi = Math.min(100, Math.ceil((Math.max(...vals) + 5) / 5) * 5);
  const x = (i: number) => L + (years.length === 1 ? (W - L - R) / 2 : (i / (years.length - 1)) * (W - L - R)), y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = years.reduce((best, _, k) => (Math.abs(x(k) - px) < Math.abs(x(best) - px) ? k : best), 0);
    setAt(i); setTip({ x: e.clientX, y: e.clientY, title: years[i], rows: series.map((s) => [s.values[i] == null ? '—' : String(s.values[i]), s.name, s.colour]) });
  };
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Performance Index over the years">
      {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={L - 6} y={y(t) + 3} fontSize={10} fill={MUTED} textAnchor="end">{t}</text></g>)}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={BASE} />
      {years.map((yr, i) => <text key={yr} x={x(i)} y={H - 8} fontSize={10} fill={MUTED} textAnchor="middle">{yr}</text>)}
      {at != null && <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} stroke={BASE} />}
      {series.map((s) => {
        const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)] as const));
        const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0]} ${p[1]} ` : acc), '');
        const last = [...pts].reverse().find(Boolean);
        return <g key={s.name}><path d={d} fill="none" stroke={s.colour} strokeWidth={2} strokeLinejoin="round" />
          {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={4} fill={s.colour} stroke="var(--tile)" strokeWidth={2} />)}
          {last && <text x={Math.min(last[0] + 6, W - R - 2)} y={last[1] - 7} fontSize={10.5} fill={INK2} textAnchor={last[0] > W - 90 ? 'end' : 'start'}>{s.name}</text>}</g>;
      })}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onPointerMove={move} onPointerLeave={() => { setAt(null); setTip(null); }} />
    </svg>
  );
}

/** Vertical paired bars (share of grades, or subject averages): this year and the year compared. */
function PairedColumns({ cats, now, then, unit, setTip, yNow, yThen, max }: { cats: string[]; now: (number | null)[]; then: (number | null)[] | null; unit: string; setTip: (t: Tip) => void; yNow: string; yThen: string | null; max?: number }) {
  const W = Math.max(320, cats.length * (then ? 56 : 40) + 50), H = 190, L = 34, B = 34, T = 10;
  const top = max ?? Math.max(10, ...now.map((v) => v ?? 0), ...(then ?? []).map((v) => v ?? 0)) * 1.12;
  const band = (W - L - 8) / cats.length, bw = Math.min(16, (band - 10) / (then ? 2 : 1));
  const y = (v: number) => (v / top) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', maxHeight: 260 }} role="img" aria-label="Comparison by category">
      {[0, top / 2, top].map((t) => <g key={t}><line x1={L} x2={W - 8} y1={H - B - y(t)} y2={H - B - y(t)} stroke={GRID} /><text x={L - 5} y={H - B - y(t) + 3} fontSize={10} fill={MUTED} textAnchor="end">{Math.round(t)}</text></g>)}
      <line x1={L} x2={W - 8} y1={H - B} y2={H - B} stroke={BASE} />
      {cats.map((c, i) => {
        const cx = L + i * band + band / 2, x0 = cx - (then ? bw + 1 : bw / 2);
        const tip = (e: React.PointerEvent | React.FocusEvent) => setTip({ x: 'clientX' in e ? e.clientX : 200, y: 'clientY' in e ? e.clientY : 200, title: c,
          rows: [[now[i] == null ? '—' : `${now[i]}${unit}`, yNow, NOW], ...(then && yThen ? [[then[i] == null ? '—' : `${then[i]}${unit}`, yThen, THEN] as [string, string, string]] : [])] });
        return <g key={c} tabIndex={0} onPointerMove={tip} onFocus={tip} onPointerLeave={() => setTip(null)} onBlur={() => setTip(null)}>
          <rect x={cx - band / 2} y={T} width={band} height={H - T - B} fill="transparent" />
          {now[i] != null && <path d={vbar(x0, H - B, bw, y(now[i]!))} fill={NOW} />}
          {then && then[i] != null && <path d={vbar(x0 + bw + 2, H - B, bw, y(then[i]!))} fill={THEN} />}
          <text x={cx} y={H - B + 14} fontSize={10.5} fill={INK2} textAnchor="middle">{c.length > 10 ? `${c.slice(0, 9)}…` : c}</text>
        </g>;
      })}
    </svg>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────

export function ResultsDashboard() {
  const [code, setCode] = useState('ANNUAL');
  const d = useLoad<Data>(`/analytics/results?code=${code}`, [code]);
  const [year, setYear] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null | undefined>(undefined);
  const [command, setCommand] = useState('');
  const [cls, setCls] = useState('');
  const [school, setSchool] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const x = d.data;
  const yNow = year ?? x?.years.find((y) => x.pi.some((r) => r.year === y)) ?? x?.years[0] ?? '';
  const yThen = compare === undefined ? x?.years.find((y) => y < yNow) ?? null : compare;
  const schools = useMemo(() => (x?.schools ?? []).filter((s) => !command || s.command === command), [x, command]);
  const inScope = useMemo(() => new Set(schools.map((s) => s.id)), [schools]);
  const keyOk = (k: string) => !cls || k === cls || (cls === 'XI' && k.startsWith('XI-')) || (cls === 'XII' && k.startsWith('XII-'));
  const rowsFor = (y: string | null, schoolId?: string | null) => (x?.pi ?? []).filter((r) => r.year === y && inScope.has(r.schoolId) && keyOk(r.classKey) && (!schoolId || r.schoolId === schoolId));
  const now = rowsFor(yNow, school), then = yThen ? rowsFor(yThen, school) : [];
  const piNow = aggPi(now), piThen = yThen ? aggPi(then) : null;
  const perSchool = schools.map((s) => ({ id: s.id, name: short(s.name), now: aggPi(rowsFor(yNow, s.id)), then: yThen ? aggPi(rowsFor(yThen, s.id)) : null }))
    .filter((s) => s.now != null || s.then != null).sort((a, b) => (b.now ?? -1) - (a.now ?? -1));
  const best = perSchool.find((s) => s.now != null);
  const keys = (x?.classKeys ?? []).filter(keyOk);
  const cell = (s: string, k: string) => ({ now: (x?.pi ?? []).find((r) => r.year === yNow && r.schoolId === s && r.classKey === k)?.pi ?? null, then: yThen ? (x?.pi ?? []).find((r) => r.year === yThen && r.schoolId === s && r.classKey === k)?.pi ?? null : null });
  const heatSchools = perSchool.map((s) => ({ id: s.id, name: s.name }));
  const trendYears = [...(x?.years ?? [])].filter((y) => (x?.pi ?? []).some((r) => r.year === y)).sort();
  const commandName = command || 'NES';
  const pickedName = school ? short(x?.schools.find((s) => s.id === school)?.name ?? '') : null;
  const trend = [{ name: `${commandName} (all schools)`, colour: NOW, values: trendYears.map((y) => aggPi(rowsFor(y))) },
    ...(school ? [{ name: pickedName!, colour: THEN, values: trendYears.map((y) => aggPi(rowsFor(y, school))) }] : [])];
  const share = (rows: PiRow[], grades: string[]) => { const tot = rows.reduce((t, r) => t + grades.reduce((a, g) => a + (r.counts?.[g] ?? 0), 0), 0); return grades.map((g) => (tot ? Math.round((rows.reduce((t, r) => t + (r.counts?.[g] ?? 0), 0) / tot) * 1000) / 10 : null)); };
  const subjRows = (y: string | null) => (x?.subjects ?? []).filter((r) => r.year === y && inScope.has(r.schoolId) && (!school || r.schoolId === school) && (!cls || r.classCode === cls));
  const subjAvg = (y: string | null) => { const m = new Map<string, { s: number; n: number }>(); for (const r of subjRows(y)) { const v = m.get(r.subject) ?? { s: 0, n: 0 }; v.s += r.average * r.entries; v.n += r.entries; m.set(r.subject, v); } return m; };
  const sNow = subjAvg(yNow), sThen = yThen ? subjAvg(yThen) : null;
  const subjects = [...sNow.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k]) => k);
  const board = (x?.board ?? []).filter((b) => inScope.has(b.schoolId) && (!school || b.schoolId === school) && (!cls || b.classCode === cls));
  const toppers = now.filter((r) => r.topper).map((r) => ({ ...r, school: short(x!.schools.find((s) => s.id === r.schoolId)?.name ?? '') })).sort((a, b) => (x!.classKeys.indexOf(a.classKey) - x!.classKeys.indexOf(b.classKey)) || (b.topper!.pct - a.topper!.pct));
  const delta = piNow != null && piThen != null ? r2(piNow - piThen) : null;
  const { run, busy } = useAction();
  const commands = [...new Set((x?.schools ?? []).map((s) => s.command).filter(Boolean))] as string[];
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Results dashboard</span><span className="spacer" style={{ flex: 1 }} />
        {x && <button className="btn quiet small" disabled={busy} onClick={() => run(() => saveFile(`/pi/consolidation?year=${yNow}&code=${code}&format=csv`, `pi-consolidation-${yNow}.csv`))}>HQ consolidation (CSV)</button>}</div></div>
      <main className="page">
        {/* One row of filters scopes everything below. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, opacity: d.loading ? 0.6 : 1 }}>
          <label className="small">Year <select className="input" style={{ width: 'auto', height: 34 }} value={yNow} onChange={(e) => { setYear(e.target.value); setCompare(undefined); }}>{(x?.years ?? []).map((y) => <option key={y}>{y}</option>)}</select></label>
          <label className="small">Compare with <select className="input" style={{ width: 'auto', height: 34 }} value={yThen ?? ''} onChange={(e) => setCompare(e.target.value || null)}><option value="">No comparison</option>{(x?.years ?? []).filter((y) => y !== yNow).map((y) => <option key={y}>{y}</option>)}</select></label>
          <label className="small">Exam <select className="input" style={{ width: 'auto', height: 34 }} value={code} onChange={(e) => setCode(e.target.value)}><option value="ANNUAL">Annual (Common Final)</option><option value="HY">Half-Yearly</option></select></label>
          <label className="small">Command <select className="input" style={{ width: 'auto', height: 34 }} value={command} onChange={(e) => { setCommand(e.target.value); setSchool(null); }}><option value="">All</option>{commands.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="small">Class <select className="input" style={{ width: 'auto', height: 34 }} value={cls} onChange={(e) => setCls(e.target.value)}><option value="">VI to XII</option>{['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].map((c) => <option key={c}>{c}</option>)}{(x?.classKeys ?? []).filter((k) => k.includes('-')).map((k) => <option key={k} value={k}>{x!.labels[k]}</option>)}</select></label>
          {school && <span className="pill blue">{pickedName} <button className="linkbtn tiny" onClick={() => setSchool(null)} aria-label="Show all schools">✕</button></span>}
        </div>
        {!x ? <Empty>{d.error ?? 'Loading…'}</Empty> : <>
          <section className="tile tight" style={{ marginBottom: 16 }}>
            <div className="kpis">
              <div><div className="kpi-label">Performance Index · {pickedName ?? commandName}</div><div className="kpi-value">{piNow ?? '—'}</div>
                <div className="kpi-note">{delta == null ? `${yNow}` : <span style={{ color: delta >= 0 ? '#006300' : '#b3261e' }}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} on {yThen} ({piThen})</span>}</div></div>
              <div><div className="kpi-label">Students counted</div><div className="kpi-value">{now.reduce((t, r) => t + r.students, 0).toLocaleString('en-IN')}</div><div className="kpi-note">{yThen ? `${then.reduce((t, r) => t + r.students, 0).toLocaleString('en-IN')} in ${yThen}` : ' '}</div></div>
              <div><div className="kpi-label">Schools reporting</div><div className="kpi-value">{new Set(now.map((r) => r.schoolId)).size}</div><div className="kpi-note">of {schools.length} in view</div></div>
              <div><div className="kpi-label">Highest PI</div><div className="kpi-value" style={{ fontSize: '1.4rem', marginTop: 12 }}>{best ? `${best.name}` : '—'}</div><div className="kpi-note">{best ? `PI ${best.now}` : ''}</div></div>
            </div>
          </section>
          <div className="row" style={{ gap: 16 }}>
            <Card title="Performance Index by school" note={`Click a school to see only its figures below.${yThen ? ` Blue ${yNow}, orange ${yThen}.` : ''}`}
              table={<table className="table small"><thead><tr><th>School</th><th className="num">{yNow}</th>{yThen && <th className="num">{yThen}</th>}{yThen && <th className="num">Change</th>}</tr></thead>
                <tbody>{perSchool.map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{s.now ?? '—'}</td>{yThen && <td className="num">{s.then ?? '—'}</td>}{yThen && <td className="num">{s.now != null && s.then != null ? `${s.now - s.then >= 0 ? '+' : ''}${r2(s.now - s.then)}` : '—'}</td>}</tr>)}</tbody></table>}>
              {yThen && <Legend items={[[NOW, yNow], [THEN, yThen]]} />}
              {perSchool.length ? <SchoolBars rows={perSchool} selected={school} onPick={(id) => setSchool(school === id ? null : id)} setTip={setTip} yNow={yNow} yThen={yThen} /> : <Empty>No results for {yNow} yet.</Empty>}
            </Card>
            <Card title="Over the years" note="The Performance Index each year (frozen as reported, or loaded by NES for earlier years)."
              table={<table className="table small"><thead><tr><th>Year</th>{trend.map((t) => <th key={t.name} className="num">{t.name}</th>)}</tr></thead><tbody>{trendYears.map((y, i) => <tr key={y}><td>{y}</td>{trend.map((t) => <td key={t.name} className="num">{t.values[i] ?? '—'}</td>)}</tr>)}</tbody></table>}>
              {trend.length > 1 && <Legend items={trend.map((t) => [t.colour, t.name])} />}
              <Trend years={trendYears} series={trend} setTip={setTip} />
            </Card>
            <Card wide title={`PI by school and class · ${yNow}`} note="Darker is higher. Click a cell to focus on that school; VI–IX and XI on the 7-point scale, X and XII on CBSE grades (8-point)."
              table={<table className="table small"><thead><tr><th>School</th>{keys.map((k) => <th key={k} className="num">{x.labels[k]}</th>)}</tr></thead><tbody>{heatSchools.map((s) => <tr key={s.id}><td>{s.name}</td>{keys.map((k) => { const v = cell(s.id, k); return <td key={k} className="num">{v.now ?? '—'}{v.then != null && v.now != null ? <span className="tiny muted"> ({v.now - v.then >= 0 ? '+' : ''}{r2(v.now - v.then)})</span> : ''}</td>; })}</tr>)}</tbody></table>}>
              {heatSchools.length ? <div className="scroll-x"><Heatmap schools={heatSchools} keys={keys} labels={x.labels} value={cell} selected={{ school, key: null }} onPick={(s) => setSchool(s)} setTip={setTip} /></div> : <Empty>No results.</Empty>}
            </Card>
            <Card title="Grades awarded (share of all grades)" note="Classes VI–IX and XI (policy bands) and Classes X and XII (CBSE grades) are shown apart: they are different scales."
              table={<table className="table small"><thead><tr><th>Grade</th><th className="num">VI–IX, XI {yNow}</th>{yThen && <th className="num">{yThen}</th>}<th className="num">X, XII {yNow}</th>{yThen && <th className="num">{yThen}</th>}</tr></thead>
                <tbody>{BOARD.concat(['D']).filter((g, i, a) => a.indexOf(g) === i).map((g) => <tr key={g}><td>{g}</td><td className="num">{INTERNAL.includes(g) ? share(now.filter((r) => r.scale === 7), INTERNAL)[INTERNAL.indexOf(g)] ?? '—' : ''}</td>{yThen && <td className="num">{INTERNAL.includes(g) ? share(then.filter((r) => r.scale === 7), INTERNAL)[INTERNAL.indexOf(g)] ?? '—' : ''}</td>}
                  <td className="num">{BOARD.includes(g) ? share(now.filter((r) => r.scale === 8), BOARD)[BOARD.indexOf(g)] ?? '—' : ''}</td>{yThen && <td className="num">{BOARD.includes(g) ? share(then.filter((r) => r.scale === 8), BOARD)[BOARD.indexOf(g)] ?? '—' : ''}</td>}</tr>)}</tbody></table>}>
              {yThen && <Legend items={[[NOW, yNow], [THEN, yThen]]} />}
              {now.some((r) => r.scale === 7 && r.sumNi) && <><div className="tiny muted">Classes VI–IX and XI, % of grades</div><PairedColumns cats={INTERNAL} now={share(now.filter((r) => r.scale === 7), INTERNAL)} then={yThen ? share(then.filter((r) => r.scale === 7), INTERNAL) : null} unit="%" setTip={setTip} yNow={yNow} yThen={yThen} /></>}
              {now.some((r) => r.scale === 8 && r.sumNi) && <><div className="tiny muted">Classes X and XII (CBSE), % of grades</div><PairedColumns cats={BOARD} now={share(now.filter((r) => r.scale === 8), BOARD)} then={yThen ? share(then.filter((r) => r.scale === 8), BOARD) : null} unit="%" setTip={setTip} yNow={yNow} yThen={yThen} /></>}
              {!now.some((r) => r.sumNi) && <Empty>Grade counts are not available for figures loaded from earlier sheets.</Empty>}
            </Card>
            <Card title="Subjects: average marks" note={`Average percentage in each subject${cls ? ` in Class ${cls.split('-')[0]}` : ''}, all children who sat it.`}
              table={<table className="table small"><thead><tr><th>Subject</th><th className="num">{yNow}</th>{yThen && <th className="num">{yThen}</th>}<th className="num">Entries</th></tr></thead>
                <tbody>{subjects.map((sj) => { const a = sNow.get(sj)!, b = sThen?.get(sj); return <tr key={sj}><td>{sj}</td><td className="num">{r2(a.s / a.n)}%</td>{yThen && <td className="num">{b ? `${r2(b.s / b.n)}%` : '—'}</td>}<td className="num">{a.n}</td></tr>; })}</tbody></table>}>
              {yThen && <Legend items={[[NOW, yNow], [THEN, yThen]]} />}
              {subjects.length ? <PairedColumns cats={subjects} now={subjects.map((sj) => { const a = sNow.get(sj)!; return Math.round((a.s / a.n) * 10) / 10; })} then={sThen ? subjects.map((sj) => { const b = sThen.get(sj); return b ? Math.round((b.s / b.n) * 10) / 10 : null; }) : null} unit="%" setTip={setTip} yNow={yNow} yThen={yThen} max={100} /> : <Empty>No subject marks for this selection.</Empty>}
            </Card>
            <Card title="CBSE results, X and XII" note="From the result files the schools uploaded.">
              {!board.length ? <Empty>No CBSE results loaded for these years.</Empty> : <div className="scroll-x"><table className="table small"><thead><tr><th>School</th><th>Class</th>{(x.years).filter((y) => y === yNow || y === yThen).map((y) => <th key={y} className="num">{y}: pass · avg · 90%+</th>)}</tr></thead>
                <tbody>{[...new Set(board.map((b) => `${b.schoolId}|${b.classCode}`))].map((k) => { const [sid, c] = k.split('|'); return <tr key={k}><td>{short(x.schools.find((s) => s.id === sid)?.name ?? '')}</td><td>{c}</td>
                  {x.years.filter((y) => y === yNow || y === yThen).map((y) => { const b = board.find((z) => z.schoolId === sid && z.classCode === c && z.year === y); return <td key={y} className="num">{b ? `${Math.round((b.passed / b.candidates) * 1000) / 10}% · ${b.average}% · ${b.above90}` : '—'}</td>; })}</tr>; })}</tbody></table></div>}
            </Card>
            <Card title={`Toppers · ${yNow}`} note="The topper of each class and stream in each school, on the subjects the policy counts.">
              {!toppers.length ? <Empty>No toppers for this selection.</Empty> : <div className="scroll-x" style={{ maxHeight: 360 }}><table className="table small"><thead><tr><th>Class</th><th>Topper</th><th>School</th><th className="num">%</th></tr></thead>
                <tbody>{toppers.map((t, i) => <tr key={i}><td>{x.labels[t.classKey]}</td><td>{t.topper!.name}</td><td>{t.school}</td><td className="num">{t.topper!.pct}</td></tr>)}</tbody></table></div>}
            </Card>
          </div>
          <TipBox tip={tip} />
        </>}
      </main>
    </>
  );
}
