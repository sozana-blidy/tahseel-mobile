/** Router automation — manager RPCs (all refuse non-managers on the server). */
import type { AutomationMode, LogAction, SummaryRow, TargetRow } from "./automation";
import { rpc } from "./rpc";

export interface CycleInfo {
  month: string;
  cutoff_at: string;
  eve_at: string;
  started: boolean;
  snapshot_at: string | null;
  snapshot_count: number | null;
  in_scope_count: number | null;
  prev_count: number | null;
  hold_reason: "sanity" | "daily_limit" | null;
  hold_count: number | null;
  paused: boolean;
  count_now: number;
  excluded_count: number;
}

export interface RouterInfo {
  id: string;
  name: string;
  enabled: boolean;
  has_token: boolean;
  last_seen_at: string | null;
  silent: boolean;
}

export interface AutomationStatus {
  mode: AutomationMode;
  cutoff_day: number;
  max_disconnects_per_run: number;
  daily_new_disconnect_limit: number;
  areas: { id: string; name: string }[];
  routers: RouterInfo[];
  cycle: CycleInfo;
}

export interface LogRow {
  id: number;
  at: string;
  router_id: string;
  username: string;
  subscriber_id: string | null;
  action: LogAction;
  reason: string;
  message: string;
  batch_no: number | null;
  dry: boolean;
}

export interface SubscriberAutomation {
  no_auto_disconnect: boolean;
  month: string;
  excluded: boolean;
  accounts: { router_id: string; state: "disabled" | "simulated" | "overridden"; month: string; since: string }[];
}

export const loadAutomationStatus = () => rpc<AutomationStatus>("automation_status");
export const loadCycleInfo = (month: string) => rpc<CycleInfo>("automation_cycle_info", { p_month: month });
export const loadDisconnectList = (month: string) =>
  rpc<TargetRow[]>("automation_disconnect_list", { p_month: month }).then((r) => (r ?? []).map((x) => ({ ...x, due: Number(x.due) })));
export const loadLogDays = () => rpc<{ day: string; n: number; alerts: number }[]>("automation_log_days", { p_limit: 60 });
export const loadLog = (day: string, router: string | null, action: string | null) =>
  rpc<LogRow[]>("automation_log_list", { p_day: day, p_router: router, p_action: action });
export const loadLogSummary = (day: string) =>
  rpc<SummaryRow[]>("automation_log_summary", { p_day: day }).then((r) => (r ?? []).map((x) => ({ ...x, n: Number(x.n) })));
export const loadSubscriberAutomation = (id: string) => rpc<SubscriberAutomation>("subscriber_automation", { p_subscriber_id: id });

export const setExclusion = (subscriberId: string, month: string, excluded: boolean) =>
  rpc("automation_set_exclusion", { p_subscriber_id: subscriberId, p_month: month, p_excluded: excluded });
export const setPause = (month: string, paused: boolean) => rpc("automation_set_pause", { p_month: month, p_paused: paused });
export const continueCutoff = (month: string) => rpc("automation_continue", { p_month: month });
export const setCutoffDay = (day: number) => rpc("set_cutoff_day", { p_day: day });
export const setNoAutoDisconnect = (subscriberId: string, value: boolean) =>
  rpc("set_no_auto_disconnect", { p_subscriber_id: subscriberId, p_value: value });
