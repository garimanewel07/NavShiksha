import type { Db } from '../db/client.js';
import { invalid } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope, requireRole } from './auth.js';
import { sectionInfo } from './sections.js';
import { assertCan } from './access.js';
import { evaluateApplicant, nextAdmissionNo, recordServiceFact } from './admissions.js';
import { localToday, currentYear } from '../lib/dates.js';

/**
 * Spreadsheet import and export. Files are CSV with a UTF-8 marker, so Excel opens and saves them
 * directly. An import is always checked row by row first (preview), and then saved all at once or
 * not at all, so a half-imported school never happens.
 */

const today = () => localToday();

/** RFC 4180 CSV: quoted fields, commas, quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
/** CSV with a UTF-8 marker. Cells that look like formulas are neutralised so a file can never run code in Excel. */
export const toCsv = (header: string[], rows: unknown[][]) => `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

// ── Exports ───────────────────────────────────────────────────────────────────────────────

export async function exportStudents(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'students.export', schoolId);
  const rows = await db.query<Record<string, unknown>>(
    `select e.admission_no, s.nes_id, s.name, s.dob::text, s.gender, e.class_code, sec.name as section, c.name as campus, h.name as house,
            e.status, lower(e.period)::text as joined, e.admission_category, g.name as guardian, sg.relationship, g.phone
       from enrolment e join student s on s.id = e.student_id join org_unit c on c.id = e.campus_id join class_level cl on cl.code = e.class_code
       left join section sec on sec.id = e.section_id left join house h on h.id = e.house_id
       left join student_guardian sg on sg.student_id = s.id and sg.is_primary left join guardian g on g.id = sg.guardian_id
      where e.school_id = $1 and upper_inf(e.period) order by cl.ordinal, sec.name, s.name`, [schoolId]);
  const cols = ['admission_no', 'nes_id', 'name', 'dob', 'gender', 'class_code', 'section', 'campus', 'house', 'status', 'joined', 'admission_category', 'guardian', 'relationship', 'phone'];
  return toCsv(['Admission no', 'NES ID', 'Name', 'Date of birth', 'Gender', 'Class', 'Section', 'Campus', 'House', 'Status', 'Joined', 'Admission category', 'Parent or guardian', 'Relationship', 'Phone'],
    rows.map((r) => cols.map((c) => r[c])));
}

/** The monthly attendance register for a class: one row per child, one column per school day. */
export async function attendanceRegister(db: Db, actor: Actor, sectionId: string, month: string) {
  const s = await sectionInfo(db, sectionId);
  // The class's own class teachers, or those who keep registers for every class.
  if (actor.id !== s.class_teacher_id && actor.id !== s.co_class_teacher_id) await assertCan(db, actor, 'attendance.register', s.school_id);
  const marks = await db.query<{ admission_no: string; name: string; on_date: string; status: string }>(
    `select e.admission_no, st.name, a.on_date::text, m.status from attendance_session a join attendance_mark m on m.session_id = a.id
       join enrolment e on e.id = m.enrolment_id join student st on st.id = e.student_id
      where a.section_id = $1 and a.on_date >= $2::date and a.on_date < ($2::date + interval '1 month') order by st.name, a.on_date`, [sectionId, `${month}-01`]);
  const days = [...new Set(marks.map((m) => m.on_date))].sort();
  const kids = new Map<string, { name: string; marks: Map<string, string> }>();
  for (const m of marks) {
    const k = kids.get(m.admission_no) ?? { name: m.name, marks: new Map() };
    k.marks.set(m.on_date, m.status);
    kids.set(m.admission_no, k);
  }
  const rows = [...kids.entries()].map(([no, k]) => {
    const vals = days.map((d) => k.marks.get(d) ?? '');
    return [no, k.name, ...vals, vals.filter((v) => v === 'P').length, vals.filter((v) => v === 'A').length, vals.filter((v) => v === 'L').length];
  });
  return toCsv(['Admission no', 'Name', ...days.map((d) => d.slice(8)), 'Present', 'Absent', 'Leave'], rows);
}

// ── Student import ────────────────────────────────────────────────────────────────────────

const HEADERS = ['name', 'dob', 'gender', 'class', 'section', 'campus', 'parent_name', 'relationship', 'phone', 'service', 'service_status', 'rank', 'posted_in_station', 'admission_no', 'joined'] as const;
export const IMPORT_TEMPLATE = toCsv([...HEADERS], [
  ['Aarav Sharma', '2014-06-12', 'M', 'VII', 'A', 'Main Campus', 'Cdr Vikram Sharma', 'FATHER', '+919812345678', 'NAVY', 'SERVING', 'N_CDR', 'yes', 'OLD/2019/0142', '2026-04-01'],
]);

const SERVICES = ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD', 'DEF_CIV_NAVY', 'DEF_CIV_ARMY_AF', 'NES_STAFF', 'CIVILIAN'];
const STATUSES = ['SERVING', 'DEPUTATION_NAVY', 'ESM_PENSION', 'ESM_NO_PENSION', 'RETIRED', 'DIED_IN_SERVICE', 'NONE'];

interface Parsed { line: number; data: Record<string, string>; errors: string[]; campusId?: string; sectionId?: string | null; dob?: string; joined?: string; category?: string }

function normDate(v: string) {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

async function check(db: Db, schoolId: string, year: string, text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw invalid('The file has no rows. Download the template and fill it in.');
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = HEADERS.filter((h) => !['rank', 'posted_in_station', 'admission_no', 'joined', 'campus'].includes(h) && !head.includes(h));
  if (missing.length) throw invalid(`These columns are missing: ${missing.join(', ')}.`);
  if (rows.length > 3001) throw invalid('Import at most 3,000 students at a time.');
  const campuses = await db.query<{ id: string; name: string }>(`select id, name from org_unit where parent_id = $1 and kind = 'campus' and active`, [schoolId]);
  const sections = await db.query<{ id: string; campus_id: string; class_code: string; name: string }>(
    `select s.id, s.campus_id, s.class_code, s.name from section s join org_unit c on c.id = s.campus_id where c.parent_id = $1 and s.academic_year = $2`, [schoolId, year]);
  const ranks = new Set((await db.query<{ code: string }>('select code from rank')).map((r) => r.code));
  const existingNos = new Set((await db.query<{ admission_no: string }>('select admission_no from enrolment where school_id = $1', [schoolId])).map((r) => r.admission_no));
  const seenNos = new Set<string>();
  const out: Parsed[] = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const d: Record<string, string> = {};
    head.forEach((h, j) => { d[h] = (r[j] ?? '').trim(); });
    const p: Parsed = { line: i + 2, data: d, errors: [] };
    if (d.name.length < 2) p.errors.push('Name is missing.');
    p.dob = normDate(d.dob) ?? undefined;
    if (!p.dob) p.errors.push('Date of birth must be YYYY-MM-DD or DD/MM/YYYY.');
    if (!['F', 'M', 'X'].includes(d.gender.toUpperCase())) p.errors.push('Gender must be F, M or X.');
    const campus = d.campus ? campuses.find((c) => c.name.toLowerCase() === d.campus.toLowerCase()) : campuses.length === 1 ? campuses[0] : undefined;
    if (!campus) p.errors.push(campuses.length > 1 ? `Campus must be one of: ${campuses.map((c) => c.name).join(', ')}.` : 'Unknown campus.');
    p.campusId = campus?.id;
    const cls = d.class.toUpperCase();
    const sec = sections.find((s) => s.campus_id === campus?.id && s.class_code === cls && s.name === d.section.toUpperCase());
    if (!sec) p.errors.push(`There is no class ${cls}-${d.section.toUpperCase()} at this campus.`);
    p.sectionId = sec?.id ?? null;
    if (d.parent_name.length < 2) p.errors.push('Parent name is missing.');
    if (!['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT'].includes(d.relationship.toUpperCase())) p.errors.push('Relationship must be FATHER, MOTHER, GUARDIAN or GRANDPARENT.');
    const phone = d.phone.replace(/[\s-]/g, '');
    if (!/^(\+91)?[6-9]\d{9}$/.test(phone)) p.errors.push('Phone must be a 10-digit Indian mobile number.');
    if (!SERVICES.includes(d.service.toUpperCase())) p.errors.push(`Service must be one of ${SERVICES.join(', ')}.`);
    if (!STATUSES.includes(d.service_status.toUpperCase())) p.errors.push(`Service status must be one of ${STATUSES.join(', ')}.`);
    if (d.rank && !ranks.has(d.rank.toUpperCase())) p.errors.push(`Unknown rank code ${d.rank}.`);
    if (d.admission_no) {
      if (existingNos.has(d.admission_no) || seenNos.has(d.admission_no)) p.errors.push(`Admission number ${d.admission_no} is already used.`);
      seenNos.add(d.admission_no);
    }
    p.joined = d.joined ? normDate(d.joined) ?? undefined : today();
    if (!p.joined) p.errors.push('Joined date must be YYYY-MM-DD or DD/MM/YYYY.');
    if (!p.errors.length) {
      const ev = await evaluateApplicant(db, schoolId, d.relationship.toUpperCase(), {
        service: d.service.toUpperCase(), status: d.service_status.toUpperCase(), rankCode: d.rank ? d.rank.toUpperCase() : null, postedInStation: /^(y|yes|true|1)$/i.test(d.posted_in_station ?? ''),
      }, p.joined!);
      p.category = ev.admission.code;
    }
    out.push(p);
  }
  return out;
}

export async function previewStudents(db: Db, actor: Actor, schoolId: string, year: string, csv: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  const rows = await check(db, schoolId, year, csv);
  return { total: rows.length, valid: rows.filter((r) => !r.errors.length).length, rows: rows.map((r) => ({ line: r.line, name: r.data.name, class: `${r.data.class}-${r.data.section}`, parent: r.data.parent_name, category: r.category ?? null, errors: r.errors })) };
}

/**
 * Imports students. Families are matched by phone number, so siblings share one parent record
 * and one app login. Nothing is saved if any row has a problem.
 */
export async function importStudents(db: Db, actor: Actor, schoolId: string, year: string, csv: string) {
  requireRole(actor, 'SCHOOL_ADMIN', 'NES_ADMIN');
  await assertUnitInScope(db, actor, schoolId);
  const rows = await check(db, schoolId, year, csv);
  const bad = rows.filter((r) => r.errors.length);
  if (bad.length) throw invalid(`${bad.length} rows have problems. Fix them and try again; nothing was imported.`, bad.slice(0, 20).map((r) => ({ field: `line ${r.line}`, message: r.errors.join(' ') })));
  return db.tx(async (t) => {
    let created = 0, families = 0;
    for (const r of rows) {
      const d = r.data;
      const phone = d.phone.replace(/[\s-]/g, '').replace(/^(?!\+91)/, '+91');
      let g = await t.maybeOne<{ id: string }>('select id from guardian where phone = $1 order by id limit 1', [phone]);
      const service = { service: d.service.toUpperCase(), status: d.service_status.toUpperCase(), rankCode: d.rank ? d.rank.toUpperCase() : null, postedInStation: /^(y|yes|true|1)$/i.test(d.posted_in_station ?? '') };
      if (!g) {
        g = await t.one<{ id: string }>('insert into guardian (name, phone) values ($1, $2) returning id', [d.parent_name, phone]);
        { const yearStart = `${currentYear().slice(0, 4)}-01-01`; await recordServiceFact(t, g.id, r.joined! < yearStart ? r.joined! : yearStart, service); }
        await t.query(`insert into app_user (name, role, guardian_id) values ($1, 'PARENT', $2)`, [d.parent_name, g.id]);
        families++;
      }
      const s = await t.one<{ id: string }>('insert into student (name, dob, gender) values ($1, $2, $3) returning id', [d.name, r.dob, d.gender.toUpperCase()]);
      await t.query('insert into student_guardian (student_id, guardian_id, relationship, is_primary) values ($1, $2, $3, true)', [s.id, g.id, d.relationship.toUpperCase()]);
      const ev = await evaluateApplicant(t, schoolId, d.relationship.toUpperCase(), service, r.joined!);
      const no = d.admission_no || await nextAdmissionNo(t, schoolId, year);
      await t.query(
        `insert into enrolment (student_id, school_id, campus_id, section_id, academic_year, class_code, admission_no, status, period, admission_category, category_snapshot)
         values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', daterange($8::date, null), $9, $10)`,
        [s.id, schoolId, r.campusId, r.sectionId, year, d.class.toUpperCase(), no, r.joined, ev.admission.code, JSON.stringify({ admission: ev.admission, imported: true })]);
      created++;
    }
    return { students: created, newFamilies: families };
  }, { actor: actor.label });
}
