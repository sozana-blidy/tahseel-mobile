-- Batch 2 (16 Nov 2026):
-- 1) agent accounts created by the admin-users Edge Function (service role only helpers)
-- 2) guest mode (read-only, unlocked by a guest code stored as a hash)
-- 3) invoice deferral («تأجيل»): one month at most, paid together with the next invoice
-- 4) late-payment notifications (cutoff_day setting)

/* ======================= 1. agent accounts (Edge Function admin-users) ======================= */

-- Validates (p_dry_run) or registers an agent whose auth user the Edge Function just created.
-- Same rules as create_agent_invite. Callable by service_role only — never by the app.
create or replace function public.admin_register_agent(
  p_actor uuid, p_user_id uuid, p_full_name text, p_username text, p_area_ids uuid[],
  p_phone text default null, p_comp_type text default 'none', p_comp_amount bigint default 0,
  p_dry_run boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles; uname text := lower(trim(p_username)); a uuid; prof public.profiles;
begin
  select * into me from public.profiles where id = p_actor and role = 'manager' and active;
  if not found then perform public._fail('هذه العملية للمدير فقط'); end if;
  if coalesce(trim(p_full_name), '') = '' then perform public._fail('اسم المعتمد مطلوب'); end if;
  if uname !~ '^[a-z0-9_.]{3,30}$' then perform public._fail('اسم الدخول: أحرف إنجليزية صغيرة أو أرقام فقط (3 أحرف على الأقل)'); end if;
  if exists (select 1 from public.profiles where username = uname)
     or exists (select 1 from public.agent_invites where username = uname and claimed_at is null and revoked_at is null and expires_at > now()) then
    perform public._fail('اسم الدخول ' || uname || ' مستخدم مسبقاً');
  end if;
  if coalesce(array_length(p_area_ids, 1), 0) = 0 then perform public._fail('اختر منطقة واحدة على الأقل'); end if;
  foreach a in array p_area_ids loop
    if not exists (select 1 from public.areas where id = a) then perform public._fail('منطقة غير موجودة'); end if;
    if (public._area_agent(a)).id is not null then
      perform public._fail('المنطقة ' || (select name from public.areas where id = a) || ' مرتبطة بمعتمد آخر');
    end if;
  end loop;
  if p_comp_type not in ('none', 'monthly_salary', 'per_invoice') or coalesce(p_comp_amount, 0) < 0 then perform public._fail('تعويض غير صحيح'); end if;
  if p_dry_run then return jsonb_build_object('ok', true, 'username', uname); end if;

  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then perform public._fail('حساب الدخول غير موجود'); end if;
  insert into public.profiles (id, role, full_name, username, phone, comp_type, comp_amount)
  values (p_user_id, 'agent', trim(p_full_name), uname, nullif(trim(p_phone), ''), p_comp_type, case when p_comp_type = 'none' then 0 else p_comp_amount end)
  returning * into prof;
  insert into public.agent_areas (agent_id, area_id) select p_user_id, x from unnest(p_area_ids) x on conflict do nothing;
  perform public._audit(me, 'create_agent_account', 'profile', p_user_id::text, 'إنشاء حساب المعتمد ' || prof.full_name || ' (' || uname || ')');
  return jsonb_build_object('ok', true, 'username', uname, 'full_name', prof.full_name,
    'areas', (select string_agg(ar.name, '، ' order by ar.sort_order, ar.name) from public.areas ar where ar.id = any (p_area_ids)));
end $$;

-- Checks the target of a password reset is an agent; audits the reset. service_role only.
create or replace function public.admin_agent_for_reset(p_actor uuid, p_agent_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles; ag public.profiles;
begin
  select * into me from public.profiles where id = p_actor and role = 'manager' and active;
  if not found then perform public._fail('هذه العملية للمدير فقط'); end if;
  select * into ag from public.profiles where id = p_agent_id and role = 'agent';
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  perform public._audit(me, 'reset_agent_password', 'profile', ag.id::text, 'إعادة تعيين كلمة مرور المعتمد ' || ag.full_name);
  return jsonb_build_object('full_name', ag.full_name, 'username', ag.username,
    'areas', (select string_agg(ar.name, '، ' order by ar.sort_order, ar.name)
              from public.agent_areas aa join public.areas ar on ar.id = aa.area_id where aa.agent_id = ag.id));
end $$;

-- Manager check for the Edge Function (service_role only).
create or replace function public.admin_is_manager(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user and role = 'manager' and active)
$$;

revoke execute on function public.admin_register_agent(uuid, uuid, text, text, uuid[], text, text, bigint, boolean),
  public.admin_agent_for_reset(uuid, uuid), public.admin_is_manager(uuid) from public, anon, authenticated;
grant execute on function public.admin_register_agent(uuid, uuid, text, text, uuid[], text, text, bigint, boolean),
  public.admin_agent_for_reset(uuid, uuid), public.admin_is_manager(uuid) to service_role;

/* ======================= 2. guest mode (read-only, unlocked by a guest code) ======================= */

-- Three-part display name — same rule as src/lib/names.ts (kept in step by a DB test).
create or replace function public._norm_ar(s text) returns text language sql immutable as $$
  select trim(translate(coalesce(s, ''), 'إأآىة', 'ااايه'))
$$;

create or replace function public._display_name(p_full text, p_father text) returns text
language plpgsql immutable as $$
declare
  v_full text := regexp_replace(trim(coalesce(p_full, '')), '\s+', ' ', 'g');
  v_father text := regexp_replace(trim(coalesce(p_father, '')), '\s+', ' ', 'g');
  toks text[]; n int; first_len int;
  compound text[] := array['عبد', 'أبو', 'ابو', 'أم', 'ام'];
begin
  if v_father = '' then return v_full; end if;
  toks := string_to_array(v_full, ' ');
  n := coalesce(array_length(toks, 1), 0);
  if n < 2 then return v_full || ' ' || v_father; end if;
  if strpos(' ' || public._norm_ar(v_full) || ' ', ' ' || public._norm_ar(v_father) || ' ') > 0 then return v_full; end if;
  if n = 2 and toks[1] = any (compound) then return v_full || ' ' || v_father; end if;
  first_len := case when n >= 3 and (toks[1] = any (compound) or toks[2] like 'ال%') then 2 else 1 end;
  return array_to_string(toks[1:first_len] || v_father || toks[first_len + 1:n], ' ');
end $$;

-- One row. The code is never stored — only a salted SHA-256. No grants: apps cannot read it.
create table public.guest_config (
  id boolean primary key default true check (id),
  code_salt text,
  code_hash text,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);
insert into public.guest_config (id) values (true);

-- An anonymous user that entered the right code (valid while version matches and not expired).
create table public.guest_sessions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  version int not null,
  expires_at timestamptz not null
);

create table public.guest_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index guest_attempts_recent on public.guest_attempts (user_id, at);

alter table public.guest_config enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.guest_attempts enable row level security;
revoke all on public.guest_config, public.guest_sessions, public.guest_attempts from anon, authenticated;

create or replace function public._is_guest() returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' and auth.uid() is not null
$$;

create or replace function public._guest_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select public._is_guest() and exists (
    select 1 from public.guest_sessions s join public.guest_config c on c.id
    where s.user_id = auth.uid() and s.version = c.version and s.expires_at > now() and c.code_hash is not null)
$$;

-- Manager sets or changes the guest code (null/empty = guest mode off). Signs out every guest.
create or replace function public.set_guest_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); v_code text := lower(trim(coalesce(p_code, ''))); v_salt text;
begin
  if v_code <> '' and length(v_code) < 6 then perform public._fail('رمز الضيف: 6 أحرف أو أرقام على الأقل'); end if;
  if length(v_code) > 30 then perform public._fail('رمز الضيف طويل جداً'); end if;
  v_salt := case when v_code = '' then null else gen_random_uuid()::text end;
  update public.guest_config set
    code_salt = v_salt,
    code_hash = case when v_code = '' then null else encode(sha256(convert_to(v_salt || v_code, 'UTF8')), 'hex') end,
    version = version + 1, updated_at = now(), updated_by = me.id
  where id;
  delete from public.guest_sessions where true;
  perform public._audit(me, 'set_guest_code', 'guest_config', null, case when v_code = '' then 'إيقاف دخول الضيوف' else 'تغيير رمز الضيف' end);
  return jsonb_build_object('enabled', v_code <> '');
end $$;

create or replace function public.guest_code_enabled() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return (select c.code_hash is not null from public.guest_config c where c.id);
end $$;

-- Guest enters the code. Never raises on a wrong code (the failed attempt must be kept):
-- returns {ok:false, error}. 5 wrong codes per user per 15 min; 100 across all guests (shared
-- brute force through many anonymous users).
create or replace function public.guest_unlock(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.guest_config; uid uuid := auth.uid(); mine int; everyone int; v_until timestamptz := now() + interval '12 hours';
begin
  if not public._is_guest() then perform public._fail('هذه العملية للضيوف فقط'); end if;
  select * into c from public.guest_config where id;
  if c.code_hash is null then return jsonb_build_object('ok', false, 'error', 'دخول الضيوف غير مفعّل'); end if;
  select count(*) filter (where ga.user_id = uid), count(*) into mine, everyone
  from public.guest_attempts ga where ga.at > now() - interval '15 minutes';
  if mine >= 5 or everyone >= 100 then
    return jsonb_build_object('ok', false, 'error', 'محاولات كثيرة — حاول بعد 15 دقيقة');
  end if;
  if encode(sha256(convert_to(c.code_salt || lower(trim(coalesce(p_code, ''))), 'UTF8')), 'hex') <> c.code_hash then
    insert into public.guest_attempts (user_id) values (uid);
    return jsonb_build_object('ok', false, 'error', 'رمز الضيف غير صحيح');
  end if;
  insert into public.guest_sessions (user_id, version, expires_at) values (uid, c.version, v_until)
  on conflict (user_id) do update set version = excluded.version, expires_at = excluded.expires_at;
  delete from public.guest_attempts ga where ga.at < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'expires_at', v_until);
end $$;

create or replace function public.guest_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('unlocked', public._guest_ok())
$$;

-- Invoice status per subscriber for a month (internal; callers check access themselves).
create or replace function public._month_status(p_month text)
returns table (subscriber_id uuid, area_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select i.subscriber_id, i.area_id,
    case
      when i.amount = 0 or (x.exempt > 0 and x.paid + x.exempt >= i.amount) then 'exempt'
      when x.paid >= i.amount then 'paid'
      else 'unpaid' end
  from public.invoices i
  cross join lateral (
    select coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0) as paid,
           coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0) as exempt
  ) x
  where i.month = p_month
$$;

-- Guest: areas with paid / unpaid counts. No money, no agents. p_month null = latest month.
create or replace function public.guest_overview(p_month text default null)
returns table (month text, area_id uuid, area_name text, paid_count bigint, unpaid_count bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare m text;
begin
  if not public._guest_ok() then perform public._fail('أدخل رمز الضيف'); end if;
  m := coalesce(p_month, (select max(bm.month) from public.billing_months bm));
  return query
  select m, a.id, a.name,
    count(*) filter (where st.status = 'paid'), count(*) filter (where st.status = 'unpaid')
  from public.areas a
  join public._month_status(m) st on st.area_id = a.id
  group by a.id, a.name, a.sort_order
  order by a.sort_order, a.name;
end $$;

-- Guest: one area — area name, three-part name, paid / unpaid / exempt. Nothing else.
create or replace function public.guest_area_list(p_month text, p_area_id uuid)
returns table (area_name text, display_name text, status text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare m text;
begin
  if not public._guest_ok() then perform public._fail('أدخل رمز الضيف'); end if;
  m := coalesce(p_month, (select max(bm.month) from public.billing_months bm));
  return query
  select a.name, public._display_name(s.full_name, s.father_name), st.status
  from public._month_status(m) st
  join public.subscribers s on s.id = st.subscriber_id
  join public.areas a on a.id = st.area_id
  where st.area_id = p_area_id
  order by 2;
end $$;

revoke execute on function public._norm_ar(text), public._display_name(text, text), public._is_guest(), public._guest_ok(),
  public._month_status(text) from public, anon, authenticated;
revoke execute on function public.set_guest_code(text), public.guest_code_enabled(), public.guest_unlock(text), public.guest_status(),
  public.guest_overview(text), public.guest_area_list(text, uuid) from public, anon;
grant execute on function public.set_guest_code(text), public.guest_code_enabled(), public.guest_unlock(text), public.guest_status(),
  public.guest_overview(text), public.guest_area_list(text, uuid) to authenticated;

/* ======================= 3. deferral («تأجيل») ======================= */

create or replace function public._shift_month(m text, n int) returns text language sql immutable as $$
  select to_char((m || '-01')::date + make_interval(months => n), 'YYYY-MM')
$$;

-- One deferral moves ONE unpaid invoice to the next month; it is then paid together with that
-- month's invoice. One active deferral per invoice (cancelled rows don't count), never two months.
create table public.invoice_deferrals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id),
  subscriber_id uuid not null references public.subscribers (id),
  month text not null,
  deferred_to_month text not null,
  client_key text unique,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id)
);
create unique index invoice_deferrals_one_active on public.invoice_deferrals (invoice_id) where cancelled_at is null;
create index invoice_deferrals_carried on public.invoice_deferrals (subscriber_id, deferred_to_month) where cancelled_at is null;
alter table public.invoice_deferrals enable row level security;
grant select on public.invoice_deferrals to authenticated;
create policy invoice_deferrals_read on public.invoice_deferrals for select to authenticated using (public.is_manager());

-- The active deferral that carries an older invoice INTO p_month (null if none).
create or replace function public._carried_into(p_subscriber uuid, p_month text) returns public.invoice_deferrals
language sql stable security definer set search_path = public as $$
  select d.* from public.invoice_deferrals d
  where d.subscriber_id = p_subscriber and d.deferred_to_month = p_month and d.cancelled_at is null
  limit 1
$$;

-- Router batch: a subscriber with an active deferral whose invoice is still unpaid is NEVER disconnected.
create or replace function public.never_disconnect(p_subscriber_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.invoice_deferrals d join public.invoices i on i.id = d.invoice_id
    where d.subscriber_id = p_subscriber_id and d.cancelled_at is null
      and i.amount > coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)
                    + coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0))
$$;

create or replace function public.defer_invoice(p_subscriber_id uuid, p_month text, p_client_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); d public.invoice_deferrals; st record; v_to text;
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select * into d from public.invoice_deferrals where client_key = p_client_key;
  if found then return jsonb_build_object('deferral_id', d.id, 'deferred_to', d.deferred_to_month, 'repeated', true); end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if st.remaining <= 0 then perform public._fail(st.full_name || ': الفاتورة مدفوعة أو معفاة — لا تأجيل'); end if;
  if exists (select 1 from public.invoice_deferrals x where x.invoice_id = st.invoice_id and x.cancelled_at is null) then
    perform public._fail(st.full_name || ': الفاتورة مؤجلة مسبقاً');
  end if;
  -- max ONE deferred month: this month already carries the previous one
  if (public._carried_into(p_subscriber_id, p_month)).id is not null then
    perform public._fail(st.full_name || ': لا يمكن التأجيل لأكثر من شهر واحد (الشهر السابق مؤجل إلى هذا الشهر)');
  end if;
  v_to := public._shift_month(p_month, 1);
  insert into public.invoice_deferrals (invoice_id, subscriber_id, month, deferred_to_month, client_key, created_by)
  values (st.invoice_id, p_subscriber_id, p_month, v_to, p_client_key, me.id) returning * into d;
  perform public._audit(me, 'defer_invoice', 'invoice', st.invoice_id::text, 'تأجيل فاتورة ' || st.full_name || ' ' || p_month || ' إلى ' || v_to);
  return jsonb_build_object('deferral_id', d.id, 'deferred_to', v_to, 'repeated', false);
end $$;

create or replace function public.cancel_deferral(p_subscriber_id uuid, p_month text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); d public.invoice_deferrals; st record;
begin
  select * into d from public.invoice_deferrals x
  where x.subscriber_id = p_subscriber_id and x.month = p_month and x.cancelled_at is null for update;
  if not found then perform public._fail('لا يوجد تأجيل لهذا الشهر'); end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if st.remaining <= 0 then perform public._fail('الفاتورة المؤجلة دُفعت — لا يمكن إلغاء التأجيل'); end if;
  update public.invoice_deferrals set cancelled_at = now(), cancelled_by = me.id where id = d.id;
  perform public._audit(me, 'cancel_deferral', 'invoice', d.invoice_id::text, 'إلغاء تأجيل فاتورة ' || st.full_name || ' ' || p_month);
end $$;

-- Agent «تم الدفع»: pays this month's invoice AND a carried (deferred) one in one action.
-- Idempotent: rows use client_key and client_key || ':carried'.
create or replace function public.agent_mark_paid(p_subscriber_id uuid, p_month text, p_client_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_agent(); st record; cst record; d public.invoice_deferrals;
  prev_total bigint; prev_n int; cur_id uuid; car_id uuid; car_amt bigint := 0;
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select coalesce(sum(p.amount), 0), count(*) into prev_total, prev_n
  from public.payments p where p.client_key in (p_client_key, p_client_key || ':carried');
  if prev_n > 0 then
    if exists (select 1 from public.payments p where p.client_key in (p_client_key, p_client_key || ':carried') and p.recorded_by <> me.id) then
      perform public._fail('طلب غير صالح');
    end if;
    return jsonb_build_object('payment_id', (select p.id from public.payments p where p.client_key = p_client_key),
      'amount', prev_total, 'repeated', true);
  end if;
  d := public._carried_into(p_subscriber_id, p_month);
  if d.id is not null then                       -- older invoice first (lock order)
    select * into cst from public._invoice_for_update(p_subscriber_id, d.month);
    if not (cst.area_id in (select public.my_area_ids())) then perform public._fail('هذا المشترك ليس من منطقتك'); end if;
    car_amt := greatest(cst.remaining, 0);
  end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if not (st.area_id in (select public.my_area_ids())) then perform public._fail('هذا المشترك ليس من منطقتك'); end if;
  if st.remaining <= 0 and car_amt <= 0 then perform public._fail(st.full_name || ': مدفوع مسبقاً'); end if;
  if st.remaining > 0 then
    insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, client_key, recorded_by)
    values (st.invoice_id, p_subscriber_id, st.area_id, p_month, st.remaining, 'agent_cash', me.id, p_client_key, me.id)
    returning id into cur_id;
  end if;
  if car_amt > 0 then
    insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, client_key, recorded_by, notes)
    values (cst.invoice_id, p_subscriber_id, cst.area_id, d.month, car_amt, 'agent_cash', me.id, p_client_key || ':carried', me.id, 'فاتورة مؤجلة')
    returning id into car_id;
  end if;
  perform public._audit(me, 'agent_payment', 'payment', coalesce(cur_id, car_id)::text,
    'تم الدفع: ' || st.full_name || ' — ' || public._fmt(greatest(st.remaining, 0) + car_amt)
    || case when car_amt > 0 then ' (مع فاتورة ' || d.month || ' المؤجلة)' else '' end);
  return jsonb_build_object('payment_id', coalesce(cur_id, car_id), 'amount', greatest(st.remaining, 0) + car_amt,
    'carried_month', case when car_amt > 0 then d.month end, 'carried_amount', car_amt, 'repeated', false);
end $$;

-- Manager payment: the full amount due — this month's invoice plus a carried one — in one action.
-- p_amount null or exactly the total. Sham Cash: the transfer number goes on the current month's
-- row; the carried row notes «نفس عملية {ref}». Signature unchanged.
create or replace function public.manager_record_payment(
  p_subscriber_id uuid, p_month text, p_amount bigint, p_method text, p_client_key text,
  p_reference text default null, p_paid_on date default current_date, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); st record; cst record; d public.invoice_deferrals; ag public.profiles;
  ref text := nullif(trim(p_reference), ''); prev_total bigint; prev_n int; cur_id uuid; car_id uuid; car_amt bigint := 0; cur_amt bigint; total bigint;
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select coalesce(sum(p.amount), 0), count(*) into prev_total, prev_n
  from public.payments p where p.client_key in (p_client_key, p_client_key || ':carried');
  if prev_n > 0 then
    return jsonb_build_object('payment_id', (select p.id from public.payments p where p.client_key = p_client_key),
      'amount', prev_total, 'repeated', true);
  end if;
  if p_method not in ('agent_cash', 'manager_cash', 'shamcash') then perform public._fail('طريقة دفع غير صحيحة'); end if;
  d := public._carried_into(p_subscriber_id, p_month);
  if d.id is not null then
    select * into cst from public._invoice_for_update(p_subscriber_id, d.month);
    car_amt := greatest(cst.remaining, 0);
  end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  cur_amt := greatest(st.remaining, 0);
  total := cur_amt + car_amt;
  if total <= 0 then perform public._fail(st.full_name || ': مدفوع مسبقاً'); end if;
  if p_amount is not null and p_amount <> total then
    perform public._fail('تُدفع الفاتورة كاملة فقط: ' || public._fmt(total));
  end if;
  if p_method = 'agent_cash' then
    ag := public._area_agent(st.area_id);
    if ag.id is null then perform public._fail('هذه المنطقة بدون معتمد — اختر «نقداً للمدير»'); end if;
  end if;
  if ref is not null and exists (select 1 from public.payments where reference = ref and reversal_of is null and reversed_by is null) then
    perform public._fail('رقم العملية مسجّل مسبقاً');
  end if;
  if cur_amt > 0 then
    insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, reference, paid_on, notes, client_key, recorded_by)
    values (st.invoice_id, p_subscriber_id, st.area_id, p_month, cur_amt, p_method, ag.id, ref, coalesce(p_paid_on, current_date), nullif(trim(p_notes), ''), p_client_key, me.id)
    returning id into cur_id;
  end if;
  if car_amt > 0 then
    insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, reference, paid_on, notes, client_key, recorded_by)
    values (cst.invoice_id, p_subscriber_id, cst.area_id, d.month, car_amt, p_method, ag.id,
      case when cur_amt > 0 then null else ref end, coalesce(p_paid_on, current_date),
      case when cur_amt > 0 and ref is not null then 'نفس عملية ' || ref else 'فاتورة مؤجلة' end,
      p_client_key || ':carried', me.id)
    returning id into car_id;
  end if;
  perform public._audit(me, 'manager_payment', 'payment', coalesce(cur_id, car_id)::text,
    'دفعة ' || public._fmt(total) || ' — ' || st.full_name || ' (' || p_method || ')'
    || case when car_amt > 0 then ' مع فاتورة ' || d.month || ' المؤجلة' else '' end);
  return jsonb_build_object('payment_id', coalesce(cur_id, car_id), 'amount', total,
    'carried_month', case when car_amt > 0 then d.month end, 'carried_amount', car_amt, 'repeated', false);
end $$;

-- area_subscribers gains the deferral columns → return type changes → drop and recreate.
--   carried_month / carried_amount: an older invoice deferred INTO this month, still unpaid.
--   deferred_to: this month's invoice is deferred (and still unpaid) to that month.
--   never_disconnect: either of the two (read by the router batch).
drop function if exists public.area_subscribers(text, uuid);

create function public.area_subscribers(p_month text, p_area_id uuid default null)
returns table (
  id uuid, code text, full_name text, father_name text, username text, phone text, area_id uuid, area_name text,
  package_label text, monthly_amount bigint, sub_status text, invoice_id uuid, amount bigint, paid bigint, exempt bigint,
  remaining bigint, status text, paid_by_agent boolean, last_paid_at timestamptz,
  paid_via text, carried_month text, carried_amount bigint, deferred_to text, never_disconnect boolean
) language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_manager() or public.is_agent()) then perform public._fail('غير مصرح'); end if;
  return query
  with scope as (
    select a.id from public.areas a
    where (p_area_id is null or a.id = p_area_id)
      and (public.is_manager() or a.id in (select public.my_area_ids()))
  ), inv as (
    select i.id, i.subscriber_id, i.amount,
      coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)::bigint as paid,
      coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0)::bigint as exempt,
      exists (select 1 from public.payments p where p.invoice_id = i.id and p.method = 'agent_cash' and p.reversal_of is null and p.reversed_by is null) as by_agent,
      (select max(p.created_at) from public.payments p where p.invoice_id = i.id and p.reversal_of is null and p.reversed_by is null) as last_paid,
      (select string_agg(distinct p.method, ',' order by p.method) from public.payments p where p.invoice_id = i.id and p.reversal_of is null and p.reversed_by is null) as via,
      (select d.deferred_to_month from public.invoice_deferrals d where d.invoice_id = i.id and d.cancelled_at is null) as def_to
    from public.invoices i where i.month = p_month
  ), carried as (
    select d.subscriber_id, d.month as c_month,
      greatest(0, ci.amount
        - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = ci.id), 0)
        - coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = ci.id), 0))::bigint as c_amount
    from public.invoice_deferrals d join public.invoices ci on ci.id = d.invoice_id
    where d.deferred_to_month = p_month and d.cancelled_at is null
  )
  select s.id, s.code, s.full_name, s.father_name, s.username, s.phone, s.area_id, a.name, s.package_label, s.monthly_amount, s.status,
    inv.id, inv.amount, coalesce(inv.paid, 0), coalesce(inv.exempt, 0),
    case when inv.id is null then 0 else greatest(0, inv.amount - inv.paid - inv.exempt) end::bigint,
    case
      when inv.id is null then case when s.monthly_amount is null then 'no_price' when s.status = 'disconnected' then 'disconnected' else 'no_invoice' end
      when inv.amount = 0 or (inv.exempt > 0 and inv.paid + inv.exempt >= inv.amount) then 'exempt'
      when inv.paid >= inv.amount then 'paid'
      else 'unpaid' end,
    coalesce(inv.by_agent, false), inv.last_paid, inv.via,
    case when c.c_amount > 0 then c.c_month end,
    coalesce(case when c.c_amount > 0 then c.c_amount end, 0)::bigint,
    case when inv.id is not null and inv.amount - inv.paid - inv.exempt > 0 then inv.def_to end,
    (coalesce(c.c_amount, 0) > 0) or (inv.id is not null and inv.def_to is not null and inv.amount - inv.paid - inv.exempt > 0)
  from public.subscribers s
  join public.areas a on a.id = s.area_id
  left join inv on inv.subscriber_id = s.id
  left join carried c on c.subscriber_id = s.id
  where s.area_id in (select scope.id from scope)
    and (inv.id is not null or s.status = 'active' or coalesce(c.c_amount, 0) > 0)
  order by a.sort_order, s.full_name;
end $$;

revoke execute on function public._shift_month(text, int), public._carried_into(uuid, text) from public, anon, authenticated;
revoke execute on function public.area_subscribers(text, uuid), public.defer_invoice(uuid, text, text), public.cancel_deferral(uuid, text)
  from public, anon;
grant execute on function public.area_subscribers(text, uuid), public.defer_invoice(uuid, text, text), public.cancel_deferral(uuid, text)
  to authenticated;
-- never_disconnect: for the router integration (server side). The app reads the same flag via area_subscribers.
revoke execute on function public.never_disconnect(uuid) from public, anon, authenticated;
grant execute on function public.never_disconnect(uuid) to service_role;

/* ======================= 4. late-payment notifications ======================= */

-- Day of the invoice month from which a payment counts as LATE (00:00 Asia/Damascus). 25 for the test period.
insert into public.settings (key, value) values ('cutoff_day', '25') on conflict (key) do nothing;

create or replace function public._cutoff_day() returns int
language sql stable security definer set search_path = public as $$
  select case when s.value ~ '^\d{1,2}$' then greatest(1, least(28, s.value::int)) else 25 end
  from (select (select value from public.settings where key = 'cutoff_day') as value) s
$$;

-- true when a payment made at p_at for invoice month p_month is late.
create or replace function public._is_late(p_month text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select p_at >= (to_date(p_month || '-' || lpad(public._cutoff_day()::text, 2, '0'), 'YYYY-MM-DD')::timestamp at time zone 'Asia/Damascus')
$$;

-- ONE notification per late payment row. Never for: reversals, a carried (deferred) invoice.
-- Only an invoice's own payment at/after the cutoff of its month.
create or replace function public._notify_late_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.amount <= 0 or new.reversal_of is not null then return new; end if;
  if exists (select 1 from public.invoice_deferrals d where d.invoice_id = new.invoice_id and d.cancelled_at is null) then return new; end if;
  if not public._is_late(new.month, new.created_at) then return new; end if;
  insert into public.notifications (kind, title, body, area_id, agent_id, payment_id)
  select 'late_payment', 'دفعة متأخرة',
    public._display_name(s.full_name, s.father_name) || ' — ' || a.name || ': كان متأخراً ودفع ' || public._fmt(new.amount) || ' ل.س',
    new.area_id, new.agent_id, new.id
  from public.subscribers s join public.areas a on a.id = new.area_id
  where s.id = new.subscriber_id;
  return new;
end $$;

create trigger payments_late_notification after insert on public.payments
  for each row execute function public._notify_late_payment();

revoke execute on function public._cutoff_day(), public._is_late(text, timestamptz), public._notify_late_payment() from public, anon, authenticated;
