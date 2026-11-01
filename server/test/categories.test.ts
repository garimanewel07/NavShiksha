import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateApplicant } from '../src/modules/admissions.js';
import { publishScheme } from '../src/modules/categories.js';
import { makeWorld, rejects, type World } from './helpers.js';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const cat = (rel: string, service: Record<string, unknown>) => evaluateApplicant(w.db, w.schoolA, rel, service as never, '2026-10-01');

describe('admission categories and fee bands', () => {
  it('works out Cat 1 and the fee band from service facts, with reasons', async () => {
    const r = await cat('FATHER', { service: 'NAVY', status: 'SERVING', rankCode: 'N_LCDR', postedInStation: true });
    expect(r.admission.code).toBe('1');
    expect(r.feeBand.code).toBe('OFFICER');
    expect(r.admission.because.join(' ')).toMatch(/posted in station/);
    expect(r.admission.requiredDocs).toContain('FORM_2A');
  });

  it('covers ex-servicemen, defence civilians, grandchildren and others', async () => {
    expect((await cat('FATHER', { service: 'NAVY', status: 'ESM_PENSION', rankCode: 'N_CPO' })).admission.code).toBe('2');
    expect((await cat('FATHER', { service: 'NAVY', status: 'ESM_PENSION', rankCode: 'N_CPO' })).feeBand.code).toBe('CPO_AND_ABOVE');
    expect((await cat('MOTHER', { service: 'DEF_CIV_NAVY', status: 'SERVING', postedInStation: true, civilOfficer: true })).feeBand.code).toBe('OFFICER');
    expect((await cat('GRANDPARENT', { service: 'NAVY', status: 'SERVING', rankCode: 'N_PO', postedInStation: true })).admission.code).toBe('4A');
    expect((await cat('FATHER', { service: 'CIVILIAN', status: 'NONE' })).admission.code).toBe('4B');
  });

  it('versions schemes by date: a new version takes over, the old one keeps its history', async () => {
    const changed = await publishScheme(w.db, {
      schoolId: w.schoolA, kind: 'FEE_BAND', name: 'Alpha fee bands', validFrom: '2026-11-01',
      rules: [{ code: 'FLAT', label: 'Everyone', priority: 1, condition: { always: true } }],
    }, 'test');
    expect(changed.version).toBe(1);
    expect((await cat('FATHER', { service: 'NAVY', status: 'SERVING', rankCode: 'N_PO', postedInStation: true })).feeBand.code).toBe('PO_AND_BELOW');
    const later = await evaluateApplicant(w.db, w.schoolA, 'FATHER', { service: 'NAVY', status: 'SERVING', rankCode: 'N_PO', postedInStation: true }, '2026-12-01');
    expect(later.feeBand.code).toBe('FLAT');
  });

  it('refuses rules on a published scheme and overlapping published versions', async () => {
    const s = await w.db.one<{ id: string }>(`select id from category_scheme where kind = 'ADMISSION' and status = 'PUBLISHED' limit 1`);
    await rejects(w.db.query(`update category_rule set label = 'x' where scheme_id = $1`, [s.id]), /cannot change/);
    await rejects(w.db.query(`insert into category_scheme (school_id, kind, name, version, valid, status) values (null, 'ADMISSION', 'dup', 99, daterange('2026-05-01', null), 'PUBLISHED')`), /exclusion|conflicting/);
  });

  it('refuses a scheme without a catch-all rule', async () => {
    await rejects(publishScheme(w.db, { schoolId: w.schoolB, kind: 'ADMISSION', name: 'bad', validFrom: '2026-05-01',
      rules: [{ code: '1', label: 'x', priority: 1, condition: { eq: ['service', 'NAVY'] } }] }, 'test'), /catch-all/);
  });
});
