/**
 * Builds a realistic, internally consistent demo network for testing R1.
 * Reference data is inserted directly; everything that has business rules (fees, payments,
 * transfers, attendance, messages, admissions) goes through the real modules, so the demo
 * data obeys exactly the same constraints as live data.
 *
 *   npm run seed            (rebuilds ./data/pg from scratch)
 */
import { rmSync } from 'node:fs';
import { DEFAULT_DATA_DIR, openDb, type Db } from './db/client.js';
import { migrate } from './db/migrate.js';
import { classify, type RankedRule, type Rule } from './lib/rules.js';
import { publishScheme } from './modules/categories.js';
import { loadActor } from './modules/auth.js';
import * as fees from './modules/fees.js';
import * as payments from './modules/payments.js';
import * as students from './modules/students.js';
import * as attendance from './modules/attendance.js';
import * as messaging from './modules/messaging.js';
import * as admissions from './modules/admissions.js';
import * as org from './modules/org.js';
import * as homework from './modules/homework.js';
import * as notices from './modules/notices.js';
import * as leave from './modules/leave.js';
import * as generator from './modules/generator.js';
import * as cover from './modules/cover.js';
import * as site from './modules/site.js';
import * as academics from './modules/academics.js';
import * as awards from './modules/awards.js';
import * as settings from './modules/settings.js';
import * as duties from './modules/duties.js';
import * as attachments from './modules/attachments.js';
import * as charges from './modules/charges.js';
import * as printing from './modules/printing.js';
import * as library from './modules/library.js';
import * as certificates from './modules/certificates.js';
import * as transfers from './modules/transfers.js';
import * as chat from './modules/chat.js';
import * as sections from './modules/sections.js';
import * as staff from './modules/staff.js';
import * as staffLeave from './modules/staffLeave.js';
import * as payroll from './modules/payroll.js';
import * as accounts from './modules/accounts.js';
import * as transport from './modules/transport.js';
import * as recruitment from './modules/recruitment.js';
import * as cwt from './modules/cwt.js';
import * as support from './modules/support.js';
import * as health from './modules/health.js';
import * as gate from './modules/gate.js';
import * as stores from './modules/stores.js';
import * as alumni from './modules/alumni.js';
import * as hpc from './modules/hpc.js';
import * as exams from './modules/exams.js';
import * as governance from './modules/governance.js';
import * as inspections from './modules/inspections.js';
import { HPC_CLASSES, HPC_TEMPLATES } from './reference/hpcTemplates.js';
import { newDocument, Sheet } from './lib/pdf.js';
import { last4, seal } from './lib/secret.js';
import { addDays } from './lib/dates.js';
import { ncsMumbaiSite } from './reference/siteTemplates.js';
import { rupees } from './lib/money.js';
import { ADMISSION_RULES, FEE_BAND_RULES, TUITION_OFFICER, BAND_FACTOR } from './reference/nes-defaults.js';
import { localToday, daysFromToday } from './lib/dates.js';

const YEAR = '2026-27';
const TODAY = localToday();

let seed = 20261011;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const FIRST_F = ['Aadhya', 'Ananya', 'Diya', 'Ishita', 'Kavya', 'Meera', 'Myra', 'Navya', 'Riya', 'Saanvi', 'Sara', 'Tara', 'Zoya', 'Anika', 'Ira', 'Pari', 'Rhea', 'Sana', 'Avni', 'Kiara'];
const FIRST_M = ['Aarav', 'Arjun', 'Advait', 'Dhruv', 'Ishaan', 'Kabir', 'Reyansh', 'Vihaan', 'Vivaan', 'Aditya', 'Ayaan', 'Krish', 'Rohan', 'Shaurya', 'Atharv', 'Yash', 'Om', 'Rudra', 'Aryan', 'Neel'];
const LAST = ['Sharma', 'Nair', 'Menon', 'Iyer', 'Rao', 'Singh', 'Patil', 'Kulkarni', 'Das', 'Pillai', 'Reddy', 'Gupta', 'Joshi', 'Fernandes', 'D’Souza', 'Banerjee', 'Chauhan', 'Thomas', 'Verma', 'Kamath'];
const ADULT_M = ['Rohit', 'Sanjay', 'Vikram', 'Anil', 'Deepak', 'Rajesh', 'Suresh', 'Manoj', 'Arun', 'Karthik'];

let phone = 9810000000;
const nextPhone = () => `+91${phone++}`;

type Profile = { service: string; status: string; rank: string | null; civil: boolean; posted: boolean; rel: string };
function randomProfile(): Profile {
  const r = rnd();
  const navyRank = () => { const x = rnd(); return x < 0.25 ? pick(['N_LCDR', 'N_CDR', 'N_LT', 'N_CAPT']) : x < 0.4 ? pick(['N_CPO', 'N_MCPO2']) : pick(['N_PO', 'N_LS', 'N_SEA']); };
  if (r < 0.59) return { service: 'NAVY', status: 'SERVING', rank: navyRank(), civil: false, posted: true, rel: pick(['FATHER', 'MOTHER']) };
  if (r < 0.62) return { service: pick(['ARMY', 'AIR_FORCE']), status: 'DEPUTATION_NAVY', rank: null, civil: false, posted: true, rel: 'FATHER' };
  if (r < 0.71) return { service: 'NAVY', status: 'ESM_PENSION', rank: navyRank(), civil: false, posted: false, rel: 'FATHER' };
  if (r < 0.78) return { service: 'DEF_CIV_NAVY', status: 'SERVING', rank: null, civil: rnd() < 0.2, posted: true, rel: pick(['FATHER', 'MOTHER']) };
  if (r < 0.806) return { service: 'NAVY', status: 'ESM_NO_PENSION', rank: navyRank(), civil: false, posted: false, rel: 'FATHER' };
  if (r < 0.856) return { service: pick(['NAVY', 'ARMY', 'AIR_FORCE']), status: 'SERVING', rank: null, civil: false, posted: false, rel: 'FATHER' };
  if (r < 0.871) return { service: 'DEF_CIV_ARMY_AF', status: 'SERVING', rank: null, civil: false, posted: true, rel: 'MOTHER' };
  if (r < 0.909) return { service: 'NAVY', status: 'ESM_PENSION', rank: navyRank(), civil: false, posted: false, rel: 'GRANDPARENT' };
  return { service: 'CIVILIAN', status: 'NONE', rank: null, civil: false, posted: false, rel: pick(['FATHER', 'MOTHER']) };
}
const rankFor = (p: Profile) => p.rank ?? (p.service === 'NAVY' ? pick(['N_LCDR', 'N_CPO', 'N_PO', 'N_LS'])
  : p.service === 'ARMY' ? pick(['A_MAJ', 'A_HAV', 'A_NSUB']) : p.service === 'AIR_FORCE' ? pick(['AF_WGCDR', 'AF_SGT', 'AF_JWO']) : null);

async function unit(db: Db, kind: string, code: string, name: string, parentId: string | null, extra: Record<string, unknown> = {}) {
  const r = await db.one<{ id: string }>(
    `insert into org_unit (kind, code, name, parent_id, school_type, affiliation_no, udise_code, address) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [kind, code, name, parentId, extra.type ?? null, extra.aff ?? null, extra.udise ?? null, extra.address ?? null]);
  return r.id;
}

async function main() {
  const dir = process.env.NES_DATA_DIR ?? DEFAULT_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  const db = await openDb(dir);
  await migrate(db);
  const t0 = Date.now();

  await db.query(`insert into academic_year (code, period) values ('2026-27', daterange('2026-04-01', '2027-04-01'))`);
  const nes = await unit(db, 'society', 'NES', 'Navy Education Society', null);
  const cmd: Record<string, string> = {};
  for (const [c, n] of [['WNC', 'Western Naval Command'], ['ENC', 'Eastern Naval Command'], ['SNC', 'Southern Naval Command'], ['ANC', 'Andaman and Nicobar Command'], ['NHQ', 'Naval Headquarters']]) cmd[c] = await unit(db, 'command', c, n, nes);

  const schoolsDef = [
    { code: 'NCS-MB', name: 'Navy Children School, Mumbai', cmd: 'WNC', campus: 'Main Campus', addr: 'Navy Nagar, Colaba, Mumbai 400005', classes: 'I-XII', perSection: 9 },
    { code: 'NCS-VZ', name: 'Navy Children School, Visakhapatnam (NB)', cmd: 'ENC', campus: 'Nausena Baugh Campus', addr: 'Nausena Baugh, Visakhapatnam 530005', classes: 'BV-XII', perSection: 8 },
    { code: 'NCS-KC', name: 'Navy Children School, Kochi', cmd: 'SNC', campus: 'Naval Base Campus', addr: 'Naval Base, Kochi 682004', classes: 'BV-XII', perSection: 8 },
    { code: 'NCS-GA', name: 'Navy Children School, Goa', cmd: 'WNC', campus: 'Dabolim Campus', addr: 'Airport Road, Dabolim, Goa 403801', classes: 'I-XII', perSection: 7 },
    { code: 'NCS-PB', name: 'Navy Children School, Port Blair', cmd: 'ANC', campus: 'Minnie Bay Campus', addr: 'Minnie Bay, Port Blair 744103', classes: 'I-XII', perSection: 6 },
    { code: 'NCS-DL', name: 'Navy Children School, Delhi', cmd: 'NHQ', campus: 'Chanakyapuri Campus', addr: 'Chanakyapuri, New Delhi 110021', classes: 'I-XII', perSection: 7 },
  ];
  const school: Record<string, { id: string; campus: string }> = {};
  let udise = 27230100001;
  for (const s of schoolsDef) {
    const id = await unit(db, 'school', s.code, s.name, cmd[s.cmd], { type: 'NCS', aff: `CBSE-${1100000 + Object.keys(school).length}`, udise: String(udise++) });
    const campus = await unit(db, 'campus', `${s.code}-A`, s.campus, id, { address: s.addr });
    school[s.code] = { id, campus };
  }
  // A Naval Kindergarten that merged into NCS Mumbai: it becomes Mumbai's second campus.
  const nkg = await unit(db, 'school', 'NKG-COL', 'Naval Kindergarten, Colaba', cmd.WNC, { type: 'NKG', udise: String(udise++) });
  const kgCampus = await unit(db, 'campus', 'NKG-COL-A', 'Kindergarten Campus', nkg, { address: 'Colaba Military Station, Mumbai 400005' });

  const classes = await db.query<{ code: string; ordinal: number }>('select code, ordinal from class_level order by ordinal');
  const sectionIds: Record<string, string[]> = {};
  async function addSections(campusId: string, from: number, to: number, cap: number) {
    for (const c of classes.filter((x) => x.ordinal >= from && x.ordinal <= to)) {
      for (const n of ['A', 'B']) {
        const r = await db.one<{ id: string }>(`insert into section (campus_id, academic_year, class_code, name, capacity) values ($1,$2,$3,$4,$5) returning id`,
          [campusId, YEAR, c.code, n, c.code === 'III' && campusId === school['NCS-MB'].campus ? 9 : cap]);
        (sectionIds[`${campusId}:${c.code}`] ??= []).push(r.id);
      }
    }
  }
  for (const s of schoolsDef) await addSections(school[s.code].campus, s.classes === 'BV-XII' ? 1 : 4, 15, 36);
  await addSections(kgCampus, 1, 3, 24);
  // A Navy Kindergarten on its own (Balvatika 1 to 3 only): it appears as a choice only for those classes.
  const nkgGoa = await unit(db, 'school', 'NKG-GA', 'Navy Kindergarten, Goa', cmd.WNC, { type: 'NKG', udise: String(udise++) });
  await addSections(await unit(db, 'campus', 'NKG-GA-A', 'Vasco Campus', nkgGoa, { address: 'Naval Station, Vasco da Gama, Goa 403802' }), 1, 3, 25);

  // Users
  const user = async (name: string, role: string, designation: string, scope: string | null, guardianId: string | null = null) =>
    (await db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path, guardian_id) values ($1,$2,$3,$4::ltree,$5) returning id`,
      [name, role, designation, scope, guardianId])).id;
  const nesAdmin = await user('Cdr Anjali Verma', 'NES_ADMIN', 'NES Academics Officer', 'nes');
  const nesFinance = await user('Mr Ramesh Iyer', 'NES_ADMIN', 'NES Finance Officer', 'nes');
  await user('Capt Vivek Menon', 'COMMAND_OFFICER', 'Command Education Officer, WNC', 'nes.wnc');
  const principal = await user('Mrs Sunita Rao', 'SCHOOL_ADMIN', 'Principal, NCS Mumbai', 'nes.wnc.ncs_mb');
  const accountant = await user('Mr Prakash Shetty', 'ACCOUNTANT', 'Accountant, NCS Mumbai', 'nes.wnc.ncs_mb');
  // The principal of another school, to show requests to move a child between schools.
  const principalKc = await user('Mrs Lata Menon', 'SCHOOL_ADMIN', 'Principal, NCS Kochi', 'nes.snc.ncs_kc');
  const teacher = await user('Mrs Priya Kulkarni', 'TEACHER', 'TGT Mathematics, class teacher VIII-B', 'nes.wnc.ncs_mb');
  // More Mumbai teachers, one per subject, so timetables and homework have real owners.
  const subjectTeacher: Record<string, string> = { MAT: teacher };
  for (const [code, name, desig] of [['ENG', 'Mr Rahul Desai', 'TGT English, class teacher VIII-A'], ['HIN', 'Mrs Kavita Joshi', 'TGT Hindi'], ['SCI', 'Mrs Meena Iyer', 'TGT Science, class teacher X-A'],
    ['SST', 'Mr Faisal Khan', 'TGT Social Science'], ['SAN', 'Mr Vivek Sharma', 'TGT Sanskrit'], ['CS', 'Mrs Sapna Kapoor', 'PGT Computer Science'], ['PE', 'Mr Arjun Pillai', 'PGT Physical Education']] as const) {
    subjectTeacher[code] = await user(name, 'TEACHER', desig, 'nes.wnc.ncs_mb');
  }
  const A = (id: string) => loadActor(db, id);
  const mb0 = school['NCS-MB'].id;
  const mbSec = (cls: string, i: number) => sectionIds[`${school['NCS-MB'].campus}:${cls}`][i];
  // Class teachers for the year (co-class teachers act when the class teacher is away).
  for (const [sec, who, kind] of [[mbSec('VIII', 1), teacher, 'CLASS'], [mbSec('VIII', 1), subjectTeacher.SST, 'CO'], [mbSec('VIII', 0), subjectTeacher.ENG, 'CLASS'], [mbSec('VIII', 0), subjectTeacher.HIN, 'CO'],
    [mbSec('X', 0), subjectTeacher.SCI, 'CLASS'], [mbSec('X', 0), subjectTeacher.SAN, 'CO'], [mbSec('X', 1), subjectTeacher.CS, 'CLASS'], [mbSec('IX', 0), subjectTeacher.PE, 'CLASS']] as const) {
    await db.tx((t) => t.query(`insert into class_teacher (section_id, user_id, kind, valid, assigned_by) values ($1, $2, $3, daterange('2026-04-01', '2027-04-01'), $4)`, [sec, who, kind, principal]), { actor: 'seed' });
  }

  // Merger: NKG Colaba joins NCS Mumbai as its Kindergarten Campus.
  await org.recordMerger(db, await A(nesAdmin), { mergedSchoolId: nkg, survivingSchoolId: school['NCS-MB'].id, effectiveDate: '2026-04-01', note: 'NKG Colaba merged into NCS Mumbai' });

  // Category schemes (NES default), effective for the year.
  await publishScheme(db, { schoolId: null, kind: 'ADMISSION', name: 'NES admission categories', validFrom: '2026-04-01', rules: ADMISSION_RULES }, 'seed');
  await publishScheme(db, { schoolId: null, kind: 'FEE_BAND', name: 'NES fee bands', validFrom: '2026-04-01', rules: FEE_BAND_RULES }, 'seed');
  const admRules = (await db.query<RankedRule>(`select r.id, r.code, r.label, r.priority, r.condition from category_rule r join category_scheme s on s.id = r.scheme_id where s.kind = 'ADMISSION'`));

  // Fee plans: quarterly instalments, version 1 drafted by finance, approved by a second officer.
  for (const s of Object.values(school)) {
    const p = await db.one<{ id: string }>(`insert into fee_plan (school_id, academic_year, name) values ($1, $2, 'Fees 2026–27') returning id`, [s.id, YEAR]);
    for (const [code, label, due, a, b] of [['Q1', 'Apr–Jun', '2026-04-25', '2026-04-01', '2026-07-01'], ['Q2', 'Jul–Sep', '2026-07-25', '2026-07-01', '2026-10-01'],
      ['Q3', 'Oct–Dec', '2026-10-25', '2026-10-01', '2027-01-01'], ['Q4', 'Jan–Mar', '2027-01-25', '2027-01-01', '2027-04-01']]) {
      await db.query(`insert into fee_installment (plan_id, code, label, due_date, period) values ($1,$2,$3,$4,daterange($5::date,$6::date))`, [p.id, code, label, due, a, b]);
    }
    const v = await db.tx((t) => t.one<{ id: string }>(`insert into fee_plan_version (plan_id, version, valid, policy, note) values ($1, 1, daterange('2026-04-01', null), 'FUTURE_ONLY', 'Approved fee schedule 2026–27') returning id`, [p.id]), { actor: 'Mr Ramesh Iyer (NES Finance)' });
    for (const [cb, base] of Object.entries(TUITION_OFFICER)) {
      for (const [fb, f] of Object.entries(BAND_FACTOR)) {
        await db.query(`insert into fee_rate values ($1,$2,$3,'TUITION','QUARTERLY',$4)`, [v.id, cb, fb, rupees(Math.round((base * f) / 10) * 10)]);
        await db.query(`insert into fee_rate values ($1,$2,$3,'ANNUAL','ANNUAL',$4)`, [v.id, cb, fb, rupees(cb === 'PRE' ? 3000 : 4500)]);
        if (cb !== 'PRE') await db.query(`insert into fee_rate values ($1,$2,$3,'COMPUTER','QUARTERLY',$4)`, [v.id, cb, fb, rupees(900)]);
      }
    }
    await db.query(`update fee_plan_version set status = 'PUBLISHED', approved_by = 'Cdr Anjali Verma (NES)', published_at = now() where id = $1`, [v.id]);
  }
  await db.query(`insert into concession_rule (name, condition, head_code, percent, priority, valid)
                  values ('Second child: 10% off tuition', '{"gte":["sibling_rank",2]}', 'TUITION', 10, 1, daterange('2026-04-01', null))`);

  // Families and students. Each student's admission category is computed by the same engine.
  async function family(p: Profile, guardianName: string, kids: { name: string; gender: string; dob: string; campus: string; school: string; classCode: string; section?: number }[], start = '2026-04-01') {
    const g = await db.one<{ id: string }>(`insert into guardian (name, phone) values ($1, $2) returning id`, [guardianName, nextPhone()]);
    const rank = rankFor(p);
    await db.query(`insert into guardian_service_fact (guardian_id, valid, service, status, rank_code, civil_officer, posted_in_station)
                    values ($1, daterange('2026-01-01', null), $2, $3, $4, $5, $6)`, [g.id, p.service, p.status, rank, p.civil, p.posted]);
    const rb = rank ? (await db.one<{ band: string }>('select band from rank where code = $1', [rank])).band : null;
    const cat = classify(admRules.map((r) => ({ ...r, condition: r.condition as Rule })), { service: p.service, status: p.status, rank_band: rb, civil_officer: p.civil, posted_in_station: p.posted, relationship: p.rel });
    const ids: string[] = [];
    for (const k of kids) {
      const s = await db.one<{ id: string }>(`insert into student (name, dob, gender) values ($1, $2, $3) returning id`, [k.name, k.dob, k.gender]);
      await db.query(`insert into student_guardian (student_id, guardian_id, relationship, is_primary) values ($1, $2, $3, true)`, [s.id, g.id, p.rel]);
      const secs = sectionIds[`${k.campus}:${k.classCode}`];
      const sec = secs[k.section ?? Math.floor(rnd() * secs.length)];
      const counter = await db.one<{ last_no: number }>(`insert into admission_counter (school_id, year, last_no) values ($1, $2, 1)
        on conflict (school_id, year) do update set last_no = admission_counter.last_no + 1 returning last_no`, [k.school, YEAR]);
      const code = (await db.one<{ code: string }>('select code from org_unit where id = $1', [k.school])).code;
      await db.query(`insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
                      values ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',daterange($8::date, null),$9,$10)`,
        [s.id, k.school, k.campus, sec, YEAR, k.classCode, `${code}/2026/${String(counter.last_no).padStart(4, '0')}`, start, cat.code, JSON.stringify({ admission: cat, seeded: true })]);
      ids.push(s.id);
    }
    return { guardianId: g.id, studentIds: ids };
  }
  const dobFor = (ordinal: number) => `${2026 - (2 + ordinal)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`;

  // Named demo families
  const mehta = await family({ service: 'NAVY', status: 'SERVING', rank: 'N_LCDR', civil: false, posted: true, rel: 'FATHER' }, 'Lt Cdr Rohan Mehta', [
    { name: 'Aarav Mehta', gender: 'M', dob: '2013-05-14', campus: school['NCS-MB'].campus, school: school['NCS-MB'].id, classCode: 'VIII', section: 1 },
    { name: 'Anaya Mehta', gender: 'F', dob: '2021-02-09', campus: kgCampus, school: school['NCS-MB'].id, classCode: 'BV2', section: 0 },
  ]);
  const nair = await family({ service: 'NAVY', status: 'SERVING', rank: 'N_PO', civil: false, posted: true, rel: 'FATHER' }, 'PO Suresh Nair', [
    { name: 'Kavya Nair', gender: 'F', dob: '2011-08-21', campus: school['NCS-MB'].campus, school: school['NCS-MB'].id, classCode: 'X', section: 0 },
  ]);
  await user('Lt Cdr Rohan Mehta', 'PARENT', 'Parent', null, mehta.guardianId);
  await user('PO Suresh Nair', 'PARENT', 'Parent', null, nair.guardianId);

  let count = 3;
  const kgClasses = classes.filter((c) => c.ordinal <= 3);
  for (const s of schoolsDef) {
    const sc = school[s.code];
    const from = s.classes === 'BV-XII' ? 1 : 4;
    for (const c of classes.filter((x) => x.ordinal >= from)) {
      const n = (c.code === 'III' && s.code === 'NCS-MB') ? 18 : s.perSection * 2 - (c.ordinal >= 14 ? 4 : 0);
      for (let i = 0; i < n; i++) {
        const female = rnd() < 0.48;
        const last = pick(LAST);
        await family(randomProfile(), `${pick(ADULT_M)} ${last}`, [{ name: `${pick(female ? FIRST_F : FIRST_M)} ${last}`, gender: female ? 'F' : 'M', dob: dobFor(c.ordinal), campus: sc.campus, school: sc.id, classCode: c.code }]);
        count++;
      }
    }
  }
  for (const c of kgClasses) {
    for (let i = 0; i < 14; i++) {
      const female = rnd() < 0.5; const last = pick(LAST);
      await family(randomProfile(), `${pick(ADULT_M)} ${last}`, [{ name: `${pick(female ? FIRST_F : FIRST_M)} ${last}`, gender: female ? 'F' : 'M', dob: dobFor(c.ordinal), campus: kgCampus, school: school['NCS-MB'].id, classCode: c.code }]);
      count++;
    }
  }
  console.log(`Students: ${count} (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Earlier this year: children who already moved between schools on posting (history, so the
  // move is written directly; new moves go through a request the other school accepts).
  const nes0 = await A(nesAdmin);
  const routes: [string, string, number][] = [['NCS-MB', 'NCS-VZ', 9], ['NCS-KC', 'NCS-MB', 8], ['NCS-VZ', 'NCS-KC', 7], ['NCS-GA', 'NCS-MB', 5], ['NCS-DL', 'NCS-MB', 4], ['NCS-MB', 'NCS-KC', 4], ['NCS-VZ', 'NCS-MB', 4], ['NCS-PB', 'NCS-VZ', 3]];
  const months = ['2026-06-15', '2026-07-10', '2026-08-05', '2026-09-01'];
  for (const [from, to, n] of routes) {
    const movers = await db.query<{ student_id: string; class_code: string }>(
      `select e.student_id, e.class_code from enrolment e where e.school_id = $1 and e.status = 'ACTIVE' and e.admission_category in ('1', '1A', '3B')
         and exists (select 1 from section s where s.campus_id = $2 and s.class_code = e.class_code)
         and not exists (select 1 from enrolment x where x.student_id = e.student_id and x.status = 'TRANSFERRED_OUT')
       order by e.admission_no desc limit $3`, [school[from].id, school[to].campus, n]);
    for (const m of movers) await db.tx((t) => transfers.move(t, nes0, { studentId: m.student_id, toCampusId: school[to].campus, date: pick(months), reason: 'Parent posted to new station' }), { actor: 'seed' });
  }
  // Children who left NES (withdrawn with TC).
  const leavers = await db.query<{ id: string }>(`select id from enrolment where status = 'ACTIVE' and class_code in ('XI', 'XII', 'IX') order by admission_no limit 11`);
  for (const l of leavers) await db.tx((t) => t.query(`update enrolment set status = 'WITHDRAWN', period = daterange(lower(period), '2026-08-20') where id = $1`, [l.id]), { actor: 'seed' });
  console.log(`Transfers and leavers done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Transport at NCS Mumbai: fares by zone, three vehicles, routes with stop times (no GPS), and the
  // children on them, from April. Their transport fee is billed with the instalments below.
  {
    const pm = await A(principal);
    for (const [zone, name, rupee] of [['A', 'Navy Nagar and Colaba (up to 3 km)', 900], ['B', 'Cuffe Parade and Nariman Point (3 to 6 km)', 1300], ['C', 'Beyond 6 km', 1700]] as const)
      await transport.setFare(db, pm, mb0, { zone, name, monthlyPaise: rupee * 100, from: '2026-04-01' });
    const veh = async (regNo: string, kind: 'BUS' | 'MINIBUS' | 'VAN', seats: number, owner: 'SCHOOL' | 'CONTRACTOR' | 'NAVY', insurance: string, contractor?: string) =>
      (await transport.saveVehicle(db, pm, mb0, { regNo, kind, seats, owner, contractor, fitnessUntil: '2027-06-30', insuranceUntil: insurance, permitUntil: '2027-03-31', pucUntil: daysFromToday(75) })).id;
    const v1 = await veh('MH 01 DB 4471', 'BUS', 40, 'NAVY', '2027-02-28');
    const v2 = await veh('MH 01 EK 2210', 'MINIBUS', 26, 'CONTRACTOR', daysFromToday(18), 'Sai Krupa Travels');
    const v3 = await veh('MH 01 CV 0915', 'VAN', 12, 'CONTRACTOR', '2027-01-15', 'Sai Krupa Travels');
    const crew = async (name: string, phone: string, role: 'DRIVER' | 'ATTENDANT', licenceNo?: string) =>
      (await transport.saveCrew(db, pm, mb0, { name, phone, role, licenceNo: licenceNo ?? null, licenceUntil: licenceNo ? '2028-11-30' : null, policeVerifiedOn: '2026-03-12' })).id;
    const d1 = await crew('Shri Baban Jadhav', '9820141001', 'DRIVER', 'MH01 20090034567'), d2 = await crew('Shri Anil Kadam', '9820141002', 'DRIVER', 'MH01 20120045678'), d3 = await crew('Shri Vijay More', '9820141003', 'DRIVER', 'MH01 20150056789');
    const a2 = await crew('Smt Rekha Pawar', '9820141012', 'ATTENDANT'), a3 = await crew('Smt Sunita Gawde', '9820141013', 'ATTENDANT');
    const defs = [
      { code: 'R1', name: 'Navy Nagar – Colaba', v: v1, d: d1, a: null as string | null, stops: [['Sagar Darshan, Navy Nagar', '07:05', '14:40', 'A'], ['INHS Asvini gate', '07:12', '14:33', 'A'], ['Colaba Market', '07:20', '14:25', 'A'], ['Regal Circle', '07:30', '14:15', 'A']] },
      { code: 'R2', name: 'Cuffe Parade – Nariman Point', v: v2, d: d2, a: a2, stops: [['World Trade Centre', '06:55', '14:50', 'B'], ['Badhwar Park', '07:05', '14:40', 'B'], ['Nariman Point (Air India building)', '07:15', '14:30', 'B'], ['Churchgate', '07:25', '14:20', 'B']] },
      { code: 'R3', name: 'Bhendi Bazaar – Mazgaon Dock', v: v3, d: d3, a: a3, stops: [['Mazgaon Dock gate', '06:45', '15:00', 'C'], ['Byculla station', '06:55', '14:50', 'C'], ['Bhendi Bazaar', '07:05', '14:40', 'C']] },
    ];
    const stopIds: string[][] = [];
    for (const r of defs) {
      const id = (await transport.saveRoute(db, pm, mb0, { code: r.code, name: r.name, vehicleId: r.v, driverId: r.d, attendantId: r.a, tracking: r.code === 'R3' ? 'TIMES' : 'TAPS' })).id;
      await transport.saveStops(db, pm, id, r.stops.map(([name, morning, afternoon, fareZone]) => ({ name, morning, afternoon, fareZone })));
      stopIds.push((await db.query<{ id: string }>('select id from route_stop where route_id = $1 order by seq', [id])).map((x) => x.id));
    }
    const kids = await db.query<{ student_id: string }>(
      `select e.student_id from enrolment e join student s on s.id = e.student_id where e.school_id = $1 and e.status = 'ACTIVE' and e.class_code not in ('BV1', 'BV2', 'BV3') and s.id <> all($2)
        order by e.admission_no limit 66`, [mb0, [mehta.studentIds[0], nair.studentIds[0]]]);
    await transport.allocate(db, pm, { studentId: mehta.studentIds[0], pickupStopId: stopIds[0][1], dropStopId: stopIds[0][1], from: '2026-04-01' });
    await transport.allocate(db, pm, { studentId: nair.studentIds[0], pickupStopId: stopIds[1][2], dropStopId: stopIds[1][2], from: '2026-04-01' });
    const seats = [38, 24, 10];
    let i = 0;
    for (const [ri, n] of seats.entries()) for (let k = 0; k < n && i < kids.length; k++, i++) {
      const st = stopIds[ri][k % stopIds[ri].length];
      await transport.allocate(db, pm, { studentId: kids[i].student_id, pickupStopId: st, dropStopId: st, from: '2026-04-01' });
    }
  }
  console.log(`Transport done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Fees for Q1–Q3 through the real generator, then payments through the sandbox gateway.
  const fin = await A(nesFinance);
  // Mumbai's PTA fee: ₹500 a year per family, billed with the eldest child's first bill.
  await settings.set(db, await A(principal), mb0, { key: 'fees.pta_amount', value: 500, from: TODAY });
  // NCS Port Blair bills by the month; the others by the quarter.
  for (const [code, s] of Object.entries(school)) {
    if (code === 'NCS-PB') {
      await fees.setSchedule(db, fin, s.id, YEAR, 'MONTHLY');
      for (const m of ['M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10']) await fees.generateDemands(db, fin, s.id, YEAR, m);
    } else for (const q of ['Q1', 'Q2', 'Q3']) await fees.generateDemands(db, fin, s.id, YEAR, q);
  }
  console.log(`Fees raised (${Math.round((Date.now() - t0) / 1000)}s)`);
  const payers = await db.query<{ student_id: string; guardian_id: string; school_id: string }>(
    `select distinct on (e.student_id) e.student_id, sg.guardian_id, e.school_id from enrolment e
       join student_guardian sg on sg.student_id = e.student_id and sg.is_primary
      where e.school_id = $1 order by e.student_id`, [school['NCS-MB'].id]);
  let paid = 0;
  for (const p of payers) {
    if (p.student_id === mehta.studentIds[0] || p.student_id === mehta.studentIds[1]) continue;
    const u = (await db.maybeOne<{ id: string }>(`select id from app_user where guardian_id = $1`, [p.guardian_id]))
      ?? await db.one<{ id: string }>(`insert into app_user (name, role, guardian_id) values ('Parent', 'PARENT', $1) returning id`, [p.guardian_id]);
    const parent = await A(u.id);
    const items = await db.query<{ enrolment_id: string; installment_code: string }>(
      `select distinct d.enrolment_id, d.installment_code from fee_due d join enrolment e on e.id = d.enrolment_id
        where e.student_id = $1 and e.school_id = $2 and d.installment_code in ('Q1', 'Q2') and d.owed_paise > d.paid_paise`, [p.student_id, p.school_id]);
    if (!items.length || rnd() < 0.06) continue;
    const order = await payments.createOrder(db, parent, { studentId: p.student_id, method: rnd() < 0.8 ? 'UPI' : 'DEBIT_CARD', idempotencyKey: `seed-${p.student_id}`, items: items.map((i) => ({ enrolmentId: i.enrolment_id, installment: i.installment_code })) }) as { id: string };
    await payments.sandboxPay(db, parent, order.id, 'success');
    paid++;
  }
  // The Mehta family has paid Q1 and Q2; Q3 is due.
  const rohan = await db.one<{ id: string }>(`select id from app_user where guardian_id = $1`, [mehta.guardianId]);
  for (const sid of mehta.studentIds) {
    const items = await db.query<{ enrolment_id: string; installment_code: string }>(
      `select distinct d.enrolment_id, d.installment_code from fee_due d join enrolment e on e.id = d.enrolment_id where e.student_id = $1 and d.installment_code in ('Q1','Q2')`, [sid]);
    const o = await payments.createOrder(db, await A(rohan.id), { studentId: sid, method: 'UPI', idempotencyKey: `seed-mehta-${sid}`, items: items.map((i) => ({ enrolmentId: i.enrolment_id, installment: i.installment_code })) }) as { id: string };
    await payments.sandboxPay(db, await A(rohan.id), o.id, 'success');
  }
  console.log(`Payments: ${paid + 2} (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Houses and blood groups at Mumbai.
  const houses: string[] = [];
  for (const [name, colour] of [['Angre', '#C4161C'], ['Trata', '#0071E3'], ['Kunjali', '#1D8C3A'], ['Asvini', '#C9A227']]) {
    houses.push((await db.one<{ id: string }>(`insert into house (school_id, name, colour) values ($1, $2, $3) returning id`, [school['NCS-MB'].id, name, colour])).id);
  }
  await db.tx((t) => t.query(
    `update enrolment set house_id = ($2::uuid[])[1 + (abs(hashtext(id::text)) % 4)] where school_id = $1 and status in ('ACTIVE', 'PROVISIONAL')`, [school['NCS-MB'].id, houses]), { actor: 'seed' });
  await db.tx((t) => t.query(
    `update student set blood_group = (array['O+','B+','A+','AB+','O-','B-','A-','AB-'])[1 + (abs(hashtext(id::text)) % 8)]`), { actor: 'seed' });

  // School timings. NCS Mumbai's follow its published school hours (VI–XII to 2:00, 2:30 on Fridays;
  // I–II to 1:30; III–V to 1:45; Bal Vatika 8:30 to 12:30). Other schools start with one set.
  const p0 = await A(principal);
  type Row = [string, string, number | null, string, string];
  const senior = (fri: boolean): Row[] => [['ASSEMBLY', 'Assembly', null, '07:40', '08:00'], ['PERIOD', 'Period 1', 1, '08:00', '08:40'], ['PERIOD', 'Period 2', 2, '08:40', '09:20'],
    ['PERIOD', 'Period 3', 3, '09:20', '10:00'], ['BREAK', 'Short break', null, '10:00', '10:15'], ['PERIOD', 'Period 4', 4, '10:15', '10:55'], ['PERIOD', 'Period 5', 5, '10:55', '11:35'],
    ['LUNCH', 'Lunch', null, '11:35', '12:05'], ['PERIOD', 'Period 6', 6, '12:05', '12:45'], ['PERIOD', 'Period 7', 7, '12:45', '13:25'], ['PERIOD', 'Period 8', 8, '13:25', fri ? '14:05' : '14:00'],
    ...(fri ? [['ACTIVITY', 'Clubs', null, '14:05', '14:30'] as Row] : [])];
  const primary = (end7: string): Row[] => [['ASSEMBLY', 'Assembly', null, '07:40', '08:00'], ['PERIOD', 'Period 1', 1, '08:00', '08:40'], ['PERIOD', 'Period 2', 2, '08:40', '09:20'],
    ['PERIOD', 'Period 3', 3, '09:20', '10:00'], ['BREAK', 'Break', null, '10:00', '10:20'], ['PERIOD', 'Period 4', 4, '10:20', '11:00'], ['PERIOD', 'Period 5', 5, '11:00', '11:40'],
    ['LUNCH', 'Lunch', null, '11:40', '12:10'], ['PERIOD', 'Period 6', 6, '12:10', '12:50'], ['PERIOD', 'Period 7', 7, '12:50', end7]];
  const balvatika: Row[] = [['ASSEMBLY', 'Circle time', null, '08:30', '09:00'], ['PERIOD', 'Activity 1', 1, '09:00', '09:40'], ['PERIOD', 'Activity 2', 2, '09:40', '10:20'],
    ['BREAK', 'Snack and play', null, '10:20', '10:50'], ['PERIOD', 'Activity 3', 3, '10:50', '11:30'], ['PERIOD', 'Activity 4', 4, '11:30', '12:10'], ['ACTIVITY', 'Story time', null, '12:10', '12:30']];
  const seedBell = async (schoolId: string, name: string, classes: string[], day: (d: number) => Row[]) => {
    const b = await db.one<{ id: string }>(`insert into bell_schedule (school_id, name, class_codes, valid, created_by) values ($1, $2, $3, daterange('2026-04-01', null), $4) returning id`, [schoolId, name, classes, principal]);
    for (let d = 1; d <= 5; d++) for (const [i, [kind, label, pn, a, z]] of day(d).entries()) {
      await db.query(`insert into bell_slot (schedule_id, weekday, seq, kind, label, period_no, starts, ends) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [b.id, d, i + 1, kind, label, pn, a, z]);
    }
  };
  {
    await seedBell(school['NCS-MB'].id, 'Classes VI–XII', ['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'], (d) => senior(d === 5));
    await seedBell(school['NCS-MB'].id, 'Classes I–II', ['I', 'II'], () => primary('13:30'));
    await seedBell(school['NCS-MB'].id, 'Classes III–V', ['III', 'IV', 'V'], () => primary('13:45'));
    await seedBell(school['NCS-MB'].id, 'Bal Vatika', ['BV1', 'BV2', 'BV3'], () => balvatika);
    for (const [code, s2] of Object.entries(school)) {
      if (code === 'NCS-MB') continue;
      const classes = (await db.query<{ class_code: string }>(`select distinct s.class_code from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1`, [s2.id])).map((r) => r.class_code);
      await seedBell(s2.id, 'School timings', classes, (d) => senior(d === 5));
    }
  }

  // Teaching load for VIII-A, VIII-B and X-A, and their timetables built by the generator.
  const LOAD: Record<string, [string, number][]> = {
    VIII: [['MAT', 7], ['ENG', 6], ['SCI', 6], ['HIN', 5], ['SST', 5], ['SAN', 3], ['CS', 3], ['PE', 2], ['LIB', 1]],
    X: [['MAT', 7], ['ENG', 6], ['SCI', 7], ['HIN', 5], ['SST', 6], ['CS', 4], ['PE', 2], ['LIB', 1]],
  };
  const demoSecs = [mbSec('VIII', 0), mbSec('VIII', 1), mbSec('X', 0)];
  for (const [i, sec] of demoSecs.entries()) {
    await generator.saveLoad(db, p0, sec, LOAD[i < 2 ? 'VIII' : 'X'].map(([code, n]) => ({ subjectCode: code, teacherId: subjectTeacher[code] ?? null, periodsPerWeek: n, maxPerDay: n > 5 ? 2 : 1 })));
  }
  const proposal = await generator.generate(db, p0, mb0, { sectionIds: demoSecs, from: '2026-04-01' });
  if (!proposal.complete) console.log(`Generator: ${proposal.note}`);
  await generator.publishProposal(db, p0, mb0, { from: '2026-04-01', sections: proposal.sections.map((x) => ({ sectionId: x.sectionId, slots: x.slots })) });

  // Attendance: the last ten school days for the demo sections, and the last school day for all of Mumbai.
  const schoolDays: string[] = [];
  for (let d = 0; schoolDays.length < 10; d++) {
    const day = new Date(Date.now() - d * 864e5);
    if (day.getDay() !== 0) schoolDays.push(day.toISOString().slice(0, 10));
  }
  const mbSections = await db.query<{ id: string }>(`select s.id from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1`, [school['NCS-MB'].id]);
  const demoSections = new Set([mbSec('VIII', 1), mbSec('X', 0), sectionIds[`${kgCampus}:BV2`][0]]);
  for (const s of mbSections) {
    const roll = await db.query<{ id: string }>(`select id from enrolment where section_id = $1 and status = 'ACTIVE'`, [s.id]);
    for (const day of demoSections.has(s.id) ? schoolDays : schoolDays.slice(0, 1)) {
      const absent = roll.filter(() => rnd() < 0.05).map((r) => ({ enrolmentId: r.id, status: (rnd() < 0.3 ? 'L' : 'A') as 'A' | 'L' }));
      await attendance.mark(db, p0, s.id, day, absent);
    }
  }
  const t = await A(teacher);
  const viiib = sectionIds[`${school['NCS-MB'].campus}:VIII`][1];
  const th = await messaging.createThread(db, t, { sectionId: viiib, subject: 'Annual Day rehearsal', body: 'Annual Day rehearsal on Saturday 18 October, 8:00 am to 12 noon. Will your child attend?', replyMode: 'REQUIRED', options: ['Yes', 'No'] });
  await messaging.reply(db, await A(rohan.id), th.threadId, { choice: 'Yes', body: 'Yes, he will attend. Can he leave by 11:30 for a medical appointment?', studentId: mehta.studentIds[0] });
  const others = await db.query<{ student_id: string; guardian_id: string }>(`select student_id, guardian_id from thread_recipient where thread_id = $1 and guardian_id <> $2 limit 9`, [th.threadId, mehta.guardianId]);
  for (const o of others) {
    const u = (await db.maybeOne<{ id: string }>(`select id from app_user where guardian_id = $1`, [o.guardian_id])) ?? await db.one<{ id: string }>(`insert into app_user (name, role, guardian_id) values ('Parent', 'PARENT', $1) returning id`, [o.guardian_id]);
    await messaging.reply(db, await A(u.id), th.threadId, { choice: rnd() < 0.85 ? 'Yes' : 'No', studentId: o.student_id });
  }

  // Pending admissions at Mumbai, including a Cat 1 child for a full class.
  const apps = [
    { cls: 'III', name: 'Ira Deshmukh', dob: '2018-03-02', g: 'Lt Nikhil Deshmukh', svc: { service: 'NAVY', status: 'SERVING', rankCode: 'N_LT', postedInStation: true } },
    { cls: 'VI', name: 'Neel Pillai', dob: '2015-06-11', g: 'Mr Ajay Pillai', svc: { service: 'DEF_CIV_NAVY', status: 'SERVING', postedInStation: true } },
    { cls: 'I', name: 'Myra Thomas', dob: '2020-01-19', g: 'Mr Joseph Thomas', svc: { service: 'CIVILIAN', status: 'NONE' } },
    { cls: 'IV', name: 'Atharv Patil', dob: '2017-09-30', g: 'CPO Mahesh Patil', svc: { service: 'NAVY', status: 'ESM_PENSION', rankCode: 'N_CPO' } },
  ];
  for (const a of apps) {
    await admissions.submitApplication(db, p0, { campusId: school['NCS-MB'].campus, academicYear: YEAR, classCode: a.cls, child: { name: a.name, dob: a.dob, gender: rnd() < 0.5 ? 'F' : 'M' },
      guardian: { name: a.g, phone: nextPhone() }, relationship: 'FATHER', service: a.svc });
  }
  // Take the Cat 1 application for full Class III all the way: verify, offer over capacity, admit provisionally.
  const ira = await db.one<{ id: string }>(`select id from application where child_name = 'Ira Deshmukh'`);
  const detail = await admissions.applicationDetail(db, p0, ira.id);
  for (const d of detail.documents as { doc_type: string }[]) await admissions.verifyDocument(db, p0, ira.id, d.doc_type, 'VERIFIED');
  await admissions.offerSeat(db, p0, ira.id, 'Cat 1: father posted to Mumbai; Cat 1 children are not refused');
  await admissions.admit(db, p0, ira.id, { provisional: true, tcDueDate: '2026-10-05' });
  const neel = await db.one<{ id: string }>(`select id from application where child_name = 'Neel Pillai'`);
  for (const d of (await admissions.applicationDetail(db, p0, neel.id)).documents as { doc_type: string }[]) await admissions.verifyDocument(db, p0, neel.id, d.doc_type, 'VERIFIED');
  void accountant;

  // ── R2: school life ──
  const nesUnit = (await db.one<{ id: string }>(`select id from org_unit where code = 'NES'`)).id;
  const wncUnit = (await db.one<{ id: string }>(`select id from org_unit where code = 'WNC'`)).id;
  const mb = school['NCS-MB'].id;
  const nes1 = await A(nesAdmin);
  const plus = (n: number) => daysFromToday(n);

  // Calendar: NES-wide holidays and Mumbai's own vacations and events (from the school's holiday list).
  for (const [unit, title, kind, from, to] of [
    [nesUnit, 'Dussehra', 'HOLIDAY', '2026-10-20', '2026-10-20'], [nesUnit, 'Guru Nanak Jayanti', 'HOLIDAY', '2026-11-24', '2026-11-24'],
    [nesUnit, 'Christmas', 'HOLIDAY', '2026-12-25', '2026-12-25'], [nesUnit, 'Republic Day', 'HOLIDAY', '2027-01-26', '2027-01-26'],
    [mb, 'Autumn break', 'VACATION', '2026-10-16', '2026-10-23'], [mb, 'Diwali break', 'VACATION', '2026-11-06', '2026-11-09'],
    [mb, 'Bhaidooj', 'HOLIDAY', '2026-11-11', '2026-11-11'], [mb, 'Winter break', 'VACATION', '2026-12-24', '2027-01-02'],
    [mb, 'Parent–teacher meeting, Classes VI–VIII', 'PTM', '2026-10-31', '2026-10-31'], [mb, 'Pre-board examinations, X and XII', 'EXAM', '2026-12-08', '2026-12-19'],
    [mb, 'Annual Day · Kala Utsav', 'EVENT', '2026-11-20', '2026-11-21'],
  ] as const) await notices.addEvent(db, unit === nesUnit ? nes1 : p0, { unitId: unit, title, kind, from, to });

  // Notices from NES, the Command and the school. Some are public and appear on the website.
  await notices.create(db, nes1, { unitId: nesUnit, title: 'NES Inter-School Science Exhibition 2026', body: 'Schools may nominate up to three projects per category by 15 November. The exhibition will be held at NCS Visakhapatnam in December.', kind: 'CIRCULAR', audience: 'ALL', isPublic: true });
  await notices.create(db, await A((await db.one<{ id: string }>(`select id from app_user where role = 'COMMAND_OFFICER' limit 1`)).id),
    { unitId: wncUnit, title: 'WNC inter-school athletics meet', body: 'Trials for the WNC athletics meet will be held in each school in the first week of November.', kind: 'NOTICE', audience: 'ALL' });
  await notices.create(db, p0, { unitId: mb, title: 'Autumn break, 16–23 October', body: 'School is closed for the autumn break from 16 to 23 October. Classes resume on Saturday, 24 October.', kind: 'NOTICE', audience: 'ALL', isPublic: true });
  await notices.create(db, p0, { unitId: mb, title: 'Parent–teacher meeting on 31 October', body: 'PTM for Classes VI to VIII on Saturday 31 October, 8:30 am to 12:30 pm. Half-yearly answer scripts will be shown.', kind: 'EVENT', audience: 'PARENTS', classCodes: ['VI', 'VII', 'VIII'], isPublic: false });
  await notices.create(db, p0, { unitId: mb, title: 'Health and wellness workshop for teachers', body: 'Hosted by CBSE in the Samvad Auditorium, 29–30 August.', kind: 'NOTICE', audience: 'STAFF' });

  // Homework for VIII-B and X-A, set by their teachers through the real path.
  const hw = async (teacherId: string, sec: string, subjectCode: string, title: string, details: string, due: number) =>
    homework.create(db, await A(teacherId), { sectionId: sec, subjectCode, title, details, dueOn: plus(due) });
  await hw(teacher, mbSec('VIII', 1), 'MAT', 'Exercise 6.3, questions 1–12', 'Squares and square roots. Show all working in the notebook.', 1);
  await hw(subjectTeacher.ENG, mbSec('VIII', 1), 'ENG', 'Read chapter 5 and write a summary', 'About 150 words, in your own words.', 2);
  await hw(subjectTeacher.SCI, mbSec('VIII', 1), 'SCI', 'Draw and label a plant cell', 'Use a pencil; colour optional.', 3);
  await hw(subjectTeacher.SST, mbSec('VIII', 1), 'SST', 'Map work: rivers of India', 'Mark the ten major rivers on the outline map.', 5);
  await hw(teacher, mbSec('X', 0), 'MAT', 'Sample paper 2, section B', 'Attempt in 45 minutes.', 2);
  await hw(subjectTeacher.SCI, mbSec('X', 0), 'SCI', 'Revise chemical reactions', 'Balance the 20 equations on the worksheet.', 3);

  // Leave: Aarav's request (waiting), a classmate's (approved) and another waiting for Mrs Kulkarni.
  const aarav = mehta.studentIds[0];
  const rohanA = await A(rohan.id);
  const l1 = await leave.apply(db, rohanA, { studentId: aarav, from: plus(9), to: plus(10), reason: 'Family function in Pune' });
  void l1;
  const classmate = await db.one<{ student_id: string; guardian_id: string }>(
    `select e.student_id, sg.guardian_id from enrolment e join student_guardian sg on sg.student_id = e.student_id
      where e.section_id = $1 and e.student_id <> $2 and e.status = 'ACTIVE' order by e.admission_no limit 1`, [mbSec('VIII', 1), aarav]);
  const cmUser = (await db.maybeOne<{ id: string }>(`select id from app_user where guardian_id = $1`, [classmate.guardian_id]))
    ?? await db.one<{ id: string }>(`insert into app_user (name, role, guardian_id) values ('Parent', 'PARENT', $1) returning id`, [classmate.guardian_id]);
  const l2 = await leave.apply(db, await A(cmUser.id), { studentId: classmate.student_id, from: plus(1), to: plus(2), reason: 'Fever, doctor advised rest' });
  await leave.decide(db, t, l2.id, true, 'Get well soon');
  const classmate2 = await db.one<{ student_id: string; guardian_id: string }>(
    `select e.student_id, sg.guardian_id from enrolment e join student_guardian sg on sg.student_id = e.student_id
      where e.section_id = $1 and e.student_id not in ($2, $3) and e.status = 'ACTIVE' order by e.admission_no limit 1`, [mbSec('VIII', 1), aarav, classmate.student_id]);
  const cm2 = (await db.maybeOne<{ id: string }>(`select id from app_user where guardian_id = $1`, [classmate2.guardian_id]))
    ?? await db.one<{ id: string }>(`insert into app_user (name, role, guardian_id) values ('Parent', 'PARENT', $1) returning id`, [classmate2.guardian_id]);
  await leave.apply(db, await A(cm2.id), { studentId: classmate2.student_id, from: plus(3), to: plus(3), reason: 'Sister’s wedding' });
  // Five days for chickenpox: certificate attached, the class teacher has approved, now with the principal.
  const l3 = await leave.apply(db, await A(cmUser.id), { studentId: classmate.student_id, from: plus(4), to: plus(8), reason: 'Chickenpox, doctor advised five days at home' });
  await attachments.upload(db, await A(cmUser.id), { refKind: 'leave', refId: l3.id, name: 'medical-certificate.pdf', dataBase64: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64') });
  await leave.decide(db, t, l3.id, true, 'Certificate seen');

  // Websites: NCS Mumbai with its full content; every other school from the starter template.
  for (const s2 of Object.values(school)) {
    const d = await site.draft(db, nes1, s2.id);
    if (s2.id === mb) {
      await db.tx((tx) => tx.query(`update site set slug = 'ncs-mumbai' where school_id = $1`, [mb]), { actor: 'seed' });
      const saved = await site.save(db, p0, mb, d.draftVersion, ncsMumbaiSite());
      await site.publish(db, p0, mb, saved.draftVersion, 'Website launched with content from the school');
    } else {
      await site.publish(db, nes1, s2.id, d.draftVersion, 'Starter website');
    }
  }
  await site.enquire(db, 'ncs-mumbai', { name: 'Asha Menon', phone: '+919820011122', topic: 'Admissions', message: 'My husband has been posted to Mumbai in December. Is there a seat in Class III for our daughter?' });
  // Cover: Mr Faisal Khan is absent today, so his lessons need cover (try Timetable → Cover → Fill automatically).
  if (![0, 6].includes(new Date().getDay())) {
    await cover.markAbsent(db, p0, { schoolId: mb, teacherId: subjectTeacher.SST, from: TODAY, to: TODAY, reason: 'Medical leave' });
  }
  // Special days after the autumn break.
  for (const plan of [
    { date: '2026-10-29', classCodes: ['VI', 'VII', 'VIII', 'IX'], kind: 'EVENT' as const, title: 'Annual Day rehearsal', cancelledPeriods: [7, 8] },
    { date: '2026-10-30', classCodes: null, kind: 'SHORT_DAY' as const, title: 'Short day before the PTM', shortDay: { firstStart: '08:00', minutes: 30, periods: 6, breakAfter: 3, breakMinutes: 15 } },
  ]) if (plan.date >= TODAY) await cover.addDayPlan(db, p0, { schoolId: mb, ...plan });
  // Settings at each level: NES fixes the 75% attendance rule for every school; the Western
  // Command allows three days for corrections; NCS Mumbai allows at most two homework a day.
  const wncOfficer = await A((await db.one<{ id: string }>(`select id from app_user where role = 'COMMAND_OFFICER' and scope_path = 'nes.wnc'`)).id);
  await settings.set(db, nes1, nes, { key: 'attendance.min_percent', value: 75, from: TODAY, locked: true });
  await settings.set(db, wncOfficer, cmd.WNC, { key: 'attendance.correction_days', value: 3, from: TODAY });
  await settings.set(db, p0, mb, { key: 'homework.max_due_per_day', value: 2, from: TODAY });
  // Duties: Mrs Kulkarni runs the timetable and cover, Mrs Kapoor edits the website, Mrs Iyer the exams.
  await duties.assign(db, p0, mb, { userId: teacher, code: 'TIMETABLE_COORDINATOR', from: TODAY });
  await duties.assign(db, p0, mb, { userId: subjectTeacher.CS, code: 'WEBSITE_EDITOR', from: TODAY });
  await duties.assign(db, p0, mb, { userId: subjectTeacher.SCI, code: 'EXAM_INCHARGE', from: TODAY });
  // A late attendance correction waiting for the principal: the latest roll older than the window.
  const sess = await db.maybeOne<{ id: string; on: string }>(
    `select s.id, s.on_date::text as on from attendance_session s where s.section_id = $1 and s.on_date < current_date - 4
        and exists (select 1 from attendance_mark m where m.session_id = s.id and m.status = 'A') order by s.on_date desc limit 1`, [mbSec('VIII', 1)]);
  const old = sess?.on ?? '';
  {
    if (sess) {
      // The parent sent a leave note late: one absence becomes leave; the rest of the roll stays as it was.
      const marks = await db.query<{ id: string; status: 'A' | 'L' }>(`select enrolment_id as id, status from attendance_mark where session_id = $1 and status in ('A', 'L') order by enrolment_id`, [sess.id]);
      const i = marks.findIndex((m) => m.status === 'A');
      if (i >= 0) await attendance.mark(db, await A(teacher), mbSec('VIII', 1), old, marks.map((m, j) => ({ enrolmentId: m.id, status: j === i ? 'L' as const : m.status })));
    }
  }
  // Additional charges: CBSE registration for IX and XI (compulsory), and a Class VIII trip (optional).
  const acc = await A(accountant);
  const cbse = await charges.draft(db, acc, { schoolId: mb, year: YEAR, head: 'CBSE', title: 'CBSE registration, Classes IX and XI', details: 'Registration for the 2027–28 board examinations. Collected for CBSE and paid to CBSE.',
    amountPaise: 30000, mode: 'COMPULSORY', classCodes: ['IX', 'XI'], dueOn: plus(25) });
  await charges.approve(db, p0, cbse.id);
  const trip = await charges.draft(db, acc, { schoolId: mb, year: YEAR, head: 'TRIP', title: 'Science trip to Nehru Science Centre, Worli', details: 'Day trip by school bus, 8:00 to 2:30. Packed lunch included.',
    amountPaise: 85000, mode: 'OPTIONAL', classCodes: ['VIII'], dueOn: plus(21), respondBy: plus(14), capacity: 40, refundableUntil: plus(16), inChargeId: teacher });
  await charges.approve(db, p0, trip.id);
  const viii = await db.query<{ student_id: string }>(`select e.student_id from enrolment e where e.section_id = $1 and e.status = 'ACTIVE' and e.student_id <> $2 order by e.admission_no limit 6`, [mbSec('VIII', 1), mehta.studentIds[0]]);
  const ta = await A(teacher);
  for (const [i, k] of viii.entries()) await charges.respond(db, ta, trip.id, k.student_id, i !== 2, 'Paper slip');
  // Printing, library, cards and certificates at NCS Mumbai.
  await db.tx((t) => t.query(`update org_unit set city = 'Mumbai', phone = '82916 14970', email = 'prin.ncs.mb@gmail.com', website = 'www.ncsmumbai.edu.in', school_no = '30245',
    address = 'Block VII, Navy Nagar, Colaba, Mumbai 400005' where id = $1`, [mb]), { actor: 'seed' });
  // Staff: one record each, from which the ID cards, payroll, leave and chat all read.
  // ── R4: staff, pay and leave (NCS Mumbai keeps its own) ──
  // Mumbai's own structures: regular staff on a pay scale, contract teachers on consolidated pay,
  // guest teachers per period, support staff on daily wages. The accountant proposes; the principal approves.
  await settings.set(db, p0, mb, { key: 'payroll.pt_state', value: 'MH', from: TODAY });
  const FROM = '2026-04-01';
  const comp = async (structureId: string, c: Partial<staff.ComponentInput> & { code: string; name: string; calc: staff.ComponentInput['calc'] }) => {
    const r = await staff.proposeComponent(db, acc, structureId, { kind: 'EARNING', taxable: true, pfWage: false, prorate: true, ordinal: 1, from: FROM, ...c });
    await staff.decideComponent(db, p0, r.id, true);
  };
  const regular = (await staff.createStructure(db, acc, mb, { name: 'Regular staff', description: 'Permanent teaching and office staff on the school’s pay scales', pf: 'CEILING', esi: true, pt: true, tds: true })).id;
  await comp(regular, { code: 'BASIC', name: 'Basic pay', calc: 'BASE', pfWage: true, ordinal: 1 });
  await comp(regular, { code: 'DA', name: 'Dearness allowance', calc: 'PERCENT', percent: 55, ofCodes: ['BASIC'], pfWage: true, ordinal: 2 });
  await comp(regular, { code: 'HRA', name: 'House rent allowance', calc: 'PERCENT', percent: 9, ofCodes: ['BASIC'], ordinal: 3 });
  await comp(regular, { code: 'TA', name: 'Transport allowance', calc: 'FLAT', amountPaise: 360000, ordinal: 4 });
  const contractS = (await staff.createStructure(db, acc, mb, { name: 'Contract teachers', description: 'Fixed-term teachers on consolidated pay', pf: 'ACTUAL', esi: true, pt: true, tds: true })).id;
  await comp(contractS, { code: 'CONSOLIDATED', name: 'Consolidated pay', calc: 'BASE', pfWage: true });
  const guestS = (await staff.createStructure(db, acc, mb, { name: 'Guest teachers per period', description: 'Paid for the periods taught in the month', pf: 'NONE', esi: false, pt: true, tds: true })).id;
  await comp(guestS, { code: 'PERIODS', name: 'Periods taught', calc: 'PER_UNIT', unit: 'PERIODS', amountPaise: 45000, prorate: false });
  const dailyS = (await staff.createStructure(db, acc, mb, { name: 'Support staff daily wage', description: 'Gardeners, helpers and sweepers paid by the day', pf: 'CEILING', esi: true, pt: true, tds: false })).id;
  await comp(dailyS, { code: 'WAGES', name: 'Daily wages', calc: 'PER_UNIT', unit: 'DAYS_PRESENT', amountPaise: 75000, pfWage: true, prorate: false });
  // A DA rise from July, proposed and waiting for the principal: approving it offers an arrears run.
  await staff.proposeComponent(db, acc, regular, { code: 'DA', name: 'Dearness allowance', kind: 'EARNING', calc: 'PERCENT', percent: 58, ofCodes: ['BASIC'], taxable: true, pfWage: true, prorate: true, ordinal: 2, from: '2026-07-01' });
  const scale = async (name: string, start: number) => {
    const steps = Array.from({ length: 12 }, (_, i) => Math.round((start * 1.03 ** i) / 100) * 10000);
    const r = await staff.addScale(db, acc, mb, { name, stepsPaise: steps, incrementMonth: 7, from: FROM });
    await staff.approveScale(db, p0, r.id);
    return r.id;
  };
  const lv = { 12: await scale('Level 12 (principal)', 78800), 8: await scale('Level 8 (PGT)', 47600), 7: await scale('Level 7 (TGT)', 44900), 6: await scale('Level 6 (accountant, superintendent)', 35400), 2: await scale('Level 2 (laboratory attendant)', 19900) };

  // Sanctioned posts, by the NES order for Mumbai's strength.
  const posts: Record<string, string[]> = {};
  for (const [type, n, level] of [['PRINCIPAL', 1, 12], ['PGT', 3, 8], ['TGT', 8, 7], ['OFFICE_SUPDT', 1, 6], ['ACCOUNTANT', 1, 6], ['LAB_ATTENDANT', 2, 2], ['SUPPORT', 4, 1]] as const) {
    await staff.addPost(db, p0, mb, { postType: type, payLevel: level, from: FROM, orderRef: 'NES/EST/NCS-MB/2026/14', count: n });
    posts[type] = (await db.query<{ id: string }>(`select id from post where school_id = $1 and post_type = $2 order by created_at, id`, [mb, type])).map((x) => x.id);
  }
  const people = new Map<string, string>();
  const sup = await user('Mrs Shobha Kadam', 'STAFF', 'Office superintendent', 'nes.wnc.ncs_mb');
  const staffList: { id?: string; name?: string; desig?: string; cat: 'TEACHING' | 'NON_TEACHING'; emp: string; joined: string; until?: string; gender: 'F' | 'M'; post?: string;
    pay: { s: string; scale?: string; step?: number; base?: number }; pan?: string; uan?: string }[] = [
    { id: principal, cat: 'TEACHING', emp: 'PERMANENT', joined: '2004-07-01', gender: 'F', post: 'PRINCIPAL', pay: { s: regular, scale: lv[12], step: 8 }, pan: 'AKPPR4821K', uan: '100234567811' },
    { id: accountant, cat: 'NON_TEACHING', emp: 'PERMANENT', joined: '2012-08-01', gender: 'M', post: 'ACCOUNTANT', pay: { s: regular, scale: lv[6], step: 6 }, pan: 'BQSPS7712M', uan: '100234567812' },
    { id: sup, cat: 'NON_TEACHING', emp: 'PERMANENT', joined: '2009-06-15', gender: 'F', post: 'OFFICE_SUPDT', pay: { s: regular, scale: lv[6], step: 8 }, uan: '100234567813' },
    { id: teacher, cat: 'TEACHING', emp: 'PERMANENT', joined: '2014-07-01', gender: 'F', post: 'TGT', pay: { s: regular, scale: lv[7], step: 5 }, pan: 'CKLPK3301Q', uan: '100234567814' },
    { id: subjectTeacher.ENG, cat: 'TEACHING', emp: 'PERMANENT', joined: '2016-07-01', gender: 'M', post: 'TGT', pay: { s: regular, scale: lv[7], step: 4 }, uan: '100234567815' },
    { id: subjectTeacher.HIN, cat: 'TEACHING', emp: 'PERMANENT', joined: '2011-07-01', gender: 'F', post: 'TGT', pay: { s: regular, scale: lv[7], step: 7 }, uan: '100234567816' },
    { id: subjectTeacher.SCI, cat: 'TEACHING', emp: 'PERMANENT', joined: '2018-07-01', gender: 'F', post: 'TGT', pay: { s: regular, scale: lv[7], step: 3 }, uan: '100234567817' },
    { id: subjectTeacher.SST, cat: 'TEACHING', emp: 'PERMANENT', joined: '2019-07-01', gender: 'M', post: 'TGT', pay: { s: regular, scale: lv[7], step: 2 } },
    { id: subjectTeacher.SAN, cat: 'TEACHING', emp: 'CONTRACT', joined: '2026-04-01', until: '2027-03-31', gender: 'M', post: 'TGT', pay: { s: contractS, base: 3500000 } },
    { id: subjectTeacher.CS, cat: 'TEACHING', emp: 'CONTRACT', joined: '2025-06-01', until: '2026-11-30', gender: 'F', post: 'PGT', pay: { s: contractS, base: 4200000 } },
    { id: subjectTeacher.PE, cat: 'TEACHING', emp: 'TEMPORARY', joined: '2026-06-15', until: '2027-04-30', gender: 'M', post: 'PGT', pay: { s: contractS, base: 3800000 } },
    { name: 'Mr Nitin Rane', desig: 'Guest teacher, Music', cat: 'TEACHING', emp: 'GUEST', joined: '2026-07-01', gender: 'M', pay: { s: guestS } },
    { name: 'Ms Farah Sayed', desig: 'Guest teacher, French', cat: 'TEACHING', emp: 'GUEST', joined: '2026-07-01', gender: 'F', pay: { s: guestS } },
    { name: 'Mr Suresh More', desig: 'Laboratory attendant', cat: 'NON_TEACHING', emp: 'PERMANENT', joined: '2017-03-01', gender: 'M', post: 'LAB_ATTENDANT', pay: { s: regular, scale: lv[2], step: 5 } },
    { name: 'Mr Ganesh Patil', desig: 'Gardener', cat: 'NON_TEACHING', emp: 'DAILY_WAGE', joined: '2024-01-10', gender: 'M', post: 'SUPPORT', pay: { s: dailyS } },
    { name: 'Mrs Lakshmi Gaikwad', desig: 'Helper, Foundation Wing', cat: 'NON_TEACHING', emp: 'DAILY_WAGE', joined: '2025-06-01', gender: 'F', post: 'SUPPORT', pay: { s: dailyS } },
    { name: 'Sister Annamma Joseph', desig: 'School nurse', cat: 'NON_TEACHING', emp: 'CONTRACT', joined: '2023-06-01', until: '2027-05-31', gender: 'F', pay: { s: contractS, base: 2800000 } },
    { name: 'Mr Bahadur Thapa', desig: 'Security guard, main gate', cat: 'NON_TEACHING', emp: 'DAILY_WAGE', joined: '2022-02-01', gender: 'M', post: 'SUPPORT', pay: { s: dailyS } },
  ];
  let acctNo = 30010045001;
  const BLOOD = ['O+', 'B+', 'A+', 'AB+', 'O-', 'B-'];
  for (const [i, x] of staffList.entries()) {
    // One step per person: their record, post, pay and identity numbers. Designations are worked out from the post, the subject taught and the class.
    const e = await staff.enrol(db, p0, mb, { userId: x.id, name: x.name, title: x.desig, category: x.cat, employment: x.emp, gender: x.gender, joinedService: x.joined, contractUntil: x.until ?? null,
      orderRef: `NCS-MB/EST/${x.joined.slice(0, 4)}/${i + 1}`, ...(x.emp === 'PERMANENT' && x.joined > '2025-01-01' ? { probationUntil: addDays(x.joined, 730) } : {}),
      phone: `98${String(20110000 + i * 7919).padStart(8, '0')}`, dob: `${1968 + (i * 3) % 30}-${String(1 + (i * 5) % 12).padStart(2, '0')}-${String(1 + (i * 11) % 28).padStart(2, '0')}`,
      employeeNo: `MB-${101 + i}`, bloodGroup: BLOOD[i % BLOOD.length], emergencyContact: `Family, 98${String(30110000 + i * 7919).padStart(8, '0')}`,
      postId: x.post ? posts[x.post].shift() ?? null : null,
      pay: { structureId: x.pay.s, scaleId: x.pay.scale ?? null, step: x.pay.step ?? null, basePaise: x.pay.base ?? null, from: x.joined > FROM ? x.joined : FROM },
      identity: { pan: x.pan, uan: x.uan ?? null } });
    people.set(x.name ?? x.id!, e.userId);
    // Salary accounts, verified long ago by a second person.
    const holder = (await db.one<{ name: string }>('select name from app_user where id = $1', [e.userId])).name;
    const no = String(acctNo++);
    await db.tx((t2) => t2.query(`insert into employee_bank (user_id, account_last4, account_cipher, ifsc, bank_name, holder_name, status, requested_by, requested_at, verified_by, verified_at)
      values ($1, $2, $3, 'SBIN0000534', 'State Bank of India, Colaba', $4, 'VERIFIED', $5, $6::date, $7, $6::date + 1)`,
      [e.userId, last4(no), seal(no), holder.replace(/^(Mr|Mrs|Ms|Dr) /, ''), e.userId, x.joined > FROM ? x.joined : FROM, e.userId === principal ? accountant : principal]), { actor: 'seed' });
  }
  await duties.assign(db, p0, mb, { userId: sup, code: 'STAFF_RECORDS', from: TODAY });
  const ganesh = people.get('Mr Ganesh Patil')!, nitin = people.get('Mr Nitin Rane')!, farah = people.get('Ms Farah Sayed')!;
  // A bank change asked for in the staff app, waiting for the accountant to verify.
  await staff.requestBank(db, await A(subjectTeacher.SCI), subjectTeacher.SCI, { account: '50100234998877', ifsc: 'HDFC0000060', bankName: 'HDFC Bank, Colaba', holderName: 'Meena Iyer' });

  // Leave: the year's credit, some leave taken, a request waiting for the principal.
  await staffLeave.creditYear(db, p0, mb, Number(TODAY.slice(0, 4)));
  const cur = TODAY.slice(0, 8) + '01', prev = addDays(cur, -1).slice(0, 8) + '01', prevEnd = addDays(cur, -1);
  await staffLeave.apply(db, await A(subjectTeacher.HIN), { leaveCode: 'CL', from: daysFromToday(6), to: daysFromToday(7), reason: 'Family wedding in Pune' });
  const elReq = await staffLeave.apply(db, await A(subjectTeacher.ENG), { leaveCode: 'EL', from: daysFromToday(20), to: daysFromToday(24), reason: 'Travelling home to Goa' }) as { id: string };
  await staffLeave.decide(db, p0, elReq.id, true);

  // The staff register: last month in full, this month up to yesterday. A few absences without leave.
  const everyone = [...people.values()];
  const markMonth = async (from: string, to: string) => {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) continue;
      const absent = (u: string) => (u === ganesh && ['08', '19'].includes(d.slice(8, 10))) || (u === subjectTeacher.SST && d.slice(8, 10) === '12');
      await staffLeave.mark(db, p0, mb, d, everyone.map((u) => ({ userId: u, status: absent(u) ? 'A' as const : 'P' as const })));
    }
  };
  await markMonth(prev, prevEnd);
  if (addDays(TODAY, -1) >= cur) await markMonth(cur, addDays(TODAY, -1));
  await payroll.setInputs(db, acc, mb, prev, [{ userId: nitin, unit: 'PERIODS', quantity: 48 }, { userId: farah, unit: 'PERIODS', quantity: 36 }]);
  await payroll.setInputs(db, acc, mb, cur, [{ userId: nitin, unit: 'PERIODS', quantity: 30, note: 'Up to the 20th' }]);

  // An advance to the gardener before Diwali, recovered from this month.
  const loan = await staff.proposeLoan(db, acc, ganesh, { kind: 'FESTIVAL', principalPaise: 600000, instalmentPaise: 150000, firstMonth: cur, note: 'Diwali advance' });
  await staff.decideLoan(db, p0, loan.id, true);

  // Last month: prepared by the accountant, approved by the principal, paid by the bank.
  const runPrev = await payroll.createRun(db, acc, mb, prev);
  await payroll.submit(db, acc, runPrev.id);
  await payroll.approve(db, p0, runPrev.id);
  await payroll.bankFile(db, acc, runPrev.id);
  await payroll.markPaid(db, acc, runPrev.id, `SBI/UTR/${prev.slice(0, 7).replace('-', '')}/0045`);
  // This month: a draft the accountant is working on.
  await payroll.createRun(db, acc, mb, cur);
  await staff.setIdentity(db, acc, ganesh, { aadhaar: '234567890123' });
  // The school's books: its TAN, and September's bank statement as net banking exports it. Salaries,
  // the PF and ESI challans are matched to the books by themselves; the gateway's settlement of online
  // fees, bank charges and interest are left for the accountant to post.
  await org.updateSchoolDetails(db, p0, mb, { tan: 'MUMN12345A' });
  for (const [kind, codes] of [['PF', ['PF', 'ER_EPF', 'ER_EPS', 'ER_EDLI', 'ER_PF_ADMIN']], ['ESI', ['ESI', 'ER_ESI']], ['PT', ['PT']], ['TDS', ['TDS']]] as const) {
    const amt = (await db.one<{ a: number }>(`select coalesce(sum(amount_paise), 0)::int as a from payroll_line where run_id = $1 and code = any($2)`, [runPrev.id, codes])).a;
    if (amt > 0) await payroll.recordChallan(db, acc, mb, { kind, period: prev, amountPaise: amt, reference: `${kind}-CH-${prev.slice(0, 7).replace('-', '')}`, paidOn: addDays(prevEnd, 12) > TODAY ? TODAY : addDays(prevEnd, 12) });
  }
  {
    const book = await db.query<{ narration: string; amount: number; on: string }>(
      `select j.narration, sum(l.debit_paise - l.credit_paise)::int as amount, j.posted_on::text as on from journal j join journal_line l on l.journal_id = j.id and l.account_code = '1100'
        where j.school_id = $1 group by j.id order by j.posted_on, j.created_at`, [mb]);
    const clearing = (await db.one<{ b: number }>(`select coalesce(sum(l.debit_paise - l.credit_paise), 0)::int as b from journal_line l join journal j on j.id = l.journal_id where j.school_id = $1 and l.account_code = '1150'`, [mb])).b;
    let bal = 4_80_00_000_00;
    const dmy = (d: string) => d.split('-').reverse().join('/');
    const row = (d: string, narr: string, ref: string, amt: number) => { bal += amt; return `${dmy(d)},"${narr}",${ref},${amt < 0 ? (-amt / 100).toFixed(2) : ''},${amt > 0 ? (amt / 100).toFixed(2) : ''},${(bal / 100).toFixed(2)}`; };
    const ref = (n: string) => /\(([A-Z0-9/-]{6,})\)/.exec(n)?.[1] ?? '';
    const lines = [
      ...book.map((j) => row(j.on, `${j.amount < 0 ? 'NEFT DR' : 'CR'} ${ref(j.narration)} ${j.narration.slice(0, 24).toUpperCase()}`, ref(j.narration), j.amount)),
      ...(clearing > 0 ? [row(TODAY, 'RAZORPAY SOFTWARE PVT LTD SETTLEMENT', 'RZPSETL0918', Math.round(clearing * 0.6) - 4200)] : []),
      row(TODAY, 'SMS ALERT CHGS QTR INCL GST', '', -5900),
      row(TODAY, 'INT.PD 01-07-2026 TO 30-09-2026', '', 1_86_450_00),
    ];
    const csv = ['Txn Date,Narration,Ref No./Cheque No.,Withdrawal Amt.,Deposit Amt.,Closing Balance', `${dmy(FROM)},"OPENING BALANCE",,,,${(4_80_00_000_00 / 100).toFixed(2)}`, ...lines].join('\n');
    await accounts.importStatement(db, acc, mb, { bankLabel: 'State Bank of India, Colaba · current account', csv });
  }
  // Mrs Lakshmi Gaikwad (on the school's staff) is the attendant of R1: she sees the run in her app.
  {
    const lakshmi = people.get('Mrs Lakshmi Gaikwad')!;
    const c = (await transport.saveCrew(db, p0, mb, { userId: lakshmi, role: 'ATTENDANT', policeVerifiedOn: '2026-03-12' })).id;
    const r1 = await db.one<{ id: string; vehicle_id: string; driver_id: string; name: string }>(`select id, vehicle_id, driver_id, name from route where school_id = $1 and code = 'R1'`, [mb]);
    // R1 is followed on her phone: the stops' places are known, so arrivals are noticed by themselves.
    await transport.saveRoute(db, p0, mb, { id: r1.id, code: 'R1', name: r1.name, vehicleId: r1.vehicle_id, driverId: r1.driver_id, attendantId: c, tracking: 'PHONE' });
    for (const [seq, lat, lng] of [[1, 18.9010, 72.8125], [2, 18.9077, 72.8139], [3, 18.9140, 72.8255], [4, 18.9256, 72.8320]] as const)
      await db.tx((t2) => t2.query('update route_stop set lat = $3, lng = $4 where route_id = $1 and seq = $2', [r1.id, seq, lat, lng]), { actor: 'seed' });
    const la = await A(lakshmi);
    await transport.tripEvent(db, la, r1.id, { leg: 'MORNING', kind: 'DELAY', minutes: 12, note: 'Slow traffic near Colaba Causeway' });
    await transport.position(db, la, r1.id, { leg: 'MORNING', lat: 18.9046, lng: 72.8131 });       // between the first and second stops
    const r2stop = await db.one<{ id: string }>(`select s.id from route_stop s join route r on r.id = s.route_id where r.school_id = $1 and r.code = 'R2' and s.seq = 1`, [mb]);
    const mehtaParent = await db.one<{ id: string }>(`select id from app_user where guardian_id = $1`, [mehta.guardianId]);
    await transport.request(db, await A(mehtaParent.id), { studentId: mehta.studentIds[0], kind: 'CHANGE', pickupStopId: r2stop.id, dropStopId: r2stop.id, fromDate: daysFromToday(12), note: 'Moving to Cuffe Parade next month' });
  }
  console.log(`Staff and payroll done (${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const sec of (await db.query<{ id: string }>(`select s.id from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1`, [mb]))) await sections.assignRollNumbers(db, p0, sec.id);
  for (const [name, purpose, x] of [['Office laser printer', 'DOCUMENTS', 0], ['Library label printer (thermal, 50 × 25 mm)', 'LABELS', 0.5], ['ID card printer (PVC, CR80)', 'CARDS', -0.3]] as const) {
    await printing.savePrinter(db, p0, mb, { name, purpose, offsetX: x, offsetY: 0, scale: 100 });
  }
  await duties.assign(db, p0, mb, { userId: subjectTeacher.HIN, code: 'LIBRARIAN', from: TODAY });
  await duties.assign(db, p0, mb, { userId: accountant, code: 'ADMISSION_INCHARGE', from: TODAY });
  const lib = await A(subjectTeacher.HIN);
  for (const [title, author, publisher, call, subject, price, copies, isbn] of [
    ['Wings of Fire', 'A. P. J. Abdul Kalam', 'Universities Press', '920 KAL', 'Biography', 350, 4, '9788173711466'],
    ['Malgudi Days', 'R. K. Narayan', 'Indian Thought Publications', '823 NAR', 'Fiction', 250, 3, '9780143039655'],
    ['Godan', 'Munshi Premchand', 'Saraswati Press', '891.43 PRE', 'Hindi literature', 180, 3, null],
    ['The Discovery of India', 'Jawaharlal Nehru', 'Penguin', '954 NEH', 'History', 499, 2, '9780143031031'],
    ['Panchatantra', 'Vishnu Sharma', 'Rupa', '398.2 VIS', 'Stories', 195, 5, null],
    ['NCERT Science Class VIII', 'NCERT', 'NCERT', '507 NCE', 'Science', 65, 10, null],
    ['Ruskin Bond Children’s Omnibus', 'Ruskin Bond', 'Rupa', '823 BON', 'Fiction', 395, 3, '9788171672929'],
    ['India’s Naval Heritage', 'Indian Navy', 'Naval Headquarters', '359.00954 IND', 'Defence', 600, 2, null],
  ] as const) await library.addBook(db, lib, mb, { title, author, publisher, callNumber: call, subject, pricePaise: price * 100, copies, isbn: isbn ?? null, location: `Rack ${subject.slice(0, 1)}` });
  const aaravAdm = (await db.one<{ nes_id: string }>(`select nes_id from student where id = $1`, [mehta.studentIds[0]])).nes_id;
  await library.issue(db, lib, mb, { borrower: aaravAdm, barcodes: ['MB000001'] });
  const overdueKid = await db.one<{ admission_no: string; id: string }>(`select admission_no, id from enrolment where section_id = $1 and status = 'ACTIVE' order by admission_no offset 3 limit 1`, [mbSec('VIII', 1)]);
  // A book borrowed three weeks ago and now overdue.
  await db.tx(async (t) => {
    const copy = await t.one<{ id: string }>(`select id from library_copy where school_id = $1 and barcode = 'MB000005'`, [mb]);
    await t.query(`insert into library_loan (copy_id, school_id, enrolment_id, issued_on, due_on, issued_by) values ($1, $2, $3, current_date - 20, current_date - 6, $4)`, [copy.id, mb, overdueKid.id, subjectTeacher.HIN]);
    await t.query(`update library_copy set status = 'ON_LOAN' where id = $1`, [copy.id]);
  }, { actor: 'seed' });
  // Labels for the first shelf are printed; the rest are waiting.
  await db.tx((t) => t.query(`update library_copy set label_printed_at = now() where school_id = $1 and accession_no <= 12`, [mb]), { actor: 'seed' });
  // A parent asks for a bonafide certificate; the office has CEA drafts ready for VIII-B.
  await certificates.request(db, rohanA, { studentId: mehta.studentIds[0], kind: 'BONAFIDE', purpose: 'Passport application' });
  await certificates.prepareBulk(db, await A(accountant), mb, { kind: 'CEA', sectionIds: [mbSec('VIII', 1)] });
  // Certificates already issued this year, for the register and its downloads: transfer
  // certificates for children whose fees are clear (one of them to NCS Kochi, which moves the
  // child there), and bonafide certificates.
  const clear = await db.query<{ student_id: string; enrolment_id: string }>(
    `select e.student_id, e.id as enrolment_id from enrolment e where e.school_id = $1 and e.status = 'ACTIVE' and e.class_code in ('X', 'XII', 'VII')
       and not exists (select 1 from library_loan l where l.enrolment_id = e.id and l.returned_on is null)
     order by e.class_code, e.admission_no limit 6`, [mb]);
  // Their families clear what is due at the fee counter first.
  for (const k of clear) {
    const bills = await db.query<{ bill: string }>(`select bill from fee_due where enrolment_id = $1 group by bill having sum(owed_paise - paid_paise) > 0`, [k.enrolment_id]);
    if (!bills.length) continue;
    const o = await payments.createOrder(db, acc, { studentId: k.student_id, method: 'CASH', idempotencyKey: `seed-clear-${k.student_id}`, items: bills.map((b) => ({ enrolmentId: k.enrolment_id, bill: b.bill })) }) as { id: string };
    await payments.sandboxPay(db, acc, o.id, 'success');
  }
  // One child moves to NCS Kochi: Mumbai asks, Kochi gives a seat, Mumbai issues the TC.
  const kc = await A(principalKc);
  const todayIso = localToday(), tomorrow = daysFromToday(1);
  const req = await transfers.requestTransfer(db, p0, { studentId: clear[0].student_id, toSchoolId: school['NCS-KC'].id, joiningOn: tomorrow, reason: 'Father posted to Kochi' });
  const kcSeat = (await transfers.incomingRequests(db, kc, school["NCS-KC"].id) as unknown as { id: string; sections: { id: string; free: number }[] }[]).find((r) => r.id === req.id)!.sections.find((x) => x.free > 0)!;
  await transfers.decide(db, kc, req.id, { decision: 'ACCEPT', sectionId: kcSeat.id });
  for (const [i, k] of clear.slice(0, 3).entries()) {
    const tc = await certificates.prepare(db, p0, { studentId: k.student_id, kind: 'TC', leavingDate: todayIso,
      reason: i === 0 ? 'Father posted to Kochi' : i === 1 ? 'Family moving to Pune' : 'Admission to a residential school' });
    await certificates.submit(db, p0, tc.id);
  }
  // Open requests: a Mumbai child waiting for Kochi's answer, and a Kochi child asking Mumbai for a seat.
  const waiting = await db.one<{ student_id: string }>(`select e.student_id from enrolment e where e.school_id = $1 and e.status = 'ACTIVE' and e.class_code = 'VI' order by e.admission_no limit 1`, [mb]);
  await transfers.requestTransfer(db, p0, { studentId: waiting.student_id, toSchoolId: school['NCS-KC'].id, joiningOn: daysFromToday(20), reason: 'Mother posted to INS Venduruthy, Kochi' });
  const fromKochi = await db.one<{ student_id: string }>(`select e.student_id from enrolment e where e.school_id = $1 and e.status = 'ACTIVE' and e.class_code = 'VIII' order by e.admission_no limit 1`, [school['NCS-KC'].id]);
  await transfers.requestTransfer(db, kc, { studentId: fromKochi.student_id, toSchoolId: mb, joiningOn: daysFromToday(14), reason: 'Father posted to Western Naval Command, Mumbai' });
  for (const k of clear.slice(3)) {
    const bc = await certificates.prepare(db, p0, { studentId: k.student_id, kind: 'BONAFIDE', purpose: 'Bank account' });
    await certificates.submit(db, p0, bc.id);
  }
  console.log(`School life and websites done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // ── R3: academics ──
  // Marks are generated in SQL from a stable "ability" per child, a small school effect and noise
  // per paper, so schools and classes differ realistically and every run gives the same data.
  const SCHOOL_EFFECT: Record<string, number> = { 'NCS-MB': 0.04, 'NCS-VZ': 0.02, 'NCS-KC': 0.05, 'NCS-GA': 0, 'NCS-PB': -0.03, 'NCS-DL': 0.03 };
  const fillMarks = async (assessmentId: string, schoolId: string, effect: number, by: string, skip: string | null = null) => {
    await db.tx((tx) => tx.query(
      `insert into mark (assessment_id, enrolment_id, subject_code, marks, absent, entered_by)
       select $1, e.id, p.subject_code,
              case when abs(hashtext(e.id::text || p.subject_code || $1::text)) % 70 = 0 then null
                   else least(p.max_marks, greatest(0, round(p.max_marks * (0.42 + (abs(hashtext(e.student_id::text)) % 1000) / 1000.0 * 0.55 + $3
                        + ((abs(hashtext(e.id::text || p.subject_code || $1::text)) % 200) - 100) / 1000.0)))) end,
              abs(hashtext(e.id::text || p.subject_code || $1::text)) % 70 = 0, $4
         from enrolment e join assessment_paper p on p.assessment_id = $1 and p.class_code = e.class_code
        where e.school_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)
          and ($5::uuid is null or not (e.section_id = $5 and p.subject_code = 'MAT'))`, [assessmentId, schoolId, effect, by, skip]), { actor: 'seed: marks entry' });
  };
  const viiibSec = mbSec('VIII', 1);
  for (const [code, s2] of Object.entries(school)) {
    const lead = s2.id === mb ? p0 : nes1;
    for (const exam of ['PT1', 'HY', 'PT2'] as const) {
      const { id } = await academics.createFromPlan(db, lead, s2.id, YEAR, exam);
      await academics.open(db, lead, id);
      await fillMarks(id, s2.id, SCHOOL_EFFECT[code] ?? 0, lead.id, exam === 'PT2' && s2.id === mb ? viiibSec : null);
      if (exam === 'HY' && s2.id === mb) {
        // Holistic Progress Card entries for every Mumbai child, and class-teacher remarks for VIII-B.
        await db.tx((tx) => tx.query(
          `insert into hpc_entry (assessment_id, enrolment_id, domain_code, level, remark, entered_by)
           select $1, e.id, d.code, (array['PROGRESSING','PROFICIENT','PROFICIENT','ADVANCED','ADVANCED','BEGINNER'])[1 + abs(hashtext(e.id::text || d.code)) % 6], '', $3
             from enrolment e cross join hpc_domain d
            where e.school_id = $2 and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`, [id, mb, p0.id]), { actor: 'seed: HPC' });
        const remarks = ['Works steadily and asks good questions in class.', 'A cheerful member of the class; reading has improved this term.', 'Strong in mathematics; should take more care with presentation.', 'Helpful to classmates and keen on sports.'];
        const viiib = await db.query<{ id: string }>(`select id from enrolment where section_id = $1 and status = 'ACTIVE' order by admission_no`, [viiibSec]);
        for (const [i, e] of viiib.entries()) await academics.saveHpc(db, t, id, viiibSec, e.id, { entries: [], remark: remarks[i % remarks.length] });
        const anaya = await db.one<{ id: string; section_id: string }>(`select id, section_id from enrolment where student_id = $1 and upper_inf(period)`, [mehta.studentIds[1]]);
        await academics.saveHpc(db, p0, id, anaya.section_id, anaya.id, { entries: [
          { domain: 'LANGUAGE', level: 'ADVANCED', remark: 'Retells stories with confidence and loves picture books.' },
          { domain: 'PHYSICAL', level: 'PROFICIENT', remark: 'Enjoys the obstacle course; balance has improved.' }], remark: 'Anaya has settled in beautifully at the Foundation Wing.' });
        // Holistic Progress Cards in the NES format (Balvatika to Class V) for Mumbai's A sections:
        // every item rated, a remark, favourites for All About Me and a height and weight check-up.
        for (const cls of HPC_CLASSES) {
          const r = [...hpc.rules(HPC_TEMPLATES[cls]).entries()];
          await db.tx((tx) => tx.query(
            `insert into hpc_rating (assessment_id, enrolment_id, item_id, value, entered_by)
             select $1, e.id, it.id,
                    case when it.k in ('LEVEL', 'SMILEY') then (array['3','2','3','2','3','1','3','2'])[1 + abs(hashtext(e.id::text || it.id)) % 8]
                         when it.k = 'YESNO' then case when abs(hashtext(e.id::text || it.id)) % 9 = 0 then 'NO' else 'YES' end
                         when it.k = 'TEXT' then (array['Drawing and colouring','Reading stories','Mathematics puzzles','Football and running','Singing in the assembly'])[1 + abs(hashtext(e.id::text || it.id)) % 5]
                         else (string_to_array(substr(it.k, 8), '|'))[array_length(string_to_array(substr(it.k, 8), '|'), 1) - abs(hashtext(e.id::text || it.id)) % 2] end, $3
               from enrolment e join section s on s.id = e.section_id join org_unit c on c.id = s.campus_id cross join unnest($4::text[], $5::text[]) as it(id, k)
              where c.parent_id = $2 and e.class_code = $6 and s.name = 'A' and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`,
            [id, mb, p0.id, r.map(([i]) => i), r.map(([, k]) => (k.kind === 'CHOICE' ? `CHOICE:${k.scale.join('|')}` : k.kind)), cls]), { actor: 'seed: holistic cards' });
        }
        await db.tx(async (tx) => {
          const kids = `from enrolment e join section s on s.id = e.section_id join org_unit c on c.id = s.campus_id
                         where c.parent_id = $1 and e.class_code = any($2) and s.name = 'A' and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period)`;
          const h = (k: string, list: string[]) => `(array[${list.map((x) => `'${x}'`).join(',')}])[1 + abs(hashtext(e.id::text || '${k}')) % ${list.length}]`;
          await tx.query(`insert into report_remark (assessment_id, enrolment_id, remark, entered_by) select $3, e.id, ${h('rm', ['A cheerful learner who takes part eagerly in every activity.', 'Has grown in confidence and now speaks up in class.', 'Curious and careful; enjoys stories and number games.', 'Kind to classmates; should practise writing neatly at home.'])}, $4 ${kids} on conflict do nothing`, [mb, HPC_CLASSES, id, p0.id]);
          await tx.query(`insert into hpc_profile (enrolment_id, answers, updated_by) select e.id, jsonb_build_object('f.1', ${h('c', ['Blue', 'Yellow', 'Pink', 'Green'])}, 'f.2', ${h('a', ['Dog', 'Cat', 'Elephant', 'Parrot'])}, 'f.3', ${h('g', ['Ludo', 'Kho-kho', 'Cricket', 'Hide and seek'])}, 'f.4', ${h('v', ['Potato', 'Carrot', 'Peas'])}, 'f.5', ${h('f', ['Dosa', 'Paneer', 'Idli', 'Pasta'])}, 'f.6', ${h('fr', ['Riya', 'Kabir', 'Meher', 'Arjun'])}), $3 ${kids}`, [mb, ['I', 'II'], p0.id]);
          await tx.query(`insert into hpc_profile (enrolment_id, answers, updated_by) select e.id, jsonb_build_object('f.1', ${h('b', ['The Jungle Book', 'Panchatantra stories', 'Malgudi Days'])}, 'f.2', ${h('e', ['Mangoes', 'Rajma chawal', 'Upma'])}, 'f.3', ${h('p', ['My grandparents', 'Mother and Father', 'My sister'])}, 'f.4', ${h('q', ['Swimming', 'Drawing competitions', 'Quiz contests'])}, 'f.5', ${h('d', ['Bitter gourd', 'Getting up early', 'Loud noises'])}, 'f.6', ${h('k', ['I try a little each day.', 'I talk to my mother about it.', 'I eat it with something I like.'])}, 'f.7', ${h('m', ['Space', 'Dinosaurs', 'Mathematics', 'Oceans'])}), $3 ${kids}`, [mb, ['III', 'IV', 'V'], p0.id]);
          await tx.query(`insert into health_checkup (student_id, school_id, on_date, height_cm, weight_kg, recorded_by)
            select e.student_id, $1, '2026-07-15', 96 + cl.ordinal * 6 + abs(hashtext(e.id::text || 'h')) % 9, 14 + cl.ordinal * 2.5 + abs(hashtext(e.id::text || 'w')) % 6, $3
              from enrolment e join section s on s.id = e.section_id join org_unit c on c.id = s.campus_id join class_level cl on cl.code = e.class_code
             where c.parent_id = $1 and e.class_code = any($2) and s.name = 'A' and e.status in ('ACTIVE', 'PROVISIONAL') and upper_inf(e.period) on conflict do nothing`, [mb, HPC_CLASSES, p0.id]);
        }, { actor: 'seed: holistic cards' });
      }
      if (exam !== 'PT2') { await academics.lock(db, lead, id); await academics.publish(db, lead, id); }
    }
  }
  console.log(`Exams and results done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // CBSE 2026 results (academic year 2025-26) as the result text files CBSE sends, for four schools,
  // loaded and published; and the Performance Index of earlier years as NES loaded it from its
  // consolidation sheets. Names are made up.
  let bSeed = 7;
  const bRnd = () => { bSeed = (bSeed * 48271) % 2147483647; return bSeed / 2147483647; };
  const B_FIRST = ['Aarav', 'Diya', 'Kabir', 'Meher', 'Ishaan', 'Tara', 'Reyansh', 'Anvi', 'Vihaan', 'Saanvi', 'Arjun', 'Kiara', 'Dhruv', 'Myra', 'Aditi', 'Rohan', 'Nisha', 'Yash', 'Pari', 'Om'];
  const B_LAST = ['Sharma', 'Nair', 'Iyer', 'Menon', 'Rao', 'Patil', 'Das', 'Gill', 'Bose', 'Kulkarni', 'Pillai', 'Reddy', 'Singh', 'Joshi', 'Thomas'];
  const gradeOf = (m: number) => (m >= 91 ? 'A1' : m >= 81 ? 'A2' : m >= 71 ? 'B1' : m >= 61 ? 'B2' : m >= 51 ? 'C1' : m >= 41 ? 'C2' : m >= 37 ? 'D1' : m >= 33 ? 'D2' : 'E');
  const STREAMS: Record<string, string[]> = { SCI: ['301', '041', '042', '043', '083'], COM: ['301', '055', '054', '030', '041'], HUM: ['301', '027', '028', '029', '048'] };
  const boardFile = (cls: 'X' | 'XII', base: number, n: number, lift: number) => {
    const lines = ['                      CENTRAL BOARD OF SECONDARY EDUCATION', `            ${cls === 'X' ? 'SECONDARY' : 'SENIOR SCHOOL CERTIFICATE'} EXAMINATION (CLASS ${cls}) 2026`, '',
      'ROLL NO  SEX  CANDIDATE NAME                    SUB1  SUB2  SUB3  SUB4  SUB5  SUB6  RESULT'];
    for (let i = 0; i < n; i++) {
      const codes = cls === 'X' ? ['184', '085', '041', '086', '087', '402'] : STREAMS[i % 5 < 3 ? 'SCI' : i % 5 === 3 ? 'COM' : 'HUM'];
      const ability = 0.5 + bRnd() * 0.45 + lift;
      const marks = codes.map(() => Math.max(18, Math.min(100, Math.round((ability + (bRnd() - 0.5) * 0.18) * 100))));
      const fails = marks.filter((m) => m < 33).length;
      const name = `${B_FIRST[Math.floor(bRnd() * B_FIRST.length)]} ${B_LAST[Math.floor(bRnd() * B_LAST.length)]}`.toUpperCase();
      lines.push(`${String(base + i).padEnd(8)} ${bRnd() < 0.5 ? 'F' : 'M'}    ${name.padEnd(34)}${codes.map((c) => c.padEnd(6)).join('')}${fails === 0 ? 'PASS' : fails === 1 ? 'COMP' : 'ESSENTIAL REPEAT'}`);
      lines.push(`${' '.repeat(49)}${marks.map((m) => `${String(m).padStart(3, '0')} ${gradeOf(m)}`).join(' ')}`);
    }
    return lines.join('\n');
  };
  for (const [i, code] of ['NCS-MB', 'NCS-VZ', 'NCS-KC', 'NCS-DL'].entries()) {
    const lead = code === 'NCS-MB' ? p0 : nes1;
    for (const cls of ['X', 'XII'] as const) {
      await exams.importBoardResults(db, lead, school[code].id, { year: 2026, classCode: cls, content: boardFile(cls, 26100000 + i * 100000 + (cls === 'X' ? 0 : 50000), cls === 'X' ? 42 : 30, (SCHOOL_EFFECT[code] ?? 0) * 1.5), fileName: `${code}_${cls}_2026.txt` });
      await exams.publishBoardResults(db, lead, school[code].id, 2026, cls);
    }
  }
  const PI_KEYS = ['VI', 'VII', 'VIII', 'IX', 'X', 'XI-SCIENCE', 'XI-COMMERCE', 'XI-HUMANITIES', 'XII-SCIENCE', 'XII-COMMERCE', 'XII-HUMANITIES'];
  await db.tx(async (tx) => {
    for (const [k, yr] of ['2023-24', '2024-25', '2025-26'].entries()) for (const [code, s2] of Object.entries(school)) for (const key of PI_KEYS) {
      if (yr === '2025-26' && ['NCS-MB', 'NCS-VZ', 'NCS-KC', 'NCS-DL'].includes(code) && (key === 'X' || key.startsWith('XII'))) continue;   // from the CBSE files
      const v = Math.round((66 + (SCHOOL_EFFECT[code] ?? 0) * 120 + k * 1.4 + bRnd() * 12 - (key.includes('COMMERCE') || key.includes('HUMANITIES') ? 6 : 0)) * 100) / 100;
      await tx.query(`insert into pi_snapshot (school_id, academic_year, class_key, scale, students, sum_ni, sum_wni, pi, source, frozen_by) values ($1, $2, $3, $4, 0, 0, 0, $5, 'IMPORTED', $6)`,
        [s2.id, yr, key, key === 'X' || key.startsWith('XII') ? 8 : 7, v, nes1.id]);
    }
  }, { actor: 'seed: earlier years' });
  console.log(`CBSE results and earlier years' PI done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Awards: NES schemes; Mumbai's Half-Yearly Class X topper nominated, approved by a second officer and paid;
  // a Delhi nomination waiting; Mrs Kulkarni nominated for the Outstanding Teacher Award.
  const fin1 = await A(nesFinance);
  const sch = {
    x: await awards.createScheme(db, nes1, { code: 'MERIT_X', name: 'NES Merit Award — Class X topper', kind: 'STUDENT', amountPaise: 1_100_000, criteria: 'First in Class X in the school, Half-Yearly or board.', from: '2026-04-01' }),
    xii: await awards.createScheme(db, nes1, { code: 'MERIT_XII', name: 'NES Merit Award — Class XII topper', kind: 'STUDENT', amountPaise: 1_100_000, criteria: 'First in each Class XII stream.', from: '2026-04-01' }),
    second: await awards.createScheme(db, nes1, { code: 'MERIT_SECOND', name: 'NES Merit Award — second position', kind: 'STUDENT', amountPaise: 750_000, criteria: 'Second in Class X or XII.', from: '2026-04-01' }),
    teacher: await awards.createScheme(db, nes1, { code: 'OUTSTANDING_TEACHER', name: 'NES Outstanding Teacher Award', kind: 'TEACHER', amountPaise: 2_500_000, criteria: 'One teacher per Command each year, for results, innovation and mentoring.', from: '2026-04-01' }),
  };
  const topper = async (schoolId: string, cls: string) => db.one<{ student_id: string; name: string; percentage: number }>(
    `select e.student_id, st.name, r.percentage::float as percentage from result r join assessment a on a.id = r.assessment_id join enrolment e on e.id = r.enrolment_id
       join student st on st.id = e.student_id where a.school_id = $1 and a.code = 'HY' and r.class_code = $2 and r.rank_class = 1 order by st.name limit 1`, [schoolId, cls]);
  const mbX = await topper(mb, 'X');
  const n1 = await awards.nominate(db, p0, { schemeId: sch.x.id, schoolId: mb, year: YEAR, studentId: mbX.student_id, citation: `${mbX.name} stood first in Class X in the Half-Yearly examination with ${mbX.percentage}%.`, evidence: { exam: 'HY', percentage: mbX.percentage } });
  await awards.decide(db, nes1, n1.id, true, 'Approved by NES');
  await awards.pay(db, fin1, n1.id, 'NEFT/NES/2026/0412');
  const dlX = await topper(school['NCS-DL'].id, 'X');
  await awards.nominate(db, nes1, { schemeId: sch.x.id, schoolId: school['NCS-DL'].id, year: YEAR, studentId: dlX.student_id, citation: `${dlX.name} stood first in Class X at NCS Delhi with ${dlX.percentage}%.`, evidence: { exam: 'HY', percentage: dlX.percentage } });
  await awards.nominate(db, p0, { schemeId: sch.teacher.id, schoolId: mb, year: YEAR, teacherId: teacher, citation: 'Mrs Kulkarni lifted Class VIII mathematics results by 12 points, runs the Ramanujan Math Lab club and mentors new teachers.' });
  void sch.xii; void sch.second;
  console.log(`Awards done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // ── R6: recruitment, the Common Written Test, help and support ──
  // Mumbai recruits a TGT Mathematics (with the CWT) and Primary Teachers; Kochi and Delhi, which
  // have Mathematics teachers, are asked to set the CWT paper. A candidate registered last year applies again.
  await db.query(`update app_user set phone = coalesce(phone, '+919820000101'), email = coalesce(email, 'principal.mumbai@ncs.example') where id = $1`, [principal]);
  await db.query(`update app_user set phone = coalesce(phone, '+919447000202'), email = coalesce(email, 'principal.kochi@ncs.example') where id = $1`, [principalKc]);
  const principalDl = await user('Cdr (Retd) Neha Bhatia', 'SCHOOL_ADMIN', 'Principal, NCS Delhi', 'nes.nhq.ncs_dl');
  await db.query(`update app_user set phone = '+919811000303', email = 'principal.delhi@ncs.example' where id = $1`, [principalDl]);
  for (const [pid, code, names] of [[principalKc, 'NCS-KC', ['Mrs Bindu Thomas', 'Mr Joseph Mathew']], [principalDl, 'NCS-DL', ['Mrs Ritu Malhotra', 'Mr Sandeep Rawat', 'Mrs Anjali Gupta']]] as const) {
    const pa = await A(pid);
    await staff.addPost(db, pa, school[code].id, { postType: 'TGT', subjectCode: 'MAT', payLevel: 7, from: FROM, orderRef: `NES/EST/${code}/MAT`, count: names.length });
    const free = (await staff.posts(db, pa, school[code].id) as unknown as { id: string; post_type: string; holder: string | null }[]).filter((x) => x.post_type === 'TGT' && !x.holder);
    for (const [i, n] of names.entries()) await staff.enrol(db, pa, school[code].id, { name: n, category: 'TEACHING', employment: 'PERMANENT', gender: n.startsWith('Mr ') ? 'M' : 'F', joinedService: '2019-07-01', orderRef: `${code}/EST/${30 + i}`, postId: free[i].id, pay: null });
  }
  const mbPosts = await staff.posts(db, p0, mb) as unknown as { id: string; post_type: string; holder: string | null }[];
  const tgtPost = mbPosts.find((x) => x.post_type === 'TGT' && !x.holder);
  const tgt = await recruitment.createVacancy(db, p0, mb, { postId: tgtPost?.id ?? null, postType: 'TGT', subjectCode: 'MAT', employment: 'CONTRACT', positions: 2, opensOn: daysFromToday(-12), closesOn: daysFromToday(18),
    payText: 'Consolidated ₹48,000 a month', description: 'Mathematics for Classes VI to X. Two posts on contract for the session 2026-27, renewable on performance.', cwt: true,
    fees: { GEN: 50000, OBC: 50000, EWS: 50000, SC: 0, ST: 0, PWD: 0, ESM: 0, WOMEN: 25000 },
    questions: [{ id: 'q1', label: 'Can you also teach Computer Applications in Class VI to VIII?', type: 'YESNO', required: true }] });
  await recruitment.publishVacancy(db, p0, tgt.id);
  const prt = await recruitment.createVacancy(db, p0, mb, { postType: 'PRT', employment: 'CONTRACT', positions: 4, opensOn: daysFromToday(-20), closesOn: daysFromToday(10), payText: 'Consolidated ₹38,000 a month', fees: { GEN: 30000, OBC: 30000, EWS: 30000, SC: 0, ST: 0, PWD: 0, ESM: 0, WOMEN: null } });
  await recruitment.publishVacancy(db, p0, prt.id);
  await recruitment.createVacancy(db, p0, mb, { postType: 'PGT', subjectCode: 'PHY', employment: 'GUEST', positions: 1, opensOn: daysFromToday(5), closesOn: daysFromToday(35), payText: '₹600 a period' });
  // Applicants: registered candidates who applied (their profiles are summarised in each application).
  const CITY = ['Mumbai', 'Mumbai', 'Mumbai', 'Thane', 'Navi Mumbai', 'Pune', 'Nashik', 'Kochi', 'Goa', 'Delhi'];
  const SURNAME = ['Patil', 'Deshmukh', 'Nair', 'Menon', 'Iyer', 'Shah', 'Joshi', 'Kulkarni', 'Pillai', 'Rao', 'Singh', 'Sharma', 'Gaikwad', 'Fernandes', "D'Souza", 'Khan', 'Bhosale', 'Pawar', 'Reddy', 'Verma'];
  let cn = 0;
  const applicants = async (vacancyId: string, n: number, kind: 'TGT' | 'PRT') => {
    const rows = Array.from({ length: n }, () => {
      cn++;
      const f = rnd() < 0.72, name = `${pick(f ? FIRST_F : FIRST_M)} ${pick(SURNAME)}`, age = 23 + Math.floor(rnd() * 13), cat = pick(['GEN', 'GEN', 'GEN', 'OBC', 'OBC', 'SC', 'ST', 'EWS']);
      const q = Math.round((52 + rnd() * 40) * 10) / 10, test = rnd() < 0.85 ? Math.round(90 + rnd() * 55) : null, exp = Math.floor(rnd() * 96);
      return { email: `applicant${cn}@example.in`, mobile: `+917${String(700000000 + cn).padStart(9, '0')}`, name, dob: daysFromToday(-(age * 365 + Math.floor(rnd() * 300))), gender: f ? 'F' : 'M', cat, q, test, exp, age, city: pick(CITY),
        status: rnd() < 0.04 ? 'FEE_DUE' : 'SUBMITTED', fee: cat === 'SC' || cat === 'ST' ? 0 : f && kind === 'TGT' ? 25000 : kind === 'TGT' ? 50000 : 30000, navy: rnd() < 0.15 ? 'NAVY_SPOUSE' : 'NONE' };
    });
    await db.query(`insert into candidate (email, mobile, name, dob, gender, category, city, navy_relation, email_verified_at, mobile_verified_at)
                    select x.email, x.mobile, x.name, x.dob::date, x.gender, x.cat, x.city, x.navy, now(), now() from jsonb_to_recordset($1::jsonb) as x(email text, mobile text, name text, dob text, gender text, cat text, city text, navy text)`, [JSON.stringify(rows)]);
    await db.query(`insert into job_application (vacancy_id, candidate_id, snapshot, eligibility, category, gender, navy_relation, age_years, qual_pct, test_score, experience_months, city, search, fee_paise, fee_status, status, declared_at, receipt_no, created_at)
      select $1, c.id, jsonb_build_object('name', c.name, 'email', c.email, 'mobile', c.mobile, 'candidate_no', c.candidate_no, 'dob', c.dob, 'gender', c.gender, 'category', c.category, 'city', c.city, 'navy_relation', c.navy_relation, 'pwd', false, 'ex_serviceman', false,
               'education', jsonb_build_array(jsonb_build_object('level', $2::text, 'degree', $3::text, 'subjects', $4::jsonb, 'percentage', x.q, 'status', 'PASSED', 'year', 2026 - x.age + 22), jsonb_build_object('level', 'BED', 'degree', 'B.Ed.', 'subjects', '[]'::jsonb, 'percentage', 70, 'status', 'PASSED')),
               'tests', case when x.test is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind', 'CTET', 'paper', $5::text, 'score', x.test, 'qualified', true)) end, 'experience', '[]'::jsonb, 'documents', '[]'::jsonb),
             '[{"ok":true,"label":"Checked at submission","detail":"All conditions met"}]', c.category, c.gender, c.navy_relation, x.age, x.q, x.test, x.exp, c.city, lower(c.name || ' ' || c.candidate_no || ' ' || c.email || ' ' || c.mobile),
             x.fee, case when x.fee = 0 then 'NOT_REQUIRED' when x.status = 'FEE_DUE' then 'DUE' else 'PAID' end, x.status, now() - (x.exp % 12) * interval '1 day',
             case when x.fee > 0 and x.status <> 'FEE_DUE' then 'RCP-' || substr(md5(c.id::text), 1, 10) end, now() - (x.exp % 12) * interval '1 day'
        from jsonb_to_recordset($6::jsonb) as x(email text, q numeric, test numeric, exp int, age int, fee int, status text) join candidate c on c.email = x.email`,
      [vacancyId, kind === 'TGT' ? 'GRADUATION' : 'SR_SECONDARY', kind === 'TGT' ? 'B.Sc. Mathematics' : 'Class XII', JSON.stringify(kind === 'TGT' ? ['MAT', 'Physics'] : ['English', 'Mathematics']), kind === 'TGT' ? 'II' : 'I', JSON.stringify(rows)]);
    await recruitment.recomputeMerit(db, vacancyId);
  };
  await applicants(tgt.id, 1200, 'TGT');
  await applicants(prt.id, 450, 'PRT');
  // Meera registered for last year's recruitment; this year she only checks, confirms and pays.
  const meera = await db.one<{ id: string }>(`insert into candidate (email, mobile, name, father_name, dob, gender, category, city, state, pincode, address, navy_relation, email_verified_at, mobile_verified_at, created_at)
    values ('meera.nair@example.in', '+919820011223', 'Meera Nair', 'Ramesh Nair', '1994-05-10', 'F', 'GEN', 'Mumbai', 'Maharashtra', '400005', '12, Sagar Darshan, Colaba', 'NAVY_SPOUSE', now(), now(), now() - interval '14 months') returning id`);
  await db.query(`insert into candidate_education (candidate_id, level, degree, subjects, institution, year, percentage) values
    ($1, 'SR_SECONDARY', 'Class XII (CBSE)', '{Physics,Chemistry,Mathematics}', 'Kendriya Vidyalaya, Navy Nagar', 2012, 88), ($1, 'GRADUATION', 'B.Sc. Mathematics', '{MAT,Physics}', 'University of Mumbai', 2015, 74.6),
    ($1, 'POST_GRADUATION', 'M.Sc. Mathematics', '{MAT}', 'University of Mumbai', 2017, 68.2), ($1, 'BED', 'B.Ed.', '{MAT}', 'Government College of Education, Mumbai', 2018, 79)`, [meera.id]);
  await db.query(`insert into candidate_test (candidate_id, kind, paper, year, score, qualified) values ($1, 'CTET', 'II', 2019, 104, true)`, [meera.id]);
  await db.query(`insert into candidate_experience (candidate_id, organisation, post, subject, from_date, to_date, teaching, cbse) values ($1, 'Kendriya Vidyalaya, Colaba', 'TGT Mathematics (contract)', 'Mathematics', '2019-06-01', '2024-03-31', true, true)`, [meera.id]);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  // Every document a candidate must upload before applying: photo, signature, thumb, photo ID, a certificate per qualification and test.
  for (const [k, ref] of [['PHOTO', null], ['SIGNATURE', null], ['THUMB', null], ['ID_PROOF', null], ['EDUCATION', 'SR_SECONDARY'], ['EDUCATION', 'GRADUATION'], ['EDUCATION', 'POST_GRADUATION'], ['EDUCATION', 'BED'], ['TEST', 'CTET']] as const) {
    await db.query(`insert into candidate_document (candidate_id, kind, ref_key, name, content_type, size, sha256, data) values ($1, $2, $3, $4, 'image/png', $5, md5($6::text), $7)`,
      [meera.id, k, ref, `${(ref ?? k).toLowerCase()}.png`, PNG.length, `${k}${ref ?? ''}`, PNG]);
  }
  const meeraUser = await db.one<{ id: string }>(`insert into app_user (name, role, designation, candidate_id, email) values ('Meera Nair', 'CANDIDATE', 'Candidate, NavShiksha Careers', $1, 'meera.nair@example.in') returning id`, [meera.id]);
  const mc = await A(meeraUser.id);
  const ma = await recruitment.apply(db, mc, tgt.id, { declaration: true, answers: { q1: 'Yes' }, from: '49.36.12.8' });
  await recruitment.capturePayment(db, mc, (await recruitment.payFee(db, mc, ma.id)).id, 'success');
  // The principal shortlists the strongest for the written test: 60% or more, CTET 120 or more.
  await recruitment.bulkAction(db, p0, tgt.id, { filter: { minQualPct: 60, minTestScore: 100, status: ['SUBMITTED'], category: ['GEN', 'OBC', 'EWS'] }, action: 'CWT', note: 'Called for the CWT' });
  await recruitment.bulkAction(db, p0, tgt.id, { filter: { minQualPct: 58, minTestScore: 95, status: ['SUBMITTED'], category: ['SC', 'ST'] }, action: 'CWT', note: 'Called for the CWT' });
  await recruitment.bulkAction(db, p0, tgt.id, { filter: { ids: [ma.id] }, action: 'CWT' });
  await recruitment.bulkAction(db, p0, prt.id, { filter: { minQualPct: 80, status: ['SUBMITTED'] }, action: 'SHORTLISTED', note: 'Above 80% in Class XII' });
  // The CWT for December: Mumbai's requirement in; Kochi and Delhi asked to set the paper; Kochi has sent one.
  const cycle = await cwt.createCycle(db, nes1, { title: 'Common Written Test for teachers, November 2026', examDate: daysFromToday(30), requirementsBy: daysFromToday(8), papersDue: daysFromToday(20) });
  await cwt.sendRequirement(db, p0, cycle.id, tgt.id);
  await cwt.requestAll(db, nes1, cycle.id, 3);
  const pdf = async (title: string, lines: string[]) => { const d = await newDocument(title); const sh = new Sheet(d.doc, 210, 297, d.fonts); sh.text(title, 15, 15, { size: 14, font: d.fonts.bold }); lines.forEach((l, i) => sh.text(l, 15, 28 + i * 7, { size: 10, maxWidth: 180 })); return Buffer.from(await d.doc.save()).toString('base64'); };
  const kcReq = await db.one<{ id: string }>(`select q.id from cwt_paper_request q where q.school_id = $1`, [school['NCS-KC'].id]);
  await cwt.submitPaper(db, await A(principalKc), kcReq.id, {
    question: { name: 'CWT TGT Mathematics - NCS Kochi.pdf', contentType: 'application/pdf', dataBase64: await pdf('CWT 2026 · TGT Mathematics · Question paper', ['Section A: 60 multiple-choice questions (1 mark each)', 'Section B: 10 short answers (3 marks each)', 'Section C: 2 lesson plans (5 marks each)', 'Maximum marks 100 · 150 minutes']) },
    key: { name: 'CWT TGT Mathematics - answer key.pdf', contentType: 'application/pdf', dataBase64: await pdf('CWT 2026 · TGT Mathematics · Answer key', ['Section A: 1 (b), 2 (d), 3 (a), 4 (c) …', 'Section B: marking scheme attached', 'Section C: rubric of five criteria']) },
    note: 'Prepared by the Mathematics department; two sets available on request.' });
  await cwt.assignRollNumbers(db, nes1, cycle.id);

  // Help and support: the helpdesk works tickets by hand (the AI assistant exists but NES has not switched it on).
  const hema = await user('Ms Hema Pillai', 'SUPPORT', 'NavShiksha helpdesk', null);
  await user('NavShiksha developer team', 'DEVELOPER', 'Developer', null);
  await support.createAgent(db, nes1, { name: 'NavShiksha Assistant', kind: 'AI' });
  const hd = await A(hema);
  // A parent reports a wrong date of birth; the helpdesk proposes the correction; the principal approves it in Approvals.
  const fam = await db.one<{ uid: string; sid: string; name: string }>(`select u.id as uid, st.id as sid, st.name from app_user u join student_guardian sg on sg.guardian_id = u.guardian_id join student st on st.id = sg.student_id
      join enrolment e on e.student_id = st.id and upper_inf(e.period) and e.school_id = $1 where u.role = 'PARENT' order by st.name limit 1`, [mb]);
  const tk1 = await support.createTicket(db, await A(fam.uid), { category: 'DATA', title: `Wrong date of birth for ${fam.name.split(' ')[0]}`, page: `/students/${fam.sid}`,
    description: `The date of birth shown for ${fam.name} is wrong. It should be 14 July 2014 as in the birth certificate.`, refs: [{ entityType: 'STUDENT', entityId: fam.sid, field: 'dob', correctValue: '2014-07-14' }] });
  const ref1 = (await db.one<{ ref: string }>(`select ref from ticket_ref r join ticket t on t.id = r.ticket_id where t.number = $1`, [tk1.number])).ref;
  await support.deskTake(db, hd, tk1.number);
  await support.deskTriage(db, hd, tk1.number, { category: 'DATA', module: 'students', severity: 'NORMAL', summary: 'Date of birth wrong; the parent gives the correct date from the birth certificate.' });
  await support.deskPropose(db, hd, tk1.number, { kind: 'DATA_CORRECTION', ref: ref1, field: 'dob', newValue: 'USER_VALUE', summary: 'Correct the date of birth to the date the parent gave', details: 'The parent cites the birth certificate. Please check the certificate in the admission file before approving.' });
  // A fault: a new teacher missing from the staff chat group; a repair approved by the principal, then resolved and rated.
  const tk2 = await support.createTicket(db, await A(teacher), { category: 'PROBLEM', title: 'New teacher not in the All staff chat group', page: '/chat', description: 'The Physics teacher who joined on Monday is not in the All staff group, so she misses the notices posted there.' });
  await support.deskTake(db, hd, tk2.number);
  await support.deskNote(db, hd, tk2.number, 'Groups are rebuilt from the staff lists each night; a rebuild now should add her.');
  const fx2 = await support.deskPropose(db, hd, tk2.number, { kind: 'REPAIR', action: 'RESYNC_CHAT_GROUPS', summary: 'Rebuild the staff chat groups from the staff lists' });
  await support.decideFix(db, p0, fx2.number, true, 'Go ahead');
  await support.deskResolve(db, hd, tk2.number, 'The chat groups were rebuilt; she is now in All staff.');
  await support.rate(db, await A(teacher), tk2.number, 5);
  // A new module requested: the developer decides first.
  const tk3 = await support.createTicket(db, p0, { category: 'REQUEST', title: 'A hostel module for boarding students', page: '/', description: 'We are starting a hostel for 40 children next year. We need rooms, wardens, mess fees and night attendance in NavShiksha.' });
  await support.deskTriage(db, hd, tk3.number, { category: 'REQUEST', module: 'other', severity: 'NORMAL', summary: 'A new hostel module (rooms, wardens, mess fees, night attendance).', needsDeveloper: true, reason: 'A new module affecting fees and attendance for every school.' });
  console.log(`Recruitment, CWT and support done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // ── R5: health, the gate, stores and assets, alumni (NCS Mumbai) ──
  const nurseId = people.get('Sister Annamma Joseph')!, guardId = people.get('Mr Bahadur Thapa')!;
  await duties.assign(db, p0, mb, { userId: nurseId, code: 'NURSE', from: TODAY });
  await duties.assign(db, p0, mb, { userId: guardId, code: 'GATE_SECURITY', from: TODAY });
  await duties.assign(db, p0, mb, { userId: sup, code: 'STORE_KEEPER', from: TODAY });
  await duties.assign(db, p0, mb, { userId: subjectTeacher.PE, code: 'SAFETY_OFFICER', from: TODAY });
  await duties.assign(db, p0, mb, { userId: subjectTeacher.ENG, code: 'ALUMNI_COORDINATOR', from: TODAY });
  const nurse = await A(nurseId), guardA = await A(guardId), keeper = await A(sup), safetyOfficer = await A(subjectTeacher.PE), mehtaParent = await A((await db.one<{ id: string }>(`select id from app_user where guardian_id = $1`, [mehta.guardianId])).id);
  // Health records: what parents told the school at admission, and the nurse's register.
  await health.update(db, mehtaParent, aarav, { conditions: 'Mild asthma', medication: 'Salbutamol inhaler in his bag', alert: 'Asthma: inhaler in bag; no running in heavy dust', doctor: 'Dr S. Kulkarni, INHS Asvini', doctorPhone: '022 2215 0000' });
  await health.addImmunisation(db, mehtaParent, aarav, { vaccine: 'Tdap booster', dose: '1', givenOn: '2024-06-10' });
  await health.addImmunisation(db, mehtaParent, aarav, { vaccine: 'HPV', dose: '1', dueOn: daysFromToday(20) });
  const ALLERGY = [['Peanuts', 'Severe peanut allergy: EpiPen in bag'], ['Dust and pollen', null], ['Penicillin', 'Allergic to penicillin'], ['Lactose intolerant', null], ['Bee stings', 'Severe bee-sting allergy: EpiPen in staff room']];
  const mbKids = await db.query<{ id: string; section_id: string }>(`select e.student_id as id, e.section_id from enrolment e where e.school_id = $1 and upper_inf(e.period) and e.status = 'ACTIVE' order by e.admission_no`, [mb]);
  for (const [i, k] of mbKids.entries()) {
    if (i % 9 === 4) { const [al, alert] = ALLERGY[i % ALLERGY.length]; await health.update(db, nurse, k.id, { allergies: String(al), ...(alert ? { alert } : {}) }); }
  }
  const viiibKids = mbKids.filter((k) => k.section_id === viiib);
  await health.recordCheckups(db, nurse, mb, { onDate: '2026-07-20', rows: viiibKids.map((k, i) => ({ studentId: k.id, heightCm: 140 + (i * 7) % 25, weightKg: 34 + (i * 5) % 18, visionLeft: i % 6 === 0 ? '6/12' : '6/6', visionRight: '6/6', dental: i % 5 === 0 ? 'Caries: see a dentist' : 'Healthy' })) });
  const pcm = await stores.saveItem(db, keeper, mb, { code: 'MED-PCM', name: 'Paracetamol 500 mg', category: 'MEDICINE', kind: 'CONSUMABLE', unit: 'tablets', reorderLevel: 50, trackExpiry: true });
  const ors = await stores.saveItem(db, keeper, mb, { code: 'MED-ORS', name: 'ORS sachet', category: 'MEDICINE', kind: 'CONSUMABLE', unit: 'sachets', reorderLevel: 20, trackExpiry: true });
  const band = await stores.saveItem(db, keeper, mb, { code: 'MED-BAND', name: 'Adhesive bandages', category: 'MEDICINE', kind: 'CONSUMABLE', unit: 'nos', reorderLevel: 50, trackExpiry: true });
  await stores.adjust(db, keeper, mb, { itemId: pcm.id, kind: 'OPENING', qty: 200, batch: 'PCM2611', expiry: '2027-11-30', unitPaise: 150, note: 'Infirmary stock' });
  await stores.adjust(db, keeper, mb, { itemId: ors.id, kind: 'OPENING', qty: 15, batch: 'ORS2512', expiry: daysFromToday(40), unitPaise: 2200, note: 'Infirmary stock' });
  await stores.adjust(db, keeper, mb, { itemId: band.id, kind: 'OPENING', qty: 300, batch: 'BD27', expiry: '2028-06-30', unitPaise: 300, note: 'Infirmary stock' });
  const someone = (n: number) => mbKids[(n * 37) % mbKids.length].id;
  await health.recordVisit(db, nurse, mb, { studentId: someone(1), complaint: 'Headache after PE', temperatureC: 37.2, treatment: 'Water and rest for 20 minutes', outcome: 'BACK_TO_CLASS' });
  await health.recordVisit(db, nurse, mb, { studentId: someone(2), complaint: 'Grazed knee on the playground', treatment: 'Cleaned and dressed', medicines: [{ name: 'Adhesive bandages', itemId: band.id, qty: 2 }], outcome: 'BACK_TO_CLASS', tellParent: true });
  await health.recordVisit(db, nurse, mb, { studentId: someone(3), complaint: 'Fever and body ache', temperatureC: 38.8, treatment: 'Paracetamol given; parent called', medicines: [{ name: 'Paracetamol 500 mg', dose: '1 tablet', itemId: pcm.id, qty: 1 }], outcome: 'SENT_HOME' });
  const inc1 = await health.reportIncident(db, await A(teacher), mb, { at: new Date(Date.now() - 3 * 864e5).toISOString(), kind: 'INJURY', severity: 'MINOR', place: 'Playground, near the basketball court', description: 'A Class VI boy fell while running and bruised his elbow.', actionTaken: 'First aid by the nurse; class teacher told the parent.', studentIds: [someone(4)] });
  await health.updateIncident(db, safetyOfficer, inc1.id, { note: 'Loose gravel near the court cleared by the maintenance staff.', close: true });
  await health.reportIncident(db, await A(subjectTeacher.HIN), mb, { at: new Date(Date.now() - 864e5).toISOString(), kind: 'BULLYING', severity: 'MODERATE', place: 'Class VIII-A, lunch break', description: 'Two students repeatedly took a classmate’s lunch and called him names; the classmate told the class teacher.', actionTaken: 'Students separated; counsellor informed.' });
  await health.recordDrill(db, safetyOfficer, mb, { kind: 'FIRE', onDate: daysFromToday(-62), startedAt: '10:40', minutesToClear: 5.5, participants: 1180, observations: 'Second-floor east wing slow; one door was locked.', actions: 'Keep the east wing door unlocked in school hours.' });
  await health.recordDrill(db, safetyOfficer, mb, { kind: 'EARTHQUAKE', onDate: daysFromToday(-150), startedAt: '11:15', minutesToClear: 4, participants: 1150, observations: 'Duck, cover and hold done well.' });
  // The gate: today's visitors, the Mehtas' driver who may collect Aarav, and gate passes.
  const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const exp = await gate.expect(db, await A(teacher), mb, { name: 'Dr Rekha Menon', phone: '9820456789', purpose: 'Career talk for Class X', organisation: 'IIT Bombay', on: TODAY });
  await gate.checkInByCode(db, guardA, mb, exp.sandboxCode!, { idKind: 'Aadhaar', idLast4: '4412' });
  await gate.walkIn(db, guardA, mb, { name: 'Mr Prakash Jadhav', phone: '9819001122', purpose: 'Water purifier service', organisation: 'AquaSure Services', hostUserId: sup, vehicleNo: 'MH01AB1234' });
  const out = await gate.walkIn(db, guardA, mb, { name: 'Courier (BlueDart)', purpose: 'Parcel for the office' });
  await gate.checkOut(db, guardA, out.id);
  await gate.expect(db, p0, mb, { name: 'Mr Vikram Sethi', phone: '9833112233', purpose: 'Meeting about the annual day', organisation: 'Parent-Teacher Association', on: TODAY });
  const driver = await gate.addPickup(db, mehtaParent, aarav, { name: 'Mr Ramesh Pawar', relation: 'Family driver', phone: '9821334455', photoBase64: PHOTO });
  await gate.addPickup(db, mehtaParent, aarav, { name: 'Mrs Sudha Mehta', relation: 'Grandmother', phone: '9821334466', photoBase64: PHOTO });
  const gp = await gate.requestPass(db, mehtaParent, aarav, { on: TODAY, leaveAt: '13:15', reason: 'Dentist appointment at INHS Asvini', pickupId: driver.id });
  const ctVIIIB = (await db.one<{ id: string }>(`select user_id as id from class_teacher where section_id = $1 and kind = 'CLASS' and valid @> current_date`, [viiib])).id;
  await gate.decidePass(db, await A(ctVIIIB), gp.id, true);
  const nairParent = await A((await db.one<{ id: string }>(`select id from app_user where guardian_id = $1`, [nair.guardianId])).id);
  const kavya = (await db.one<{ id: string }>(`select id from student where name = 'Kavya Nair'`)).id;
  await gate.requestPass(db, nairParent, kavya, { on: daysFromToday(1), leaveAt: '11:30', reason: 'Passport appointment' });
  // Stores: the item list, opening stock, suppliers, indents, an order received (laptops onto the register) and one waiting for the principal.
  const item = async (code: string, name: string, category: string, kind: 'CONSUMABLE' | 'ASSET', o: { unit?: string; reorder?: number; open?: number; rate?: number; life?: number; expiry?: string } = {}) => {
    const r = await stores.saveItem(db, keeper, mb, { code, name, category, kind, unit: o.unit, reorderLevel: o.reorder ?? 0, lifeYears: o.life ?? null, trackExpiry: !!o.expiry });
    if (o.open) await stores.adjust(db, keeper, mb, { itemId: r.id, kind: 'OPENING', qty: o.open, unitPaise: o.rate ?? null, expiry: o.expiry ?? null, batch: o.expiry ? 'OPEN' : undefined, note: 'Opening stock (from the stock register)' });
    return r.id;
  };
  const a4 = await item('ST-A4', 'A4 paper, 75 gsm (ream)', 'STATIONERY', 'CONSUMABLE', { unit: 'reams', reorder: 40, open: 32, rate: 28000 });
  await item('ST-CHALK', 'White chalk (box of 100)', 'STATIONERY', 'CONSUMABLE', { unit: 'boxes', reorder: 30, open: 120, rate: 6500 });
  await item('ST-MARKER', 'Whiteboard markers (pack of 10)', 'STATIONERY', 'CONSUMABLE', { unit: 'packs', reorder: 20, open: 45, rate: 18000 });
  await item('ST-REG', 'Attendance registers', 'STATIONERY', 'CONSUMABLE', { unit: 'nos', reorder: 10, open: 60, rate: 12000 });
  await item('IT-TONER', 'Laser printer toner 88A', 'IT', 'CONSUMABLE', { unit: 'nos', reorder: 4, open: 3, rate: 260000 });
  await item('LAB-HCL', 'Hydrochloric acid, 2.5 L', 'LAB', 'CONSUMABLE', { unit: 'bottles', reorder: 4, open: 6, rate: 95000, expiry: '2027-08-31' });
  await item('LAB-PHENOL', 'Phenolphthalein indicator, 100 ml', 'LAB', 'CONSUMABLE', { unit: 'bottles', reorder: 5, open: 4, rate: 18000, expiry: daysFromToday(45) });
  await item('SP-FOOTBALL', 'Football, size 5', 'SPORTS', 'CONSUMABLE', { unit: 'nos', reorder: 6, open: 14, rate: 85000 });
  await item('CL-PHENYL', 'Floor cleaner, 5 L', 'CLEANING', 'CONSUMABLE', { unit: 'cans', reorder: 10, open: 22, rate: 54000 });
  const laptopItem = await item('IT-LAPTOP', 'Laptop, i5, 16 GB', 'IT', 'ASSET', { life: 4 });
  const panelItem = await item('IT-PANEL', 'Interactive panel, 75 inch', 'IT', 'ASSET', { life: 7 });
  const benchItem = await item('FU-BENCH', 'Student desk and bench (double)', 'FURNITURE', 'ASSET', { life: 10 });
  for (const [n, name, where, on, cost, life, it] of [[6, 'Interactive panel, 75 inch', 'Classrooms IX-A to XI-B', '2023-06-15', 18500000, 7, panelItem], [4, 'Desktop computer, i3', 'Computer lab', '2021-07-01', 4200000, 4, null],
    [2, 'LCD projector', 'Auditorium and AV room', '2022-01-10', 6500000, 5, null], [10, 'Student desk and bench (double)', 'Class VIII-B', '2019-05-20', 850000, 10, benchItem], [1, 'Water cooler with purifier', 'Ground floor corridor', '2020-04-01', 9800000, 8, null],
    [1, 'School band set (drums, bugles)', 'Music room', '2018-08-01', 24000000, 10, null]] as const) {
    for (let k = 0; k < n; k++) await stores.addAsset(db, keeper, mb, { name, itemId: it, location: where, acquiredOn: on, costPaise: cost, lifeYears: life, serialNo: `${name.slice(0, 3).toUpperCase()}-${on.slice(0, 4)}-${k + 1}` });
  }
  const cooler = (await db.one<{ id: string }>(`select id from asset where school_id = $1 and name like 'Water cooler%'`, [mb])).id;
  await stores.scheduleService(db, keeper, cooler, { kind: 'Filter change and service (AMC)', everyMonths: 3, dueOn: daysFromToday(-3), vendor: 'AquaSure Services' });
  const proj = (await db.one<{ id: string }>(`select id from asset where school_id = $1 and name = 'LCD projector' order by tag limit 1`, [mb])).id;
  await stores.scheduleService(db, keeper, proj, { kind: 'Lamp and filter check', everyMonths: 12, dueOn: daysFromToday(18) });
  const supA = await stores.saveSupplier(db, keeper, mb, { name: 'Coastal Computers Pvt Ltd', gstin: '27AABCC1234D1Z5', phone: '022 2204 1100', email: 'sales@coastalcomputers.example', address: 'Fort, Mumbai 400001' });
  const supB = await stores.saveSupplier(db, keeper, mb, { name: 'Colaba Stationery Mart', gstin: '27AAGFC5678K1Z2', phone: '022 2282 4455', address: 'Colaba Causeway, Mumbai 400005' });
  const ind1 = await stores.raiseIndent(db, await A(subjectTeacher.CS), mb, { department: 'Computer lab', purpose: 'Replace four lab desktops that no longer start', neededBy: daysFromToday(30), lines: [{ itemId: laptopItem, qty: 4, estPaise: 6000000 }] });
  await stores.decideIndent(db, p0, ind1.id, true, 'Approved from the IT budget');
  const po1 = await stores.createPo(db, keeper, mb, { supplierId: supA.id, indentId: ind1.id, terms: 'Delivery within 15 days; three years’ warranty on site.', lines: [{ itemId: laptopItem, qty: 4, unitPaise: 5650000, gstPct: 18 }] });
  await stores.approvePo(db, p0, po1.id);
  const po1Line = (await db.one<{ id: string }>('select id from po_line where po_id = $1', [po1.id])).id;
  await stores.receive(db, keeper, po1.id, { receivedOn: daysFromToday(-5), invoiceNo: 'CC/26-27/0412', invoiceDate: daysFromToday(-6), lines: [{ lineId: po1Line, qty: 4, serials: ['5CD2341ABC', '5CD2341ABD', '5CD2341ABE', '5CD2341ABF'], location: 'Computer lab' }] });
  const grn1 = (await db.one<{ id: string }>('select id from goods_receipt where po_id = $1', [po1.id])).id;
  await stores.paySupplier(db, await A(accountant), grn1, { amountPaise: 15000000, paidOn: daysFromToday(-1), utr: 'SBIN26292004417' });
  const ind2 = await stores.raiseIndent(db, await A(teacher), mb, { department: 'Mathematics', purpose: 'Board work and the Ramanujan Math Lab', lines: [{ itemId: a4, qty: 5 }, { description: 'Geometry box set for the maths lab', qty: 20 }] });
  await stores.decideIndent(db, p0, ind2.id, true);
  await stores.issueIndent(db, keeper, ind2.id);
  await stores.raiseIndent(db, await A(subjectTeacher.SCI), mb, { department: 'Chemistry lab', purpose: 'Practicals for Class X', neededBy: daysFromToday(10), lines: [{ description: 'Burettes, 50 ml', qty: 10 }, { description: 'Litmus paper (pack)', qty: 20 }] });
  await stores.createPo(db, keeper, mb, { supplierId: supB.id, terms: 'Delivery to the school store.', lines: [{ itemId: a4, qty: 100, unitPaise: 27500, gstPct: 12 }] });
  // Alumni: former pupils registered with NCS Mumbai, most verified; a reunion with replies.
  const AL = [['Arjun Deshpande', 2010, 'Engineer', 'Larsen & Toubro', 'Mumbai'], ['Neha Shetty', 2012, 'Doctor', 'KEM Hospital', 'Mumbai'], ['Lt Kabir Malhotra', 2014, 'Naval officer', 'Indian Navy', 'Visakhapatnam'],
    ['Priya Raghavan', 2015, 'Product manager', 'Flipkart', 'Bengaluru'], ['Siddharth Rao', 2016, 'Architect', 'Self-employed', 'Pune'], ['Meghna Iyer', 2016, 'Teacher', 'Kendriya Vidyalaya', 'Kochi'],
    ['Farhan Qureshi', 2018, 'Student (MBA)', 'IIM Ahmedabad', 'Ahmedabad'], ['Tanvi Kulkarni', 2019, 'Data analyst', 'TCS', 'Mumbai'], ['Rahul Menon', 2020, 'Sub-lieutenant', 'Indian Navy', 'Kochi'], ['Ishita Verma', 2021, 'Student', 'IIT Bombay', 'Mumbai']] as const;
  const coord = await A(subjectTeacher.ENG);
  for (const [i, [name, year, occ, org2, city]] of AL.entries()) {
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@alumni.example`;
    const mobile = `98700${String(10000 + i).padStart(5, '0')}`;
    const c1 = (await alumni.requestCode(db, { destination: email, purpose: 'ALUMNI_REGISTER' })).sandboxCode!;
    const c2 = (await alumni.requestCode(db, { destination: mobile, purpose: 'ALUMNI_REGISTER' })).sandboxCode!;
    const r = await alumni.register(db, { schoolId: mb, name, email, mobile, leftYear: year, lastClass: 'XII', occupation: occ, organisation: org2, city, inDirectory: i % 4 !== 3, emailCode: c1, mobileCode: c2 });
    if (!r.verified && i < 8) {
      const a = await db.one<{ id: string }>('select id from alumnus where email = $1', [email]);
      await alumni.verify(db, coord, a.id, { approve: true, note: 'Checked the old admission registers' });
    }
  }
  await db.query(`update app_user set designation = 'Alumnus, batch of 2016' where alumnus_id = (select id from alumnus where name = 'Siddharth Rao')`);
  const reunion = await alumni.sendEvent(db, coord, mb, { title: 'Grand alumni reunion 2026', kind: 'REUNION', onDate: '2026-12-27', venue: 'School auditorium, Navy Nagar', body: 'All former pupils of NCS Mumbai are invited to the grand reunion on the last Sunday of December: assembly at 10:00, the school band, lunch and a walk through the old classrooms.' });
  for (const name of ['Arjun Deshpande', 'Neha Shetty', 'Priya Raghavan', 'Siddharth Rao']) {
    const u = await db.one<{ id: string }>(`select u.id from app_user u join alumnus a on a.id = u.alumnus_id where a.name = $1`, [name]);
    await alumni.rsvp(db, await A(u.id), reunion.id, { answer: name === 'Priya Raghavan' ? 'MAYBE' : 'YES', guests: name === 'Neha Shetty' ? 1 : 0 });
  }
  console.log(`Health, gate, stores and alumni done (${Math.round((Date.now() - t0) / 1000)}s)`);

  {
  // ── Governance: the Executive Committee (a past meeting with confirmed minutes and decisions being
  // carried out, the next meeting with its agenda), a School Managing Committee, the NES Conference,
  // a resolution out for votes; inspections with a checklist; sign-ins for the adoption figures.
  const nesUnit = (await db.one<{ id: string }>(`select id from org_unit where kind = 'society'`)).id;
  const wncId = (await db.one<{ id: string }>(`select id from app_user where role = 'COMMAND_OFFICER' and scope_path = 'nes.wnc'`)).id;
  const [ga, gf, gw, gp] = [await A(nesAdmin), await A(nesFinance), await A(wncId), await A(principal)];
  const kc = school['NCS-KC']?.id, dl = school['NCS-DL']?.id;
  const ec = await governance.createCommittee(db, ga, { unitId: nesUnit, kind: 'EXECUTIVE', quorum: 4,
    purpose: 'Policy for all Navy Children Schools and Navy Kindergartens: fees, staffing, academics and new schools. Meets every quarter.',
    members: [{ name: 'Rear Admiral (Retd) S. K. Nair', detail: 'Chairman’s nominee', role: 'CHAIR' }, { userId: nesAdmin, role: 'CONVENER' }, { userId: nesFinance, role: 'MEMBER' },
      { userId: wncId, role: 'MEMBER' }, { userId: principal, role: 'MEMBER' }, { userId: principalKc, role: 'MEMBER' }, { userId: principalDl, role: 'MEMBER' }] });
  // The committee has sat for a while: members' terms began in the spring.
  await db.query(`update committee_member set valid = daterange(current_date - 180, null) where committee_id = $1`, [ec.id]);
  const soonIso = () => new Date(Date.now() + 3600_000).toISOString();
  const m1 = await governance.scheduleMeeting(db, ga, ec.id, { startsAt: soonIso(), venue: 'Conference room, NES, New Delhi', videoLink: 'https://meet.example.org/nes-ec' });
  const items: Record<string, string> = {};
  for (const [who, title, details] of [[principal, 'Lighter summer uniform for Kindergartens', 'Parents report that the present uniform is too warm from April to June.'],
    [nesAdmin, 'Training on the new assessment framework', 'All TGTs and PGTs to be trained before the half-yearly examination.'],
    [principalKc, 'Fee concession for children of sailors on sea duty', 'A concession while the parent is on a long deployment.']] as const) {
    const it = await governance.submitItem(db, await A(who), ec.id, { title, details, meetingId: m1.id });
    if (it.status === 'SUBMITTED') await governance.triageItem(db, ga, it.id, { action: 'ACCEPT', meetingId: m1.id });
    items[title] = it.id;
  }
  await db.query(`update meeting set starts_at = now() - interval '20 days', agenda_closes = now() - interval '23 days' where id = $1`, [m1.id]);
  const mv = await governance.meeting(db, ga, m1.id);
  await governance.attendance(db, ga, m1.id, mv.attendance.map((a: any) => ({ memberId: a.member_id, status: a.name === 'Mrs Lata Menon' ? 'LEAVE' : 'PRESENT' as const })));
  const schools3 = [mb, kc, dl].filter(Boolean) as string[];
  await governance.recordDecision(db, ga, m1.id, { agendaItemId: items['Lighter summer uniform for Kindergartens'], title: 'Summer uniform for Kindergartens', body: 'Kindergartens move to a lighter cotton summer uniform from 1 April. Schools tell parents by January.',
    reason: 'Comfort of young children in the hot months.', ownerId: principal, dueOn: daysFromToday(70), schoolIds: schools3,
    actions: [{ title: 'Get samples from three suppliers', ownerId: teacher, dueOn: daysFromToday(10) }, { title: 'Circular to parents with the new specification', ownerId: principal, dueOn: daysFromToday(45) }] });
  await governance.recordDecision(db, ga, m1.id, { agendaItemId: items['Training on the new assessment framework'], title: 'Teachers trained on the new assessment framework', body: 'Every TGT and PGT attends a two-day workshop before the half-yearly examination.',
    ownerId: nesAdmin, dueOn: daysFromToday(25), schoolIds: schools3, actions: [{ title: 'Book resource persons for each Command', ownerId: nesAdmin, dueOn: daysFromToday(1) }] });
  await governance.recordDecision(db, ga, m1.id, { agendaItemId: items['Fee concession for children of sailors on sea duty'], title: 'Fee concession for children of sailors on sea duty', body: 'The finance officer to bring the cost and the rule to the next meeting.', outcome: 'NEEDS_MEETING' });
  await governance.saveMinutes(db, ga, m1.id, { note: 'The chair welcomed members. Mrs Lata Menon was granted leave of absence.', items: [
    { id: items['Lighter summer uniform for Kindergartens'], discussion: 'Members agreed the present uniform is unsuitable in summer. Samples to be seen before orders are placed.' },
    { id: items['Training on the new assessment framework'], discussion: 'NES to arrange the workshops Command by Command.' },
    { id: items['Fee concession for children of sailors on sea duty'], discussion: 'Members supported the idea but asked for the cost first.' }] });
  await governance.circulate(db, ga, m1.id);
  await governance.comment(db, gp, m1.id, 'Please record that parents were consulted through the PTA.');
  await governance.confirm(db, ga, m1.id);   // the chair is outside NavShiksha, so the convener confirms
  await db.query(`update meeting set confirmed_at = now() - interval '15 days', circulated_at = now() - interval '18 days' where id = $1`, [m1.id]).catch(() => null);
  const uniform = (await db.one<{ id: string }>(`select id from decision where title = 'Summer uniform for Kindergartens'`)).id;
  const samples = (await db.one<{ id: string }>(`select id from decision_action where decision_id = $1 and title like 'Get samples%'`, [uniform])).id;
  await governance.updateAction(db, await A(teacher), samples, { percent: 60, note: 'Two suppliers have sent samples; the third by Friday.' });
  await governance.acknowledge(db, gp, uniform, mb);
  await governance.reportAction(db, gp, uniform, mb, 'Samples shown at the PTA meeting; parents preferred the cotton blend. The order will be placed in December.');
  if (kc) await governance.acknowledge(db, await A(principalKc), uniform, kc);
  await governance.scheduleMeeting(db, ga, ec.id, { startsAt: new Date(Date.now() + 12 * 864e5).toISOString(), venue: 'Conference room, NES, New Delhi', videoLink: 'https://meet.example.org/nes-ec' });
  await governance.submitItem(db, await A(principalDl), ec.id, { title: 'A second section of Class XI Science at NCS Delhi', details: 'Forty-two Cat 1 applications for twenty-eight seats this year.' });
  const vote = await governance.proposeByCirculation(db, ga, ec.id, { title: 'School holiday on Navy Day', body: 'All schools close on 4 December for Navy Day; the day is made up on a Saturday in January.', closesOn: daysFromToday(3), schoolIds: schools3 });
  await governance.vote(db, gf, vote.id, { vote: 'YES' });

  const smc = await governance.createCommittee(db, gp, { unitId: mb, kind: 'SCHOOL_MANAGING', quorum: 3, purpose: 'Oversees the school’s budget, fees, staffing and development plan.',
    members: [{ name: 'Cmde (Station nominee)', detail: 'Chairman, Navy Nagar station', role: 'CHAIR' }, { userId: principal, role: 'CONVENER' }, { userId: accountant, role: 'MEMBER' },
      { userId: teacher, role: 'MEMBER' }, { name: 'Parent representative, Class X', detail: 'Elected by the PTA', role: 'MEMBER' }] });
  await governance.scheduleMeeting(db, gp, smc.id, { startsAt: new Date(Date.now() + 6 * 864e5).toISOString(), venue: 'Principal’s office, NCS Mumbai' });
  const conf = await governance.createCommittee(db, ga, { unitId: nesUnit, kind: 'CONFERENCE', quorum: 3, endsOn: daysFromToday(32), purpose: 'The annual conference of principals: sessions, topics from schools and resolutions followed through the year.',
    members: [{ userId: nesAdmin, role: 'CHAIR' }, { userId: nesFinance, role: 'CONVENER' }, { userId: principal, role: 'MEMBER' }, { userId: principalKc, role: 'MEMBER' }, { userId: principalDl, role: 'MEMBER' }] });
  await governance.scheduleMeeting(db, gf, conf.id, { title: 'Session 1: Assessment and the Holistic Progress Card', startsAt: new Date(Date.now() + 30 * 864e5).toISOString(), venue: 'NES Auditorium, New Delhi' });
  await governance.submitItem(db, gp, conf.id, { title: 'Sharing question banks across schools', details: 'A common bank of questions for periodic tests, built by subject teachers of all schools.' });

  // Inspections: NES's checklist, last month's inspection of NCS Mumbai, one planned at Kochi, Mumbai's own self-assessment.
  const tpl = await inspections.saveTemplate(db, ga, { unitId: nesUnit, name: 'Annual school inspection', scale: 4, purpose: 'The yearly inspection of every school by its Command.', sections: [
    { title: 'Safety and security', items: [{ text: 'Fire extinguishers in date and staff trained', weight: 2 }, { text: 'Evacuation drill held this term and recorded', weight: 2 }, { text: 'Gate register and visitor badges in use' }, { text: 'CCTV covering gates and corridors' }] },
    { title: 'Academics', items: [{ text: 'Lesson plans kept by every teacher' }, { text: 'Marks entered and published on time', weight: 2 }, { text: 'Remedial classes for students below 40%' }, { text: 'Library open to every class each week' }] },
    { title: 'Administration', items: [{ text: 'Fee collection reconciled with the bank every month', weight: 2 }, { text: 'Service books up to date' }, { text: 'Stores verified this year' }] },
    { title: 'Health and welfare', items: [{ text: 'Health check-ups done for every class' }, { text: 'Clean drinking water and toilets' }, { text: 'Child protection committee met this term', weight: 2 }] }] });
  const ins = await inspections.plan(db, gw, { schoolId: mb, templateId: tpl.id, kind: 'ANNUAL', scheduledOn: daysFromToday(0) });
  await db.query(`update inspection set scheduled_on = $2 where id = $1`, [ins.id, daysFromToday(-28)]);
  const ratings: [string, number | null][] = [['1.1', 4], ['1.2', 2], ['1.3', 4], ['1.4', 3], ['2.1', 3], ['2.2', 4], ['2.3', 3], ['2.4', 4], ['3.1', 4], ['3.2', 3], ['3.3', 2], ['4.1', 4], ['4.2', 4], ['4.3', 3]];
  await inspections.rate(db, gw, ins.id, ratings.map(([itemId, rating]) => ({ itemId, rating, remark: rating === 2 ? 'Needs attention' : '' })));
  await inspections.addFinding(db, gw, ins.id, { itemId: '1.2', severity: 'MAJOR', body: 'No evacuation drill recorded this term. Hold one and record it.', dueOn: daysFromToday(2) });
  await inspections.addFinding(db, gw, ins.id, { itemId: '3.3', severity: 'MINOR', body: 'Verify the stores and the asset register before the year ends.', dueOn: daysFromToday(60) });
  await inspections.addFinding(db, gw, ins.id, { severity: 'ADVISORY', body: 'Consider a reading corner in each primary classroom.' });
  await inspections.report(db, gw, ins.id, 'A well run school with strong academics and administration. The evacuation drill and stores verification need attention.');
  await db.query(`update inspection set reported_at = now() - interval '26 days' where id = $1`, [ins.id]);
  const drill = (await db.one<{ id: string }>(`select id from inspection_finding where inspection_id = $1 and item_id = '1.2'`, [ins.id])).id;
  await inspections.respond(db, gp, drill, 'Evacuation drill held on Monday with all classes; the building was cleared in 4 minutes 10 seconds. Recorded under Safety.');
  if (kc) await inspections.plan(db, ga, { schoolId: kc, templateId: tpl.id, kind: 'ANNUAL', scheduledOn: daysFromToday(14) });
  await inspections.plan(db, gp, { schoolId: mb, templateId: tpl.id, kind: 'SELF', title: 'Self-assessment before the annual inspection', scheduledOn: daysFromToday(0) });
  // Sign-ins over the last week, for "staff using NavShiksha".
  await db.query(`insert into sign_in_day (user_id, on_date) select u.id, current_date - d from app_user u, generate_series(0, 6) d
                   where u.role in ('SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF', 'NES_ADMIN', 'COMMAND_OFFICER') and u.active and (abs(hashtext(u.id::text || d::text)) % 3) > 0 on conflict do nothing`);
  console.log(`Governance and inspections done (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  // Staff chat groups: every school's staff, principals, NES and Command channels.
  await chat.syncAutoGroups(db);
  // Close the database so everything written reaches the disk before the process ends.
  await db.close?.();
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. Data in ${dir}`);
}

await main();
