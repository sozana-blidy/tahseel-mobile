# Tahseel Mobile (تحصيل)

Collection & billing app for a satellite/wireless ISP. One Expo (Android) app with two interfaces:
**Manager** (all areas, edits, payments per agent, deliveries, Excel) and **Agent** (own areas only, "تم الدفع").

Backend: Supabase (Postgres + RLS + SECURITY DEFINER functions + Realtime).

## Layout
```
supabase/migrations/   schema, security (RLS), functions — apply in order
supabase/tests/        local Postgres harness + rule tests (not deployed)
docs/                  SUPABASE-SETUP.md, BUILD-APK.md, GOTCHAS.md
supabase/scripts/      reset_test_data.sql (clears test data before the real import)
                       reset_payments.sql (⚠️ deletes all payments/exemptions/agent tx; keeps invoices)
plugins/               withReleaseSigning.js (release key from Gradle properties)
src/app/               screens (Expo Router): login, join, inactive, agent/,
                       manager/(tabs) [areas, agents, notifications], manager/area, subscriber, agent, invite
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
pnpm test        :: app logic (search, money, offline outbox, xlsx, report)
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
