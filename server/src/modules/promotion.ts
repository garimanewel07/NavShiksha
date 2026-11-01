import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { assertGuardianOf } from './access.js';
import * as notify from './notify.js';

/**
 * Moving the whole school on to the next academic year. The principal prepares a promotion list:
 * each child's decision is worked out from the year's published results (no detention up to Class
 * VII; below 33% in VIII, IX and XI is held back; Class X goes on to XI unless the board result says
 * otherwise; Class XII completes school), and their section next year follows (same section letter,
 * or the Class XI stream allotted by merit and the family's choices). The principal changes any line,
 * then applies it: each child's class for the year is kept in their history, the enrolment moves on,
 * roll numbers are given afresh, leavers' enrolments end, and families are told.
 */

const STREAMS: Record<string, string> = { SCIENCE_PCM: 'Science (PCM)', SCIENCE_PCB: 'Science (PCB)', COMMERCE: 'Commerce', HUMANITIES: 'Humanities' };
const PASS = 33;

async function principal(db: Db, actor: Actor, schoolId: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
}

async function years(db: Db, toYear?: string) {
  const cur = await db.maybeOne<{ code: string; start: string; end: string }>(`select code, lower(period)::text as start, upper(period)::text as end from academic_year where period @> current_date`);
  if (!cur) throw invalid('No academic year covers today.');
  const next = toYear ?? `${Number(cur.code.slice(0, 4)) + 1}-${String((Number(cur.code.slice(0, 4)) + 2) % 100).padStart(2, '0')}`;
  const n = await db.maybeOne<{ code: string; start: string }>(`select code, lower(period)::text as start from academic_year where code = $1`, [next]);
  return { from: cur, to: n ? { code: n.code, start: n.start } : null, nextCode: next };
}

/** NES opens the next academic year (1 April to 31 March). */
export async function openYear(db: Db, actor: Actor, code: string) {
  requireRole(actor, 'NES_ADMIN');
  if (!/^\d{4}-\d{2}$/.test(code) || (Number(code.slice(0, 4)) + 1) % 100 !== Number(code.slice(5))) throw invalid('Give the year like 2027-28.');
  if (await db.maybeOne('select 1 from academic_year where code = $1', [code])) throw conflict('exists', 'This year is already open.');
  await db.tx((t) => t.query(`insert into academic_year (code, period) values ($1, daterange($2::date, $3::date))`, [code, `${code.slice(0, 4)}-04-01`, `${Number(code.slice(0, 4)) + 1}-04-01`]), { actor: actor.label });
  return { code };
}

// ── Class XI streams ──────────────────────────────────────────────────────────────────────

/** A Class X family (or the office) gives the streams they want for Class XI, in order. */
export async function chooseStreams(db: Db, actor: Actor, studentId: string, choices: string[]) {
  const e = await db.maybeOne<{ id: string; class_code: string; school_id: string }>(`select id, class_code, school_id from enrolment where student_id = $1 and upper_inf(period) and status = 'ACTIVE'`, [studentId]);
  if (!e) throw notFound('Student');
  if (actor.role === 'PARENT') await assertGuardianOf(db, actor, studentId);
  else await principal(db, actor, e.school_id);
  if (e.class_code !== 'X') throw invalid('Stream choices are for children in Class X.');
  if (!choices.length || choices.some((c) => !STREAMS[c]) || new Set(choices).size !== choices.length) throw invalid('Choose streams in order of preference.');
  const y = await years(db);
  await db.tx((t) => t.query(`insert into stream_choice (enrolment_id, for_year, choices, by_user) values ($1,$2,$3,$4) on conflict (enrolment_id, for_year) do update set choices = excluded.choices, by_user = excluded.by_user, at = now(), allotted = null`,
    [e.id, y.nextCode, choices, actor.id]), { actor: actor.label });
  return { choices };
}

export async function myStreamChoice(db: Db, actor: Actor, studentId: string) {
  await assertGuardianOf(db, actor, studentId);
  const y = await years(db);
  return { streams: STREAMS, forYear: y.nextCode, choice: await db.maybeOne(`select c.choices, c.allotted from stream_choice c join enrolment e on e.id = c.enrolment_id where e.student_id = $1 and c.for_year = $2`, [studentId, y.nextCode]) };
}

export async function setStream(db: Db, actor: Actor, sectionId: string, stream: string | null) {
  const s = await db.maybeOne<{ school_id: string; class_code: string }>(`select c.parent_id as school_id, s.class_code from section s join org_unit c on c.id = s.campus_id where s.id = $1`, [sectionId]);
  if (!s) throw notFound('Section');
  await principal(db, actor, s.school_id);
  if (!['XI', 'XII'].includes(s.class_code)) throw invalid('Streams are for Classes XI and XII.');
  if (stream && !STREAMS[stream]) throw invalid('Unknown stream.');
  await db.tx((t) => t.query('update section set stream = $2 where id = $1', [sectionId, stream]), { actor: actor.label });
  return { stream };
}

// ── The promotion list ────────────────────────────────────────────────────────────────────

/** Next year's sections, made like this year's (same campus, class, letter, seats and stream) where they do not exist yet. */
async function ensureSections(t: Db, schoolId: string, fromYear: string, toYear: string) {
  await t.query(
    `insert into section (campus_id, academic_year, class_code, name, capacity, stream)
     select s.campus_id, $3, s.class_code, s.name, s.capacity, s.stream from section s join org_unit c on c.id = s.campus_id
      where c.parent_id = $1 and s.academic_year = $2 and not exists (select 1 from section x where x.campus_id = s.campus_id and x.academic_year = $3 and x.class_code = s.class_code and x.name = s.name)`,
    [schoolId, fromYear, toYear]);
  // The class above, for children moving up into a class the campus did not have this year.
  await t.query(
    `insert into section (campus_id, academic_year, class_code, name, capacity)
     select s.campus_id, $3, nx.code, s.name, s.capacity from section s join org_unit c on c.id = s.campus_id join class_level cl on cl.code = s.class_code join class_level nx on nx.ordinal = cl.ordinal + 1
      where c.parent_id = $1 and s.academic_year = $2 and exists (select 1 from enrolment e where e.section_id = s.id and upper_inf(e.period))
        and not exists (select 1 from section x join org_unit xc on xc.id = x.campus_id where xc.parent_id = $1 and x.academic_year = $3 and x.class_code = nx.code)`,
    [schoolId, fromYear, toYear]);
}

/**
 * Prepares (or prepares again) the promotion list for a school, from this year to the next. Lines
 * the principal has changed by hand are kept when it is prepared again.
 */
export async function prepare(db: Db, actor: Actor, schoolId: string, toYearCode?: string) {
  await principal(db, actor, schoolId);
  const y = await years(db, toYearCode);
  if (!y.to) throw conflict('no_year', `NES has not opened ${y.nextCode} yet.`);
  const toYear = y.to.code;
  return db.tx(async (t) => {
    await ensureSections(t, schoolId, y.from.code, toYear);
    let run = await t.maybeOne<{ id: string; status: string }>('select id, status from promotion_run where school_id = $1 and from_year = $2', [schoolId, y.from.code]);
    if (run?.status === 'APPLIED') throw conflict('applied', 'This year’s promotion has already been applied.');
    if (!run) run = await t.one<{ id: string; status: string }>(`insert into promotion_run (school_id, from_year, to_year, created_by) values ($1,$2,$3,$4) returning id, status`, [schoolId, y.from.code, toYear, actor.id]);
    const kids = await t.query<{ id: string; class_code: string; section_id: string | null; section: string | null; campus_id: string; ordinal: number; pct: string | null; board: string | null; board_pct: string | null; choices: string[] | null }>(
      `select e.id, e.class_code, e.section_id, s.name as section, e.campus_id, cl.ordinal,
              (select r.percentage from result r join assessment a on a.id = r.assessment_id where r.enrolment_id = e.id and a.academic_year = $2 and a.status = 'PUBLISHED' order by (a.kind = 'ANNUAL') desc, a.published_at desc limit 1) as pct,
              (select b.result from board_result b where b.enrolment_id = e.id order by b.year desc limit 1) as board,
              (select b.percentage from board_result b where b.enrolment_id = e.id order by b.year desc limit 1) as board_pct,
              (select c.choices from stream_choice c where c.enrolment_id = e.id and c.for_year = $3) as choices
         from enrolment e join class_level cl on cl.code = e.class_code left join section s on s.id = e.section_id
        where e.school_id = $1 and e.academic_year = $2 and upper_inf(e.period) and e.status in ('ACTIVE', 'PROVISIONAL')`, [schoolId, y.from.code, toYear]);
    const nextClass = new Map((await t.query<{ ordinal: number; code: string }>('select ordinal, code from class_level')).map((c) => [c.ordinal, c.code]));
    const sections = await t.query<{ id: string; campus_id: string; class_code: string; name: string; capacity: number; stream: string | null }>(
      `select s.id, s.campus_id, s.class_code, s.name, s.capacity, s.stream from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1 and s.academic_year = $2 order by s.class_code, s.name`, [schoolId, toYear]);
    const kept = new Set((await t.query<{ enrolment_id: string }>(`select enrolment_id from promotion_line where run_id = $1 and reason like 'Changed by%'`, [run.id])).map((r) => r.enrolment_id));
    await t.query(`delete from promotion_line where run_id = $1 and not (reason like 'Changed by%')`, [run.id]);
    const sectionFor = (cls: string, letter: string | null, campus: string) =>
      sections.find((s) => s.class_code === cls && s.name === letter && s.campus_id === campus) ?? sections.find((s) => s.class_code === cls && s.name === letter) ?? sections.find((s) => s.class_code === cls) ?? null;
    // Class XI streams by merit: board percentage, else the year's result.
    const xi = sections.filter((s) => s.class_code === 'XI' && s.stream);
    const seatsLeft = new Map(xi.map((s) => [s.id, s.capacity]));
    const allot = new Map<string, string | null>();
    const toXi = kids.filter((k) => k.class_code === 'X' && !kept.has(k.id)).sort((a, b) => Number(b.board_pct ?? b.pct ?? 0) - Number(a.board_pct ?? a.pct ?? 0));
    if (xi.length) for (const k of toXi) {
      const wants = k.choices ?? [];
      const sec = wants.map((w) => xi.find((s) => s.stream === w && (seatsLeft.get(s.id) ?? 0) > 0)).find(Boolean) ?? null;
      if (sec) seatsLeft.set(sec.id, seatsLeft.get(sec.id)! - 1);
      allot.set(k.id, sec?.id ?? null);
    }
    let n = 0;
    for (const k of kids) {
      if (kept.has(k.id)) continue;
      const pct = k.pct === null ? null : Number(k.pct);
      let decision: string, toClass: string | null = null, toSection: string | null = null, reason = '';
      if (k.class_code === 'XII') { decision = 'COMPLETE'; reason = 'Class XII: completes school'; }
      else if (k.class_code === 'X' && k.board && !['PASS', 'COMP'].includes(k.board)) { decision = 'DETAIN'; reason = `Board result: ${k.board.toLowerCase()}`; }
      else if (['VIII', 'IX', 'XI'].includes(k.class_code) && pct !== null && pct < PASS) { decision = 'DETAIN'; reason = `${pct}% in the year’s result (below ${PASS}%)`; }
      else { decision = 'PROMOTE'; reason = pct === null ? 'No published result this year' : `${pct}% in the year’s result`; }
      if (decision === 'PROMOTE') {
        toClass = nextClass.get(k.ordinal + 1) ?? null;
        if (!toClass) { decision = 'COMPLETE'; reason = 'Last class of the school'; }
        else if (toClass === 'XI' && xi.length) {
          toSection = allot.get(k.id) ?? null;
          const sec = toSection ? xi.find((s) => s.id === toSection) : null;
          reason += sec ? ` · ${STREAMS[sec.stream!]} (merit and choice)` : k.choices?.length ? ' · no seat in the chosen streams: choose a section' : ' · no stream chosen: choose a section';
        } else toSection = sectionFor(toClass, k.section, k.campus_id)?.id ?? null;
      } else if (decision === 'DETAIN') { toClass = k.class_code; toSection = sectionFor(k.class_code, k.section, k.campus_id)?.id ?? null; }
      await t.query(`insert into promotion_line (run_id, enrolment_id, from_class, from_section, percentage, decision, to_class, to_section, reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.id, k.id, k.class_code, k.section_id, pct, decision, toClass, toSection, reason]);
      n++;
    }
    return { runId: run.id, fromYear: y.from.code, toYear, lines: n + kept.size };
  }, { actor: actor.label });
}

export async function view(db: Db, actor: Actor, schoolId: string) {
  await principal(db, actor, schoolId);
  const y = await years(db);
  const run = await db.maybeOne<{ id: string; status: string; from_year: string; to_year: string; applied_at: string | null }>('select id, status, from_year, to_year, applied_at from promotion_run where school_id = $1 and from_year = $2', [schoolId, y.from.code]);
  if (!run) return { run: null, nextYearOpen: !!y.to, nextYear: y.nextCode, lines: [], sections: [] };
  const lines = await db.query(
    `select l.enrolment_id, st.name, e.admission_no, l.from_class, fs.name as from_section, l.percentage::float, l.decision, l.to_class, l.to_section, ts.name as to_section_name, ts.stream, l.reason,
            (select c.choices from stream_choice c where c.enrolment_id = l.enrolment_id and c.for_year = $2) as choices
       from promotion_line l join enrolment e on e.id = l.enrolment_id join student st on st.id = e.student_id join class_level cl on cl.code = l.from_class
       left join section fs on fs.id = l.from_section left join section ts on ts.id = l.to_section where l.run_id = $1 order by cl.ordinal, fs.name, st.name`, [run.id, run.to_year]);
  const sections = await db.query(`select s.id, s.class_code, s.name, s.stream, s.capacity, (select count(*) from promotion_line l where l.run_id = $3 and l.to_section = s.id)::int as allotted
                                     from section s join org_unit c on c.id = s.campus_id join class_level cl on cl.code = s.class_code where c.parent_id = $1 and s.academic_year = $2 order by cl.ordinal, s.name`, [schoolId, run.to_year, run.id]);
  return { run, lines, sections, streams: STREAMS };
}

export async function setLine(db: Db, actor: Actor, runId: string, enrolmentId: string, input: { decision: 'PROMOTE' | 'DETAIN' | 'COMPLETE' | 'LEAVE'; toSection?: string | null; reason?: string }) {
  const run = await db.maybeOne<{ school_id: string; status: string; to_year: string }>('select school_id, status, to_year from promotion_run where id = $1', [runId]);
  if (!run) throw notFound('Promotion list');
  await principal(db, actor, run.school_id);
  if (run.status !== 'DRAFT') throw conflict('applied', 'Already applied.');
  const line = await db.maybeOne<{ from_class: string }>('select from_class from promotion_line where run_id = $1 and enrolment_id = $2', [runId, enrolmentId]);
  if (!line) throw notFound('Child on the list');
  let toClass: string | null = null;
  if (['PROMOTE', 'DETAIN'].includes(input.decision)) {
    if (!input.toSection) throw invalid('Choose the section for next year.');
    const s = await db.maybeOne<{ class_code: string; academic_year: string; school_id: string }>(`select s.class_code, s.academic_year, c.parent_id as school_id from section s join org_unit c on c.id = s.campus_id where s.id = $1`, [input.toSection]);
    if (!s || s.academic_year !== run.to_year || s.school_id !== run.school_id) throw invalid('Choose one of next year’s sections.');
    toClass = s.class_code;
    const want = input.decision === 'DETAIN' ? line.from_class : (await db.one<{ code: string }>(`select c2.code from class_level c1 join class_level c2 on c2.ordinal = c1.ordinal + 1 where c1.code = $1`, [line.from_class])).code;
    if (toClass !== want) throw invalid(`${input.decision === 'DETAIN' ? 'Held back' : 'Promoted'} children go to Class ${want}.`);
  }
  if (input.decision !== 'PROMOTE' && !input.reason?.trim()) throw invalid('Give the reason.');
  await db.tx((t) => t.query(`update promotion_line set decision = $3, to_class = $4, to_section = $5, reason = $6 where run_id = $1 and enrolment_id = $2`,
    [runId, enrolmentId, input.decision, toClass, input.toSection ?? null, `Changed by ${actor.name}${input.reason?.trim() ? `: ${input.reason.trim()}` : ''}`]), { actor: actor.label });
  return { ok: true };
}

/**
 * Applies the list: history kept, enrolments moved to next year (or ended for those completing or
 * leaving), roll numbers given in each new section by name, and every family told. Allowed from 45
 * days before the new year starts.
 */
export async function apply(db: Db, actor: Actor, runId: string, today = localToday()) {
  const run = await db.maybeOne<{ school_id: string; status: string; from_year: string; to_year: string }>('select school_id, status, from_year, to_year from promotion_run where id = $1', [runId]);
  if (!run) throw notFound('Promotion list');
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal applies the promotion list.');
  await principal(db, actor, run.school_id);
  if (run.status !== 'DRAFT') throw conflict('applied', 'Already applied.');
  const start = (await db.one<{ s: string }>('select lower(period)::text as s from academic_year where code = $1', [run.to_year])).s;
  const from = new Date(Date.parse(`${start}T00:00:00Z`) - 45 * 864e5).toISOString().slice(0, 10);
  if (today < from) throw conflict('early', `The promotion list can be applied from ${from}.`);
  const missing = await db.one<{ n: number }>(`select count(*)::int as n from promotion_line where run_id = $1 and decision in ('PROMOTE', 'DETAIN') and to_section is null`, [runId]);
  if (missing.n) throw invalid(`${missing.n} children have no section for next year.`);
  return db.tx(async (t) => {
    const lines = await t.query<{ enrolment_id: string; student_id: string; name: string; decision: string; from_class: string; from_section: string | null; percentage: string | null; to_class: string | null; to_section: string | null; to_campus: string | null; to_label: string | null; roll_no: number | null }>(
      `select l.enrolment_id, e.student_id, st.name, l.decision, l.from_class, l.from_section, l.percentage, l.to_class, l.to_section, ts.campus_id as to_campus, ts.class_code || '-' || ts.name as to_label, e.roll_no
         from promotion_line l join enrolment e on e.id = l.enrolment_id join student st on st.id = e.student_id left join section ts on ts.id = l.to_section where l.run_id = $1`, [runId]);
    const outcome: Record<string, string> = { PROMOTE: 'PROMOTED', DETAIN: 'DETAINED', COMPLETE: 'COMPLETED', LEAVE: 'LEFT' };
    for (const l of lines) {
      await t.query(`insert into class_history (enrolment_id, academic_year, class_code, section_id, roll_no, outcome, percentage, decided_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [l.enrolment_id, run.from_year, l.from_class, l.from_section, l.roll_no, outcome[l.decision], l.percentage, actor.id]);
      if (l.decision === 'PROMOTE' || l.decision === 'DETAIN') {
        await t.query(`update enrolment set roll_no = null where id = $1`, [l.enrolment_id]);
        await t.query(`update enrolment set academic_year = $2, class_code = $3, section_id = $4, campus_id = $5 where id = $1`, [l.enrolment_id, run.to_year, l.to_class, l.to_section, l.to_campus]);
      } else {
        await t.query(`update enrolment set status = $2, period = daterange(lower(period), $3::date) where id = $1`, [l.enrolment_id, l.decision === 'COMPLETE' ? 'COMPLETED' : 'WITHDRAWN', start]);
      }
    }
    // Roll numbers in each of next year's sections, by name.
    await t.query(`with r as (select e.id, row_number() over (partition by e.section_id order by st.name) as n from enrolment e join student st on st.id = e.student_id
                              join section s on s.id = e.section_id join org_unit c on c.id = s.campus_id where c.parent_id = $1 and s.academic_year = $2 and upper_inf(e.period))
                   update enrolment e set roll_no = r.n from r where r.id = e.id`, [run.school_id, run.to_year]);
    await t.query(`update stream_choice c set allotted = s.stream from promotion_line l join section s on s.id = l.to_section where l.run_id = $1 and c.enrolment_id = l.enrolment_id and c.for_year = $2`, [runId, run.to_year]);
    await t.query(`update promotion_run set status = 'APPLIED', applied_by = $2, applied_at = now() where id = $1`, [runId, actor.id]);
    for (const l of lines) {
      const first = l.name.split(' ')[0];
      const body = l.decision === 'PROMOTE' ? `${first} moves to Class ${l.to_label} for ${run.to_year}.` : l.decision === 'DETAIN' ? `${first} stays in Class ${l.to_class} (${l.to_label}) for ${run.to_year}. The class teacher will talk to you.`
        : l.decision === 'COMPLETE' ? `${first} has completed school. Congratulations! Do register as an alumnus.` : `${first}’s enrolment ends this year.`;
      await notify.toParentsOf(t, [l.student_id], { kind: 'RESULT', title: `Next year: ${first}`, body, link: '/results' });
    }
    return { applied: lines.length, promoted: lines.filter((l) => l.decision === 'PROMOTE').length, detained: lines.filter((l) => l.decision === 'DETAIN').length, completed: lines.filter((l) => l.decision === 'COMPLETE').length };
  }, { actor: actor.label });
}

/** A child's class year by year (for the student record and certificates). */
export async function history(db: Db, enrolmentId: string) {
  return db.query(`select h.academic_year, h.class_code, s.name as section, h.outcome, h.percentage::float from class_history h left join section s on s.id = h.section_id where h.enrolment_id = $1 order by h.academic_year`, [enrolmentId]);
}
