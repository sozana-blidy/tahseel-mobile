# Edge Functions (Windows, Command Prompt)

Tahseel has one Edge Function: **`admin-users`** (`supabase/functions/admin-users/`).
It creates agent logins (username + generated password) and resets agent passwords.
It is the ONLY place that uses the service key — Supabase injects it into the function;
nothing has to be copied anywhere, and the app never sees it.

Every call: the caller's token is verified by Supabase Auth → the caller must be an active
manager (`admin_is_manager`) → the function acts. Passwords are returned once and never stored.
Login domains are allow-listed in `supabase/functions/admin-users/logic.ts`
(`ALLOWED_EMAIL_DOMAINS`, default `agents.tahseel.app`). If you change
`EXPO_PUBLIC_AGENT_EMAIL_DOMAIN` in `.env`, add the same domain there and redeploy.

## Before the first deploy
1. Migration `20261116000007_accounts_guest_deferral_late.sql` must already be applied
   (it creates `admin_register_agent`, `admin_agent_for_reset`, `admin_is_manager`).
2. Your project ref: Supabase dashboard → Project Settings → General → **Reference ID**
   (also the first part of the project URL `https://<ref>.supabase.co`).

## Deploy (Command Prompt)
```
cd /d D:\dev\tahseel-mobile
pnpm dlx supabase@latest login
pnpm dlx supabase@latest link --project-ref <ref>
pnpm dlx supabase@latest functions deploy admin-users --project-ref <ref> --use-api
```
- `login` opens the browser once. `link` may ask for the database password — it is only used by
  the CLI, never stored in the repo.
- `--use-api` bundles on Supabase's side, so Docker is not needed.
- No `secrets set` step: `SUPABASE_URL` and the service key are provided automatically.
- Redeploy the same way after any change in `supabase/functions/admin-users/`.

## Which service key does the project use?
Dashboard → Project Settings → **API Keys**:
- Tab **"Legacy API keys"** shows `anon` / `service_role` (long `eyJ…` JWTs) → the function reads
  `SUPABASE_SERVICE_ROLE_KEY`.
- Tab **"API Keys"** shows `sb_publishable_…` / `sb_secret_…` → the function reads
  `SUPABASE_SECRET_KEYS` (its `default` key).
The function supports both; nothing to configure. If it answers «الخادم غير مُعدّ», neither was
injected — check Edge Functions → admin-users → Logs.

If the app gets **401 "Invalid JWT"** although the manager is signed in (projects that moved to the
new JWT signing keys), redeploy without the gateway check — the function still verifies every token
itself with `auth.getUser()`:
```
pnpm dlx supabase@latest functions deploy admin-users --project-ref <ref> --use-api --no-verify-jwt
```

## Guest mode: enable anonymous sign-ins
1. Dashboard → Authentication → **Sign In / Providers** → turn on **"Allow anonymous sign-ins"** → Save.
2. Dashboard → Authentication → **Rate Limits** → "Anonymous users" (sign-ins per hour per IP):
   keep it low, e.g. **10**.
3. **CAPTCHA (Authentication → Attack Protection): leave OFF.** It applies to ALL sign-ins
   (manager and agents too) and the app does not send CAPTCHA tokens — turning it on would block
   every login. Guests are protected instead by the guest code (checked in the database, 5 wrong
   tries per 15 minutes) and the rate limit above.
4. Guest users pile up in Authentication → Users ("Anonymous"). Deleting old ones is safe at any time.

## Smoke test after deploy
Manager app → المعتمدون → «إنشاء حسابات» → one test agent on a free area → the Excel file opens in
the share sheet → sign in on another phone with that username/password → «إعادة تعيين كلمة المرور»
→ the old password stops working. Then disable the test agent.
Logs: Dashboard → Edge Functions → admin-users → Logs.
