/**
 * Damascus wall clock. Syria has used UTC+3 all year since October 2022 (no DST), so a fixed
 * offset is exact and avoids depending on time-zone data in the phone or in Hermes' Intl.
 * The database uses 'Asia/Damascus', which gives the same result.
 */
const OFFSET_MS = 3 * 60 * 60 * 1000;

/** The manager's daily summary appears (and is notified) at 22:00 Damascus time. */
export const SUMMARY_HOUR = 22;

export interface DamascusClock {
  /** YYYY-MM-DD */
  day: string;
  hour: number;
  minute: number;
}

export function damascusNow(now: Date = new Date()): DamascusClock {
  const d = new Date(now.getTime() + OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** The real instant of HH:MM Damascus time on a Damascus day (YYYY-MM-DD). */
export function damascusInstant(day: string, hour: number, minute = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - OFFSET_MS);
}

/** YYYY-MM-DD shifted by n days (calendar arithmetic, no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "21:40" */
export function hhmm(c: DamascusClock): string {
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** Today's summary is shown only from 22:00 Damascus time. */
export function isSummaryTime(c: DamascusClock): boolean {
  return c.hour >= SUMMARY_HOUR;
}
