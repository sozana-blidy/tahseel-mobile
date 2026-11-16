/** Read models for the manager screens (all filtered by RLS + manager-only functions). */
import { q, rpc } from "./rpc";
import { supabase } from "./supabase";
import { normalizeRow, toNum, type Profile, type SubscriberRow } from "./types";

export interface AreaSummary {
  area_id: string;
  area_name: string;
  agent_id: string | null;
  agent_name: string | null;
  subscribers: number;
  expected: number;
  paid: number;
  exempt: number;
  remaining: number;
  paid_count: number;
  unpaid_count: number;
  partial_count: number;
  exempt_count: number;
}

function nums<T>(r: Record<string, unknown>, keys: string[]): T {
  const o = { ...r };
  for (const k of keys) o[k] = toNum(r[k]);
  return o as T;
}

export async function loadOverview(month: string): Promise<AreaSummary[]> {
  const rows = await rpc<Record<string, unknown>[]>("area_overview", { p_month: month });
  return rows.map((r) => nums<AreaSummary>(r, ["subscribers", "expected", "paid", "exempt", "remaining", "paid_count", "unpaid_count", "partial_count", "exempt_count"]));
}

export async function loadAreaRows(month: string, areaId: string): Promise<SubscriberRow[]> {
  const rows = await rpc<Record<string, unknown>[]>("area_subscribers", { p_month: month, p_area_id: areaId });
  return rows.map(normalizeRow);
}

export interface SubscriberFull {
  id: string;
  code: string;
  full_name: string;
  father_name: string | null;
  username: string | null;
  phone: string | null;
  area_id: string;
  speed_mbps: number | null;
  package_label: string | null;
  monthly_amount: number | null;
  standing_exempt: boolean;
  status: "active" | "disconnected";
  disconnected_from: string | null;
  notes: string | null;
}

export interface Ledger {
  id: string;
  amount: number;
  method?: "agent_cash" | "manager_cash" | "shamcash";
  reason?: string;
  reference?: string | null;
  notes?: string | null;
  agent_id?: string | null;
  recorded_by: string;
  created_at: string;
  reversal_of: string | null;
  reversed_by: string | null;
}

export interface SubscriberDetail {
  sub: SubscriberFull;
  row: SubscriberRow | null;
  areaName: string;
  areaAgent: { id: string; full_name: string } | null;
  payments: Ledger[];
  exemptions: Ledger[];
  names: Record<string, string>;
  pricePerMbps: number;
}

export async function loadSubscriber(id: string, month: string): Promise<SubscriberDetail> {
  const sub = await q<SubscriberFull>(supabase.from("subscribers").select("*").eq("id", id).single());
  const [rows, area, aa, pays, exs, profiles, price] = await Promise.all([
    rpc<Record<string, unknown>[]>("area_subscribers", { p_month: month, p_area_id: sub.area_id }),
    q<{ name: string }>(supabase.from("areas").select("name").eq("id", sub.area_id).single()),
    q<{ agent_id: string }[]>(supabase.from("agent_areas").select("agent_id").eq("area_id", sub.area_id)),
    q<Ledger[]>(supabase.from("payments").select("*").eq("subscriber_id", id).eq("month", month).order("created_at")),
    q<Ledger[]>(supabase.from("exemptions").select("*").eq("subscriber_id", id).eq("month", month).order("created_at")),
    q<Pick<Profile, "id" | "full_name" | "active">[]>(supabase.from("profiles").select("id, full_name, active")),
    q<{ value: string } | null>(supabase.from("settings").select("value").eq("key", "price_per_mbps").maybeSingle()),
  ]);
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.full_name]));
  const agentId = aa[0]?.agent_id;
  const agent = agentId ? profiles.find((p) => p.id === agentId && p.active) : undefined;
  const row = rows.map(normalizeRow).find((r) => r.id === id) ?? null;
  const fix = (l: Ledger) => ({ ...l, amount: toNum(l.amount) });
  return {
    sub: { ...sub, monthly_amount: sub.monthly_amount === null ? null : toNum(sub.monthly_amount), speed_mbps: sub.speed_mbps === null ? null : toNum(sub.speed_mbps) },
    row,
    areaName: area.name,
    areaAgent: agent ? { id: agent.id, full_name: agent.full_name } : null,
    payments: pays.map(fix),
    exemptions: exs.map(fix),
    names,
    pricePerMbps: toNum(price?.value ?? 50000) || 50000,
  };
}

export interface AgentCashRow {
  agent_id: string;
  agent_name: string;
  area_id: string;
  area_name: string;
  collected: number;
  collected_count: number;
  delivered: number;
  deductions: number;
  holding: number;
}

export interface Compensation {
  type: Profile["comp_type"];
  rate: number;
  invoices: number;
  due: number;
  deducted: number;
  paid_separately: number;
  remaining: number;
}

export interface AgentSummary {
  profile: Profile;
  areas: { id: string; name: string }[];
  cash: AgentCashRow[];
  totals: { collected: number; delivered: number; deductions: number; holding: number; count: number };
}

export async function loadAgents(month: string): Promise<AgentSummary[]> {
  const [profiles, links, areas, cash] = await Promise.all([
    q<Profile[]>(supabase.from("profiles").select("*").eq("role", "agent").order("full_name")),
    q<{ agent_id: string; area_id: string }[]>(supabase.from("agent_areas").select("agent_id, area_id")),
    q<{ id: string; name: string; sort_order: number }[]>(supabase.from("areas").select("id, name, sort_order").order("sort_order")),
    rpc<Record<string, unknown>[]>("agent_cash", { p_month: month }),
  ]);
  const cashRows = cash.map((r) => nums<AgentCashRow>(r, ["collected", "collected_count", "delivered", "deductions", "holding"]));
  return profiles.map((p) => {
    const mine = cashRows.filter((c) => c.agent_id === p.id);
    return {
      profile: { ...p, comp_amount: toNum(p.comp_amount) },
      areas: areas.filter((a) => links.some((l) => l.agent_id === p.id && l.area_id === a.id)).map((a) => ({ id: a.id, name: a.name })),
      cash: mine,
      totals: mine.reduce(
        (t, c) => ({ collected: t.collected + c.collected, delivered: t.delivered + c.delivered, deductions: t.deductions + c.deductions, holding: t.holding + c.holding, count: t.count + c.collected_count }),
        { collected: 0, delivered: 0, deductions: 0, holding: 0, count: 0 },
      ),
    };
  });
}

export async function loadCompensation(agentId: string, month: string): Promise<Compensation> {
  const r = await rpc<Record<string, unknown>>("agent_compensation", { p_agent_id: agentId, p_month: month });
  return nums<Compensation>(r, ["rate", "invoices", "due", "deducted", "paid_separately", "remaining"]);
}

export interface AgentTx {
  id: string;
  area_id: string | null;
  month: string;
  type: "delivery" | "deduction" | "salary_paid";
  amount: number;
  paid_on: string;
  notes: string | null;
  created_at: string;
  reversal_of: string | null;
  reversed_by: string | null;
}

export async function loadAgentTx(agentId: string, month: string): Promise<AgentTx[]> {
  const rows = await q<AgentTx[]>(supabase.from("agent_transactions").select("*").eq("agent_id", agentId).eq("month", month).order("created_at", { ascending: false }));
  return rows.map((r) => ({ ...r, amount: toNum(r.amount) }));
}

export interface AreaLite {
  id: string;
  name: string;
  agent_id: string | null;
  agent_name: string | null;
}

export async function loadAreas(): Promise<AreaLite[]> {
  const [areas, links, profiles] = await Promise.all([
    q<{ id: string; name: string }[]>(supabase.from("areas").select("id, name").order("sort_order")),
    q<{ agent_id: string; area_id: string }[]>(supabase.from("agent_areas").select("agent_id, area_id")),
    q<{ id: string; full_name: string; active: boolean }[]>(supabase.from("profiles").select("id, full_name, active").eq("role", "agent")),
  ]);
  return areas.map((a) => {
    const agent = profiles.find((p) => p.active && links.some((l) => l.area_id === a.id && l.agent_id === p.id));
    return { ...a, agent_id: agent?.id ?? null, agent_name: agent?.full_name ?? null };
  });
}

export interface Invite {
  code: string;
  full_name: string;
  username: string;
  area_ids: string[];
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
}

export async function loadOpenInvites(): Promise<Invite[]> {
  return q<Invite[]>(
    supabase.from("agent_invites").select("code, full_name, username, area_ids, expires_at, claimed_at, revoked_at").is("claimed_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: false }),
  );
}

/** Text the manager sends to a new agent (WhatsApp etc.). */
export function inviteMessage(i: { code: string; username: string; full_name: string }) {
  return `تطبيق تحصيل — تفعيل حساب المعتمد ${i.full_name}\nرمز الدعوة: ${i.code}\nاسم الدخول: ${i.username}\nالرمز صالح لمرة واحدة خلال 7 أيام.`;
}

export interface DailyLine {
  day: string; // YYYY-MM-DD (Damascus)
  area_id: string;
  area_name: string;
  agent_id: string | null;
  agent_name: string | null;
  amount: number;
  invoices: number;
}

export async function loadDailyCollections(days = 14): Promise<DailyLine[]> {
  const rows = await rpc<Record<string, unknown>[]>("daily_collections", { p_days: days });
  return rows.map((r) => ({ ...(r as unknown as DailyLine), day: String(r.day).slice(0, 10), amount: toNum(r.amount), invoices: toNum(r.invoices) }));
}

export interface DayPayment {
  payment_id: string;
  subscriber_id: string;
  full_name: string;
  father_name: string | null;
  package_label: string | null;
  month: string;
  amount: number;
  created_at: string;
  agent_name: string | null;
}

export async function loadDayPayments(areaId: string, day: string): Promise<DayPayment[]> {
  const rows = await rpc<Record<string, unknown>[]>("day_payments", { p_area_id: areaId, p_day: day });
  return rows.map((r) => ({ ...(r as unknown as DayPayment), amount: toNum(r.amount) }));
}
