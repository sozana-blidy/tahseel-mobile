import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { emitDataChanged, onDataChanged } from "./bus";
import { currentMonth } from "./months";
import { refreshTonight } from "./reminders";
import { q } from "./rpc";
import { supabase } from "./supabase";

interface ManagerState {
  month: string;
  setMonth(m: string): void;
  months: string[];
  reloadMonths(): Promise<void>;
  /** The calendar month has no invoices yet. */
  currentMonthMissing: boolean;
}

const Ctx = createContext<ManagerState | null>(null);

/**
 * Month selection shared by the manager screens. Payments from agents refresh open
 * screens live (Realtime) — without a notification per payment: the manager gets
 * one daily summary per area instead.
 */
export function ManagerProvider({ children }: { children: ReactNode }) {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>(currentMonth());
  const picked = useRef(false);

  const reloadMonths = useCallback(async () => {
    try {
      const rows = await q<{ month: string }[]>(supabase.from("billing_months").select("month").order("month", { ascending: false }));
      const list = rows.map((r) => r.month);
      setMonths(list);
      if (!picked.current && list[0]) setMonth(list[0]);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    reloadMonths();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel("manager-payments")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "payments" }, () => {
        clearTimeout(timer);
        timer = setTimeout(emitDataChanged, 1500);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [reloadMonths]);

  // Tonight's 22:00 notification carries today's counts: re-schedule it whenever manager data
  // refreshes (writes, live agent payments) and when the app comes back to the foreground.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refreshTonight(), 5000);
    };
    const offData = onDataChanged(soon);
    const appState = AppState.addEventListener("change", (s) => s === "active" && soon());
    return () => {
      clearTimeout(timer);
      offData();
      appState.remove();
    };
  }, []);

  const setMonthPicked = useCallback((m: string) => {
    picked.current = true;
    setMonth(m);
  }, []);

  const value = useMemo<ManagerState>(
    () => ({ month, setMonth: setMonthPicked, months, reloadMonths, currentMonthMissing: !months.includes(currentMonth()) }),
    [month, setMonthPicked, months, reloadMonths],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useManager(): ManagerState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useManager outside ManagerProvider");
  return v;
}
