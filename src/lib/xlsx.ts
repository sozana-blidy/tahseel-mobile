/**
 * Minimal .xlsx reader/writer (pure JS on fflate — runs on Hermes, no Node APIs).
 * Reader: cell values only (strings / numbers), enough for the subscriber workbook.
 * Writer: inline strings, bold header, #,##0 numbers, right-to-left sheets, column widths.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Cell, SheetGrid } from "./parseWorkbook";

/* ------------------------------ reading ------------------------------ */

const MAX_ROWS = 5000;
const MAX_COLS = 40;

function decodeXml(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] ?? "";
    });
}

/** Text of all <t> runs, ignoring phonetic runs (<rPh>). */
function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ? decodeXml(m[1]) : "";
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}

/** "AB12" → 27 (0-based column index 27). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function resolvePath(target: string): string {
  const t = target.replace(/^\/+/, "");
  return t.startsWith("xl/") ? t : `xl/${t}`;
}

export function readXlsx(bytes: Uint8Array): SheetGrid[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("الملف ليس ملف Excel (.xlsx) صالحاً");
  }
  const txt = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  const workbook = txt("xl/workbook.xml");
  if (!workbook) throw new Error("الملف ليس ملف Excel (.xlsx) صالحاً");

  const rels = new Map<string, string>();
  for (const m of txt("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, resolvePath(target));
  }

  const shared: string[] = [];
  for (const m of txt("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");

  const out: SheetGrid[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name") ?? "";
    const rid = attr(m[0], "r:id");
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? txt(path) : "";
    const rows: Cell[][] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rTag = rm[1] ?? rm[3] ?? "";
      const r = Number(attr(`<row ${rTag}>`, "r") ?? rows.length + 1) - 1;
      if (r >= MAX_ROWS) break;
      const cells: Cell[] = [];
      let auto = 0;
      for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c ${cm[1]}>`;
        const ref = attr(tag, "r");
        const c = ref ? colIndex(ref) : auto;
        auto = c + 1;
        if (c >= MAX_COLS) continue;
        const body = cm[2] ?? "";
        const t = attr(tag, "t");
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value: Cell = null;
        if (t === "s") value = v !== undefined ? shared[Number(v)] ?? null : null;
        else if (t === "inlineStr") value = textOf(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "");
        else if (t === "str") value = v !== undefined ? decodeXml(v) : null;
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (t === "e") value = null;
        else if (v !== undefined && v !== "") {
          const n = Number(v);
          value = Number.isFinite(n) ? n : decodeXml(v);
        }
        if (value === "") value = null;
        cells[c] = value;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
      rows[r] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    // Merged ranges: repeat the top-left value in every cell (same as ExcelJS).
    for (const mm of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
      const c1 = colIndex(mm[1]);
      const r1 = Number(mm[2]) - 1;
      const c2 = Math.min(colIndex(mm[3]), MAX_COLS - 1);
      const r2 = Math.min(Number(mm[4]) - 1, MAX_ROWS - 1);
      const v = rows[r1]?.[c1] ?? null;
      for (let r = r1; r <= r2; r++) {
        const row = (rows[r] ??= []);
        for (let c = c1; c <= c2; c++) {
          while (row.length < c) row.push(null);
          row[c] = v;
        }
      }
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    out.push({ name, rows });
  }
  return out;
}

/* ------------------------------ writing ------------------------------ */

export type XCell = string | number | null | undefined;

export interface XSheet {
  name: string;
  /** First row is the header (bold, frozen). */
  rows: XCell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** 0-based indexes of columns holding money (formatted #,##0). */
  moneyCols?: number[];
  /** Make the last row bold (totals). */
  totalRow?: boolean;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel sheet names: ≤31 chars, no []:*?/\ , unique. */
export function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let n = 2;
  let out = base;
  while (used.has(out.toLowerCase())) {
    const suffix = ` ${n++}`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(out.toLowerCase());
  return out;
}

// style ids: 0 normal · 1 header · 2 money · 3 bold text · 4 bold money
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3F1ED"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(s: XSheet): string {
  const money = new Set(s.moneyCols ?? []);
  const last = s.rows.length - 1;
  const rows = s.rows
    .map((row, r) => {
      const bold = r === 0 || (s.totalRow && r === last && r > 0);
      const cells = row
        .map((v, c) => {
          if (v === null || v === undefined || v === "") return "";
          const ref = `${colName(c)}${r + 1}`;
          if (typeof v === "number" && Number.isFinite(v)) {
            const st = r === 0 ? 1 : money.has(c) ? (bold ? 4 : 2) : bold ? 3 : 0;
            return `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
          }
          const st = r === 0 ? 1 : bold ? 3 : 0;
          return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = s.rows.length > 1 ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView rightToLeft="1" workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  if (!sheets.length) throw new Error("no sheets");
  const used = new Set<string>();
  const names = sheets.map((s) => safeSheetName(s.name, used));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}
