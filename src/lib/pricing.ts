/**
 * Company pricing rule (confirmed by the manager, Nov 2026):
 *   every 1 Mbps = 50,000 SYP per month  →  2M = 100,000 · 8M = 400,000 · 10M = 500,000
 *   SPF = exempt subscriber (no charge).
 * The rate is stored in settings so it can change for future months without
 * touching issued invoices.
 */
export const DEFAULT_PRICE_PER_MBPS = 50_000;

export type SpeedParse =
  | { kind: "mbps"; mbps: number; label: string }
  | { kind: "spf"; label: "SPF" }
  | { kind: "numeric"; label: string }
  | { kind: "none" }
  | { kind: "unknown"; label: string };

export function parseSpeed(raw: string | number | null | undefined): SpeedParse {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { kind: "none" };
  if (typeof raw === "number") return { kind: "numeric", label: String(raw) };
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (s === "SPF") return { kind: "spf", label: "SPF" };
  if (/^\d+(\.\d+)?$/.test(s)) return { kind: "numeric", label: s };
  const m = s.match(/^(\d+(?:\.\d+)?)M(?:B|BPS)?$/);
  if (m) {
    const mbps = Number(m[1]);
    return { kind: "mbps", mbps, label: `${m[1]}M` };
  }
  return { kind: "unknown", label: s };
}

export function priceForMbps(mbps: number, perMbps = DEFAULT_PRICE_PER_MBPS): number {
  return Math.round(mbps * perMbps);
}
