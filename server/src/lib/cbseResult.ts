/**
 * Reads the result file CBSE gives schools for Classes X and XII (a fixed-width text file).
 *
 * Each candidate takes two lines: the first has the roll number, sex, name, the subject codes and
 * the result (PASS, COMP, ESSENTIAL REPEAT, ABST…); the second has marks and grade for each subject
 * in the same order, sometimes followed by the internal (co-scholastic) grades. Headers, page
 * breaks and totals are skipped. The reader works on tokens rather than column positions, so small
 * differences in spacing between years do not matter, and it reports any line it could not use.
 */

export interface BoardSubject { code: string; marks: number | null; grade: string; absent: boolean }
export interface BoardRow { roll: string; gender: 'M' | 'F' | null; flag: string | null; name: string; subjects: BoardSubject[]; result: string; line: number }
/** What the file says about itself: the school code, Class X or XII, and main or supplementary examination. */
export interface BoardFileInfo { schoolCode: string | null; level: 'X' | 'XII' | null; supplementary: boolean; examDate: string | null }

const ROLL = /^\d{7,9}$/;
const CODE = /^\d{3}$/;
const MARK = /^(\d{1,3}|AB|ABS|ABST|XXX|---)$/i;
const GRADE = /^[A-E](-?[12])?$/i;
const RESULTS = ['ESSENTIAL REPEAT', 'PASS', 'COMPTT', 'COMP', 'FAIL', 'ABST', 'ABSENT', 'RL', 'RW', 'SR', 'XXXX', 'ER', 'UFM', 'RT'];

function resultOf(tokens: string[]) {
  const joined = tokens.join(' ').toUpperCase();
  return RESULTS.find((r) => new RegExp(`(^|\\s)${r}(\\s|$)`).test(joined)) ?? (joined.trim() || 'UNKNOWN');
}

/** Marks-and-grade pairs found in a run of tokens. */
function pairs(tokens: string[]) {
  const out: { marks: number | null; grade: string; absent: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // "085A2" written without a space.
    const glued = /^(\d{2,3})([A-E][12]?)$/i.exec(t);
    if (glued) { out.push({ marks: Number(glued[1]), grade: glued[2].toUpperCase(), absent: false }); continue; }
    if (MARK.test(t) && i + 1 < tokens.length && GRADE.test(tokens[i + 1])) {
      const absent = !/^\d/.test(t);
      out.push({ marks: absent ? null : Number(t), grade: tokens[i + 1].toUpperCase().replace('-', ''), absent });
      i++;
    }
  }
  return out;
}

export function parseCbseResult(text: string) {
  const lines = text.replace(/\f/g, '\n').split(/\r?\n/);
  const head = lines.slice(0, 40).join('\n').toUpperCase();
  const info: BoardFileInfo = {
    schoolCode: /SCHOOL\s*:\s*-?\s*(\d{4,6})/.exec(text)?.[1] ?? null,
    level: /SENIOR SCHOOL/.test(head) ? 'XII' : /SECONDARY SCHOOL|SECONDARY EXAMINATION/.test(head) ? 'X' : null,
    // The main examination is in spring; the supplementary (compartment and improvement) in summer.
    supplementary: /SUPPLEMENTARY|COMPARTMENT|IMPROVEMENT|\(C[A-Z]*\)/.test(head),
    examDate: /DATE:-?\s*(\d{2})-(\d{2})-(\d{4})/.exec(head)?.slice(1).reverse().join('-') ?? null,
  };
  const rows: BoardRow[] = [];
  const skipped: { line: number; text: string }[] = [];
  let cur: BoardRow | null = null;
  let need = 0;
  const finish = () => {
    if (!cur) return;
    if (cur.subjects.filter((s) => s.grade).length < need) skipped.push({ line: cur.line, text: `${cur.roll} ${cur.name}: marks for ${need} subjects not found` });
    else rows.push(cur);
    cur = null;
  };
  lines.forEach((raw, i) => {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    if (ROLL.test(tokens[0]) && tokens.some((t, k) => k > 1 && CODE.test(t))) {
      finish();
      // Columns after the roll number: a flag (I for improvement, C for compartment…, usually blank)
      // and the sex, each one character wide; read by position so a one-letter name is not taken for them.
      const cols = /^\s*\d{7,9} (.) ([MF ]) (.*)$/i.exec(raw);
      let k = 1, gender: 'M' | 'F' | null = null, flag: string | null = null, rest = tokens;
      if (cols) {
        flag = cols[1].trim() || null;
        gender = (cols[2].trim().toUpperCase() || null) as 'M' | 'F' | null;
        // Files laid out with the sex straight after the roll number (one space) carry no flag column.
        if (!gender && flag && /^[MF]$/i.test(flag)) { gender = flag.toUpperCase() as 'M' | 'F'; flag = null; }
        rest = [tokens[0], ...cols[3].trim().split(/\s+/)];
      } else if (/^[MF]$/i.test(tokens[1] ?? '')) { gender = tokens[1].toUpperCase() as 'M' | 'F'; k = 2; }
      const nameParts: string[] = [];
      while (k < rest.length && !CODE.test(rest[k])) nameParts.push(rest[k++]);
      const tokensAfter = rest;
      const codes: string[] = [];
      while (k < tokensAfter.length && CODE.test(tokensAfter[k])) codes.push(tokensAfter[k++]);
      const tail = tokensAfter.slice(k);
      const found = pairs(tail);
      cur = { roll: tokens[0], gender, flag, name: nameParts.join(' '), result: resultOf(tail.filter((t) => !MARK.test(t) && !GRADE.test(t) && !/^\d/.test(t))), line: i + 1,
        subjects: codes.map((code) => ({ code, marks: null, grade: '', absent: false })) };
      need = codes.length;
      found.slice(0, need).forEach((p, j) => Object.assign(cur!.subjects[j], p));
      if (found.length >= need) finish();
      return;
    }
    if (cur) {
      const filled = cur.subjects.filter((s) => s.grade).length;
      const found = pairs(tokens);
      if (found.length) {
        found.slice(0, need - filled).forEach((p, j) => Object.assign(cur!.subjects[filled + j], p));
        if (cur.subjects.every((s) => s.grade)) finish();
        return;
      }
    }
    if (tokens.some((t) => ROLL.test(t))) skipped.push({ line: i + 1, text: raw.trim().slice(0, 120) });
  });
  finish();
  return { rows, skipped, info };
}

/** True when the file looks like the CBSE text file rather than a spreadsheet saved as CSV. */
export const looksLikeCbseTxt = (text: string) => !/^[^\n]*,[^\n]*,/.test(text.split(/\r?\n/).find((l) => l.trim()) ?? '') && /\d{7,9}\s+[MF]?\s*[A-Z]/i.test(text);
