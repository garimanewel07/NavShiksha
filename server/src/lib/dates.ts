/**
 * Dates as the schools live them: India time. "Today" changes at midnight in India, not in UTC,
 * and the database works in the same time zone, so a record made at 1 am carries the right date.
 */
export const SCHOOL_TIME_ZONE = 'Asia/Kolkata';

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in India, as YYYY-MM-DD. */
export const localToday = () => ymd.format(new Date());

/** The academic year (April to March) a date falls in, as "2026-27". */
export const academicYearOf = (iso: string) => {
  const y = Number(iso.slice(0, 4)), start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};
/** The academic year today falls in (the default wherever a screen does not choose one). */
export const currentYear = () => academicYearOf(localToday());
/** The academic year before a given one: "2026-27" → "2025-26". */
export const yearBefore = (year: string) => academicYearOf(`${Number(year.slice(0, 4)) - 1}-06-01`);

/** A date some days before or after a YYYY-MM-DD date. */
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** A date some days from today in India. */
export const daysFromToday = (n: number) => addDays(localToday(), n);
