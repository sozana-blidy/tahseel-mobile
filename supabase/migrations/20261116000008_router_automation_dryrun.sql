-- Tahseel 0008 — MikroTik automation, DRY-RUN.
--
-- Two calls per router run (every 5 minutes, RouterOS script routeros/tahseel-sync-dryrun.rsc):
--   A  router_sync(id, token, {"phase":"candidates"})           → {"check": [usernames]}
--   B  router_sync(id, token, {"phase":"report","obs":[{u,e,d}]}) → final verdicts, logged once per day
-- The router only READS each name (exists? disabled?). Nothing on a router is ever changed here.
-- In dry_run, `actions` in the answer is ALWAYS empty; what live mode would do is in `would`.
--
-- Rules (Asia/Damascus), current calendar month M:
--   disconnect  : from 00:00 of cutoff_day; M's own invoice open (not paid / exempted / deferred) OR the invoice
--                 deferred INTO M still open («لم يدفع الفاتورتين (شهر مؤجّل)»); subscriber active (not «فك»),
--                 not SPF, not no_auto_disconnect, has a username, area in automation_area_ids,
--                 not excluded for M; cycle not paused / held.
--   re-enable   : only rows WE disabled (router_accounts), once that invoice is paid / exempted / deferred,
--                 or the subscriber is excluded / marked «لا يُفصل». Next poll (≤ 10 minutes).
--   safety      : snapshot at the first run after cutoff; sanity hold (N > 50% of in-scope, or N > 2 × last
--                 cycle when last cycle > 0); 50 per run per router, oldest unpaid first; more than
--                 daily_new_disconnect_limit NEW (not in the snapshot) in one day → hold. «متابعة الفصل» resumes.

/* ======================= 1. settings ======================= */

insert into public.settings (key, value) values
  ('automation_mode', 'dry_run'),            -- off | dry_run | live (anything else = off)
  ('max_disconnects_per_run', '50'),
  ('daily_new_disconnect_limit', '30')
on conflict (key) do nothing;

-- The 9 in-scope areas, matched by name or alias. 5009 areas (الفاخورة، الخرنوبة، الرويمية) are NOT listed.
insert into public.settings (key, value)
select 'automation_area_ids', coalesce(string_agg(a.id::text, ',' order by a.name), '')
from public.areas a
where exists (select 1 from unnest(array['الهنادي', 'فديو', 'القطرية', 'مزار القطرية', 'ضهر السرياني', 'مرديدو', 'الخلالة', 'الشير', 'روضو']) n
              where n = a.name or n = any (a.aliases))
on conflict (key) do nothing;

create or replace function public._automation_mode() returns text
language sql stable security definer set search_path = public as $$
  select case when v in ('off', 'dry_run', 'live') then v else 'off' end
  from (select (select value from public.settings where key = 'automation_mode') as v) s
$$;

create or replace function public._setting_int(p_key text, p_default int, p_min int, p_max int) returns int
language sql stable security definer set search_path = public as $$
  select case when v ~ '^\d{1,6}$' then greatest(p_min, least(p_max, v::int)) else p_default end
  from (select (select value from public.settings where key = p_key) as v) s
$$;

-- Malformed setting → no area is in scope (fail closed).
create or replace function public._automation_areas() returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v text := (select value from public.settings where key = 'automation_area_ids');
begin
  if v is null or btrim(v) = '' then return '{}'; end if;
  return (select coalesce(array_agg(btrim(x)::uuid), '{}') from unnest(string_to_array(v, ',')) x where btrim(x) <> '');
exception when others then
  return '{}';
end $$;

create or replace function public._dam_month(p_now timestamptz) returns text
language sql stable as $$ select to_char(p_now at time zone 'Asia/Damascus', 'YYYY-MM') $$;

create or replace function public._dam_day(p_now timestamptz) returns date
language sql stable as $$ select (p_now at time zone 'Asia/Damascus')::date $$;

create or replace function public._dam_hm(p_at timestamptz) returns text
language sql stable as $$ select to_char(p_at at time zone 'Asia/Damascus', 'HH24:MI') $$;

-- 00:00 Asia/Damascus on cutoff_day of p_month.
create or replace function public._cutoff_at(p_month text) returns timestamptz
language sql stable security definer set search_path = public as $$
  select to_date(p_month || '-' || lpad(public._cutoff_day()::text, 2, '0'), 'YYYY-MM-DD')::timestamp at time zone 'Asia/Damascus'
$$;

/* ======================= 2. subscribers: «لا يُفصل» ======================= */

alter table public.subscribers add column no_auto_disconnect boolean not null default false;

create or replace function public.set_no_auto_disconnect(p_subscriber_id uuid, p_value boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); s public.subscribers;
begin
  update public.subscribers set no_auto_disconnect = coalesce(p_value, false), updated_at = now()
  where id = p_subscriber_id returning * into s;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  perform public._audit(me, case when s.no_auto_disconnect then 'no_auto_disconnect_on' else 'no_auto_disconnect_off' end,
    'subscriber', s.id::text,
    case when s.no_auto_disconnect then 'لا يُفصل تلقائياً: ' else 'إلغاء «لا يُفصل»: ' end || public._display_name(s.full_name, s.father_name));
end $$;

/* ======================= 3. tables ======================= */

create table public.routers (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,20}$'),
  name text not null,
  token_hash text,                        -- sha256 hex of the token; the token itself is never stored
  enabled boolean not null default true,
  last_seen_at timestamptz,
  last_report jsonb,
  created_at timestamptz not null default now()
);
insert into public.routers (id, name) values ('1100', 'RB1100Dx4'), ('2116', 'CCR2116') on conflict (id) do nothing;

-- One row per (router, username) that Tahseel disabled: state 'disabled' (live, real) or 'simulated' (dry-run).
-- 'overridden' = we disabled it, someone re-enabled it by hand → not disconnected again for that month.
create table public.router_accounts (
  router_id text not null references public.routers (id),
  username text not null,                 -- the subscriber's username exactly as stored (= router spelling)
  subscriber_id uuid references public.subscribers (id),
  state text not null check (state in ('disabled', 'simulated', 'overridden')),
  month text not null,                    -- the invoice month that caused it
  batch_no int,
  since timestamptz not null default now(),
  primary key (router_id, username)
);

-- Last thing each router saw for a name (used only to put not-found / manually-disabled names last in the queue).
create table public.router_observed (
  router_id text not null references public.routers (id),
  username text not null,
  present boolean not null,
  disabled boolean not null,
  at timestamptz not null,
  primary key (router_id, username)
);

-- One per billing month M: snapshot at the first run after cutoff, pause, hold.
create table public.automation_cycles (
  month text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  cutoff_at timestamptz,
  snapshot_at timestamptz,
  snapshot_count int,
  in_scope_count int,
  prev_count int,
  hold_reason text check (hold_reason in ('sanity', 'daily_limit')),
  hold_at timestamptz,
  hold_count int,
  waived_day date,                        -- «متابعة» after a daily-limit hold: no daily limit for the rest of that day
  continued_at timestamptz,
  continued_by uuid references public.profiles (id),
  paused boolean not null default false,
  paused_at timestamptz,
  paused_by uuid references public.profiles (id)
);

create table public.automation_snapshot (
  month text not null references public.automation_cycles (month) on delete cascade,
  subscriber_id uuid not null references public.subscribers (id),
  primary key (month, subscriber_id)
);

-- «استثناء هذا الشهر»: excluded from M's automatic disconnect only.
create table public.automation_exclusions (
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  subscriber_id uuid not null references public.subscribers (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (month, subscriber_id)
);

create table public.automation_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  router_id text not null,
  month text not null,
  phase text not null,
  mode text not null,
  dry boolean not null,
  gate text,
  n_check int not null default 0,
  n_obs int not null default 0,
  n_disable int not null default 0,
  n_enable int not null default 0,
  batch_no int
);
create index automation_runs_router_month on public.automation_runs (router_id, month, batch_no);
create index automation_runs_at on public.automation_runs (at);

-- What happened / would have happened. ONE line per (day, router, username, action, reason).
create table public.automation_log (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  day date not null,
  router_id text not null default '-',    -- '-' = not about one router
  username text not null default '',
  subscriber_id uuid references public.subscribers (id),
  month text,
  action text not null check (action in ('would_disable', 'would_enable', 'disable', 'enable', 'skipped', 'alert')),
  reason text not null,
  message text not null,
  observed_exists boolean,
  observed_disabled boolean,
  batch_no int,
  new_after_cutoff boolean not null default false,
  dry boolean not null
);
create unique index automation_log_once on public.automation_log (day, router_id, username, action, reason);
create index automation_log_day on public.automation_log (day, at);

alter table public.routers enable row level security;
alter table public.router_accounts enable row level security;
alter table public.router_observed enable row level security;
alter table public.automation_cycles enable row level security;
alter table public.automation_snapshot enable row level security;
alter table public.automation_exclusions enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_log enable row level security;
-- Only the log is readable directly, and only by the manager. Everything else goes through functions.
grant select on public.automation_log to authenticated;
create policy automation_log_read on public.automation_log for select to authenticated using (public.is_manager());

/* ======================= 4. decision rules ======================= */

-- What is still owed on one invoice (amount − payments − exemptions).
create or replace function public._inv_rem(p_invoice uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select i.amount - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)
                  - coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0)
  from public.invoices i where i.id = p_invoice
$$;

-- true while the subscriber owes month M: M's own invoice open and not deferred, or the invoice deferred INTO M open.
-- (A deferral protects only the month that was deferred.)
create or replace function public._owes(p_sub uuid, p_month text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.invoices i
                 where i.subscriber_id = p_sub and i.month = p_month and public._inv_rem(i.id) > 0
                   and not exists (select 1 from public.invoice_deferrals d where d.invoice_id = i.id and d.cancelled_at is null))
      or exists (select 1 from public.invoice_deferrals d
                 where d.subscriber_id = p_sub and d.deferred_to_month = p_month and d.cancelled_at is null
                   and public._inv_rem(d.invoice_id) > 0)
$$;

-- Everyone who WOULD be disconnected for month M (ignores time, pause and hold). excluded = «استثناء هذا الشهر».
-- Order: oldest unpaid month first, then subscriber code (stable).
create or replace function public._automation_targets(p_month text)
returns table (subscriber_id uuid, code text, username text, display_name text, area_id uuid, area_name text,
               reason text, reason_text text, oldest_month text, due bigint, excluded boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.code, btrim(s.username), public._display_name(s.full_name, s.father_name), s.area_id, a.name,
    case when car.inv is not null then 'two_bills' else 'unpaid' end,
    case when car.inv is not null then 'لم يدفع الفاتورتين (شهر مؤجّل)' else 'لم يدفع فاتورة ' || p_month end,
    least(car.month, old.month, p_month),
    coalesce(cur.rem, 0) + coalesce(car.rem, 0),
    exists (select 1 from public.automation_exclusions x where x.month = p_month and x.subscriber_id = s.id)
  from public.subscribers s
  join public.areas a on a.id = s.area_id
  left join lateral (
    select i.id as inv, public._inv_rem(i.id) as rem from public.invoices i
    where i.subscriber_id = s.id and i.month = p_month
      and not exists (select 1 from public.invoice_deferrals d where d.invoice_id = i.id and d.cancelled_at is null)
  ) cur on cur.rem > 0
  left join lateral (
    select d.invoice_id as inv, d.month, public._inv_rem(d.invoice_id) as rem from public.invoice_deferrals d
    where d.subscriber_id = s.id and d.deferred_to_month = p_month and d.cancelled_at is null
    limit 1
  ) car on car.rem > 0
  left join lateral (
    select min(i.month) as month from public.invoices i
    where i.subscriber_id = s.id and i.month <= p_month and public._inv_rem(i.id) > 0
      and not exists (select 1 from public.invoice_deferrals d where d.invoice_id = i.id and d.cancelled_at is null)
  ) old on true
  where s.status = 'active' and not s.standing_exempt and not s.no_auto_disconnect
    and nullif(btrim(s.username), '') is not null
    and s.area_id = any (public._automation_areas())
    and (cur.inv is not null or car.inv is not null)
  order by least(car.month, old.month, p_month), s.code, s.id
$$;

-- Why a row WE disabled for month p_month may be re-enabled now (null = keep it disabled).
-- Never for a «فك» subscriber or one that no longer exists.
create or replace function public._enable_reason(p_sub uuid, p_month text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when s.id is null or s.status <> 'active' then null
    when s.no_auto_disconnect then 'no_auto'
    when exists (select 1 from public.automation_exclusions x where x.month = p_month and x.subscriber_id = s.id) then 'excluded'
    when public._owes(s.id, p_month) then null
    when exists (select 1 from public.invoices i join public.invoice_deferrals d on d.invoice_id = i.id and d.cancelled_at is null
                 where i.subscriber_id = s.id and i.month = p_month) then 'deferred'
    when s.standing_exempt or exists (select 1 from public.invoices i where i.subscriber_id = s.id and i.month = p_month
                 and coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0) > 0) then 'exempt'
    else 'paid' end
  from (select p_sub as id) k left join public.subscribers s on s.id = k.id
$$;

create or replace function public._enable_text(p_sub uuid, p_reason text) returns text
language sql stable security definer set search_path = public as $$
  select case p_reason
    when 'paid' then 'بعد الدفع' || coalesce(' الساعة ' || public._dam_hm(
      (select max(p.created_at) from public.payments p where p.subscriber_id = p_sub and p.amount > 0)), '')
    when 'deferred' then 'بعد تأجيل الفاتورة'
    when 'exempt' then 'بعد الإعفاء'
    when 'excluded' then 'بعد استثنائه من الفصل هذا الشهر'
    when 'no_auto' then 'بعد تفعيل «لا يُفصل»'
    else '' end
$$;

/* ======================= 5. log, alerts, cycle ======================= */

create or replace function public._alog(p_at timestamptz, p_router text, p_username text, p_sub uuid, p_month text,
  p_action text, p_reason text, p_message text, p_exists boolean, p_disabled boolean, p_batch int, p_new boolean, p_dry boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.automation_log (at, day, router_id, username, subscriber_id, month, action, reason, message,
    observed_exists, observed_disabled, batch_no, new_after_cutoff, dry)
  values (p_at, public._dam_day(p_at), coalesce(p_router, '-'), coalesce(p_username, ''), p_sub, p_month,
    p_action, p_reason, p_message, p_exists, p_disabled, p_batch, coalesce(p_new, false), p_dry)
  on conflict (day, router_id, username, action, reason) do nothing;
  return found;
end $$;

-- Alert in the log (once per day per reason) + phone notification when p_notify (first time that day only).
create or replace function public._automation_alert(p_at timestamptz, p_router text, p_month text, p_reason text, p_message text, p_notify boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_dry boolean := public._automation_mode() <> 'live';
begin
  if public._alog(p_at, p_router, '', null, p_month, 'alert', p_reason, p_message, null, null, null, false, v_dry) and p_notify then
    insert into public.notifications (kind, title, body)
    values ('automation_hold', 'إيقاف الفصل التلقائي', p_message || case when v_dry then ' — وضع تجريبي' else '' end);
  end if;
end $$;

-- Cycle row for M, locked for this transaction (routers are serialized here). Takes the snapshot at the first
-- call at/after the cutoff and applies the sanity hold.
create or replace function public._automation_cycle(p_month text, p_now timestamptz) returns public.automation_cycles
language plpgsql security definer set search_path = public as $$
declare c public.automation_cycles; n int; v_scope int; v_prev int;
begin
  insert into public.automation_cycles (month) values (p_month) on conflict (month) do nothing;
  select * into c from public.automation_cycles where month = p_month for update;
  if c.snapshot_at is null and p_now >= public._cutoff_at(p_month)
     and exists (select 1 from public.billing_months bm where bm.month = p_month) then
    insert into public.automation_snapshot (month, subscriber_id)
    select p_month, t.subscriber_id from public._automation_targets(p_month) t where not t.excluded;
    get diagnostics n = row_count;
    select count(*) into v_scope from public.subscribers s
    where s.status = 'active' and nullif(btrim(s.username), '') is not null and s.area_id = any (public._automation_areas());
    select pc.snapshot_count into v_prev from public.automation_cycles pc
    where pc.month = public._shift_month(p_month, -1) and pc.snapshot_at is not null;
    update public.automation_cycles set cutoff_at = public._cutoff_at(p_month), snapshot_at = p_now, snapshot_count = n,
      in_scope_count = v_scope, prev_count = v_prev
    where month = p_month returning * into c;
    if (v_scope > 0 and n * 2 > v_scope) or (coalesce(v_prev, 0) > 0 and n > 2 * v_prev) then
      update public.automation_cycles set hold_reason = 'sanity', hold_at = p_now, hold_count = n
      where month = p_month returning * into c;
      perform public._automation_alert(p_now, '-', p_month, 'sanity_hold',
        'تم إيقاف الفصل التلقائي — عدد غير طبيعي (' || n || ')', true);
    end if;
  end if;
  return c;
end $$;

/* ======================= 6. router_sync ======================= */

-- Names this router must check, in order: enables, (live) verifications, then up to 500 disconnect candidates.
create or replace function public._router_candidates(p_router_id text, p_month text, p_now timestamptz, p_disables boolean, p_dry boolean)
returns table (username text, kind text, subscriber_id uuid, state text, reason text, reason_text text, ord bigint)
language sql stable security definer set search_path = public as $$
  select ra.username, 'enable', ra.subscriber_id, ra.state, er.reason, null::text, 0::bigint
  from public.router_accounts ra
  cross join lateral (select public._enable_reason(ra.subscriber_id, ra.month) as reason) er
  where ra.router_id = p_router_id and er.reason is not null
    and (ra.state = 'disabled' or (ra.state = 'simulated' and p_dry))
  union all
  select ra.username, 'verify', ra.subscriber_id, ra.state, null::text, null::text, 0::bigint
  from public.router_accounts ra
  where ra.router_id = p_router_id and ra.state = 'disabled' and not p_dry
    and public._enable_reason(ra.subscriber_id, ra.month) is null
  union all
  select * from (
    select t.username, 'disable', t.subscriber_id, null::text, t.reason, t.reason_text,
      row_number() over (order by (o.username is not null), t.oldest_month, t.code, t.subscriber_id)
    from public._automation_targets(p_month) t
    left join public.router_observed o on o.router_id = p_router_id and lower(o.username) = lower(t.username)
      and o.at > p_now - interval '24 hours' and (not o.present or o.disabled)
    where p_disables and not t.excluded
      and not exists (select 1 from public.router_accounts ra
                      where ra.router_id = p_router_id and lower(ra.username) = lower(t.username)
                        and (ra.state = 'disabled' or (ra.state = 'simulated' and p_dry)
                             or (ra.state = 'overridden' and ra.month = p_month)))
    order by 7
    limit 500
  ) d
$$;

create or replace function public._router_sync(p_router_id text, p_report jsonb, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mode text := public._automation_mode();
  v_month text := public._dam_month(p_now);
  v_day date := public._dam_day(p_now);
  v_phase text := coalesce(p_report ->> 'phase', 'candidates');
  v_script_dry boolean := coalesce(p_report ->> 'dry', 'true') <> 'false';
  -- RouterOS :serialize may turn a one-item list into a lone object: accept both.
  v_obs jsonb := case when jsonb_typeof(p_report -> 'obs') = 'object' then jsonb_build_array(p_report -> 'obs')
                      else coalesce(p_report -> 'obs', '[]'::jsonb) end;
  v_dry boolean;
  c public.automation_cycles;
  v_gate text;
  v_max int := public._setting_int('max_disconnects_per_run', 50, 0, 500);
  v_limit int := public._setting_int('daily_new_disconnect_limit', 30, 0, 100000);
  v_batch int;
  v_n_dis int := 0; v_n_en int := 0; v_n_obs int := 0;
  v_stop boolean := false;
  v_new boolean; v_today_new int;
  v_actions jsonb := '[]'; v_would jsonb := '[]'; v_check jsonb;
  k record; v_name text; v_tag text; v_txt text;
begin
  if v_phase not in ('candidates', 'report') then perform public._fail('bad phase'); end if;
  if jsonb_typeof(v_obs) <> 'array' or jsonb_array_length(v_obs) > 3000 then perform public._fail('bad obs'); end if;

  update public.routers set last_seen_at = p_now,
    last_report = jsonb_build_object('phase', v_phase, 'at', p_now, 'identity', left(p_report ->> 'identity', 64),
                                     'dry_script', v_script_dry, 'n_obs', jsonb_array_length(v_obs))
  where id = p_router_id;
  delete from public.automation_runs where at < p_now - interval '30 days';

  if v_mode = 'off' then
    insert into public.automation_runs (at, router_id, month, phase, mode, dry, gate) values (p_now, p_router_id, v_month, v_phase, v_mode, true, 'off');
    return jsonb_build_object('ok', true, 'mode', 'off', 'check', '[]'::jsonb, 'actions', '[]'::jsonb, 'would', '[]'::jsonb);
  end if;

  v_dry := v_mode = 'dry_run' or v_script_dry;
  if v_mode = 'live' and v_script_dry then
    perform public._automation_alert(p_now, p_router_id, v_month, 'dry_script_in_live',
      'الوضع حقيقي لكن سكربت السيرفر ' || p_router_id || ' تجريبي (قراءة فقط) — لم يُنفَّذ شيء', false);
  end if;
  if not v_dry then
    delete from public.router_accounts where router_id = p_router_id and state = 'simulated';
  end if;

  -- Silent routers (log only).
  insert into public.automation_log (at, day, router_id, username, month, action, reason, message, dry)
  select p_now, v_day, r.id, '', v_month, 'alert', 'router_silent',
    'السيرفر ' || r.id || ' لم يتصل منذ أكثر من 15 دقيقة (آخر اتصال ' || public._dam_hm(r.last_seen_at) || ')', v_dry
  from public.routers r
  where r.enabled and r.id <> p_router_id and r.last_seen_at is not null and r.last_seen_at < p_now - interval '15 minutes'
  on conflict (day, router_id, username, action, reason) do nothing;

  -- Gate for disconnects (enables are never gated).
  c := public._automation_cycle(v_month, p_now);
  if p_now < public._cutoff_at(v_month) then
    v_gate := 'before_cutoff';
  elsif not exists (select 1 from public.billing_months bm where bm.month = v_month) then
    v_gate := 'no_month';
    perform public._automation_alert(p_now, '-', v_month, 'no_month', 'بعد يوم القطع ولم يُفتح شهر ' || v_month || ' — لا فصل', false);
  elsif c.paused then
    v_gate := 'paused';
    perform public._automation_alert(p_now, '-', v_month, 'paused', 'الفصل التلقائي موقوف لهذا الشهر (' || v_month || ')', false);
  elsif c.hold_reason is not null then
    v_gate := 'held';
  end if;

  if v_phase = 'candidates' then
    select coalesce(jsonb_agg(x.username order by x.kord, x.ord), '[]') into v_check
    from (select username, ord, case kind when 'enable' then 0 when 'verify' then 1 else 2 end as kord
          from public._router_candidates(p_router_id, v_month, p_now, v_gate is null, v_dry)) x;
    insert into public.automation_runs (at, router_id, month, phase, mode, dry, gate, n_check)
    values (p_now, p_router_id, v_month, 'candidates', v_mode, v_dry, v_gate, jsonb_array_length(v_check));
    return jsonb_build_object('ok', true, 'mode', v_mode, 'dry', v_dry, 'gate', v_gate, 'check', v_check);
  end if;

  -- Phase B: final verdicts from what the router observed. Names that are not candidates are ignored.
  v_batch := coalesce((select max(ar.batch_no) from public.automation_runs ar where ar.router_id = p_router_id and ar.month = v_month), 0) + 1;

  for k in
    select cd.*, o.present, o.disabled, s.full_name, s.father_name
    from public._router_candidates(p_router_id, v_month, p_now, v_gate is null, v_dry) cd
    join lateral (
      select coalesce((j ->> 'e') in ('true', 'yes', '1'), false) as present,
             coalesce((j ->> 'd') in ('true', 'yes', '1'), false) as disabled
      from jsonb_array_elements(v_obs) j
      where jsonb_typeof(j) = 'object' and lower(j ->> 'u') = lower(cd.username)
      limit 1
    ) o on true
    left join public.subscribers s on s.id = cd.subscriber_id
    order by case cd.kind when 'enable' then 0 when 'verify' then 1 else 2 end, cd.ord
  loop
    v_n_obs := v_n_obs + 1;
    v_name := k.username || ' (' || coalesce(public._display_name(k.full_name, k.father_name), '؟') || ')';
    insert into public.router_observed (router_id, username, present, disabled, at)
    values (p_router_id, k.username, k.present, k.disabled, p_now)
    on conflict (router_id, username) do update set present = excluded.present, disabled = excluded.disabled, at = excluded.at;

    if not k.present then
      if k.kind <> 'disable' then delete from public.router_accounts where router_id = p_router_id and username = k.username; end if;
      perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'skipped', 'not_found',
        'الحساب ' || v_name || ' غير موجود على السيرفر ' || p_router_id, false, null, null, false, v_dry);

    elsif k.kind = 'enable' then
      v_txt := public._enable_text(k.subscriber_id, k.reason);
      if k.state = 'simulated' and k.disabled then
        -- We never really disabled it, yet it is disabled → someone did it by hand. Not ours: forget it.
        delete from public.router_accounts where router_id = p_router_id and username = k.username;
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'skipped', 'manual_disabled',
          v_name || ' على سيرفر ' || p_router_id || ': معطّل يدوياً — لن يُلمس', true, true, null, false, v_dry);
      elsif k.state = 'simulated' or (k.state = 'disabled' and v_dry) then
        if k.state = 'simulated' then delete from public.router_accounts where router_id = p_router_id and username = k.username; end if;
        v_would := v_would || jsonb_build_object('u', k.username, 'action', 'enable', 'reason', k.reason);
        v_n_en := v_n_en + 1;
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'would_enable', k.reason,
          'كان سيتم إعادة تفعيل ' || v_name || ' على سيرفر ' || p_router_id || ' ' || v_txt, true, k.disabled, null, false, true);
      elsif k.disabled then  -- live, ours, still disabled → enable
        delete from public.router_accounts where router_id = p_router_id and username = k.username;
        v_actions := v_actions || jsonb_build_object('u', k.username, 'action', 'enable', 'reason', k.reason);
        v_n_en := v_n_en + 1;
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'enable', k.reason,
          'إعادة تفعيل ' || v_name || ' على سيرفر ' || p_router_id || ' ' || v_txt, true, true, null, false, false);
      else                    -- live, ours, already enabled by hand
        delete from public.router_accounts where router_id = p_router_id and username = k.username;
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'skipped', 'already_enabled',
          v_name || ' على سيرفر ' || p_router_id || ': مفعّل مسبقاً', true, false, null, false, false);
      end if;

    elsif k.kind = 'verify' then  -- live only: ours, still owed
      if not k.disabled then
        update public.router_accounts set state = 'overridden', month = v_month where router_id = p_router_id and username = k.username;
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'skipped', 'manual_enabled',
          v_name || ' على سيرفر ' || p_router_id || ': أعيد تفعيله يدوياً — لن يُفصل هذا الشهر', true, false, null, false, false);
      end if;

    else  -- disable candidate
      if k.disabled then
        perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month, 'skipped', 'manual_disabled',
          v_name || ' على سيرفر ' || p_router_id || ': معطّل يدوياً — لن يُلمس', true, true, null, false, v_dry);
        continue;
      end if;
      if v_stop or v_n_dis >= v_max then continue; end if;  -- the rest go in the next batch (next run)

      v_new := not exists (select 1 from public.automation_snapshot sn where sn.month = v_month and sn.subscriber_id = k.subscriber_id);
      if v_new and c.waived_day is distinct from v_day
         and not exists (select 1 from public.automation_log l where l.day = v_day and l.new_after_cutoff
                         and l.subscriber_id = k.subscriber_id and l.action in ('would_disable', 'disable')) then
        select count(distinct l.subscriber_id) into v_today_new from public.automation_log l
        where l.day = v_day and l.new_after_cutoff and l.action in ('would_disable', 'disable');
        if v_today_new >= v_limit then
          update public.automation_cycles set hold_reason = 'daily_limit', hold_at = p_now, hold_count = v_today_new + 1
          where month = v_month returning * into c;
          perform public._automation_alert(p_now, '-', v_month, 'daily_limit_hold',
            'تم إيقاف الفصل التلقائي — عدد غير طبيعي من الفصل الجديد اليوم (أكثر من ' || v_limit || ')', true);
          v_stop := true;
          continue;
        end if;
      end if;

      insert into public.router_accounts (router_id, username, subscriber_id, state, month, batch_no, since)
      values (p_router_id, k.username, k.subscriber_id, case when v_dry then 'simulated' else 'disabled' end, v_month, v_batch, p_now)
      on conflict (router_id, username) do update
        set subscriber_id = excluded.subscriber_id, state = excluded.state, month = excluded.month, batch_no = excluded.batch_no, since = excluded.since;
      v_tag := k.reason; v_txt := k.reason_text;
      if v_dry then
        v_would := v_would || jsonb_build_object('u', k.username, 'action', 'disable', 'reason', v_tag);
      else
        v_actions := v_actions || jsonb_build_object('u', k.username, 'action', 'disable', 'reason', v_tag);
      end if;
      v_n_dis := v_n_dis + 1;
      perform public._alog(p_now, p_router_id, k.username, k.subscriber_id, v_month,
        case when v_dry then 'would_disable' else 'disable' end, v_tag,
        case when v_dry then 'كان سيتم فصل ' else 'تم فصل ' end || v_name || ' على سيرفر ' || p_router_id
          || ' — السبب: ' || v_txt || ' (الدفعة ' || v_batch || case when v_new then '، جديد بعد يوم القطع' else '' end || ')',
        true, false, v_batch, v_new, v_dry);
    end if;
  end loop;

  insert into public.automation_runs (at, router_id, month, phase, mode, dry, gate, n_obs, n_disable, n_enable, batch_no)
  values (p_now, p_router_id, v_month, 'report', v_mode, v_dry, coalesce(v_gate, case when v_stop then 'held' end),
          v_n_obs, v_n_dis, v_n_en, case when v_n_dis > 0 then v_batch end);

  return jsonb_build_object('ok', true, 'mode', v_mode, 'dry', v_dry, 'gate', coalesce(v_gate, case when v_stop then 'held' end),
    'batch', case when v_n_dis > 0 then v_batch end,
    'actions', case when v_dry then '[]'::jsonb else v_actions end,   -- dry-run: ALWAYS empty
    'would', v_would);
end $$;

-- Called by the routers with the anon key. Checks the per-router token first; a bad token writes nothing.
create or replace function public.router_sync(p_router_id text, p_token text, p_report jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.routers;
begin
  select * into r from public.routers where id = p_router_id;
  if not found or not r.enabled or r.token_hash is null or p_token is null
     or r.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') then
    perform public._fail('unauthorized');
  end if;
  if p_report is null or jsonb_typeof(p_report) <> 'object' or octet_length(p_report::text) > 200000 then
    perform public._fail('bad report');
  end if;
  return public._router_sync(p_router_id, p_report, now());
end $$;

-- Run by YOU in the Supabase SQL Editor: select public.router_issue_token('1100');
-- Returns the token ONCE (only its hash is stored). Issuing again invalidates the old token.
create or replace function public.router_issue_token(p_router_id text) returns text
language plpgsql security definer set search_path = public as $$
declare v_token text := 'tsk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update public.routers set token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex') where id = p_router_id;
  if not found then perform public._fail('router not found: ' || coalesce(p_router_id, 'null')); end if;
  return v_token;
end $$;

/* ======================= 7. manager functions ======================= */

create or replace function public._check_month(p_month text) returns text
language plpgsql immutable as $$
begin
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform public._fail('شهر غير صالح'); end if;
  return p_month;
end $$;

-- «قائمة الفصل»: who would be disconnected for M (default: this Damascus month), with exclusions marked.
create or replace function public.automation_disconnect_list(p_month text default null)
returns table (subscriber_id uuid, code text, username text, display_name text, area_id uuid, area_name text,
               reason text, reason_text text, oldest_month text, due bigint, excluded boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query select * from public._automation_targets(public._check_month(coalesce(p_month, public._dam_month(now()))));
end $$;

create or replace function public._cycle_info(p_month text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'month', p_month,
    'cutoff_at', public._cutoff_at(p_month),
    'eve_at', public._cutoff_at(p_month) - interval '4 hours',
    'started', now() >= public._cutoff_at(p_month),
    'snapshot_at', c.snapshot_at, 'snapshot_count', c.snapshot_count, 'in_scope_count', c.in_scope_count,
    'prev_count', c.prev_count, 'hold_reason', c.hold_reason, 'hold_count', c.hold_count,
    'paused', coalesce(c.paused, false),
    'count_now', (select count(*) from public._automation_targets(p_month) t where not t.excluded),
    'excluded_count', (select count(*) from public.automation_exclusions x where x.month = p_month))
  from (select p_month as m) k left join public.automation_cycles c on c.month = k.m
$$;

create or replace function public.automation_cycle_info(p_month text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return public._cycle_info(public._check_month(coalesce(p_month, public._dam_month(now()))));
end $$;

create or replace function public.automation_set_exclusion(p_subscriber_id uuid, p_month text, p_excluded boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); s public.subscribers; m text := public._check_month(p_month);
begin
  select * into s from public.subscribers where id = p_subscriber_id;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  if coalesce(p_excluded, false) then
    insert into public.automation_exclusions (month, subscriber_id, created_by) values (m, s.id, me.id) on conflict do nothing;
  else
    delete from public.automation_exclusions where month = m and subscriber_id = s.id;
  end if;
  if found then
    perform public._audit(me, case when p_excluded then 'automation_exclude' else 'automation_unexclude' end, 'subscriber', s.id::text,
      case when p_excluded then 'استثناء من الفصل التلقائي لشهر ' else 'إلغاء استثناء الفصل التلقائي لشهر ' end
        || m || ': ' || public._display_name(s.full_name, s.father_name));
  end if;
end $$;

create or replace function public.automation_set_pause(p_month text, p_paused boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); m text := public._check_month(p_month);
begin
  insert into public.automation_cycles (month) values (m) on conflict (month) do nothing;
  update public.automation_cycles set paused = coalesce(p_paused, false), paused_at = now(), paused_by = me.id where month = m;
  perform public._audit(me, case when p_paused then 'automation_pause' else 'automation_resume' end, 'automation', m,
    case when p_paused then 'إيقاف الفصل التلقائي لشهر ' else 'استئناف الفصل التلقائي لشهر ' end || m);
  perform public._alog(now(), '-', '', null, m, 'alert', case when p_paused then 'pause_set' else 'pause_cleared' end,
    case when p_paused then 'أوقف المدير الفصل التلقائي لشهر ' else 'استأنف المدير الفصل التلقائي لشهر ' end || m,
    null, null, null, false, public._automation_mode() <> 'live');
end $$;

-- «متابعة الفصل» after a hold.
create or replace function public.automation_continue(p_month text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); m text := public._check_month(p_month); c public.automation_cycles;
begin
  select * into c from public.automation_cycles where month = m for update;
  if not found or c.hold_reason is null then perform public._fail('الفصل غير موقوف'); end if;
  update public.automation_cycles set hold_reason = null, continued_at = now(), continued_by = me.id,
    waived_day = case when c.hold_reason = 'daily_limit' then public._dam_day(c.hold_at) else waived_day end
  where month = m;
  perform public._audit(me, 'automation_continue', 'automation', m, 'متابعة الفصل التلقائي لشهر ' || m || ' بعد الإيقاف (' || c.hold_reason || ')');
  perform public._alog(now(), '-', '', null, m, 'alert', 'continued', 'تابع المدير الفصل التلقائي لشهر ' || m,
    null, null, null, false, public._automation_mode() <> 'live');
end $$;

create or replace function public.automation_log_list(p_day date, p_router text default null, p_action text default null)
returns table (id bigint, at timestamptz, router_id text, username text, subscriber_id uuid, action text, reason text,
               message text, batch_no int, dry boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query
  select l.id, l.at, l.router_id, l.username, l.subscriber_id, l.action, l.reason, l.message, l.batch_no, l.dry
  from public.automation_log l
  where l.day = p_day
    and (p_router is null or l.router_id = p_router)
    and (p_action is null or l.action = p_action)
  order by l.at desc, l.id desc
  limit 3000;
end $$;

-- Daily count summary: per router and action.
create or replace function public.automation_log_summary(p_day date)
returns table (router_id text, action text, n bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query select l.router_id, l.action, count(*) from public.automation_log l where l.day = p_day group by 1, 2 order by 1, 2;
end $$;

create or replace function public.automation_log_days(p_limit int default 60)
returns table (day date, n bigint, alerts bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query select l.day, count(*), count(*) filter (where l.action = 'alert')
  from public.automation_log l group by l.day order by l.day desc limit greatest(1, least(coalesce(p_limit, 60), 366));
end $$;

-- Settings screen (read-only except cutoff_day in dry_run).
create or replace function public.automation_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m text := public._dam_month(now());
begin
  perform public._require_manager();
  return jsonb_build_object(
    'mode', public._automation_mode(),
    'cutoff_day', public._cutoff_day(),
    'max_disconnects_per_run', public._setting_int('max_disconnects_per_run', 50, 0, 500),
    'daily_new_disconnect_limit', public._setting_int('daily_new_disconnect_limit', 30, 0, 100000),
    'areas', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by a.sort_order, a.name), '[]')
              from public.areas a where a.id = any (public._automation_areas())),
    'routers', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'enabled', r.enabled,
                  'has_token', r.token_hash is not null, 'last_seen_at', r.last_seen_at,
                  'silent', r.enabled and (r.last_seen_at is null or r.last_seen_at < now() - interval '15 minutes')) order by r.id), '[]')
                from public.routers r),
    'cycle', public._cycle_info(m));
end $$;

-- Only while automation_mode = 'dry_run'. Restarts this month's TEST cycle (snapshot, hold, simulated
-- disconnects) so the 20:00 warning and the 00:00 run can be tried again. Exclusions and pause are kept.
create or replace function public.set_cutoff_day(p_day int) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); v_old int := public._cutoff_day(); m text := public._dam_month(now());
begin
  if public._automation_mode() <> 'dry_run' then perform public._fail('يمكن تغيير يوم القطع في الوضع التجريبي فقط'); end if;
  if p_day is null or p_day < 1 or p_day > 28 then perform public._fail('يوم القطع من 1 إلى 28'); end if;
  insert into public.settings (key, value) values ('cutoff_day', p_day::text) on conflict (key) do update set value = excluded.value;
  delete from public.automation_snapshot where month = m;
  update public.automation_cycles set cutoff_at = null, snapshot_at = null, snapshot_count = null, in_scope_count = null,
    prev_count = null, hold_reason = null, hold_at = null, hold_count = null, waived_day = null
  where month = m;
  delete from public.router_accounts where state = 'simulated';
  perform public._audit(me, 'set_cutoff_day', 'settings', 'cutoff_day', 'يوم القطع: ' || v_old || ' ← ' || p_day,
    jsonb_build_object('old', v_old, 'new', p_day));
  insert into public.automation_log (at, day, router_id, username, month, action, reason, message, dry)
  values (now(), public._dam_day(now()), '-', '', m, 'alert', 'cutoff_changed_' || p_day,
    'تم تغيير يوم القطع من ' || v_old || ' إلى ' || p_day || ' — بدأت الدورة التجريبية من جديد', true)
  on conflict (day, router_id, username, action, reason) do nothing;
end $$;

-- Subscriber page: «لا يُفصل», this month's exclusion, and what Tahseel did on each router.
create or replace function public.subscriber_automation(p_subscriber_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m text := public._dam_month(now());
begin
  perform public._require_manager();
  return (select jsonb_build_object(
    'no_auto_disconnect', s.no_auto_disconnect,
    'month', m,
    'excluded', exists (select 1 from public.automation_exclusions x where x.month = m and x.subscriber_id = s.id),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('router_id', ra.router_id, 'state', ra.state, 'month', ra.month,
                   'since', ra.since) order by ra.router_id), '[]')
                 from public.router_accounts ra where ra.subscriber_id = s.id))
    from public.subscribers s where s.id = p_subscriber_id);
end $$;

/* ======================= 8. privileges ======================= */

revoke execute on function
  public._automation_mode(), public._setting_int(text, int, int, int), public._automation_areas(),
  public._dam_month(timestamptz), public._dam_day(timestamptz), public._dam_hm(timestamptz), public._cutoff_at(text),
  public._inv_rem(uuid), public._owes(uuid, text), public._automation_targets(text), public._enable_reason(uuid, text),
  public._enable_text(uuid, text), public._alog(timestamptz, text, text, uuid, text, text, text, text, boolean, boolean, int, boolean, boolean),
  public._automation_alert(timestamptz, text, text, text, text, boolean), public._automation_cycle(text, timestamptz),
  public._router_candidates(text, text, timestamptz, boolean, boolean), public._router_sync(text, jsonb, timestamptz),
  public._check_month(text), public._cycle_info(text)
from public, anon, authenticated;

-- Token issuing: SQL Editor only.
revoke execute on function public.router_issue_token(text) from public, anon, authenticated, service_role;

-- Routers call with the anon key; the token is checked inside.
revoke execute on function public.router_sync(text, text, jsonb) from public;
grant execute on function public.router_sync(text, text, jsonb) to anon;

revoke execute on function
  public.set_no_auto_disconnect(uuid, boolean), public.automation_disconnect_list(text), public.automation_cycle_info(text),
  public.automation_set_exclusion(uuid, text, boolean), public.automation_set_pause(text, boolean), public.automation_continue(text),
  public.automation_log_list(date, text, text), public.automation_log_summary(date), public.automation_log_days(int),
  public.automation_status(), public.set_cutoff_day(int), public.subscriber_automation(uuid)
from public, anon;
grant execute on function
  public.set_no_auto_disconnect(uuid, boolean), public.automation_disconnect_list(text), public.automation_cycle_info(text),
  public.automation_set_exclusion(uuid, text, boolean), public.automation_set_pause(text, boolean), public.automation_continue(text),
  public.automation_log_list(date, text, text), public.automation_log_summary(date), public.automation_log_days(int),
  public.automation_status(), public.set_cutoff_day(int), public.subscriber_automation(uuid)
to authenticated;

/* ======================= 9. check after running ======================= */
-- Expect 9 rows here. A missing area name means automation_area_ids is short — tell Claude before going on.
select a.name as in_scope_area
from public.areas a where a.id = any (public._automation_areas())
order by a.name;
