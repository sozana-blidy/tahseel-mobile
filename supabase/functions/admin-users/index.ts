// Supabase Edge Function (Deno): create agent accounts / reset agent passwords.
// The service key exists ONLY here (injected by Supabase) — never in the app.
// Every call: verify the caller's JWT → caller must be an active manager → act.
// Passwords are generated here, returned once, and never stored in our tables.
// Deploy: see docs/EDGE-FUNCTIONS.md
import { createClient } from "npm:@supabase/supabase-js@2";
import { generatePassword, parseAgent, parseRequest } from "./logic.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** Legacy projects: SUPABASE_SERVICE_ROLE_KEY. New API keys: SUPABASE_SECRET_KEYS = {"default":"sb_secret_..."}. */
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    return keys.default ?? Object.values(keys)[0] ?? "";
  } catch {
    return "";
  }
}

const dbError = (e: { message?: string } | null) => e?.message ?? "خطأ غير متوقع";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const url = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  if (!url || !key) return json(500, { error: "الخادم غير مُعدّ (مفتاح الخدمة غير متوفر)" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) who is calling? (token verified by Supabase Auth, not just decoded)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "يجب تسجيل الدخول" });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who.user || who.user.is_anonymous) return json(401, { error: "يجب تسجيل الدخول" });
  const { data: isManager, error: mErr } = await admin.rpc("admin_is_manager", { p_user: who.user.id });
  if (mErr) return json(500, { error: dbError(mErr) });
  if (!isManager) return json(403, { error: "هذه العملية للمدير فقط" });

  // 2) what is asked?
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "طلب غير صالح" });
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const r = parsed.value;

  if (r.action === "reset") {
    const { data: ag, error } = await admin.rpc("admin_agent_for_reset", { p_actor: who.user.id, p_agent_id: r.agent_id });
    if (error) return json(400, { error: dbError(error) });
    const password = generatePassword();
    const { error: upErr } = await admin.auth.admin.updateUserById(r.agent_id, { password });
    if (upErr) return json(500, { error: "تعذر تغيير كلمة المرور" });
    return json(200, { results: [{ ok: true, full_name: ag.full_name, username: ag.username, areas: ag.areas ?? "", password }] });
  }

  // create: one by one, each independent (a failure never leaves a half-made account)
  const results: unknown[] = [];
  for (const raw of r.agents) {
    const a = parseAgent(raw);
    const label = String((raw as Record<string, unknown>)?.full_name ?? "");
    if (!a.ok) {
      results.push({ ok: false, full_name: label, error: a.error });
      continue;
    }
    const v = a.value;
    const args = {
      p_actor: who.user.id, p_full_name: v.full_name, p_username: v.username, p_area_ids: v.area_ids,
      p_phone: v.phone, p_comp_type: v.comp_type, p_comp_amount: v.comp_amount,
    };
    const dry = await admin.rpc("admin_register_agent", { ...args, p_user_id: null, p_dry_run: true });
    if (dry.error) {
      results.push({ ok: false, full_name: v.full_name, username: v.username, error: dbError(dry.error) });
      continue;
    }
    const password = generatePassword();
    const created = await admin.auth.admin.createUser({
      email: `${v.username}@${r.domain}`, password, email_confirm: true, user_metadata: { full_name: v.full_name },
    });
    if (created.error || !created.data.user) {
      const taken = /already|exists|registered/i.test(created.error?.message ?? "");
      results.push({ ok: false, full_name: v.full_name, username: v.username, error: taken ? `اسم الدخول ${v.username} مستخدم مسبقاً` : "تعذر إنشاء حساب الدخول" });
      continue;
    }
    const uid = created.data.user.id;
    const reg = await admin.rpc("admin_register_agent", { ...args, p_user_id: uid, p_dry_run: false });
    if (reg.error) {
      await admin.auth.admin.deleteUser(uid); // undo: no login without a profile
      results.push({ ok: false, full_name: v.full_name, username: v.username, error: dbError(reg.error) });
      continue;
    }
    results.push({ ok: true, full_name: reg.data.full_name, username: v.username, areas: reg.data.areas ?? "", password });
  }
  return json(200, { results });
});
