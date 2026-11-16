/**
 * Pure parts of the admin-users Edge Function (no Deno APIs) — unit-tested with vitest.
 */

/** Only these login domains may be used. A modified client cannot create accounts elsewhere. */
export const ALLOWED_EMAIL_DOMAINS = ["agents.tahseel.app"];
export const MAX_AGENTS_PER_REQUEST = 20;

/** No look-alikes: 0 O 1 l I are left out. */
export const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Uniform random password (rejection sampling), at least one letter and one digit. */
export function generatePassword(length = 10, random: RandomBytes = cryptoBytes): string {
  const n = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n); // bytes >= limit would bias the result
  for (;;) {
    let out = "";
    while (out.length < length) {
      for (const b of random(length * 2)) {
        if (b < limit && out.length < length) out += PASSWORD_ALPHABET[b % n];
      }
    }
    if (/[0-9]/.test(out) && /[a-zA-Z]/.test(out)) return out;
  }
}

export interface AgentInput {
  full_name: string;
  username: string;
  area_ids: string[];
  comp_type: "none" | "monthly_salary" | "per_invoice";
  comp_amount: number;
  phone: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USERNAME = /^[a-z0-9_.]{3,30}$/;

export function checkDomain(domain: unknown): Parsed<string> {
  const d = typeof domain === "string" ? domain.trim().toLowerCase() : "";
  return ALLOWED_EMAIL_DOMAINS.includes(d) ? { ok: true, value: d } : { ok: false, error: "نطاق حسابات المعتمدين غير مسموح" };
}

export function parseAgent(x: unknown): Parsed<AgentInput> {
  const o = (x ?? {}) as Record<string, unknown>;
  const full_name = typeof o.full_name === "string" ? o.full_name.trim() : "";
  const username = typeof o.username === "string" ? o.username.trim().toLowerCase() : "";
  const area_ids = Array.isArray(o.area_ids) ? o.area_ids : [];
  const comp_type = o.comp_type ?? "none";
  const comp_amount = o.comp_amount ?? 0;
  const phone = typeof o.phone === "string" && o.phone.trim() ? o.phone.trim() : null;
  if (!full_name || full_name.length > 80) return { ok: false, error: "اسم المعتمد مطلوب" };
  if (!USERNAME.test(username)) return { ok: false, error: `اسم الدخول «${username}»: أحرف إنجليزية صغيرة أو أرقام أو . _ (3 أحرف على الأقل)` };
  if (area_ids.length === 0 || !area_ids.every((a) => typeof a === "string" && UUID.test(a))) return { ok: false, error: "اختر منطقة واحدة على الأقل" };
  if (comp_type !== "none" && comp_type !== "monthly_salary" && comp_type !== "per_invoice") return { ok: false, error: "تعويض غير صحيح" };
  if (typeof comp_amount !== "number" || !Number.isSafeInteger(comp_amount) || comp_amount < 0) return { ok: false, error: "تعويض غير صحيح" };
  if (phone && phone.length > 30) return { ok: false, error: "رقم الهاتف غير صحيح" };
  return { ok: true, value: { full_name, username, area_ids: [...new Set(area_ids as string[])], comp_type, comp_amount, phone } };
}

export type Request =
  | { action: "create"; domain: string; agents: unknown[] }
  | { action: "reset"; agent_id: string };

export function parseRequest(body: unknown): Parsed<Request> {
  const o = (body ?? {}) as Record<string, unknown>;
  if (o.action === "create") {
    const d = checkDomain(o.email_domain);
    if (!d.ok) return d;
    if (!Array.isArray(o.agents) || o.agents.length === 0) return { ok: false, error: "لا يوجد معتمدون" };
    if (o.agents.length > MAX_AGENTS_PER_REQUEST) return { ok: false, error: `${MAX_AGENTS_PER_REQUEST} معتمداً كحد أقصى في المرة الواحدة` };
    const names = o.agents.map((a) => String((a as Record<string, unknown>)?.username ?? "").trim().toLowerCase());
    if (new Set(names).size !== names.length) return { ok: false, error: "اسم دخول مكرر في القائمة" };
    return { ok: true, value: { action: "create", domain: d.value, agents: o.agents } };
  }
  if (o.action === "reset") {
    if (typeof o.agent_id !== "string" || !UUID.test(o.agent_id)) return { ok: false, error: "طلب غير صالح" };
    return { ok: true, value: { action: "reset", agent_id: o.agent_id } };
  }
  return { ok: false, error: "طلب غير صالح" };
}
