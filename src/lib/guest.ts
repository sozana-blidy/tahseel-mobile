/**
 * Guest (anonymous, read-only) data. Everything goes through guest_* database functions, which
 * refuse unless this anonymous user entered the guest code. Only area names, three-part names
 * and paid/unpaid/exempt — never phones, usernames, amounts or agents.
 */
import { buildSearchable, scoreMatch } from "./arabic";
import { rpc } from "./rpc";
import { toNum } from "./types";

export type GuestStatus = "paid" | "unpaid" | "exempt";

export interface GuestArea {
  month: string;
  area_id: string;
  area_name: string;
  paid_count: number;
  unpaid_count: number;
}

export interface GuestRow {
  area_name: string;
  display_name: string;
  status: GuestStatus;
}

export async function guestUnlocked(): Promise<boolean> {
  const r = await rpc<{ unlocked: boolean }>("guest_status");
  return !!r?.unlocked;
}

/** Throws the server's Arabic message on a wrong code / too many tries. */
export async function guestUnlock(code: string): Promise<void> {
  const r = await rpc<{ ok: boolean; error?: string }>("guest_unlock", { p_code: code });
  if (!r?.ok) throw new Error(r?.error ?? "رمز الضيف غير صحيح");
}

export async function loadGuestAreas(): Promise<GuestArea[]> {
  const rows = await rpc<Record<string, unknown>[]>("guest_overview", { p_month: null });
  return rows.map((r) => ({ ...(r as unknown as GuestArea), paid_count: toNum(r.paid_count), unpaid_count: toNum(r.unpaid_count) }));
}

export async function loadGuestArea(month: string, areaId: string): Promise<GuestRow[]> {
  return rpc<GuestRow[]>("guest_area_list", { p_month: month, p_area_id: areaId });
}

/** Search by name (same Arabic matching as the agent list); empty query = everyone. */
export function searchGuestRows(rows: GuestRow[], query: string): GuestRow[] {
  if (!query.trim()) return rows;
  return rows
    .map((r) => ({ r, s: scoreMatch(query, buildSearchable({ fullName: r.display_name })) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
}
