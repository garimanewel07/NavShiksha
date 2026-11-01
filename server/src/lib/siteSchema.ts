import { z } from 'zod';

/**
 * The website document a school edits. Every block type is validated here before it is saved or
 * published, so a malformed or unsafe page can never reach the public site. Links accept only
 * site paths, in-page anchors, https, mailto and tel — never javascript: or data: URLs.
 * New block types are added here (and in the web renderer); existing ones keep their fields.
 */
const s = (max: number) => z.string().trim().max(max);
const req = (max: number) => z.string().trim().min(1, 'Required.').max(max);
const href = z.string().trim().max(400).regex(/^(\/(?!\/)|#|https:\/\/|mailto:|tel:)/, 'Use a page link (/…), #section, https://, mailto: or tel:.');
const link = z.object({ label: req(40), href });
const optLink = link.optional().nullable();
const head = { eyebrow: s(60).optional(), title: s(140).optional(), subtitle: s(400).optional() };
const id = z.string().regex(/^[a-z0-9]{6,24}$/);
/** A photo the school uploaded (Website → Images), or none yet. */
const photo = z.string().uuid().optional().or(z.literal(''));
/** A YouTube video, played from youtube-nocookie.com only after the visitor presses play. */
const youtube = z.string().trim().regex(/^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{11}/, 'Paste a YouTube link (https://www.youtube.com/watch?v=…).');

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('hero'), eyebrow: s(80).optional(), title: req(120), subtitle: s(400).optional(), primary: optLink, secondary: optLink, style: z.enum(['sea', 'plain', 'photo']), image: photo }),
  z.object({ id, type: z.literal('stats'), items: z.array(z.object({ value: req(16), label: req(60) })).min(1).max(6) }),
  z.object({ id, type: z.literal('text'), ...head, body: s(6000), image: photo, imageSide: z.enum(['left', 'right']).optional() }),
  z.object({ id, type: z.literal('message'), label: s(60).optional(), quote: req(400), body: s(1500).optional(), name: req(80), role: s(80).optional(), link: optLink, photo }),
  z.object({ id, type: z.literal('cards'), ...head, columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    items: z.array(z.object({ title: req(200), text: s(600).optional(), tag: s(80).optional(), tone: z.enum(['light', 'navy', 'dark']).optional(), image: photo })).min(1).max(24) }),
  z.object({ id, type: z.literal('people'), ...head, items: z.array(z.object({ name: req(90), role: s(120).optional(), photo })).min(1).max(40) }),
  z.object({ id, type: z.literal('toppers'), ...head, groups: z.array(z.object({ title: req(60), list: z.array(z.object({ name: req(80), score: req(12), photo })).min(1).max(10) })).min(1).max(8) }),
  z.object({ id, type: z.literal('timeline'), ...head, items: z.array(z.object({ when: req(30), title: req(120), text: s(800).optional() })).min(1).max(40) }),
  z.object({ id, type: z.literal('list'), ...head, groups: z.array(z.object({ title: s(60).optional(), items: z.array(req(80)).min(1).max(60) })).min(1).max(6) }),
  z.object({ id, type: z.literal('table'), ...head, groups: z.array(z.object({ title: s(60).optional(), rows: z.array(z.object({ label: req(120), value: req(120) })).min(1).max(30) })).min(1).max(4), note: s(400).optional() }),
  z.object({ id, type: z.literal('steps'), ...head, items: z.array(z.object({ title: req(120), text: s(500).optional() })).min(1).max(12) }),
  z.object({ id, type: z.literal('notices'), ...head, limit: z.number().int().min(1).max(20) }),
  z.object({ id, type: z.literal('calendar'), ...head, limit: z.number().int().min(1).max(20) }),
  z.object({ id, type: z.literal('liveToppers'), ...head, perClass: z.number().int().min(1).max(3) }),
  z.object({ id, type: z.literal('contact'), ...head,
    places: z.array(z.object({ label: s(40).optional(), name: req(80), address: req(200), phones: z.array(req(20)).max(4), email: z.string().trim().email().max(120).optional().or(z.literal('')), mapQuery: s(200).optional() })).min(1).max(4),
    note: s(600).optional() }),
  z.object({ id, type: z.literal('gallery'), ...head, layout: z.enum(['grid', 'mosaic']).optional(), images: z.array(z.object({ assetId: z.string().uuid().or(z.literal('')), caption: s(120).optional() })).max(60) }),
  z.object({ id, type: z.literal('slider'), title: s(120).optional(), subtitle: s(300).optional(), primary: optLink, height: z.enum(['tall', 'medium']), seconds: z.number().int().min(0).max(15),
    slides: z.array(z.object({ assetId: z.string().uuid().or(z.literal('')), caption: s(120).optional() })).min(1).max(12) }),
  z.object({ id, type: z.literal('showcase'), ...head, items: z.array(z.object({ title: req(120), text: s(800).optional(), image: photo, link: optLink })).min(1).max(12) }),
  z.object({ id, type: z.literal('video'), ...head, items: z.array(z.object({ url: youtube.or(z.literal('')), title: s(120).optional() })).min(1).max(12) }),
  z.object({ id, type: z.literal('documents'), ...head, items: z.array(z.object({ assetId: z.string().uuid().or(z.literal('')), title: req(120), note: s(200).optional() })).min(1).max(40) }),
  z.object({ id, type: z.literal('faq'), ...head, items: z.array(z.object({ q: req(200), a: req(1500) })).min(1).max(40) }),
  z.object({ id, type: z.literal('cta'), title: req(120), text: s(400).optional(), button: link, tone: z.enum(['light', 'dark']) }),
  z.object({ id, type: z.literal('enquiry'), ...head }),
]);
export type Block = z.infer<typeof blockSchema>;

const pageSchema = z.object({
  id,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.').max(40),
  title: req(60),
  inNav: z.boolean(),
  /** Pages with the same group appear together under one menu heading (About, Admissions…). */
  group: s(30).optional(),
  blocks: z.array(blockSchema).max(40),
});

export const siteSchema = z.object({
  settings: z.object({
    name: req(100),
    shortName: req(30),
    tagline: s(200).optional(),
    ribbon: z.object({ text: s(200), link: optLink }).optional().nullable(),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #0071E3.'),
    footer: s(400).optional(),
    address: s(200).optional(),
    phone: s(60).optional(),
    email: z.string().trim().email().max(120).optional().or(z.literal('')),
  }),
  pages: z.array(pageSchema).min(1).max(60),
}).superRefine((site, ctx) => {
  const slugs = new Set<string>();
  site.pages.forEach((p, i) => {
    if (slugs.has(p.slug)) ctx.addIssue({ code: 'custom', path: ['pages', i, 'slug'], message: `Two pages use the address “${p.slug}”.` });
    slugs.add(p.slug);
  });
  if (!slugs.has('home')) ctx.addIssue({ code: 'custom', path: ['pages'], message: 'The site needs a page with the address “home”.' });
  if (JSON.stringify(site).length > 1_500_000) ctx.addIssue({ code: 'custom', path: [], message: 'The site is too large. Remove some sections.' });
});
export type SiteDoc = z.infer<typeof siteSchema>;
