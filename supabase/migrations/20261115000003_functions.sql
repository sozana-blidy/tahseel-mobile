-- Tahseel — all write operations and the main read models.
-- Every function: SECURITY DEFINER, fixed search_path, explicit role check.
-- Errors are raised in Arabic so the app can show them as-is.

/* ======================= internal helpers (not callable by apps) ======================= */

create or replace function public._fail(msg text) returns void language plpgsql as $$
begin
  raise exception using message = msg, errcode = 'P0001';
end $$;

create or replace function public._require_manager() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid() and active and role = 'manager';
  if not found then perform public._fail('هذه العملية للمدير فقط'); end if;
  return p;
end $$;

create or replace function public._require_agent() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid() and active and role = 'agent';
  if not found then perform public._fail('الحساب غير مفعّل كمعتمد'); end if;
  return p;
end $$;

create or replace function public._valid_month(m text) returns boolean language sql immutable as $$
  select m ~ '^\d{4}-(0[1-9]|1[0-2])$'
$$;

create or replace function public._fmt(v bigint) returns text language sql immutable as $$
  select to_char(v, 'FM999,999,999,999')
$$;

create or replace function public._audit(actor public.profiles, action text, entity text, entity_id text, summary text, data jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, actor_name, action, entity, entity_id, summary, data)
  values (actor.id, actor.full_name, action, entity, entity_id, summary, data)
$$;

-- Invoice state for (subscriber, month). Locks the invoice row so concurrent payments serialize.
create or replace function public._invoice_for_update(p_subscriber uuid, p_month text)
returns table (invoice_id uuid, area_id uuid, amount bigint, paid bigint, exempt bigint, remaining bigint, full_name text)
language plpgsql security definer set search_path = public as $$
declare inv public.invoices; s public.subscribers;
begin
  select * into s from public.subscribers where id = p_subscriber;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  select * into inv from public.invoices i where i.subscriber_id = p_subscriber and i.month = p_month for update;
  if not found then
    if s.monthly_amount is null then perform public._fail(s.full_name || ': سعر الاشتراك غير محدد'); end if;
    perform public._fail(s.full_name || ': لا توجد فاتورة لهذا الشهر');
  end if;
  return query
    select inv.id, inv.area_id, inv.amount,
      coalesce((select sum(p.amount) from public.payments p where p.invoice_id = inv.id), 0)::bigint,
      coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = inv.id), 0)::bigint,
      greatest(0, inv.amount
        - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = inv.id), 0)
        - coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = inv.id), 0))::bigint,
      s.full_name;
end $$;

create or replace function public._area_agent(p_area uuid) returns public.profiles
language sql stable security definer set search_path = public as $$
  select p.* from public.agent_areas aa join public.profiles p on p.id = aa.agent_id
  where aa.area_id = p_area and p.active limit 1
$$;

/* ======================= setup: manager account (run once in SQL editor) ======================= */

-- Not callable from the app. Run in the Supabase SQL editor after the manager signs up:
--   select public.make_manager('manager@example.com', 'المدير', 'manager');
create or replace function public.make_manager(p_email text, p_full_name text, p_username text)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No auth user with email %', p_email; end if;
  insert into public.profiles (id, role, full_name, username) values (uid, 'manager', p_full_name, lower(p_username))
  on conflict (id) do update set role = 'manager', full_name = excluded.full_name, active = true;
  insert into public.audit_log (actor, actor_name, action, entity, entity_id, summary)
  values (uid, p_full_name, 'make_manager', 'profile', uid::text, 'تفعيل حساب المدير');
  return uid;
end $$;

/* ======================= agents & invites ======================= */

create or replace function public._new_code() returns text language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I/L
  bytes bytea := uuid_send(gen_random_uuid());
  out text := '';
begin
  for i in 0..7 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return out;
end $$;

create or replace function public.create_agent_invite(
  p_full_name text, p_username text, p_area_ids uuid[], p_phone text default null,
  p_comp_type text default 'none', p_comp_amount bigint default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); uname text := lower(trim(p_username)); v_code text; a uuid;
begin
  if coalesce(trim(p_full_name), '') = '' then perform public._fail('اسم المعتمد مطلوب'); end if;
  if uname !~ '^[a-z0-9_.]{3,30}$' then perform public._fail('اسم الدخول: أحرف إنجليزية صغيرة أو أرقام فقط (3 أحرف على الأقل)'); end if;
  if exists (select 1 from public.profiles where username = uname)
     or exists (select 1 from public.agent_invites where username = uname and claimed_at is null and revoked_at is null and expires_at > now()) then
    perform public._fail('اسم الدخول مستخدم مسبقاً');
  end if;
  if coalesce(array_length(p_area_ids, 1), 0) = 0 then perform public._fail('اختر منطقة واحدة على الأقل'); end if;
  foreach a in array p_area_ids loop
    if not exists (select 1 from public.areas where id = a) then perform public._fail('منطقة غير موجودة'); end if;
    if (public._area_agent(a)).id is not null then
      perform public._fail('المنطقة ' || (select name from public.areas where id = a) || ' مرتبطة بمعتمد آخر');
    end if;
  end loop;
  if p_comp_type not in ('none', 'monthly_salary', 'per_invoice') or coalesce(p_comp_amount, 0) < 0 then perform public._fail('تعويض غير صحيح'); end if;
  loop
    v_code := public._new_code();
    exit when not exists (select 1 from public.agent_invites i where i.code = v_code);
  end loop;
  insert into public.agent_invites (code, full_name, username, phone, area_ids, comp_type, comp_amount, created_by)
  values (v_code, trim(p_full_name), uname, p_phone, p_area_ids, p_comp_type, case when p_comp_type = 'none' then 0 else p_comp_amount end, me.id);
  perform public._audit(me, 'create_invite', 'agent_invite', v_code, 'رمز دعوة للمعتمد ' || trim(p_full_name));
  return jsonb_build_object('code', v_code, 'username', uname, 'expires_at', now() + interval '7 days');
end $$;

-- Safe to call before login: reveals only the name/username for a valid code.
create or replace function public.invite_info(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('full_name', full_name, 'username', username)
  from public.agent_invites
  where code = upper(trim(p_code)) and claimed_at is null and revoked_at is null and expires_at > now()
$$;

-- Called by the agent right after signing up with <username>@agents.tahseel.app.
create or replace function public.claim_agent_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv public.agent_invites; uid uuid := auth.uid(); email text; a uuid; prof public.profiles;
begin
  if uid is null then perform public._fail('يجب إنشاء الحساب أولاً'); end if;
  select * into inv from public.agent_invites where code = upper(trim(p_code)) for update;
  if not found or inv.revoked_at is not null or inv.expires_at <= now() then perform public._fail('رمز الدعوة غير صالح أو منتهي'); end if;
  if inv.claimed_at is not null then perform public._fail('تم استخدام رمز الدعوة مسبقاً'); end if;
  if exists (select 1 from public.profiles where id = uid) then perform public._fail('هذا الحساب مفعّل مسبقاً'); end if;
  select u.email into email from auth.users u where u.id = uid;
  if lower(split_part(coalesce(email, ''), '@', 1)) <> inv.username then perform public._fail('اسم الدخول لا يطابق رمز الدعوة'); end if;
  insert into public.profiles (id, role, full_name, username, phone, comp_type, comp_amount)
  values (uid, 'agent', inv.full_name, inv.username, inv.phone, inv.comp_type, inv.comp_amount)
  returning * into prof;
  foreach a in array inv.area_ids loop
    if (public._area_agent(a)).id is not null then perform public._fail('إحدى المناطق أصبحت مرتبطة بمعتمد آخر — اطلب رمزاً جديداً'); end if;
    insert into public.agent_areas (agent_id, area_id) values (uid, a);
  end loop;
  update public.agent_invites set claimed_by = uid, claimed_at = now() where code = inv.code;
  perform public._audit(prof, 'claim_invite', 'profile', uid::text, 'تفعيل حساب المعتمد ' || inv.full_name);
  return jsonb_build_object('ok', true, 'full_name', inv.full_name);
end $$;

create or replace function public.revoke_agent_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager();
begin
  update public.agent_invites set revoked_at = now() where code = p_code and claimed_at is null and revoked_at is null;
  if not found then perform public._fail('الرمز غير موجود أو مستخدم'); end if;
  perform public._audit(me, 'revoke_invite', 'agent_invite', p_code, 'إلغاء رمز دعوة');
end $$;

create or replace function public.set_agent_areas(p_agent_id uuid, p_area_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); a uuid; ag public.profiles; other public.profiles;
begin
  select * into ag from public.profiles where id = p_agent_id and role = 'agent';
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  foreach a in array coalesce(p_area_ids, '{}') loop
    other := public._area_agent(a);
    if other.id is not null and other.id <> p_agent_id then
      perform public._fail('المنطقة ' || (select name from public.areas where id = a) || ' مرتبطة بالمعتمد ' || other.full_name);
    end if;
  end loop;
  delete from public.agent_areas where agent_id = p_agent_id and not (area_id = any (coalesce(p_area_ids, '{}')));
  insert into public.agent_areas (agent_id, area_id) select p_agent_id, x from unnest(coalesce(p_area_ids, '{}')) x
  on conflict do nothing;
  perform public._audit(me, 'set_agent_areas', 'profile', p_agent_id::text, 'تعديل مناطق المعتمد ' || ag.full_name);
end $$;

create or replace function public.set_agent_active(p_agent_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); ag public.profiles;
begin
  update public.profiles set active = p_active where id = p_agent_id and role = 'agent' returning * into ag;
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  if not p_active then delete from public.agent_areas where agent_id = p_agent_id; end if;
  perform public._audit(me, case when p_active then 'enable_agent' else 'disable_agent' end, 'profile', p_agent_id::text,
    case when p_active then 'تفعيل المعتمد ' else 'إيقاف المعتمد ' end || ag.full_name);
end $$;

create or replace function public.set_agent_compensation(p_agent_id uuid, p_type text, p_amount bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); ag public.profiles;
begin
  if p_type not in ('none', 'monthly_salary', 'per_invoice') or coalesce(p_amount, 0) < 0 then perform public._fail('تعويض غير صحيح'); end if;
  update public.profiles set comp_type = p_type, comp_amount = case when p_type = 'none' then 0 else p_amount end
  where id = p_agent_id and role = 'agent' returning * into ag;
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  perform public._audit(me, 'set_compensation', 'profile', p_agent_id::text, 'تعويض ' || ag.full_name || ': ' || p_type || ' ' || public._fmt(p_amount));
end $$;

/* ======================= billing months ======================= */

create or replace function public.open_month(p_month text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); n int; total bigint;
begin
  if not public._valid_month(p_month) then perform public._fail('شهر غير صحيح'); end if;
  insert into public.billing_months (month, opened_by) values (p_month, me.id) on conflict do nothing;
  with ins as (
    insert into public.invoices (subscriber_id, area_id, month, amount, package_label)
    select s.id, s.area_id, p_month, case when s.standing_exempt then 0 else s.monthly_amount end, s.package_label
    from public.subscribers s
    where s.monthly_amount is not null
      and (s.status = 'active' or (s.status = 'disconnected' and s.disconnected_from > p_month))
      and not exists (select 1 from public.invoices i where i.subscriber_id = s.id and i.month = p_month)
    returning amount
  ) select count(*), coalesce(sum(amount), 0) into n, total from ins;
  if n > 0 then perform public._audit(me, 'open_month', 'invoice', p_month, 'إصدار ' || n || ' فاتورة لشهر ' || p_month || ' بقيمة ' || public._fmt(total)); end if;
  return jsonb_build_object('issued', n, 'total', total,
    'no_price', (select count(*) from public.subscribers where status = 'active' and monthly_amount is null));
end $$;

/* ======================= payments ======================= */

-- The agent's only write: "تم الدفع" for the full remaining invoice. Cannot be undone by the agent.
create or replace function public.agent_mark_paid(p_subscriber_id uuid, p_month text, p_client_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_agent(); st record; pay public.payments; area_name text;
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select * into pay from public.payments where client_key = p_client_key;
  if found then
    if pay.recorded_by <> me.id then perform public._fail('طلب غير صالح'); end if;
    return jsonb_build_object('payment_id', pay.id, 'amount', pay.amount, 'repeated', true);
  end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if not (st.area_id in (select public.my_area_ids())) then perform public._fail('هذا المشترك ليس من منطقتك'); end if;
  if st.remaining <= 0 then perform public._fail(st.full_name || ': مدفوع مسبقاً'); end if;
  insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, client_key, recorded_by)
  values (st.invoice_id, p_subscriber_id, st.area_id, p_month, st.remaining, 'agent_cash', me.id, p_client_key, me.id)
  returning * into pay;
  select name into area_name from public.areas where id = st.area_id;
  insert into public.notifications (kind, title, body, area_id, agent_id, payment_id)
  values ('agent_payment', 'دفعة جديدة — ' || area_name,
          st.full_name || ' دفع فاتورته (' || public._fmt(st.remaining) || ' ل.س) للمعتمد ' || me.full_name,
          st.area_id, me.id, pay.id);
  perform public._audit(me, 'agent_payment', 'payment', pay.id::text, 'تم الدفع: ' || st.full_name || ' — ' || public._fmt(st.remaining));
  return jsonb_build_object('payment_id', pay.id, 'amount', st.remaining, 'repeated', false);
end $$;

-- Manager: full or partial payment, any method. agent_cash is attributed to the area's agent.
create or replace function public.manager_record_payment(
  p_subscriber_id uuid, p_month text, p_amount bigint, p_method text, p_client_key text,
  p_reference text default null, p_paid_on date default current_date, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); st record; pay public.payments; amt bigint; ag public.profiles; ref text := nullif(trim(p_reference), '');
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select * into pay from public.payments where client_key = p_client_key;
  if found then return jsonb_build_object('payment_id', pay.id, 'amount', pay.amount, 'repeated', true); end if;
  if p_method not in ('agent_cash', 'manager_cash', 'shamcash') then perform public._fail('طريقة دفع غير صحيحة'); end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if st.remaining <= 0 then perform public._fail(st.full_name || ': مدفوع مسبقاً'); end if;
  amt := coalesce(p_amount, st.remaining);
  if amt <= 0 then perform public._fail('المبلغ يجب أن يكون أكبر من صفر'); end if;
  if amt > st.remaining then perform public._fail('المبلغ ' || public._fmt(amt) || ' أكبر من المتبقي ' || public._fmt(st.remaining)); end if;
  if p_method = 'agent_cash' then
    ag := public._area_agent(st.area_id);
    if ag.id is null then perform public._fail('هذه المنطقة بدون معتمد — اختر «نقداً للمدير»'); end if;
  end if;
  if ref is not null and exists (select 1 from public.payments where reference = ref and reversal_of is null and reversed_by is null) then
    perform public._fail('رقم العملية مسجّل مسبقاً');
  end if;
  insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, reference, paid_on, notes, client_key, recorded_by)
  values (st.invoice_id, p_subscriber_id, st.area_id, p_month, amt, p_method, ag.id, ref, coalesce(p_paid_on, current_date), nullif(trim(p_notes), ''), p_client_key, me.id)
  returning * into pay;
  perform public._audit(me, 'manager_payment', 'payment', pay.id::text, 'دفعة ' || public._fmt(amt) || ' — ' || st.full_name || ' (' || p_method || ')');
  return jsonb_build_object('payment_id', pay.id, 'amount', amt, 'repeated', false);
end $$;

-- Generic reversal for append-only tables (manager only).
create or replace function public.manager_reverse(p_kind text, p_id uuid, p_reason text, p_client_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); tbl text; orig jsonb; rev_id uuid := gen_random_uuid(); reason text := trim(coalesce(p_reason, ''));
begin
  if reason = '' then perform public._fail('سبب التصحيح مطلوب'); end if;
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  tbl := case p_kind when 'payment' then 'payments' when 'exemption' then 'exemptions' when 'agent_tx' then 'agent_transactions' end;
  if tbl is null then perform public._fail('نوع غير صحيح'); end if;
  execute format('select to_jsonb(t) from public.%I t where client_key = $1', tbl) into orig using p_client_key;
  if orig is not null then return jsonb_build_object('reversal_id', orig ->> 'id', 'repeated', true); end if;
  execute format('select to_jsonb(t) from public.%I t where id = $1 for update', tbl) into orig using p_id;
  if orig is null then perform public._fail('القيد غير موجود'); end if;
  if orig ->> 'reversal_of' is not null then perform public._fail('لا يمكن تصحيح قيد تصحيح'); end if;
  if orig ->> 'reversed_by' is not null then perform public._fail('تم تصحيح هذا القيد مسبقاً'); end if;
  if tbl = 'payments' then
    insert into public.payments (id, invoice_id, subscriber_id, area_id, month, amount, method, agent_id, paid_on, notes, client_key, recorded_by, reversal_of)
    select rev_id, invoice_id, subscriber_id, area_id, month, -amount, method, agent_id, current_date, 'تصحيح: ' || reason, p_client_key, me.id, id
    from public.payments where id = p_id;
    update public.payments set reversed_by = rev_id where id = p_id;
  elsif tbl = 'exemptions' then
    insert into public.exemptions (id, invoice_id, subscriber_id, area_id, month, amount, reason, client_key, recorded_by, reversal_of)
    select rev_id, invoice_id, subscriber_id, area_id, month, -amount, 'تصحيح: ' || reason, p_client_key, me.id, id
    from public.exemptions where id = p_id;
    update public.exemptions set reversed_by = rev_id where id = p_id;
  else
    insert into public.agent_transactions (id, agent_id, area_id, month, type, amount, paid_on, notes, client_key, recorded_by, reversal_of)
    select rev_id, agent_id, area_id, month, type, -amount, current_date, 'تصحيح: ' || reason, p_client_key, me.id, id
    from public.agent_transactions where id = p_id;
    update public.agent_transactions set reversed_by = rev_id where id = p_id;
  end if;
  perform public._audit(me, 'reverse_' || p_kind, p_kind, p_id::text, 'تصحيح ' || public._fmt((orig ->> 'amount')::bigint) || ' — ' || reason);
  return jsonb_build_object('reversal_id', rev_id, 'repeated', false);
end $$;

/* ======================= subscriber management (manager) ======================= */

create or replace function public.set_month_exempt(p_subscriber_id uuid, p_month text, p_reason text, p_client_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); st record; ex public.exemptions;
begin
  if trim(coalesce(p_reason, '')) = '' then perform public._fail('سبب الإعفاء مطلوب'); end if;
  select * into ex from public.exemptions where client_key = p_client_key;
  if found then return jsonb_build_object('exemption_id', ex.id, 'repeated', true); end if;
  select * into st from public._invoice_for_update(p_subscriber_id, p_month);
  if st.remaining <= 0 then perform public._fail('لا يوجد مبلغ متبقٍ للإعفاء'); end if;
  insert into public.exemptions (invoice_id, subscriber_id, area_id, month, amount, reason, client_key, recorded_by)
  values (st.invoice_id, p_subscriber_id, st.area_id, p_month, st.remaining, trim(p_reason), p_client_key, me.id) returning * into ex;
  perform public._audit(me, 'exempt_month', 'exemption', ex.id::text, 'إعفاء ' || st.full_name || ' لشهر ' || p_month || ' — ' || trim(p_reason));
  return jsonb_build_object('exemption_id', ex.id, 'amount', st.remaining, 'repeated', false);
end $$;

-- Edit a subscriber. Speed sets the price (Mbps × price_per_mbps). If p_apply_month is given and
-- that invoice has no payment/exemption yet, it is re-priced too; otherwise the change starts next month.
create or replace function public.update_subscriber(
  p_id uuid, p_full_name text, p_father_name text, p_phone text, p_speed_mbps numeric,
  p_standing_exempt boolean, p_notes text, p_apply_month text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); old public.subscribers; new_amount bigint; rate bigint; inv public.invoices; repriced boolean := false; v_speed numeric;
begin
  select * into old from public.subscribers where id = p_id for update;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  if coalesce(trim(p_full_name), '') = '' then perform public._fail('الاسم مطلوب'); end if;
  if p_speed_mbps is not null and (p_speed_mbps <= 0 or p_speed_mbps > 1000) then perform public._fail('السرعة غير صحيحة'); end if;
  rate := (select value::bigint from public.settings where key = 'price_per_mbps');
  v_speed := coalesce(p_speed_mbps, old.speed_mbps);
  new_amount := case when coalesce(p_standing_exempt, false) then 0
                     when v_speed is not null then round(v_speed * rate)::bigint
                     when old.standing_exempt then null   -- was SPF with no speed: price unknown until a speed is set
                     else old.monthly_amount end;
  update public.subscribers set
    full_name = trim(p_full_name), father_name = nullif(trim(p_father_name), ''), phone = nullif(trim(p_phone), ''),
    speed_mbps = coalesce(p_speed_mbps, speed_mbps),
    package_label = case when coalesce(p_standing_exempt, false) then 'SPF' when v_speed is not null then trim_scale(v_speed)::text || 'M' else package_label end,
    monthly_amount = new_amount, standing_exempt = coalesce(p_standing_exempt, false), notes = nullif(trim(p_notes), ''), updated_at = now()
  where id = p_id;
  if p_apply_month is not null and new_amount is not null then
    select * into inv from public.invoices where subscriber_id = p_id and month = p_apply_month for update;
    if found and inv.amount <> new_amount
       and not exists (select 1 from public.payments where invoice_id = inv.id)
       and not exists (select 1 from public.exemptions where invoice_id = inv.id) then
      update public.invoices set amount = new_amount where id = inv.id;
      repriced := true;
    end if;
  end if;
  perform public._audit(me, 'update_subscriber', 'subscriber', p_id::text,
    'تعديل ' || trim(p_full_name) || coalesce(' — السعر ' || public._fmt(old.monthly_amount) || ' → ' || public._fmt(new_amount), '')
    || case when repriced then ' (طُبّق على فاتورة ' || p_apply_month || ')' else '' end);
  return jsonb_build_object('monthly_amount', new_amount, 'repriced', repriced);
end $$;

create or replace function public.disconnect_subscriber(p_id uuid, p_from_month text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); s public.subscribers;
begin
  if not public._valid_month(p_from_month) then perform public._fail('شهر غير صحيح'); end if;
  update public.subscribers set status = 'disconnected', disconnected_from = p_from_month, updated_at = now() where id = p_id returning * into s;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  perform public._audit(me, 'disconnect', 'subscriber', p_id::text, 'فك اشتراك ' || s.full_name || ' اعتباراً من ' || p_from_month);
end $$;

create or replace function public.reconnect_subscriber(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); s public.subscribers;
begin
  update public.subscribers set status = 'active', disconnected_from = null, updated_at = now() where id = p_id returning * into s;
  if not found then perform public._fail('المشترك غير موجود'); end if;
  perform public._audit(me, 'reconnect', 'subscriber', p_id::text, 'إعادة تفعيل ' || s.full_name);
end $$;

create or replace function public.add_subscriber(
  p_area_id uuid, p_full_name text, p_father_name text, p_phone text, p_username text, p_speed_mbps numeric, p_standing_exempt boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); rate bigint; amt bigint; s public.subscribers; seq int;
begin
  if coalesce(trim(p_full_name), '') = '' then perform public._fail('الاسم مطلوب'); end if;
  if not exists (select 1 from public.areas where id = p_area_id) then perform public._fail('المنطقة غير موجودة'); end if;
  rate := (select value::bigint from public.settings where key = 'price_per_mbps');
  amt := case when coalesce(p_standing_exempt, false) then 0 when p_speed_mbps is null then null else round(p_speed_mbps * rate)::bigint end;
  seq := coalesce((select max(substring(code from 3)::int) from public.subscribers where code ~ '^S-\d+$'), 0) + 1;
  insert into public.subscribers (code, full_name, father_name, phone, username, area_id, speed_mbps, package_label, monthly_amount, standing_exempt)
  values ('S-' || lpad(seq::text, 4, '0'), trim(p_full_name), nullif(trim(p_father_name), ''), nullif(trim(p_phone), ''), nullif(trim(p_username), ''),
          p_area_id, p_speed_mbps,
          case when coalesce(p_standing_exempt, false) then 'SPF' when p_speed_mbps is not null then trim_scale(p_speed_mbps)::text || 'M' end,
          amt, coalesce(p_standing_exempt, false))
  returning * into s;
  perform public._audit(me, 'add_subscriber', 'subscriber', s.id::text, 'إضافة مشترك ' || s.full_name);
  return jsonb_build_object('id', s.id, 'code', s.code);
end $$;

/* ======================= agent cash (manager) ======================= */

create or replace function public.record_agent_tx(
  p_agent_id uuid, p_area_id uuid, p_month text, p_type text, p_amount bigint, p_client_key text,
  p_paid_on date default current_date, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); t public.agent_transactions; ag public.profiles;
begin
  if coalesce(length(p_client_key), 0) < 8 then perform public._fail('طلب غير صالح'); end if;
  select * into t from public.agent_transactions where client_key = p_client_key;
  if found then return jsonb_build_object('id', t.id, 'repeated', true); end if;
  if not public._valid_month(p_month) then perform public._fail('شهر غير صحيح'); end if;
  if p_type not in ('delivery', 'deduction', 'salary_paid') then perform public._fail('نوع الحركة غير صحيح'); end if;
  if coalesce(p_amount, 0) <= 0 then perform public._fail('المبلغ يجب أن يكون أكبر من صفر'); end if;
  select * into ag from public.profiles where id = p_agent_id and role = 'agent';
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  insert into public.agent_transactions (agent_id, area_id, month, type, amount, paid_on, notes, client_key, recorded_by)
  values (p_agent_id, p_area_id, p_month, p_type, p_amount, coalesce(p_paid_on, current_date), nullif(trim(p_notes), ''), p_client_key, me.id)
  returning * into t;
  perform public._audit(me, 'agent_tx', 'agent_transaction', t.id::text,
    case p_type when 'delivery' then 'تسليم من ' when 'deduction' then 'اقتطاع تعويض ' else 'راتب منفصل لـ ' end || ag.full_name || ': ' || public._fmt(p_amount));
  return jsonb_build_object('id', t.id, 'repeated', false);
end $$;

/* ======================= notifications ======================= */

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); n int;
begin
  update public.notifications set read_at = now() where read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

/* ======================= import (manager, before any invoice) ======================= */

-- p_rows: [{full_name, father_name, username, phone, area, speed_mbps, package_label, monthly_amount,
--          standing_exempt, source_sheet, source_row, flags[]}]
create or replace function public.import_subscribers(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_manager(); r jsonb; area_id uuid; n int := 0; seq int := 0; ord int := 0; uname text;
begin
  if exists (select 1 from public.invoices) then perform public._fail('لا يمكن الاستيراد بعد إصدار الفواتير'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform public._fail('لا يوجد مشتركون للاستيراد'); end if;
  delete from public.subscribers;
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into area_id from public.areas where name = r ->> 'area' or (r ->> 'area') = any (aliases);
    if area_id is null then
      ord := ord + 1;
      insert into public.areas (name, sort_order) values (r ->> 'area', ord) returning id into area_id;
    end if;
    seq := seq + 1;
    uname := nullif(trim(r ->> 'username'), '');
    if uname is not null and exists (select 1 from public.subscribers where lower(username) = lower(uname)) then uname := null; end if;
    insert into public.subscribers (code, full_name, father_name, username, phone, area_id, speed_mbps, package_label, monthly_amount,
      standing_exempt, source_sheet, source_row, import_flags)
    values ('S-' || lpad(seq::text, 4, '0'), trim(r ->> 'full_name'), nullif(trim(r ->> 'father_name'), ''), uname, nullif(trim(r ->> 'phone'), ''),
      area_id, (r ->> 'speed_mbps')::numeric, r ->> 'package_label', (r ->> 'monthly_amount')::bigint,
      coalesce((r ->> 'standing_exempt')::boolean, false), r ->> 'source_sheet', (r ->> 'source_row')::int,
      coalesce(array(select jsonb_array_elements_text(r -> 'flags')), '{}'));
    n := n + 1;
  end loop;
  perform public._audit(me, 'import', 'subscriber', null, 'استيراد ' || n || ' مشترك من ملف Excel');
  return jsonb_build_object('imported', n, 'areas', (select count(*) from public.areas));
end $$;

/* ======================= read models ======================= */

-- Subscriber rows with this month's invoice state. Manager: any area. Agent: own areas only.
create or replace function public.area_subscribers(p_month text, p_area_id uuid default null)
returns table (
  id uuid, code text, full_name text, father_name text, username text, phone text, area_id uuid, area_name text,
  package_label text, monthly_amount bigint, sub_status text, invoice_id uuid, amount bigint, paid bigint, exempt bigint,
  remaining bigint, status text, paid_by_agent boolean, last_paid_at timestamptz
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
      (select max(p.created_at) from public.payments p where p.invoice_id = i.id and p.reversal_of is null and p.reversed_by is null) as last_paid
    from public.invoices i where i.month = p_month
  )
  select s.id, s.code, s.full_name, s.father_name, s.username, s.phone, s.area_id, a.name, s.package_label, s.monthly_amount, s.status,
    inv.id, inv.amount, coalesce(inv.paid, 0), coalesce(inv.exempt, 0),
    case when inv.id is null then 0 else greatest(0, inv.amount - inv.paid - inv.exempt) end::bigint,
    case
      when inv.id is null then case when s.monthly_amount is null then 'no_price' when s.status = 'disconnected' then 'disconnected' else 'no_invoice' end
      when inv.amount = 0 or (inv.exempt > 0 and inv.paid + inv.exempt >= inv.amount) then 'exempt'
      when inv.paid >= inv.amount then 'paid'
      when inv.paid > 0 or inv.exempt > 0 then 'partial'
      else 'unpaid' end,
    coalesce(inv.by_agent, false), inv.last_paid
  from public.subscribers s
  join public.areas a on a.id = s.area_id
  left join inv on inv.subscriber_id = s.id
  where s.area_id in (select scope.id from scope)
    and (inv.id is not null or s.status = 'active')
  order by a.sort_order, s.full_name;
end $$;

create or replace function public.area_overview(p_month text)
returns table (
  area_id uuid, area_name text, agent_id uuid, agent_name text, subscribers bigint, expected bigint, paid bigint, exempt bigint, remaining bigint,
  paid_count bigint, unpaid_count bigint, partial_count bigint, exempt_count bigint
) language sql stable security definer set search_path = public as $$
  select r.area_id, r.area_name, ag.id, ag.full_name, count(*),
    coalesce(sum(r.amount), 0)::bigint, coalesce(sum(r.paid), 0)::bigint, coalesce(sum(r.exempt), 0)::bigint, coalesce(sum(r.remaining), 0)::bigint,
    count(*) filter (where r.status = 'paid'), count(*) filter (where r.status = 'unpaid'),
    count(*) filter (where r.status = 'partial'), count(*) filter (where r.status = 'exempt')
  from public.area_subscribers(p_month) r
  left join lateral (select p.id, p.full_name from public.agent_areas aa join public.profiles p on p.id = aa.agent_id where aa.area_id = r.area_id and p.active limit 1) ag on true
  group by r.area_id, r.area_name, ag.id, ag.full_name
  order by min((select sort_order from public.areas where id = r.area_id)), r.area_name
$$;

-- "شو واصل للمعتمد مصاري" — per agent and area for a month.
create or replace function public.agent_cash(p_month text)
returns table (
  agent_id uuid, agent_name text, area_id uuid, area_name text, collected bigint, collected_count bigint,
  delivered bigint, deductions bigint, holding bigint
) language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_manager() or public.is_agent()) then perform public._fail('غير مصرح'); end if;
  return query
  select p.id, p.full_name, a.id, a.name,
    coalesce((select sum(x.amount) from public.payments x where x.agent_id = p.id and x.area_id = a.id and x.month = p_month and x.method = 'agent_cash'), 0)::bigint,
    coalesce((select count(*) from public.payments x where x.agent_id = p.id and x.area_id = a.id and x.month = p_month and x.method = 'agent_cash' and x.reversal_of is null and x.reversed_by is null), 0)::bigint,
    coalesce((select sum(t.amount) from public.agent_transactions t where t.agent_id = p.id and t.area_id = a.id and t.month = p_month and t.type = 'delivery'), 0)::bigint,
    coalesce((select sum(t.amount) from public.agent_transactions t where t.agent_id = p.id and t.area_id = a.id and t.month = p_month and t.type = 'deduction'), 0)::bigint,
    (coalesce((select sum(x.amount) from public.payments x where x.agent_id = p.id and x.area_id = a.id and x.month = p_month and x.method = 'agent_cash'), 0)
     - coalesce((select sum(t.amount) from public.agent_transactions t where t.agent_id = p.id and t.area_id = a.id and t.month = p_month and t.type in ('delivery', 'deduction')), 0))::bigint
  from public.profiles p
  join public.agent_areas aa on aa.agent_id = p.id
  join public.areas a on a.id = aa.area_id
  where p.role = 'agent' and (public.is_manager() or p.id = auth.uid())
  order by p.full_name, a.sort_order;
end $$;

-- Compensation due for an agent/month. per_invoice: an invoice counts once, in the month (payment date)
-- it became fully paid, if any live payment toward it went through this agent.
create or replace function public.agent_compensation(p_agent_id uuid, p_month text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ag public.profiles; n bigint := 0; due bigint; deducted bigint; paid_sep bigint;
begin
  if not (public.is_manager() or p_agent_id = auth.uid()) then perform public._fail('غير مصرح'); end if;
  select * into ag from public.profiles where id = p_agent_id and role = 'agent';
  if not found then perform public._fail('المعتمد غير موجود'); end if;
  if ag.comp_type = 'per_invoice' then
    with live as (
      select p.invoice_id, p.amount, p.created_at, i.amount as inv_amount,
        sum(p.amount) over (partition by p.invoice_id order by p.created_at, p.id) as cum
      from public.payments p join public.invoices i on i.id = p.invoice_id
      where p.reversal_of is null and p.reversed_by is null and i.amount > 0
        and p.invoice_id in (select invoice_id from public.payments where agent_id = p_agent_id and method = 'agent_cash' and reversal_of is null and reversed_by is null)
    ), completion as (
      select invoice_id, min(created_at) as done_at from live where cum >= inv_amount group by invoice_id
    )
    select count(*) into n from completion where to_char(done_at at time zone 'Asia/Damascus', 'YYYY-MM') = p_month;
  end if;
  due := case ag.comp_type when 'monthly_salary' then ag.comp_amount when 'per_invoice' then n * ag.comp_amount else 0 end;
  select coalesce(sum(amount) filter (where type = 'deduction'), 0), coalesce(sum(amount) filter (where type = 'salary_paid'), 0)
    into deducted, paid_sep
  from public.agent_transactions where agent_id = p_agent_id and month = p_month and type in ('deduction', 'salary_paid');
  return jsonb_build_object('type', ag.comp_type, 'rate', ag.comp_amount, 'invoices', n, 'due', due,
    'deducted', deducted, 'paid_separately', paid_sep, 'remaining', greatest(0, due - deducted - paid_sep));
end $$;

/* ======================= grants ======================= */

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.invite_info(text) to anon, authenticated;
grant execute on function
  public.is_manager(), public.is_agent(), public.my_area_ids(), public.my_profile(),
  public.claim_agent_invite(text),
  public.create_agent_invite(text, text, uuid[], text, text, bigint), public.revoke_agent_invite(text),
  public.set_agent_areas(uuid, uuid[]), public.set_agent_active(uuid, boolean), public.set_agent_compensation(uuid, text, bigint),
  public.open_month(text),
  public.agent_mark_paid(uuid, text, text),
  public.manager_record_payment(uuid, text, bigint, text, text, text, date, text),
  public.manager_reverse(text, uuid, text, text),
  public.set_month_exempt(uuid, text, text, text),
  public.update_subscriber(uuid, text, text, text, numeric, boolean, text, text),
  public.disconnect_subscriber(uuid, text), public.reconnect_subscriber(uuid),
  public.add_subscriber(uuid, text, text, text, text, numeric, boolean),
  public.record_agent_tx(uuid, uuid, text, text, bigint, text, date, text),
  public.mark_notifications_read(bigint[]),
  public.import_subscribers(jsonb),
  public.area_subscribers(text, uuid), public.area_overview(text), public.agent_cash(text), public.agent_compensation(uuid, text)
to authenticated;
