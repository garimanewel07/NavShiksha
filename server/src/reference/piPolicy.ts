/**
 * NES policy letter "Calculation of Performance Index (PI)", Classes VI to XII.
 *
 * Classes VI–IX and XI: each counted subject gets a grade from its marks (91–100 A1 … 00–32 E),
 * weighted 7 to 0, and PI = [Σ(Wi × Ni) ÷ ΣNi] × 100 ÷ 7. Only the Common Final Examination
 * counts (no internal assessment). VI–VIII count all scholastic subjects; IX counts Hindi and
 * English plus the best three others; XI counts English plus the best four others.
 *
 * Classes X and XII: the grades on the CBSE result, as CBSE gave them (A1 … D2, E), weighted 8
 * to 0, and PI = [Σ(Wi × Ni) ÷ ΣNi] × 100 ÷ 8. X counts Hindi and English plus the best three;
 * XII counts English plus the best four.
 */

export const INTERNAL_GRADES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E'] as const;
export const BOARD_GRADES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E'] as const;
export const INTERNAL_WEIGHT: Record<string, number> = { A1: 7, A2: 6, B1: 5, B2: 4, C1: 3, C2: 2, D: 1, E: 0 };
export const BOARD_WEIGHT: Record<string, number> = { A1: 8, A2: 7, B1: 6, B2: 5, C1: 4, C2: 3, D1: 2, D2: 1, E: 0 };

/**
 * The marks ranges of the policy (91–100 A1 … 33–40 D, 00–32 E) read as lower limits on the exact
 * percentage: 32.5% has not reached 33, so it is E; 90.6% has not reached 91, so it is A2.
 */
const BANDS: [number, string][] = [[91, 'A1'], [81, 'A2'], [71, 'B1'], [61, 'B2'], [51, 'C1'], [41, 'C2'], [33, 'D'], [0, 'E']];
export const internalGrade = (pct: number | null) => (pct === null ? 'E' : BANDS.find(([min]) => pct >= min - 1e-9)![1]);

/** CBSE writes grades as "A1", "A-1" or "A 1"; E1/E2 (and any fail) count as E. */
export function boardGrade(g: string) {
  const x = g.toUpperCase().replace(/[\s-]/g, '');
  return (BOARD_GRADES as readonly string[]).includes(x) ? x : x.startsWith('E') ? 'E' : null;
}

/** Subjects outside the PI in Classes VI–VIII (additional and co-scholastic subjects). */
export const NOT_SCHOLASTIC = ['CS', 'PE', 'ART', 'MUS', 'LIB'];

export const PI_CLASSES = ['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
export const scaleOf = (classCode: string) => (classCode === 'X' || classCode === 'XII' ? 8 : 7);

/** What each class counts, in the policy's words (shown on the PI sheet). */
export const COUNTED: Record<string, string> = {
  VI: 'All scholastic subjects', VII: 'All scholastic subjects', VIII: 'All scholastic subjects',
  IX: 'Hindi and English (mandatory) + best 3 of the remaining', X: 'Hindi and English (mandatory) + best 3 of the remaining',
  XI: 'English (mandatory) + best 4 of the remaining', XII: 'English (mandatory) + best 4 of the remaining',
};

/**
 * The subjects that count for one student: VI–VIII all of them; otherwise the mandatory ones
 * (English, and Hindi in IX and X) and the best of the rest by marks, five in all.
 */
export function counted<T extends { pct: number | null }>(classCode: string, subjects: T[], kindOf: (s: T) => 'ENGLISH' | 'HINDI' | null): T[] {
  if (['VI', 'VII', 'VIII'].includes(classCode)) return subjects;
  const wants = classCode === 'IX' || classCode === 'X' ? ['ENGLISH', 'HINDI'] : ['ENGLISH'];
  const must: T[] = [];
  for (const w of wants) {
    const m = subjects.filter((s) => kindOf(s) === w && !must.includes(s)).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))[0];
    if (m) must.push(m);
  }
  const rest = subjects.filter((s) => !must.includes(s)).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  return [...must, ...rest.slice(0, Math.max(0, 5 - must.length))];
}

/** The number of subjects each student should contribute (for the ΣNi check). */
export const perStudent = (classCode: string) => (['VI', 'VII', 'VIII'].includes(classCode) ? 6 : 5);

export type Stream = 'SCIENCE' | 'COMMERCE' | 'HUMANITIES';

/** A Class XI or XII stream from the subjects taken (our codes or CBSE codes). */
export function streamFrom(codes: string[]): Stream {
  const has = (...c: string[]) => c.some((x) => codes.includes(x));
  if (has('PHY', '042') && has('CHE', '043')) return 'SCIENCE';
  if (has('ACC', '055', 'BST', '054')) return 'COMMERCE';
  return 'HUMANITIES';
}

/** A section's stream (SCIENCE_PCM etc.) reported as the policy's three streams. */
export const streamOfSection = (s: string | null): Stream | null => (!s ? null : s.startsWith('SCIENCE') ? 'SCIENCE' : (s as Stream));

/** PI from grade counts. */
export function pi(counts: Record<string, number>, scale: 7 | 8) {
  const w = scale === 7 ? INTERNAL_WEIGHT : BOARD_WEIGHT;
  const sumNi = Object.values(counts).reduce((a, b) => a + b, 0);
  const sumWNi = Object.entries(counts).reduce((a, [g, n]) => a + (w[g] ?? 0) * n, 0);
  return { sumNi, sumWNi, pi: sumNi ? Math.round(((sumWNi / sumNi) * 100 / scale) * 100) / 100 : null };
}
