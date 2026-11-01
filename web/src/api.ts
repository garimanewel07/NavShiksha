/** Thin API client. All rules live on the server; this only carries the session token. */
export class ApiError extends Error {
  /** number: what the user sees and can quote (NS-404); ref: an unexpected error's place in the error log. */
  constructor(public status: number, public code: string, message: string, public details?: unknown, public number = `NS-${status || '000'}`, public ref?: string) { super(message); }
}

/** Tells the whole app about the system's state (maintenance, stopped, read only) or a sign-out. */
export const announce = (name: 'nes:system' | 'nes:signed-out', detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** Turns any failed response, or no response at all, into one ApiError with a number. */
async function failure(res: Response | null): Promise<ApiError> {
  if (!res) return new ApiError(0, 'offline', 'NavShiksha cannot be reached. Check the internet connection and try again; nothing you typed has been lost.', undefined, 'NS-000');
  const data = await res.json().catch(() => ({}));
  const e = data?.error ?? {};
  const err = new ApiError(res.status, e.code ?? 'error', e.message ?? (res.status >= 500 ? 'Something went wrong on our side.' : 'Something went wrong.'), e.details, e.number, e.ref);
  if (res.status === 401 && err.code !== 'passcode_required') { setSession(null); announce('nes:signed-out', err.message); }
  if (['maintenance', 'locked_down'].includes(err.code)) announce('nes:system', { mode: err.code === 'locked_down' ? 'LOCKDOWN' : 'MAINTENANCE', message: err.message });
  if (err.code === 'read_only') announce('nes:system', { mode: 'READ_ONLY', message: err.message });
  return err;
}
const send = (input: string, init: RequestInit) => fetch(input, init).catch(() => null);

const KEY = 'nes.session';

export function session(): { token: string; user: User } | null {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setSession(s: { token: string; user: User } | null) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export interface User { id: string; name: string; role: string; designation: string | null; scopePath: string | null; guardianId: string | null; duties?: { schoolId: string; code: string }[];
  /** What the person may do (from /me): permissions from the role hold in all their schools, those from a duty only at that school. */
  can?: { roles: string[]; duties: Record<string, string[]> };
  /** On a committee or owning an action (governance), on an inspection team (inspections). */
  governance?: boolean; inspections?: boolean }

/** Whether to show an action: the same permission table the server checks (server/src/modules/access.ts). */
export const allowed = (u: User, perm: string, schoolId?: string | null) =>
  !!u.can && (u.can.roles.includes(perm) || (schoolId ? !!u.can.duties[perm]?.includes(schoolId) : !!u.can.duties[perm]?.length));

/** Whether the person holds a duty (at any school in their scope). */
export const hasDuty = (u: User, code: string) => !!u.duties?.some((d) => d.code === code);

/** On a test server, the testers' passcode for demo sign-in (kept for this browser tab only). */
export const passcode = {
  get: () => { try { return sessionStorage.getItem('nes.passcode') ?? ''; } catch { return ''; } },
  set: (p: string) => { try { sessionStorage.setItem('nes.passcode', p); } catch { /* storage unavailable */ } },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const s = session();
  const pc = path.startsWith('/auth/') ? passcode.get() : '';
  const res = await send(`/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...(pc ? { 'x-test-passcode': pc } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res || !res.ok) throw await failure(res);
  return (await res.json().catch(() => ({}))) as T;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const money = (paise: number, exact = false) => (exact ? inr2 : inr).format((paise ?? 0) / 100);
export const num = (n: number) => (n ?? 0).toLocaleString('en-IN');
export const day = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const time = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
/** Today in India (the schools' time zone), as YYYY-MM-DD. */
/** The academic year (April to March) a date falls in, as "2026-27". */
export const academicYearOf = (iso: string) => { const y = Number(iso.slice(0, 4)), start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1; return `${start}-${String((start + 1) % 100).padStart(2, '0')}`; };
/** The academic year today falls in, and the ones before it. */
export const currentYear = () => academicYearOf(today());
export const recentYears = (n: number) => Array.from({ length: n }, (_, i) => academicYearOf(`${Number(currentYear().slice(0, 4)) - i}-06-01`));
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ACRONYMS = /\b(nes|upi|cpo|po|tc|ncs|nkg|esm|cbse|udise|apaar|pen|ppo|id|nhq|wnc|enc|snc)\b/g;
export const words = (s?: string | null) =>
  (s ?? '').replaceAll('_', ' ').toLowerCase().replace(ACRONYMS, (m) => m.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());

/** Fetches a file the server makes (PDF, CSV) with the session, for opening or saving. */
export async function apiFile(path: string, opts: { method?: string; body?: unknown } = {}) {
  const s = session();
  const res = await send(`/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res || !res.ok) throw await failure(res);
  return { blob: await res.blob(), headers: res.headers };
}

/**
 * Opens a PDF in a new tab to print. Print at "Actual size" (100%), not "Fit to page", so labels,
 * cards and certificates line up with the stationery.
 */
export async function openPdf(path: string, body?: unknown) {
  const tab = window.open('', '_blank');
  try {
    const { blob, headers } = await apiFile(path, body ? { body } : {});
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return headers;
  } catch (e) { tab?.close(); throw e; }
}

/** Saves a file the server makes (a spreadsheet) to the computer. */
export async function saveFile(path: string, name: string, body?: unknown) {
  const { blob } = await apiFile(path, body ? { body } : {});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Reads a chosen file as base64 (images) or text (CSV). */
export const readBase64 = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] ?? '');
  r.onerror = () => fail(r.error);
  r.readAsDataURL(f);
});
export const readText = (f: File) => f.text();
