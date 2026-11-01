import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as hpc from '../src/modules/hpc.js';
import * as reportCards from '../src/modules/reportCards.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { HPC_TEMPLATES } from '../src/reference/hpcTemplates.js';
import { family, makeWorld, rejects, type World } from './helpers.js';

/**
 * Holistic Progress Cards in the schools' format: NES templates by class, the class teacher's
 * ratings per term (checked against each item's scale), All About Me from the parent, drawings for
 * the glimpse pages, and the printed card with a column per term so far.
 */

let w: World, other: Actor, ivT: Actor, bvT: Actor, hy: string, annual: string, ivA: string, bvA: string;
type Fam = Awaited<ReturnType<typeof family>>;
let kid: Fam, small: Fam;
// A 2×2 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAACQJAQFqN8wvAAAAAElFTkSuQmCC';

beforeAll(async () => {
  w = await makeWorld();
  for (const cls of ['IV', 'BV1']) {
    const s = await w.db.one<{ id: string }>(`insert into section (campus_id, academic_year, class_code, name, capacity) values ($1, '2026-27', $2, 'A', 30) returning id`, [w.campusA, cls]);
    w.sectionsA[cls] = [s.id];
  }
  ivA = w.sectionsA.IV[0]; bvA = w.sectionsA.BV1[0];
  const teacher = async (name: string) => loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, 'TEACHER', 'Teacher', 'nes.wnc.ncs_a') returning id`, [name])).id);
  ivT = await teacher('Teacher Four'); bvT = await teacher('Teacher Balvatika'); other = await teacher('Teacher Other');
  for (const [sec, t] of [[ivA, ivT], [bvA, bvT]] as const) await w.db.query(`insert into class_teacher (section_id, user_id, kind, valid, assigned_by) values ($1, $2, 'CLASS', daterange(current_date, '2027-04-01'), $2)`, [sec, t.id]);
  kid = await family(w, { classCode: 'IV' });
  small = await family(w, { classCode: 'BV1' });
  await w.db.query(`update student set name = 'Ira Menon', dob = '2016-08-13' where id = $1`, [kid.studentId]);
  await w.db.query(`update student set name = 'Kabir Rao', dob = '2022-03-24' where id = $1`, [small.studentId]);
  const mk = (code: string, name: string, kind: string, a: string, b: string) => w.db.one<{ id: string }>(
    `insert into assessment (school_id, academic_year, code, name, kind, status, starts, ends, created_by) values ($1, '2026-27', $2, $3, $4, 'OPEN', $5, $6, $7) returning id`,
    [w.schoolA, code, name, kind, a, b, w.principalA.id]).then((r) => r.id);
  hy = await mk('HY', 'Half-Yearly Examination', 'TERM', '2026-09-14', '2026-09-26');
  annual = await mk('ANNUAL', 'Annual Examination', 'ANNUAL', '2027-02-22', '2027-03-10');
  await w.db.query(`insert into health_checkup (student_id, school_id, on_date, height_cm, weight_kg, recorded_by) values ($1, $2, '2026-07-10', 142, 32, $3)`, [kid.studentId, w.schoolA, w.principalA.id]);
});

/** Every item of a template rated, with a sensible value for its kind. */
function fullRatings(t: Parameters<typeof hpc.rules>[0], seed = 0) {
  const out: Record<string, string> = {};
  let n = seed;
  for (const [id, r] of hpc.rules(t)) {
    n++;
    out[id] = r.kind === 'LEVEL' ? String((n % 3) + 1) : r.kind === 'SMILEY' ? String((n % 3) + 1) : r.kind === 'YESNO' ? (n % 5 ? 'YES' : 'NO')
      : r.kind === 'CHOICE' ? r.scale[r.scale.length - 1 - (n % 2)] : 'Drawing and cricket';
  }
  return out;
}

describe('templates', () => {
  it('ships the sample formats: Balvatika in stars, Classes I–II in plants and smileys, III–V in the PARAKH parts', () => {
    expect(HPC_TEMPLATES.BV1.parts.every((p) => p.kind === 'STARS')).toBe(true);
    expect(HPC_TEMPLATES.I.parts.map((p) => p.kind)).toEqual(['GOALS', 'SMILEYS', 'SMILEYS']);
    expect(HPC_TEMPLATES.IV.parts.map((p) => p.kind)).toEqual(['CHOICE', 'SUBJECT', 'SUBJECT', 'SUBJECT', 'SUBJECT', 'SUBJECT', 'SUBJECT', 'YESNO', 'YESNO', 'CHOICE', 'TEXT']);
    const ids = [...hpc.rules(HPC_TEMPLATES.IV).keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lets only NES change a template, keeps old item ids and numbers new ones', async () => {
    const t = structuredClone(HPC_TEMPLATES.V);
    const sub = t.parts.find((p) => p.kind === 'SUBJECT')!;
    if (sub.kind !== 'SUBJECT') throw new Error();
    const before = sub.groups[0].items.length;
    sub.groups[0].items.push({ id: '', text: 'Reads aloud with expression.' });
    await rejects(hpc.saveTemplate(w.db, w.principalA, 'V', t), /do not have access/);
    const saved = await hpc.saveTemplate(w.db, w.admin, 'V', t);
    const g = (saved.parts.find((p) => p.kind === 'SUBJECT') as typeof sub).groups[0];
    expect(g.items[before].id).toBe(`${g.id}.${before + 1}`);
    expect(saved.custom).toBe(true);
    expect((await hpc.resetTemplate(w.db, w.admin, 'V')).custom).toBe(false);
  });
});

describe('ratings', () => {
  it('takes only the class teacher’s ratings, and only values the item allows', async () => {
    await rejects(hpc.save(w.db, other, hy, kid.enrolmentId, { ratings: { '2.1.1': '3' } }), /class teacher/);
    await rejects(hpc.save(w.db, ivT, hy, kid.enrolmentId, { ratings: { '2.1.1': '5' } }), /not allowed/);
    await rejects(hpc.save(w.db, ivT, hy, kid.enrolmentId, { ratings: { '1.0.1': 'Maybe' } }), /not allowed/);
    const t = await hpc.template(w.db, 'IV');
    const r = await hpc.save(w.db, ivT, hy, kid.enrolmentId, { ratings: fullRatings(t), remark: 'Ira is a sincere student who is making steady progress.' });
    expect(r.rated).toBe(r.of);
    const sheet = await hpc.sheet(w.db, ivT, hy, ivA);
    expect((sheet.students as { rated: number; remark: boolean }[])[0]).toMatchObject({ rated: r.of, remark: true });
    // Ratings belong to an open term; periodic tests have no holistic card.
    const pt = (await w.db.one<{ id: string }>(`insert into assessment (school_id, academic_year, code, name, kind, status, created_by) values ($1, '2026-27', 'PT1', 'Periodic Test 1', 'PERIODIC', 'OPEN', $2) returning id`, [w.schoolA, w.principalA.id])).id;
    await rejects(hpc.save(w.db, ivT, pt, kid.enrolmentId, { ratings: {} }), /term examinations/);
  });

  it('All About Me comes from the parent; drawings go on the glimpse pages', async () => {
    const p = await hpc.profile(w.db, kid.parent, kid.studentId);
    expect(p.applies).toBe(true);
    await hpc.saveProfile(w.db, kid.parent, kid.studentId, { 'f.1': 'Ramayana', 'f.2': 'Spinach', 'f.7': 'Mathematics', bogus: 'x' });
    await hpc.addPhoto(w.db, kid.parent, kid.studentId, { kind: 'SELF', dataBase64: PNG });
    await hpc.addPhoto(w.db, kid.parent, kid.studentId, { kind: 'SELF', dataBase64: PNG });
    const again = await hpc.profile(w.db, ivT, kid.studentId);
    if (!again.applies) throw new Error();
    expect(Object.keys(again.answers)).toEqual(['f.1', 'f.2', 'f.7']);
    expect(again.photos.length).toBe(1);                                                   // the self portrait is replaced, not added
    await rejects(hpc.saveProfile(w.db, other, kid.studentId, {}), /parent or the class teacher|not shown/);
  });
});

describe('printing', () => {
  it('prints a draft for the class teacher, the published card for the parent, and both terms on the annual card', async () => {
    const draft = await reportCards.forSection(w.db, ivT, hy, ivA);
    expect(draft.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await rejects(reportCards.forStudent(w.db, kid.parent, kid.studentId, hy), /Published results/);
    await w.db.query(`update assessment set status = 'LOCKED' where id = $1`, [hy]);
    await w.db.query(`update assessment set status = 'PUBLISHED', published_at = '2026-10-03T10:00:00+05:30' where id = $1`, [hy]);
    await rejects(hpc.save(w.db, ivT, hy, kid.enrolmentId, { ratings: { '2.1.1': '1' } }), /no longer be changed|published/);
    const term1 = await reportCards.forStudent(w.db, kid.parent, kid.studentId, hy);
    const t = await hpc.template(w.db, 'IV');
    await hpc.save(w.db, ivT, annual, kid.enrolmentId, { ratings: fullRatings(t, 1), remark: 'Ira has grown in confidence this term.' });
    const both = await reportCards.forSection(w.db, w.principalA, annual, ivA);
    const bt = await hpc.template(w.db, 'BV1');
    await hpc.save(w.db, bvT, annual, small.enrolmentId, { ratings: fullRatings(bt) });
    const bv = await reportCards.forSection(w.db, bvT, annual, bvA);
    expect(both.pdf.length).toBeGreaterThan(term1.pdf.length);
    const out = process.env.HPC_OUT;
    if (out) { writeFileSync(`${out}/iv-term1.pdf`, term1.pdf); writeFileSync(`${out}/iv-annual.pdf`, both.pdf); writeFileSync(`${out}/bv1-annual.pdf`, bv.pdf); }
  });
});
