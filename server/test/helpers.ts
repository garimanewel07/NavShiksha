import { openDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { fromDbError } from '../src/lib/errors.js';
import { publishScheme } from '../src/modules/categories.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { move } from '../src/modules/transfers.js';
import { rupees } from '../src/lib/money.js';
import { ADMISSION_RULES, FEE_BAND_RULES, TUITION_OFFICER, BAND_FACTOR } from '../src/reference/nes-defaults.js';

export const YEAR = '2026-27';
let phone = 9900000000;
export const nextPhone = () => `+91${phone++}`;

export interface World {
  db: Db;
  schoolA: string; campusA: string; schoolB: string; campusB: string;
  sectionsA: Record<string, string[]>;
  planA: string;
  admin: Actor; finance: Actor; principalA: Actor; teacherA: Actor;
}

/** A small, complete network in a fresh in-memory database. */
export async function makeWorld(): Promise<World> {
  const db = await openDb();
  await migrate(db);
  await db.query(`insert into academic_year (code, period) values ($1, daterange('2026-04-01', '2027-04-01'))`, [YEAR]);
  const ins = (kind: string, code: string, name: string, parent: string | null, type: string | null = null, address: string | null = null) =>
    db.one<{ id: string }>(`insert into org_unit (kind, code, name, parent_id, school_type, address) values ($1,$2,$3,$4,$5,$6) returning id`, [kind, code, name, parent, type, address]).then((r) => r.id);
  const nes = await ins('society', 'NES', 'Navy Education Society', null);
  const wnc = await ins('command', 'WNC', 'Western Naval Command', nes);
  const enc = await ins('command', 'ENC', 'Eastern Naval Command', nes);
  const schoolA = await ins('school', 'NCS-A', 'NCS Alpha', wnc, 'NCS');
  const campusA = await ins('campus', 'NCS-A-1', 'Alpha Main', schoolA, null, 'Alpha Road');
  const schoolB = await ins('school', 'NCS-B', 'NCS Bravo', enc, 'NCS');
  const campusB = await ins('campus', 'NCS-B-1', 'Bravo Main', schoolB, null, 'Bravo Road');
  const sectionsA: Record<string, string[]> = {};
  for (const [campus, cls, cap] of [[campusA, 'VIII', 2], [campusA, 'X', 30], [campusB, 'VIII', 30], [campusB, 'X', 30]] as const) {
    for (const n of ['A', 'B']) {
      const r = await db.one<{ id: string }>(`insert into section (campus_id, academic_year, class_code, name, capacity) values ($1,$2,$3,$4,$5) returning id`, [campus, YEAR, cls, n, cap]);
      if (campus === campusA) (sectionsA[cls] ??= []).push(r.id);
    }
  }
  await publishScheme(db, { schoolId: null, kind: 'ADMISSION', name: 'NES admission categories', validFrom: '2026-04-01', rules: ADMISSION_RULES }, 'test');
  await publishScheme(db, { schoolId: null, kind: 'FEE_BAND', name: 'NES fee bands', validFrom: '2026-04-01', rules: FEE_BAND_RULES }, 'test');
  let planA = '';
  for (const s of [schoolA, schoolB]) {
    const p = await db.one<{ id: string }>(`insert into fee_plan (school_id, academic_year, name) values ($1, $2, 'Fees') returning id`, [s, YEAR]);
    if (s === schoolA) planA = p.id;
    for (const [code, a, b] of [['Q1', '2026-04-01', '2026-07-01'], ['Q2', '2026-07-01', '2026-10-01'], ['Q3', '2026-10-01', '2027-01-01'], ['Q4', '2027-01-01', '2027-04-01']]) {
      await db.query(`insert into fee_installment values ($1, $2, $2, $3::date + 24, daterange($3::date, $4::date))`, [p.id, code, a, b]);
    }
    const v = await db.tx((t) => t.one<{ id: string }>(`insert into fee_plan_version (plan_id, version, valid) values ($1, 1, daterange('2026-04-01', null)) returning id`, [p.id]), { actor: 'maker' });
    for (const [cb, base] of Object.entries(TUITION_OFFICER)) for (const [fb, f] of Object.entries(BAND_FACTOR)) {
      await db.query(`insert into fee_rate values ($1,$2,$3,'TUITION','QUARTERLY',$4)`, [v.id, cb, fb, rupees(Math.round((base * f) / 10) * 10)]);
      await db.query(`insert into fee_rate values ($1,$2,$3,'ANNUAL','ANNUAL',$4)`, [v.id, cb, fb, rupees(4500)]);
    }
    await db.query(`update fee_plan_version set status = 'PUBLISHED', approved_by = 'checker', published_at = now() where id = $1`, [v.id]);
  }
  await db.query(`insert into concession_rule (name, condition, head_code, percent, priority, valid) values ('Sibling', '{"gte":["sibling_rank",2]}', 'TUITION', 10, 1, daterange('2026-04-01', null))`);
  const user = async (name: string, role: string, scope: string) =>
    loadActor(db, (await db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3::ltree) returning id`, [name, role, scope])).id);
  const teacherA = await user('Teacher Alpha', 'TEACHER', 'nes.wnc.ncs_a');
  for (const sc of [schoolA, schoolB]) await defaultBell(db, sc, ['VIII', 'X'], '2026-04-01', teacherA.id);
  // Teacher Alpha is class teacher of X-A and teaches X-B one period a week.
  await db.query(`insert into class_teacher (section_id, user_id, kind, valid, assigned_by) values ($1, $2, 'CLASS', daterange(current_date, '2027-04-01'), $2)`, [sectionsA.X[0], teacherA.id]);
  const tt = await db.one<{ id: string }>(`insert into timetable (section_id, valid, created_by) values ($1, daterange('2026-04-01', null), $2) returning id`, [sectionsA.X[1], teacherA.id]);
  await db.query(`insert into timetable_slot (timetable_id, weekday, period, starts, ends, subject_code, teacher_id) values ($1, 1, 1, '08:00', '08:40', 'MAT', $2)`, [tt.id, teacherA.id]);
  return {
    db, schoolA, campusA, schoolB, campusB, sectionsA, planA, teacherA,
    admin: await user('NES Admin', 'NES_ADMIN', 'nes'),
    finance: await user('NES Finance', 'NES_ADMIN', 'nes'),
    principalA: await user('Principal Alpha', 'SCHOOL_ADMIN', 'nes.wnc.ncs_a'),
  };
}

/** Standard timings: assembly, eight 40-minute periods, a short break after P3 and lunch after P5, Monday to Friday. */
export const BELL = [['ASSEMBLY', 'Assembly', null, '07:40', '08:00'], ['PERIOD', 'Period 1', 1, '08:00', '08:40'], ['PERIOD', 'Period 2', 2, '08:40', '09:20'],
  ['PERIOD', 'Period 3', 3, '09:20', '10:00'], ['BREAK', 'Short break', null, '10:00', '10:15'], ['PERIOD', 'Period 4', 4, '10:15', '10:55'],
  ['PERIOD', 'Period 5', 5, '10:55', '11:35'], ['LUNCH', 'Lunch', null, '11:35', '12:05'], ['PERIOD', 'Period 6', 6, '12:05', '12:45'],
  ['PERIOD', 'Period 7', 7, '12:45', '13:25'], ['PERIOD', 'Period 8', 8, '13:25', '14:00']] as const;

export async function defaultBell(db: Db, schoolId: string, classes: string[], from: string, userId: string) {
  const b = await db.one<{ id: string }>(`insert into bell_schedule (school_id, name, class_codes, valid, created_by) values ($1, 'Main timings', $2, daterange($3::date, null), $4) returning id`, [schoolId, classes, from, userId]);
  for (let d = 1; d <= 5; d++) for (const [i, [kind, label, p, a, z]] of BELL.entries()) {
    await db.query(`insert into bell_slot (schedule_id, weekday, seq, kind, label, period_no, starts, ends) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [b.id, d, i + 1, kind, label, p, a, z]);
  }
  return b.id;
}

export interface FamilyInput {
  service?: string; status?: string; rank?: string | null; posted?: boolean; rel?: string; classCode?: string; section?: number; start?: string;
}

/** Inserts a guardian (with a service record and a parent login) and one enrolled child at school A. */
export async function family(w: World, f: FamilyInput = {}) {
  const { db } = w;
  const service = f.service ?? 'NAVY';
  const rank = f.rank === undefined ? (['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD'].includes(service) ? 'N_PO' : null) : f.rank;
  const g = await db.one<{ id: string }>(`insert into guardian (name, phone) values ('Parent Test', $1) returning id`, [nextPhone()]);
  await db.query(`insert into guardian_service_fact (guardian_id, valid, service, status, rank_code, posted_in_station) values ($1, daterange('2026-01-01', null), $2, $3, $4, $5)`,
    [g.id, service, f.status ?? 'SERVING', rank, f.posted ?? true]);
  const s = await db.one<{ id: string }>(`insert into student (name, dob, gender) values ('Child Test', '2013-06-01', 'F') returning id`);
  await db.query(`insert into student_guardian values ($1, $2, $3, true)`, [s.id, g.id, f.rel ?? 'FATHER']);
  const cls = f.classCode ?? 'X';
  const sec = w.sectionsA[cls][f.section ?? 0];
  const e = await db.one<{ id: string }>(
    `insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
     values ($1, $2, $3, $4, $5, $6, 'A/' || substr(md5(random()::text), 1, 8), 'ACTIVE', daterange($7::date, null), '1', '{}') returning id`,
    [s.id, w.schoolA, w.campusA, sec, YEAR, cls, f.start ?? '2026-04-01']);
  const parent = await loadActor(db, (await db.one<{ id: string }>(`insert into app_user (name, role, guardian_id) values ('Parent Test', 'PARENT', $1) returning id`, [g.id])).id);
  return { guardianId: g.id, studentId: s.id, enrolmentId: e.id, parent };
}

/** Expects a promise to fail with a message matching the pattern. */
export async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try { await p; } catch (e) {
    // Match the raw message or the one users see after the API maps database errors.
    const msg = (e as Error).message;
    const shown = fromDbError(e)?.message ?? msg;
    if (!pattern.test(msg) && !pattern.test(shown)) throw new Error(`Failed with "${msg}", expected ${pattern}`);
    return;
  }
  throw new Error(`Expected failure matching ${pattern}, but it succeeded`);
}

/** A move already made earlier in the year (history), written directly as the seed does. */
export function movedEarlier(w: World, studentId: string, toCampusId: string, date: string, reason = 'Posting') {
  return w.db.tx((t) => move(t, w.admin, { studentId, toCampusId, date, reason }), { actor: 'test' });
}
