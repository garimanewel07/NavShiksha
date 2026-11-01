import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './site.css';

export type SLink = { label: string; href: string } | null | undefined;
export interface Block { id: string; type: string; [k: string]: any }
export interface Page { id: string; slug: string; title: string; inNav: boolean; group?: string; blocks: Block[] }
export interface SiteDoc {
  settings: { name: string; shortName: string; tagline?: string; ribbon?: { text: string; link?: SLink } | null; accent: string; footer?: string; address?: string; phone?: string; email?: string };
  pages: Page[];
}
export interface Live {
  notices: { id: string; title: string; body: string; kind: string; created_at: string }[];
  events: { id: string; title: string; kind: string; starts: string; ends: string }[];
  toppers?: { assessment: string; rows: { class_code: string; class_name: string; name: string; percentage: number }[] } | null;
}

interface Ctx { slug: string; preview: boolean; go: (page: string) => void; live: Live | null; editing: boolean }

/** While editing in the builder: what is selected, and what the editor does when a part of the page is clicked. */
export interface EditCtx {
  selected: string | null;
  label: (b: Block) => string;
  select: (target: string, field?: string) => void;
  act: (blockId: string, action: 'up' | 'down' | 'copy' | 'delete') => void;
  add: (at: number) => void;
}

/** Turns a link from the content into a destination. "/staff-login" is the ERP sign-in. */
function A({ ctx, href, className, children, style, edit }: { ctx: Ctx; href: string; className?: string; children: ReactNode; style?: CSSProperties; edit?: string }) {
  if (ctx.editing) return <a className={className} style={style} href="#" data-edit={edit} onClick={(e) => e.preventDefault()}>{children}</a>;
  if (href === '/staff-login') return <a className={className} style={style} href="/">{children}</a>;
  // NavShiksha's own portals, shared by every school.
  if (href === '/navshiksha-careers' || href === '/navshiksha-alumni') return <a className={className} style={style} href={href === '/navshiksha-careers' ? '/careers' : '/alumni'}>{children}</a>;
  if (href.startsWith('/')) {
    const page = href.replace(/^\/+/, '').split(/[?#]/)[0] || 'home';
    if (ctx.preview) return <a className={className} style={style} href="#" onClick={(e) => { e.preventDefault(); ctx.go(page); }}>{children}</a>;
    return <Link className={className} style={style} to={`/s/${ctx.slug}${page === 'home' ? '' : `/${page}`}`}>{children}</Link>;
  }
  const external = href.startsWith('https://');
  return <a className={className} style={style} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>;
}

const initials = (n: string) => n.replace(/^(Vice Admiral|Dr \(Mrs\)|Dr|Mrs|Mr|Ms|Cdr|Cmde|Capt|SLt|Lt)\.?\s+/i, '').split(/[\s,]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).slice(0, 2).join('');
const GRADS = ['#2E8BF0,#0B1F4D', '#5E5CE6,#0B1F4D', '#30B0C7,#0B1F4D', '#C9A227,#5C4A0A'];
const dm = (d: string) => { const x = new Date(d.length === 10 ? `${d}T00:00:00` : d); return { d: x.toLocaleDateString('en-IN', { day: '2-digit' }), m: x.toLocaleDateString('en-IN', { month: 'short' }) }; };
const paras = (t?: string) => (t ?? '').split(/\n{2,}/).filter(Boolean);
const KIND: Record<string, string> = { PTM: 'Parent–teacher meeting', EXAM: 'Exam', HOLIDAY: 'Holiday', VACATION: 'Vacation', EVENT: 'Event', NOTICE: 'Notice', CIRCULAR: 'Circular', URGENT: 'Urgent' };
const kindLabel = (k: string) => KIND[k] ?? k[0] + k.slice(1).toLowerCase().replace(/_/g, ' ');

/** Text from the content. While editing, an empty field shows what goes there, and any text can be clicked to change it. */
function T({ ctx, f, v, as = 'p', className, style, ph }: { ctx: Ctx; f: string; v?: string; as?: 'p' | 'h1' | 'h2' | 'b' | 'span' | 'div' | 'time'; className?: string; style?: CSSProperties; ph: string }) {
  if (!v && !ctx.editing) return null;
  const Tag = as;
  return <Tag className={`${className ?? ''}${!v ? ' edit-empty' : ''}`.trim() || undefined} style={style} data-edit={ctx.editing ? f : undefined}>{v || ph}</Tag>;
}

/** A photo the school uploaded. While editing, an empty one shows where it will appear. */
function Photo({ ctx, f, id, className, alt, ph = 'Photo goes here', style }: { ctx: Ctx; f: string; id?: string; className?: string; alt?: string; ph?: string; style?: CSSProperties }) {
  if (id) return <img className={className} style={style} src={`/api/v1/public/assets/${id}`} alt={alt ?? ''} loading="lazy" data-edit={ctx.editing ? f : undefined} />;
  if (!ctx.editing) return null;
  return <div className={`edit-photo ${className ?? ''}`} style={style} data-edit={f}><span>📷 {ph}<small>Click to choose or upload a photo</small></span></div>;
}

/** A button from the content; while editing, a missing optional one can be added where it would appear. */
function Btn({ ctx, f, l, className, ph }: { ctx: Ctx; f: string; l: SLink; className: string; ph: string }) {
  if (l) return <A ctx={ctx} className={className} href={l.href} edit={f}>{l.label}</A>;
  if (!ctx.editing) return null;
  return <span className={`${className} edit-empty edit-btn`} data-edit={f}>＋ {ph}</span>;
}

function Head({ b, left, ctx }: { b: Block; left?: boolean; ctx: Ctx }) {
  if (!b.eyebrow && !b.title && !b.subtitle && !ctx.editing) return null;
  return (
    <div className="head" style={left ? { textAlign: 'left', marginLeft: 0 } : undefined}>
      <T ctx={ctx} f="eyebrow" v={b.eyebrow} className="eyebrow" ph="Small heading (optional)" />
      <T ctx={ctx} f="title" v={b.title} as="h2" className="h2" style={{ marginTop: b.eyebrow || ctx.editing ? 6 : 0 }} ph="Heading" />
      <T ctx={ctx} f="subtitle" v={b.subtitle} className="lede" ph="A line of introduction (optional)" />
    </div>
  );
}

function Horizon() {
  return (
    <svg className="horizon" viewBox="0 70 1440 290" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <filter id="sv-blur" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="40" /></filter>
        <radialGradient id="sv-sun" cx="50%" cy="100%" r="60%"><stop offset="0" stopColor="#FFD98A" stopOpacity=".95" /><stop offset=".18" stopColor="#F5A65B" stopOpacity=".55" /><stop offset=".5" stopColor="#2E6BD8" stopOpacity=".18" /><stop offset="1" stopColor="#0B1F4D" stopOpacity="0" /></radialGradient>
        <linearGradient id="sv-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#16408F" /><stop offset="1" stopColor="#030A1C" /></linearGradient>
        <linearGradient id="sv-glint" x1="0" x2="1"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#FFE3A8" stopOpacity=".9" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <ellipse cx="720" cy="205" rx="820" ry="230" fill="url(#sv-sun)" /><circle cx="720" cy="206" r="120" fill="#FFB46B" opacity=".35" filter="url(#sv-blur)" />
      <circle cx="720" cy="206" r="54" fill="#FFE7B0" opacity=".9" />
      <rect y="200" width="1440" height="160" fill="url(#sv-sea)" /><rect y="199" width="1440" height="1.5" fill="url(#sv-glint)" />
      <g className="wave" stroke="#FFE3A8" strokeLinecap="round" fill="none" strokeWidth="2">
        <path d="M560 222h320" strokeOpacity=".7" /><path d="M600 240h240" strokeOpacity=".5" /><path d="M520 262h400" strokeOpacity=".3" /><path d="M640 286h160" strokeOpacity=".25" /><path d="M440 312h560" strokeOpacity=".12" />
      </g>
      <g fill="#030A1C" opacity=".92"><path d="M1010 199l6-14h70l6-8h20l4 8h44l10 14z" /><rect x="1062" y="166" width="3" height="14" /><rect x="1080" y="160" width="2" height="22" /><path d="M262 199l4-8h38l4 8z" opacity=".7" /></g>
    </svg>
  );
}


/** The 11-character id in a YouTube link, or null. */
export const ytId = (url?: string) => /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(url ?? '')?.[1] ?? null;

/** A YouTube video that loads from youtube-nocookie.com only when the visitor presses play. */
function Video({ id, title, editing }: { id: string | null; title?: string; editing: boolean }) {
  const [play, setPlay] = useState(false);
  if (!id) return <div className="edit-photo video-frame"><span>▶ Video goes here<small>Paste a YouTube link</small></span></div>;
  if (play && !editing) return <iframe className="video-frame" src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`} title={title || 'Video'} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />;
  return <button type="button" className="video-frame video-cover" style={{ backgroundImage: `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` }} onClick={() => setPlay(true)} aria-label={`Play ${title || 'video'}`}><span className="play" aria-hidden="true">▶</span></button>;
}

/** Photos in a grid or mosaic; a click opens them large, with arrows and Escape to close. */
function Gallery({ b, shown, ctx }: { b: Block; shown: any[]; ctx: Ctx }) {
  const [at, setAt] = useState<number | null>(null);
  const real = shown.filter((g) => g.assetId);
  useEffect(() => {
    if (at === null) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); if (e.key === 'ArrowRight') setAt((x) => (x! + 1) % real.length); if (e.key === 'ArrowLeft') setAt((x) => (x! - 1 + real.length) % real.length); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [at, real.length]);
  return <>
    <div className={`gallery${b.layout === 'mosaic' ? ' mosaic' : ''}`}>
      {shown.map((g, i) => <figure key={i}>{g.assetId
        ? (ctx.editing ? <Photo ctx={ctx} f={`images.${i}.assetId`} id={g.assetId} alt={g.caption ?? ''} />
          : <button type="button" className="gal-open" onClick={() => setAt(real.indexOf(g))} aria-label={`Open photo${g.caption ? `: ${g.caption}` : ''}`}><img src={`/api/v1/public/assets/${g.assetId}`} alt={g.caption ?? ''} loading="lazy" /></button>)
        : <div className="edit-photo gallery-ph" data-edit={`images.${i}.assetId`}><span>📷 Photo {i + 1}<small>Click to choose or upload</small></span></div>}
        {(g.caption || ctx.editing) && <T ctx={ctx} f={`images.${i}.caption`} v={g.caption} as="div" className="figcap" ph="Caption (optional)" />}</figure>)}
      {ctx.editing && <figure className="gallery-add" data-edit="images"><span>＋ Add a photo</span></figure>}
    </div>
    {at !== null && real[at] && <div className="lightbox" role="dialog" aria-label="Photo" onClick={() => setAt(null)}>
      <img src={`/api/v1/public/assets/${real[at].assetId}`} alt={real[at].caption ?? ''} onClick={(e) => e.stopPropagation()} />
      {real[at].caption && <p>{real[at].caption}</p>}
      {real.length > 1 && <><button className="lb-prev" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); setAt((at - 1 + real.length) % real.length); }}>‹</button>
        <button className="lb-next" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); setAt((at + 1) % real.length); }}>›</button></>}
      <button className="lb-close" aria-label="Close" onClick={() => setAt(null)}>✕</button>
    </div>}
  </>;
}

/** A slideshow of the school's photos across the top of a page, with a heading over it. */
function Slider({ b, ctx }: { b: Block; ctx: Ctx }) {
  const slides = ((b.slides ?? []) as { assetId: string; caption?: string }[]).filter((x) => x.assetId || ctx.editing);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = slides.length;
  useEffect(() => {
    if (!b.seconds || n < 2 || paused || ctx.editing || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), b.seconds * 1000);
    return () => clearInterval(t);
  }, [b.seconds, n, paused, ctx.editing]);
  const cur = slides[Math.min(i, n - 1)];
  // Until the school adds photos, visitors see the navy sea banner rather than an empty frame.
  if (!n && !ctx.editing) return <section className="hero"><div className="wrap">
    {b.title && <h1 className="h1">{b.title}</h1>}{b.subtitle && <p className="lede">{b.subtitle}</p>}
    {b.primary && <div className="ctas"><Btn ctx={ctx} f="primary" l={b.primary} className="btn" ph="" /></div>}</div><Horizon /></section>;
  return (
    <section className={`slider ${b.height === 'medium' ? 'medium' : ''}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      {slides.map((sl, k) => sl.assetId
        ? <img key={k} className={`slide${k === i ? ' on' : ''}`} src={`/api/v1/public/assets/${sl.assetId}`} alt={sl.caption ?? ''} data-edit={ctx.editing ? `slides.${k}.assetId` : undefined} loading={k === 0 ? 'eager' : 'lazy'} />
        : <div key={k} className={`slide edit-photo${k === i ? ' on' : ''}`} data-edit={`slides.${k}.assetId`}><span>📷 Slide {k + 1}<small>Click to choose a wide photo of the school</small></span></div>)}
      <div className="slider-shade" />
      <div className="wrap slider-text">
        <T ctx={ctx} f="title" v={b.title} as="h1" className="h1" ph="Heading over the photos (optional)" />
        <T ctx={ctx} f="subtitle" v={b.subtitle} className="lede" ph="A line about the school (optional)" />
        {(b.primary || ctx.editing) && <div className="ctas"><Btn ctx={ctx} f="primary" l={b.primary} className="btn" ph="Add a button" /></div>}
        {cur?.caption && <p className="slide-cap">{cur.caption}</p>}
      </div>
      {n > 1 && <>
        <button className="sl-prev" aria-label="Previous photo" onClick={() => setI((i - 1 + n) % n)}>‹</button>
        <button className="sl-next" aria-label="Next photo" onClick={() => setI((i + 1) % n)}>›</button>
        <div className="sl-dots">{slides.map((_, k) => <button key={k} className={k === i ? 'on' : ''} aria-label={`Photo ${k + 1}`} onClick={() => setI(k)} />)}</div></>}
    </section>
  );
}

function Enquiry({ b, ctx }: { b: Block; ctx: Ctx }) {
  const [state, setState] = useState<{ ref?: string; error?: string; busy?: boolean }>({});
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (ctx.preview || ctx.editing) { setState({ error: 'Preview: the form is switched off here.' }); return; }
    const f = new FormData(e.currentTarget);
    setState({ busy: true });
    const res = await fetch(`/api/v1/public/sites/${ctx.slug}/enquiries`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: f.get('name'), phone: f.get('phone'), topic: f.get('topic'), message: f.get('message') }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setState({ ref: data.reference });
    else setState({ error: data?.error?.details?.[0]?.message ?? data?.error?.message ?? 'Could not send. Please try again.' });
  };
  return (
    <div className="wrap">
      <Head b={b} ctx={ctx} />
      <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
        {state.ref ? (
          <div style={{ display: 'grid', gap: 8 }}><p className="h3">Thank you.</p><p className="muted">Your enquiry reached the school office. Reference <b>{state.ref}</b>.</p></div>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
            <div className="grid g2" style={{ gap: 14 }}>
              <label className="field">Your name<input className="input" name="name" required minLength={2} maxLength={80} autoComplete="name" /></label>
              <label className="field">Mobile<input className="input" name="phone" required inputMode="tel" autoComplete="tel" placeholder="+91" /></label>
            </div>
            <label className="field">About<select className="input" name="topic">{['Admissions', 'Fees', 'Transfer certificate', 'Careers', 'Other'].map((t) => <option key={t}>{t}</option>)}</select></label>
            <label className="field">Message<textarea className="input" name="message" required minLength={5} maxLength={2000} /></label>
            {state.error && <p className="small" style={{ color: '#C4161C' }}>{state.error}</p>}
            <button className="btn" style={{ justifySelf: 'start' }} disabled={state.busy}>Send</button>
          </form>
        )}
      </div>
    </div>
  );
}

function BlockView({ b, prev, ctx }: { b: Block; prev?: Block; ctx: Ctx }) {
  const items = (k: string) => (b[k] ?? []) as any[];
  switch (b.type) {
    case 'hero': {
      const inner = <>
        <T ctx={ctx} f="eyebrow" v={b.eyebrow} className="eyebrow" ph="Small heading (optional)" />
        <T ctx={ctx} f="title" v={b.title} as="h1" className="h1" ph="Heading" />
        <T ctx={ctx} f="subtitle" v={b.subtitle} className="lede" ph="A line about the school (optional)" />
        {(b.primary || b.secondary || ctx.editing) && <div className="ctas">
          <Btn ctx={ctx} f="primary" l={b.primary} className="btn" ph="Add a button" />
          <Btn ctx={ctx} f="secondary" l={b.secondary} className="more" ph="Add a second link" />
        </div>}
      </>;
      if (b.style === 'sea') return <section className="hero"><div className="wrap">{inner}</div><Horizon /></section>;
      if (b.style === 'photo') return (
        <section className="hero photo" style={b.image ? { backgroundImage: `url(/api/v1/public/assets/${b.image})` } : undefined} data-edit={ctx.editing && !b.image ? 'image' : undefined}>
          <div className="wrap">{inner}{ctx.editing && !b.image && <div className="edit-photo hero-ph" data-edit="image"><span>📷 Banner photo goes here<small>Click to choose or upload a wide photo</small></span></div>}</div>
        </section>);
      return <section className="subhero"><div className="wrap">{inner}</div></section>;
    }
    case 'stats': {
      const lift = (prev?.type === 'hero' && prev.style !== 'plain') || prev?.type === 'slider';
      return <div className="wrap"><div className={`stats${lift ? ' lift' : ''}`} style={{ '--n': Math.min(4, items('items').length) } as CSSProperties}>
        {items('items').map((x, i) => <div key={i}><T ctx={ctx} f={`items.${i}.value`} v={x.value} as="b" ph="0" /><T ctx={ctx} f={`items.${i}.label`} v={x.label} as="span" ph="label" /></div>)}</div></div>;
    }
    case 'text': {
      const text = <div className="card" style={{ maxWidth: b.image || ctx.editing ? undefined : 860, margin: '0 auto' }}>
        <T ctx={ctx} f="eyebrow" v={b.eyebrow} className="muted small" ph="Small heading (optional)" />
        <T ctx={ctx} f="title" v={b.title} className="h3" style={{ marginTop: 6 }} ph="Heading (optional)" />
        <T ctx={ctx} f="subtitle" v={b.subtitle} className="muted" style={{ marginTop: 8 }} ph="Introduction (optional)" />
        <div style={{ display: 'grid', gap: 12, marginTop: 14 }} data-edit={ctx.editing ? 'body' : undefined}>
          {paras(b.body).length ? paras(b.body).map((p, i) => <p key={i} style={{ whiteSpace: 'pre-line' }}>{p}</p>) : ctx.editing && <p className="edit-empty">Write the text here.</p>}</div>
      </div>;
      if (!b.image && !ctx.editing) return <div className="wrap">{text}</div>;
      return <div className="wrap"><div className={`split${b.imageSide === 'left' ? ' left' : ''}`}>{text}
        <Photo ctx={ctx} f="image" id={b.image} className="split-photo" ph="Photo beside the text (optional)" /></div></div>;
    }
    case 'message':
      return <div className="wrap"><div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <T ctx={ctx} f="label" v={b.label} className="muted small" ph="Small heading (optional)" />
        <T ctx={ctx} f="quote" v={b.quote} className="h3" style={{ maxWidth: 760 }} ph="The message in a sentence or two" />
        <T ctx={ctx} f="body" v={b.body} className="muted" style={{ maxWidth: 760 }} ph="More text (optional)" />
        <div className="who" style={{ paddingTop: 6, flexWrap: 'wrap' }}>
          {b.photo ? <Photo ctx={ctx} f="photo" id={b.photo} className="av photo" /> : ctx.editing ? <span className="av edit-av" data-edit="photo" title="Add a photo">📷</span> : <span className="av">{initials(b.name)}</span>}
          <div><T ctx={ctx} f="name" v={b.name} as="b" ph="Name" /><T ctx={ctx} f="role" v={b.role} as="div" className="small muted" ph="Role (optional)" /></div>
          {(b.link || ctx.editing) && <span style={{ marginLeft: 'auto' }}><Btn ctx={ctx} f="link" l={b.link} className="more small" ph="Add a link" /></span>}</div>
      </div></div>;
    case 'cards':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className={`grid g${b.columns}`}>
        {items('items').map((c, i) => (
          <div key={i} className={`card ${c.tone && c.tone !== 'light' ? c.tone : ''}${c.image ? ' has-photo' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: b.columns <= 3 ? 180 : undefined }}>
            {(c.image || ctx.editing) && <Photo ctx={ctx} f={`items.${i}.image`} id={c.image} className="card-photo" ph="Card photo (optional)" />}
            <T ctx={ctx} f={`items.${i}.tag`} v={c.tag} className="muted small" ph="Small label (optional)" />
            <T ctx={ctx} f={`items.${i}.title`} v={c.title} className={b.columns === 4 ? 'h4' : 'h3'} ph="Card title" />
            <T ctx={ctx} f={`items.${i}.text`} v={c.text} className="muted small" style={{ marginTop: 'auto' }} ph="A line about it (optional)" />
          </div>))}
      </div></div>;
    case 'people':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="grid g4">
        {items('items').map((x, i) => (
          <div key={i} className={`card${i === 0 && items('items').length % 4 !== 0 ? ' navy' : ''}`} style={{ padding: 26, display: 'grid', gap: 14, alignContent: 'start', gridColumn: i === 0 && items('items').length % 4 === 3 ? 'span 2' : undefined }}>
            {x.photo ? <Photo ctx={ctx} f={`items.${i}.photo`} id={x.photo} className="av photo" /> : ctx.editing ? <span className="av edit-av" data-edit={`items.${i}.photo`} title="Add a photo">📷</span>
              : <span className="av" style={{ background: `linear-gradient(145deg,${GRADS[i % 4]})` }}>{initials(x.name)}</span>}
            <div><T ctx={ctx} f={`items.${i}.name`} v={x.name} as="b" ph="Name" /><T ctx={ctx} f={`items.${i}.role`} v={x.role} as="div" className="small muted" ph="Role (optional)" /></div>
          </div>))}
      </div></div>;
    case 'toppers': {
      const groups = items('groups');
      const single = groups.every((g) => g.list.length === 1);
      return <div className="wrap"><Head b={b} ctx={ctx} />
        {single ? <div className={`grid g${Math.min(4, groups.length)}`}>{groups.map((g, i) => (
          <div key={i} className="card" style={{ padding: 26, display: 'flex', flexDirection: 'column', gap: 14 }} data-edit={ctx.editing ? `groups.${i}.title` : undefined}>
            <p className="muted small">{g.title}</p>
            <div className="who">{g.list[0].photo ? <img className="av photo" src={`/api/v1/public/assets/${g.list[0].photo}`} alt="" loading="lazy" /> : <span className="av" style={{ background: `linear-gradient(145deg,${GRADS[i % 4]})` }}>{initials(g.list[0].name)}</span>}<b style={{ lineHeight: 1.25 }}>{g.list[0].name}</b></div>
            <p className="score">{g.list[0].score}</p>
          </div>))}</div>
          : <div className="grid g2">{groups.map((g, i) => (
            <div key={i} className="card" style={{ padding: 26 }} data-edit={ctx.editing ? `groups.${i}.title` : undefined}><p className="h4">{g.title}</p><div style={{ marginTop: 10 }}>
              {g.list.map((r: any, j: number) => {
                const rank = g.list.findIndex((x: any) => x.score === r.score) + 1;
                return <div key={j} className={`rank${rank === 1 ? ' first' : ''}`}><i>{rank}</i>{r.photo && <img className="rank-photo" src={`/api/v1/public/assets/${r.photo}`} alt="" loading="lazy" />}<span>{r.name}</span><b>{r.score}</b></div>;
              })}</div></div>))}</div>}
      </div>;
    }
    case 'timeline':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="card"><div className="tl">
        {items('items').map((t, i) => <article key={i}><T ctx={ctx} f={`items.${i}.when`} v={t.when} as="time" ph="When" /><div><T ctx={ctx} f={`items.${i}.title`} v={t.title} className="h4" ph="What happened" /><T ctx={ctx} f={`items.${i}.text`} v={t.text} className="muted" style={{ marginTop: 6 }} ph="More detail (optional)" /></div></article>)}
      </div></div></div>;
    case 'list':
      return <div className="wrap"><Head b={b} ctx={ctx} />{items('groups').map((g, i) => (
        <div key={i} style={{ marginTop: i ? 30 : 0 }} data-edit={ctx.editing ? `groups.${i}.items` : undefined}>{g.title && <p className="h4" style={{ marginBottom: 12 }}>{g.title}</p>}
          <div className="chips">{g.items.map((it: string, j: number) => <span key={j}>{it || (ctx.editing ? '…' : '')}</span>)}</div></div>))}</div>;
    case 'table':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className={`grid g${Math.min(2, items('groups').length)}`}>
        {items('groups').map((g, i) => <div key={i} className="card" data-edit={ctx.editing ? `groups.${i}.rows` : undefined}>{g.title && <p className="h4">{g.title}</p>}
          <table className="rows" style={{ marginTop: g.title ? 10 : 0 }}><tbody>{g.rows.map((r: any, j: number) => <tr key={j}><td>{r.label}</td><td>{r.value}</td></tr>)}</tbody></table></div>)}
      </div><T ctx={ctx} f="note" v={b.note} className="small muted" style={{ textAlign: 'center', marginTop: 18 }} ph="Note below (optional)" /></div>;
    case 'steps':
      return <div className="wrap"><div className="card" style={{ maxWidth: 860, margin: '0 auto' }}>
        <T ctx={ctx} f="eyebrow" v={b.eyebrow} className="muted small" ph="Small heading (optional)" /><T ctx={ctx} f="title" v={b.title} className="h3" style={{ marginTop: 4 }} ph="Heading" />
        <ol className="steps" style={{ marginTop: 10 }}>{items('items').map((x, i) => <li key={i}><span><T ctx={ctx} f={`items.${i}.title`} v={x.title} as="b" ph="Step" />{(x.text || ctx.editing) && <br />}<T ctx={ctx} f={`items.${i}.text`} v={x.text} as="span" className="small muted" ph="Detail (optional)" /></span></li>)}</ol>
      </div></div>;
    case 'notices': {
      const list = ctx.live?.notices.slice(0, b.limit) ?? null;
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="card">
        {!list ? <div className="placeholder">Public notices from the ERP appear here.</div>
          : list.length === 0 ? <p className="muted">No notices right now.</p>
          : list.map((n) => { const x = dm(n.created_at); return <div key={n.id} className="notice"><div className="date"><b>{x.d}</b><span>{x.m}</span></div><div><div style={{ fontWeight: 600 }}>{n.title}</div><div className="small muted">{n.body.slice(0, 180)}</div></div><span className="pill blue">{kindLabel(n.kind)}</span></div>; })}
      </div></div>;
    }
    case 'calendar': {
      const list = ctx.live?.events.slice(0, b.limit) ?? null;
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="card">
        {!list ? <div className="placeholder">Holidays and events from the ERP calendar appear here.</div>
          : list.length === 0 ? <p className="muted">Nothing scheduled.</p>
          : list.map((e) => { const x = dm(e.starts); const until = e.ends !== e.starts ? ` – ${new Date(`${e.ends}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : '';
            return <div key={e.id} className="notice"><div className="date"><b>{x.d}</b><span>{x.m}</span></div><div><div style={{ fontWeight: 600 }}>{e.title}</div><div className="small muted">{new Date(`${e.starts}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}{until}</div></div>
              <span className={`pill ${e.kind === 'HOLIDAY' || e.kind === 'VACATION' ? 'green' : e.kind === 'EXAM' ? 'orange' : 'blue'}`}>{kindLabel(e.kind)}</span></div>; })}
      </div></div>;
    }
    case 'liveToppers': {
      const t = ctx.live?.toppers;
      if (!ctx.live) return <div className="wrap"><Head b={b} ctx={ctx} /><div className="placeholder">Class toppers from the latest published exam appear here.</div></div>;
      if (!t || t.rows.length === 0) return ctx.editing ? <div className="wrap"><Head b={b} ctx={ctx} /><div className="placeholder">Class toppers appear here once an exam's results are published.</div></div> : null;
      const byClass = new Map<string, { name: string; rows: typeof t.rows }>();
      for (const r of t.rows) { const g = byClass.get(r.class_code) ?? { name: r.class_name, rows: [] }; g.rows.push(r); byClass.set(r.class_code, g); }
      return <div className="wrap"><Head b={{ ...b, subtitle: b.subtitle || t.assessment }} ctx={ctx} /><div className="grid g4">
        {[...byClass.entries()].map(([code, g], i) => (
          <div key={code} className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p className="muted small">{g.name}</p>
            {g.rows.map((r, j) => <div key={j} className="who"><span className="av" style={{ width: 40, height: 40, fontSize: 14, background: `linear-gradient(145deg,${GRADS[(i + j) % 4]})` }}>{initials(r.name)}</span><div><b style={{ display: 'block', lineHeight: 1.2 }}>{r.name}</b><span className="small muted">{r.percentage.toFixed(1)}%</span></div></div>)}
          </div>))}
      </div></div>;
    }
    case 'contact':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className={`grid g${Math.min(2, items('places').length)}`}>
        {items('places').map((x, i) => <div key={i} className="card" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          {(x.label || ctx.editing) && <T ctx={ctx} f={`places.${i}.label`} v={x.label} as="span" className="pill blue" style={{ justifySelf: 'start' }} ph="Label" />}
          <T ctx={ctx} f={`places.${i}.name`} v={x.name} className="h3" ph="Name of the place" /><T ctx={ctx} f={`places.${i}.address`} v={x.address} className="muted" ph="Address" />
          {(x.phones ?? []).filter(Boolean).length > 0 ? <p data-edit={ctx.editing ? `places.${i}.phones` : undefined}>{x.phones.filter(Boolean).map((ph: string, j: number) => <span key={j}>{j > 0 && ' · '}<a href={ctx.editing ? undefined : `tel:${ph.replace(/[^0-9+]/g, '')}`}>{ph}</a></span>)}</p>
            : ctx.editing && <p className="edit-empty" data-edit={`places.${i}.phones`}>Phone numbers</p>}
          {x.email ? <p><a href={ctx.editing ? undefined : `mailto:${x.email}`} data-edit={ctx.editing ? `places.${i}.email` : undefined}>{x.email}</a></p> : ctx.editing && <p className="edit-empty" data-edit={`places.${i}.email`}>Email (optional)</p>}
          {x.mapQuery && <a className="more small" href={ctx.editing ? undefined : `https://maps.google.com/?q=${encodeURIComponent(x.mapQuery)}`} target="_blank" rel="noopener noreferrer" data-edit={ctx.editing ? `places.${i}.mapQuery` : undefined}>Directions</a>}
        </div>)}
      </div><T ctx={ctx} f="note" v={b.note} className="small muted" style={{ textAlign: 'center', marginTop: 18 }} ph="Note below (optional)" /></div>;
    case 'gallery': {
      const shown = items('images').filter((g) => g.assetId || ctx.editing);
      if (!shown.length && !ctx.editing) return null;
      return <div className="wrap"><Head b={b} ctx={ctx} /><Gallery b={b} shown={shown} ctx={ctx} /></div>;
    }
    case 'slider':
      return <Slider b={b} ctx={ctx} />;
    case 'showcase':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="showcase">
        {items('items').map((x, i) => (
          <div key={i} className={`show-row${i % 2 ? ' flip' : ''}`}>
            <Photo ctx={ctx} f={`items.${i}.image`} id={x.image} className="show-photo" alt={x.title} ph={`Photo of ${x.title || 'this'}`} />
            {!x.image && !ctx.editing && <div className="show-photo show-none" aria-hidden="true" />}
            <div className="show-text">
              <T ctx={ctx} f={`items.${i}.title`} v={x.title} className="h3" ph="Title" />
              <T ctx={ctx} f={`items.${i}.text`} v={x.text} className="muted" style={{ marginTop: 10, whiteSpace: 'pre-line' }} ph="A few lines about it (optional)" />
              {(x.link || ctx.editing) && <div style={{ marginTop: 14 }}><Btn ctx={ctx} f={`items.${i}.link`} l={x.link} className="more" ph="Add a link" /></div>}
            </div>
          </div>))}
      </div></div>;
    case 'video': {
      const vids = items('items').filter((v) => ytId(v.url) || ctx.editing);
      if (!vids.length) return null;
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className={`grid g${Math.min(3, Math.max(1, vids.length))}`}>
        {vids.map((v, i) => <figure key={i} className="video" data-edit={ctx.editing ? `items.${i}.url` : undefined}>
          <Video id={ytId(v.url)} title={v.title} editing={ctx.editing} />
          {(v.title || ctx.editing) && <T ctx={ctx} f={`items.${i}.title`} v={v.title} as="div" className="figcap" ph="Title (optional)" />}</figure>)}
      </div></div>;
    }
    case 'documents': {
      const docs = items('items').filter((d) => d.assetId || ctx.editing);
      if (!docs.length) return null;
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="card docs">
        {docs.map((d, i) => {
          const inner = <><span className="doc-ic" aria-hidden="true">PDF</span><span style={{ flex: 1 }}><b>{d.title}</b>{d.note && <span className="small muted" style={{ display: 'block' }}>{d.note}</span>}</span>
            <span className="more small">{d.assetId ? 'Open' : 'File to be added'}</span></>;
          return d.assetId && !ctx.editing
            ? <a key={i} className="doc" href={`/api/v1/public/assets/${d.assetId}`} target="_blank" rel="noopener noreferrer">{inner}</a>
            : <div key={i} className={`doc${!d.assetId ? ' edit-empty' : ''}`} data-edit={ctx.editing ? `items.${i}.assetId` : undefined}>{inner}</div>;
        })}
      </div></div>;
    }
    case 'faq':
      return <div className="wrap"><Head b={b} ctx={ctx} /><div className="card faq">
        {items('items').map((x, i) => <details key={i} open={ctx.editing || undefined} data-edit={ctx.editing ? `items.${i}.q` : undefined}><summary>{x.q}</summary><p className="muted" style={{ whiteSpace: 'pre-line' }}>{x.a}</p></details>)}
      </div></div>;
    case 'cta':
      return <div className="wrap"><div className={`card ${b.tone === 'dark' ? 'dark' : ''}`} style={{ textAlign: 'center', display: 'grid', gap: 14, justifyItems: 'center', padding: '56px 34px' }}>
        <T ctx={ctx} f="title" v={b.title} className="h2" style={{ maxWidth: 760 }} ph="Heading" /><T ctx={ctx} f="text" v={b.text} className="lede" style={{ maxWidth: 640, color: b.tone === 'dark' ? '#A1A1A6' : undefined }} ph="A line of text (optional)" />
        <Btn ctx={ctx} f="button" l={b.button} className="btn" ph="Add the button" />
      </div></div>;
    case 'enquiry':
      return <Enquiry b={b} ctx={ctx} />;
    default:
      return null;
  }
}

/**
 * A whole school website: ribbon, navigation, the page's blocks and the footer. In the builder
 * (edit) every part can be clicked to change it, empty places say what goes there, and sections
 * can be added, moved, copied and removed where they stand.
 */
export function SiteView({ doc, slug, page, live, preview = false, onNavigate, edit }: { doc: SiteDoc; slug: string; page: string; live: Live | null; preview?: boolean; onNavigate?: (p: string) => void; edit?: EditCtx }) {
  const [open, setOpen] = useState(false);
  const ctx: Ctx = { slug, preview, go: (p) => onNavigate?.(p), live, editing: !!edit };
  const current = doc.pages.find((p) => p.slug === page) ?? doc.pages.find((p) => p.slug === 'home') ?? doc.pages[0];
  const nav = doc.pages.filter((p) => p.inNav && p.slug !== 'home');
  // The menu: pages with a group gather under one heading with a drop-down, in page order.
  const menu: { key: string; group: string; pages: Page[] }[] = [];
  for (const p of nav) {
    const g = p.group?.trim();
    const m = g ? menu.find((x) => x.group === g) : undefined;
    if (m) m.pages.push(p); else menu.push({ key: g ? `g:${g}` : p.id, group: g ?? '', pages: [p] });
  }
  const [drop, setDrop] = useState<string | null>(null);
  const s = doc.settings;
  /** In the builder, a click selects what was clicked instead of following links or submitting. */
  const pick = (target: string) => (e: React.MouseEvent) => {
    if (!edit) return;
    e.preventDefault(); e.stopPropagation();
    edit.select(target, (e.target as HTMLElement).closest('[data-edit]')?.getAttribute('data-edit') ?? undefined);
  };
  const add = (at: number) => edit && <button className="edit-add" onClick={() => edit.add(at)}><span>＋ Add a section here</span></button>;
  return (
    <div className="site-shell">
      <div className={`site${edit ? ' editing' : ''}`} style={{ '--accent': s.accent } as CSSProperties}>
        <div className={edit ? `edit-zone${edit.selected === 'settings' ? ' on' : ''}` : undefined} onClickCapture={edit ? pick('settings') : undefined}>
          {edit && <div className="edit-chip">Top of every page · name, menu, notice ribbon</div>}
          {(s.ribbon?.text || edit) && <div className={`ribbon${!s.ribbon?.text ? ' edit-empty' : ''}`} data-edit={edit ? 'ribbon' : undefined}>{s.ribbon?.text || 'Notice ribbon (optional): a line shown above the menu on every page'} {s.ribbon?.link && <A ctx={ctx} className="more" href={s.ribbon.link.href}>{s.ribbon.link.label}</A>}</div>}
          <header className={`nav${open ? ' open' : ''}`}>
            <div className="wrap">
              <A ctx={ctx} className="brand" href="/home" edit="shortName">
                <img className="crest" src={`/api/v1/public/sites/${ctx.slug}/logo`} alt="" />
                {s.shortName}
              </A>
              <nav className="links" aria-label="Main">
                {menu.map((m) => m.pages.length === 1 && !m.group
                  ? <span key={m.key} onClick={() => setOpen(false)}><A ctx={ctx} href={`/${m.pages[0].slug}`} className={m.pages[0].slug === current.slug ? 'on' : undefined}>{m.pages[0].title}</A></span>
                  : <div key={m.key} className={`dd${drop === m.key ? ' show' : ''}`} onMouseLeave={() => setDrop(null)}>
                      <button type="button" className={m.pages.some((p) => p.slug === current.slug) ? 'on' : undefined} aria-expanded={drop === m.key} onClick={() => setDrop(drop === m.key ? null : m.key)} onMouseEnter={() => setDrop(m.key)}>{m.group} <span aria-hidden="true">▾</span></button>
                      <div className="dd-menu" onClick={() => { setDrop(null); setOpen(false); }}>{m.pages.map((p) => <A key={p.id} ctx={ctx} href={`/${p.slug}`} className={p.slug === current.slug ? 'on' : undefined}>{p.title}</A>)}</div>
                    </div>)}
              </nav>
              <A ctx={ctx} className="btn sm dark staff" href="/staff-login">Staff login</A>
              <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}><svg width="18" height="12" viewBox="0 0 18 12" stroke="#1D1D1F" strokeWidth="1.5"><path d="M0 1h18M0 11h18" /></svg></button>
            </div>
          </header>
        </div>
        <main>
          {add(0)}
          {current.blocks.map((b, i) => {
            const section = (
              <section className={b.type === 'hero' || b.type === 'slider' ? undefined : 'block'} style={i === 0 && b.type !== 'hero' && b.type !== 'slider' ? { paddingTop: 64 } : b.type === 'stats' && current.blocks[i - 1]?.type === 'hero' ? { paddingTop: current.blocks[i - 1].style === 'plain' ? 56 : 0 } : undefined}>
                <BlockView b={b} prev={current.blocks[i - 1]} ctx={ctx} />
              </section>);
            if (!edit) return <div key={b.id}>{section}</div>;
            const on = edit.selected === b.id;
            return (
              <div key={b.id} className={`edit-block${on ? ' on' : ''}`} id={`blk-${b.id}`}>
                <div className="edit-chip">{edit.label(b)}</div>
                {on && <div className="edit-tools">
                  <button title="Move up" disabled={i === 0} onClick={() => edit.act(b.id, 'up')}>↑</button>
                  <button title="Move down" disabled={i === current.blocks.length - 1} onClick={() => edit.act(b.id, 'down')}>↓</button>
                  <button title="Copy" onClick={() => edit.act(b.id, 'copy')}>⧉</button>
                  <button title="Delete" onClick={() => edit.act(b.id, 'delete')}>🗑</button>
                </div>}
                <div className="edit-body" onClickCapture={pick(b.id)}>{section}</div>
                {add(i + 1)}
              </div>);
          })}
          {current.blocks.length === 0 && !edit && <div className="wrap" style={{ padding: '80px 0' }}><div className="placeholder">This page has no sections yet.</div></div>}
        </main>
        <div className={edit ? `edit-zone${edit.selected === 'footer' ? ' on' : ''}` : undefined} onClickCapture={edit ? pick('footer') : undefined}>
          {edit && <div className="edit-chip">Bottom of every page · address, phone, email</div>}
          <footer>
            <div className="wrap">
              <div className="fgrid">
                <div><h4 data-edit={edit ? 'name' : undefined}>{s.name}</h4>
                  {(s.address || edit) && <p style={{ margin: 0 }} className={!s.address ? 'edit-empty' : undefined} data-edit={edit ? 'address' : undefined}>{s.address || 'Address'}</p>}
                  {(s.phone || edit) && <p style={{ margin: '8px 0 0' }} className={!s.phone ? 'edit-empty' : undefined} data-edit={edit ? 'phone' : undefined}>{s.phone || 'Phone'}</p>}
                  {(s.email || edit) && <p style={{ margin: 0 }} className={!s.email ? 'edit-empty' : undefined} data-edit={edit ? 'email' : undefined}>{s.email || 'Email'}</p>}</div>
                <div><h4>School</h4>{menu.filter((m) => !m.group).map((m) => <A key={m.key} ctx={ctx} href={`/${m.pages[0].slug}`}>{m.pages[0].title}</A>)}</div>
                <div><h4>More</h4>{menu.filter((m) => m.group).map((m) => <A key={m.key} ctx={ctx} href={`/${m.pages[0].slug}`}>{m.group}</A>)}</div>
                <div><h4>Staff</h4><A ctx={ctx} href="/staff-login">Staff login</A><a href={edit ? undefined : 'https://ncert.nic.in/textbook.php'} target="_blank" rel="noopener noreferrer">NCERT textbooks</a></div>
              </div>
              <div className="fbase"><span className="society" data-edit={edit ? 'footer' : undefined}><img src="/api/v1/public/brand/nes-logo" alt="" />A school of the Navy Education Society{s.footer ? ` · ${s.footer}` : ''}</span><span>© {new Date().getFullYear()} {s.shortName} · NavShiksha</span></div>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
