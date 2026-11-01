import { beforeAll, describe, expect, it } from 'vitest';
import * as site from '../src/modules/site.js';
import * as notices from '../src/modules/notices.js';
import * as org from '../src/modules/org.js';
import * as printing from '../src/modules/printing.js';
import { makeWorld, rejects, type World } from './helpers.js';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('website builder', () => {
  it('creates a starter site the first time a principal opens it', async () => {
    const d = await site.draft(w.db, w.principalA, w.schoolA);
    expect(d.slug).toBe('ncs-a');
    expect(d.published).toBeNull();
    expect(d.draft.pages.map((p) => p.slug)).toContain('home');
  });

  it('refuses teachers and other schools', async () => {
    await rejects(site.draft(w.db, w.teacherA, w.schoolA), /access|duty/);
    await rejects(site.draft(w.db, w.principalA, w.schoolB), /outside your access/);
  });

  it('stops two editors overwriting each other', async () => {
    const d = await site.draft(w.db, w.principalA, w.schoolA);
    const doc = structuredClone(d.draft);
    doc.settings.tagline = 'First edit';
    await site.save(w.db, w.principalA, w.schoolA, d.draftVersion, doc);
    doc.settings.tagline = 'Second edit from a stale screen';
    await rejects(site.save(w.db, w.principalA, w.schoolA, d.draftVersion, doc), /Someone else saved/);
  });

  it('rejects unsafe links and a site without a home page', async () => {
    const d = await site.draft(w.db, w.principalA, w.schoolA);
    const bad = structuredClone(d.draft);
    (bad.pages[0].blocks[0] as { primary: unknown }).primary = { label: 'Click', href: 'javascript:alert(1)' };
    await rejects(site.save(w.db, w.principalA, w.schoolA, d.draftVersion, bad), /need attention/);
    const noHome = structuredClone(d.draft);
    noHome.pages = noHome.pages.filter((p) => p.slug !== 'home');
    await rejects(site.save(w.db, w.principalA, w.schoolA, d.draftVersion, noHome), /need attention/);
  });

  it('publishes permanent releases, serves the latest with live notices, and rolls back', async () => {
    await rejects(site.publicSite(w.db, 'ncs-a'), /not found/);
    let d = await site.draft(w.db, w.principalA, w.schoolA);
    const v1 = await site.publish(w.db, w.principalA, w.schoolA, d.draftVersion, 'First version');
    expect(v1.version).toBe(1);
    await notices.create(w.db, w.principalA, { unitId: w.schoolA, title: 'Sports Day on 5 December', body: 'All welcome.', kind: 'EVENT', audience: 'ALL', isPublic: true });
    await notices.create(w.db, w.principalA, { unitId: w.schoolA, title: 'Internal staff note', body: 'Not for the website.', kind: 'NOTICE', audience: 'ALL' });
    const pub = await site.publicSite(w.db, 'ncs-a');
    expect(pub.live.notices.map((n) => n.title)).toEqual(['Sports Day on 5 December']);

    const doc = structuredClone(d.draft);
    doc.settings.tagline = 'Version two';
    await site.save(w.db, w.principalA, w.schoolA, d.draftVersion, doc);
    d = await site.draft(w.db, w.principalA, w.schoolA);
    expect(d.unpublishedChanges).toBe(true);
    await site.publish(w.db, w.principalA, w.schoolA, d.draftVersion, 'Tagline');
    expect((await site.publicSite(w.db, 'ncs-a')).settings.tagline).toBe('Version two');

    await rejects(w.db.query(`update site_release set note = 'x' where school_id = $1`, [w.schoolA]), /permanent|cannot/);
    d = await site.draft(w.db, w.principalA, w.schoolA);
    await site.restore(w.db, w.principalA, w.schoolA, 1, d.draftVersion);
    d = await site.draft(w.db, w.principalA, w.schoolA);
    await site.publish(w.db, w.principalA, w.schoolA, d.draftVersion, 'Roll back to v1');
    const back = await site.publicSite(w.db, 'ncs-a');
    expect(back.version).toBe(3);
    expect(back.settings.tagline).not.toBe('Version two');
  });

  it('accepts real images only, judged by the file itself', async () => {
    const ok = await site.upload(w.db, w.principalA, w.schoolA, { name: 'dot.png', dataBase64: PNG.toString('base64') });
    expect(ok.contentType).toBe('image/png');
    await rejects(site.upload(w.db, w.principalA, w.schoolA, { name: 'evil.png', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') }), /Only photos \(PNG, JPEG, WebP\) and PDF/);
    // PDFs for Downloads sections (almanac, mandatory disclosure), judged by their own signature too.
    const pdf = await site.upload(w.db, w.principalA, w.schoolA, { name: 'Almanac 2026-27.pdf', dataBase64: Buffer.from('%PDF-1.4\n%test').toString('base64') });
    expect(pdf.contentType).toBe('application/pdf');
  });

  it('takes visitor enquiries and lets staff change only their status', async () => {
    const r = await site.enquire(w.db, 'ncs-a', { name: 'Asha', phone: '+919900011122', topic: 'Admissions', message: 'Is there a seat in Class III?' });
    expect(r.reference).toHaveLength(8);
    const [e] = await site.enquiries(w.db, w.principalA, w.schoolA) as { id: string }[];
    await site.setEnquiryStatus(w.db, w.principalA, e.id, 'REPLIED');
    await rejects(w.db.query(`update site_enquiry set message = 'changed' where id = $1`, [e.id]), /only status/);
  });
});

describe('the school’s details are kept once', () => {
  it('shows the school record’s phone, email and address on the website, and ignores copies typed into the site', async () => {
    await org.updateSchoolDetails(w.db, w.principalA, w.schoolA, { phone: '022 2214 0000', email: 'office@ncs-a.example.in', address: 'Navy Nagar, Colaba' });
    await rejects(org.updateSchoolDetails(w.db, w.principalA, w.schoolA, { name: 'Renamed' }), /set by NES/);
    const d = await site.draft(w.db, w.principalA, w.schoolA);
    expect(d.draft.settings).toMatchObject({ phone: '022 2214 0000', email: 'office@ncs-a.example.in', address: 'Navy Nagar, Colaba' });
    // A stale copy saved from an old browser tab cannot override the school record.
    await site.save(w.db, w.principalA, w.schoolA, d.draftVersion, { ...d.draft, settings: { ...d.draft.settings, phone: '000' } });
    const again = await site.draft(w.db, w.principalA, w.schoolA);
    await site.publish(w.db, w.principalA, w.schoolA, again.draftVersion, 'Contact details');
    expect((await site.publicSite(w.db, 'ncs-a')).settings.phone).toBe('022 2214 0000');
    const header = await printing.schoolHeader(w.db, w.schoolA);
    expect(header.phone).toBe('022 2214 0000');                      // certificates and report cards show the same
  });
});
