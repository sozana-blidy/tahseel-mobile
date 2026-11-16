# Router setup — Tahseel sync, DRY-RUN (read-only)

This batch changes **nothing** on either router. The script only reads PPP secrets and reports to Tahseel;
Tahseel logs what it *would* do («السجل» in the app). `routeros/scan.test.ts` fails `pnpm test` if the script
ever contains a command that could change something.

| Server | Router | `PASTE_ROUTER_ID` |
|---|---|---|
| 1100 | RB1100Dx4 | `1100` |
| 2116 | CCR2116 | `2116` |

You do everything below by hand in **Winbox → New Terminal** (or Winbox menus). Nothing is installed automatically.

---

## 0. Before you start

1. Migration `20261116000008_router_automation_dryrun.sql` is applied (Supabase → SQL Editor).
2. Issue one token per router in the SQL Editor — each returns the token **once**; only its hash is stored:
   ```sql
   select public.router_issue_token('1100');
   select public.router_issue_token('2116');
   ```
   Keep each token only long enough to paste it into that router's script. Never put it in chat, git or a file in the repo.
   Running it again issues a new token and the old one stops working at once.
3. You need two public values from the app's environment: the **project ref** (the `xxxx` in
   `EXPO_PUBLIC_SUPABASE_URL` = `https://xxxx.supabase.co`) and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
   Both are public, but the token is not — treat the filled router script as private.

## 1. Version and clock (on each router)

```
/system resource print
/system clock print
```
- `version` must be **7.24** or newer (the script uses `:serialize` / `:deserialize`).
- The date and time must be right — certificate checks fail on a wrong clock. If it's wrong, fix NTP first
  (`/system ntp client print`). Disconnect timing does **not** use the router clock; the server decides by Damascus time.

## 2. HTTPS — certificate is always verified

The script calls `/tool fetch … check-certificate=yes`. It **never** uses `check-certificate=no` (the scanner forbids it).

### Preferred: RouterOS built-in trust store
MikroTik docs (Certificates → *Built-in trust store authorities*): RouterOS ships a list of root CAs, and
`/certificate settings builtin-trust-store` decides which services may use it. The default (`default`) includes **fetch**,
so no CA import is needed.

1. Check the setting:
   ```
   /certificate settings print
   ```
   `builtin-trust-store` should be `default` (or a list that contains `fetch`). If it is `untrusted` or a list without
   `fetch`, use the fallback below instead of changing it, unless you decide to change it yourself.
   The list of built-in roots is in Winbox → **System → Certificates → Built In CA**.
2. Test TLS only (replace `xxxx` with the project ref):
   ```
   /tool fetch url="https://xxxx.supabase.co/rest/v1/" check-certificate=yes output=none
   ```
   - An HTTP error such as **401** = TLS **worked** (the request simply had no key). ✅
   - An error that mentions **SSL / certificate / trust** = the chain is not trusted → fallback.

### Fallback: import the exact CA chain
1. On the PC, open `https://xxxx.supabase.co/rest/v1/` in a browser → padlock → certificate → *Certification path*.
   Export the **root** CA (and the intermediate) as *Base-64 (.cer/.pem)*. Note the root's SHA-256 fingerprint.
2. Winbox → **Files** → drag the `.cer` file(s) in. Then:
   ```
   /certificate import file-name=ROOT.cer passphrase=""
   /certificate print detail where name~"ROOT"
   ```
   The fingerprint must equal the one the browser showed. Repeat the TLS test above.
3. Downside: if Supabase changes CA you must re-import. The built-in store updates with RouterOS.

## 3. Install the script (each router)

1. Copy [routeros/tahseel-sync-dryrun.rsc](../routeros/tahseel-sync-dryrun.rsc) into Notepad (not into the repo copy).
   Replace the four values:
   - `PASTE_PROJECT_REF` → `xxxx`
   - `PASTE_ANON_KEY` → the anon key
   - `PASTE_ROUTER_ID` → `1100` or `2116` (must match the router — see the table above)
   - `PASTE_ROUTER_TOKEN` → that router's token
2. Winbox → **System → Scripts → +**
   - Name: `tahseel-sync`
   - Policy: tick **read** and **test** only
   - Source: paste the filled script → **OK**.
3. Close Notepad without saving.

> Why only *read* + *test*: with no *write* policy, RouterOS itself refuses any change command — a second lock on top of
> the script content. If the manual run below logs `not enough permissions`, tick **write** as well (MikroTik does not
> document exactly which policies `/tool fetch` needs; forum reports differ). The script content stays read-only either way.

## 4. Manual test run — THIS is the real test

The DB tests prove the server rules; only this run proves RouterOS syntax, HTTPS and the token on the real router.

1. Count disabled secrets **before**:
   ```
   :put [:len [/ppp secret find where disabled]]
   ```
2. Run once:
   ```
   /system script run tahseel-sync
   ```
3. Read the log:
   ```
   /log print where message~"tahseel"
   ```
   Expected:
   - Before the cutoff: `tahseel 1100: mode=dry_run gate=before_cutoff check=0`
   - After the cutoff: `… check=N`, then `… DRY-RUN gate= batch=1 would=K - nothing was changed` and one
     `would disable <user> (unpaid)` line per account.
4. Count disabled secrets **after** (step 1 again) — the number must be identical.
5. In the app: «السجل» shows the same lines; Settings shows *last contact* for this server.

To test the after-cutoff path before the 25th: in the app Settings (dry-run only) set the cutoff day to today, run again,
then set it back. Changing it resets this month's test cycle and also moves the late-payment notifications.
Expect a **sanity hold** on the first real run if more than half of in-scope subscribers are unpaid — that is the guard
working; «متابعة الفصل» in the app lets it continue.

### If it fails
| Log / error | Meaning | Fix |
|---|---|---|
| `not configured` | a `PASTE_` value is left | fill all four |
| `call A failed` | network, TLS, key or token | run the TLS test (§2); re-check key and token |
| HTTP 401 in fetch | wrong/missing anon key | re-paste `EXPO_PUBLIC_SUPABASE_ANON_KEY` value |
| HTTP 400 with `unauthorized` | wrong token or router id | re-issue the token for this router id |
| `not enough permissions` | script policy | add **write** (§3) |
| `call B failed` | network, or report over 60 KB | check the log line before it; tell Claude the count |

## 5. Schedule every 10 minutes (after the manual run passes)

```
/system scheduler add name=tahseel-sync interval=10m start-time=startup policy=read,test on-event="/system script run tahseel-sync"
```
(use `policy=read,write,test` if you had to add write in §3). Check: `/system scheduler print where name="tahseel-sync"`.
A payment is reflected within one run (≤ 10 min).

## 6. Pause or remove

Pause / resume:
```
/system scheduler disable [find name="tahseel-sync"]
/system scheduler enable [find name="tahseel-sync"]
```
Remove completely:
```
/system scheduler remove [find name="tahseel-sync"]
/system script remove [find name="tahseel-sync"]
```
Also block the router on the server side (SQL Editor): `update public.routers set enabled = false where id = '1100';`
— any call with its token is then refused. Issuing a new token (§0) also revokes the old one.

## What this script can and cannot do

- Reads: `/ppp secret find`, `/ppp secret get`, `/system identity get`, `/tool fetch` (`output=user`, certificate verified).
- Writes on the router: **nothing**. No secret is added, removed or edited; no session is dropped; no file is written.
- If the server ever returns `actions`, the script logs a warning and ignores them.
- Only usernames the server names are looked at; every other secret (99x, vpn01, l2tp …) is never read or reported.
