# Supabase setup (one time)

## 1. Create the project
- supabase.com → New project. Region: **Frankfurt (eu-central-1)** — closest to Syria.
- Save the database password in your password manager (never in chat or git).

## 2. Apply the migrations
SQL Editor → New query → paste and run each file **in order**:
1. `supabase/migrations/20261115000001_schema.sql`
2. `supabase/migrations/20261115000002_security.sql`
3. `supabase/migrations/20261115000003_functions.sql`

Do NOT run `supabase/tests/supabase_emulation.sql` — Supabase already has `auth`.

## 3. Auth settings
Authentication → Providers → Email:
- Enable Email provider: ON
- **Confirm email: OFF** (agents sign up with `<username>@agents.tahseel.app`, which has no real inbox)

Keep "Allow new users to sign up" ON — agents create their own login with an invite code. This is safe: a signed-up user without a claimed invite has no profile and sees nothing.

## 4. Manager account
1. Authentication → Users → Add user → email + password (Auto confirm). Use the manager's real email.
2. SQL Editor:
   ```sql
   select public.make_manager('manager-email@example.com', 'المدير', 'manager');
   ```

## 5. Realtime
Database → Publications → `supabase_realtime`: confirm `notifications` and `payments` are listed (the security migration adds them).

## 6. Keys for the app (batch M2)
Project Settings → API:
- `EXPO_PUBLIC_SUPABASE_URL` = Project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` = anon / publishable key (safe in the app — RLS protects data)
- The **service_role** key never goes in the app, chat, or git.

## 7. Reachability check from Syria (do before M2 is finished)
On each agent's phone, on mobile data (Syriatel / MTN) and with VPN OFF, open in the browser:
`https://<project-ref>.supabase.co/rest/v1/` → a JSON error about a missing API key = reachable. A timeout or block page = not reachable → tell me before we continue.
