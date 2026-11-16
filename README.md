# Tahseel Mobile (تحصيل)

Collection & billing app for a satellite/wireless ISP. One Expo (Android) app with two interfaces:
**Manager** (all areas, edits, payments per agent, deliveries, Excel) and **Agent** (own areas only, "تم الدفع").

Backend: Supabase (Postgres + RLS + SECURITY DEFINER functions + Realtime).

## Layout
```
supabase/migrations/   schema, security (RLS), functions — apply in order
supabase/tests/        local Postgres harness + rule tests (not deployed)
docs/                  SUPABASE-SETUP.md, BUILD-APK.md, EDGE-FUNCTIONS.md, ROUTER-SETUP.md, GOTCHAS.md
supabase/functions/    admin-users (Edge Function: agent accounts / password reset)
supabase/scripts/      reset_test_data.sql (clears test data before the real import)
                       reset_payments.sql (⚠️ deletes all payments/exemptions/agent tx; keeps invoices)
routeros/              tahseel-sync-dryrun.rsc (READ-ONLY MikroTik script, placeholders only) + scan.ts/scan.test.ts
plugins/               withReleaseSigning.js (release key from Gradle properties)
src/app/               screens (Expo Router): login, join, inactive, agent/,
                       manager/(tabs) [areas, agents, notifications], manager/area, subscriber, agent, invite,
                       manager/automation [log «السجل», cutoff «قائمة الفصل», settings]
src/lib/               supabase client, auth, offline payment outbox, search, money
src/ui/                theme + small UI kit (Tajawal, RTL)
```

## Run the app on a phone (Windows, Command Prompt)
```
copy .env.example .env
rem edit .env: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
pnpm install
pnpm start
```
Scan the QR code with **Expo Go** (Play Store, SDK 58) on the same Wi-Fi.
If the phone is on another network: `pnpm start --tunnel`.
First launch in Expo Go: close and reopen the app once so the Arabic (RTL) layout applies.

## First real use
1. Clear any test data: run `supabase/scripts/reset_test_data.sql` in the SQL Editor.
2. Manager app → المزيد → استيراد من Excel → pick the company workbook → check the totals → استيراد.
3. المناطق → إصدار (issue this month's invoices).
4. المعتمدون → + دعوة معتمد for each agent → share the code.

## Build the APK
See `docs/BUILD-APK.md`.

## Checks
```
pnpm typecheck
pnpm test        :: app logic (search, money, offline outbox, xlsx, report, automation)
                 :: + routeros/scan.test.ts: FAILS if the router script could change anything
set TAHSEEL_REAL_XLSX=C:\path\to\company.xlsx   :: optional: also test against the real file
pnpm test:db     :: database rules (needs local PostgreSQL)
```

## Database tests (local PostgreSQL 16+)
```
set TAHSEEL_PG=postgres://postgres@localhost:5432/postgres
pnpm install
pnpm test:db
```
Each test clones a fresh database from a migrated template. Supabase's `auth` schema is emulated by `supabase/tests/supabase_emulation.sql` (never apply that file to Supabase).

## Core rules (enforced in the database, not the app)
- Agents work offline: a confirmed «تم الدفع» is saved on the phone and resent until the server answers (server de-duplicates by client key).
- Tables are read-only for app users; every write goes through a function that checks the role.
- Agents see only their assigned areas. "تم الدفع" records the full remaining invoice; agents cannot undo.
- Corrections are reversal rows (append-only), manager only, with a reason.
- Price = Mbps × 50,000 SYP (setting `price_per_mbps`). SPF = exempt.

## Router automation (MikroTik) — DRY-RUN only
Two routers (1100 = RB1100Dx4, 2116 = CCR2116) run `routeros/tahseel-sync-dryrun.rsc` every 5 minutes.
The script only **reads** PPP secrets and reports to `router_sync`; the server logs what it *would* do. Nothing on a
router changes in this version. Setup, HTTPS check, manual test run and removal: `docs/ROUTER-SETUP.md`.

- Mode `automation_mode = dry_run` (settings). Scope: the 9 areas in `automation_area_ids`; SPF, «فك», «لا يُفصل»,
  no username, and this month's exclusions are never candidates. Matching is by exact username (case-insensitive in DB).
- Cutoff = 00:00 Damascus on `cutoff_day` (default 25). Warning on the manager phone at 20:00 the day before.
- Safety: snapshot at the first run after the cutoff; sanity hold if N > 50% of in-scope or > 2× last month;
  50 per run per router (oldest unpaid first); hold if > 30 NEW ones in one day; «متابعة الفصل» to continue.
- Re-enable only accounts Tahseel itself disabled, on the next run after payment / exemption / deferral / exclusion.
- App: «السجل» (top left of المناطق), «قائمة الفصل», settings (cutoff day editable in dry-run only), «لا يُفصل» on the
  subscriber page. Router tokens: `select public.router_issue_token('1100');` in the SQL Editor (hash stored only).
- Router exports are personal data: keep them outside the repo; tests use synthetic usernames only.
