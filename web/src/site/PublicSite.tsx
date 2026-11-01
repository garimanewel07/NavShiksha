import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SiteView, type Live, type SiteDoc } from './SiteView';
import { ErrorPage, messageOf, numberOf } from '../errors';

/** The public website of one school, served from its latest published release. No sign-in. */
export default function PublicSite() {
  const { slug = '', page = 'home' } = useParams();
  const [state, setState] = useState<{ doc?: SiteDoc & { live: Live }; failed?: { number: string; message?: string } }>({});
  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/public/sites/${encodeURIComponent(slug)}`).then(async (r) => {
      if (!alive) return;
      if (!r.ok) { setState({ failed: { number: numberOf(r.status), message: r.status === 404 ? 'This school’s website is not published yet, or the address is mistyped.' : await messageOf(r) } }); return; }
      setState({ doc: await r.json() });
    }).catch(() => alive && setState({ failed: { number: 'NS-000' } }));
    return () => { alive = false; };
  }, [slug]);
  useEffect(() => { window.scrollTo(0, 0); }, [page]);
  useEffect(() => {
    if (!state.doc) return;
    const p = state.doc.pages.find((x) => x.slug === page);
    document.title = p && p.slug !== 'home' ? `${p.title} · ${state.doc.settings.shortName}` : state.doc.settings.name;
  }, [state.doc, page]);
  if (state.failed) return <ErrorPage number={state.failed.number} message={state.failed.message} full />;
  if (!state.doc) return <div style={{ minHeight: '100vh', background: '#F5F5F7' }} />;
  if (!state.doc.pages.some((p) => p.slug === page)) return <ErrorPage number="NS-404" message="This school’s website has no such page." full home={[`/s/${slug}`, `${state.doc.settings.shortName} home page`]} />;
  return <SiteView doc={state.doc} slug={slug} page={page} live={state.doc.live} />;
}
