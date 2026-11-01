import { useState } from 'react';
import { api, passcode, words, type User } from '../api';
import { initials, useAction, useLoad } from '../ui';

interface DemoUser { id: string; name: string; role: string; designation: string; unit: string }

/** Development sign-in: choose a seeded person. Production uses MFA for staff and OTP for parents. */
export default function Login({ onSignedIn, notice }: { onSignedIn: (s: { token: string; user: User }) => void; notice?: string }) {
  const { data, error, reload } = useLoad<DemoUser[]>('/auth/demo-users');
  const { run, busy } = useAction();
  const [code, setCode] = useState('');
  const locked = !!error && /passcode/i.test(error);
  const signIn = async (id: string) => {
    const r = await run(() => api<{ token: string; user: User }>('/auth/login', { body: { userId: id } }));
    if (r) onSignedIn(r);
  };
  return (
    <main className="page" style={{ maxWidth: 980, paddingTop: 72 }}>
      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <div className="eyebrow">Test system · R1–R4 complete, R5 and R6 in progress</div>
        <img src="/brand/navshiksha/stacked.png" alt="NavShiksha" style={{ height: 150, margin: '14px auto 0', display: 'block' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <img src="/brand/nes-logo.png" alt="Navy Education Society" style={{ height: 40 }} />
          <img src="/brand/ncs-logo.png" alt="Navy Children School" style={{ height: 40 }} />
          <span className="muted small" style={{ textAlign: 'left' }}>For the Navy Education Society,<br />Navy Children Schools and Navy Kindergartens</span>
        </div>
        <p className="muted" style={{ fontSize: '1.24rem', marginTop: 8 }}>Choose who you are to try the system. All data is sample data.</p>
      </div>
      {notice && <div className="callout" role="status" style={{ maxWidth: 520, margin: '16px auto' }}>{notice}</div>}
      {locked && <form className="tile tight stack" style={{ maxWidth: 420, margin: '20px auto' }} onSubmit={(e) => { e.preventDefault(); passcode.set(code.trim()); reload(); }}>
        <b>This is a test server.</b><span className="small muted">Enter the passcode you were given to try NavShiksha.</span>
        <input className="input" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Testers’ passcode" />
        <button className="btn" disabled={!code.trim()}>Continue</button>
      </form>}
      {!locked && ([['NES and Commands', ['NES_ADMIN', 'COMMAND_OFFICER']], ['School staff', ['SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF']], ['Parents · NavShiksha parent app', ['PARENT']], ['Job candidates · NavShiksha Careers', ['CANDIDATE']], ['NavShiksha helpdesk and developer', ['SUPPORT', 'DEVELOPER']]] as const).map(([title, roles]) => (
        <section key={title} className="stack" style={{ gap: 12 }}>
          <h3 style={{ marginTop: 16 }}>{title}</h3>
          <div className="grid">
            {(data ?? []).filter((u) => (roles as readonly string[]).includes(u.role)).map((u) => (
              <button key={u.id} className="tile tight" disabled={busy} onClick={() => signIn(u.id)}
                style={{ border: 0, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 16, alignItems: 'center' }}>
                <span className="avatar" style={{ width: 48, height: 48, fontSize: '0.9rem', background: u.role === 'PARENT' ? 'var(--blue)' : 'var(--brand)' }}>{initials(u.name)}</span>
                <span style={{ lineHeight: 1.3 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '1.05rem' }}>{u.name}</span>
                  <span className="muted small" style={{ display: 'block' }}>{u.designation}</span>
                  <span className="pill" style={{ marginTop: 6 }}>{words(u.role)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {error && !locked && <div className="callout red small">{error}</div>}
      <p className="muted small" style={{ textAlign: 'center', marginTop: 12 }}>School websites: <a href="/s/ncs-mumbai">NCS Mumbai</a> · built and published from the ERP.</p>
    </main>
  );
}
