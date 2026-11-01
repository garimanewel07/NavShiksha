import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';

export interface Unit {
  id: string; kind: string; code: string; name: string; parent_id: string | null;
  path: string; school_type: string | null; address: string | null; active: boolean;
}

export async function tree(db: Db, actor: Actor) {
  const scope = actor.scopePath ?? 'nes';
  return db.query<Unit>(
    `select id, kind, code, name, parent_id, path::text, school_type, address, active
       from org_unit where path <@ $1::ltree or $1::ltree <@ path order by path`, [scope]);
}

/**
 * A school's official details: kept once here and read by its website, certificates, report cards,
 * ID cards, payslips and letters. The principal keeps them up to date; the name is set by NES.
 */
export async function schoolDetails(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  const s = await db.maybeOne(
    `select o.id, o.name, o.code, o.school_type, o.address, o.phone, o.email, o.website, o.city, o.affiliation_no, o.udise_code, o.school_no, o.board, o.tan,
            (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'address', c.address) order by c.code), '[]') from org_unit c where c.parent_id = o.id and c.kind = 'campus' and c.active) as campuses
       from org_unit o where o.id = $1 and o.kind = 'school'`, [schoolId]);
  if (!s) throw notFound('School');
  return { ...s, canEdit: actor.role === 'NES_ADMIN' || actor.role === 'SCHOOL_ADMIN', canRename: actor.role === 'NES_ADMIN' };
}

export async function updateSchoolDetails(db: Db, actor: Actor, schoolId: string, input: { name?: string; address?: string | null; phone?: string | null; email?: string | null; website?: string | null;
  city?: string | null; affiliationNo?: string | null; udiseCode?: string | null; schoolNo?: string | null; tan?: string | null; campuses?: { id: string; address: string }[] }) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  if (input.name !== undefined && actor.role !== 'NES_ADMIN') throw forbidden('The school’s official name is set by NES.');
  if (input.tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(input.tan.trim().toUpperCase())) throw invalid('A TAN has four letters, five digits and a letter, like MUMN12345A.');
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw invalid('That email address does not look right.');
  const set = (v: unknown) => v !== undefined;
  await db.tx(async (t) => {
    await t.query(
      `update org_unit set name = coalesce($2, name), address = case when $3 then $4 else address end, phone = case when $5 then $6 else phone end, email = case when $7 then $8 else email end,
              website = case when $9 then $10 else website end, city = case when $11 then $12 else city end, affiliation_no = case when $13 then $14 else affiliation_no end,
              udise_code = case when $15 then $16 else udise_code end, school_no = case when $17 then $18 else school_no end, tan = case when $19 then $20 else tan end where id = $1 and kind = 'school'`,
      [schoolId, input.name?.trim() || null, set(input.address), input.address?.trim() || null, set(input.phone), input.phone?.trim() || null, set(input.email), input.email?.trim() || null,
       set(input.website), input.website?.trim() || null, set(input.city), input.city?.trim() || null, set(input.affiliationNo), input.affiliationNo?.trim() || null,
       set(input.udiseCode), input.udiseCode?.trim() || null, set(input.schoolNo), input.schoolNo?.trim() || null, set(input.tan), input.tan?.trim().toUpperCase() || null]);
    for (const c of input.campuses ?? []) {
      if (c.address.trim().length < 5) throw invalid('Give each campus a full address.');
      await t.query(`update org_unit set address = $3 where id = $1 and parent_id = $2 and kind = 'campus'`, [c.id, schoolId, c.address.trim()]);
    }
  }, { actor: actor.label });
  return schoolDetails(db, actor, schoolId);
}

export async function schoolOf(db: Db, campusId: string): Promise<string> {
  const r = await db.maybeOne<{ parent_id: string }>(`select parent_id from org_unit where id = $1 and kind = 'campus'`, [campusId]);
  if (!r) throw notFound('Campus');
  return r.parent_id;
}

export async function campuses(db: Db, schoolId: string) {
  return db.query<{ id: string; code: string; name: string; address: string }>(
    `select id, code, name, address from org_unit where parent_id = $1 and kind = 'campus' and active order by code`, [schoolId]);
}

/**
 * Records a merger: the merged school's campuses move under the surviving school from the
 * effective date. Students keep their IDs; the old school and its records stay in history.
 */
export async function recordMerger(db: Db, actor: Actor, input: { mergedSchoolId: string; survivingSchoolId: string; effectiveDate: string; note?: string }) {
  requireRole(actor, 'NES_ADMIN');
  await assertUnitInScope(db, actor, input.mergedSchoolId);
  await assertUnitInScope(db, actor, input.survivingSchoolId);
  return db.tx(async (t) => {
    const kinds = await t.query<{ id: string; kind: string }>(`select id, kind from org_unit where id = any($1::uuid[])`, [[input.mergedSchoolId, input.survivingSchoolId]]);
    if (kinds.length !== 2 || kinds.some((k) => k.kind !== 'school')) throw invalid('Both units must be schools.');
    const m = await t.one<{ id: string }>(
      `insert into org_merger (merged_school_id, surviving_school_id, effective_date, note) values ($1, $2, $3, $4) returning id`,
      [input.mergedSchoolId, input.survivingSchoolId, input.effectiveDate, input.note ?? null]);
    await t.query(`update org_unit set parent_id = $2 where parent_id = $1 and kind = 'campus'`, [input.mergedSchoolId, input.survivingSchoolId]);
    await t.query(`update org_unit set active = false where id = $1`, [input.mergedSchoolId]);
    return m;
  }, { actor: actor.label });
}
