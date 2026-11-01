import { Component, useEffect, useState, type ReactNode } from 'react';
import { session } from './api';

/**
 * What people see when something goes wrong: never a blank page or the browser's own error.
 * Every error has a number (NS-404, NS-503…) they can quote; an unexpected one also has a
 * reference (E-… from the server, C-… from the browser) that the helpdesk finds in the error log.
 */

export const ERROR_TEXT: Record<string, { title: string; hint: string }> = {
  'NS-000': { title: 'NavShiksha cannot be reached', hint: 'Check the internet connection, then try again. Nothing you typed has been lost.' },
  'NS-400': { title: 'That request could not be read', hint: 'Go back and try again.' },
  'NS-401': { title: 'Please sign in again', hint: 'Your session has ended.' },
  'NS-403': { title: 'This is not part of your role', hint: 'If you need it for your work, ask your principal or NES to give you the duty.' },
  'NS-404': { title: 'Page not found', hint: 'The link may be old or mistyped.' },
  'NS-409': { title: 'That clashes with something already saved', hint: 'Reload to see the latest, then try again.' },
  'NS-422': { title: 'Some details need attention', hint: 'Check the highlighted fields and try again.' },
  'NS-423': { title: 'Changes are paused for a short while', hint: 'You can still look at everything. What you typed is still on the screen.' },
  'NS-429': { title: 'Too many tries', hint: 'Wait a minute, then try again.' },
  'NS-500': { title: 'Something went wrong on our side', hint: 'Nothing was saved. Try again; if it happens again, raise a ticket quoting the reference.' },
  'NS-503': { title: 'NavShiksha is paused for a short while', hint: 'Nothing has been lost. Please try again in a little while.' },
  'NS-APP': { title: 'This screen stopped working', hint: 'Reload the page. If it happens again, raise a ticket quoting the reference.' },
};

/** Sends a browser error to the server's error log (best effort) and returns its reference. */
export function reportClientError(message: string, stack?: string) {
  const ref = `C-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  fetch('/api/v1/system/client-errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, message: message.slice(0, 1000), stack: stack?.slice(0, 4000), path: location.pathname }) }).catch(() => {});
  return ref;
}

/** The number for a failed fetch: NS- and the status, or NS-000 when the server could not be reached. */
export const numberOf = (status?: number) => (status ? `NS-${status}` : 'NS-000');
/** The server's own message for a refused request, if it sent one. */
export const messageOf = async (r: Response) => { try { return (await r.json())?.error?.message as string | undefined; } catch { return undefined; } };

export function ErrorPage({ number, message, reference, full = false, onRetry, home = ['/', 'Go to the home page'] }: { number: string; message?: string; reference?: string; full?: boolean; onRetry?: () => void; home?: [string, string] }) {
  const t = ERROR_TEXT[number] ?? ERROR_TEXT['NS-500'];
  const signedIn = !!session();
  return (
    <div className={full ? 'err-page full' : 'err-page'} role="alert">
      <div className="err-card">
        <div className="err-number">{number}</div>
        <h1>{t.title}</h1>
        <p className="err-message">{message && message !== t.title ? message : t.hint}</p>
        {message && message !== t.title && <p className="err-hint">{t.hint}</p>}
        {reference && <p className="err-ref">Reference <code>{reference}</code></p>}
        <div className="err-actions">
          <button className="btn" onClick={() => (onRetry ? onRetry() : location.reload())}>Try again</button>
          <a className="btn quiet" href={home[0]}>{home[1]}</a>
          {signedIn && ['NS-500', 'NS-APP', 'NS-409'].includes(number) && <a className="btn quiet" href={`/help?about=${encodeURIComponent(`${number}${reference ? ` ${reference}` : ''} on ${location.pathname}`)}`}>Report the problem</a>}
        </div>
      </div>
    </div>
  );
}

export const NotFound = () => <ErrorPage number="NS-404" />;

/** Catches a screen that crashes, so the rest of the app keeps working, and shows a numbered error. */
export class ErrorBoundary extends Component<{ children: ReactNode; full?: boolean; resetKey?: string }, { error: Error | null; ref: string }> {
  state = { error: null as Error | null, ref: '' };
  static getDerivedStateFromError(error: Error) { return { error, ref: '' }; }
  componentDidCatch(error: Error) { this.setState({ ref: reportClientError(error.message, error.stack) }); }
  // Moving to another page clears the error, so one broken screen never blocks the rest.
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, ref: '' }); }
  render() {
    if (this.state.error) return <ErrorPage number="NS-APP" reference={this.state.ref} full={this.props.full} onRetry={() => this.setState({ error: null, ref: '' })} />;
    return this.props.children;
  }
}

type SystemState = { mode: 'NORMAL' | 'MAINTENANCE' | 'READ_ONLY' | 'LOCKDOWN'; message: string };

/**
 * Watches the system's state (every minute, and whenever a request is refused because of it): in
 * maintenance or when stopped, everyone but NES sees a maintenance page; when read only, a banner.
 */
export function SystemGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<SystemState>({ mode: 'NORMAL', message: '' });
  useEffect(() => {
    let alive = true;
    const check = () => fetch('/api/v1/system/status').then((r) => r.json()).then((d) => { if (alive && d?.mode) setSt({ mode: d.mode, message: d.message ?? '' }); }).catch(() => {});
    const onEvent = (e: Event) => setSt((e as CustomEvent).detail as SystemState);
    check();
    const t = setInterval(check, 60_000);
    window.addEventListener('nes:system', onEvent);
    window.addEventListener('nes:system-check', check);
    return () => { alive = false; clearInterval(t); window.removeEventListener('nes:system', onEvent); window.removeEventListener('nes:system-check', check); };
  }, []);
  const nes = session()?.user.role === 'NES_ADMIN';
  if (st.mode === 'LOCKDOWN' || (st.mode === 'MAINTENANCE' && !nes)) return <ErrorPage number="NS-503" message={st.message} full />;
  return <>
    {st.mode === 'READ_ONLY' && <div className="sys-banner" role="status">Changes are paused for a short while{st.message ? `: ${st.message}` : ''}. You can still look at everything.</div>}
    {st.mode === 'MAINTENANCE' && nes && <div className="sys-banner" role="status">Maintenance is on: only NES can use the system now. Turn it off under Emergency controls.</div>}
    {children}
  </>;
}

/** A whole screen that could not load: the error string from useLoad ("… (NS-404 · E-…)") as a designed page. */
export function FailedPage({ error }: { error: string }) {
  const m = /\s*\((NS-[0-9A-Z]+)(?: · ([A-Z]-[A-Z0-9-]+))?\)$/.exec(error);
  return <ErrorPage number={m?.[1] ?? 'NS-500'} message={m ? error.slice(0, m.index) : error} reference={m?.[2]} />;
}
