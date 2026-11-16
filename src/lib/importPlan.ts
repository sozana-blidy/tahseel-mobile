/**
 * Turns the parsed workbook into the rows sent to import_subscribers, plus the
 * numbers the manager checks before confirming.
 */
import type { ImportPreview, ImportRecord, RecordFlag } from "./parseWorkbook";

/** Sheet names that differ from the real area name (confirmed by the manager). */
export const AREA_RENAMES: Record<string, string> = {
  "ضهر السريان": "ضهر السرياني",
};
export const areaName = (sheetArea: string) => AREA_RENAMES[sheetArea.trim()] ?? sheetArea.trim();

export interface ImportRow {
  full_name: string;
  father_name: string | null;
  username: string | null;
  phone: string | null;
  area: string;
  speed_mbps: number | null;
  package_label: string | null;
  monthly_amount: number | null;
  standing_exempt: boolean;
  source_sheet: string;
  source_row: number;
  flags: RecordFlag[];
}

export interface AreaPlan {
  area: string;
  count: number;
  expected: number;
  exempt: number;
  noPrice: number;
  /** Total from the workbook's summary sheet (الكل), when present. */
  sheetTotal: number | null;
  sheetCount: number | null;
}

export interface ImportPlan {
  rows: ImportRow[];
  areas: AreaPlan[];
  total: { count: number; expected: number; exempt: number; noPrice: number };
  excluded: { record: ImportRecord; reason: string }[];
  warnings: { label: string; count: number }[];
}

const EXCLUDE_REASON: Partial<Record<RecordFlag, string>> = {
  unknown_name: "الاسم «مجهول»",
  duplicate_in_continuation_sheet: "مكرر في ورقة التكملة",
};

export function buildImportPlan(p: ImportPreview): ImportPlan {
  const rows: ImportRow[] = [];
  const excluded: ImportPlan["excluded"] = [];
  for (const r of p.records) {
    if (!r.include) {
      const f = r.flags.find((x) => EXCLUDE_REASON[x]);
      excluded.push({ record: r, reason: (f && EXCLUDE_REASON[f]) ?? "مستبعد" });
      continue;
    }
    rows.push({
      full_name: r.fullName,
      father_name: r.fatherName ?? null,
      username: r.username ?? null,
      phone: r.phone ?? null,
      area: areaName(r.area),
      speed_mbps: r.mbps ?? null,
      package_label: r.packageName ?? null,
      monthly_amount: r.price,
      standing_exempt: r.exempt,
      source_sheet: r.sheet,
      source_row: r.row,
      flags: r.flags,
    });
  }

  const summary = new Map(p.summary.map((s) => [areaName(s.area), s]));
  const byArea = new Map<string, AreaPlan>();
  for (const r of rows) {
    const a = byArea.get(r.area) ?? { area: r.area, count: 0, expected: 0, exempt: 0, noPrice: 0, sheetTotal: null, sheetCount: null };
    a.count++;
    if (r.standing_exempt) a.exempt++;
    else if (r.monthly_amount === null) a.noPrice++;
    else a.expected += r.monthly_amount;
    byArea.set(r.area, a);
  }
  const areas = [...byArea.values()].map((a) => ({ ...a, sheetTotal: summary.get(a.area)?.total ?? null, sheetCount: summary.get(a.area)?.countWithFree ?? summary.get(a.area)?.count ?? null }));
  const total = areas.reduce((t, a) => ({ count: t.count + a.count, expected: t.expected + a.expected, exempt: t.exempt + a.exempt, noPrice: t.noPrice + a.noPrice }), { count: 0, expected: 0, exempt: 0, noPrice: 0 });

  const count = (f: RecordFlag) => rows.filter((r) => r.flags.includes(f)).length;
  const warnings = [
    { label: "بدون سعر (السرعة غير معروفة) — حدّدها لاحقاً من صفحة المشترك", count: total.noPrice },
    { label: "اسم مستخدم مكرر — يُحفظ لأول واحد فقط", count: count("duplicate_username") },
    { label: "اسم مشابه في نفس المنطقة — تحقق أنهم أشخاص مختلفون", count: count("same_name_in_area") },
    { label: "سعر الورقة يختلف عن قاعدة 50 ألف للميغا — تم اعتماد القاعدة", count: count("sheet_price_differs") },
  ].filter((w) => w.count > 0);

  return { rows, areas, total, excluded, warnings };
}
