import { buildSearchable, scoreMatch, type Searchable } from "./arabic";
import type { PendingPayment } from "./paymentQueue";
import type { RowStatus, SubscriberRow } from "./types";

export type ListFilter = "unpaid" | "paid" | "all";

/** What the agent sees for a row, after merging unsent taps from the outbox. */
export type DisplayStatus = RowStatus | "sending";

export interface DisplayRow extends SubscriberRow {
  display: DisplayStatus;
  /** Amount the "تم الدفع" button will record (full remaining invoice). */
  due: number;
  canMark: boolean;
  search: Searchable;
}

export function toDisplayRows(rows: SubscriberRow[], pending: PendingPayment[], month: string): DisplayRow[] {
  const sending = new Set(pending.filter((p) => p.state === "pending" && p.month === month).map((p) => p.subscriberId));
  return rows.map((r) => {
    const isSending = sending.has(r.id) && (r.status === "unpaid" || r.status === "partial");
    const display: DisplayStatus = isSending ? "sending" : r.status;
    return {
      ...r,
      display,
      due: r.remaining,
      canMark: !isSending && (r.status === "unpaid" || r.status === "partial") && r.remaining > 0,
      search: buildSearchable({ fullName: r.display_name, fatherName: r.father_name ?? "", username: r.username ?? "", code: r.code, phone: r.phone ?? "" }),
    };
  });
}

const OPEN: DisplayStatus[] = ["unpaid", "partial"];
const DONE: DisplayStatus[] = ["paid", "sending", "exempt"];

/** A search query ignores the status filter, so a paid person is still found (and shown as paid). */
export function filterRows(rows: DisplayRow[], query: string, filter: ListFilter, areaId: string | null): DisplayRow[] {
  const inArea = areaId ? rows.filter((r) => r.area_id === areaId) : rows;
  if (query.trim()) {
    return inArea
      .map((r) => ({ r, s: scoreMatch(query, r.search) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
  }
  if (filter === "unpaid") return inArea.filter((r) => OPEN.includes(r.display));
  if (filter === "paid") return inArea.filter((r) => DONE.includes(r.display));
  return inArea;
}

export interface AgentTotals {
  collectedCount: number;
  collected: number;
  openCount: number;
  open: number;
}

export function totals(rows: DisplayRow[]): AgentTotals {
  const t: AgentTotals = { collectedCount: 0, collected: 0, openCount: 0, open: 0 };
  for (const r of rows) {
    if (r.display === "paid" || r.display === "sending") {
      t.collectedCount++;
      t.collected += r.display === "sending" ? r.paid + r.due : r.paid;
    } else if (r.display === "partial") {
      t.collected += r.paid;
    }
    if (r.display === "unpaid" || r.display === "partial") {
      t.openCount++;
      t.open += r.remaining;
    }
  }
  return t;
}
