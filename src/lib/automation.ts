/**
 * Router automation (batch 3, dry-run) — pure parts, unit-tested. No Expo imports.
 */
import { buildSearchable, scoreMatch } from "./arabic";
import { addDays, damascusInstant, damascusNow, hhmm } from "./damascus";

export type AutomationMode = "off" | "dry_run" | "live";

/** The eve-of-cutoff warning is shown at 20:00 Damascus on the day before the cutoff day. */
export const EVE_HOUR = 20;
export const EVE_PREFIX = "automation-eve-";
export const CUTOFF_ROUTE = "/manager/automation/cutoff";
export const URGENT_COLOR = "#B3261E";

export interface Eve {
  /** Billing month whose cutoff follows this eve (YYYY-MM). */
  month: string;
  /** The cutoff day itself (YYYY-MM-DD, 00:00 Damascus). */
  cutoffDay: string;
  /** The eve (YYYY-MM-DD). */
  eveDay: string;
  at: Date;
  id: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
function shiftMonthStr(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** The next `count` eves strictly after `now` (cutoff day clamped to 1–28 like the server). */
export function nextEves(cutoffDay: number, now: Date = new Date(), count = 2): Eve[] {
  const day = Number.isFinite(cutoffDay) ? Math.min(28, Math.max(1, Math.round(cutoffDay))) : 25;
  const month0 = damascusNow(now).day.slice(0, 7);
  const out: Eve[] = [];
  for (let i = 0; out.length < count && i < count + 2; i++) {
    const month = shiftMonthStr(month0, i);
    const cutoffDayStr = `${month}-${pad(day)}`;
    const eveDay = addDays(cutoffDayStr, -1);
    const at = damascusInstant(eveDay, EVE_HOUR);
    if (at.getTime() > now.getTime()) out.push({ month, cutoffDay: cutoffDayStr, eveDay, at, id: EVE_PREFIX + month });
  }
  return out;
}

export const EVE_TITLE = "تنبيه فصل الليلة";

/** The text the manager asked for; without N when the count could not be fetched. */
export function eveBody(n: number | null, mode: AutomationMode): string {
  const who = n === null ? "حسابات" : `${n} حساب`;
  return `سيتم فصل ${who} الساعة 12 ليلاً لعدم دفع الفاتورة — للإلغاء أو التعديل راجع القائمة${mode === "live" ? "" : " — وضع تجريبي"}`;
}

/** Whether the eve warning should be scheduled at all. */
export function eveWanted(mode: AutomationMode, paused: boolean, n: number | null): boolean {
  return mode !== "off" && !paused && n !== 0;
}

/* ---------------- «السجل» ---------------- */

export type LogAction = "would_disable" | "would_enable" | "disable" | "enable" | "skipped" | "alert";

export const ACTION_LABEL: Record<LogAction, string> = {
  would_disable: "سيُفصل (تجريبي)",
  would_enable: "سيُعاد تفعيله (تجريبي)",
  disable: "فُصل",
  enable: "أُعيد تفعيله",
  skipped: "لم يُلمس",
  alert: "تنبيه",
};

export const ACTION_FILTERS: [LogAction | "all", string][] = [
  ["all", "الكل"],
  ["would_disable", "سيُفصل"],
  ["would_enable", "سيُعاد تفعيله"],
  ["skipped", "لم يُلمس"],
  ["alert", "تنبيهات"],
];

export const SERVERS = ["1100", "2116"] as const;
export const serverLabel = (id: string) => (id === "-" ? "عام" : `سيرفر ${id}`);

export interface SummaryRow {
  router_id: string;
  action: string;
  n: number;
}

/** Per-server counts for the day, plus a total line. Unknown actions are kept under their own key. */
export function summarize(rows: SummaryRow[]): { server: string; counts: Record<string, number>; total: number }[] {
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const c = by.get(r.router_id) ?? {};
    c[r.action] = (c[r.action] ?? 0) + Number(r.n);
    by.set(r.router_id, c);
  }
  const order = (id: string) => (id === "-" ? "zz" : id);
  return [...by.entries()]
    .sort((a, b) => order(a[0]).localeCompare(order(b[0])))
    .map(([server, counts]) => ({ server, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }));
}

/* ---------------- «قائمة الفصل» ---------------- */

export interface TargetRow {
  subscriber_id: string;
  code: string;
  username: string;
  display_name: string;
  area_id: string;
  area_name: string;
  reason: "unpaid" | "two_bills";
  reason_text: string;
  oldest_month: string;
  due: number;
  excluded: boolean;
}

export interface AreaSection {
  area_id: string;
  area_name: string;
  count: number;
  excluded: number;
  data: TargetRow[];
}

/** Group by area (areas in name order, rows keep the server's order), filtered by an Arabic search. */
export function groupTargets(rows: TargetRow[], query = ""): AreaSection[] {
  const q = query.trim();
  const kept = q
    ? rows.filter((r) => scoreMatch(q, buildSearchable({ fullName: r.display_name, username: r.username, code: r.code })) > 0)
    : rows;
  const by = new Map<string, AreaSection>();
  for (const r of kept) {
    const s = by.get(r.area_id) ?? { area_id: r.area_id, area_name: r.area_name, count: 0, excluded: 0, data: [] };
    s.data.push(r);
    if (r.excluded) s.excluded++;
    else s.count++;
    by.set(r.area_id, s);
  }
  return [...by.values()].sort((a, b) => a.area_name.localeCompare(b.area_name, "ar"));
}

/* ---------------- settings ---------------- */

export function parseCutoffDay(input: string): number | null {
  const t = input.trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 28 ? n : null;
}

/** "2026-11-25 00:05" in Damascus time, whatever the phone's time zone. */
export function damascusStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const c = damascusNow(new Date(iso));
  return `${c.day} ${hhmm(c)}`;
}

export const MODE_LABEL: Record<AutomationMode, string> = { off: "متوقف", dry_run: "تجريبي", live: "حقيقي" };
