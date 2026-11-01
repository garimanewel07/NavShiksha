import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';

export type Role = 'NES_ADMIN' | 'COMMAND_OFFICER' | 'SCHOOL_ADMIN' | 'ACCOUNTANT' | 'TEACHER' | 'STAFF' | 'PARENT' | 'SUPPORT' | 'DEVELOPER' | 'CANDIDATE' | 'ALUMNUS';

export interface Actor {
  id: string;
  name: string;
  role: Role;
  designation: string | null;
  scopePath: string | null;
  guardianId: string | null;
  candidateId?: string | null;
  /** Written into the audit log for every change this person makes. */
  label: string;
  /** Duties held today, e.g. timetable coordinator at a school. */
  duties: { schoolId: string; code: string }[];
}

const STAFF: Role[] = ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER'];

export async function loadActor(db: Db, userId: string): Promise<Actor> {
  const u = await db.maybeOne<{ id: string; name: string; role: Role; designation: string | null; scope_path: string | null; guardian_id: string | null; candidate_id: string | null; active: boolean }>(
    'select id, name, role, designation, scope_path::text, guardian_id, candidate_id, active from app_user where id = $1', [userId]);
  if (!u || !u.active) throw notFound('User');
  // Someone who has left keeps their sign-in for payslips and tax forms, and nothing else.
  const left = !!(await db.maybeOne('select 1 from employee where user_id = $1 and separated_on < current_date', [u.id]));
  const duties = left ? [] : await db.query<{ school_id: string; code: string }>('select school_id, code from duty where user_id = $1 and valid @> current_date', [u.id]);
  return { id: u.id, name: u.name, role: left ? 'STAFF' : u.role, designation: u.designation, scopePath: u.scope_path, guardianId: u.guardian_id, candidateId: u.candidate_id, label: `${u.name} <${u.id}>`,
    duties: duties.map((d) => ({ schoolId: d.school_id, code: d.code })) };
}

/**
 * Development sign-in: pick a seeded user. Production replaces only this function with
 * Keycloak (staff, MFA) and OTP (parents); everything downstream uses the same Actor.
 */
export async function devLogin(db: Db, userId: string) {
  const actor = await loadActor(db, userId);
  const token = randomBytes(24).toString('base64url');
  await db.query(`insert into app_session (token, user_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [token, actor.id]);
  // One row a day per person, for the "staff using NavShiksha" figure; nothing else is tracked.
  await db.query(`insert into sign_in_day (user_id, on_date) values ($1, (now() at time zone 'Asia/Kolkata')::date) on conflict do nothing`, [actor.id]);
  return { token, actor };
}

export async function actorFromToken(db: Db, token: string | undefined): Promise<Actor> {
  if (!token) throw new AppError(401, 'signed_out', 'Please sign in.');
  const s = await db.maybeOne<{ user_id: string }>('select user_id from app_session where token = $1 and expires_at > now()', [token]);
  if (!s) throw new AppError(401, 'signed_out', 'Your session has ended. Please sign in again.');
  return loadActor(db, s.user_id);
}

export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!roles.includes(actor.role)) throw forbidden();
}

export const isStaff = (a: Actor) => STAFF.includes(a.role);

/** A staff member may act on a school (or campus) only inside their part of the NES tree. */
export async function assertUnitInScope(db: Db, actor: Actor, unitId: string) {
  if (!actor.scopePath) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(unitId)) throw forbidden('Choose a school.');
  const ok = await db.maybeOne('select 1 from org_unit where id = $1 and path <@ $2::ltree', [unitId, actor.scopePath]);
  if (!ok) throw forbidden('This school is outside your access.');
}

export async function listDemoUsers(db: Db) {
  return db.query(`select u.id, u.name, u.role, u.designation, coalesce(o.name, case u.role when 'CANDIDATE' then 'NavShiksha Careers' when 'PARENT' then 'Parent' else 'NavShiksha support' end) as unit
                     from app_user u left join org_unit o on o.path = u.scope_path
                    where u.active and u.designation is not null order by array_position(array['NES_ADMIN','COMMAND_OFFICER','SCHOOL_ADMIN','ACCOUNTANT','TEACHER','STAFF','PARENT','CANDIDATE','SUPPORT','DEVELOPER'], u.role), u.name`);
}
