/**
 * Monthly Excel report (full SYP, #,##0). Sheets: الملخص · المعتمدون · غير المدفوعين ·
 * one sheet per area. Pass areaId for a single-area report.
 */
import { loadAgents, loadAreaRows, loadCompensation, loadOverview } from "./managerData";
import { monthLabel } from "./months";
import { q, rpc } from "./rpc";
import { supabase } from "./supabase";
import { normalizeRow, type SubscriberRow } from "./types";
import type { XSheet } from "./xlsx";

const STATUS_AR: Record<SubscriberRow["status"], string> = {
  paid: "مدفوع", unpaid: "غير مدفوع", exempt: "معفى",
  no_invoice: "لا فاتورة", no_price: "بدون سعر", disconnected: "مفصول",
};
const METHOD_AR: Record<string, string> = { agent_cash: "عند المعتمد", manager_cash: "نقداً للمدير", shamcash: "شام كاش" };
const COMP_AR = { none: "بدون", monthly_salary: "راتب شهري", per_invoice: "عن كل فاتورة" } as const;

const SUB_HEAD = ["المنطقة", "الاسم الثلاثي", "اسم المستخدم", "الهاتف", "الباقة", "الفاتورة", "المدفوع", "الإعفاء", "الباقي", "الحالة", "طريقة الدفع"];
const SUB_W = [14, 30, 14, 14, 8, 12, 12, 10, 12, 12, 18];
const SUB_MONEY = [5, 6, 7, 8];

function subLine(r: SubscriberRow, methods: Map<string, Set<string>>) {
  return [
    r.area_name, r.display_name, r.username, r.phone, r.package_label,
    r.amount, r.amount === null ? null : r.paid, r.amount === null ? null : r.exempt, r.amount === null ? null : r.remaining,
    STATUS_AR[r.status], r.invoice_id ? [...(methods.get(r.invoice_id) ?? [])].map((m) => METHOD_AR[m] ?? m).join("، ") : null,
  ];
}

export async function buildMonthReport(month: string, areaId?: string): Promise<{ sheets: XSheet[]; fileName: string }> {
  const [overview, rows, pays] = await Promise.all([
    loadOverview(month),
    areaId ? loadAreaRows(month, areaId) : rpc<Record<string, unknown>[]>("area_subscribers", { p_month: month }).then((x) => x.map(normalizeRow)),
    q<{ invoice_id: string; method: string; amount: number; reversal_of: string | null; reversed_by: string | null }[]>(
      supabase.from("payments").select("invoice_id, method, amount, reversal_of, reversed_by").eq("month", month),
    ),
  ]);
  const methods = new Map<string, Set<string>>();
  for (const p of pays) if (!p.reversal_of && !p.reversed_by) (methods.get(p.invoice_id) ?? methods.set(p.invoice_id, new Set()).get(p.invoice_id)!).add(p.method);

  const areas = areaId ? overview.filter((a) => a.area_id === areaId) : overview;
  const sheets: XSheet[] = [];

  const sum = areas.reduce((t, a) => ({ s: t.s + a.subscribers, p: t.p + a.paid_count, u: t.u + a.unpaid_count, e: t.e + a.exempt_count, ex: t.ex + a.expected, pd: t.pd + a.paid, xm: t.xm + a.exempt, r: t.r + a.remaining }), { s: 0, p: 0, u: 0, e: 0, ex: 0, pd: 0, xm: 0, r: 0 });
  sheets.push({
    name: "الملخص",
    rows: [
      ["المنطقة", "المعتمد", "المشتركون", "دفعوا", "لم يدفعوا", "معفى", "المطلوب", "المدفوع", "الإعفاءات", "الباقي", "مكتملة"],
      ...areas.map((a) => [a.area_name, a.agent_name ?? "المدير", a.subscribers, a.paid_count, a.unpaid_count, a.exempt_count, a.expected, a.paid, a.exempt, a.remaining, a.remaining === 0 && a.expected > 0 ? "نعم" : "لا"]),
      ...(areaId ? [] : [["المجموع", null, sum.s, sum.p, sum.u, sum.e, sum.ex, sum.pd, sum.xm, sum.r, null]]),
    ],
    widths: [16, 16, 11, 9, 10, 8, 14, 14, 12, 14, 9],
    moneyCols: [6, 7, 8, 9],
    totalRow: !areaId,
  });

  if (!areaId) {
    const agents = await loadAgents(month);
    const comps = await Promise.all(agents.map((a) => loadCompensation(a.profile.id, month).catch(() => null)));
    sheets.push({
      name: "المعتمدون",
      rows: [
        ["المعتمد", "المناطق", "فواتير حصّلها", "المحصّل", "المسلّم", "اقتطاع تعويض", "معه الآن", "نوع التعويض", "المستحق", "دُفع منفصلاً", "الباقي له"],
        ...agents.map((a, i) => {
          const c = comps[i];
          return [a.profile.full_name, a.areas.map((x) => x.name).join("، "), a.totals.count, a.totals.collected, a.totals.delivered, a.totals.deductions, a.totals.holding, COMP_AR[a.profile.comp_type], c?.due ?? null, c?.paid_separately ?? null, c?.remaining ?? null];
        }),
      ],
      widths: [16, 26, 12, 14, 14, 12, 14, 12, 12, 12, 12],
      moneyCols: [3, 4, 5, 6, 8, 9, 10],
    });
    const open = rows.filter((r) => r.status === "unpaid");
    sheets.push({ name: "غير المدفوعين", rows: [SUB_HEAD, ...open.map((r) => subLine(r, methods))], widths: SUB_W, moneyCols: SUB_MONEY });
  }

  for (const a of areas) {
    const list = rows.filter((r) => r.area_id === a.area_id);
    sheets.push({ name: a.area_name, rows: [SUB_HEAD, ...list.map((r) => subLine(r, methods))], widths: SUB_W, moneyCols: SUB_MONEY });
  }

  const label = areaId ? `${areas[0]?.area_name ?? "منطقة"}-` : "";
  return { sheets, fileName: `تحصيل-${label}${month}.xlsx` };
}

export const reportTitle = (month: string) => `تقرير ${monthLabel(month)}`;
