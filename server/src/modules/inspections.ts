import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import { reportPdf } from '../lib/reportPdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import * as notify from './notify.js';

/**
 * School inspections with checklists. NES (or a Command) keeps the checklists and plans visits to
 * schools in its part of the tree: annual, thematic (safety, academics…) or surprise, which the
 * school does not see until the inspectors start. The team rates each item and records findings;
 * the lead submits the report with its score. The principal responds to each finding by its due
 * date; the inspector accepts the response (closing it) or sends it back. A principal can also
 * assess their own school against any checklist (a self-assessment), which nobody else marks.
 */

export type ChecklistItem = { id: string; text: string; weight: number };
export type Section = { title: string; items: ChecklistItem[] };
const UUID = /^[0-9a-f-]{36}$/i;
const today = () => localToday();
const INSPECTORS = ['NES_ADMIN', 'COMMAND_OFFICER'];

/** Gives every item an id ("2.3") and a weight, and checks the shape. */
function normalise(sections: { title: string; items: { text: string; weight?: number }[] }[]): Section[] {
  if (!sections.length) throw invalid('Add at least one section.');
  return sections.map((s, i) => {
    if (!s.title?.trim()) throw invalid(`Section ${i + 1} needs a title.`);
    if (!s.items?.length) throw invalid(`“${s.title}” needs at least one item.`);
    return { title: s.title.trim(), items: s.items.map((it, j) => {
      if (!it.text?.trim()) throw invalid(`Item ${j + 1} of “${s.title}” is empty.`);
      const w = it.weight ?? 1;
      if (!(w >= 1 && w <= 5)) throw invalid('Weights run from 1 to 5.');
      return { id: `${i + 1}.${j + 1}`, text: it.text.trim(), weight: w };
    }) };
  });
}

// ── Checklists ───────────────────────────────────────────────────────────────────────────────

/** Checklists the person can use: those kept at their level or above (a school uses NES's and its Command's). */
export async function templates(db: Db, actor: Actor) {
  if (!actor.scopePath || !['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(actor.role)) throw forbidden();
  return db.query(
    `select t.id, t.unit_id, t.name, t.purpose, t.scale, t.sections, t.active, o.name as unit, t.version,
            ($2 and o.path <@ $1::ltree) as editable,
            (select count(*)::int from inspection i where i.template_id = t.id) as used
       from inspection_template t join org_unit o on o.id = t.unit_id
      where $1::ltree <@ o.path or o.path <@ $1::ltree order by t.active desc, t.name`, [actor.scopePath, INSPECTORS.includes(actor.role)]);
}

export async function saveTemplate(db: Db, actor: Actor, input: { id?: string; unitId: string; name: string; purpose?: string; scale: 3 | 4 | 5; sections: { title: string; items: { text: string; weight?: number }[] }[]; active?: boolean }) {
  if (!INSPECTORS.includes(actor.role)) throw forbidden('Checklists are kept by NES and the Commands.');
  await assertUnitInScope(db, actor, input.unitId);
  const sections = normalise(input.sections);
  return db.tx(async (t) => {
    if (input.id) {
      const cur = await t.maybeOne<{ unit_id: string }>('select unit_id from inspection_template where id = $1', [input.id]);
      if (!cur) throw notFound('Checklist');
      await assertUnitInScope(t, actor, cur.unit_id);
      // Inspections keep their own copy, so editing never changes a report already made.
      await t.query('update inspection_template set name = $2, purpose = $3, scale = $4, sections = $5, active = coalesce($6, active) where id = $1',
        [input.id, input.name.trim(), input.purpose?.trim() ?? '', input.scale, JSON.stringify(sections), input.active ?? null]);
      return { id: input.id };
    }
    return t.one<{ id: string }>('insert into inspection_template (unit_id, name, purpose, scale, sections, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
      [input.unitId, input.name.trim(), input.purpose?.trim() ?? '', input.scale, JSON.stringify(sections), actor.id]);
  }, { actor: actor.label });
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────

export async function plan(db: Db, actor: Actor, input: { schoolId: string; templateId: string; kind: 'ANNUAL' | 'SURPRISE' | 'THEMATIC' | 'SELF'; title?: string; scheduledOn: string; leadId?: string; teamIds?: string[] }) {
  await assertUnitInScope(db, actor, input.schoolId);
  const school = await db.maybeOne<{ name: string; path: string }>(`select name, path::text from org_unit where id = $1 and kind = 'school'`, [input.schoolId]);
  if (!school) throw invalid('Inspections are of schools.');
  if (input.kind === 'SELF') { if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('A self-assessment is the school’s own.'); }
  else if (!INSPECTORS.includes(actor.role)) throw forbidden('Inspections are planned by NES and the Commands.');
  if (input.scheduledOn < today() && input.kind !== 'SELF') throw invalid('Choose today or a later date.');
  const tpl = await db.maybeOne<{ name: string; scale: number; sections: Section[]; active: boolean }>(
    `select t.name, t.scale, t.sections, t.active from inspection_template t join org_unit o on o.id = t.unit_id where t.id = $1 and $2::ltree <@ o.path`, [input.templateId, school.path]);
  if (!tpl || !tpl.active) throw invalid('Choose a checklist that applies to this school.');
  const lead = input.kind === 'SELF' ? actor.id : input.leadId ?? actor.id;
  const team = [...new Set([lead, ...(input.teamIds ?? [])])];
  for (const uid of team) {
    const ok = await db.maybeOne(`select 1 from app_user where id = $1 and active and role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF')`, [uid]);
    if (!ok) throw invalid('Inspectors are NES, Command or school staff.');
  }
  const title = input.title?.trim() || `${input.kind === 'SELF' ? 'Self-assessment' : 'Inspection'}: ${tpl.name}`;
  return db.tx(async (t) => {
    const i = await t.one<{ id: string }>(
      `insert into inspection (school_id, template_id, checklist, kind, title, scheduled_on, lead_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.schoolId, input.templateId, JSON.stringify({ scale: tpl.scale, sections: tpl.sections }), input.kind, title, input.scheduledOn, lead, actor.id]);
    for (const uid of team) await t.query('insert into inspection_team (inspection_id, user_id) values ($1, $2)', [i.id, uid]);
    await notify.toUsers(t, team.filter((u) => u !== actor.id), { kind: 'INSPECTION', title: `${title}, ${school.name}`, body: `On ${notify.fmt(input.scheduledOn)}.`, link: `/inspections/${i.id}` });
    // The school is told in advance, except for a surprise visit.
    if (!['SURPRISE', 'SELF'].includes(input.kind)) await notify.toUsers(t, await heads(t, input.schoolId), { kind: 'INSPECTION', title: `${title} on ${notify.fmt(input.scheduledOn)}`, body: 'The checklist is in NavShiksha so the school can prepare.', link: `/inspections/${i.id}` });
    return { id: i.id };
  }, { actor: actor.label });
}

const heads = async (db: Db, schoolId: string) => (await db.query<{ id: string }>(
  `select u.id from app_user u join org_unit o on o.id = $1 where u.role = 'SCHOOL_ADMIN' and u.active and u.scope_path = o.path`, [schoolId])).map((h) => h.id);

type Row = { id: string; school_id: string; school: string; school_path: string; template_id: string; checklist: { scale: number; sections: Section[] }; kind: string; title: string; scheduled_on: string; status: string;
  lead_id: string; lead: string; summary: string; score: number | null; started_at: string | null; reported_at: string | null; closed_at: string | null; created_by: string; version: number };

async function load(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Inspection');
  const i = await db.maybeOne<Row>(
    `select i.*, i.scheduled_on::text, o.name as school, o.path::text as school_path, u.name as lead, i.score::float as score
       from inspection i join org_unit o on o.id = i.school_id join app_user u on u.id = i.lead_id where i.id = $1`, [id]);
  if (!i) throw notFound('Inspection');
  return i;
}

/** What the person may do with an inspection; throws when they may not see it. */
async function rights(db: Db, actor: Actor, i: Row) {
  const team = !!(await db.maybeOne('select 1 from inspection_team where inspection_id = $1 and user_id = $2', [i.id, actor.id]));
  const inScope = !!actor.scopePath && !!(await db.maybeOne('select 1 where $1::ltree <@ $2::ltree', [i.school_path, actor.scopePath]));
  const overseer = INSPECTORS.includes(actor.role) && inScope;
  const head = actor.role === 'SCHOOL_ADMIN' && inScope;
  // A surprise visit is hidden from the school until it starts.
  const headSees = head && (i.kind !== 'SURPRISE' || i.status !== 'PLANNED');
  if (!team && !overseer && !headSees) throw forbidden('This inspection is for the inspectors and the school.');
  const open = ['PLANNED', 'IN_PROGRESS'].includes(i.status);
  return {
    team, overseer, head,
    rate: team && open,
    report: i.lead_id === actor.id && open,
    respond: head && i.kind !== 'SELF' && i.status === 'REPORTED',
    close: (i.lead_id === actor.id || overseer) && i.status === 'REPORTED',
    cancel: (i.created_by === actor.id || overseer) && i.status === 'PLANNED',
  };
}

export async function list(db: Db, actor: Actor, f: { schoolId?: string; status?: string } = {}) {
  if (!actor.scopePath) throw forbidden();
  return db.query(
    `select i.id, i.title, i.kind, i.scheduled_on::text, i.status, i.score::float, o.name as school, u.name as lead, i.reported_at,
            (select count(*)::int from inspection_finding f where f.inspection_id = i.id and f.status <> 'CLOSED') as open_findings,
            (select count(*)::int from inspection_finding f where f.inspection_id = i.id and f.status = 'OPEN' and f.due_on < current_date) as overdue_findings
       from inspection i join org_unit o on o.id = i.school_id join app_user u on u.id = i.lead_id
      where (exists (select 1 from inspection_team x where x.inspection_id = i.id and x.user_id = $1)
             or ($3 and o.path <@ $2::ltree)
             or ($4 and o.path <@ $2::ltree and (i.kind <> 'SURPRISE' or i.status <> 'PLANNED')))
        and ($5::uuid is null or i.school_id = $5) and ($6::text is null or i.status = $6) and i.status <> 'CANCELLED'
      order by (i.status in ('PLANNED', 'IN_PROGRESS', 'REPORTED')) desc, i.scheduled_on desc limit 300`,
    [actor.id, actor.scopePath, INSPECTORS.includes(actor.role), actor.role === 'SCHOOL_ADMIN', f.schoolId ?? null, f.status ?? null]);
}

export async function inspection(db: Db, actor: Actor, id: string) {
  const i = await load(db, id);
  const r = await rights(db, actor, i);
  const ratings = await db.query(`select item_id, rating, not_applicable, remark from inspection_rating where inspection_id = $1`, [id]);
  const findings = await db.query(
    `select f.id, f.item_id, f.severity, f.body, f.due_on::text, f.status, f.response, f.responded_at, ur.name as responded_by, f.closed_at, uc.name as closed_by,
            (f.status = 'OPEN' and f.due_on < current_date) as overdue
       from inspection_finding f left join app_user ur on ur.id = f.responded_by left join app_user uc on uc.id = f.closed_by
      where f.inspection_id = $1 order by array_position(array['CRITICAL', 'MAJOR', 'MINOR', 'ADVISORY'], f.severity), f.created_at`, [id]);
  const team = await db.query(`select u.id, u.name, u.designation from inspection_team x join app_user u on u.id = x.user_id where x.inspection_id = $1 order by u.name`, [id]);
  const previous = await db.query(`select id, title, scheduled_on::text, score::float from inspection where school_id = $1 and id <> $2 and status in ('REPORTED', 'CLOSED') and template_id = $3 order by scheduled_on desc limit 5`, [i.school_id, id, i.template_id]);
  return { ...i, school_path: undefined, ratings, findings, team, previous, progress: progress(i.checklist, ratings as any), rights: r };
}

/** The score: each rated item's rating as a share of the scale, weighted; items marked not applicable are left out. */
function progress(cl: Row['checklist'], ratings: { item_id: string; rating: number | null; not_applicable: boolean }[]) {
  const items = cl.sections.flatMap((s) => s.items);
  const by = new Map(ratings.map((r) => [r.item_id, r]));
  let sum = 0, weight = 0, done = 0;
  const sections = cl.sections.map((s) => {
    let ss = 0, sw = 0;
    for (const it of s.items) {
      const r = by.get(it.id);
      if (r?.not_applicable) { done++; continue; }
      if (r?.rating) { done++; const v = (r.rating - 1) / (cl.scale - 1); ss += v * it.weight; sw += it.weight; }
    }
    sum += ss; weight += sw;
    return { title: s.title, score: sw ? Math.round((ss / sw) * 1000) / 10 : null };
  });
  return { items: items.length, done, score: weight ? Math.round((sum / weight) * 1000) / 10 : null, sections };
}

export async function start(db: Db, actor: Actor, id: string) {
  const i = await load(db, id);
  const r = await rights(db, actor, i);
  if (!r.rate) throw forbidden('The inspection team starts the inspection.');
  if (i.status !== 'PLANNED') return inspection(db, actor, id);
  await db.tx(async (t) => {
    await t.query(`update inspection set status = 'IN_PROGRESS', started_at = now() where id = $1`, [id]);
    if (i.kind === 'SURPRISE') await notify.toUsers(t, await heads(t, i.school_id), { kind: 'INSPECTION', title: `${i.title} has started`, body: `Led by ${i.lead}.`, link: `/inspections/${id}` });
  }, { actor: actor.label });
  return inspection(db, actor, id);
}

export async function rate(db: Db, actor: Actor, id: string, entries: { itemId: string; rating?: number | null; notApplicable?: boolean; remark?: string }[]) {
  const i = await load(db, id);
  const r = await rights(db, actor, i);
  if (!r.rate) throw forbidden('The inspection team rates the checklist while the inspection is open.');
  const ids = new Set(i.checklist.sections.flatMap((s) => s.items.map((it) => it.id)));
  await db.tx(async (t) => {
    if (i.status === 'PLANNED') await t.query(`update inspection set status = 'IN_PROGRESS', started_at = now() where id = $1`, [id]);
    for (const e of entries) {
      if (!ids.has(e.itemId)) throw invalid('That item is not on this checklist.');
      const rating = e.notApplicable ? null : e.rating ?? null;
      if (rating !== null && !(rating >= 1 && rating <= i.checklist.scale)) throw invalid(`Ratings run from 1 to ${i.checklist.scale}.`);
      await t.query(
        `insert into inspection_rating (inspection_id, item_id, rating, not_applicable, remark, rated_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (inspection_id, item_id) do update set rating = excluded.rating, not_applicable = excluded.not_applicable, remark = excluded.remark, rated_by = excluded.rated_by, rated_at = now()`,
        [id, e.itemId, rating, !!e.notApplicable, e.remark?.trim() ?? '', actor.id]);
    }
  }, { actor: actor.label });
  return inspection(db, actor, id);
}

export async function addFinding(db: Db, actor: Actor, id: string, input: { itemId?: string | null; severity: 'ADVISORY' | 'MINOR' | 'MAJOR' | 'CRITICAL'; body: string; dueOn?: string | null }) {
  const i = await load(db, id);
  const r = await rights(db, actor, i);
  if (!r.rate) throw forbidden('Findings are recorded by the team while the inspection is open.');
  if (input.itemId && !i.checklist.sections.some((s) => s.items.some((it) => it.id === input.itemId))) throw invalid('That item is not on this checklist.');
  if (input.severity !== 'ADVISORY' && i.kind !== 'SELF' && !input.dueOn) throw invalid('Give the school a date to put it right.');
  if (input.dueOn && input.dueOn < today()) throw invalid('The due date is in the past.');
  await db.tx((t) => t.query('insert into inspection_finding (inspection_id, item_id, severity, body, due_on, created_by) values ($1, $2, $3, $4, $5, $6)',
    [id, input.itemId ?? null, input.severity, input.body.trim(), input.dueOn ?? null, actor.id]), { actor: actor.label });
  return inspection(db, actor, id);
}

export async function removeFinding(db: Db, actor: Actor, findingId: string) {
  const f = await db.maybeOne<{ inspection_id: string }>('select inspection_id from inspection_finding where id = $1', [findingId]);
  if (!f) throw notFound('Finding');
  const i = await load(db, f.inspection_id);
  if (!(await rights(db, actor, i)).rate) throw forbidden();
  await db.tx(async (t) => {
    await t.query(`update inspection_finding set status = 'CLOSED', closed_at = now(), closed_by = $2, response = coalesce(response, 'Withdrawn by the inspector before the report.') where id = $1`, [findingId, actor.id]);
  }, { actor: actor.label });
  return inspection(db, actor, f.inspection_id);
}

/** The lead submits the report: every item rated (or marked not applicable), a summary, the score. */
export async function report(db: Db, actor: Actor, id: string, summary: string) {
  const i = await inspection(db, actor, id);
  if (!i.rights.report) throw forbidden('The lead inspector submits the report.');
  if (i.progress.done < i.progress.items) throw invalid(`${i.progress.items - i.progress.done} item(s) are not rated yet. Rate them or mark them not applicable.`);
  if (summary.trim().length < 20) throw invalid('Write a short summary for the school and NES.');
  // Advice needs no answer from the school; only findings with something to put right stay open.
  const findings = (i.findings as any[]).filter((f) => f.status === 'OPEN' && f.severity !== 'ADVISORY').length;
  await db.tx(async (t) => {
    await t.query(`update inspection_finding set status = 'CLOSED', closed_at = now(), closed_by = $2, response = coalesce(response, 'Advice: no response needed.')
                    where inspection_id = $1 and severity = 'ADVISORY' and status = 'OPEN'`, [id, actor.id]);
    await t.query(`update inspection set status = $2, summary = $3, score = $4, reported_at = now(), closed_at = case when $2 = 'CLOSED' then now() end where id = $1`,
      [id, findings && i.kind !== 'SELF' ? 'REPORTED' : 'CLOSED', summary.trim(), i.progress.score ?? 0]);
    if (i.kind !== 'SELF') await notify.toUsers(t, await heads(t, i.school_id), { kind: 'INSPECTION', title: `Report: ${i.title}`, body: `Score ${i.progress.score ?? 0}%. ${findings} finding(s) to respond to.`, link: `/inspections/${id}` });
  }, { actor: actor.label });
  return inspection(db, actor, id);
}

/** The principal says what the school has done about a finding. */
export async function respond(db: Db, actor: Actor, findingId: string, response: string) {
  const f = await db.maybeOne<{ inspection_id: string; status: string }>('select inspection_id, status from inspection_finding where id = $1', [findingId]);
  if (!f) throw notFound('Finding');
  const i = await load(db, f.inspection_id);
  if (!(await rights(db, actor, i)).respond) throw forbidden('The principal responds to the findings once the report is out.');
  if (f.status !== 'OPEN') throw invalid('This finding has already been answered.');
  if (response.trim().length < 10) throw invalid('Say what the school has done, in a sentence or two.');
  await db.tx(async (t) => {
    await t.query(`update inspection_finding set status = 'RESPONDED', response = $2, responded_by = $3, responded_at = now() where id = $1`, [findingId, response.trim(), actor.id]);
    await notify.toUsers(t, [i.lead_id], { kind: 'INSPECTION', title: `${i.school} responded to a finding`, body: response.trim().slice(0, 140), link: `/inspections/${i.id}` });
  }, { actor: actor.label });
  return inspection(db, actor, i.id);
}

/** The inspector accepts the response (closing the finding) or sends it back with a note. When every finding is closed, so is the inspection. */
export async function decideFinding(db: Db, actor: Actor, findingId: string, input: { accept: boolean; note?: string }) {
  const f = await db.maybeOne<{ inspection_id: string; status: string; response: string | null }>('select inspection_id, status, response from inspection_finding where id = $1', [findingId]);
  if (!f) throw notFound('Finding');
  const i = await load(db, f.inspection_id);
  if (!(await rights(db, actor, i)).close) throw forbidden('The inspector accepts the school’s responses.');
  if (f.status === 'CLOSED') throw invalid('This finding is closed.');
  if (!input.accept && !(input.note?.trim())) throw invalid('Say what is still needed; the principal is told.');
  await db.tx(async (t) => {
    if (input.accept) await t.query(`update inspection_finding set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`, [findingId, actor.id]);
    else {
      await t.query(`update inspection_finding set status = 'OPEN', response = $2 where id = $1`, [findingId, `${f.response ?? ''}\n\nSent back: ${input.note!.trim()}`.trim()]);
      await notify.toUsers(t, await heads(t, i.school_id), { kind: 'INSPECTION', title: 'A finding needs more work', body: input.note!.trim().slice(0, 140), link: `/inspections/${i.id}` });
    }
    const open = (await t.one<{ n: number }>(`select count(*)::int as n from inspection_finding where inspection_id = $1 and status <> 'CLOSED'`, [i.id])).n;
    if (!open) await t.query(`update inspection set status = 'CLOSED', closed_at = now() where id = $1 and status = 'REPORTED'`, [i.id]);
  }, { actor: actor.label });
  return inspection(db, actor, i.id);
}

export async function cancel(db: Db, actor: Actor, id: string, reason: string) {
  const i = await load(db, id);
  if (!(await rights(db, actor, i)).cancel) throw forbidden('Only a planned inspection can be called off, by whoever planned it or NES.');
  if (reason.trim().length < 3) throw invalid('Say why.');
  await db.tx(async (t) => {
    await t.query(`update inspection set status = 'CANCELLED', summary = $2 where id = $1`, [id, `Called off: ${reason.trim()}`]);
    const team = (await t.query<{ user_id: string }>('select user_id from inspection_team where inspection_id = $1', [id])).map((x) => x.user_id);
    const told = i.kind === 'SURPRISE' ? team : [...team, ...(await heads(t, i.school_id))];
    await notify.toUsers(t, told.filter((u) => u !== actor.id), { kind: 'INSPECTION', title: `${i.title} is called off`, body: reason.trim(), link: '/inspections' });
  }, { actor: actor.label });
  return { ok: true };
}

export async function reportPdfFor(db: Db, actor: Actor, id: string) {
  const i: any = await inspection(db, actor, id);
  const by = new Map((i.ratings as any[]).map((r) => [r.item_id, r]));
  return reportPdf(`${i.status === 'PLANNED' || i.status === 'IN_PROGRESS' ? 'DRAFT · ' : ''}${i.title}`, `${i.school} · ${i.scheduled_on} · led by ${i.lead}`, (r) => {
    r.pairs([['School', i.school], ['Kind', i.kind.toLowerCase().replace('_', ' ')], ['Score', i.score !== null ? `${i.score}%` : i.progress.score !== null ? `${i.progress.score}% (so far)` : '—'], ['Team', i.team.map((x: any) => x.name).join(', ')]]);
    if (i.summary) { r.heading('Summary'); r.para(i.summary); }
    for (const s of i.checklist.sections) {
      r.heading(`${s.title}${i.progress.sections.find((x: any) => x.title === s.title)?.score != null ? ` · ${i.progress.sections.find((x: any) => x.title === s.title).score}%` : ''}`);
      r.table([{ label: 'Item', width: 8 }, { label: 'What is checked', width: 52 }, { label: 'Rating', width: 12, align: 'right' }, { label: 'Remark', width: 40 }],
        s.items.map((it: ChecklistItem) => { const x: any = by.get(it.id); return [it.id, it.text, x?.not_applicable ? 'N/A' : x?.rating ? `${x.rating} of ${i.checklist.scale}` : '—', x?.remark ?? '']; }));
    }
    if (i.findings.length) {
      r.heading('Findings');
      r.table([{ label: 'Severity', width: 14 }, { label: 'Finding', width: 50 }, { label: 'Due', width: 14 }, { label: 'School’s response', width: 40 }],
        i.findings.map((f: any) => [f.severity.toLowerCase(), `${f.item_id ? `${f.item_id} · ` : ''}${f.body}`, f.due_on ?? '', `${f.response ?? ''}${f.status === 'CLOSED' ? ' (closed)' : ''}`]));
    }
    r.signatures(['Lead inspector', 'Principal']);
  });
}

/** Latest score per school, and open findings, for the insights page. */
export async function latestBySchool(db: Db, scopePath: string) {
  return db.query<{ school_id: string; score: number | null; on: string | null; open_findings: number; overdue_findings: number }>(
    `select o.id as school_id,
            (select i.score::float from inspection i where i.school_id = o.id and i.kind <> 'SELF' and i.status in ('REPORTED', 'CLOSED') order by i.scheduled_on desc limit 1) as score,
            (select i.scheduled_on::text from inspection i where i.school_id = o.id and i.kind <> 'SELF' and i.status in ('REPORTED', 'CLOSED') order by i.scheduled_on desc limit 1) as on,
            (select count(*)::int from inspection_finding f join inspection i on i.id = f.inspection_id where i.school_id = o.id and i.kind <> 'SELF' and f.status <> 'CLOSED') as open_findings,
            (select count(*)::int from inspection_finding f join inspection i on i.id = f.inspection_id where i.school_id = o.id and i.kind <> 'SELF' and f.status = 'OPEN' and f.due_on < current_date) as overdue_findings
       from org_unit o where o.kind = 'school' and o.path <@ $1::ltree`, [scopePath]);
}
