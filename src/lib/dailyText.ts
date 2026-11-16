import { isSummaryTime, type DamascusClock } from "./damascus";
import { formatFull } from "./money";

export const SUMMARY_PENDING_TEXT = "يظهر ملخص اليوم الساعة 10 مساءً";

/** The daily summary is an evening thing: before 22:00 Damascus, today's lines are hidden. */
export function visibleSummary<L extends { day: string }>(lines: L[], clock: DamascusClock): { lines: L[]; todayHidden: boolean } {
  if (isSummaryTime(clock)) return { lines, todayHidden: false };
  return { lines: lines.filter((l) => l.day !== clock.day), todayHidden: true };
}

/** «تم دفع 4,000,000 ل.س لمعتمد الهنادي علي قدار» */
export function dailyLine(l: { amount: number; area_name: string; agent_name: string | null }): string {
  return `تم دفع ${formatFull(l.amount)} ل.س لمعتمد ${l.area_name}${l.agent_name ? ` ${l.agent_name}` : ""}`;
}

/** "اليوم" / "أمس" / "الأحد 15/11" for a YYYY-MM-DD in local time. */
export function dayTitle(day: string, now = new Date()): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return "اليوم";
  if (diff === 1) return "أمس";
  const names = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  return `${names[date.getDay()]} ${d}/${m}`;
}
