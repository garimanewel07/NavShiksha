import { beforeAll, describe, expect, it } from 'vitest';
import * as health from '../src/modules/health.js';
import * as gate from '../src/modules/gate.js';
import * as stores from '../src/modules/stores.js';
import * as alumni from '../src/modules/alumni.js';
import { trialBalance } from '../src/modules/ledger.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';

/**
 * Campus operations: health records and the infirmary, incidents and drills, the gate (visitors,
 * who may collect a child, gate passes), stores and assets (with the books), and alumni.
 */

let w: World;
let nurse: Actor, guardA: Actor, keeper: Actor, safety: Actor, otherTeacher: Actor;
type Fam = Awaited<ReturnType<typeof family>>;
let kid: Fam;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

async function staffWithDuty(name: string, role: string, duty: string | null) {
  const u = await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, 'nes.wnc.ncs_a') returning id`, [name, role]);
  if (duty) await w.db.query(`insert into duty (school_id, user_id, code, valid, assigned_by) values ($1, $2, $3, daterange(current_date, null), $4)`, [w.schoolA, u.id, duty, w.principalA.id]);
  return loadActor(w.db, u.id);
}
const notes = (userId: string) => w.db.query<{ kind: string; title: string; body: string }>('select kind, title, body from notification where user_id = $1 order by created_at', [userId]);

beforeAll(async () => {
  w = await makeWorld();
  nurse = await staffWithDuty('Sister Mary', 'STAFF', 'NURSE');
  guardA = await staffWithDuty('Guard Ram Singh', 'STAFF', 'GATE_SECURITY');
  keeper = await staffWithDuty('Store Keeper Iqbal', 'STAFF', 'STORE_KEEPER');
  safety = await staffWithDuty('Safety Officer Rao', 'TEACHER', 'SAFETY_OFFICER');
  otherTeacher = await staffWithDuty('Teacher Bravo', 'TEACHER', null);
  kid = await family(w, { classCode: 'X' });          // X-A, whose class teacher is Teacher Alpha
});

describe('health', () => {
  it('lets the parent keep the health record; the class teacher sees the alert; others do not', async () => {
    await health.update(w.db, kid.parent, kid.studentId, { allergies: 'Peanuts (severe)', medication: 'EpiPen in the school bag', alert: 'Severe peanut allergy: EpiPen in bag' });
    const alerts = await health.classAlerts(w.db, w.teacherA, w.sectionsA.X[0]) as { alert: string }[];
    expect(alerts[0].alert).toMatch(/peanut/);
    await rejects(health.classAlerts(w.db, otherTeacher, w.sectionsA.X[0]), /class’s teachers/);
    await rejects(health.update(w.db, otherTeacher, kid.studentId, { alert: 'x' }), /not part of your role/);
    const other = await family(w, { classCode: 'X' });
    await rejects(health.record(w.db, other.parent, kid.studentId), /./);
  });

  it('records an infirmary visit, takes the medicine from stock, and tells the parent', async () => {
    const pcm = await stores.saveItem(w.db, w.principalA, w.schoolA, { code: 'PCM500', name: 'Paracetamol 500 mg', category: 'MEDICINE', kind: 'CONSUMABLE', unit: 'tablets', reorderLevel: 20, trackExpiry: true });
    await stores.adjust(w.db, keeper, w.schoolA, { itemId: pcm.id, kind: 'OPENING', qty: 30, batch: 'B1', expiry: '2027-03-31', note: 'Opening stock' });
    const v = await health.recordVisit(w.db, nurse, w.schoolA, { studentId: kid.studentId, complaint: 'Fever and headache', temperatureC: 38.6, treatment: 'Paracetamol given; rested',
      medicines: [{ name: 'Paracetamol 500 mg', dose: '1 tablet', itemId: pcm.id, qty: 1 }], outcome: 'SENT_HOME' });
    expect(v.parentTold).toBe(true);
    expect((await notes(kid.parent.id)).at(-1)).toMatchObject({ kind: 'HEALTH', body: expect.stringMatching(/Fever and headache.*sent home.*collect/) });
    const items = await stores.items(w.db, keeper, w.schoolA) as { code: string; balance: number }[];
    expect(items.find((i) => i.code === 'PCM500')!.balance).toBe(29);
    expect((await health.visits(w.db, nurse, w.schoolA)).length).toBe(1);
    await rejects(health.recordVisit(w.db, w.teacherA, w.schoolA, { studentId: kid.studentId, complaint: 'x', outcome: 'RESTED' }), /not part of your role/);
  });

  it('records a whole class’s check-up with BMI worked out', async () => {
    await health.recordCheckups(w.db, nurse, w.schoolA, { onDate: '2026-07-15', rows: [{ studentId: kid.studentId, heightCm: 150, weightKg: 45, visionLeft: '6/6', visionRight: '6/9', dental: 'Healthy' }] });
    const r = await health.record(w.db, kid.parent, kid.studentId);
    expect(r.checkups[0]).toMatchObject({ height_cm: 150, weight_kg: 45, bmi: 20 });
    expect(r.record).toMatchObject({ allergies: 'Peanuts (severe)' });
  });

  it('keeps child-protection incidents to the principal and the safety officer; reminds of drills', async () => {
    const i = await health.reportIncident(w.db, w.teacherA, w.schoolA, { at: new Date().toISOString(), kind: 'CHILD_PROTECTION', severity: 'SERIOUS', place: 'Corridor near X-A',
      description: 'A child reported being threatened by older students.', studentIds: [kid.studentId] });
    expect(i.number).toMatch(/^INC-/);
    expect(await health.incidents(w.db, w.teacherA, w.schoolA)).toHaveLength(0);            // not even the reporter sees it again
    expect((await health.incidents(w.db, safety, w.schoolA) as { confidential: boolean }[])[0].confidential).toBe(true);
    await rejects(health.updateIncident(w.db, w.teacherA, i.id, { note: 'Spoke to them' }), /principal or the safety officer/);
    await health.updateIncident(w.db, safety, i.id, { note: 'Counsellor met the child; parents of all three met the principal.', close: true });
    expect((await health.drills(w.db, w.principalA, w.schoolA)).due.find((d) => d.kind === 'FIRE')!.overdue).toBe(true);
    await health.recordDrill(w.db, safety, w.schoolA, { kind: 'FIRE', onDate: '2026-10-01', minutesToClear: 4.5, participants: 900, observations: 'Class VIII-B slow on the east stairs' });
    expect((await health.drills(w.db, w.principalA, w.schoolA)).due.find((d) => d.kind === 'FIRE')!.overdue).toBe(false);
  });
});

describe('the gate', () => {
  it('lets in an expected visitor by code, tells the host, prints a badge, and signs them out', async () => {
    const e = await gate.expect(w.db, w.teacherA, w.schoolA, { name: 'Mr Sunil Rao', phone: '98200 44556', purpose: 'Science exhibition judge', on: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) });
    expect(e.sandboxCode).toMatch(/^\d{6}$/);
    expect((await w.db.one<{ template_code: string }>(`select template_code from outbound_message where to_address = '+919820044556'`)).template_code).toBe('VISITOR_CODE_SMS');
    await rejects(gate.checkInByCode(w.db, guardA, w.schoolA, '000000'), /visitor with that code/);
    const v = await gate.checkInByCode(w.db, guardA, w.schoolA, e.sandboxCode!, { idKind: 'Aadhaar', idLast4: '1234' });
    expect((await notes(w.teacherA.id)).at(-1)!.title).toBe('Mr Sunil Rao is at the gate');
    expect((await gate.badge(w.db, guardA, v.id)).data.subarray(0, 5).toString()).toBe('%PDF-');
    const walk = await gate.walkIn(w.db, guardA, w.schoolA, { name: 'Courier', purpose: 'Delivery to the office', photoBase64: JPEG });
    const reg = await gate.register(w.db, guardA, w.schoolA) as { status: string }[];
    expect(reg.filter((r) => r.status === 'IN')).toHaveLength(2);
    await gate.checkOut(w.db, guardA, walk.id);
    await rejects(gate.walkIn(w.db, w.teacherA, w.schoolA, { name: 'X', purpose: 'Y' }), /not part of your role/);
  });

  it('lets a child go early only to a person the parent named, on a pass the class teacher approved', async () => {
    await rejects(gate.addPickup(w.db, kid.parent, kid.studentId, { name: 'Driver Babu', relation: 'Family driver' }), /photo/);
    const p = await gate.addPickup(w.db, kid.parent, kid.studentId, { name: 'Driver Babu', relation: 'Family driver', phone: '9820099887', photoBase64: JPEG });
    expect((await gate.pickupCard(w.db, kid.parent, p.id)).data.subarray(0, 5).toString()).toBe('%PDF-');
    const token = (await w.db.one<{ token: string }>('select token from authorised_pickup where id = $1', [p.id])).token;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const pass = await gate.requestPass(w.db, kid.parent, kid.studentId, { on: today, leaveAt: '12:30', reason: 'Dentist appointment', pickupId: p.id });
    expect((await notes(w.teacherA.id)).at(-1)!.title).toMatch(/Gate pass/);
    // Not approved yet: the guard's scan finds nothing to let go.
    await rejects(gate.verify(w.db, guardA, w.schoolA, token), /approved gate pass today/);
    await rejects(gate.decidePass(w.db, otherTeacher, pass.id, true), /class teacher or the principal/);
    await gate.decidePass(w.db, w.teacherA, pass.id, true);
    const found = await gate.verify(w.db, guardA, w.schoolA, token);
    expect(found[0]).toMatchObject({ number: pass.number, pickup: 'Driver Babu' });
    await gate.letGo(w.db, guardA, pass.id);
    expect((await notes(kid.parent.id)).at(-1)).toMatchObject({ kind: 'GATE', body: expect.stringMatching(/with Driver Babu/) });
    await rejects(gate.letGo(w.db, guardA, pass.id), /already left/);
    // Another family cannot use this child's pickup or passes.
    const other = await family(w, { classCode: 'X' });
    await rejects(gate.requestPass(w.db, other.parent, other.studentId, { on: today, leaveAt: '13:00', reason: 'x x x', pickupId: p.id }), /people you have named/);
  });
});

describe('stores and assets', () => {
  let paper: string, laptop: string, supplier: string;
  it('issues stock first-expiry-first-out, warns when low, and never issues expired stock', async () => {
    paper = (await stores.saveItem(w.db, keeper, w.schoolA, { code: 'A4', name: 'A4 paper (ream)', category: 'STATIONERY', kind: 'CONSUMABLE', unit: 'reams', reorderLevel: 10 })).id;
    await stores.adjust(w.db, keeper, w.schoolA, { itemId: paper, kind: 'OPENING', qty: 12, unitPaise: 30000, note: 'Opening stock' });
    await stores.issue(w.db, keeper, w.schoolA, { itemId: paper, qty: 3, department: 'Office' });
    expect((await notes(keeper.id)).at(-1)!.title).toBe('A4 paper (ream) is running low');
    await rejects(stores.issue(w.db, keeper, w.schoolA, { itemId: paper, qty: 50, department: 'Office' }), /Only 9 reams/);
    const ors = (await stores.saveItem(w.db, keeper, w.schoolA, { code: 'ORS', name: 'ORS sachet', category: 'MEDICINE', kind: 'CONSUMABLE', trackExpiry: true })).id;
    await stores.adjust(w.db, keeper, w.schoolA, { itemId: ors, kind: 'OPENING', qty: 5, batch: 'OLD', expiry: '2026-01-31', note: 'Opening' });
    await stores.adjust(w.db, keeper, w.schoolA, { itemId: ors, kind: 'OPENING', qty: 5, batch: 'NEW', expiry: '2027-06-30', note: 'Opening' });
    await rejects(stores.issue(w.db, keeper, w.schoolA, { itemId: ors, qty: 6, department: 'Infirmary' }), /unexpired/);
    await stores.issue(w.db, keeper, w.schoolA, { itemId: ors, qty: 2, department: 'Infirmary' });
    const led = await stores.ledgerOf(w.db, keeper, ors) as { batch: string; qty: number }[];
    expect(led[0]).toMatchObject({ batch: 'NEW', qty: -2 });
  });

  it('runs indent, approval, order (approved by someone else), receipt into stock and assets, and payment, all in the books', async () => {
    const ind = await stores.raiseIndent(w.db, w.teacherA, w.schoolA, { department: 'Computer lab', purpose: 'New lab', lines: [{ itemId: paper, qty: 5 }, { description: 'Laptops for the computer lab', qty: 2 }] });
    await rejects(stores.decideIndent(w.db, keeper, ind.id, true), /principal approves/);
    await stores.decideIndent(w.db, w.principalA, ind.id, true);
    const iss = await stores.issueIndent(w.db, keeper, ind.id);
    expect(iss.short).toEqual(['Laptops for the computer lab']);
    laptop = (await stores.saveItem(w.db, keeper, w.schoolA, { code: 'LAPTOP', name: 'Laptop i5 16 GB', category: 'IT', kind: 'ASSET', lifeYears: 4 })).id;
    supplier = (await stores.saveSupplier(w.db, keeper, w.schoolA, { name: 'Coastal Computers', gstin: '27AABCC1234D1Z5', phone: '022 2200 1100' })).id;
    const po = await stores.createPo(w.db, keeper, w.schoolA, { supplierId: supplier, indentId: ind.id, lines: [{ itemId: laptop, qty: 2, unitPaise: 5000000, gstPct: 18 }, { itemId: paper, qty: 20, unitPaise: 30000, gstPct: 12 }] });
    // The principal who would approve did not prepare it; a store keeper cannot approve.
    await rejects(stores.approvePo(w.db, keeper, po.id), /principal approves/);
    await stores.approvePo(w.db, w.principalA, po.id);
    const lines = ((await stores.orders(w.db, keeper, w.schoolA)) as { id: string; lines: { id: string; itemId: string }[] }[]).find((o) => o.id === po.id)!.lines;
    const g = await stores.receive(w.db, keeper, po.id, { receivedOn: '2026-10-10', invoiceNo: 'CC/2026/889', lines: lines.map((l) => ({ lineId: l.id, qty: l.itemId === laptop ? 2 : 20, serials: l.itemId === laptop ? ['SN-A1', 'SN-A2'] : undefined, location: 'Computer lab' })) });
    expect(g.amount).toBe(2 * 5900000 + 20 * 33600);
    const reg = await stores.assets(w.db, keeper, w.schoolA) as { tag: string; cost_paise: number; serial_no: string }[];
    expect(reg).toHaveLength(2);
    expect(reg[0]).toMatchObject({ tag: 'A-NCSA-00001', cost_paise: 5900000, serial_no: 'SN-A1' });
    const tb = await trialBalance(w.db, w.schoolA) as { code: string; debit: number; credit: number }[];
    expect(tb.find((r) => r.code === '1600')).toMatchObject({ debit: 11800000 });
    expect(tb.find((r) => r.code === '5400')).toMatchObject({ debit: 672000 });
    expect(tb.find((r) => r.code === '2600')).toMatchObject({ credit: 12472000 });
    const grn = (await w.db.one<{ id: string }>('select id from goods_receipt where po_id = $1', [po.id])).id;
    await rejects(stores.paySupplier(w.db, keeper, grn, { amountPaise: 100, paidOn: '2026-10-15', utr: 'UTR1234' }), /not part of your role/);
    await stores.paySupplier(w.db, w.principalA, grn, { amountPaise: 12472000, paidOn: '2026-10-15', utr: 'SBIN26288001' });
    expect(((await stores.suppliers(w.db, keeper, w.schoolA)) as { owed_paise: number }[])[0].owed_paise).toBe(0);
  });

  it('audits assets by scanning, marks the ones not found, and writes one off with the loss in the books', async () => {
    const a = await stores.startAudit(w.db, keeper, w.schoolA, 'Annual verification 2026-27');
    const s = await stores.scan(w.db, keeper, a.id, 'A-NCSA-00001', 'Principal’s office');
    expect(s.moved).toBe(true);
    const rep = await stores.auditReport(w.db, keeper, a.id);
    expect(rep.missing.map((m: any) => m.tag)).toEqual(['A-NCSA-00002']);
    await stores.closeAudit(w.db, keeper, a.id);
    const assets = await stores.assets(w.db, keeper, w.schoolA) as { tag: string; status: string; location: string; id: string }[];
    expect(assets.find((x) => x.tag === 'A-NCSA-00001')!.location).toBe('Principal’s office');
    expect(assets.find((x) => x.tag === 'A-NCSA-00002')!.status).toBe('MISSING');
    const dep = await stores.depreciate(w.db, w.principalA, w.schoolA, '2026-27');
    expect(dep.amountPaise).toBe(2 * Math.round((5900000 / 4) * 6 / 12));                  // October to March: six months
    await rejects(stores.depreciate(w.db, w.principalA, w.schoolA, '2026-27'), /already in the books/);
    const lost = assets.find((x) => x.tag === 'A-NCSA-00002')!;
    const d = await stores.dispose(w.db, w.principalA, lost.id, { on: '2026-10-20', note: 'Not found in the annual verification; written off by order NCS-A/ADM/12' });
    expect(d.gain).toBe(-(5900000 - 737500));
    const tb = await trialBalance(w.db, w.schoolA) as { debit: number; credit: number }[];
    expect(tb.reduce((s, r) => s + Number(r.debit), 0)).toBe(tb.reduce((s, r) => s + Number(r.credit), 0));
    expect((await stores.tagLabels(w.db, keeper, w.schoolA)).data.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('alumni', () => {
  it('verifies a former pupil found in the records at once, and asks the school about anyone else', async () => {
    const left = await w.db.one<{ id: string }>(`insert into student (name, dob, gender) values ('Rohan Kapoor', '2004-02-11', 'M') returning id`);
    await w.db.query(`insert into enrolment (student_id, school_id, campus_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
                      values ($1, $2, $3, '2026-27', 'X', 'OLD/1', 'COMPLETED', daterange('2015-04-01', '2020-04-01'), '1', '{}')`, [left.id, w.schoolA, w.campusA]);
    const code = async (dest: string) => (await alumni.requestCode(w.db, { destination: dest, purpose: 'ALUMNI_REGISTER' })).sandboxCode!;
    const r = await alumni.register(w.db, { schoolId: w.schoolA, name: 'Rohan Kapoor', email: 'rohan@example.in', mobile: '9811122233', dob: '2004-02-11', leftYear: 2020, lastClass: 'X', occupation: 'Engineer', inDirectory: true,
      emailCode: await code('rohan@example.in'), mobileCode: await code('9811122233') });
    expect(r.verified).toBe(true);
    const r2 = await alumni.register(w.db, { schoolId: w.schoolA, name: 'Anita Shah', email: 'anita@example.in', mobile: '9811122244', leftYear: 2012, emailCode: await code('anita@example.in'), mobileCode: await code('9811122244') });
    expect(r2.verified).toBe(false);
    const coordinator = await staffWithDuty('Alumni Coordinator', 'TEACHER', 'ALUMNI_COORDINATOR');
    const pending = await alumni.list(w.db, coordinator, w.schoolA, { status: 'PENDING' }) as { id: string }[];
    expect(pending).toHaveLength(1);
    await alumni.verify(w.db, coordinator, pending[0].id, { approve: true, note: 'Checked the 2012 register' });
    const rohan = await loadActor(w.db, (await w.db.one<{ id: string }>(`select u.id from app_user u join alumnus a on a.id = u.alumnus_id where a.email = 'rohan@example.in'`)).id);
    const dir = await alumni.directory(w.db, rohan, {}) as { name: string }[];
    expect(dir.map((d) => d.name)).toEqual(['Rohan Kapoor']);                              // Anita did not agree to be listed
    const ev = await alumni.sendEvent(w.db, coordinator, w.schoolA, { title: 'Batch of 2020 reunion', kind: 'REUNION', onDate: '2026-12-26', venue: 'School auditorium', body: 'Join us for the reunion of the batch of 2020.', batches: [2020] });
    expect(ev.sent).toBe(1);
    await alumni.rsvp(w.db, rohan, ev.id, { answer: 'YES', guests: 1 });
    expect(((await alumni.events(w.db, coordinator, w.schoolA)) as { replies: Record<string, number> }[])[0].replies).toEqual({ YES: 2 });
    await rejects(alumni.list(w.db, w.teacherA, w.schoolA, {}), /not part of your role/);
  });
});
