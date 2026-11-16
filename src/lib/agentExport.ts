import { formatFull } from "./money";
import { monthLabel } from "./months";
import type { SubscriberRow } from "./types";
import type { XSheet } from "./xlsx";

/** The agent's unpaid list for the manager (full SYP, three-part names). */
export function unpaidSheet(rows: SubscriberRow[], agentName: string, month: string): { sheets: XSheet[]; fileName: string; message: string } {
  const open = rows.filter((r) => r.status === "unpaid" && r.remaining > 0);
  const total = open.reduce((a, r) => a + r.remaining, 0);
  const sheet: XSheet = {
    name: "غير المدفوعين",
    rows: [
      ["المنطقة", "الاسم الثلاثي", "اسم المستخدم", "الهاتف", "الباقة", "الباقي"],
      ...open.map((r) => [r.area_name, r.display_name, r.username, r.phone, r.package_label, r.remaining]),
      ["المجموع", `${open.length} مشترك`, null, null, null, total],
    ],
    widths: [14, 30, 14, 14, 8, 14],
    moneyCols: [5],
    totalRow: true,
  };
  return {
    sheets: [sheet],
    fileName: `غير-المدفوعين-${agentName}-${month}.xlsx`,
    message: `غير المدفوعين — ${monthLabel(month)} — ${agentName}: ${open.length} مشترك، المجموع ${formatFull(total)} ل.س`,
  };
}
