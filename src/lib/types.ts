import { displayName } from "./names";

export type Role = "manager" | "agent";

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  username: string;
  phone: string | null;
  active: boolean;
  comp_type: "none" | "monthly_salary" | "per_invoice";
  comp_amount: number;
}

export type RowStatus = "paid" | "unpaid" | "exempt" | "no_invoice" | "no_price" | "disconnected";

/** One row of public.area_subscribers(month). Bigints arrive as numbers or strings — normalize with toNum. */
export interface SubscriberRow {
  id: string;
  /** "first father family" — computed on load (lib/names.ts). */
  display_name: string;
  code: string;
  full_name: string;
  father_name: string | null;
  username: string | null;
  phone: string | null;
  area_id: string;
  area_name: string;
  package_label: string | null;
  monthly_amount: number | null;
  sub_status: "active" | "disconnected";
  invoice_id: string | null;
  amount: number | null;
  paid: number;
  exempt: number;
  remaining: number;
  status: RowStatus;
  paid_by_agent: boolean;
  last_paid_at: string | null;
  /** Comma-separated live payment methods, e.g. "agent_cash" or "agent_cash,manager_cash". */
  paid_via: string | null;
}

export const toNum = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));

export function normalizeRow(r: Record<string, unknown>): SubscriberRow {
  const row = r as unknown as SubscriberRow;
  return {
    ...row,
    display_name: displayName(String(r.full_name ?? ""), (r.father_name as string | null) ?? null),
    paid_via: (r.paid_via as string | null) ?? null,
    monthly_amount: r.monthly_amount === null ? null : toNum(r.monthly_amount),
    amount: r.amount === null ? null : toNum(r.amount),
    paid: toNum(r.paid),
    exempt: toNum(r.exempt),
    remaining: toNum(r.remaining),
  };
}
