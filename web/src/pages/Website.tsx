import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, day, time, type User } from '../api';
import { Drawer, Empty, Icon, useAction, useLoad, useSchools, useToast, ask, tell, askText } from '../ui';
import { BLOCKS, blockTitle, newId, type Field } from '../site/spec';
import { SiteView, type EditCtx, type Live, type Page, type SiteDoc } from '../site/SiteView';
import { SchoolDetailsPanel } from './School';
import { FailedPage } from '../errors';

interface Draft { slug: string; draft: SiteDoc; draftVersion: number; updatedAt: string; updatedBy: string | null; published: { version: number; publishedAt: string; publishedBy: string } | null; unpublishedChanges: boolean }

const I = {
  up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M5 12l7 7 7-7', copy: 'M8 8h12v12H8zM4 16V4h12', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
};

/** Index of every school website for NES and Command users (the Unified view). */
export function Websites({ user }: { user?: User }) {
  const { data } = useLoad<any[]>('/sites');
  // NES edits any school's site; a Command looks at its schools' sites but does not edit them.
  const edits = user?.role === 'NES_ADMIN';
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">School websites</span></div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head"><div><h2>Every school, one builder</h2><p className="muted" style={{ marginTop: 6 }}>Schools edit and publish their own websites. {edits ? 'You can open any school’s builder.' : 'You can view every published website in your area.'}</p></div></div>
          {!data ? <Empty>Loading…</Empty> : (
            <table className="table"><thead><tr><th>School</th><th>Address</th><th>Published</th><th /></tr></thead><tbody>
              {data.map((s) => <tr key={s.school_id}><td><b>{s.school}</b></td><td className="mono">{s.slug ? `/s/${s.slug}` : '—'}</td>
                <td>{s.version ? `Version ${s.version} · ${day(s.published_at)}` : <span className="pill orange">Not published</span>}</td>
                <td className="num" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{s.version && <a className="btn quiet small" href={`/s/${s.slug}`} target="_blank" rel="noreferrer">View</a>}{edits && <Link className="btn small" to={`/websites/${s.school_id}`}>Open builder</Link>}</td></tr>)}
            </tbody></table>)}
        </section>
      </main>
    </>
  );
}

/** The website builder for one school. */
export default function Website({ user }: { user: User }) {
  const params = useParams();
  const { schools } = useSchools();
  const schoolId = params.schoolId ?? (user.role === 'SCHOOL_ADMIN' ? schools[0]?.id : undefined);
  const school = schools.find((s) => s.id === schoolId);
  const { data, reload, error } = useLoad<Draft>(schoolId ? `/schools/${schoolId}/site` : null, [schoolId]);
  const [doc, setDoc] = useState<SiteDoc | null>(null);
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'pages' | 'settings' | 'images' | 'history' | 'enquiries'>('pages');
  const [pageId, setPageId] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const toast = useToast();
  const { run, busy } = useAction();

  useEffect(() => {
    if (!data) return;
    setDoc(structuredClone(data.draft)); setVersion(data.draftVersion); setDirty(false);
    setPageId((p) => (data.draft.pages.some((x) => x.id === p) ? p : data.draft.pages[0]?.id ?? ''));
  }, [data]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = (fn: (d: SiteDoc) => void) => setDoc((d) => { if (!d) return d; const n = structuredClone(d); fn(n); setDirty(true); return n; });
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0];
  const pageIndex = doc && page ? doc.pages.indexOf(page) : -1;

  const friendly = (field: string) => {
    const m = field.match(/^pages\.(\d+)(?:\.blocks\.(\d+))?(.*)$/);
    if (!m || !doc) return field.replace(/^settings\./, 'Settings › ');
    const p = doc.pages[+m[1]];
    const b = m[2] !== undefined ? p?.blocks[+m[2]] : null;
    return [`Page “${p?.title ?? m[1]}”`, b ? `${BLOCKS[b.type]?.label ?? b.type} “${blockTitle(b).slice(0, 30)}”` : null, m[3].replace(/^\./, '').replace(/\.(\d+)/g, (_, n) => ` ${+n + 1}`).replace(/\./g, ' › ') || null].filter(Boolean).join(' › ');
  };

  const save = async (): Promise<number | null> => {
    if (!doc || !schoolId) return null;
    setIssues([]);
    try {
      const r = await api<{ draftVersion: number }>(`/schools/${schoolId}/site`, { method: 'PUT', body: { draftVersion: version, doc } });
      setVersion(r.draftVersion); setDirty(false); toast('Draft saved');
      return r.draftVersion;
    } catch (e) {
      const err = e as ApiError;
      if (Array.isArray(err.details)) setIssues(err.details as { field: string; message: string }[]);
      toast(err.message, 'error');
      return null;
    }
  };
  const publish = async (note: string) => {
    if (!schoolId) return;
    const v = dirty ? await save() : version;
    if (v === null) return;
    const r = await run(() => api<{ version: number }>(`/schools/${schoolId}/site/publish`, { body: { draftVersion: v, note } }));
    if (r) { toast(`Published version ${r.version}. The website is live.`); setPublishing(false); reload(); }
  };

  if (!schoolId) return <main className="page"><Empty>{user.role === 'SCHOOL_ADMIN' ? 'Loading…' : 'Choose a school from School websites.'}</Empty></main>;
  if (error) return <FailedPage error={error} />;
  if (!doc || !data || !page) return <main className="page"><Empty>Loading the website…</Empty></main>;

  const pageLinks = doc.pages.map((p) => `/${p.slug}`);
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Website</span>
        <span className="muted small">{school?.name}</span>
        <span className="spacer" />
        <span className="small muted">{dirty ? 'Unsaved changes' : data.published ? (data.unpublishedChanges ? 'Saved · not published yet' : `Live · version ${data.published.version}`) : 'Not published yet'}</span>
        <button className="btn quiet small" onClick={() => setPreview(page.slug)}><Icon d={I.eye} size={16} />Preview</button>
        {data.published && <a className="btn quiet small" href={`/s/${data.slug}`} target="_blank" rel="noreferrer"><Icon d={I.ext} size={16} />Live site</a>}
        <button className="btn secondary small" disabled={!dirty} onClick={save}>Save draft</button>
        {/* The website editor drafts; the principal (or NES) publishes. */}
        {['SCHOOL_ADMIN', 'NES_ADMIN'].includes(user.role) ? <button className="btn small" disabled={busy} onClick={() => setPublishing(true)}>Publish</button> : <span className="tiny muted">The principal publishes</span>}
      </div></div>
      <main className="page">
        <div className="seg" role="tablist">
          {(['pages', 'settings', 'images', 'history', 'enquiries'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'images' ? 'Photos and files' : t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        {issues.length > 0 && <div className="callout red"><b>Fix these before saving:</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{issues.slice(0, 8).map((x, i) => <li key={i}>{friendly(x.field)}: {x.message}</li>)}</ul></div>}

        {tab === 'pages' && <LiveEditor doc={doc} slug={data.slug} schoolId={schoolId} page={page} pageIndex={pageIndex} change={change} pageLinks={pageLinks}
          onPage={(id) => setPageId(id)} />}

        {tab === 'settings' && (
          <section className="tile">
            <div className="tile-head"><div><h3>Website settings</h3><p className="muted small" style={{ marginTop: 4 }}>Shown on every page: name, notice ribbon, footer and colour.</p></div></div>
            <div className="form-grid">
              <label className="field"><span>Short name (menu)</span><input className="input" value={doc.settings.shortName} maxLength={30} onChange={(e) => change((d) => { d.settings.shortName = e.target.value; })} /></label>
              <label className="field"><span>Accent colour</span><span style={{ display: 'flex', gap: 8 }}><input type="color" value={doc.settings.accent} onChange={(e) => change((d) => { d.settings.accent = e.target.value.toUpperCase(); })} style={{ width: 56, height: 44, border: 0, background: 'none' }} /><input className="input mono" value={doc.settings.accent} onChange={(e) => change((d) => { d.settings.accent = e.target.value; })} /></span></label>
            </div>
            <div style={{ marginTop: 16 }}><h4 style={{ margin: '0 0 6px' }}>School details</h4>
              <SchoolDetailsPanel schoolId={schoolId} compact onSaved={(x) => change((d) => { d.settings.name = x.name; d.settings.address = x.address ?? ''; d.settings.phone = x.phone ?? undefined; d.settings.email = x.email ?? undefined; })} /></div>
            <div className="stack" style={{ marginTop: 16 }}>
              <label className="field"><span>Tagline</span><input className="input" value={doc.settings.tagline ?? ''} maxLength={200} onChange={(e) => change((d) => { d.settings.tagline = e.target.value; })} /></label>
              <label className="field"><span>Notice ribbon at the top (leave empty to hide)</span><input className="input" value={doc.settings.ribbon?.text ?? ''} maxLength={200}
                onChange={(e) => change((d) => { d.settings.ribbon = e.target.value ? { text: e.target.value, link: d.settings.ribbon?.link ?? null } : null; })} /></label>
              {doc.settings.ribbon?.text && <LinkField label="Ribbon link" optional value={doc.settings.ribbon.link} pageLinks={pageLinks} onChange={(v) => change((d) => { d.settings.ribbon!.link = v; })} />}
              <label className="field"><span>Footer line</span><input className="input" value={doc.settings.footer ?? ''} maxLength={400} onChange={(e) => change((d) => { d.settings.footer = e.target.value; })} /></label>
            </div>
          </section>
        )}
        {tab === 'settings' && (
          <section className="tile">
            <div className="tile-head"><div><h3>Start from a layout</h3><p className="muted small" style={{ marginTop: 4 }}>Replace the draft with a ready layout, then put in your own words and photos. The live website does not change until you publish.</p></div></div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
              {([['full', 'Full school website', 'Laid out like the present Navy Children School sites: 29 pages under About, Student corner, Academics, Admissions, Beyond the classroom and Gallery, with a photo slider, facilities with photos, toppers with photos, photo albums, videos, downloads and FAQs. Every photo place is marked for your own pictures.'],
                ['basic', 'Short website', 'Four pages: Home, About, Admissions and Contact. Add pages and sections as you need them.']] as const).map(([t, l, d]) => (
                <div key={t} className="callout stack small"><b>{l}</b><span className="muted">{d}</span>
                  <button className="btn quiet small" style={{ alignSelf: 'flex-start' }} disabled={busy || dirty} onClick={async () => {
                    if (!await ask(`Replace the draft with the ${l.toLowerCase()}? Your published website stays as it is until you publish again, and older published versions remain in History.`, { ok: 'Use this layout' })) return;
                    if (await run(() => api(`/schools/${schoolId}/site/start-from`, { body: { template: t, draftVersion: version } }), 'Layout loaded into the draft')) { reload(); setTab('pages'); }
                  }}>Use this layout</button></div>))}
            </div>
            {dirty && <p className="tiny muted" style={{ marginTop: 8 }}>Save or discard your changes first.</p>}
          </section>
        )}

        {tab === 'images' && <Images schoolId={schoolId} />}
        {tab === 'history' && <History schoolId={schoolId} version={version} dirty={dirty} onRestored={reload} published={data.published?.version} />}
        {tab === 'enquiries' && <Enquiries schoolId={schoolId} />}
      </main>

      {publishing && <Drawer title="Publish the website" onClose={() => setPublishing(false)}>
        <PublishForm busy={busy} dirty={dirty} onPublish={publish} />
      </Drawer>}

      {preview && <Preview doc={doc} slug={data.slug} page={preview} onPage={setPreview} onClose={() => setPreview(null)} />}
    </>
  );
}

function PublishForm({ busy, dirty, onPublish }: { busy: boolean; dirty: boolean; onPublish: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <div className="stack">
      <p className="muted">Publishing makes this version of the website public. Every published version is kept, so you can go back to any of them from History.</p>
      {dirty && <div className="callout blue small">Your unsaved changes will be saved first.</div>}
      <label className="field"><span>What changed? (optional)</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Updated toppers for 2026" /></label>
      <button className="btn big" disabled={busy} onClick={() => onPublish(note)}>Publish now</button>
    </div>
  );
}

/** Live ERP data (notices, holidays, toppers) in the numbers the draft asks for, not the published site's. */
function liveUrl(slug: string, doc: SiteDoc) {
  const blocks = doc.pages.flatMap((p) => p.blocks) as any[];
  const most = (t: string, k: string) => Math.max(0, ...blocks.filter((b) => b.type === t).map((b) => Number(b[k]) || 0));
  return `/api/v1/public/sites/${slug}?notices=${most('notices', 'limit')}&events=${most('calendar', 'limit')}&toppers=${most('liveToppers', 'perClass')}`;
}

function Preview({ doc, slug, page, onPage, onClose }: { doc: SiteDoc; slug: string; page: string; onPage: (p: string) => void; onClose: () => void }) {
  const [live, setLive] = useState<Live | null>(null);
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');
  const frame = useRef<HTMLDivElement>(null);
  const want = liveUrl(slug, doc);
  useEffect(() => { fetch(want).then((r) => (r.ok ? r.json() : null)).then((d) => setLive(d?.live ?? null)).catch(() => {}); }, [want]);
  useEffect(() => { frame.current?.scrollTo(0, 0); }, [page]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="preview-wrap" role="dialog" aria-label="Website preview">
      <div className="preview-bar">
        <b>Preview of your draft</b><span style={{ opacity: 0.7 }}>Not public until you publish</span><span className="spacer" style={{ flex: 1 }} />
        <span className="seg" style={{ background: '#3A3A3C' }}>
          <button className={width === 'desktop' ? 'on' : ''} style={{ color: width === 'desktop' ? undefined : '#fff' }} onClick={() => setWidth('desktop')}>Desktop</button>
          <button className={width === 'phone' ? 'on' : ''} style={{ color: width === 'phone' ? undefined : '#fff' }} onClick={() => setWidth('phone')}>Phone</button>
        </span>
        <button className="btn small" onClick={onClose}>Close preview</button>
      </div>
      <div className="preview-frame" ref={frame}>
        <div style={{ width: width === 'phone' ? 390 : '100%', maxWidth: '100%', margin: width === 'phone' ? '16px auto' : '0 auto', background: '#fff', minHeight: '100%', boxShadow: width === 'phone' ? '0 0 0 10px #1D1D1F, 0 20px 60px rgba(0,0,0,.35)' : undefined, borderRadius: width === 'phone' ? 28 : 0, overflow: 'hidden' }}>
          <SiteView doc={doc} slug={slug} page={page} live={live} preview onNavigate={onPage} />
        </div>
      </div>
    </div>
  );
}

function Images({ schoolId }: { schoolId: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/site/assets`, [schoolId]);
  const { run, busy } = useAction();
  const upload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const b64 = await shrink(f).catch(async (e) => { await tell(`${f.name}: ${(e as Error).message}`); return null; });
      if (!b64) continue;
      await run(() => api(`/schools/${schoolId}/site/assets`, { body: { name: f.name, dataBase64: b64 } }), `Uploaded ${f.name}`);
    }
    reload();
  };
  return (
    <section className="tile">
      <div className="tile-head"><div><h3>Photos and files</h3><p className="muted small" style={{ marginTop: 4 }}>Upload as many as you like: the campus, buildings, classrooms, events, students (with families’ consent) and staff. Photos from a phone or camera are made smaller automatically. PDFs (almanac, syllabus, mandatory disclosure, forms) go in Downloads sections. You can also upload straight from the place on the page where a photo goes.</p></div>
        <label className="btn small" style={{ cursor: busy ? 'wait' : 'pointer' }}>Upload photos or PDFs<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} /></label></div>
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No photos or files yet.</Empty> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {data.map((a) => <figure key={a.id} style={{ margin: 0 }}>{a.content_type === 'application/pdf'
            ? <a href={`/api/v1/public/assets/${a.id}`} target="_blank" rel="noreferrer" style={{ display: 'grid', placeItems: 'center', aspectRatio: '4/3', borderRadius: 12, background: '#FDECEC', color: '#C4161C', fontWeight: 700 }}>PDF</a>
            : <img src={`/api/v1/public/assets/${a.id}`} alt={a.name} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 12, background: 'var(--fill)' }} />}
            <figcaption className="tiny muted" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</figcaption></figure>)}
        </div>)}
    </section>
  );
}

function History({ schoolId, version, dirty, onRestored, published }: { schoolId: string; version: number; dirty: boolean; onRestored: () => void; published?: number }) {
  const { data } = useLoad<any[]>(`/schools/${schoolId}/site/releases`, [schoolId, published]);
  const { run, busy } = useAction();
  return (
    <section className="tile">
      <div className="tile-head"><div><h3>Published versions</h3><p className="muted small" style={{ marginTop: 4 }}>Every publish is kept. Load an old version into the draft, check it, then publish it to roll back.</p></div></div>
      {dirty && <div className="callout orange small" style={{ marginBottom: 12 }}>Save or discard your unsaved changes before loading an old version.</div>}
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>Nothing published yet.</Empty> : (
        <table className="table"><thead><tr><th>Version</th><th>Note</th><th>By</th><th>When</th><th /></tr></thead><tbody>
          {data.map((r) => <tr key={r.version}><td><b>{r.version}</b>{r.version === published && <span className="pill green" style={{ marginLeft: 8 }}>Live</span>}</td><td>{r.note || '—'}</td><td>{r.published_by}</td><td>{time(r.published_at)}</td>
            <td className="num"><button className="btn quiet small" disabled={busy || dirty} onClick={async () => { if (await run(() => api(`/schools/${schoolId}/site/restore`, { body: { version: r.version, draftVersion: version } }), `Version ${r.version} loaded into the draft. Publish to make it live.`)) onRestored(); }}>Load into draft</button></td></tr>)}
        </tbody></table>)}
    </section>
  );
}

function Enquiries({ schoolId }: { schoolId: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/site/enquiries`, [schoolId]);
  const { run } = useAction();
  return (
    <section className="tile">
      <div className="tile-head"><div><h3>Enquiries from the website</h3><p className="muted small" style={{ marginTop: 4 }}>Sent through the contact form. Call or message the parent, then mark it replied.</p></div></div>
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No enquiries yet.</Empty> : (
        <table className="table"><thead><tr><th>From</th><th>About</th><th>Message</th><th>Received</th><th>Status</th></tr></thead><tbody>
          {data.map((e) => <tr key={e.id}><td><b>{e.name}</b><div className="small"><a href={`tel:${e.phone}`}>{e.phone}</a></div></td><td>{e.topic}</td><td style={{ maxWidth: 360 }}>{e.message}</td><td className="small">{time(e.created_at)}</td>
            <td><select className="input" style={{ height: 34, width: 'auto' }} value={e.status} onChange={async (ev) => { await run(() => api(`/site-enquiries/${e.id}/status`, { body: { status: ev.target.value } })); reload(); }}>
              <option value="NEW">New</option><option value="REPLIED">Replied</option><option value="CLOSED">Closed</option></select></td></tr>)}
        </tbody></table>)}
    </section>
  );
}

// ── Field editors ────────────────────────────────────────────────────────────────────────

function LinkField({ label, optional, value, onChange, pageLinks }: { label: string; optional?: boolean; value: any; onChange: (v: any) => void; pageLinks: string[] }) {
  const listId = useMemo(() => `pl-${newId()}`, []);
  if (!value) return optional ? <div><button className="btn quiet small" onClick={() => onChange({ label: 'Learn more', href: pageLinks[1] ?? '/home' })}><Icon d={I.plus} size={14} />{label}</button></div> : null;
  return (
    <div className="sub-item">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="small muted">{label}</span>{optional && <button className="linkbtn small" onClick={() => onChange(null)}>Remove</button>}</div>
      <div className="form-grid">
        <label className="field"><span>Button text</span><input className="input" value={value.label} maxLength={40} onChange={(e) => onChange({ ...value, label: e.target.value })} /></label>
        <label className="field"><span>Goes to</span><input className="input mono" list={listId} value={value.href} maxLength={400} onChange={(e) => onChange({ ...value, href: e.target.value })} placeholder="/admissions or https://…" />
          <datalist id={listId}>{pageLinks.map((p) => <option key={p} value={p} />)}<option value="/staff-login" /></datalist></label>
      </div>
    </div>
  );
}

/**
 * Makes a photo small enough for the website (longest side 2400 px, JPEG), so photos straight from a
 * phone or camera can be used. Small PNG, JPEG or WebP files are kept as they are.
 */
async function shrink(f: File): Promise<string> {
  if (f.type === 'application/pdf') {
    if (f.size > 10 * 1024 * 1024) throw new Error('PDFs must be 10 MB or smaller.');
    return await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f); });
  }
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) throw new Error('Use a PNG, JPEG or WebP photo, or a PDF.');
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('This photo could not be opened.')); i.src = url; });
    const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    let blob: Blob = f;
    if (scale < 1 || f.size > 3 * 1024 * 1024) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), 'image/jpeg', 0.85));
    }
    if (blob.size > 5 * 1024 * 1024) throw new Error('This photo is too large even after making it smaller.');
    return await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(blob); });
  } finally { URL.revokeObjectURL(url); }
}

function ImageField({ value, onChange, schoolId, help }: { value: string; onChange: (v: string) => void; schoolId: string; help?: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/site/assets`, [schoolId]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/schools/${schoolId}/site/assets`, { body: { name: f.name, dataBase64: await shrink(f) } });
      reload(); onChange(r.id);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="img-field">
      <div className="img-current">
        {value ? <img src={`/api/v1/public/assets/${value}`} alt="" /> : <div className="img-none">No photo yet</div>}
        <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
          <label className="btn small" style={{ cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Uploading…' : value ? 'Upload another' : 'Upload a photo'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {value && <button className="linkbtn small" onClick={() => onChange('')}>Remove photo</button>}
        </div>
      </div>
      {help && <span className="tiny muted">{help}</span>}
      {(data ?? []).some((a) => a.content_type !== 'application/pdf') && <><span className="tiny muted">Or choose one already uploaded:</span>
        <div className="img-strip">{(data ?? []).filter((a) => a.content_type !== 'application/pdf').map((a) => <button key={a.id} type="button" className={a.id === value ? 'on' : ''} title={a.name} onClick={() => onChange(a.id)}><img src={`/api/v1/public/assets/${a.id}`} alt={a.name} loading="lazy" /></button>)}</div></>}
    </div>
  );
}

/** A PDF for a Downloads section: upload one, or choose one already uploaded. */
function FileField({ value, onChange, schoolId, help }: { value: string; onChange: (v: string) => void; schoolId: string; help?: string }) {
  const { data, reload } = useLoad<any[]>(`/schools/${schoolId}/site/assets`, [schoolId]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const pdfs = (data ?? []).filter((a) => a.content_type === 'application/pdf');
  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/schools/${schoolId}/site/assets`, { body: { name: f.name, dataBase64: await shrink(f) } });
      reload(); onChange(r.id);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {value ? <a className="small" href={`/api/v1/public/assets/${value}`} target="_blank" rel="noreferrer">{pdfs.find((p) => p.id === value)?.name ?? 'Open the PDF'}</a> : <span className="small muted">No file yet</span>}
        <label className="btn small" style={{ cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Uploading…' : value ? 'Upload another' : 'Upload a PDF'}
          <input type="file" accept="application/pdf" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {value && <button className="linkbtn small" onClick={() => onChange('')}>Remove</button>}
      </div>
      {pdfs.length > 0 && <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Choose an uploaded PDF"><option value="">Or choose one already uploaded…</option>{pdfs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      {help && <span className="tiny muted">{help}</span>}
    </div>
  );
}

function Fields({ fields, value, onChange, pageLinks, schoolId, path = '' }: { fields: Field[]; value: Record<string, any>; onChange: (k: string, v: any) => void; pageLinks: string[]; schoolId: string; path?: string }) {
  return (
    <>
      {fields.map((f) => {
        const v = value[f.key];
        switch (f.kind) {
          case 'text':
            return <label key={f.key} className="field" data-path={path + f.key}><span>{f.label}{f.optional ? ' (optional)' : ''}</span><input className="input" value={v ?? ''} maxLength={f.max} onChange={(e) => onChange(f.key, e.target.value)} />{f.help && <span className="tiny muted">{f.help}</span>}</label>;
          case 'textarea':
            return <label key={f.key} className="field" data-path={path + f.key}><span>{f.label}{f.optional ? ' (optional)' : ''}</span><textarea className="input" value={v ?? ''} maxLength={f.max} rows={f.max && f.max > 1000 ? 8 : 3} onChange={(e) => onChange(f.key, e.target.value)} />{f.help && <span className="tiny muted">{f.help}</span>}</label>;
          case 'number':
            return <label key={f.key} className="field" data-path={path + f.key} style={{ maxWidth: 160 }}><span>{f.label}</span><input className="input" type="number" min={f.min} max={f.max} value={v ?? f.min} onChange={(e) => onChange(f.key, Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min)))} /></label>;
          case 'select':
            return <label key={f.key} className="field" data-path={path + f.key} style={{ maxWidth: 260 }}><span>{f.label}</span><select className="input" value={String(v ?? f.options[0][0])} onChange={(e) => { const o = f.options.find((x) => String(x[0]) === e.target.value); onChange(f.key, o ? o[0] : e.target.value); }}>
              {f.options.map(([ov, ol]) => <option key={String(ov)} value={String(ov)}>{ol}</option>)}</select></label>;
          case 'link':
            return <div key={f.key} data-path={path + f.key}><LinkField label={f.label} optional={f.optional} value={v} pageLinks={pageLinks} onChange={(nv) => onChange(f.key, nv)} /></div>;
          case 'image':
            return <div key={f.key} className="field" data-path={path + f.key}><span>{f.label}</span><ImageField value={v ?? ''} schoolId={schoolId} help={f.help} onChange={(nv) => onChange(f.key, nv)} /></div>;
          case 'file':
            return <div key={f.key} className="field" data-path={path + f.key}><span>{f.label}</span><FileField value={v ?? ''} schoolId={schoolId} help={f.help} onChange={(nv) => onChange(f.key, nv)} /></div>;
          case 'strings': {
            const arr: string[] = v ?? [];
            return <div key={f.key} className="field" data-path={path + f.key}><span>{f.label}</span><div className="sub-list">
              {arr.map((s, i) => <div key={i} style={{ display: 'flex', gap: 6 }}><input className="input" value={s} maxLength={80} onChange={(e) => onChange(f.key, arr.map((x, j) => (j === i ? e.target.value : x)))} />
                <button className="icon-btn" style={{ height: 44, width: 36 }} title={`Remove ${f.itemLabel}`} onClick={() => onChange(f.key, arr.filter((_, j) => j !== i))}><Icon d={I.trash} size={14} /></button></div>)}
              <button className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(f.key, [...arr, ''])}>+ Add {f.itemLabel}</button>
            </div></div>;
          }
          case 'list': {
            const arr: Record<string, any>[] = v ?? [];
            const set = (i: number, k: string, nv: any) => onChange(f.key, arr.map((x, j) => (j === i ? { ...x, [k]: nv } : x)));
            const move = (i: number, d: number) => { const n = [...arr]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(f.key, n); };
            return <div key={f.key} className="field" data-path={path + f.key}><span>{f.label}</span><div className="sub-list">
              {arr.map((item, i) => <div key={i} className="sub-item" data-path={`${path}${f.key}.${i}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span className="small muted" style={{ flex: 1 }}>{f.itemLabel[0].toUpperCase() + f.itemLabel.slice(1)} {i + 1}</span>
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><Icon d={I.up} size={14} /></button>
                  <button className="icon-btn" disabled={i === arr.length - 1} onClick={() => move(i, 1)} title="Move down"><Icon d={I.down} size={14} /></button>
                  <button className="icon-btn" onClick={() => onChange(f.key, arr.filter((_, j) => j !== i))} title={`Remove ${f.itemLabel}`}><Icon d={I.trash} size={14} /></button></div>
                <Fields fields={f.fields} value={item} pageLinks={pageLinks} schoolId={schoolId} path={`${path}${f.key}.${i}.`} onChange={(k, nv) => set(i, k, nv)} />
              </div>)}
              <button className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(f.key, [...arr, f.make()])}>+ Add {f.itemLabel}</button>
            </div></div>;
          }
        }
      })}
    </>
  );
}

// ── The live editor ──────────────────────────────────────────────────────────────────────

const DEVICES = { desktop: { label: 'Computer', width: '100%' }, tablet: { label: 'Tablet', width: '820px' }, phone: { label: 'Phone', width: '390px' } } as const;

/**
 * The page as visitors will see it, editable where it stands: click a heading, a text, a photo or a
 * button and its fields open beside the page; every change shows on the page at once. Empty places
 * say what goes there. Sections are added between others, and moved, copied or removed on the page.
 */
function LiveEditor({ doc, slug, schoolId, page, pageIndex, change, pageLinks, onPage }: { doc: SiteDoc; slug: string; schoolId: string; page: Page; pageIndex: number;
  change: (fn: (d: SiteDoc) => void) => void; pageLinks: string[]; onPage: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ path: string; at: number } | null>(null);
  const [device, setDevice] = useState<keyof typeof DEVICES>('desktop');
  const [adding, setAdding] = useState<number | null>(null);
  const [pageDrawer, setPageDrawer] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const want = liveUrl(slug, doc);
  useEffect(() => { fetch(want).then((r) => (r.ok ? r.json() : null)).then((d) => setLive(d?.live ?? null)).catch(() => {}); }, [want]);
  useEffect(() => { setSelected(null); }, [page.id]);
  // Clicking something on the page brings its field into view in the panel and puts the cursor in it.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      const el = inspector.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focus.path)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      el.querySelector<HTMLElement>('input:not([type=file]),textarea,select')?.focus({ preventScroll: true });
    }, 80);
    return () => clearTimeout(t);
  }, [focus]);

  const bi = page.blocks.findIndex((b) => b.id === selected);
  const block = bi >= 0 ? page.blocks[bi] : null;
  const edit: EditCtx = {
    selected,
    label: (b) => `${BLOCKS[b.type]?.label ?? b.type} · click to change`,
    select: (target, field) => {
      setSelected(target);
      let path = field;
      const i = page.blocks.findIndex((b) => b.id === target);
      if (i >= 0 && field) {
        const b = page.blocks[i];
        // "＋ Add a photo" in a photo section adds one; a missing button is added where it was clicked.
        if (b.type === 'gallery' && field === 'images') {
          const n = (b.images ?? []).length;
          change((d) => { d.pages[pageIndex].blocks[i].images = [...(b.images ?? []), { assetId: '', caption: '' }]; });
          path = `images.${n}.assetId`;
        }
        const def = BLOCKS[b.type]?.fields.find((f) => f.key === field);
        if (def?.kind === 'link' && !b[field]) change((d) => { (d.pages[pageIndex].blocks[i] as any)[field] = { label: field === 'button' ? 'Apply now' : 'Learn more', href: pageLinks.find((x) => x !== '/home') ?? '/home' }; });
        if (field === 'image' && b.type === 'hero' && b.style !== 'photo') change((d) => { d.pages[pageIndex].blocks[i].style = 'photo'; });
      }
      if (path) setFocus({ path, at: Date.now() });
    },
    act: async (id, a) => {
      const i = page.blocks.findIndex((b) => b.id === id);
      if (a === 'delete' && !await ask('Remove this section from the page?')) return;
      change((d) => {
        const bl = d.pages[pageIndex].blocks;
        if (a === 'up' && i > 0) { const [x] = bl.splice(i, 1); bl.splice(i - 1, 0, x); }
        if (a === 'down' && i < bl.length - 1) { const [x] = bl.splice(i, 1); bl.splice(i + 1, 0, x); }
        if (a === 'copy') bl.splice(i + 1, 0, { ...structuredClone(bl[i]), id: newId() });
        if (a === 'delete') bl.splice(i, 1);
      });
      if (a === 'delete') setSelected(null);
      setTimeout(() => document.getElementById(`blk-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    },
    add: (at) => setAdding(at),
  };
  const setting = (k: keyof SiteDoc['settings'], v: any) => change((d) => { (d.settings as any)[k] = v; });

  return (
    <div className="wb">
      <div className="wb-bar">
        <div className="wb-pages">
          {doc.pages.length <= 8 ? doc.pages.map((p) => <button key={p.id} className={p.id === page.id ? 'on' : ''} onClick={() => onPage(p.id)}>{p.title}{!p.inNav && p.slug !== 'home' ? ' (hidden)' : ''}</button>)
            : <select className="input" style={{ height: 36, width: 'auto', minWidth: 260 }} value={page.id} onChange={(e) => onPage(e.target.value)} aria-label="Page to edit">
                {[...new Set(doc.pages.map((p) => p.group ?? ''))].map((g) => <optgroup key={g || '—'} label={g || 'Pages'}>
                  {doc.pages.filter((p) => (p.group ?? '') === g).map((p) => <option key={p.id} value={p.id}>{p.title}{!p.inNav && p.slug !== 'home' ? ' (hidden)' : ''}</option>)}</optgroup>)}
              </select>}
          <button className="add" onClick={async () => {
            const title = await askText('Name of the new page');
            if (!title?.trim()) return;
            const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
            let slugTry = base; let k = 2;
            while (doc.pages.some((x) => x.slug === slugTry)) slugTry = `${base}-${k++}`;
            const np: Page = { id: newId(), slug: slugTry, title: title.trim().slice(0, 60), inNav: true, blocks: [{ id: newId(), type: 'hero', style: 'plain', title: title.trim() }] };
            change((d) => { d.pages.push(np); }); onPage(np.id);
          }}>＋ Page</button>
        </div>
        <button className="btn quiet small" onClick={() => setPageDrawer(true)}>Page settings</button>
        <span className="seg" role="group" aria-label="Show as">
          {(Object.keys(DEVICES) as (keyof typeof DEVICES)[]).map((k) => <button key={k} className={device === k ? 'on' : ''} onClick={() => setDevice(k)}>{DEVICES[k].label}</button>)}
        </span>
      </div>
      <div className="wb-main">
        <div className="wb-canvas" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div className={`wb-device ${device}`} style={{ width: DEVICES[device].width }}>
            <SiteView doc={doc} slug={slug} page={page.slug} live={live} preview edit={edit} />
          </div>
        </div>
        <aside className="wb-inspector" ref={inspector}>
          {block ? <>
            <div className="wb-ins-head">
              <div><b>{BLOCKS[block.type]?.label ?? block.type}</b><div className="tiny muted">{BLOCKS[block.type]?.hint}</div></div>
              <button className="linkbtn small" onClick={() => setSelected(null)}>Done</button>
            </div>
            <p className="tiny muted">Changes show on the page as you type. Click another part of the page to change it.</p>
            <Fields fields={BLOCKS[block.type]?.fields ?? []} value={block} pageLinks={pageLinks} schoolId={schoolId}
              onChange={(k, v) => change((d) => { (d.pages[pageIndex].blocks[bi] as any)[k] = v; })} />
            <div className="wb-ins-actions">
              <button className="btn quiet small" disabled={bi === 0} onClick={() => edit.act(block.id, 'up')}>Move up</button>
              <button className="btn quiet small" disabled={bi === page.blocks.length - 1} onClick={() => edit.act(block.id, 'down')}>Move down</button>
              <button className="btn quiet small" onClick={() => edit.act(block.id, 'copy')}>Copy</button>
              <button className="btn quiet small danger-text" onClick={() => edit.act(block.id, 'delete')}>Remove</button>
            </div>
          </> : selected === 'settings' ? <>
            <div className="wb-ins-head"><div><b>Top of every page</b><div className="tiny muted">Name in the menu and the notice ribbon</div></div><button className="linkbtn small" onClick={() => setSelected(null)}>Done</button></div>
            <label className="field" data-path="shortName"><span>Name in the menu</span><input className="input" value={doc.settings.shortName} maxLength={30} onChange={(e) => setting('shortName', e.target.value)} /></label>
            <label className="field" data-path="ribbon"><span>Notice ribbon (leave empty to hide)</span><input className="input" value={doc.settings.ribbon?.text ?? ''} maxLength={200}
              onChange={(e) => change((d) => { d.settings.ribbon = e.target.value ? { text: e.target.value, link: d.settings.ribbon?.link ?? null } : null; })} /></label>
            {doc.settings.ribbon?.text && <LinkField label="Ribbon link" optional value={doc.settings.ribbon.link} pageLinks={pageLinks} onChange={(v) => change((d) => { d.settings.ribbon!.link = v; })} />}
            <label className="field" data-path="accent"><span>Accent colour (buttons and links)</span><span style={{ display: 'flex', gap: 8 }}><input type="color" value={doc.settings.accent} onChange={(e) => setting('accent', e.target.value.toUpperCase())} style={{ width: 56, height: 44, border: 0, background: 'none' }} /><input className="input mono" value={doc.settings.accent} onChange={(e) => setting('accent', e.target.value)} /></span></label>
            <p className="tiny muted">The school logo comes from Printing → School images; the official Navy Children School emblem is used until the school uploads its own.</p>
          </> : selected === 'footer' ? <>
            <div className="wb-ins-head"><div><b>Bottom of every page</b><div className="tiny muted">School name, address and contact</div></div><button className="linkbtn small" onClick={() => setSelected(null)}>Done</button></div>
            <div data-path="name"><SchoolDetailsPanel schoolId={schoolId} compact onSaved={(x) => change((d) => { d.settings.name = x.name; d.settings.address = x.address ?? ''; d.settings.phone = x.phone ?? undefined; d.settings.email = x.email ?? undefined; })} /></div>
            <label className="field" data-path="footer"><span>Footer line</span><input className="input" value={doc.settings.footer ?? ''} maxLength={400} onChange={(e) => setting('footer', e.target.value)} /></label>
          </> : <>
            <div className="wb-ins-head"><div><b>Edit this page</b><div className="tiny muted">{page.title} · /{page.slug}</div></div></div>
            <ol className="wb-guide">
              <li><b>Click anything on the page</b> — a heading, a line of text, a photo or a button. Its fields open here and the page changes as you type.</li>
              <li><b>Dashed places</b> show what can go there: “Photo goes here”, “Add a button”, an introduction. Click them to fill them in.</li>
              <li><b>＋ Add a section here</b> appears between sections when you point at the gap.</li>
              <li>Switch between <b>Computer</b>, <b>Tablet</b> and <b>Phone</b> above to see the page on each.</li>
              <li><b>Save draft</b> keeps your work; <b>Publish</b> makes it public.</li>
            </ol>
            <div className="small muted" style={{ marginTop: 6 }}>Sections on this page</div>
            <div className="wb-outline">
              {page.blocks.map((b) => <button key={b.id} onClick={() => { setSelected(b.id); document.getElementById(`blk-${b.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
                <span className="pill">{BLOCKS[b.type]?.label ?? b.type}</span><span className="ellipsis">{blockTitle(b)}</span></button>)}
              <button className="add" onClick={() => setAdding(page.blocks.length)}>＋ Add a section at the end</button>
            </div>
          </>}
        </aside>
      </div>

      {adding !== null && <Drawer title="Add a section" onClose={() => setAdding(null)}>
        <div className="type-grid">
          {Object.entries(BLOCKS).map(([type, spec]) => (
            <button key={type} onClick={() => {
              const nb = { id: newId(), type, ...spec.make() };
              const at = adding;
              change((d) => { d.pages[pageIndex].blocks.splice(at, 0, nb as any); });
              setAdding(null); setSelected(nb.id);
              setTimeout(() => document.getElementById(`blk-${nb.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
            }}><b>{spec.label}</b><div className="small muted" style={{ marginTop: 4 }}>{spec.hint}</div></button>))}
        </div>
      </Drawer>}

      {pageDrawer && <Drawer title={`Page: ${page.title}`} onClose={() => setPageDrawer(false)}>
        <section className="tile tight stack">
          <label className="field"><span>Page name (in the menu)</span><input className="input" value={page.title} maxLength={60} onChange={(e) => change((d) => { d.pages[pageIndex].title = e.target.value; })} /></label>
          <label className="field"><span>Address</span><input className="input mono" value={page.slug} disabled={page.slug === 'home'} maxLength={40}
            onChange={(e) => change((d) => { d.pages[pageIndex].slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); })} /><span className="tiny muted">/s/{slug}/{page.slug === 'home' ? '' : page.slug}</span></label>
          {page.slug !== 'home' && <label className="check"><input type="checkbox" checked={page.inNav} onChange={(e) => change((d) => { d.pages[pageIndex].inNav = e.target.checked; })} />Show in the menu</label>}
          {page.slug !== 'home' && page.inNav && <label className="field"><span>Menu heading (optional)</span>
            <input className="input" list="wb-groups" value={page.group ?? ''} maxLength={30} placeholder="e.g. About, Admissions, Gallery" onChange={(e) => change((d) => { const g = e.target.value; if (g) d.pages[pageIndex].group = g; else delete d.pages[pageIndex].group; })} />
            <datalist id="wb-groups">{[...new Set(doc.pages.map((p) => p.group).filter(Boolean))].map((g) => <option key={g} value={g} />)}</datalist>
            <span className="tiny muted">Pages with the same heading appear together in a drop-down menu, like About ▸ Principal’s message.</span></label>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn quiet small" disabled={pageIndex <= 0} onClick={() => change((d) => { const [x] = d.pages.splice(pageIndex, 1); d.pages.splice(pageIndex - 1, 0, x); })}>Earlier in the menu</button>
            <button className="btn quiet small" disabled={pageIndex >= doc.pages.length - 1} onClick={() => change((d) => { const [x] = d.pages.splice(pageIndex, 1); d.pages.splice(pageIndex + 1, 0, x); })}>Later in the menu</button>
            {page.slug !== 'home' && <button className="btn danger small" onClick={async () => { if (await ask(`Delete the page “${page.title}”? You can undo by not saving.`)) { change((d) => { d.pages.splice(pageIndex, 1); }); onPage(doc.pages[0].id); setPageDrawer(false); } }}>Delete page</button>}
          </div>
        </section>
      </Drawer>}
    </div>
  );
}
