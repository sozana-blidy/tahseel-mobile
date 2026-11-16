/**
 * Parser for the company's subscriber workbook. Pure function over a grid of
 * primitive cell values so it can be unit-tested without a browser.
 *
 * Rules (from the brief): detect records, preserve source info, flag
 * duplicates/missing prices, never invent data, never auto-merge by name.
 */
import { normalizeArabic } from "./arabic";
import { DEFAULT_PRICE_PER_MBPS, parseSpeed, priceForMbps } from "./pricing";

export type PriceFlag = "ok" | "missing";

export type Cell = string | number | null;
export interface SheetGrid {
  name: string;
  rows: Cell[][];
}

export type RecordFlag =
  | "spf_exempt"
  | "unknown_speed"
  | "numeric_speed"
  | "no_speed"
  | "sheet_price_differs"
  | "unknown_name"
  | "no_username"
  | "duplicate_username"
  | "same_name_in_area"
  | "duplicate_in_continuation_sheet";

export const FLAG_LABEL: Record<RecordFlag, string> = {
  spf_exempt: "SPF — مشترك معفى",
  unknown_speed: "صيغة سرعة غير معروفة",
  numeric_speed: "خانة السرعة تحوي رقماً وليس سرعة",
  no_speed: "السرعة غير محددة",
  sheet_price_differs: "جدول الورقة يذكر سعراً مختلفاً عن القاعدة",
  unknown_name: "اسم المشترك «مجهول»",
  no_username: "بدون اسم مستخدم",
  duplicate_username: "اسم المستخدم مكرر",
  same_name_in_area: "اسم مشابه في نفس المنطقة",
  duplicate_in_continuation_sheet: "مكرر من الورقة الأساسية",
};

/** Flags that make a record excluded by default (the manager can still include it). */
const EXCLUDE_BY_DEFAULT: RecordFlag[] = ["unknown_name", "duplicate_in_continuation_sheet"];

export interface ImportRecord {
  key: string;
  sheet: string;
  /** 1-based Excel row number. */
  row: number;
  serial?: string;
  fullName: string;
  fatherName?: string;
  username?: string;
  phone?: string;
  rawSpeed?: string;
  packageName?: string;
  /** Monthly price from the company rule (Mbps × rate). null = unknown, never invented. */
  price: number | null;
  priceFlag: PriceFlag;
  mbps?: number;
  /** SPF subscribers are exempt (price 0). */
  exempt: boolean;
  area: string;
  flags: RecordFlag[];
  include: boolean;
  duplicateOf?: string;
}

export type SheetKind = "subscribers" | "continuation" | "summary" | "unknown";

export interface SheetReport {
  name: string;
  kind: SheetKind;
  area?: string;
  records: number;
  vacant: number;
  priceTable: Record<string, number>;
  note?: string;
}

export interface SummaryRow {
  area: string;
  count: number | null;
  countWithFree: number | null;
  total: number | null;
}

export interface ImportPreview {
  sheets: SheetReport[];
  records: ImportRecord[];
  summary: SummaryRow[];
  /** Speed → set of prices seen across sheets. */
  priceConflicts: Record<string, number[]>;
}

const str = (v: Cell | undefined): string => (v === null || v === undefined ? "" : String(v).trim());

export function normalizeSpeed(v: Cell | undefined): { label?: string; numeric: boolean } {
  if (v === null || v === undefined || str(v) === "") return { numeric: false };
  if (typeof v === "number") return { label: String(v), numeric: true };
  let s = str(v).toUpperCase().replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(s)) return { label: s, numeric: true };
  s = s.replace(/MB$/, "M");
  return { label: s, numeric: false };
}

function areaFromSheet(name: string): string {
  return name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function findHeaderRow(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    if ((rows[i] ?? []).some((c) => typeof c === "string" && /[اإ]سم المشترك/.test(c))) return i;
  }
  return -1;
}

function parsePriceTable(rows: Cell[][], minCol: number): Record<string, number> {
  const table: Record<string, number> = {};
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r] ?? [];
    for (let c = minCol; c < row.length; c++) {
      if (str(row[c]) === "السرعة" && str(row[c + 2]).includes("قيمة")) {
        for (let rr = r + 1; rr < Math.min(rows.length, r + 20); rr++) {
          const sp = normalizeSpeed(rows[rr]?.[c]);
          const price = rows[rr]?.[c + 2];
          if (!sp.label || sp.numeric) break;
          if (typeof price === "number" && Number.isFinite(price) && price > 0) table[sp.label] = Math.round(price);
        }
        return table;
      }
    }
  }
  return table;
}

function parseSummarySheet(rows: Cell[][]): SummaryRow[] {
  const out: SummaryRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const area = str(r[0]);
    if (!area || area === "السرعة") break;
    const n = (v: Cell | undefined) => (typeof v === "number" ? v : null);
    out.push({ area: areaFromSheet(area), count: n(r[1]), countWithFree: n(r[2]), total: n(r[3]) });
  }
  return out;
}

export function parseWorkbook(sheets: SheetGrid[], perMbps = DEFAULT_PRICE_PER_MBPS): ImportPreview {
  const reports: SheetReport[] = [];
  const records: ImportRecord[] = [];
  let summary: SummaryRow[] = [];
  const priceSeen: Record<string, Set<number>> = {};
  const sheetNames = sheets.map((s) => areaFromSheet(s.name));

  // Pass 1: structure + price tables
  const parsed = sheets.map((sheet) => {
    const rows = sheet.rows;
    const hi = findHeaderRow(rows);
    const header = hi >= 0 ? (rows[hi] ?? []).map(str) : [];
    const starts = header.map((h, i) => (/[اإ]سم المشترك/.test(h) ? i : -1)).filter((i) => i >= 0);
    const lastBlockEnd = starts.length ? starts[starts.length - 1] + 5 : 0;
    const priceTable = hi >= 0 ? parsePriceTable(rows, lastBlockEnd) : {};
    for (const [sp, p] of Object.entries(priceTable)) (priceSeen[sp] ??= new Set()).add(p);
    return { sheet, rows, hi, header, starts, priceTable };
  });

  const priceConflicts: Record<string, number[]> = {};
  for (const [sp, set] of Object.entries(priceSeen)) {
    if (set.size > 1) priceConflicts[sp] = [...set].sort((a, b) => a - b);
  }

  for (const { sheet, rows, hi, header, starts, priceTable } of parsed) {
    const area0 = areaFromSheet(sheet.name);
    if (hi < 0) {
      const first = str(rows[0]?.[0]);
      if (first.startsWith("الموقع")) {
        if (summary.length === 0) summary = parseSummarySheet(rows);
        reports.push({ name: sheet.name, kind: "summary", records: 0, vacant: 0, priceTable: {}, note: "ورقة ملخص — لا تحتوي مشتركين، تُستخدم للمقارنة فقط" });
      } else {
        reports.push({ name: sheet.name, kind: "unknown", records: 0, vacant: 0, priceTable: {}, note: "لم يتم التعرف على بنية الورقة" });
      }
      continue;
    }
    // "الهنادي 2" style: continuation of an existing sheet
    const m = area0.match(/^(.*\S)\s+\d+$/);
    const isContinuation = !!m && sheetNames.includes(m[1]);
    const area = isContinuation ? m![1] : area0;

    let count = 0;
    let vacant = 0;
    for (let bi = 0; bi < starts.length; bi++) {
      const s = starts[bi];
      const end = bi + 1 < starts.length ? starts[bi + 1] - 1 : s + 5;
      const col = (label: RegExp) => {
        for (let c = s + 1; c <= end && c < header.length; c++) if (label.test(header[c])) return c;
        return -1;
      };
      const cFather = col(/الأب/);
      const cUser = col(/يوزر/);
      const cSpeed = col(/السرعة/);
      const cPhone = col(/الهاتف/);
      for (let r = hi + 1; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const name = str(row[s]).replace(/\s+/g, " ");
        if (!name || /[اإ]سم المشترك/.test(name)) continue;
        if (name === "شاغر") {
          vacant++;
          continue;
        }
        const flags: RecordFlag[] = [];
        const sp = parseSpeed(cSpeed >= 0 ? row[cSpeed] : null);
        let price: number | null = null;
        let mbps: number | undefined;
        let exempt = false;
        let packageName: string | undefined;
        if (sp.kind === "none") flags.push("no_speed");
        else if (sp.kind === "numeric") flags.push("numeric_speed");
        else if (sp.kind === "unknown") flags.push("unknown_speed");
        else if (sp.kind === "spf") {
          flags.push("spf_exempt");
          exempt = true;
          price = 0;
          packageName = "SPF";
        } else {
          mbps = sp.mbps;
          packageName = sp.label;
          price = priceForMbps(sp.mbps, perMbps);
          const sheetPrice = priceTable[sp.label];
          if (sheetPrice !== undefined && sheetPrice !== price) flags.push("sheet_price_differs");
        }
        const priceFlag: PriceFlag = price === null ? "missing" : "ok";
        if (name === "مجهول") flags.push("unknown_name");
        const username = cUser >= 0 ? str(row[cUser]) || undefined : undefined;
        if (!username) flags.push("no_username");
        count++;
        records.push({
          key: `${sheet.name}!${r + 1}:${s}`,
          sheet: sheet.name,
          row: r + 1,
          serial: str(row[s - 1]) || undefined,
          fullName: name,
          fatherName: cFather >= 0 ? str(row[cFather]) || undefined : undefined,
          username,
          phone: cPhone >= 0 ? str(row[cPhone]) || undefined : undefined,
          rawSpeed: cSpeed >= 0 ? str(row[cSpeed]) || undefined : undefined,
          packageName: packageName ?? ("label" in sp ? sp.label : undefined),
          price,
          priceFlag,
          mbps,
          exempt,
          area,
          flags,
          include: true,
        });
      }
    }
    reports.push({
      name: sheet.name,
      kind: isContinuation ? "continuation" : "subscribers",
      area,
      records: count,
      vacant,
      priceTable,
      note: isContinuation ? `ورقة تكملة لـ «${area}» — تُفحص السجلات المكررة` : undefined,
    });
  }

  // Duplicate detection
  const nameKey = (r: ImportRecord) => `${r.area}|${normalizeArabic(r.fullName)}`;
  const mainByName = new Map<string, ImportRecord[]>();
  const contSheets = new Set(reports.filter((r) => r.kind === "continuation").map((r) => r.name));
  for (const r of records) {
    if (contSheets.has(r.sheet)) continue;
    const k = nameKey(r);
    mainByName.set(k, [...(mainByName.get(k) ?? []), r]);
  }
  for (const r of records) {
    if (!contSheets.has(r.sheet)) continue;
    const matches = mainByName.get(nameKey(r)) ?? [];
    const sameFather = matches.find((m) => normalizeArabic(m.fatherName) === normalizeArabic(r.fatherName));
    const hit = sameFather ?? matches[0];
    if (hit) {
      r.flags.push("duplicate_in_continuation_sheet");
      r.duplicateOf = `${hit.sheet} — صف ${hit.row}${hit.username ? ` (${hit.username})` : ""}`;
    }
  }
  for (const group of mainByName.values()) {
    if (group.length > 1) for (const r of group) r.flags.push("same_name_in_area");
  }
  const byUser = new Map<string, ImportRecord[]>();
  for (const r of records) {
    if (!r.username) continue;
    const k = r.username.toLowerCase();
    byUser.set(k, [...(byUser.get(k) ?? []), r]);
  }
  for (const group of byUser.values()) if (group.length > 1) for (const r of group) r.flags.push("duplicate_username");

  for (const r of records) r.include = !r.flags.some((f) => EXCLUDE_BY_DEFAULT.includes(f));

  return { sheets: reports, records, summary, priceConflicts };
}
