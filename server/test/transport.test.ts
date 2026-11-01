import { beforeAll, describe, expect, it } from 'vitest';
import * as transport from '../src/modules/transport.js';
import * as fees from '../src/modules/fees.js';
import * as staff from '../src/modules/staff.js';
import * as duties from '../src/modules/duties.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, YEAR, type World } from './helpers.js';
import { addDays, localToday } from '../src/lib/dates.js';

/**
 * Transport without GPS: stops with morning and afternoon times; the attendant's taps move the
 * expected times and tell the parents further along. The child's stop decides the transport fee.
 */

let w: World;
let attendant: Actor, incharge: Actor;
let route: string, van: string;
let stops: { id: string; name: string }[];
type Fam = Awaited<ReturnType<typeof family>>;
let kid: Fam, kid2: Fam;
const T = localToday();

const owed = async (enrolmentId: string, bill: string, head = 'TRANSPORT') =>
  (await w.db.one<{ n: number }>(`select coalesce(sum(net_paise), 0)::int as n from fee_demand where enrolment_id = $1 and bill = $2 and head_code = $3`, [enrolmentId, bill, head])).n;
const notes = async (studentId: string, like: string) =>
  (await w.db.one<{ n: number }>(`select count(*)::int as n from notification where student_id = $1 and kind = 'TRANSPORT' and title like $2`, [studentId, like])).n;

beforeAll(async () => {
  w = await makeWorld();
  const a = await staff.enrol(w.db, w.principalA, w.schoolA, { name: 'Sunil Attendant', title: 'Bus attendant', category: 'NON_TEACHING', employment: 'DAILY_WAGE', joinedService: '2026-04-01', orderRef: 'T/1' });
  attendant = await loadActor(w.db, a.userId);
  await duties.assign(w.db, w.principalA, w.schoolA, { userId: w.teacherA.id, code: 'TRANSPORT_INCHARGE', from: T });
  incharge = await loadActor(w.db, w.teacherA.id);
});

describe('setting up the school’s transport', () => {
  it('keeps fares by zone, vehicles with their papers, crew and routes with stop times', async () => {
    await transport.setFare(w.db, w.principalA, w.schoolA, { zone: 'A', name: 'Up to 5 km', monthlyPaise: 120000, from: '2026-04-01' });
    await transport.setFare(w.db, w.principalA, w.schoolA, { zone: 'B', name: '5 to 10 km', monthlyPaise: 180000, from: '2026-04-01' });
    van = (await transport.saveVehicle(w.db, w.principalA, w.schoolA, { regNo: 'MH 01 AB 1234', kind: 'VAN', seats: 4, owner: 'CONTRACTOR', contractor: 'Sai Travels',
      fitnessUntil: addDays(T, 200), insuranceUntil: addDays(T, -3), permitUntil: addDays(T, 20), pucUntil: addDays(T, 90) })).id;
    const driver = (await transport.saveCrew(w.db, w.principalA, w.schoolA, { name: 'Ramesh Driver', phone: '9820011111', role: 'DRIVER', licenceNo: 'MH01 20110012345', licenceUntil: addDays(T, 400), policeVerifiedOn: '2026-03-01' })).id;
    const att = (await transport.saveCrew(w.db, w.principalA, w.schoolA, { userId: attendant.id, role: 'ATTENDANT', policeVerifiedOn: '2026-03-01' })).id;   // school staff: details from the staff record
    route = (await transport.saveRoute(w.db, incharge, w.schoolA, { code: 'R1', name: 'Colaba – Cuffe Parade', vehicleId: van, driverId: driver, attendantId: att })).id;
    await rejects(transport.saveStops(w.db, incharge, route, [{ name: 'A', morning: '07:30', fareZone: 'A' }, { name: 'B', morning: '07:10', fareZone: 'A' }]), /get later/);
    await rejects(transport.saveStops(w.db, incharge, route, [{ name: 'A', morning: '07:00', fareZone: 'Z' }]), /no fare/);
    await transport.saveStops(w.db, incharge, route, [
      { name: 'Cuffe Parade', landmark: 'World Trade Centre gate', morning: '07:00', afternoon: '14:30', fareZone: 'B' },
      { name: 'Badhwar Park', morning: '07:15', afternoon: '14:15', fareZone: 'A' },
      { name: 'Sassoon Dock', morning: '07:30', afternoon: '14:00', fareZone: 'A' }]);
    await rejects(transport.saveRoute(w.db, w.teacherA.id === incharge.id ? attendant : attendant, w.schoolA, { code: 'R2', name: 'x' }), /not part of your role/);
    const o = await transport.overview(w.db, incharge, w.schoolA) as unknown as { routes: { stops: { id: string; name: string }[]; driver: string; attendant: string }[]; alerts: { level: string; message: string }[] };
    stops = o.routes[0].stops;
    expect(o.routes[0]).toMatchObject({ driver: 'Ramesh Driver', attendant: 'Sunil Attendant' });
    expect(o.alerts.some((a) => a.level === 'ERROR' && /insurance expired/.test(a.message))).toBe(true);
    expect(o.alerts.some((a) => a.level === 'WARNING' && /permit expires/.test(a.message))).toBe(true);
  });
});

describe('a child’s stop decides the fee', () => {
  it('bills each month used at the stop’s fare, and puts already-billed quarters right on a start or stop', async () => {
    kid = await family(w, { classCode: 'VIII' });
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q3');
    expect(await owed(kid.enrolmentId, 'Q3')).toBe(0);
    await rejects(transport.allocate(w.db, w.teacherA.id === incharge.id ? attendant : w.teacherA, { studentId: kid.studentId, pickupStopId: stops[1].id, dropStopId: stops[1].id, from: '2026-10-01' }), /not part of your role/);
    const r = await transport.allocate(w.db, incharge, { studentId: kid.studentId, pickupStopId: stops[1].id, dropStopId: stops[1].id, from: '2026-10-01' });
    expect(r.fees).toHaveLength(1);
    expect(await owed(kid.enrolmentId, 'Q3')).toBe(3 * 120000);                      // October, November, December at zone A
    // Off the bus from 20 November: November is charged (used by the 15th), December is not.
    await transport.stopTransport(w.db, incharge, kid.studentId, '2026-11-20');
    expect(await owed(kid.enrolmentId, 'Q3')).toBe(2 * 120000);
    await fees.generateDemands(w.db, w.finance, w.schoolA, YEAR, 'Q4');
    expect(await owed(kid.enrolmentId, 'Q4')).toBe(0);
    // Back on, at the farther stop, from January: the new quarter is priced from the allocation when it is raised.
    await transport.allocate(w.db, incharge, { studentId: kid.studentId, pickupStopId: stops[0].id, dropStopId: stops[0].id, from: '2027-01-01' });
    expect(await owed(kid.enrolmentId, 'Q4')).toBe(3 * 180000);
    const bal = await w.db.one<{ d: string; c: string }>('select sum(debit_paise)::text as d, sum(credit_paise)::text as c from journal_line');
    expect(bal.d).toBe(bal.c);
  });

  it('takes a parent’s request to the transport in-charge, and keeps within the seats', async () => {
    kid2 = await family(w, { classCode: 'VIII' });
    await transport.request(w.db, kid2.parent, { studentId: kid2.studentId, kind: 'START', pickupStopId: stops[2].id, dropStopId: stops[2].id, fromDate: T, note: 'We have moved to Sassoon Dock' });
    await rejects(transport.request(w.db, kid2.parent, { studentId: kid2.studentId, kind: 'START', pickupStopId: stops[2].id, fromDate: T }), /already waiting/);
    await rejects(transport.request(w.db, kid.parent, { studentId: kid2.studentId, kind: 'STOP', fromDate: T }), /./);           // not their child
    const pending = (await transport.overview(w.db, incharge, w.schoolA) as unknown as { requests: { id: string; student_id: string }[] }).requests;
    await transport.decideRequest(w.db, incharge, pending.find((p) => p.student_id === kid2.studentId)!.id, true);
    expect((await transport.forParent(w.db, kid2.parent, kid2.studentId) as { on: boolean }).on).toBe(true);
    // The van has 4 seats.
    const more = [await family(w, { classCode: 'VIII' }), await family(w, { classCode: 'VIII' }), await family(w, { classCode: 'VIII' })];
    for (const f of more.slice(0, 2)) await transport.allocate(w.db, incharge, { studentId: f.studentId, pickupStopId: stops[2].id, from: T });
    await rejects(transport.allocate(w.db, incharge, { studentId: more[2].studentId, pickupStopId: stops[2].id, from: T }), /full \(4 seats\)/);
  });
});

describe('the day, without GPS', () => {
  it('moves the expected times when the bus is late, and tells only the parents still waiting', async () => {
    const before = await notes(kid2.studentId, '%late%');
    await rejects(transport.tripEvent(w.db, kid2.parent, route, { leg: 'MORNING', kind: 'DELAY', minutes: 15 }), /./);
    const r = await transport.tripEvent(w.db, attendant, route, { leg: 'MORNING', kind: 'DELAY', minutes: 15, note: 'Traffic at Colaba Causeway' });
    expect(r.delayMin).toBe(15);
    expect(r.stops.find((s) => s.name === 'Sassoon Dock')!.eta).toBe('07:45');
    expect(await notes(kid2.studentId, '%15 minutes late%')).toBe(before + 1);
    // A small change does not send another message.
    await transport.tripEvent(w.db, attendant, route, { leg: 'MORNING', kind: 'DELAY', minutes: 17 });
    expect(await notes(kid2.studentId, '%late%')).toBe(before + 1);
    // The bus reaches the second stop: the parent at the third sees it has passed.
    await transport.tripEvent(w.db, attendant, route, { leg: 'MORNING', kind: 'AT_STOP', stopId: stops[1].id });
    const my = await transport.forParent(w.db, kid2.parent, kid2.studentId) as unknown as { legs: { leg: string; status: string; stopsBefore: { name: string; passed: boolean }[]; route: { attendant: string; reg_no: string } }[] };
    const m = my.legs.find((l) => l.leg === 'MORNING')!;
    expect(m.status).toBe('RUNNING');
    expect(m.stopsBefore.map((s) => s.passed)).toEqual([true, true]);
    expect(m.route).toMatchObject({ attendant: 'Sunil Attendant', reg_no: 'MH 01 AB 1234' });
  });

  it('records who got on, tells the parent, and tells everyone when a run is cancelled', async () => {
    await transport.board(w.db, attendant, route, { leg: 'MORNING', entries: [{ studentId: kid2.studentId, status: 'BOARDED' }] });
    expect(await notes(kid2.studentId, '%got on bus R1%')).toBe(1);
    const outsider = await family(w, { classCode: 'VIII' });
    await rejects(transport.board(w.db, attendant, route, { leg: 'MORNING', entries: [{ studentId: outsider.studentId, status: 'BOARDED' }] }), /not on this bus today/);
    const mine = await transport.myBus(w.db, attendant) as unknown as { code: string; roster: { stop: string; children: unknown[] }[] }[];
    expect(mine[0].code).toBe('R1');
    expect(mine[0].roster.find((s) => s.stop === 'Sassoon Dock')!.children.length).toBe(3);
    expect(mine[0].roster.find((s) => s.stop === 'Badhwar Park')!.children.length).toBe(1);
    await transport.tripEvent(w.db, attendant, route, { leg: 'AFTERNOON', kind: 'CANCELLED', note: 'Van being repaired; please collect your child at 14:00.' });
    expect(await notes(kid2.studentId, '%not running this afternoon%')).toBe(1);
  });

  it('shares positions only when the route is switched to GPS', async () => {
    await rejects(transport.position(w.db, attendant, route, { leg: 'MORNING', lat: 18.91, lng: 72.82 }), /stop times/);
    await transport.saveRoute(w.db, incharge, w.schoolA, { id: route, code: 'R1', name: 'Colaba – Cuffe Parade', vehicleId: van, tracking: 'PHONE',
      driverId: (await w.db.one<{ id: string }>(`select driver_id as id from route where id = $1`, [route])).id, attendantId: (await w.db.one<{ id: string }>(`select attendant_id as id from route where id = $1`, [route])).id });
    await transport.position(w.db, attendant, route, { leg: 'MORNING', lat: 18.9101, lng: 72.8205 });
    const my = await transport.forParent(w.db, kid2.parent, kid2.studentId) as unknown as { legs: { leg: string; position: { lat: number } | null }[] };
    expect(my.legs.find((l) => l.leg === 'MORNING')!.position?.lat).toBeCloseTo(18.9101);
  });
});

describe('four ways to follow a bus', () => {
  it('“stop times only”: nothing to tap, parents see the timetable; the office can still say a run is off', async () => {
    const r2 = (await transport.saveRoute(w.db, incharge, w.schoolA, { code: 'R2', name: 'Times only', tracking: 'TIMES', attendantId: (await w.db.one<{ id: string }>(`select attendant_id as id from route where id = $1`, [route])).id })).id;
    await transport.saveStops(w.db, incharge, r2, [{ name: 'Navy Nagar', morning: '07:10', afternoon: '14:20', fareZone: 'A' }]);
    const stop = (await w.db.one<{ id: string }>('select id from route_stop where route_id = $1', [r2])).id;
    const f = await family(w, { classCode: 'VIII' });
    await transport.allocate(w.db, incharge, { studentId: f.studentId, pickupStopId: stop, dropStopId: stop, from: T });
    await rejects(transport.tripEvent(w.db, attendant, r2, { leg: 'MORNING', kind: 'DELAY', minutes: 15 }), /stop times only/);
    await rejects(transport.position(w.db, attendant, r2, { leg: 'MORNING', lat: 18.9, lng: 72.8 }), /stop times/);
    const my = await transport.forParent(w.db, f.parent, f.studentId) as unknown as { legs: { tracking: string; scheduled: string; eta: string; status: string }[] };
    expect(my.legs[0]).toMatchObject({ tracking: 'TIMES', scheduled: '07:10', eta: '07:10', status: 'SCHEDULED' });
    await transport.tripEvent(w.db, incharge, r2, { leg: 'AFTERNOON', kind: 'CANCELLED', note: 'Holiday for the Navy Week parade' });
    expect(await notes(f.studentId, '%not running%')).toBe(1);
  });

  it('“the attendant’s phone”: learns where each stop is, then notices the bus there by itself', async () => {
    // R1 is on the phone (switched in the test above). Tapping "at this stop" with location on teaches the route where the stop is.
    await transport.tripEvent(w.db, attendant, route, { leg: 'MORNING', kind: 'AT_STOP', stopId: stops[1].id, lat: 18.9067, lng: 72.8147 });
    expect((await w.db.one<{ lat: number }>('select lat::float from route_stop where id = $1', [stops[1].id])).lat).toBeCloseTo(18.9067);
    const before = await w.db.one<{ seq: number | null }>(`select last_stop_seq as seq from trip where route_id = $1 and on_date = $2 and leg = 'MORNING'`, [route, T]);
    expect(before.seq).toBe(2);
    // Sassoon Dock's place is known (set by the office). Far from it: just a position. Within 150 m: marked there by itself.
    await w.db.query('update route_stop set lat = $2, lng = $3 where id = $1', [stops[2].id, 18.9122, 72.8302]);
    const far = await transport.position(w.db, attendant, route, { leg: 'MORNING', lat: 18.95, lng: 72.84 }) as { at: string | null };
    expect(far.at).toBeNull();
    const near = await transport.position(w.db, attendant, route, { leg: 'MORNING', lat: 18.9125, lng: 72.8300 }) as { at: string | null };
    expect(near.at).toBe('Sassoon Dock');
    expect((await w.db.one<{ seq: number }>(`select last_stop_seq as seq from trip where route_id = $1 and on_date = $2 and leg = 'MORNING'`, [route, T])).seq).toBe(3);
    const my = await transport.forParent(w.db, kid2.parent, kid2.studentId) as unknown as { legs: { leg: string; distanceM: number | null }[] };
    expect(my.legs.find((l) => l.leg === 'MORNING')!.distanceM).toBeLessThan(150);
  });

  it('“a fitted tracker”: sends positions with its own secret token', async () => {
    await transport.saveRoute(w.db, incharge, w.schoolA, { id: route, code: 'R1', name: 'Colaba – Cuffe Parade', vehicleId: van, tracking: 'DEVICE',
      driverId: (await w.db.one<{ id: string }>(`select driver_id as id from route where id = $1`, [route])).id, attendantId: (await w.db.one<{ id: string }>(`select attendant_id as id from route where id = $1`, [route])).id });
    await rejects(transport.position(w.db, attendant, route, { leg: 'MORNING', lat: 18.9, lng: 72.8 }), /fitted tracker/);
    const { token } = await transport.trackerToken(w.db, incharge, van);
    await rejects(transport.devicePosition(w.db, 'x'.repeat(30), { lat: 18.9, lng: 72.8 }), /not recognised/);
    expect((await transport.devicePosition(w.db, token, { lat: 18.93, lng: 72.83 })).routes).toBe(1);
  });
});
