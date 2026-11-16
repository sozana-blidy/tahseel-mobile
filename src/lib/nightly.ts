/**
 * The manager's 22:00 notification — pure parts (no Expo imports, unit-tested).
 * One one-off notification per night, identified by its Damascus date.
 */
import { addDays, hhmm, isSummaryTime, type DamascusClock } from "./damascus";
import { formatFull } from "./money";

export const NIGHT_PREFIX = "manager-summary-";
export const nightId = (day: string) => `${NIGHT_PREFIX}${day}`;

export const NIGHT_TITLE = "ملخص تحصيل اليوم";
export const NIGHT_GENERIC_BODY = "اضغط لعرض المبالغ التي وصلت لكل معتمد اليوم";

/** Damascus days whose 22:00 is still ahead: tonight (if before 22:00) and the following nights. */
export function upcomingNights(clock: DamascusClock, count = 7): string[] {
  const first = isSummaryTime(clock) ? addDays(clock.day, 1) : clock.day;
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

const invoicesWord = (n: number) => (n >= 3 && n <= 10 ? "فواتير" : "فاتورة");

export interface NightLine {
  day: string;
  area_name: string;
  agent_name: string | null;
  amount: number;
  invoices: number;
}

/**
 * «الهنادي — علي قدار: 7 فواتير (900,000)» per area, for today's Damascus date only, then «(حتى 21:40)».
 * Agent cash only — same source as the daily summary screen (daily_collections).
 */
export function nightlyBody(lines: NightLine[], clock: DamascusClock): string {
  const today = lines.filter((l) => l.day === clock.day);
  const asOf = `(حتى ${hhmm(clock)})`;
  if (today.length === 0) return `لم تصل دفعات عبر المعتمدين اليوم ${asOf}`;
  return [
    ...today.map((l) => `${l.area_name} — ${l.agent_name ?? "المدير"}: ${l.invoices} ${invoicesWord(l.invoices)} (${formatFull(l.amount)})`),
    asOf,
  ].join("\n");
}
