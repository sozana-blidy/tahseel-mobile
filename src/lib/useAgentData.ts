import { useCallback, useEffect, useRef, useState } from "react";
import { readCache, writeCache } from "./cache";
import { classifyError } from "./errors";
import { supabase } from "./supabase";
import { normalizeRow, toNum, type SubscriberRow } from "./types";

export interface AgentCash {
  collected: number;
  delivered: number;
  deductions: number;
  holding: number;
}

interface Snapshot {
  months: string[];
  rows: SubscriberRow[];
  cash: AgentCash;
}

const EMPTY_CASH: AgentCash = { collected: 0, delivered: 0, deductions: 0, holding: 0 };

/**
 * Everything the agent screen needs for one month. Falls back to the last cached
 * copy when offline. Refetches when any payment in the agent's areas changes
 * (Supabase Realtime respects the same RLS, so only his areas arrive).
 */
export function useAgentData(userId: string | undefined) {
  const [month, setMonth] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const monthRef = useRef<string | null>(null);
  monthRef.current = month;

  const load = useCallback(
    async (wanted: string | null) => {
      if (!userId) return;
      setRefreshing(true);
      try {
        const m = await supabase.from("billing_months").select("month").order("month", { ascending: false });
        if (m.error) throw m.error;
        const months = (m.data ?? []).map((x) => x.month as string);
        const target = wanted && months.includes(wanted) ? wanted : (months[0] ?? null);
        if (!target) {
          setSnap({ months, rows: [], cash: EMPTY_CASH });
          setMonth(null);
        } else {
          const [rows, cash] = await Promise.all([
            supabase.rpc("area_subscribers", { p_month: target }),
            supabase.rpc("agent_cash", { p_month: target }),
          ]);
          if (rows.error) throw rows.error;
          if (cash.error) throw cash.error;
          const c = (cash.data ?? []).reduce(
            (a: AgentCash, r: Record<string, unknown>) => ({
              collected: a.collected + toNum(r.collected),
              delivered: a.delivered + toNum(r.delivered),
              deductions: a.deductions + toNum(r.deductions),
              holding: a.holding + toNum(r.holding),
            }),
            EMPTY_CASH,
          );
          const next: Snapshot = { months, rows: (rows.data ?? []).map(normalizeRow), cash: c };
          setSnap(next);
          setMonth(target);
          await writeCache(`agent:${userId}:${target}`, next);
          await writeCache(`agent:${userId}:last`, target);
        }
        setUpdatedAt(new Date().toISOString());
        setOffline(false);
        setError(null);
      } catch (e) {
        const err = classifyError(e);
        const lastMonth = wanted ?? (await readCache<string>(`agent:${userId}:last`))?.data ?? null;
        const cached = lastMonth ? await readCache<Snapshot>(`agent:${userId}:${lastMonth}`) : null;
        if (cached) {
          setSnap(cached.data);
          setMonth(lastMonth);
          setUpdatedAt(cached.at);
        }
        setOffline(err.retry);
        setError(err.message);
      } finally {
        setRefreshing(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`agent-payments-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "payments" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => load(monthRef.current), 800);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [userId, load]);

  // Stable identities: screens pass these to effects/children.
  const refresh = useCallback(() => load(monthRef.current), [load]);
  const selectMonth = useCallback((m: string) => load(m), [load]);

  return {
    month,
    months: snap?.months ?? [],
    rows: snap?.rows ?? null,
    cash: snap?.cash ?? EMPTY_CASH,
    updatedAt,
    offline,
    error,
    refreshing,
    refresh,
    selectMonth,
  };
}
