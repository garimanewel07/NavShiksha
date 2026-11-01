import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { siteSchema, type SiteDoc } from '../lib/siteSchema.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import * as notices from './notices.js';
import * as duties from './duties.js';
import { publicToppers } from './academics.js';
import { fullSchoolSite, starterSite } from '../reference/siteTemplates.js';
import { localToday, daysFromToday } from '../lib/dates.js';

/**
 * The school's name, address, phone and email are not kept in the website: they come from the
 * school's record (Settings → School details), so the website, certificates and report cards
 * always agree. Applied whenever a site is shown or saved.
 */
async function withSchool(db: Db, schoolId: string, doc: SiteDoc): Promise<SiteDoc> {
  const o = await db.one<{ name: string; address: string | null; phone: string | null; email: string | null }>(
    `select o.name, coalesce(o.address, (select c.address from org_unit c where c.parent_id = o.id and c.kind = 'campus' and c.active order by c.code limit 1)) as address, o.phone, o.email
       from org_unit o where o.id = $1`, [schoolId]);
  return { ...doc, settings: { ...doc.settings, name: o.name, address: o.address ?? '', phone: o.phone ?? undefined, email: o.email ?? undefined } as SiteDoc['settings'] };
}

function validate(doc: unknown): SiteDoc {
  const r = siteSchema.safeParse(doc);
  if (!r.success) throw invalid('Some parts of the website need attention.', r.error.issues.slice(0, 20).map((i) => ({ field: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Drafts, images and enquiries: school leadership or the website editor. Publishing stays with leadership. */
async function editor(db: Db, actor: Actor, schoolId: string) {
  await duties.assertLeaderOrDuty(db, actor, schoolId, 'WEBSITE_EDITOR');
}

/** Creates a school's site from the starter template the first time it is opened. */
async function ensure(db: Db, actor: Actor, schoolId: string) {
  const site = await db.maybeOne('select 1 from site where school_id = $1', [schoolId]);
  if (site) return;
  const school = await db.one<{ name: string; code: string; kind: string }>('select name, code, kind from org_unit where id = $1', [schoolId]);
  if (school.kind !== 'school') throw invalid('Websites belong to schools.');
  const addr = await db.maybeOne<{ address: string | null }>(`select address from org_unit where parent_id = $1 and kind = 'campus' order by name limit 1`, [schoolId]);
  const slug = school.code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await db.tx((t) => t.query(`insert into site (school_id, slug, draft, updated_by) values ($1, $2, $3, $4) on conflict do nothing`,
    [schoolId, slug, JSON.stringify(starterSite(school.name, addr?.address ?? '')), actor.id]), { actor: actor.label });
}

export async function draft(db: Db, actor: Actor, schoolId: string) {
  await editor(db, actor, schoolId);
  await ensure(db, actor, schoolId);
  const s = await db.one<{ slug: string; draft: SiteDoc; draft_version: number; updated_at: string; updated_by: string | null }>(
    `select s.slug, s.draft, s.draft_version, s.updated_at, u.name as updated_by from site s left join app_user u on u.id = s.updated_by where s.school_id = $1`, [schoolId]);
  const last = await db.maybeOne<{ version: number; published_at: string; published_by: string; content: SiteDoc }>(
    `select r.version, r.published_at, u.name as published_by, r.content from site_release r join app_user u on u.id = r.published_by
      where r.school_id = $1 order by r.version desc limit 1`, [schoolId]);
  return {
    slug: s.slug, draft: await withSchool(db, schoolId, s.draft), draftVersion: s.draft_version, updatedAt: s.updated_at, updatedBy: s.updated_by,
    published: last ? { version: last.version, publishedAt: last.published_at, publishedBy: last.published_by } : null,
    unpublishedChanges: !last || JSON.stringify((await withSchool(db, schoolId, last.content)).pages) !== JSON.stringify(s.draft.pages) || JSON.stringify({ ...last.content.settings, name: 0, address: 0, phone: 0, email: 0 }) !== JSON.stringify({ ...s.draft.settings, name: 0, address: 0, phone: 0, email: 0 }),
  };
}

/**
 * Saves the draft only if nobody else saved since this editor loaded it (optimistic locking on
 * draft_version). The losing editor is told to reload rather than silently overwriting.
 */
export async function save(db: Db, actor: Actor, schoolId: string, expectedVersion: number, doc: unknown) {
  await editor(db, actor, schoolId);
  const clean = await withSchool(db, schoolId, validate(doc));
  return db.tx(async (t) => {
    const r = await t.maybeOne<{ draft_version: number }>(
      `update site set draft = $3, draft_version = draft_version + 1, updated_by = $4, updated_at = now()
        where school_id = $1 and draft_version = $2 returning draft_version`, [schoolId, expectedVersion, JSON.stringify(clean), actor.id]);
    if (!r) throw conflict('stale', 'Someone else saved changes to this website. Reload to see them before saving again.');
    return { draftVersion: r.draft_version };
  }, { actor: actor.label });
}

/** Publishes the draft the editor is looking at as a new, permanent release. */
export async function publish(db: Db, actor: Actor, schoolId: string, expectedVersion: number, note: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  return db.tx(async (t) => {
    const s = await t.maybeOne<{ draft: unknown; draft_version: number }>('select draft, draft_version from site where school_id = $1 for update', [schoolId]);
    if (!s) throw notFound('Website');
    if (s.draft_version !== expectedVersion) throw conflict('stale', 'The draft changed since you opened it. Reload, check it, then publish.');
    const clean = validate(s.draft);
    const r = await t.one<{ version: number }>(
      `insert into site_release (school_id, version, content, note, published_by)
       values ($1, coalesce((select max(version) from site_release where school_id = $1), 0) + 1, $2, $3, $4) returning version`,
      [schoolId, JSON.stringify(clean), note.trim(), actor.id]);
    return { version: r.version };
  }, { actor: actor.label });
}

/**
 * Replaces the draft with a starting layout: the short one, or the full site laid out like the
 * present NCS websites. Published versions are untouched, so nothing goes public until published.
 */
export async function startFrom(db: Db, actor: Actor, schoolId: string, expectedVersion: number, template: 'basic' | 'full') {
  await editor(db, actor, schoolId);
  await ensure(db, actor, schoolId);
  const school = await db.one<{ name: string }>('select name from org_unit where id = $1', [schoolId]);
  const addr = await db.maybeOne<{ address: string | null }>(`select address from org_unit where parent_id = $1 and kind = 'campus' order by name limit 1`, [schoolId]);
  const doc = template === 'full' ? fullSchoolSite(school.name, addr?.address ?? '') : starterSite(school.name, addr?.address ?? '');
  return save(db, actor, schoolId, expectedVersion, doc);
}

export async function releases(db: Db, actor: Actor, schoolId: string) {
  await editor(db, actor, schoolId);
  return db.query(
    `select r.version, r.note, r.published_at, u.name as published_by from site_release r join app_user u on u.id = r.published_by
      where r.school_id = $1 order by r.version desc limit 50`, [schoolId]);
}

/** Copies an earlier release into the draft; publishing it again makes it live (a rollback). */
export async function restore(db: Db, actor: Actor, schoolId: string, version: number, expectedVersion: number) {
  await editor(db, actor, schoolId);
  return db.tx(async (t) => {
    const r = await t.maybeOne<{ content: unknown }>('select content from site_release where school_id = $1 and version = $2', [schoolId, version]);
    if (!r) throw notFound('Release');
    const u = await t.maybeOne<{ draft_version: number }>(
      `update site set draft = $3, draft_version = draft_version + 1, updated_by = $4, updated_at = now()
        where school_id = $1 and draft_version = $2 returning draft_version`, [schoolId, expectedVersion, JSON.stringify(r.content), actor.id]);
    if (!u) throw conflict('stale', 'Someone else saved changes to this website. Reload first.');
    return { draftVersion: u.draft_version };
  }, { actor: actor.label });
}

/** The Unified view: every school website in scope and when it was last published. */
export async function list(db: Db, actor: Actor) {
  if (!actor.scopePath) throw forbidden();
  return db.query(
    `select o.id as school_id, o.name as school, s.slug, s.updated_at,
            (select max(version) from site_release r where r.school_id = o.id) as version,
            (select max(published_at) from site_release r where r.school_id = o.id) as published_at
       from org_unit o left join site s on s.school_id = o.id
      where o.kind = 'school' and o.active and o.path <@ $1::ltree order by o.name`, [actor.scopePath]);
}

// ── Public ───────────────────────────────────────────────────────────────────────────────

/** The published site plus live blocks (public notices, upcoming events) from the ERP. */
export async function publicSite(db: Db, slug: string, want: { notices?: number; events?: number; toppers?: number } = {}) {
  const s = await db.maybeOne<{ school_id: string; content: SiteDoc; version: number; published_at: string }>(
    `select s.school_id, r.content, r.version, r.published_at from site s
       join lateral (select content, version, published_at from site_release where school_id = s.school_id order by version desc limit 1) r on true
      where s.slug = $1`, [slug]);
  if (!s) throw notFound('Website');
  const blocks = s.content.pages.flatMap((p) => p.blocks);
  // The website builder asks for the counts in the draft being edited (which may differ from the
  // published site), so its preview shows as many notices and holidays as the school chose.
  const cap = (v: number | undefined, max: number) => (v === undefined || !Number.isFinite(v) ? undefined : Math.max(0, Math.min(max, Math.floor(v))));
  const noticeLimit = cap(want.notices, 20) ?? Math.max(0, ...blocks.filter((b) => b.type === 'notices').map((b) => (b as { limit: number }).limit));
  const eventLimit = cap(want.events, 20) ?? Math.max(0, ...blocks.filter((b) => b.type === 'calendar').map((b) => (b as { limit: number }).limit));
  const topperDepth = cap(want.toppers, 3) ?? Math.max(0, ...blocks.filter((b) => b.type === 'liveToppers').map((b) => (b as { perClass: number }).perClass));
  const today = localToday();
  const until = daysFromToday(365);
  return {
    ...(await withSchool(db, s.school_id, s.content)),
    version: s.version,
    publishedAt: s.published_at,
    live: {
      notices: noticeLimit ? await notices.publicFor(db, s.school_id, noticeLimit) : [],
      events: eventLimit ? (await notices.eventsForSchool(db, s.school_id, today, until)).slice(0, eventLimit) : [],
      toppers: topperDepth ? await publicToppers(db, s.school_id, topperDepth) : null,
    },
  };
}

/** A visitor's enquiry from the contact form. Staff see it in the website builder. */
export async function enquire(db: Db, slug: string, input: { name: string; phone: string; topic: string; message: string }) {
  const s = await db.maybeOne<{ school_id: string }>('select school_id from site where slug = $1', [slug]);
  if (!s) throw notFound('Website');
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into site_enquiry (school_id, name, phone, topic, message) values ($1, $2, $3, $4, $5) returning id`,
    [s.school_id, input.name.trim(), input.phone.trim(), input.topic, input.message.trim()]), { actor: 'public website' });
  return { reference: r.id.slice(0, 8).toUpperCase() };
}

export async function enquiries(db: Db, actor: Actor, schoolId: string) {
  await editor(db, actor, schoolId);
  return db.query(`select id, name, phone, topic, message, status, created_at from site_enquiry where school_id = $1 order by created_at desc limit 200`, [schoolId]);
}

export async function setEnquiryStatus(db: Db, actor: Actor, id: string, status: 'NEW' | 'REPLIED' | 'CLOSED') {
  const e = await db.maybeOne<{ school_id: string }>('select school_id from site_enquiry where id = $1', [id]);
  if (!e) throw notFound('Enquiry');
  await editor(db, actor, e.school_id);
  await db.tx((t) => t.query('update site_enquiry set status = $2 where id = $1', [id, status]), { actor: actor.label });
  return { ok: true };
}

// ── Images ───────────────────────────────────────────────────────────────────────────────

function sniff(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | null {
  if (buf.length > 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Stores a photo (up to 5 MB) or a PDF (up to 10 MB). The declared type is ignored; the file's own
 * signature decides, so a script renamed .png is refused.
 */
export async function upload(db: Db, actor: Actor, schoolId: string, input: { name: string; dataBase64: string }) {
  await editor(db, actor, schoolId);
  await ensure(db, actor, schoolId);
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (!buf.length) throw invalid('The file is empty.');
  const type = sniff(buf);
  if (!type) throw invalid('Only photos (PNG, JPEG, WebP) and PDF documents are accepted.');
  if (type === 'application/pdf' ? buf.length > 10 * 1024 * 1024 : buf.length > 5 * 1024 * 1024) throw invalid(type === 'application/pdf' ? 'PDFs must be 10 MB or smaller.' : 'Photos must be 5 MB or smaller.');
  const r = await db.tx((t) => t.one<{ id: string }>(
    `insert into site_asset (school_id, name, content_type, bytes, uploaded_by) values ($1, $2, $3, $4, $5) returning id`,
    [schoolId, input.name.slice(0, 120) || 'image', type, buf, actor.id]), { actor: actor.label });
  return { id: r.id, contentType: type, size: buf.length };
}

export async function assets(db: Db, actor: Actor, schoolId: string) {
  await editor(db, actor, schoolId);
  return db.query(`select id, name, content_type, octet_length(bytes) as size, uploaded_at from site_asset where school_id = $1 order by uploaded_at desc limit 2000`, [schoolId]);
}

export async function asset(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Image');
  const a = await db.maybeOne<{ content_type: string; bytes: Uint8Array; name: string }>('select content_type, bytes, name from site_asset where id = $1', [id]);
  if (!a) throw notFound('Image');
  return a;
}
