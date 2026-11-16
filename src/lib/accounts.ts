/**
 * Agent accounts through the admin-users Edge Function (the service key lives only there).
 * Passwords come back ONCE and go straight into an Excel file the manager shares/saves.
 */
import { AGENT_EMAIL_DOMAIN } from "./env";
import { supabase } from "./supabase";
import type { XSheet } from "./xlsx";

export interface NewAgent {
  full_name: string;
  username: string;
  area_ids: string[];
  comp_type: "none" | "monthly_salary" | "per_invoice";
  comp_amount: number;
  phone: string | null;
}

export type AccountResult =
  | { ok: true; full_name: string; username: string; areas: string; password: string }
  | { ok: false; full_name: string; username?: string; error: string };

export const PASSWORD_WARNING = "احفظ الملف — كلمات المرور لا تُعرض مرة أخرى";

async function call(body: Record<string, unknown>): Promise<AccountResult[]> {
  const { data, error } = await supabase.functions.invoke<{ results: AccountResult[] }>("admin-users", { body });
  if (error) {
    // FunctionsHttpError carries our Arabic { error } body in its Response
    const ctx = (error as { context?: Response }).context;
    let msg: string | undefined;
    try {
      msg = ctx ? ((await ctx.json()) as { error?: string }).error : undefined;
    } catch {
      /* not JSON */
    }
    throw new Error(msg ?? (/fetch|network/i.test(error.message) ? "لا يوجد اتصال بالإنترنت" : "تعذر الاتصال بخدمة الحسابات"));
  }
  return data?.results ?? [];
}

export const createAgentAccounts = (agents: NewAgent[]) => call({ action: "create", email_domain: AGENT_EMAIL_DOMAIN, agents });
export const resetAgentPassword = (agentId: string) => call({ action: "reset", agent_id: agentId });

/** الاسم، المناطق، اسم الدخول، كلمة المرور — successful rows only. */
export function credentialsSheet(results: AccountResult[]): XSheet {
  const ok = results.filter((r): r is Extract<AccountResult, { ok: true }> => r.ok);
  return {
    name: "حسابات المعتمدين",
    rows: [["الاسم", "المناطق", "اسم الدخول", "كلمة المرور"], ...ok.map((r) => [r.full_name, r.areas, r.username, r.password])],
    widths: [24, 30, 18, 16],
  };
}

export function credentialsFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `حسابات-المعتمدين-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.xlsx`;
}
