/**
 * Money is stored as INTEGER full Syrian pounds everywhere (DB, API, Excel).
 * The UI shows and accepts amounts in THOUSANDS of SYP:
 *   1,000,000 SYP  ⇄  "1,000"      2,500 SYP  ⇄  "2.5"
 * Conversion happens only at the display/input boundary.
 */
export type SYP = number;

export const UNIT_LABEL = "المبالغ بالألف ليرة سورية";

const AR = "٠١٢٣٤٥٦٧٨٩";
const FA = "۰۱۲۳۴۵۶۷۸۹";

function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));
}

/** Display full SYP in thousands: 1500000 → "1,500"; 2500 → "2.5"; 1234 → "1.234". Exact, no rounding. */
export function formatK(syp: SYP | null | undefined): string {
  if (syp === null || syp === undefined) return "—";
  const neg = syp < 0;
  const abs = Math.abs(syp);
  const whole = Math.floor(abs / 1000);
  const frac = abs % 1000;
  let out = groupThousands(whole);
  if (frac) out += "." + String(frac).padStart(3, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + out;
}

/**
 * Parse a thousands-unit input into full SYP. "1,000" → 1,000,000; "2.5" → 2,500.
 * Accepts Arabic digits, "," / "،" as thousands separators, "." / "٫" as decimal point.
 * Rejects negatives, more than 3 decimals, and non-numbers. Returns null if invalid.
 */
export function parseK(input: string): SYP | null {
  if (typeof input !== "string") return null;
  let s = asciiDigits(input.trim()).replace(/٫/g, ".").replace(/[,،\s_']/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(3, "0")) : 0;
  const v = whole * 1000 + frac;
  return Number.isSafeInteger(v) ? v : null;
}

/** Full-SYP formatting with thousands commas (Excel and audit text): 1,000,000 */
export function formatFull(syp: SYP | null | undefined): string {
  if (syp === null || syp === undefined) return "—";
  return (syp < 0 ? "-" : "") + groupThousands(Math.abs(syp));
}

/** 1234567 → "1,234,567". Manual so it does not depend on the device's Intl/locale (Hermes). */
function groupThousands(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
