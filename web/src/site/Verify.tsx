import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorPage, messageOf, numberOf } from '../errors';

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The page a certificate's QR code opens. Anyone (another school, an office checking a CEA
 * claim) can see whether the certificate is genuine and still valid. No sign-in.
 */
export default function Verify() {
  const { code } = useParams();
  const [r, setR] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState<{ number: string; message?: string } | null>(null);
  useEffect(() => {
    fetch(`/api/v1/public/verify/${encodeURIComponent(code ?? '')}`).then(async (res) => {
      if (res.ok) setR(await res.json()); else if (res.status === 404) setMissing(true); else setFailed({ number: numberOf(res.status), message: await messageOf(res) });
    }).catch(() => setFailed({ number: 'NS-000' }));
  }, [code]);
  if (failed) return <ErrorPage number={failed.number} message={failed.message} full />;
  const tone = !r ? '#6E6E73' : r.valid ? '#1B7F3B' : '#B3261E';
  return (
    <main style={{ minHeight: '100vh', background: '#F5F5F7', display: 'grid', placeItems: 'center', padding: '24px max(16px, env(safe-area-inset-left, 0px))' }}>
      <section style={{ background: '#fff', borderRadius: 20, padding: '32px 28px', width: '100%', maxWidth: 520, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <div style={{ fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6E6E73', fontWeight: 600 }}>Navy Education Society · certificate check</div>
        {missing ? <>
          <h1 style={{ fontSize: 26, margin: '12px 0 8px', color: '#B3261E' }}>Not found</h1>
          <p style={{ color: '#3A3A3C', lineHeight: 1.5 }}>No certificate has the code <strong style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{code}</strong>. Check the code printed under the QR code, or contact the school that issued it.</p>
        </> : !r ? <p style={{ marginTop: 16 }}>Checking…</p> : <>
          <h1 style={{ fontSize: 26, margin: '12px 0 4px', color: tone }}>{r.valid ? 'Genuine and valid' : r.status === 'CANCELLED' ? 'Cancelled' : 'Not valid'}</h1>
          <p style={{ color: '#3A3A3C', marginTop: 0 }}>{r.valid ? 'This certificate was issued by the school and has not been cancelled.' : r.cancelReason ? `The school cancelled this certificate: ${r.cancelReason}` : 'This certificate is not in force.'}</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '10px 16px', marginTop: 20, fontSize: 15 }}>
            {([['Certificate', r.title], ['Serial number', r.serial], ['Issued on', r.issuedOn ? fmt(r.issuedOn) : ''], ['Student', r.student], ['Class', r.className], ['Admission number', r.admissionNo], ['School', r.school]] as [string, string][])
              .filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt style={{ color: '#6E6E73' }}>{k}</dt><dd style={{ margin: 0, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd></Fragment>)}
          </dl>
          <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 20 }}>Compare these details with the printed certificate. If anything differs, the paper copy has been altered.</p>
        </>}
      </section>
    </main>
  );
}
