import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, assertStudentAccess, can, studentGrants } from './access.js';
import * as notify from './notify.js';

/**
 * Health and safety at school: each child's health record (allergies, conditions, medication and
 * a one-line alert the class teacher sees), immunisations, yearly check-ups, the infirmary
 * register (with the parent told), incidents with follow-up, and safety drills.
 *
 * The parent and the nurse keep the health record; whoever holds the child's health grant reads it
 * (the parent, the class teacher, the counsellor, the nurse). Nothing is typed twice: the nurse's
 * visit takes medicines from the infirmary's stock in Stores, and alerts follow the child's class.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const today = () => localToday();

async function schoolOfStudent(db: Db, studentId: string) {
  const e = await db.maybeOne<{ school_id: string; section_id: string | null; name: string }>(
    `select e.school_id, e.section_id, s.name from enrolment e join student s on s.id = e.student_id where e.student_id = $1 and upper_inf(e.period) order by lower(e.period) desc limit 1`, [studentId]);
  if (!e) throw notFound('Student');
  return e;
}

// ── The health record ─────────────────────────────────────────────────────────────────────

export async function record(db: Db, actor: Actor, studentId: string) {
  if (!UUID.test(studentId)) throw notFound('Student');
  await assertStudentAccess(db, actor, studentId, 'health');
  const h = await db.maybeOne(`select h.allergies, h.conditions, h.medication, h.diet, h.alert, h.doctor, h.doctor_phone, h.updated_at, u.name as updated_by, h.version
                                 from student_health h join app_user u on u.id = h.updated_by where h.student_id = $1`, [studentId]);
  const blood = await db.one<{ blood_group: string | null; name: string }>('select blood_group, name from student where id = $1', [studentId]);
  return {
    student: blood.name, bloodGroup: blood.blood_group, record: h,
    immunisations: await db.query(`select id, vaccine, dose, given_on::text, due_on::text from immunisation where student_id = $1 order by coalesce(given_on, due_on)`, [studentId]),
    checkups: await db.query(`select id, on_date::text, height_cm::float, weight_kg::float, bmi::float, vision_left, vision_right, dental, hearing, notes from health_checkup where student_id = $1 order by on_date desc`, [studentId]),
    visits: await db.query(`select v.id, v.at, v.complaint, v.temperature_c::float, v.treatment, v.medicines, v.outcome, u.name as by from infirmary_visit v join app_user u on u.id = v.recorded_by where v.student_id = $1 order by v.at desc limit 30`, [studentId]),
  };
}

/** The parent (for their own child) or the nurse updates the health record. */
export async function update(db: Db, actor: Actor, studentId: string, input: Partial<{ allergies: string; conditions: string; medication: string; diet: string; alert: string; doctor: string; doctorPhone: string }>) {
  const e = await schoolOfStudent(db, studentId);
  if (actor.role === 'PARENT') await assertStudentAccess(db, actor, studentId, 'health');
  else await assertCan(db, actor, 'health.manage', e.school_id);
  const v = (x: string | undefined) => (x === undefined ? undefined : x.trim() || null);
  const cols = { allergies: v(input.allergies), conditions: v(input.conditions), medication: v(input.medication), diet: v(input.diet), alert: v(input.alert), doctor: v(input.doctor), doctor_phone: v(input.doctorPhone) };
  await db.tx(async (t) => {
    const set = Object.entries(cols).filter(([, x]) => x !== undefined);
    await t.query(`insert into student_health (student_id, updated_by) values ($1, $2) on conflict (student_id) do nothing`, [studentId, actor.id]);
    if (set.length) await t.query(`update student_health set ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_by = $2, updated_at = now() where student_id = $1`, [studentId, actor.id, ...set.map(([, x]) => x)]);
  }, { actor: actor.label });
  return record(db, actor, studentId);
}

export async function addImmunisation(db: Db, actor: Actor, studentId: string, input: { vaccine: string; dose?: string; givenOn?: string | null; dueOn?: string | null }) {
  const e = await schoolOfStudent(db, studentId);
  if (actor.role === 'PARENT') await assertStudentAccess(db, actor, studentId, 'health');
  else await assertCan(db, actor, 'health.manage', e.school_id);
  if (!input.givenOn && !input.dueOn) throw invalid('Give the date it was given, or when it is due.');
  return db.tx((t) => t.one<{ id: string }>(`insert into immunisation (student_id, vaccine, dose, given_on, due_on, recorded_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [studentId, input.vaccine.trim(), input.dose?.trim() ?? '', input.givenOn ?? null, input.dueOn ?? null, actor.id]), { actor: actor.label });
}

/** The yearly check-up for a whole class at once (height, weight, vision, teeth, hearing). */
export async function recordCheckups(db: Db, actor: Actor, schoolId: string, input: { onDate: string; rows: { studentId: string; heightCm?: number | null; weightKg?: number | null; visionLeft?: string; visionRight?: string; dental?: string; hearing?: string; notes?: string }[] }) {
  await assertCan(db, actor, 'health.manage', schoolId);
  if (input.onDate > today()) throw invalid('The check-up date cannot be in the future.');
  const ids = input.rows.map((r) => r.studentId);
  const ok = await db.query<{ student_id: string }>(`select student_id from enrolment where school_id = $1 and upper_inf(period) and student_id = any($2::uuid[])`, [schoolId, ids]);
  if (ok.length !== new Set(ids).size) throw invalid('Some children are not at this school.');
  await db.tx(async (t) => {
    for (const r of input.rows) await t.query(
      `insert into health_checkup (student_id, school_id, on_date, height_cm, weight_kg, vision_left, vision_right, dental, hearing, notes, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (student_id, on_date) do update set height_cm = excluded.height_cm, weight_kg = excluded.weight_kg, vision_left = excluded.vision_left, vision_right = excluded.vision_right,
              dental = excluded.dental, hearing = excluded.hearing, notes = excluded.notes, recorded_by = excluded.recorded_by`,
      [r.studentId, schoolId, input.onDate, r.heightCm ?? null, r.weightKg ?? null, r.visionLeft ?? null, r.visionRight ?? null, r.dental ?? null, r.hearing ?? null, r.notes ?? null, actor.id]);
  }, { actor: actor.label });
  return { saved: input.rows.length };
}

/** A class with each child's last check-up, for entering this year's (the nurse). */
export async function sectionSheet(db: Db, actor: Actor, sectionId: string) {
  const s = await db.maybeOne<{ school_id: string; name: string }>(`select c.parent_id as school_id, sec.class_code || '-' || sec.name as name from section sec join org_unit c on c.id = sec.campus_id where sec.id = $1`, [sectionId]);
  if (!s) throw notFound('Section');
  await assertCan(db, actor, 'health.manage', s.school_id);
  const rows = await db.query(
    `select st.id, st.name, st.blood_group, h.alert, h.allergies,
            (select row_to_json(x) from (select on_date::text, height_cm::float, weight_kg::float, bmi::float, vision_left, vision_right, dental, hearing from health_checkup c where c.student_id = st.id order by on_date desc limit 1) x) as last
       from enrolment e join student st on st.id = e.student_id left join student_health h on h.student_id = st.id
      where e.section_id = $1 and upper_inf(e.period) and e.status = 'ACTIVE' order by e.roll_no nulls last, st.name`, [sectionId]);
  return { section: s.name, schoolId: s.school_id, rows };
}

/**
 * Medical alerts for a class: each child's alert line and allergies. For the class teacher and
 * co-class teacher, the subject teachers of the class, the nurse and the principal.
 */
export async function classAlerts(db: Db, actor: Actor, sectionId: string) {
  const s = await db.maybeOne<{ school_id: string }>(`select c.parent_id as school_id from section sec join org_unit c on c.id = sec.campus_id where sec.id = $1`, [sectionId]);
  if (!s) throw notFound('Section');
  const teaches = await db.maybeOne(`select 1 from class_teacher where section_id = $1 and user_id = $2 and valid @> current_date
                                     union select 1 from teaching_load where section_id = $1 and teacher_id = $2`, [sectionId, actor.id]).catch(() => null);
  if (!teaches && !(await can(db, actor, 'health.manage', s.school_id))) throw forbidden('Medical alerts are shown to the class’s teachers and the nurse.');
  return db.query(
    `select st.id, st.name, st.blood_group, h.alert, h.allergies, h.medication
       from enrolment e join student st on st.id = e.student_id join student_health h on h.student_id = st.id
      where e.section_id = $1 and upper_inf(e.period) and (coalesce(h.alert, '') <> '' or coalesce(h.allergies, '') <> '') order by st.name`, [sectionId]);
}

// ── The infirmary ─────────────────────────────────────────────────────────────────────────

const OUTCOME: Record<string, string> = { BACK_TO_CLASS: 'went back to class', RESTED: 'rested in the infirmary', SENT_HOME: 'is being sent home', HOSPITAL: 'has been taken to hospital' };

/**
 * A visit to the infirmary. Medicines taken from the infirmary's stock come off it in Stores. The
 * parent is told every time a child is sent home or to hospital, and otherwise when the nurse says so.
 */
export async function recordVisit(db: Db, actor: Actor, schoolId: string, input: { studentId?: string | null; staffUserId?: string | null; complaint: string; temperatureC?: number | null; treatment?: string;
  medicines?: { name: string; dose?: string; itemId?: string; qty?: number }[]; outcome: 'BACK_TO_CLASS' | 'RESTED' | 'SENT_HOME' | 'HOSPITAL'; tellParent?: boolean }) {
  await assertCan(db, actor, 'health.manage', schoolId);
  if (!input.studentId === !input.staffUserId) throw invalid('Choose the child or the member of staff.');
  let student: { name: string } | null = null;
  if (input.studentId) {
    const e = await schoolOfStudent(db, input.studentId);
    if (e.school_id !== schoolId) throw invalid('This child is not at this school.');
    student = { name: e.name };
  }
  const tell = !!input.studentId && (input.tellParent || ['SENT_HOME', 'HOSPITAL'].includes(input.outcome));
  return db.tx(async (t) => {
    const v = await t.one<{ id: string; at: string }>(
      `insert into infirmary_visit (school_id, student_id, staff_user_id, complaint, temperature_c, treatment, medicines, outcome, parent_told_at, recorded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9 then now() end, $10) returning id, at`,
      [schoolId, input.studentId ?? null, input.staffUserId ?? null, input.complaint.trim(), input.temperatureC ?? null, input.treatment?.trim() ?? '', JSON.stringify(input.medicines ?? []), input.outcome, tell, actor.id]);
    for (const m of input.medicines ?? []) {
      if (!m.itemId || !m.qty) continue;
      const { issueIn } = await import('./stores.js');
      await issueIn(t, actor, schoolId, { itemId: m.itemId, qty: m.qty, department: 'Infirmary', note: `Infirmary visit ${v.id.slice(0, 8)}`, refType: 'infirmary_visit', refId: v.id });
    }
    if (tell) {
      const time = new Date(v.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      await notify.toParentsOf(t, [input.studentId!], { kind: 'HEALTH', title: `${student!.name.split(' ')[0]} visited the school infirmary`, body: `At ${time}: ${input.complaint.trim()}. ${input.treatment?.trim() ? `${input.treatment.trim()}. ` : ''}${student!.name.split(' ')[0]} ${OUTCOME[input.outcome]}.${input.outcome === 'SENT_HOME' ? ' Please collect your child from the school office.' : ''}`, link: '/health' });
    }
    if (input.outcome === 'HOSPITAL') {
      const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [schoolId]);
      await notify.toUsers(t, heads.map((h) => h.id), { kind: 'HEALTH', title: `${student?.name ?? 'A member of staff'} taken to hospital`, body: input.complaint.trim(), link: '/health' });
    }
    return { id: v.id, parentTold: tell };
  }, { actor: actor.label });
}

export async function visits(db: Db, actor: Actor, schoolId: string, on = today()) {
  await assertCan(db, actor, 'health.manage', schoolId);
  return db.query(
    `select v.id, v.at, v.complaint, v.temperature_c::float, v.treatment, v.medicines, v.outcome, v.parent_told_at, coalesce(st.name, su.name) as who, case when v.student_id is null then 'Staff' else e.class_code || '-' || sec.name end as class,
            h.alert, u.name as by
       from infirmary_visit v left join student st on st.id = v.student_id left join app_user su on su.id = v.staff_user_id left join student_health h on h.student_id = v.student_id
       left join enrolment e on e.student_id = v.student_id and upper_inf(e.period) left join section sec on sec.id = e.section_id join app_user u on u.id = v.recorded_by
      where v.school_id = $1 and (v.at at time zone 'Asia/Kolkata')::date = $2::date order by v.at desc`, [schoolId, on]);
}

/** Children at the school whose name or admission number matches, with their alert (the nurse's search). */
export async function find(db: Db, actor: Actor, schoolId: string, q: string) {
  await assertCan(db, actor, 'health.manage', schoolId);
  if (q.trim().length < 2) return [];
  return db.query(
    `select st.id, st.name, e.admission_no, e.class_code || '-' || coalesce(sec.name, '') as class, st.blood_group, h.alert, h.allergies
       from enrolment e join student st on st.id = e.student_id left join section sec on sec.id = e.section_id left join student_health h on h.student_id = st.id
      where e.school_id = $1 and upper_inf(e.period) and (st.name ilike '%' || $2 || '%' or e.admission_no ilike $2 || '%') order by st.name limit 20`, [schoolId, q.trim()]);
}

/** The nurse's overview: today's visits, children with alerts, immunisations due, check-ups not yet done this year. */
export async function overview(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'health.manage', schoolId);
  const fyStart = `${Number(today().slice(0, 4)) - (Number(today().slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
  return {
    today: await visits(db, actor, schoolId),
    alerts: await db.query(`select st.id, st.name, e.class_code || '-' || coalesce(sec.name, '') as class, h.alert, h.allergies from student_health h join student st on st.id = h.student_id
                              join enrolment e on e.student_id = st.id and upper_inf(e.period) and e.school_id = $1 left join section sec on sec.id = e.section_id
                             where coalesce(h.alert, '') <> '' order by e.class_code, st.name`, [schoolId]),
    immunisationsDue: await db.query(`select st.name, i.vaccine, i.dose, i.due_on::text from immunisation i join student st on st.id = i.student_id join enrolment e on e.student_id = st.id and upper_inf(e.period) and e.school_id = $1
                                       where i.given_on is null and i.due_on <= current_date + 30 order by i.due_on limit 100`, [schoolId]),
    checkupsDone: (await db.one<{ done: number; total: number }>(`select (select count(distinct c.student_id) from health_checkup c join enrolment e on e.student_id = c.student_id and upper_inf(e.period) and e.school_id = $1 where c.on_date >= $2)::int as done,
                                       (select count(*) from enrolment where school_id = $1 and upper_inf(period) and status = 'ACTIVE')::int as total`, [schoolId, fyStart])),
    sections: await db.query(`select sec.id, sec.class_code || '-' || sec.name as name from section sec join org_unit c on c.id = sec.campus_id where c.parent_id = $1 and sec.academic_year = (select code from academic_year where period @> current_date) order by sec.class_code, sec.name`, [schoolId]).catch(() => []),
  };
}

// ── Incidents ─────────────────────────────────────────────────────────────────────────────

const mayDealWith = (db: Db, actor: Actor, schoolId: string) => can(db, actor, 'safety.manage', schoolId);

/** Any member of staff reports an incident; the principal and the safety officer follow it up. */
export async function reportIncident(db: Db, actor: Actor, schoolId: string, input: { at: string; kind: string; severity: string; place: string; description: string; actionTaken?: string; studentIds?: string[]; staffIds?: string[]; confidential?: boolean; tellParents?: boolean }) {
  await assertUnitInScope(db, actor, schoolId);
  if (['PARENT', 'CANDIDATE', 'ALUMNUS'].includes(actor.role)) throw forbidden();
  const kids = input.studentIds ?? [];
  if (kids.length) {
    const ok = await db.query(`select 1 from enrolment where school_id = $1 and upper_inf(period) and student_id = any($2::uuid[])`, [schoolId, kids]);
    if (ok.length !== new Set(kids).size) throw invalid('Some children are not at this school.');
  }
  const confidential = !!input.confidential || input.kind === 'CHILD_PROTECTION';
  return db.tx(async (t) => {
    const r = await t.one<{ id: string; number: string }>(
      `insert into incident (school_id, at, kind, severity, place, description, action_taken, students, staff, confidential, parents_told, reported_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, number`,
      [schoolId, input.at, input.kind, input.severity, input.place.trim(), input.description.trim(), input.actionTaken?.trim() ?? '', kids, input.staffIds ?? [], confidential, !!input.tellParents && !confidential, actor.id]);
    const leads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and (
        (u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path) or exists (select 1 from duty d where d.user_id = u.id and d.school_id = $1 and d.code = 'SAFETY_OFFICER' and d.valid @> current_date))`, [schoolId]);
    await notify.toUsers(t, leads.map((l) => l.id).filter((id) => id !== actor.id), { kind: 'HEALTH', title: `${r.number}: ${input.severity.toLowerCase()} ${input.kind.toLowerCase().replace('_', ' ')} incident`, body: confidential ? 'Confidential: open it in Health and safety.' : input.place, link: '/safety' });
    if (input.tellParents && !confidential && kids.length) await notify.toParentsOf(t, kids, { kind: 'HEALTH', title: 'A note from school about an incident today', body: `${input.place}: ${input.actionTaken?.trim() || 'The school is looking after it.'} Please contact the class teacher if you have questions.`, link: '/notifications' });
    return r;
  }, { actor: actor.label });
}

export async function incidents(db: Db, actor: Actor, schoolId: string, status = 'OPEN') {
  await assertUnitInScope(db, actor, schoolId);
  const lead = await mayDealWith(db, actor, schoolId);
  return db.query(
    `select i.id, i.number, i.at, i.kind, i.severity, i.place, i.status, i.confidential, i.parents_told, u.name as reported_by,
            case when i.confidential and not $3 then null else i.description end as description, i.action_taken,
            (select coalesce(jsonb_agg(s.name order by s.name), '[]') from student s where s.id = any(i.students)) as students,
            (select coalesce(jsonb_agg(jsonb_build_object('note', x.note, 'by', b.name, 'at', x.at) order by x.id), '[]') from incident_update x join app_user b on b.id = x.by_user where x.incident_id = i.id) as updates
       from incident i join app_user u on u.id = i.reported_by
      where i.school_id = $1 and ($2 = 'ALL' or i.status = $2) and ($3 or i.reported_by = $4) and (not i.confidential or $3)
      order by i.at desc limit 200`, [schoolId, status, lead, actor.id]);
}

export async function updateIncident(db: Db, actor: Actor, id: string, input: { note: string; close?: boolean }) {
  const i = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from incident where id = $1', [id]);
  if (!i) throw notFound('Incident');
  if (!(await mayDealWith(db, actor, i.school_id))) throw forbidden('The principal or the safety officer follows incidents up.');
  if (i.status === 'CLOSED') throw conflict('closed', 'This incident is closed.');
  if (input.note.trim().length < 3) throw invalid('Write the follow-up.');
  await db.tx(async (t) => {
    await t.query('insert into incident_update (incident_id, note, by_user) values ($1, $2, $3)', [id, input.note.trim(), actor.id]);
    if (input.close) await t.query(`update incident set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`, [id, actor.id]);
  }, { actor: actor.label });
  return { status: input.close ? 'CLOSED' : 'OPEN' };
}

// ── Safety drills ─────────────────────────────────────────────────────────────────────────

export async function recordDrill(db: Db, actor: Actor, schoolId: string, input: { kind: string; onDate: string; startedAt?: string; minutesToClear?: number | null; participants?: number | null; observations?: string; actions?: string }) {
  if (!(await mayDealWith(db, actor, schoolId))) throw forbidden('The principal or the safety officer records drills.');
  if (input.onDate > today()) throw invalid('Record a drill once it has been held.');
  return db.tx((t) => t.one<{ id: string }>(`insert into safety_drill (school_id, kind, on_date, started_at, minutes_to_clear, participants, observations, actions, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [schoolId, input.kind, input.onDate, input.startedAt ?? null, input.minutesToClear ?? null, input.participants ?? null, input.observations?.trim() ?? '', input.actions?.trim() ?? '', actor.id]), { actor: actor.label });
}

/** Drills held, and whether one of each main kind is overdue (fire every 3 months, the others every 6). */
export async function drills(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  const list = await db.query<{ kind: string; on_date: string }>(`select d.id, d.kind, d.on_date::text, d.started_at::text, d.minutes_to_clear::float, d.participants, d.observations, d.actions, u.name as by
                                    from safety_drill d join app_user u on u.id = d.recorded_by where d.school_id = $1 order by d.on_date desc limit 100`, [schoolId]);
  const due: { kind: string; last: string | null; overdue: boolean }[] = [];
  for (const [kind, months] of [['FIRE', 3], ['EARTHQUAKE', 6], ['LOCKDOWN', 6]] as const) {
    const last = list.find((d) => d.kind === kind)?.on_date ?? null;
    const limit = new Date(); limit.setMonth(limit.getMonth() - months);
    due.push({ kind, last, overdue: !last || last < limit.toISOString().slice(0, 10) });
  }
  return { drills: list, due };
}

/** The parent's view of their child's health (the parent app). */
export async function forParent(db: Db, actor: Actor, studentId: string) {
  if (actor.role !== 'PARENT') throw forbidden();
  const g = await studentGrants(db, actor, studentId);
  if (!g.has('health')) throw forbidden();
  return record(db, actor, studentId);
}
