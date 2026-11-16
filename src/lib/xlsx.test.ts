import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildImportPlan } from "./importPlan";
import { parseWorkbook, type Cell, type SheetGrid } from "./parseWorkbook";
import { readXlsx, safeSheetName, writeXlsx } from "./xlsx";

/** ExcelJS gives no value for formulas without a cached result; ours returns the cached <v>. */
const FORMULA = "\u0000formula";

/** Reference reader (ExcelJS, Node only) to cross-check ours. */
async function readWithExcelJS(buf: Buffer): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    for (let r = 1; r <= Math.min(ws.rowCount, 5000); r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, 40); c++) {
        let v: unknown = row.getCell(c).value;
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          v = "formula" in o || "sharedFormula" in o ? ("result" in o && o.result !== undefined ? o.result : FORMULA) : Array.isArray(o.richText) ? (o.richText as { text: string }[]).map((t) => t.text).join("") : "text" in o ? o.text : null;
        }
        cells.push(v === undefined || v === "" ? null : (v as Cell));
      }
      rows.push(cells);
    }
    out.push({ name: ws.name, rows });
  });
  return out;
}

const trim = (g: SheetGrid[]) =>
  g.map((s) => {
    const rows = s.rows.map((r) => {
      const c = [...r];
      while (c.length && (c[c.length - 1] === null || c[c.length - 1] === undefined)) c.pop();
      return c;
    });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return { name: s.name, rows };
  });

describe("xlsx writer", () => {
  it("round-trips through our reader and through ExcelJS (RTL, #,##0, Arabic, escaping)", async () => {
    const bytes = writeXlsx([
      { name: "الملخص", rows: [["المنطقة", "المبلغ"], ["الهنادي & <فديو>", 1_250_000], ["المجموع", 106_100_000]], moneyCols: [1], widths: [20, 14], totalRow: true },
      { name: "a/b:c*d?[e]" + "x".repeat(40), rows: [["x"]] },
    ]);
    const ours = readXlsx(bytes);
    expect(ours[0].name).toBe("الملخص");
    expect(ours[0].rows[1]).toEqual(["الهنادي & <فديو>", 1_250_000]);
    expect(ours[1].name.length).toBeLessThanOrEqual(31);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getCell("B2").value).toBe(1_250_000);
    expect(ws.getCell("B2").numFmt).toBe("#,##0");
    expect(ws.getCell("A1").font?.bold).toBe(true);
    expect(ws.getCell("A3").font?.bold).toBe(true);
    expect(ws.views[0]?.rightToLeft).toBe(true);
  });

  it("unique, valid sheet names", () => {
    const used = new Set<string>();
    expect(safeSheetName("الهنادي", used)).toBe("الهنادي");
    expect(safeSheetName("الهنادي", used)).toBe("الهنادي 2");
  });

  it("rejects a non-xlsx file with an Arabic message", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/ليس ملف Excel/);
  });
});

// The company workbook holds personal data: it is never committed. Point to it with
//   set TAHSEEL_REAL_XLSX=C:\path\to\file.xlsx
const REAL = process.env.TAHSEEL_REAL_XLSX;
describe.skipIf(!REAL || !existsSync(REAL))("real company workbook", () => {
  it("our reader returns the same cells as ExcelJS", async () => {
    const buf = readFileSync(REAL!);
    const ours = trim(readXlsx(new Uint8Array(buf)));
    const ref = trim(await readWithExcelJS(buf));
    expect(ours.map((s) => s.name)).toEqual(ref.map((s) => s.name));
    let formulas = 0;
    for (let i = 0; i < ref.length; i++) {
      const mine = ref[i].rows.map((row, r) =>
        row.map((v, c) => {
          if (v !== FORMULA) return ours[i].rows[r]?.[c] ?? null;
          formulas++;
          return FORMULA;
        }),
      );
      expect(mine, ref[i].name).toEqual(ref[i].rows);
    }
    expect(formulas).toBeLessThan(100); // only the per-sheet COUNTIF price tables
  });

  it("import plan matches the confirmed totals (834 / 12 areas / 39 SPF / 4 no price / 106,100,000)", () => {
    const plan = buildImportPlan(parseWorkbook(readXlsx(new Uint8Array(readFileSync(REAL!)))));
    expect(plan.total).toEqual({ count: 834, expected: 106_100_000, exempt: 39, noPrice: 4 });
    expect(plan.areas).toHaveLength(12);
    expect(plan.areas.map((a) => a.area)).toContain("ضهر السرياني");
    expect(plan.areas.map((a) => a.area)).not.toContain("ضهر السريان");
  });
});

describe("base64 (Hermes-safe)", async () => {
  const { base64ToBytes, bytesToBase64 } = await import("./base64");
  it("matches Node for every length and round-trips an xlsx", () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      const ref = Buffer.from(b).toString("base64");
      expect(bytesToBase64(b)).toBe(ref);
      expect([...base64ToBytes(ref)]).toEqual([...b]);
    }
    const x = writeXlsx([{ name: "ا", rows: [["أ", 1]] }]);
    expect(readXlsx(base64ToBytes(bytesToBase64(x)))[0].rows[0]).toEqual(["أ", 1]);
  });
});
