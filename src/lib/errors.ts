/** Turns Supabase/network errors into an Arabic message and a retry decision. */
export interface AppError {
  message: string;
  /** true = temporary (network/server) → keep and retry later. false = final answer from the server. */
  retry: boolean;
}

type ErrLike = { code?: string; message?: string; status?: number; name?: string } | null | undefined;

const FINAL_CODES = new Set(["P0001", "42501", "22P02", "42883", "PGRST202", "23514"]);
export const NETWORK_MESSAGE = "لا يوجد اتصال بالإنترنت أو الخادم لا يستجيب";

export function classifyError(e: unknown): AppError {
  const err = e as ErrLike;
  const code = err?.code ?? "";
  const msg = err?.message ?? String(e ?? "");
  if (code === "P0001") return { message: msg, retry: false }; // our Arabic business errors
  if (FINAL_CODES.has(code)) return { message: "غير مسموح بهذه العملية", retry: false };
  if (/invalid login credentials/i.test(msg)) return { message: "اسم الدخول أو كلمة المرور غير صحيحة", retry: false };
  if (/already registered|already exists/i.test(msg)) return { message: "هذا الحساب موجود مسبقاً", retry: false };
  if (/password should be|weak.?password/i.test(msg)) return { message: "كلمة المرور ضعيفة — 8 أحرف على الأقل", retry: false };
  if (/email.*invalid|invalid.*email/i.test(msg)) return { message: "اسم الدخول غير صالح", retry: false };
  if (/rate limit|too many/i.test(msg)) return { message: "محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة", retry: true };
  if (/abort/i.test(msg) || err?.name === "AbortError") return { message: "انتهت المهلة — الشبكة بطيئة، أعد المحاولة", retry: true };
  if (code === "57014") return { message: "العملية أخذت وقتاً طويلاً على الخادم — أعد المحاولة", retry: true };
  // A real answer from the server we don't recognise: show it instead of blaming the network.
  // 23505 can be the same payment resent concurrently — the next send resolves it, so keep retrying.
  if (code && !/network|fetch/i.test(msg)) return { message: `خطأ من الخادم (${code}): ${msg}`, retry: code === "23505" };
  return { message: NETWORK_MESSAGE, retry: true };
}
