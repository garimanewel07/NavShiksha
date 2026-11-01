import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { addDays, localToday } from '../lib/dates.js';
import type { Actor } from './auth.js';
import { assertCan } from './access.js';
import * as notify from './notify.js';

/**
 * Staff leave and attendance. Leave is a ledger: every yearly credit and every day taken is a row,
 * and the balance is their sum, never typed in. A sanctioned leave marks the days in the staff
 * register and, for a teacher, records the absence so the timetable arranges cover. Absence
 * without sanctioned leave becomes loss of pay when the month's payroll is run.
 */

interface Staff { user_id: string; name: string; school_id: string; category: string; gender: string | null; joined_service: string; separated_on: string | null; role: string }

async function staffMember(db: Db, userId: string) {
  const s = await db.maybeOne<Staff>(
    `select e.user_id, u.name, e.school_id, e.category, e.gender, e.joined_service::text, e.separated_on::text, u.role from employee e join app_user u on u.id = e.user_id where e.user_id = $1`, [userId]);
  if (!s) throw notFound('Staff record');
  return s;
}

/** The school's holidays (its own, its Command's and NES's) between two dates, as a set of dates. */
export async function holidays(db: Db, schoolId: string, from: string, to: string) {
  const rows = await db.query<{ d: string }>(
    `select generate_series(greatest(lower(c.period), $2::date), least(upper(c.period) - 1, $3::date), '1 day')::date::text as d
       from calendar_event c join org_unit u on u.id = c.unit_id join org_unit s on s.id = $1
      where c.kind in ('HOLIDAY', 'VACATION') and (s.path <@ u.path or u.path <@ s.path) and c.period && daterange($2::date, $3::date, '[]')`, [schoolId, from, to]);
  return new Set(rows.map((r) => r.d));
}

/** Days a leave counts: casual leave skips Sundays and holidays; other leave counts every day. */
async function countDays(db: Db, schoolId: string, code: string, from: string, to: string) {
  if (code !== 'CL') return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  const off = await holidays(db, schoolId, from, to);
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && !off.has(d)) n++;
  return n;
}

export async function types(db: Db) {
  return db.query('select code, name, pay, credit_teaching::float, credit_other::float, max_balance::float, gender, max_per_spell::float from staff_leave_type order by ordinal');
}

export async function balances(db: Db, userId: string) {
  return db.query<{ code: string; name: string; pay: string; balance: number; gender: string | null }>(
    `select t.code, t.name, t.pay, t.gender, coalesce(sum(l.days), 0)::float as balance
       from staff_leave_type t left join staff_leave_ledger l on l.leave_code = t.code and l.user_id = $1 group by t.code, t.name, t.pay, t.gender, t.ordinal order by t.ordinal`, [userId]);
}

/**
 * The yearly credit, once per person per year (on 1 January), by teaching or non-teaching staff,
 * pro rata for those who joined during the year, and never above the leave's maximum balance.
 */
export async function creditYear(db: Db, actor: Actor, schoolId: string, year: number) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  const people = await db.query<Staff>(`select e.user_id, u.name, e.school_id, e.category, e.gender, e.joined_service::text, e.separated_on::text, u.role
     from employee e join app_user u on u.id = e.user_id where e.school_id = $1 and e.separated_on is null and e.employment in ('PERMANENT', 'CONTRACT', 'TEMPORARY')`, [schoolId]);
  return { credited: await db.tx((t) => credit(t, actor.id, people, year), { actor: actor.label }) };
}

/** The year's credit for these people (also run for someone who joins during the year, pro rata). */
export async function credit(t: Db, actorId: string, people: Pick<Staff, 'user_id' | 'category' | 'joined_service'>[], year: number) {
  const kinds = await t.query<{ code: string; credit_teaching: number; credit_other: number; max_balance: number | null }>(
    `select code, credit_teaching::float, credit_other::float, max_balance::float from staff_leave_type where credit_teaching > 0 or credit_other > 0`);
  const on = `${year}-01-01`;
  let credited = 0;
  {
    for (const p of people) for (const k of kinds) {
      const reason = `Yearly credit ${year}`;
      if (await t.maybeOne('select 1 from staff_leave_ledger where user_id = $1 and leave_code = $2 and reason = $3', [p.user_id, k.code, reason])) continue;
      let days = p.category === 'TEACHING' ? k.credit_teaching : k.credit_other;
      if (p.joined_service > on) days = Math.floor((days * (12 - new Date(`${p.joined_service}T00:00:00Z`).getUTCMonth())) / 12 * 2) / 2;
      if (k.max_balance !== null) {
        const bal = (await t.one<{ b: number }>('select coalesce(sum(days), 0)::float as b from staff_leave_ledger where user_id = $1 and leave_code = $2', [p.user_id, k.code])).b;
        // Casual leave does not carry over: the year starts afresh.
        if (k.code === 'CL' && bal > 0) await t.query(`insert into staff_leave_ledger (user_id, leave_code, on_date, days, reason, entered_by) values ($1, 'CL', $2, $3, $4, $5)`, [p.user_id, on, -bal, `Unused casual leave of ${year - 1} lapses`, actorId]);
        else days = Math.min(days, Math.max(0, k.max_balance - bal));
      }
      if (days <= 0) continue;
      await t.query(`insert into staff_leave_ledger (user_id, leave_code, on_date, days, reason, entered_by) values ($1, $2, $3, $4, $5, $6)`, [p.user_id, k.code, on, days, reason, actorId]);
      credited++;
    }
  }
  return credited;
}

/** A member of staff applies for leave in the staff app. The principal decides. */
export async function apply(db: Db, actor: Actor, input: { leaveCode: string; from: string; to: string; halfDay?: boolean; reason: string; forUserId?: string }) {
  const userId = input.forUserId ?? actor.id;
  const s = await staffMember(db, userId);
  if (userId !== actor.id) await assertCan(db, actor, 'staff.manage', s.school_id);
  if (s.separated_on) throw conflict('left', 'This person has left the school.');
  const k = await db.maybeOne<{ code: string; name: string; pay: string; gender: string | null; max_per_spell: number | null; credit: boolean }>(
    `select code, name, pay, gender, max_per_spell::float, (credit_teaching > 0 or credit_other > 0) as credit from staff_leave_type where code = $1`, [input.leaveCode]);
  if (!k) throw invalid('Choose a kind of leave.');
  if (k.gender && s.gender && k.gender !== s.gender) throw invalid(`${k.name} is not available to this person.`);
  if (input.to < input.from) throw invalid('The last day is before the first.');
  if (input.halfDay && input.from !== input.to) throw invalid('A half day is a single date.');
  if (input.reason.trim().length < 3) throw invalid('Give a reason.');
  const days = input.halfDay ? 0.5 : await countDays(db, s.school_id, k.code, input.from, input.to);
  if (days <= 0) throw invalid('Those dates are all holidays.');
  if (k.max_per_spell !== null && days > k.max_per_spell) throw invalid(`${k.name} can be taken for at most ${k.max_per_spell} days at a time.`);
  if (k.credit) {
    const bal = (await balances(db, userId)).find((b) => b.code === k.code)?.balance ?? 0;
    const pending = (await db.one<{ d: number }>(`select coalesce(sum(days), 0)::float as d from staff_leave_request where user_id = $1 and leave_code = $2 and status = 'PENDING'`, [userId, k.code])).d;
    if (days > bal - pending) throw invalid(`Not enough ${k.name.toLowerCase()}: ${bal - pending} days left${pending ? ` (${pending} waiting for a decision)` : ''}.`);
  }
  if (await db.maybeOne(`select 1 from staff_leave_request where user_id = $1 and status in ('PENDING', 'APPROVED') and period && daterange($2::date, $3::date, '[]')`, [userId, input.from, input.to])) {
    throw conflict('overlap', 'There is already leave on some of these days.');
  }
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(
      `insert into staff_leave_request (user_id, school_id, leave_code, period, days, half_day, reason) values ($1, $2, $3, daterange($4::date, $5::date, '[]'), $6, $7, $8) returning id`,
      [userId, s.school_id, k.code, input.from, input.to, days, !!input.halfDay, input.reason.trim()]);
    const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path and u.id <> $2`, [s.school_id, userId]);
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'LEAVE', title: `Leave asked: ${s.name}`, body: `${k.name}, ${days} day${days === 1 ? '' : 's'} from ${notify.fmt(input.from)}. ${input.reason.trim()}`.slice(0, 300), link: '/staff-leave' });
    return { id: r.id, days };
  }, { actor: actor.label });
}

async function loadRequest(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Leave request');
  const r = await db.maybeOne<{ id: string; user_id: string; school_id: string; leave_code: string; from: string; to: string; days: number; status: string; half_day: boolean; name: string; leave: string }>(
    `select r.id, r.user_id, r.school_id, r.leave_code, lower(r.period)::text as from, (upper(r.period) - 1)::text as to, r.days::float as days, r.status, r.half_day, u.name, t.name as leave
       from staff_leave_request r join app_user u on u.id = r.user_id join staff_leave_type t on t.code = r.leave_code where r.id = $1`, [id]);
  if (!r) throw notFound('Leave request');
  return r;
}

/** Marks a sanctioned leave in the register, and for a teacher records the absence so cover is arranged. */
async function takeEffect(t: Db, actor: Actor, r: Awaited<ReturnType<typeof loadRequest>>) {
  await t.query(`insert into staff_leave_ledger (user_id, leave_code, on_date, days, reason, request_id, entered_by) values ($1, $2, $3, $4, $5, $6, $7)`,
    [r.user_id, r.leave_code, r.from, -r.days, `${r.leave} ${r.from}${r.to !== r.from ? ` to ${r.to}` : ''}`, r.id, actor.id]);
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
    await t.query(`insert into staff_attendance (user_id, on_date, status, source, marked_by) values ($1, $2, $3, 'LEAVE', $4)
                   on conflict (user_id, on_date) do update set status = excluded.status, source = 'LEAVE', marked_by = excluded.marked_by, marked_at = now()`,
      [r.user_id, d, r.half_day ? 'H' : 'L', actor.id]);
  }
  const teacher = await t.maybeOne(`select 1 from app_user where id = $1 and role in ('TEACHER', 'SCHOOL_ADMIN')`, [r.user_id]);
  if (teacher && !r.half_day && r.to >= localToday()) {
    await t.query(`insert into teacher_absence (school_id, teacher_id, period, reason, recorded_by) values ($1, $2, daterange(greatest($3::date, current_date), ($4::date + 1)), $5, $6)
                   on conflict do nothing`, [r.school_id, r.user_id, r.from, r.to, `On leave: ${r.leave}`, actor.id]).catch(() => null);
  }
}

export async function decide(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  const r = await loadRequest(db, id);
  await assertCan(db, actor, 'staff.manage', r.school_id);
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('Staff leave is sanctioned by the principal.');
  if (r.user_id === actor.id) throw forbidden('Your own leave is sanctioned by someone else.');
  if (r.status !== 'PENDING') throw conflict('decided', 'Already decided.');
  if (!approve && (!note || note.trim().length < 3)) throw invalid('Give the reason for refusing.');
  return db.tx(async (t) => {
    await t.query(`update staff_leave_request set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1`, [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note?.trim() || null]);
    if (approve) await takeEffect(t, actor, r);
    await notify.toUsers(t, [r.user_id], { kind: 'LEAVE', title: approve ? `${r.leave} sanctioned` : `${r.leave} not sanctioned`, body: `${notify.fmt(r.from)}${r.to !== r.from ? ` to ${notify.fmt(r.to)}` : ''}${note ? `. ${note.trim()}` : ''}`, link: '/my/pay' });
    return { status: approve ? 'APPROVED' : 'REJECTED' };
  }, { actor: actor.label });
}

/** Withdraws leave before it starts. Sanctioned leave is given back to the balance and the register cleared. */
export async function cancel(db: Db, actor: Actor, id: string) {
  const r = await loadRequest(db, id);
  if (r.user_id !== actor.id) await assertCan(db, actor, 'staff.manage', r.school_id);
  if (!['PENDING', 'APPROVED'].includes(r.status)) throw conflict('closed', 'This request is closed.');
  if (r.status === 'APPROVED' && r.from <= localToday()) throw conflict('started', 'Leave that has started cannot be withdrawn; ask the office to correct the register.');
  return db.tx(async (t) => {
    await t.query(`update staff_leave_request set status = 'CANCELLED' where id = $1`, [id]);
    if (r.status === 'APPROVED') {
      await t.query(`insert into staff_leave_ledger (user_id, leave_code, on_date, days, reason, request_id, entered_by) values ($1, $2, $3, $4, $5, $6, $7)`,
        [r.user_id, r.leave_code, localToday(), r.days, `${r.leave} withdrawn`, id, actor.id]);
      await t.query(`delete from staff_attendance where user_id = $1 and source = 'LEAVE' and on_date between $2 and $3`, [r.user_id, r.from, r.to]);
      await t.query(`update teacher_absence set withdrawn_at = now() where teacher_id = $1 and withdrawn_at is null and period && daterange($2::date, $3::date, '[]') and reason like 'On leave:%'`, [r.user_id, r.from, r.to]);
    }
    return { status: 'CANCELLED' };
  }, { actor: actor.label });
}

export async function requests(db: Db, actor: Actor, schoolId: string, status?: string) {
  await assertCan(db, actor, 'staff.view', schoolId);
  return db.query(
    `select r.id, r.user_id, u.name, u.designation, r.leave_code, t.name as leave, lower(r.period)::text as from, (upper(r.period) - 1)::text as to, r.days::float as days, r.half_day,
            r.reason, r.status, r.created_at, d.name as decided_by, r.note,
            (select coalesce(sum(l.days), 0)::float from staff_leave_ledger l where l.user_id = r.user_id and l.leave_code = r.leave_code) as balance
       from staff_leave_request r join app_user u on u.id = r.user_id join staff_leave_type t on t.code = r.leave_code left join app_user d on d.id = r.decided_by
      where r.school_id = $1 and ($2::text is null or r.status = $2) order by (r.status = 'PENDING') desc, lower(r.period) desc limit 300`, [schoolId, status ?? null]);
}

export async function mine(db: Db, actor: Actor) {
  const s = await staffMember(db, actor.id);
  return {
    balances: (await balances(db, actor.id)).filter((b) => !b.gender || !s.gender || b.gender === s.gender),
    requests: await db.query(
      `select r.id, t.name as leave, r.leave_code, lower(r.period)::text as from, (upper(r.period) - 1)::text as to, r.days::float as days, r.reason, r.status, r.note, d.name as decided_by
         from staff_leave_request r join staff_leave_type t on t.code = r.leave_code left join app_user d on d.id = r.decided_by where r.user_id = $1 order by lower(r.period) desc limit 100`, [actor.id]),
    ledger: await db.query(`select l.on_date::text, t.name as leave, l.days::float as days, l.reason from staff_leave_ledger l join staff_leave_type t on t.code = l.leave_code where l.user_id = $1 order by l.on_date desc, l.id desc limit 100`, [actor.id]),
  };
}

// ── Attendance ─────────────────────────────────────────────────────────────────────────────

/** The staff register for a day: everyone on the staff, with their mark (none yet means present by default when saved). */
export async function register(db: Db, actor: Actor, schoolId: string, date: string) {
  await assertCan(db, actor, 'staff.view', schoolId);
  const off = (await holidays(db, schoolId, date, date)).has(date) || new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
  const rows = await db.query(
    `select e.user_id, u.name, u.designation, e.employment, a.status, a.source
       from employee e join app_user u on u.id = e.user_id left join staff_attendance a on a.user_id = e.user_id and a.on_date = $2
      where e.school_id = $1 and e.joined_service <= $2 and (e.separated_on is null or e.separated_on >= $2) order by u.name`, [schoolId, date]);
  return { date, holiday: off, staff: rows };
}

/** Saves the day's register. Leave already sanctioned is kept as it is. */
export async function mark(db: Db, actor: Actor, schoolId: string, date: string, entries: { userId: string; status: 'P' | 'A' | 'H' | 'D' }[]) {
  await assertCan(db, actor, 'staff.manage', schoolId);
  if (date > localToday()) throw invalid('Attendance cannot be marked for a day that has not come.');
  const locked = await db.maybeOne(`select 1 from payroll_run where school_id = $1 and month = date_trunc('month', $2::date)::date and kind = 'REGULAR' and status in ('LOCKED', 'PAID')`, [schoolId, date]);
  if (locked) throw conflict('locked', 'That month’s payroll is locked; attendance for it can no longer change.');
  return db.tx(async (t) => {
    let saved = 0;
    for (const e of entries) {
      const ok = await t.maybeOne('select 1 from employee where user_id = $1 and school_id = $2', [e.userId, schoolId]);
      if (!ok) throw invalid('Someone in the list is not on this school’s staff.');
      const r = await t.query(`insert into staff_attendance (user_id, on_date, status, source, marked_by) values ($1, $2, $3, 'MANUAL', $4)
        on conflict (user_id, on_date) do update set status = excluded.status, marked_by = excluded.marked_by, marked_at = now() where staff_attendance.source <> 'LEAVE' returning 1`, [e.userId, date, e.status, actor.id]);
      saved += r.length;
    }
    return { saved };
  }, { actor: actor.label });
}

/** A person's month: days present, absent without leave (loss of pay), on leave, and unpaid leave. */
export async function monthFor(db: Db, userId: string, month: string) {
  const end = addDays(addDays(month, 32).slice(0, 8) + '01', -1);
  const r = await db.one<{ marked: number; absent: number; half: number; unpaid: number; half_pay: number }>(
    `select count(*)::int as marked,
            count(*) filter (where a.status = 'A')::int as absent,
            count(*) filter (where a.status = 'H' and a.source <> 'LEAVE')::int as half,
            coalesce((select sum(least(upper(r.period), $3::date + 1) - greatest(lower(r.period), $2::date)) from staff_leave_request r join staff_leave_type t on t.code = r.leave_code
               where r.user_id = $1 and r.status = 'APPROVED' and t.pay = 'NONE' and r.period && daterange($2::date, $3::date, '[]')), 0)::int as unpaid,
            coalesce((select sum(least(upper(r.period), $3::date + 1) - greatest(lower(r.period), $2::date)) from staff_leave_request r join staff_leave_type t on t.code = r.leave_code
               where r.user_id = $1 and r.status = 'APPROVED' and t.pay = 'HALF' and r.period && daterange($2::date, $3::date, '[]')), 0)::int as half_pay
       from staff_attendance a where a.user_id = $1 and a.on_date between $2 and $3`, [userId, month, end]);
  const present = (await db.one<{ n: number }>(`select count(*) filter (where status in ('P', 'D'))::int + 0.5 * count(*) filter (where status = 'H') as n from staff_attendance where user_id = $1 and on_date between $2 and $3`, [userId, month, end])).n;
  return { marked: r.marked, present: Number(present), lopDays: r.absent + r.half * 0.5 + r.unpaid + r.half_pay * 0.5, unpaidLeave: r.unpaid, halfPayLeave: r.half_pay };
}


