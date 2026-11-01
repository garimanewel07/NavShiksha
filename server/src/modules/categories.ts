import type { Db } from '../db/client.js';
import { classify, ruleSchema, type Classification, type Facts, type RankedRule, type Rule } from '../lib/rules.js';
import { invalid } from '../lib/errors.js';

export type SchemeKind = 'ADMISSION' | 'FEE_BAND';

export interface ServiceFacts {
  service: string; status: string; rank_code: string | null; civil_officer: boolean; posted_in_station: boolean;
}

export interface CategoryResult extends Classification {
  schemeId: string; schemeVersion: number; schemeName: string; requiredDocs: string[];
}

/** The scheme in force for a school on a date; a school's own scheme wins over the NES default. */
async function schemeFor(db: Db, schoolId: string, kind: SchemeKind, on: string) {
  const s = await db.maybeOne<{ id: string; version: number; name: string }>(
    `select id, version, name from category_scheme
      where kind = $2 and status = 'PUBLISHED' and valid @> $3::date and (school_id = $1 or school_id is null)
      order by school_id nulls last limit 1`, [schoolId, kind, on]);
  if (!s) throw invalid(`No ${kind.toLowerCase().replace('_', ' ')} scheme is in force on ${on}.`);
  const rules = await db.query<{ id: string; code: string; label: string; priority: number; condition: Rule; required_docs: string[] }>(
    `select id, code, label, priority, condition, required_docs from category_rule where scheme_id = $1`, [s.id]);
  return { ...s, rules };
}

export async function buildFacts(db: Db, sf: ServiceFacts, relationship: string, extra: Facts = {}): Promise<Facts> {
  const rank = sf.rank_code ? await db.maybeOne<{ band: string }>('select band from rank where code = $1', [sf.rank_code]) : null;
  return {
    service: sf.service, status: sf.status, rank_band: rank?.band ?? null, civil_officer: sf.civil_officer,
    posted_in_station: sf.posted_in_station, relationship, ...extra,
  };
}

export async function categorise(db: Db, schoolId: string, kind: SchemeKind, on: string, facts: Facts): Promise<CategoryResult> {
  const s = await schemeFor(db, schoolId, kind, on);
  const hit = classify(s.rules as RankedRule[], facts);
  const rule = s.rules.find((r) => r.id === hit.ruleId)!;
  return { ...hit, schemeId: s.id, schemeVersion: s.version, schemeName: s.name, requiredDocs: rule.required_docs };
}

/** Facts for an enrolled student on a date, from the primary guardian's service record. */
export async function studentFacts(db: Db, studentId: string, on: string): Promise<{ facts: Facts; guardianId: string }> {
  const g = await db.maybeOne<{ guardian_id: string; relationship: string }>(
    `select guardian_id, relationship from student_guardian where student_id = $1 and is_primary`, [studentId]);
  if (!g) throw invalid('This student has no primary guardian.');
  const sf = await db.maybeOne<ServiceFacts>(
    `select service, status, rank_code, civil_officer, posted_in_station from guardian_service_fact
      where guardian_id = $1 and valid @> $2::date`, [g.guardian_id, on]);
  if (!sf) throw invalid(`The guardian has no service record covering ${on}.`);
  const sibling = await db.one<{ rank: number }>(
    `select count(*)::int as rank from family_of($1) f join student s on s.id = f.student_id join student me on me.id = $1
      where s.dob <= me.dob and $2::uuid is not null and exists (select 1 from enrolment e where e.student_id = s.id and e.period @> $3::date)`, [studentId, g.guardian_id, on]);
  return { facts: await buildFacts(db, sf, g.relationship, { sibling_rank: Math.max(1, sibling.rank) }), guardianId: g.guardian_id };
}

export interface SchemeInput {
  schoolId: string | null; kind: SchemeKind; name: string; validFrom: string;
  rules: { code: string; label: string; priority: number; condition: unknown; requiredDocs?: string[] }[];
}

/** Creates a scheme as a draft, validates every rule, then publishes it in one step. */
export async function publishScheme(db: Db, input: SchemeInput, actorLabel: string) {
  const last = input.rules.slice().sort((a, b) => b.priority - a.priority)[0];
  if (!last || !('always' in (last.condition as object))) throw invalid('The last rule of a scheme must be a catch-all ("always").');
  for (const r of input.rules) {
    const p = ruleSchema.safeParse(r.condition);
    if (!p.success) throw invalid(`Rule ${r.code} is not valid.`, p.error.issues);
  }
  return db.tx(async (t) => {
    const v = await t.one<{ next: number }>(
      `select coalesce(max(version), 0) + 1 as next from category_scheme where school_id is not distinct from $1 and kind = $2`, [input.schoolId, input.kind]);
    await t.query(
      `update category_scheme set valid = daterange(lower(valid), $3::date)
        where school_id is not distinct from $1 and kind = $2 and status = 'PUBLISHED' and upper_inf(valid) and lower(valid) < $3::date`,
      [input.schoolId, input.kind, input.validFrom]);
    const s = await t.one<{ id: string }>(
      `insert into category_scheme (school_id, kind, name, version, valid, status) values ($1, $2, $3, $4, daterange($5::date, null), 'DRAFT') returning id`,
      [input.schoolId, input.kind, input.name, v.next, input.validFrom]);
    for (const r of input.rules) {
      await t.query(`insert into category_rule (scheme_id, code, label, priority, condition, required_docs) values ($1, $2, $3, $4, $5, $6)`,
        [s.id, r.code, r.label, r.priority, JSON.stringify(r.condition), r.requiredDocs ?? []]);
    }
    await t.query(`update category_scheme set status = 'PUBLISHED' where id = $1`, [s.id]);
    return { id: s.id, version: v.next };
  }, { actor: actorLabel });
}

export async function listSchemes(db: Db) {
  return db.query(`select s.id, s.kind, s.name, s.version, lower(s.valid)::text as valid_from, upper(s.valid)::text as valid_to,
                          coalesce(o.name, 'All NES schools') as applies_to,
                          (select json_agg(json_build_object('code', r.code, 'label', r.label, 'priority', r.priority, 'condition', r.condition, 'requiredDocs', r.required_docs) order by r.priority)
                             from category_rule r where r.scheme_id = s.id) as rules
                     from category_scheme s left join org_unit o on o.id = s.school_id
                    where s.status = 'PUBLISHED' order by s.kind, s.version desc`);
}
