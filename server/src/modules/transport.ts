import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import type { Actor } from './auth.js';
import { assertCan, can } from './access.js';
import { assertGuardianOf } from './access.js';
import { post, signed } from './ledger.js';
import * as notify from './notify.js';
import * as settings from './settings.js';

/**
 * School transport. A child's stop is entered once, on their allocation, and from it follow the
 * transport fee (each month used, at the stop's fare), the bus list, the boarding register and the
 * parent app's "My bus". No GPS is needed: every stop has a morning and afternoon time, parents see
 * those, and the attendant may tap "started", "at this stop" or "running late" so parents further
 * along get revised times. A route can switch to GPS when a tracker (or the attendant's phone) is used.
 */

const UUID = /^[0-9a-f-]{36}$/i;
type Leg = 'MORNING' | 'AFTERNOON';
const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const hhmm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
/** Minutes past midnight now, in India. */
const nowMin = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); return toMin(p)!; };
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function schoolOfRoute(db: Db, routeId: string) {
  if (!UUID.test(routeId)) throw notFound('Route');
  const r = await db.maybeOne<{ school_id: string; code: string; name: string; tracking: string; driver_user: string | null; attendant_user: string | null }>(
    `select r.school_id, r.code, r.name, r.tracking, d.user_id as driver_user, a.user_id as attendant_user
       from route r left join transport_crew d on d.id = r.driver_id left join transport_crew a on a.id = r.attendant_id where r.id = $1`, [routeId]);
  if (!r) throw notFound('Route');
  return r;
}

// ── Set-up: vehicles, crew, fares, routes and stops ───────────────────────────────────────

export async function overview(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'transport.view', schoolId);
  const on = localToday();
  const vehicles = await db.query<Record<string, string | null>>(`select id, reg_no, kind, seats, owner, contractor, fitness_until::text, insurance_until::text, permit_until::text, puc_until::text, gps_device, active from vehicle where school_id = $1 order by reg_no`, [schoolId]);
  const crew = await db.query(
    `select c.id, c.user_id, coalesce(u.name, c.name) as name, coalesce(u.phone, c.phone) as phone, c.role, c.licence_no, c.licence_until::text, c.police_verified_on::text, c.active, c.user_id is not null as school_staff
       from transport_crew c left join app_user u on u.id = c.user_id where c.school_id = $1 order by c.role, name`, [schoolId]);
  const fares = await db.query(`select id, zone, name, monthly_paise::int as monthly_paise, lower(valid)::text as from, upper(valid)::text as to from transport_fare where school_id = $1 and (upper_inf(valid) or upper(valid) > $2) order by zone, lower(valid)`, [schoolId, on]);
  const routes = await db.query<{ id: string; seats: number | null; used: number }>(
    `select r.id, r.code, r.name, r.tracking, r.active, r.vehicle_id, r.driver_id, r.attendant_id, v.reg_no, v.seats,
            (select coalesce(u.name, c.name) from transport_crew c left join app_user u on u.id = c.user_id where c.id = r.driver_id) as driver,
            (select coalesce(u.name, c.name) from transport_crew c left join app_user u on u.id = c.user_id where c.id = r.attendant_id) as attendant,
            (select count(distinct a.student_id) from transport_allocation a join route_stop s on s.id in (a.pickup_stop_id, a.drop_stop_id) where s.route_id = r.id and a.valid @> $2::date)::int as used,
            coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'seq', s.seq, 'name', s.name, 'landmark', s.landmark, 'morning', to_char(s.morning_time, 'HH24:MI'), 'afternoon', to_char(s.afternoon_time, 'HH24:MI'), 'fareZone', s.fare_zone,
               'children', (select count(*) from transport_allocation a where (a.pickup_stop_id = s.id or a.drop_stop_id = s.id) and a.valid @> $2::date)) order by s.seq) from route_stop s where s.route_id = r.id and s.active), '[]') as stops
       from route r left join vehicle v on v.id = r.vehicle_id where r.school_id = $1 order by r.code`, [schoolId, on]);
  // Papers that have run out (the vehicle must not run) or run out within a month.
  const soon = addDays(on, 30);
  const alerts: { level: 'ERROR' | 'WARNING'; message: string }[] = [];
  for (const v of vehicles.filter((x) => x.active)) for (const [k, l] of [['fitness_until', 'fitness certificate'], ['insurance_until', 'insurance'], ['permit_until', 'permit'], ['puc_until', 'pollution certificate']] as const) {
    const d = v[k];
    if (!d) alerts.push({ level: 'WARNING', message: `${v.reg_no}: no ${l} date recorded.` });
    else if (d < on) alerts.push({ level: 'ERROR', message: `${v.reg_no}: ${l} expired on ${d}. The vehicle must not carry children.` });
    else if (d <= soon) alerts.push({ level: 'WARNING', message: `${v.reg_no}: ${l} expires on ${d}.` });
  }
  for (const c of crew as { name: string; role: string; licence_until: string | null; police_verified_on: string | null; active: boolean }[]) {
    if (!c.active) continue;
    if (c.role === 'DRIVER' && c.licence_until && c.licence_until < on) alerts.push({ level: 'ERROR', message: `${c.name}: driving licence expired on ${c.licence_until}.` });
    else if (c.role === 'DRIVER' && c.licence_until && c.licence_until <= soon) alerts.push({ level: 'WARNING', message: `${c.name}: driving licence expires on ${c.licence_until}.` });
    if (!c.police_verified_on) alerts.push({ level: 'WARNING', message: `${c.name}: police verification not recorded.` });
  }
  for (const r of routes) if (r.seats !== null && r.used > r.seats) alerts.push({ level: 'ERROR', message: `Route ${(r as unknown as { code: string }).code}: ${r.used} children for ${r.seats} seats.` });
  const requests = await db.query(
    `select q.id, q.kind, q.student_id, st.name as student, e.class_code || coalesce('-' || sec.name, '') as class, q.from_date::text, q.note, q.created_at, u.name as requested_by,
            ps.name as pickup, pr.code as pickup_route, ds.name as drop, dr.code as drop_route,
            (select s.name || ' (' || r.code || ')' from transport_allocation a join route_stop s on s.id = coalesce(a.pickup_stop_id, a.drop_stop_id) join route r on r.id = s.route_id where a.student_id = q.student_id and a.valid @> current_date) as now_on
       from transport_request q join student st on st.id = q.student_id join app_user u on u.id = q.requested_by
       left join enrolment e on e.student_id = q.student_id and upper_inf(e.period) and e.status in ('ACTIVE', 'PROVISIONAL') left join section sec on sec.id = e.section_id
       left join route_stop ps on ps.id = q.pickup_stop_id left join route pr on pr.id = ps.route_id left join route_stop ds on ds.id = q.drop_stop_id left join route dr on dr.id = ds.route_id
      where q.school_id = $1 and q.status = 'PENDING' order by q.created_at`, [schoolId]);
  return { vehicles, crew, fares, routes, requests, alerts, canManage: await can(db, actor, 'transport.manage', schoolId) };
}

export async function saveVehicle(db: Db, actor: Actor, schoolId: string, input: { id?: string; regNo: string; kind: 'BUS' | 'MINIBUS' | 'VAN'; seats: number; owner: 'SCHOOL' | 'CONTRACTOR' | 'NAVY'; contractor?: string | null;
  fitnessUntil?: string | null; insuranceUntil?: string | null; permitUntil?: string | null; pucUntil?: string | null; gpsDevice?: string | null; active?: boolean }) {
  await assertCan(db, actor, 'transport.manage', schoolId);
  const reg = input.regNo.trim().toUpperCase().replace(/\s+/g, ' ');
  const vals = [schoolId, reg, input.kind, input.seats, input.owner, input.contractor?.trim() || null, input.fitnessUntil || null, input.insuranceUntil || null, input.permitUntil || null, input.pucUntil || null, input.gpsDevice?.trim() || null, input.active ?? true];
  return db.tx(async (t) => {
    if (input.id) {
      const r = await t.query(`update vehicle set reg_no = $2, kind = $3, seats = $4, owner = $5, contractor = $6, fitness_until = $7, insurance_until = $8, permit_until = $9, puc_until = $10, gps_device = $11, active = $12
        where id = $13 and school_id = $1 returning id`, [...vals, input.id]);
      if (!r.length) throw notFound('Vehicle');
      return { id: input.id };
    }
    return t.one<{ id: string }>(`insert into vehicle (school_id, reg_no, kind, seats, owner, contractor, fitness_until, insurance_until, permit_until, puc_until, gps_device, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, vals);
  }, { actor: actor.label });
}

/** A driver or attendant: one of the school's staff (details from their staff record), or the contractor's person. */
export async function saveCrew(db: Db, actor: Actor, schoolId: string, input: { id?: string; userId?: string | null; name?: string | null; phone?: string | null; role: 'DRIVER' | 'ATTENDANT';
  licenceNo?: string | null; licenceUntil?: string | null; policeVerifiedOn?: string | null; active?: boolean }) {
  await assertCan(db, actor, 'transport.manage', schoolId);
  if (input.userId && !(await db.maybeOne('select 1 from employee where user_id = $1 and school_id = $2', [input.userId, schoolId]))) throw invalid('Choose someone on this school’s staff.');
  if (!input.userId && (!input.name || input.name.trim().length < 3)) throw invalid('Give the name, or choose one of the school’s staff.');
  const phone = input.phone ? `+91${input.phone.replace(/\D/g, '').slice(-10)}` : null;
  if (input.role === 'DRIVER' && !input.licenceNo?.trim()) throw invalid('Give the driving licence number.');
  const vals = [schoolId, input.userId || null, input.userId ? null : input.name!.trim(), input.userId ? null : phone, input.role, input.licenceNo?.trim() || null, input.licenceUntil || null, input.policeVerifiedOn || null, input.active ?? true];
  return db.tx(async (t) => {
    if (input.id) {
      await t.query(`update transport_crew set user_id = $2, name = $3, phone = $4, role = $5, licence_no = $6, licence_until = $7, police_verified_on = $8, active = $9 where id = $10 and school_id = $1`, [...vals, input.id]);
      return { id: input.id };
    }
    return t.one<{ id: string }>(`insert into transport_crew (school_id, user_id, name, phone, role, licence_no, licence_until, police_verified_on, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, vals);
  }, { actor: actor.label });
}

/** A fare zone's monthly fare from a date. Months already billed are not changed; the new fare applies from the date. */
export async function setFare(db: Db, actor: Actor, schoolId: string, input: { zone: string; name: string; monthlyPaise: number; from: string }) {
  await assertCan(db, actor, 'transport.manage', schoolId);
  const zone = input.zone.trim().toUpperCase();
  await db.tx(async (t) => {
    await t.query(`delete from transport_fare where school_id = $1 and zone = $2 and lower(valid) >= $3::date`, [schoolId, zone, input.from]);
    await t.query(`update transport_fare set valid = daterange(lower(valid), $3::date) where school_id = $1 and zone = $2 and valid @> $3::date`, [schoolId, zone, input.from]);
    await t.query(`insert into transport_fare (school_id, zone, name, monthly_paise, valid, created_by) values ($1, $2, $3, $4, daterange($5::date, null), $6)`, [schoolId, zone, input.name.trim(), input.monthlyPaise, input.from, actor.id]);
  }, { actor: actor.label });
  return { zone };
}

export async function saveRoute(db: Db, actor: Actor, schoolId: string, input: { id?: string; code: string; name: string; vehicleId?: string | null; driverId?: string | null; attendantId?: string | null; tracking?: Tracking; active?: boolean }) {
  await assertCan(db, actor, 'transport.manage', schoolId);
  const vals = [schoolId, input.code.trim().toUpperCase(), input.name.trim(), input.vehicleId || null, input.driverId || null, input.attendantId || null, input.tracking ?? 'TAPS', input.active ?? true];
  if (input.vehicleId && !(await db.maybeOne('select 1 from vehicle where id = $1 and school_id = $2', [input.vehicleId, schoolId]))) throw invalid('Choose one of this school’s vehicles.');
  for (const c of [input.driverId, input.attendantId]) if (c && !(await db.maybeOne('select 1 from transport_crew where id = $1 and school_id = $2', [c, schoolId]))) throw invalid('Choose the school’s own crew.');
  return db.tx(async (t) => {
    if (input.id) {
      const r = await t.query(`update route set code = $2, name = $3, vehicle_id = $4, driver_id = $5, attendant_id = $6, tracking = $7, active = $8 where id = $9 and school_id = $1 returning id`, [...vals, input.id]);
      if (!r.length) throw notFound('Route');
      return { id: input.id };
    }
    return t.one<{ id: string }>(`insert into route (school_id, code, name, vehicle_id, driver_id, attendant_id, tracking, active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, vals);
  }, { actor: actor.label });
}

/**
 * The route's stops in order with their times. A stop children use cannot be dropped; move them
 * first. Times must run forward in the morning (to school) and in the afternoon (from school).
 */
export async function saveStops(db: Db, actor: Actor, routeId: string, stops: { id?: string; name: string; landmark?: string | null; morning?: string | null; afternoon?: string | null; fareZone: string }[]) {
  const r = await schoolOfRoute(db, routeId);
  await assertCan(db, actor, 'transport.manage', r.school_id);
  if (!stops.length) throw invalid('A route needs at least one stop.');
  const zones = (await db.query<{ zone: string }>(`select distinct zone from transport_fare where school_id = $1`, [r.school_id])).map((z) => z.zone);
  for (const s of stops) if (!zones.includes(s.fareZone.toUpperCase())) throw invalid(`Fare zone ${s.fareZone} has no fare yet.`);
  const m = stops.map((s) => toMin(s.morning ?? null)).filter((x): x is number => x !== null);
  if (m.some((x, i) => i > 0 && x <= m[i - 1])) throw invalid('Morning times must get later from the first stop to the last.');
  const a = stops.map((s) => toMin(s.afternoon ?? null)).filter((x): x is number => x !== null);
  // In the afternoon the bus comes back the same way: the stop nearest school (the last in the list) is reached first.
  if (a.some((x, i) => i > 0 && x >= a[i - 1])) throw invalid('Afternoon times must get earlier from the first stop to the last (the bus drops the nearest stop first).');
  return db.tx(async (t) => {
    const keep = stops.filter((s) => s.id).map((s) => s.id!);
    const dropped = await t.query<{ id: string; name: string }>(`select id, name from route_stop where route_id = $1 and active and not (id = any($2::uuid[]))`, [routeId, keep]);
    for (const d of dropped) {
      if (await t.maybeOne(`select 1 from transport_allocation where (pickup_stop_id = $1 or drop_stop_id = $1) and (upper_inf(valid) or upper(valid) > current_date)`, [d.id])) throw conflict('in_use', `Children use ${d.name}; move them to another stop first.`);
      await t.query('update route_stop set active = false where id = $1', [d.id]);
    }
    for (const [i, s] of stops.entries()) {
      const vals = [s.name.trim(), s.landmark?.trim() || null, s.morning || null, s.afternoon || null, s.fareZone.toUpperCase(), i + 1];
      if (s.id) await t.query(`update route_stop set name = $1, landmark = $2, morning_time = $3, afternoon_time = $4, fare_zone = $5, seq = $6, active = true where id = $7 and route_id = $8`, [...vals, s.id, routeId]);
      else await t.query(`insert into route_stop (name, landmark, morning_time, afternoon_time, fare_zone, seq, route_id) values ($1,$2,$3,$4,$5,$6,$7)`, [...vals, routeId]);
    }
    // Inactive stops keep their history but step out of the way of the order.
    await t.query(`update route_stop set seq = 61 - x.n from (select id, row_number() over (order by seq) as n from route_stop where route_id = $1 and not active) x where route_stop.id = x.id`, [routeId]);
    return { saved: stops.length };
  }, { actor: actor.label });
}

// ── Which child is on which stop ───────────────────────────────────────────────────────────

/** The monthly charge for one child over a period: each month the bus is used by the cut-off day, at the fare of the stop used then. */
export async function chargeFor(t: Db, enrolmentId: string, start: string, end: string) {
  const e = await t.one<{ school_id: string; student_id: string }>('select school_id, student_id from enrolment where id = $1', [enrolmentId]);
  const cut = await settings.get<number>(t, e.school_id, 'transport.month_charged_if_used_by');
  const months: { month: string; zone: string; fare: number }[] = [];
  for (let m = start.slice(0, 8) + '01'; m < end; m = addDays(m, 32).slice(0, 8) + '01') {
    const by = `${m.slice(0, 8)}${String(cut).padStart(2, '0')}`;
    const a = await t.maybeOne<{ zone: string; fare: number }>(
      `select s.fare_zone as zone, f.monthly_paise::float as fare from transport_allocation a join route_stop s on s.id = coalesce(a.pickup_stop_id, a.drop_stop_id)
         join route r on r.id = s.route_id join transport_fare f on f.school_id = r.school_id and f.zone = s.fare_zone and f.valid @> $2::date
        where a.enrolment_id = $1 and a.valid && daterange($2::date, $3::date, '[]') order by lower(a.valid) limit 1`, [enrolmentId, m, by]);
    if (a) months.push({ month: m, ...a });
  }
  return { gross: months.reduce((s, x) => s + x.fare, 0), months };
}

/**
 * After a change of stop, a start or a stop, each instalment the school has already billed is put
 * right: the difference between what transport should cost for it now and what was billed is added
 * (or credited) on the same instalment, and the family is told. Nothing is typed in the fee screens.
 */
async function rebill(t: Db, enrolmentId: string, studentId: string, why: string) {
  const insts = await t.query<{ plan_id: string; code: string; label: string; start: string; end: string; version_id: string; fee_band: string; billed: number }>(
    `select f.plan_id, f.installment_code as code, i.label, lower(i.period)::text as start, upper(i.period)::text as end, (array_agg(f.version_id order by f.created_at))[1] as version_id, (array_agg(f.fee_band))[1] as fee_band,
            coalesce(sum(f.net_paise) filter (where f.head_code = 'TRANSPORT'), 0)::float as billed
       from fee_demand f join fee_installment i on i.plan_id = f.plan_id and i.code = f.installment_code
      where f.enrolment_id = $1 and f.installment_code is not null and (f.kind = 'REGULAR' or f.head_code = 'TRANSPORT')
      group by f.plan_id, f.installment_code, i.label, i.period`, [enrolmentId]);
  const school = (await t.one<{ school_id: string }>('select school_id from enrolment where id = $1', [enrolmentId])).school_id;
  const changed: string[] = [];
  for (const i of insts) {
    const due = (await chargeFor(t, enrolmentId, i.start, i.end)).gross;
    const diff = Math.round(due - i.billed);
    if (!diff) continue;
    const d = await t.one<{ id: string }>(`insert into fee_demand (enrolment_id, plan_id, installment_code, head_code, version_id, kind, gross_paise, concession_paise, fee_band, snapshot)
       values ($1, $2, $3, 'TRANSPORT', $4, 'ADJUSTMENT', $5, 0, $6, $7) returning id`, [enrolmentId, i.plan_id, i.code, i.version_id, diff, i.fee_band, JSON.stringify({ why })]);
    await post(t, { schoolId: school, narration: `Transport ${diff > 0 ? 'added to' : 'taken off'} ${i.label}: ${why}`, sourceType: 'transport_fee', sourceId: d.id,
      lines: [signed('1200', diff, 'debit', studentId), signed('4130', diff, 'credit', studentId)] });
    changed.push(`${i.label} ${diff > 0 ? '+' : '−'}${rs(Math.abs(diff))}`);
  }
  if (changed.length) await notify.toParentsOf(t, [studentId], { kind: 'FEES', title: 'Transport fee updated', body: `${why}. ${changed.join(', ')}. See Fees in the app.`, link: '/fees' });
  return changed;
}

/** Puts a child's transport fee right from their allocation (a support repair). */
export async function rebillStudent(db: Db, actor: Actor, studentId: string) {
  const e = await db.maybeOne<{ id: string; school_id: string }>(`select id, school_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [studentId]);
  if (!e) throw notFound('A current enrolment for this child');
  await assertCan(db, actor, 'transport.manage', e.school_id);
  return db.tx((t) => rebill(t, e.id, studentId, 'Transport fee checked against the bus stop'), { actor: actor.label });
}

async function stopInfo(t: Db, stopId: string | null | undefined, schoolId: string) {
  if (!stopId) return null;
  const s = await t.maybeOne<{ id: string; name: string; route_id: string; code: string; seats: number | null; school_id: string }>(
    `select s.id, s.name, s.route_id, r.code, v.seats, r.school_id from route_stop s join route r on r.id = s.route_id left join vehicle v on v.id = r.vehicle_id where s.id = $1 and s.active and r.active`, [stopId]);
  if (!s || s.school_id !== schoolId) throw invalid('Choose a stop on one of this school’s routes.');
  return s;
}

/**
 * Puts a child on a stop from a date (ending the previous stop the day before), within the bus's
 * seats. The transport fee, the bus list and the parent app follow at once.
 */
export async function allocate(db: Db, actor: Actor, input: { studentId: string; pickupStopId?: string | null; dropStopId?: string | null; from: string }, inTx?: Db) {
  const q = inTx ?? db;
  const e = await q.maybeOne<{ id: string; school_id: string }>(`select id, school_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [input.studentId]);
  if (!e) throw notFound('A current enrolment for this child');
  await assertCan(q, actor, 'transport.manage', e.school_id);
  const run = async (t: Db) => {
    const p = await stopInfo(t, input.pickupStopId, e.school_id), d = await stopInfo(t, input.dropStopId, e.school_id);
    if (!p && !d) throw invalid('Choose the pick-up stop, the drop stop, or both.');
    for (const s of [p, d].filter(Boolean) as NonNullable<typeof p>[]) {
      const used = (await t.one<{ n: number }>(`select count(distinct a.student_id)::int as n from transport_allocation a join route_stop x on x.id in (a.pickup_stop_id, a.drop_stop_id)
         where x.route_id = $1 and a.valid @> $2::date and a.student_id <> $3`, [s.route_id, input.from, input.studentId])).n;
      if (s.seats !== null && used >= s.seats) throw conflict('full', `Route ${s.code} is full (${s.seats} seats). Choose another route or add a vehicle.`);
    }
    await t.query(`delete from transport_allocation where student_id = $1 and lower(valid) >= $2::date`, [input.studentId, input.from]);
    await t.query(`update transport_allocation set valid = daterange(lower(valid), $2::date) where student_id = $1 and valid @> $2::date`, [input.studentId, input.from]);
    await t.query(`insert into transport_allocation (enrolment_id, student_id, pickup_stop_id, drop_stop_id, valid, approved_by) values ($1, $2, $3, $4, daterange($5::date, null), $6)`,
      [e.id, input.studentId, p?.id ?? null, d?.id ?? null, input.from, actor.id]);
    const where = [p ? `picked up at ${p.name} (route ${p.code})` : null, d ? `dropped at ${d.name} (route ${d.code})` : null].filter(Boolean).join(', ');
    await notify.toParentsOf(t, [input.studentId], { kind: 'TRANSPORT', title: 'School bus', body: `From ${input.from}: ${where}. Times are in the app under My bus.`, link: '/bus' });
    return { fees: await rebill(t, e.id, input.studentId, `Bus from ${input.from}`) };
  };
  return inTx ? run(inTx) : db.tx(run, { actor: actor.label });
}

/** Takes a child off the bus from a date (the day before is their last day). */
export async function stopTransport(db: Db, actor: Actor, studentId: string, from: string, inTx?: Db) {
  const q = inTx ?? db;
  const e = await q.maybeOne<{ id: string; school_id: string }>(`select id, school_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [studentId]);
  if (!e) throw notFound('A current enrolment for this child');
  await assertCan(q, actor, 'transport.manage', e.school_id);
  const run = async (t: Db) => {
    const cur = await t.maybeOne<{ id: string; from: string }>(`select id, lower(valid)::text as from from transport_allocation where student_id = $1 and (upper_inf(valid) or upper(valid) > $2::date) order by lower(valid) limit 1`, [studentId, from]);
    if (!cur) throw invalid('This child is not on the bus from that date.');
    if (cur.from >= from) await t.query('delete from transport_allocation where id = $1', [cur.id]);
    else await t.query('update transport_allocation set valid = daterange(lower(valid), $2::date) where id = $1', [cur.id, from]);
    await notify.toParentsOf(t, [studentId], { kind: 'TRANSPORT', title: 'School bus stopped', body: `The last day on the bus is ${addDays(from, -1)}.`, link: '/bus' });
    return { fees: await rebill(t, e.id, studentId, `Bus stopped from ${from}`) };
  };
  return inTx ? run(inTx) : db.tx(run, { actor: actor.label });
}

/** A parent (for their own child) or the office asks to start, change or stop. The transport in-charge decides. */
export async function request(db: Db, actor: Actor, input: { studentId: string; kind: 'START' | 'CHANGE' | 'STOP'; pickupStopId?: string | null; dropStopId?: string | null; fromDate: string; note?: string }) {
  const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and status in ('ACTIVE', 'PROVISIONAL') and upper_inf(period)`, [input.studentId]);
  if (!e) throw notFound('A current enrolment for this child');
  if (actor.role === 'PARENT') await assertGuardianOf(db, actor, input.studentId); else await assertCan(db, actor, 'transport.manage', e.school_id);
  if (input.fromDate < localToday()) throw invalid('Choose today or a later date.');
  if (input.kind !== 'STOP') { await stopInfo(db, input.pickupStopId, e.school_id); await stopInfo(db, input.dropStopId, e.school_id); }
  if (await db.maybeOne(`select 1 from transport_request where student_id = $1 and status = 'PENDING'`, [input.studentId])) throw conflict('pending', 'A request for this child is already waiting.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into transport_request (school_id, student_id, kind, pickup_stop_id, drop_stop_id, from_date, note, requested_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [e.school_id, input.studentId, input.kind, input.kind === 'STOP' ? null : input.pickupStopId || null, input.kind === 'STOP' ? null : input.dropStopId || null, input.fromDate, input.note?.trim() ?? '', actor.id]);
    const desk = await t.query<{ id: string }>(`select distinct u.id from app_user u join org_unit o on o.id = $1 left join duty d on d.user_id = u.id and d.school_id = $1 and d.code = 'TRANSPORT_INCHARGE' and d.valid @> current_date
       where u.active and u.scope_path <@ o.path and (d.user_id is not null or u.role = 'SCHOOL_ADMIN')`, [e.school_id]);
    const name = (await t.one<{ name: string }>('select name from student where id = $1', [input.studentId])).name;
    await notify.toUsers(t, desk.map((d) => d.id), { kind: 'TRANSPORT', title: `Bus: ${input.kind === 'START' ? 'start' : input.kind === 'STOP' ? 'stop' : 'change'} for ${name}`, body: `From ${input.fromDate}. ${input.note ?? ''}`.trim(), link: '/transport' });
    return { id: r.id };
  }, { actor: actor.label });
}

export async function decideRequest(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  if (!UUID.test(id)) throw notFound('Request');
  const r = await db.maybeOne<{ school_id: string; student_id: string; kind: string; pickup_stop_id: string | null; drop_stop_id: string | null; from_date: string; status: string }>(
    'select school_id, student_id, kind, pickup_stop_id, drop_stop_id, from_date::text, status from transport_request where id = $1', [id]);
  if (!r) throw notFound('Request');
  await assertCan(db, actor, 'transport.manage', r.school_id);
  if (r.status !== 'PENDING') throw conflict('decided', 'Already decided.');
  if (!approve && (!note || note.trim().length < 3)) throw invalid('Give the reason, for the parent.');
  return db.tx(async (t) => {
    let fees: string[] = [];
    if (approve) {
      const from = r.from_date < localToday() ? localToday() : r.from_date;
      fees = (r.kind === 'STOP' ? await stopTransport(t, actor, r.student_id, from, t) : await allocate(t, actor, { studentId: r.student_id, pickupStopId: r.pickup_stop_id, dropStopId: r.drop_stop_id, from }, t)).fees;
    } else await notify.toParentsOf(t, [r.student_id], { kind: 'TRANSPORT', title: 'Bus request not accepted', body: note!.trim(), link: '/bus' });
    await t.query(`update transport_request set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note?.trim() || null]);
    return { status: approve ? 'APPROVED' : 'REJECTED', fees };
  }, { actor: actor.label });
}

/** The children on a route, stop by stop, for the attendant's list and the office. */
export async function roster(db: Db, actor: Actor, routeId: string, on = localToday()) {
  const r = await schoolOfRoute(db, routeId);
  if (![r.driver_user, r.attendant_user].includes(actor.id)) await assertCan(db, actor, 'transport.view', r.school_id);
  return db.query(
    `select s.id as stop_id, s.seq, s.name as stop, to_char(s.morning_time, 'HH24:MI') as morning, to_char(s.afternoon_time, 'HH24:MI') as afternoon,
            coalesce((select jsonb_agg(jsonb_build_object('studentId', st.id, 'name', st.name, 'class', e.class_code || coalesce('-' || sec.name, ''), 'pickup', a.pickup_stop_id = s.id, 'drop', a.drop_stop_id = s.id,
               'parentPhone', (select g.phone from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id = st.id order by sg.is_primary desc limit 1)) order by st.name)
               from transport_allocation a join student st on st.id = a.student_id join enrolment e on e.id = a.enrolment_id left join section sec on sec.id = e.section_id
              where (a.pickup_stop_id = s.id or a.drop_stop_id = s.id) and a.valid @> $2::date), '[]') as children
       from route_stop s where s.route_id = $1 and s.active order by s.seq`, [routeId, on]);
}

// ── The day: trips, timings, boarding ──────────────────────────────────────────────────────

async function stopsInOrder(t: Db, routeId: string, leg: Leg) {
  const rows = await t.query<{ id: string; seq: number; name: string; time: string | null; lat: number | null; lng: number | null }>(
    `select id, seq, name, to_char(${leg === 'MORNING' ? 'morning_time' : 'afternoon_time'}, 'HH24:MI') as time, lat::float, lng::float from route_stop where route_id = $1 and active order by seq`, [routeId]);
  return leg === 'MORNING' ? rows : [...rows].reverse();
}

async function tripRow(t: Db, routeId: string, date: string, leg: Leg) {
  return (await t.maybeOne<{ id: string; status: string; delay_min: number; alerted_min: number; last_stop_seq: number | null }>(
    'select id, status, delay_min, alerted_min, last_stop_seq from trip where route_id = $1 and on_date = $2 and leg = $3', [routeId, date, leg]))
    ?? await t.one<{ id: string; status: string; delay_min: number; alerted_min: number; last_stop_seq: number | null }>(
      `insert into trip (route_id, on_date, leg) values ($1, $2, $3) on conflict (route_id, on_date, leg) do update set leg = excluded.leg returning id, status, delay_min, alerted_min, last_stop_seq`, [routeId, date, leg]);
}

/** Expected time at each stop today: the timetable, moved by how late the bus is running. */
function withEta(stops: { id: string; seq: number; name: string; time: string | null }[], trip: { status: string; delay_min: number; last_stop_seq: number | null } | null, leg: Leg) {
  const passedIdx = trip?.last_stop_seq ? stops.findIndex((s) => s.seq === trip.last_stop_seq) : -1;
  return stops.map((s, i) => ({ ...s, passed: i <= passedIdx && passedIdx >= 0, eta: s.time && trip && trip.status !== 'CANCELLED' ? hhmm(toMin(s.time)! + (i > passedIdx ? trip.delay_min : 0)) : s.time, leg }));
}

export type Tracking = 'TIMES' | 'TAPS' | 'PHONE' | 'DEVICE';
export const TRACKING: Record<Tracking, string> = {
  TIMES: 'Stop times only (nothing tracked)',
  TAPS: 'Stop times, moved by the attendant’s taps',
  PHONE: 'The attendant’s phone tracks the bus',
  DEVICE: 'A tracker fitted in the vehicle',
};
const NEAR_M = 150;                                     // within this distance of a stop, the bus is at it
const metres = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6371000, toR = Math.PI / 180, dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const legNow = (): Leg => (nowMin() < 12 * 60 ? 'MORNING' : 'AFTERNOON');

type TripState = { id: string; status: string; delay_min: number; alerted_min: number; last_stop_seq: number | null };
type Stop = { id: string; seq: number; name: string; time: string | null; lat: number | null; lng: number | null };

/**
 * Moves today's run on (started, at a stop, late, finished, not running) and tells the parents at
 * the stops still to come: their own revised time when the bus is late, or that it is not running.
 * The same for a tap, the attendant's phone, or a fitted tracker.
 */
async function progress(t: Db, r: { school_id: string; code: string }, trip: TripState, stops: Stop[], leg: Leg, change: { status: string; delay: number; last: number | null; kind: string; note?: string }) {
  const date = localToday();
  const idx = change.last ? stops.findIndex((s) => s.seq === change.last) : -1;
  const ahead = stops.slice(idx + 1);
  const col = leg === 'MORNING' ? 'pickup_stop_id' : 'drop_stop_id';
  const waiting = async (stopIds: string[]) => (await t.query<{ student_id: string }>(
    `select student_id from transport_allocation where ${col} = any($1::uuid[]) and valid @> $2::date`, [stopIds, date])).map((k) => k.student_id);
  let alerted = trip.alerted_min;
  const threshold = await settings.get<number>(t, r.school_id, 'transport.delay_alert_min');
  if (['CANCELLED', 'BREAKDOWN'].includes(change.kind)) {
    await notify.toParentsOf(t, await waiting(ahead.map((s) => s.id)), { kind: 'TRANSPORT', title: change.kind === 'CANCELLED' ? `Bus ${r.code} is not running ${leg === 'MORNING' ? 'this morning' : 'this afternoon'}` : `Bus ${r.code} has broken down`,
      body: change.note?.trim() || (change.kind === 'BREAKDOWN' ? 'The school is arranging another vehicle; you will be told the new time.' : 'Please make other arrangements today.'), link: '/bus' });
  } else if (change.status !== 'DONE' && change.delay >= threshold && change.delay - alerted >= 5) {
    for (const s of ahead) {
      if (!s.time) continue;
      const kids = await waiting([s.id]);
      if (kids.length) await notify.toParentsOf(t, kids, { kind: 'TRANSPORT', title: `Bus ${r.code} is running ${change.delay} minutes late`,
        body: `Expected at ${s.name} at about ${hhmm(toMin(s.time)! + change.delay)} instead of ${s.time}.${change.note ? ` ${change.note.trim()}` : ''}`, link: '/bus' });
    }
    alerted = change.delay;
  }
  await t.query(`update trip set status = $2, delay_min = $3, last_stop_seq = $4, alerted_min = $5, note = coalesce($6, note) where id = $1`, [trip.id, change.status, change.delay, change.last, alerted, change.note?.trim() || null]);
  return { status: change.status, delayMin: change.delay, stops: withEta(stops, { status: change.status, delay_min: change.delay, last_stop_seq: change.last }, leg) };
}

/**
 * Something happened on today's run, tapped by the attendant (or the office): the bus started,
 * reached a stop, is running late, reached school or the last stop, broke down or did not run.
 * On a "stop times only" route nothing is tapped, but the office can still say a run is not running.
 * Tapping "at this stop" with the phone's location also teaches the route where the stop is.
 */
export async function tripEvent(db: Db, actor: Actor, routeId: string, input: { leg: Leg; kind: 'STARTED' | 'AT_STOP' | 'DELAY' | 'REACHED' | 'CANCELLED' | 'BREAKDOWN'; stopId?: string | null; minutes?: number; note?: string; atTime?: string; lat?: number; lng?: number }) {
  const r = await schoolOfRoute(db, routeId);
  if (![r.driver_user, r.attendant_user].includes(actor.id)) await assertCan(db, actor, 'transport.manage', r.school_id);
  if (r.tracking === 'TIMES' && !['CANCELLED', 'BREAKDOWN'].includes(input.kind)) throw invalid('This route shows stop times only; nothing is tracked.');
  const at = input.atTime ? toMin(input.atTime)! : nowMin();
  if (input.atTime && at > nowMin() + 1) throw invalid('That time has not come yet.');
  return db.tx(async (t) => {
    const trip = await tripRow(t, routeId, localToday(), input.leg);
    if (['DONE', 'CANCELLED'].includes(trip.status) && input.kind !== 'BREAKDOWN') throw conflict('over', 'Today’s run is already finished.');
    const stops = await stopsInOrder(t, routeId, input.leg);
    let delay = trip.delay_min, last = trip.last_stop_seq, status = trip.status;
    if (input.kind === 'STARTED') { status = 'RUNNING'; const first = stops.find((s) => s.time); if (first) delay = Math.max(0, at - toMin(first.time)!); }
    if (input.kind === 'AT_STOP') {
      const s = stops.find((x) => x.id === input.stopId);
      if (!s) throw invalid('Choose a stop on this route.');
      status = 'RUNNING'; last = s.seq;
      if (s.time) delay = Math.max(0, at - toMin(s.time)!);
      if (input.lat !== undefined && input.lng !== undefined && s.lat === null) await t.query('update route_stop set lat = $2, lng = $3 where id = $1', [s.id, input.lat, input.lng]);
    }
    if (input.kind === 'DELAY') { if (!input.minutes || input.minutes < 1 || input.minutes > 240) throw invalid('Say how many minutes late.'); delay = input.minutes; status = status === 'SCHEDULED' ? 'RUNNING' : status; }
    if (input.kind === 'REACHED') status = 'DONE';
    if (input.kind === 'CANCELLED') status = 'CANCELLED';
    await t.query(`insert into trip_event (trip_id, kind, stop_id, minutes, note, lat, lng, by_user) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [trip.id, input.kind, input.stopId ?? null, input.kind === 'DELAY' ? input.minutes : delay, input.note?.trim() || null, input.lat ?? null, input.lng ?? null, actor.id]);
    return progress(t, r, trip, stops, input.leg, { status, delay, last, kind: input.kind, note: input.note });
  }, { actor: actor.label });
}

/** The attendant marks children as they get on (morning) or off (afternoon); parents are told. */
export async function board(db: Db, actor: Actor, routeId: string, input: { leg: Leg; entries: { studentId: string; status: 'BOARDED' | 'DROPPED' | 'NOT_BOARDED' | 'HANDED_TO_PARENT' }[] }) {
  const r = await schoolOfRoute(db, routeId);
  if (![r.driver_user, r.attendant_user].includes(actor.id)) await assertCan(db, actor, 'transport.manage', r.school_id);
  const date = localToday();
  return db.tx(async (t) => {
    const trip = await tripRow(t, routeId, date, input.leg);
    const col = input.leg === 'MORNING' ? 'pickup_stop_id' : 'drop_stop_id';
    const on = new Set((await t.query<{ student_id: string }>(`select a.student_id from transport_allocation a join route_stop s on s.id = a.${col} where s.route_id = $1 and a.valid @> $2::date`, [routeId, date])).map((x) => x.student_id));
    const time = hhmm(nowMin());
    for (const e of input.entries) {
      if (!on.has(e.studentId)) throw invalid('A child in the list is not on this bus today.');
      await t.query(`insert into boarding (trip_id, student_id, status, marked_by) values ($1, $2, $3, $4) on conflict (trip_id, student_id) do update set status = excluded.status, at = now(), marked_by = excluded.marked_by`, [trip.id, e.studentId, e.status, actor.id]);
      const msg = { BOARDED: `got on bus ${r.code} at ${time}`, DROPPED: `got off bus ${r.code} at ${time}`, HANDED_TO_PARENT: `was handed over at the stop at ${time}`, NOT_BOARDED: `did not get on bus ${r.code} today` }[e.status];
      const name = (await t.one<{ name: string }>('select name from student where id = $1', [e.studentId])).name;
      await notify.toParentsOf(t, [e.studentId], { kind: 'TRANSPORT', title: `${name.split(' ')[0]} ${msg}`, body: '', link: '/bus' });
    }
    if (trip.status === 'SCHEDULED') await t.query(`update trip set status = 'RUNNING' where id = $1`, [trip.id]);
    return { marked: input.entries.length };
  }, { actor: actor.label });
}

/**
 * A position, from the attendant's phone (PHONE) or the vehicle's tracker (DEVICE). The run starts
 * by itself with the first position; when the bus comes within 150 m of the next stop it is marked as
 * there, the delay is worked out against the stop time, and late-running parents are told.
 */
async function recordPosition(t: Db, routeId: string, leg: Leg, lat: number, lng: number, by: string | null) {
  const r = await t.one<{ school_id: string; code: string }>('select school_id, code from route where id = $1', [routeId]);
  const trip = await tripRow(t, routeId, localToday(), leg);
  if (['DONE', 'CANCELLED'].includes(trip.status)) return { status: trip.status };
  await t.query(`insert into trip_event (trip_id, kind, lat, lng, by_user) values ($1, 'POSITION', $2, $3, $4)`, [trip.id, lat, lng, by]);
  const stops = await stopsInOrder(t, routeId, leg);
  const idx = trip.last_stop_seq ? stops.findIndex((s) => s.seq === trip.last_stop_seq) : -1;
  // The nearest of the next few stops still to come, if the bus is at it (stops can be skipped when nobody waits).
  const near = stops.slice(idx + 1, idx + 4).find((s) => s.lat !== null && s.lng !== null && metres(lat, lng, s.lat, s.lng) <= NEAR_M);
  if (!near) {
    if (trip.status === 'SCHEDULED') await t.query(`update trip set status = 'RUNNING' where id = $1`, [trip.id]);
    return { status: 'RUNNING', at: null };
  }
  const delay = near.time ? Math.max(0, nowMin() - toMin(near.time)!) : trip.delay_min;
  await t.query(`insert into trip_event (trip_id, kind, stop_id, minutes, lat, lng, by_user) values ($1, 'AUTO_AT_STOP', $2, $3, $4, $5, $6)`, [trip.id, near.id, delay, lat, lng, by]);
  const res = await progress(t, r, trip, stops, leg, { status: 'RUNNING', delay, last: near.seq, kind: 'AUTO_AT_STOP' });
  return { ...res, at: near.name };
}

/** PHONE mode: the attendant's phone sends its location every half minute while the run is on. */
export async function position(db: Db, actor: Actor, routeId: string, input: { leg: Leg; lat: number; lng: number }) {
  const r = await schoolOfRoute(db, routeId);
  if (r.tracking !== 'PHONE') throw invalid(r.tracking === 'DEVICE' ? 'This bus is tracked by its fitted tracker.' : 'This route runs on stop times; choose “The attendant’s phone tracks the bus” to share locations.');
  if (![r.driver_user, r.attendant_user].includes(actor.id)) await assertCan(db, actor, 'transport.manage', r.school_id);
  return db.tx((t) => recordPosition(t, routeId, input.leg, input.lat, input.lng, actor.id), { actor: actor.label });
}

/** DEVICE mode: a fitted tracker, identified by its secret token, sends its position. */
export async function devicePosition(db: Db, token: string | undefined, input: { lat: number; lng: number }) {
  if (!token || token.length < 20) throw forbidden('Tracker not recognised.');
  const v = await db.maybeOne<{ id: string }>('select id from vehicle where tracker_token = $1 and active', [token]);
  if (!v) throw forbidden('Tracker not recognised.');
  const routes = await db.query<{ id: string }>(`select id from route where vehicle_id = $1 and active and tracking = 'DEVICE'`, [v.id]);
  const out = [];
  for (const r of routes) out.push(await db.tx((t) => recordPosition(t, r.id, legNow(), input.lat, input.lng, null), { actor: `tracker ${v.id}` }));
  return { routes: out.length };
}

/** A new secret token for a vehicle's tracker (the old one stops working at once). Shown once, to give the tracker company. */
export async function trackerToken(db: Db, actor: Actor, vehicleId: string) {
  const v = await db.maybeOne<{ school_id: string }>('select school_id from vehicle where id = $1', [vehicleId]);
  if (!v) throw notFound('Vehicle');
  await assertCan(db, actor, 'transport.manage', v.school_id);
  const token = (await import('node:crypto')).randomBytes(24).toString('base64url');
  await db.tx((t) => t.query('update vehicle set tracker_token = $2 where id = $1', [vehicleId, token]), { actor: actor.label });
  return { token };
}

/** Every route's run today, for the office board. */
export async function today(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'transport.view', schoolId);
  const date = localToday();
  const routes = await db.query<{ id: string; code: string; name: string; reg_no: string | null; tracking: string }>(`select r.id, r.code, r.name, v.reg_no, r.tracking from route r left join vehicle v on v.id = r.vehicle_id where r.school_id = $1 and r.active order by r.code`, [schoolId]);
  const out = [];
  for (const r of routes) {
    const legs: Record<string, unknown> = {};
    for (const leg of ['MORNING', 'AFTERNOON'] as const) {
      const trip = await db.maybeOne<{ id: string; status: string; delay_min: number; last_stop_seq: number | null; note: string | null }>('select id, status, delay_min, last_stop_seq, note from trip where route_id = $1 and on_date = $2 and leg = $3', [r.id, date, leg]);
      const stops = await stopsInOrder(db, r.id, leg);
      const boarded = trip ? (await db.one<{ n: number }>(`select count(*)::int as n from boarding where trip_id = $1 and status in ('BOARDED', 'DROPPED', 'HANDED_TO_PARENT')`, [trip.id])).n : 0;
      const last = trip?.last_stop_seq ? stops.find((s) => s.seq === trip.last_stop_seq)?.name ?? null : null;
      legs[leg] = { status: trip?.status ?? 'SCHEDULED', delayMin: trip?.delay_min ?? 0, lastStop: last, note: trip?.note ?? null, boarded, first: stops[0]?.time ?? null, lastTime: stops.at(-1)?.time ?? null };
    }
    out.push({ ...r, legs });
  }
  return out;
}

/** The attendant's or driver's bus today: the stops in order with expected times, and the children at each. */
export async function myBus(db: Db, actor: Actor) {
  const routes = await db.query<{ id: string; code: string; name: string; tracking: string; reg_no: string | null; role: string }>(
    `select r.id, r.code, r.name, r.tracking, v.reg_no, c.role from route r join transport_crew c on c.id in (r.driver_id, r.attendant_id) left join vehicle v on v.id = r.vehicle_id
      where c.user_id = $1 and r.active and c.active order by r.code`, [actor.id]);
  const date = localToday();
  const out = [];
  for (const r of routes) {
    const legs: Record<string, unknown> = {};
    for (const leg of ['MORNING', 'AFTERNOON'] as const) {
      const trip = await db.maybeOne<{ id: string; status: string; delay_min: number; last_stop_seq: number | null }>('select id, status, delay_min, last_stop_seq from trip where route_id = $1 and on_date = $2 and leg = $3', [r.id, date, leg]);
      const marks = trip ? await db.query<{ student_id: string; status: string }>('select student_id, status from boarding where trip_id = $1', [trip.id]) : [];
      legs[leg] = { status: trip?.status ?? 'SCHEDULED', delayMin: trip?.delay_min ?? 0, stops: withEta(await stopsInOrder(db, r.id, leg), trip, leg), marks };
    }
    out.push({ ...r, roster: await roster(db, actor, r.id, date), legs });
  }
  return out;
}

/** The parent app's "My bus": the child's stop, today's times (moved if the bus is late), who is on board, and how to ask for a change. */
export async function forParent(db: Db, actor: Actor, studentId: string) {
  if (actor.role === 'PARENT') await assertGuardianOf(db, actor, studentId);
  else {
    const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and upper_inf(period) and status in ('ACTIVE', 'PROVISIONAL')`, [studentId]);
    if (!e) throw notFound('Student');
    await assertCan(db, actor, 'transport.view', e.school_id);
  }
  const date = localToday();
  const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and upper_inf(period) and status in ('ACTIVE', 'PROVISIONAL')`, [studentId]);
  if (!e) return { on: false, routes: [] };
  const a = await db.maybeOne<{ pickup: string | null; drop: string | null; from: string; to: string | null }>(
    `select pickup_stop_id as pickup, drop_stop_id as drop, lower(valid)::text as from, upper(valid)::text as to from transport_allocation where student_id = $1 and (upper_inf(valid) or upper(valid) > $2) order by lower(valid) limit 1`, [studentId, date]);
  const routes = await db.query(`select r.id, r.code, r.name, coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'morning', to_char(s.morning_time, 'HH24:MI'), 'afternoon', to_char(s.afternoon_time, 'HH24:MI'), 'zone', s.fare_zone) order by s.seq) from route_stop s where s.route_id = r.id and s.active), '[]') as stops
     from route r where r.school_id = $1 and r.active order by r.code`, [e.school_id]);
  const fares = await db.query(`select zone, name, monthly_paise::int as monthly_paise from transport_fare where school_id = $1 and valid @> $2::date order by zone`, [e.school_id, date]);
  const pending = await db.maybeOne(`select kind, from_date::text, status from transport_request where student_id = $1 and status = 'PENDING'`, [studentId]);
  if (!a) return { on: false, routes, fares, pending };
  const legs = [];
  for (const [leg, stopId] of [['MORNING', a.pickup], ['AFTERNOON', a.drop]] as const) {
    if (!stopId) continue;
    const s = await db.one<{ route_id: string; name: string; seq: number }>('select route_id, name, seq from route_stop where id = $1', [stopId]);
    const r = await db.one<{ code: string; name: string; tracking: string; reg_no: string | null; seats: number | null; attendant: string | null; attendant_phone: string | null; driver: string | null }>(
      `select r.code, r.name, r.tracking, v.reg_no, v.seats, coalesce(au.name, ac.name) as attendant, coalesce(au.phone, ac.phone) as attendant_phone, coalesce(du.name, dc.name) as driver
         from route r left join vehicle v on v.id = r.vehicle_id left join transport_crew ac on ac.id = r.attendant_id left join app_user au on au.id = ac.user_id
         left join transport_crew dc on dc.id = r.driver_id left join app_user du on du.id = dc.user_id where r.id = $1`, [s.route_id]);
    const trip = await db.maybeOne<{ id: string; status: string; delay_min: number; last_stop_seq: number | null; note: string | null }>('select id, status, delay_min, last_stop_seq, note from trip where route_id = $1 and on_date = $2 and leg = $3', [s.route_id, date, leg]);
    // "Stop times only": the parent sees the timetable (and a "not running" notice if the office sends one), nothing live.
    const live = r.tracking !== 'TIMES' || trip?.status === 'CANCELLED' ? trip : null;
    const stops = withEta(await stopsInOrder(db, s.route_id, leg), live, leg);
    const mine = stops.find((x) => x.id === stopId)!;
    const mark = trip ? await db.maybeOne<{ status: string; at: string }>('select status, at from boarding where trip_id = $1 and student_id = $2', [trip.id, studentId]) : null;
    const pos = trip && ['PHONE', 'DEVICE'].includes(r.tracking) ? await db.maybeOne<{ lat: number; lng: number; at: string }>(`select lat::float, lng::float, at from trip_event where trip_id = $1 and kind = 'POSITION' order by at desc limit 1`, [trip.id]) : null;
    const mineStop = (await stopsInOrder(db, s.route_id, leg)).find((x) => x.id === stopId)!;
    legs.push({ leg, stop: s.name, route: r, tracking: r.tracking, scheduled: mine.time, eta: mine.eta, passed: mine.passed, status: live?.status ?? 'SCHEDULED', delayMin: live?.delay_min ?? 0, note: live?.note ?? null, boarding: mark, position: pos,
      distanceM: pos && mineStop.lat !== null && mineStop.lng !== null ? Math.round(metres(pos.lat, pos.lng, mineStop.lat, mineStop.lng)) : null,
      stopsBefore: live ? stops.slice(0, stops.findIndex((x) => x.id === stopId)).map((x) => ({ name: x.name, eta: x.eta, passed: x.passed })) : [] });
  }
  return { on: true, from: a.from, to: a.to, legs, routes, fares, pending };
}

export { hhmm, toMin };
