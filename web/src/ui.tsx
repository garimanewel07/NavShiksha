import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, apiFile, ApiError, words } from './api';

/** Loads data from the API; `reload` refetches after a change. */
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError(null); setFailure(null);
    try { setData(await api<T>(path)); } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'app_error', (e as Error).message, undefined, 'NS-APP');
      setFailure(err); setError(`${err.message} (${err.number}${err.ref ? ` · ${err.ref}` : ''})`);
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, failure, loading, reload: load, setData };
}

type ToastFn = (message: string, kind?: 'ok' | 'error') => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ message: string; kind: string } | null>(null);
  const show: ToastFn = (message, kind = 'ok') => { setT({ message, kind }); setTimeout(() => setT(null), 4200); };
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div role="status" className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.message}</div>}
      <DialogHost />
    </ToastCtx.Provider>
  );
}

// ── Dialogs: the app's own confirm, message and question boxes (never the browser's) ─────

type DialogReq = { kind: 'confirm' | 'notice' | 'prompt'; title: string; body?: ReactNode; ok: string; cancel: string; danger: boolean;
  input?: { type: 'text' | 'number' | 'date'; initial: string; placeholder?: string; multiline?: boolean }; resolve: (v: unknown) => void };
let openDialog: ((r: DialogReq) => void) | null = null;

/** "Publish the results? Parents are told." → title "Publish the results?", body "Parents are told." */
function split(text: string) {
  const m = /^(.+?[?.!:])(\s+)([\s\S]+)$/.exec(text.trim());
  return m && m[1].length < 140 ? { title: m[1], body: m[3] } : { title: text.trim(), body: undefined };
}
const DANGER = /^(remove|delete|cancel|withdraw|reject|refuse|discard|take back|stop|close|turn away|dispose|end|leave|sign out|reset)\b/i;
/** The main button names the action: "Remove this book?" → "Yes, remove". */
function okLabel(title: string) {
  const w = /^([A-Z][a-z]+)\b/.exec(title)?.[1];
  return w && !/^(Is|Are|Do|Does|Did|The|This|These|That|All|Any|No|Your|You|It|There|Should|Can|Will|Would)$/.test(w) ? `Yes, ${w.toLowerCase()}` : 'Yes, continue';
}

/** Asks the person to confirm an action. Resolves true if they agree. */
export function ask(text: string, o: { title?: string; ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  const t = o.title ? { title: o.title, body: text } : split(text);
  return new Promise((resolve) => {
    if (!openDialog) { resolve(window.confirm(text)); return; }
    openDialog({ kind: 'confirm', title: t.title, body: t.body, ok: o.ok ?? okLabel(t.title), cancel: o.cancel ?? 'Not now', danger: o.danger ?? DANGER.test(t.title), resolve: (v) => resolve(v as boolean) });
  });
}

/** Shows a message the person acknowledges. */
export function tell(text: string, o: { title?: string } = {}): Promise<void> {
  const lines = text.split('\n');
  const t = o.title ? { title: o.title, body: text } : lines.length > 1 ? { title: lines[0], body: lines.slice(1).join('\n') } : split(text);
  return new Promise((resolve) => {
    if (!openDialog) { window.alert(text); resolve(); return; }
    openDialog({ kind: 'notice', title: t.title, body: t.body, ok: 'OK', cancel: '', danger: false, resolve: () => resolve() });
  });
}

/** Asks for a short answer. Resolves the text, or null if they go back. */
export function askText(question: string, o: { initial?: string; placeholder?: string; type?: 'text' | 'number' | 'date'; ok?: string; multiline?: boolean } = {}): Promise<string | null> {
  const t = split(question);
  const type = o.type ?? (/YYYY-MM-DD/.test(question) ? 'date' : /how many|minutes|marks|rate this/i.test(question) && !/,/.test(question) ? 'number' : 'text');
  return new Promise((resolve) => {
    if (!openDialog) { resolve(window.prompt(question, o.initial ?? '')); return; }
    openDialog({ kind: 'prompt', title: t.title.replace(/\s*\(YYYY-MM-DD\)/, ''), body: t.body, ok: o.ok ?? 'Continue', cancel: 'Go back', danger: false,
      input: { type, initial: o.initial ?? '', placeholder: o.placeholder, multiline: o.multiline ?? /why|reason|what happened|note/i.test(question) }, resolve: (v) => resolve(v as string | null) });
  });
}

function DialogHost() {
  const [q, setQ] = useState<DialogReq[]>([]);
  const [val, setVal] = useState('');
  const okRef = useRef<HTMLButtonElement>(null);
  const inRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { openDialog = (r) => setQ((x) => [...x, r]); return () => { openDialog = null; }; }, []);
  const cur = q[0];
  useEffect(() => {
    if (!cur) return;
    setVal(cur.input?.initial ?? '');
    const id = setTimeout(() => (cur.input ? inRef.current?.focus() : okRef.current?.focus()), 20);
    return () => clearTimeout(id);
  }, [cur]);
  if (!cur) return null;
  const done = (v: unknown) => { cur.resolve(v); setQ((x) => x.slice(1)); };
  const cancel = () => done(cur.kind === 'confirm' ? false : cur.kind === 'prompt' ? null : undefined);
  const submit = () => { if (cur.kind === 'prompt') { if (val.trim()) done(val.trim()); } else done(true); };
  return (
    <div className="dialog-back" onMouseDown={(e) => { if (e.target === e.currentTarget && cur.kind !== 'notice') cancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <div className="dialog" role={cur.kind === 'notice' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dlg-title">
        <h3 id="dlg-title">{cur.title}</h3>
        {cur.body && <div className="dialog-body">{cur.body}</div>}
        {cur.input && (cur.input.multiline
          ? <textarea ref={inRef} className="input" rows={3} value={val} placeholder={cur.input.placeholder} onChange={(e) => setVal(e.target.value)} aria-label={cur.title} />
          : <input ref={inRef} className="input" type={cur.input.type} value={val} placeholder={cur.input.placeholder} onChange={(e) => setVal(e.target.value)} aria-label={cur.title}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />)}
        <div className="dialog-actions">
          {cur.kind !== 'notice' && <button className="btn quiet" onClick={cancel}>{cur.cancel}</button>}
          <button ref={okRef} className={`btn ${cur.danger ? 'danger-solid' : ''}`} disabled={cur.kind === 'prompt' && !val.trim()} onClick={submit}>{cur.ok}</button>
        </div>
      </div>
    </div>
  );
}

/** Runs an action, shows the server's message on failure, and returns the result or null. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      const err = e as ApiError;
      const detail = Array.isArray(err.details) ? ` ${(err.details as { message: string }[]).map((d) => d.message).join(' ')}` : '';
      toast(`${err.message}${detail} (${err.number ?? 'NS-APP'}${err.ref ? ` · ${err.ref}` : ''})`, 'error');
      return null;
    } finally { setBusy(false); }
  };
  return { run, busy };
}

export const CatChip = ({ code }: { code: string }) => (
  <span className="cat" style={{ background: `var(--cat-${code}, #6E6E73)`, color: ['3C', '4A', '4B'].includes(code) ? '#0B1F4D' : '#fff' }} title={`Admission category ${code}`}>
    {code}
  </span>
);

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'green', ADMITTED: 'green', VERIFIED: 'blue', PAID: 'green', CAPTURED: 'green', OFFERED: 'blue', SUBMITTED: '',
  PROVISIONAL: 'orange', WAITLISTED: 'orange', PENDING: 'orange', DUE: 'orange', REJECTED: 'red', WITHDRAWN: '', TRANSFERRED_OUT: '', FAILED: 'red',
};
export const Status = ({ s }: { s: string }) => <span className={`pill ${STATUS_TONE[s] ?? ''}`}>{words(s)}</span>;

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>{title}</h3>
          <button className="btn quiet small" onClick={onClose}>Close</button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export interface OrgUnit { id: string; kind: string; code: string; name: string; parent_id: string | null; path: string; school_type: string | null; active: boolean }

/** Schools within the signed-in person's scope; picks the first by default. */
export function useSchools() {
  const { data } = useLoad<OrgUnit[]>('/org/tree');
  const schools = (data ?? []).filter((u) => u.kind === 'school' && u.active);
  const campuses = (data ?? []).filter((u) => u.kind === 'campus' && u.active);
  return { schools, campuses, units: data ?? [] };
}

export function SchoolPicker({ value, onChange, schools }: { value: string; onChange: (id: string) => void; schools: OrgUnit[] }) {
  if (schools.length <= 1) return null;
  return (
    <label className="check small muted">School
      <select className="input" style={{ height: 36, width: 'auto' }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="School">
        {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export const initials = (name: string) => name.replace(/^(Lt Cdr|Cdr|Capt|Mrs|Mr|PO|Lt)\s+/, '').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** Each child's own colour while there is no photo, so brothers and sisters never look alike. */
const TONES: [string, string][] = [['#DCE4F2', '#7F95BE'], ['#F3E3B8', '#B98B2E'], ['#D5EADB', '#5E9A73'], ['#E7DDF1', '#9378B5']];
const photos = new Map<string, Promise<string | null>>();
const photoOf = (id: string) => {
  if (!photos.has(id)) photos.set(id, apiFile(`/photos/STUDENT/${id}`).then(({ blob }) => URL.createObjectURL(blob)).catch(() => null));
  return photos.get(id)!;
};

/** A child's photo: the one the school keeps for the ID card; until there is one, an outline in the child's colour. */
export function StudentPhoto({ id, name, size, tone = 0, radius = '50%', ring }: { id: string; name: string; size: number; tone?: number; radius?: string; ring?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let live = true; setSrc(null); photoOf(id).then((u) => { if (live) setSrc(u); }); return () => { live = false; }; }, [id]);
  const [bg, fg] = TONES[tone % TONES.length];
  return (
    <span className={`photo${ring ? ' ring' : ''}`} role="img" aria-label={`Photo of ${name}`} style={{ width: size, height: size, borderRadius: radius, background: bg }}>
      {src ? <img src={src} alt="" /> : <svg width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} viewBox="0 0 24 24" fill={fg} aria-hidden="true"><circle cx="12" cy="9" r="4.5" /><path d="M3 23c0-5 4-8 9-8s9 3 9 8z" /></svg>}
    </span>
  );
}

export type Theme = 'auto' | 'light' | 'dark';
const THEME_KEY = 'nes.theme';
export const savedTheme = (): Theme => { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };

/** Appearance: follow the phone or computer (Automatic), or always light or dark. Kept on this device only. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const choose = (t: Theme) => {
    setTheme(t);
    try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable: lasts until the page reloads */ }
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  };
  return (
    <div className="theme-switch">
      <span className="small muted">Appearance</span>
      <div className="seg" role="radiogroup" aria-label="Appearance">
        {([['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']] as [Theme, string][]).map(([t, label]) =>
          <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => choose(t)}>{label}</button>)}
      </div>
    </div>
  );
}
