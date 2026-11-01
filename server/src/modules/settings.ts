import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { SETTING, SETTINGS, type Level } from '../lib/settingsRegistry.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { localToday } from '../lib/dates.js';

const today = () => localToday();

interface Row { unit_id: string; unit: string; kind: Level; depth: number; value: unknown; locked: boolean; from: string; to: string | null }

/** Values of one key on the path from NES down to a unit, in force on a date, top first. */
async function chain(db: Db, unitId: string, key: string, on: string) {
  return db.query<Row>(
    `select v.unit_id, o.name as unit, o.kind, nlevel(o.path) as depth, v.value, v.locked, lower(v.valid)::text as from, upper(v.valid)::text as to
       from setting_value v join org_unit o on o.id = v.unit_id join org_unit me on me.id = $1
      where v.key = $2 and o.path @> me.path and v.valid @> $3::date order by nlevel(o.path)`, [unitId, key, on]);
}

/** The deepest value wins, unless a unit above has locked the key. */
function resolve(rows: Row[], def: unknown) {
  const locked = rows.find((r) => r.locked);
  const pick = locked ?? rows[rows.length - 1];
  return pick ? { value: pick.value, source: pick.unit, sourceUnitId: pick.unit_id, lockedBy: locked?.unit ?? null } : { value: def, source: 'NES default', sourceUnitId: null, lockedBy: null };
}

/** The value a module should use for a school (or any unit) on a date. */
export async function get<T = unknown>(db: Db, unitId: string, key: string, on = today()): Promise<T> {
  const def = SETTING.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return resolve(await chain(db, unitId, key, on), def.default).value as T;
}

/** Every setting for a unit: what applies, where it comes from, and whether this unit may change it. */
export async function forUnit(db: Db, actor: Actor, unitId: string) {
  await assertUnitInScope(db, actor, unitId);
  const unit = await db.one<{ kind: Level; name: string }>('select kind, name from org_unit where id = $1', [unitId]);
  const out = [];
  for (const s of SETTINGS) {
    const rows = await chain(db, unitId, s.key, today());
    const r = resolve(rows, s.default);
    const own = rows.find((x) => x.unit_id === unitId);
    const lockedAbove = rows.find((x) => x.locked && x.unit_id !== unitId);
    const upcoming = await db.query<{ value: unknown; from: string }>(
      `select value, lower(valid)::text as from from setting_value where unit_id = $1 and key = $2 and lower(valid) > $3::date order by lower(valid)`, [unitId, s.key, today()]);
    out.push({
      key: s.key, category: s.category, label: s.label, help: s.help, kind: s.kind, options: s.options ?? null,
      value: r.value, source: r.source, own: own ? { value: own.value, from: own.from, locked: own.locked } : null,
      lockedBy: lockedAbove?.unit ?? null, canSet: s.levels.includes(unit.kind) && !lockedAbove && canSetAt(actor, unit.kind), upcoming, default: s.default,
    });
  }
  return { unit: unit.name, kind: unit.kind, settings: out };
}

function canSetAt(actor: Actor, kind: Level) {
  if (actor.role === 'NES_ADMIN') return true;
  if (actor.role === 'COMMAND_OFFICER') return kind !== 'society';
  if (actor.role === 'SCHOOL_ADMIN') return kind === 'school';
  return false;
}

/**
 * Sets a value for a unit from a date. The unit's previous value ends the day before; values
 * planned after that date are replaced. Units below inherit it unless they set their own,
 * and cannot override it at all if it is locked.
 */
export async function set(db: Db, actor: Actor, unitId: string, input: { key: string; value: unknown; from: string; locked?: boolean; note?: string }) {
  await assertUnitInScope(db, actor, unitId);
  const def = SETTING.get(input.key);
  if (!def) throw notFound('Setting');
  const unit = await db.one<{ kind: Level }>('select kind from org_unit where id = $1', [unitId]);
  if (!def.levels.includes(unit.kind)) throw invalid(`This setting cannot be set at ${unit.kind === 'society' ? 'NES' : unit.kind} level.`);
  if (!canSetAt(actor, unit.kind)) throw forbidden('You cannot change settings at this level.');
  if (input.locked && unit.kind === 'school') throw invalid('Only NES or a Command can lock a setting for the schools below it.');
  if (input.from < today()) throw invalid('A setting can change from today or a later date.');
  const parsed = def.schema.safeParse(input.value);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'This value is not allowed.');
  const above = (await chain(db, unitId, input.key, input.from)).find((r) => r.locked && r.unit_id !== unitId);
  if (above) throw forbidden(`${above.unit} has fixed this setting for every school below it.`);
  return db.tx(async (t) => {
    await t.query(`delete from setting_value where unit_id = $1 and key = $2 and lower(valid) >= $3::date`, [unitId, input.key, input.from]);
    await t.query(`update setting_value set valid = daterange(lower(valid), $3::date) where unit_id = $1 and key = $2 and valid @> $3::date and lower(valid) < $3::date`, [unitId, input.key, input.from]);
    await t.query(`insert into setting_value (unit_id, key, value, locked, valid, note, set_by) values ($1, $2, $3, $4, daterange($5::date, null), $6, $7)`,
      [unitId, input.key, JSON.stringify(parsed.data), input.locked ?? false, input.from, input.note ?? '', actor.id]);
    return { key: input.key, value: parsed.data, from: input.from };
  }, { actor: actor.label });
}

/** Stops a unit's own value from a date, so it follows the level above again. */
export async function clear(db: Db, actor: Actor, unitId: string, key: string, from: string) {
  await assertUnitInScope(db, actor, unitId);
  const unit = await db.one<{ kind: Level }>('select kind from org_unit where id = $1', [unitId]);
  if (!canSetAt(actor, unit.kind)) throw forbidden('You cannot change settings at this level.');
  if (from < today()) throw invalid('Choose today or a later date.');
  await db.tx(async (t) => {
    await t.query(`delete from setting_value where unit_id = $1 and key = $2 and lower(valid) >= $3::date`, [unitId, key, from]);
    await t.query(`update setting_value set valid = daterange(lower(valid), $3::date) where unit_id = $1 and key = $2 and valid @> $3::date and lower(valid) < $3::date`, [unitId, key, from]);
  }, { actor: actor.label });
  return { ok: true };
}

export async function history(db: Db, actor: Actor, unitId: string, key: string) {
  await assertUnitInScope(db, actor, unitId);
  return db.query(
    `select v.value, v.locked, lower(v.valid)::text as from, upper(v.valid)::text as to, v.note, u.name as set_by, v.set_at
       from setting_value v join app_user u on u.id = v.set_by where v.unit_id = $1 and v.key = $2 order by lower(v.valid) desc`, [unitId, key]);
}
