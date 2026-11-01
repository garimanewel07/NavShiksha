import { useState } from 'react';
import { api, time, type User } from '../api';
import { Empty, ask, askText, tell, useAction, useLoad } from '../ui';

interface Switch { key: string; label: string; help: string; on: boolean; reason: string; since: string | null; by: string | null }
interface Controls { switches: Switch[]; lockdown: { reason: string; since: string } | null; lockdownFile: string; history: { key: string; is_on: boolean; reason: string; at: string; by: string | null }[] }

const EVENT: Record<string, string> = { SIGN_OUT_ALL: 'Signed everyone out', LOCKDOWN: 'Stopped all traffic' };

/**
 * NES's emergency controls (kill switches): each stops new work at the door and changes no data,
 * so nothing is lost. The helpdesk and the developer see only the error log.
 */
export default function SystemControls({ user }: { user: User }) {
  const nes = user.role === 'NES_ADMIN';
  const c = useLoad<Controls>(nes ? '/system/switches' : null);
  const errors = useLoad<{ ref: string; at: string; method: string; path: string; status: number; message: string }[]>('/system/errors');
  const { run, busy } = useAction();
  const [tab, setTab] = useState(nes ? 'controls' : 'errors');
  const announce = () => window.dispatchEvent(new CustomEvent('nes:system-check'));

  const flip = async (s: Switch) => {
    let reason = '';
    if (!s.on) {
      const r = await askText(`Turn on ${s.label.toLowerCase()}? ${s.help}\n\nWhy? Users see the reason, and it is kept in the record.`, { placeholder: 'For example: updating the fee module, back by 6 pm', ok: `Turn on ${s.label.toLowerCase()}` });
      if (r === null) return;
      reason = r;
    } else if (!(await ask(`Turn off ${s.label.toLowerCase()}? Everything goes back to normal at once.`, { ok: 'Turn it off' }))) return;
    if (await run(() => api(`/system/switches/${s.key}`, { body: { on: !s.on, reason } }), s.on ? `${s.label} is off` : `${s.label} is on`)) { c.reload(); announce(); }
  };
  const signOutAll = async () => {
    const reason = await askText('Sign everyone out? Everyone except you is signed out at once and must sign in again. Use this if passwords may have leaked. Nothing they saved is lost; anything not yet saved on their screen is.\n\nWhy?', { ok: 'Sign everyone out' });
    if (reason === null) return;
    const r: any = await run(() => api('/system/sign-out-all', { body: { reason } }));
    if (r) { await tell(`${r.signedOut} sessions were ended.`); c.reload(); }
  };
  const stop = async () => {
    const reason = await askText('Stop all traffic? Every page and every request is refused at once, for everyone, including you. Work already being saved finishes first, so no data is lost. Bank confirmations of payments already made are still accepted.\n\nIt can be undone only on the server, by running "npm run unlock". Make sure someone with access to the server can do that.\n\nWhy?', { ok: 'Next' });
    if (reason === null) return;
    const confirm = await askText('Type STOP to stop all traffic now.', { ok: 'Stop all traffic' });
    if (confirm === null) return;
    if (await run(() => api('/system/lockdown', { body: { reason, confirm: confirm.trim().toUpperCase() } }))) location.reload();
  };

  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">{nes ? 'Emergency controls' : 'Error log'}</span>
        {nes && <><span className="spacer" style={{ flex: 1 }} /><span className="seg"><button className={tab === 'controls' ? 'on' : ''} onClick={() => setTab('controls')}>Controls</button><button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button><button className={tab === 'errors' ? 'on' : ''} onClick={() => setTab('errors')}>Error log</button></span></>}</div></div>
      <main className="page">
        {tab === 'controls' && nes && <>
          <section className="tile">
            <h2>For an attack, or while the system is updated</h2>
            <p className="muted" style={{ marginTop: 6 }}>No control deletes or changes data. Each stops new work at the door, so anything already being saved finishes and nothing is half-saved. Turn a control off and everything carries on as before.</p>
          </section>
          {!c.data ? <Empty>{c.error ?? 'Loading…'}</Empty> : <>
            <section className="tile stack">
              {c.data.switches.map((s) => <div key={s.key} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <span><b>{s.label}</b> {s.on && <span className="pill orange">On</span>}<span className="small muted" style={{ display: 'block' }}>{s.help}</span>
                  {s.on && <span className="tiny" style={{ display: 'block', marginTop: 4 }}>“{s.reason}” · {s.by ?? 'NES'} · since {time(s.since)}</span>}</span>
                <button className={s.on ? 'btn' : 'btn quiet'} disabled={busy} onClick={() => flip(s)}>{s.on ? 'Turn off' : 'Turn on'}</button>
              </div>)}
            </section>
            <section className="tile stack">
              <h3>If accounts may have been taken over</h3>
              <div className="list-row" style={{ gridTemplateColumns: '1fr auto' }}><span><b>Sign everyone out</b><span className="small muted" style={{ display: 'block' }}>Ends every session but yours. Pair it with Pause sign-ins while passwords are changed.</span></span>
                <button className="btn quiet" disabled={busy} onClick={signOutAll}>Sign everyone out</button></div>
            </section>
            <section className="tile stack danger-zone">
              <h3>Stop all traffic</h3>
              <p className="small">Refuses every page and request, for everyone, at once. Use it during an attack. It can be lifted only on the server (<code>npm run unlock</code>), so a stolen NES password cannot undo it. The stop is a file beside the database: <code className="tiny">{c.data.lockdownFile}</code></p>
              <div><button className="btn danger-solid" disabled={busy} onClick={stop}>Stop all traffic…</button></div>
            </section>
          </>}
        </>}
        {tab === 'history' && nes && <section className="tile">
          <h3>Every time a control was used</h3>
          {!c.data ? <Empty>Loading…</Empty> : !c.data.history.length ? <Empty>No control has been used yet.</Empty> : c.data.history.map((h, i) => <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span><b>{EVENT[h.key] ?? `${c.data!.switches.find((s) => s.key === h.key)?.label ?? h.key} turned ${h.is_on ? 'on' : 'off'}`}</b><span className="small muted" style={{ display: 'block' }}>{h.reason}</span></span>
            <span className="tiny muted" style={{ textAlign: 'right' }}>{h.by ?? '—'}<br />{time(h.at)}</span></div>)}
        </section>}
        {tab === 'errors' && <section className="tile">
          <h3>Unexpected errors</h3>
          <p className="small muted">Each one is shown to the user with its reference (E- from the server, C- from a browser). Search a ticket's reference here.</p>
          {!errors.data ? <Empty>{errors.error ?? 'Loading…'}</Empty> : !errors.data.length ? <Empty>No unexpected errors. Good.</Empty> : errors.data.map((e) => <div key={e.ref} className="list-row" style={{ gridTemplateColumns: '150px 1fr auto' }}>
            <code className="small">{e.ref}</code><span><span className="small">{e.message}</span><span className="tiny muted" style={{ display: 'block' }}>{e.method} {e.path}</span></span><span className="tiny muted">{time(e.at)}</span></div>)}
        </section>}
      </main>
    </>
  );
}
