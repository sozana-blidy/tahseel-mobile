-- Manager feedback (Nov 2026):
-- 1) no notification per agent payment (800+/month) — replaced by a daily summary per area
-- 2) the subscriber list shows how a paid invoice was paid (agent / Sham Cash / manager cash)
-- 3) daily summary + the day's payments of one area (tap target of a summary line)

create or replace function public.agent_mark_paid(p_subscriber_id uuid, p_month text, p_client_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_agent(); st record; pay public.payments;
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
  perform public._audit(me, 'agent_payment', 'payment', pay.id::text, 'تم الدفع: ' || st.full_name || ' — ' || public._fmt(st.remaining));
  return jsonb_build_object('payment_id', pay.id, 'amount', st.remaining, 'repeated', false);
end $$;

-- Return type changes (new column paid_via) → drop and recreate.
drop function if exists public.area_subscribers(text, uuid);

create or replace function public.area_subscribers(p_month text, p_area_id uuid default null)
returns table (
  id uuid, code text, full_name text, father_name text, username text, phone text, area_id uuid, area_name text,
  package_label text, monthly_amount bigint, sub_status text, invoice_id uuid, amount bigint, paid bigint, exempt bigint,
  remaining bigint, status text, paid_by_agent boolean, last_paid_at timestamptz,
  paid_via text
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
      (select string_agg(distinct p.method, ',' order by p.method) from public.payments p where p.invoice_id = i.id and p.reversal_of is null and p.reversed_by is null) as via
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
    coalesce(inv.by_agent, false), inv.last_paid, inv.via
  from public.subscribers s
  join public.areas a on a.id = s.area_id
  left join inv on inv.subscriber_id = s.id
  where s.area_id in (select scope.id from scope)
    and (inv.id is not null or s.status = 'active')
  order by a.sort_order, s.full_name;
end $$;

-- One line per (day, area): money that reached the area's agent that day (Damascus time).
-- Reversal rows count on the day they were made, so a corrected mistake nets out.
create or replace function public.daily_collections(p_days int default 14)
returns table (day date, area_id uuid, area_name text, agent_id uuid, agent_name text, amount bigint, invoices bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query
  select (p.created_at at time zone 'Asia/Damascus')::date as d, a.id, a.name, g.id, g.full_name,
         sum(p.amount)::bigint, count(*) filter (where p.reversal_of is null and p.reversed_by is null)::bigint
  from public.payments p
  join public.areas a on a.id = p.area_id
  left join public.profiles g on g.id = p.agent_id
  where p.method = 'agent_cash'
    and p.created_at >= ((now() at time zone 'Asia/Damascus')::date - greatest(coalesce(p_days, 14), 1) + 1)::timestamp at time zone 'Asia/Damascus'
  group by d, a.id, a.name, a.sort_order, g.id, g.full_name
  having sum(p.amount) <> 0 or count(*) filter (where p.reversal_of is null and p.reversed_by is null) > 0
  order by d desc, a.sort_order, a.name;
end $$;

-- The live agent payments behind one summary line.
create or replace function public.day_payments(p_area_id uuid, p_day date)
returns table (payment_id uuid, subscriber_id uuid, full_name text, father_name text, package_label text,
               month text, amount bigint, created_at timestamptz, agent_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_manager();
  return query
  select p.id, s.id, s.full_name, s.father_name, s.package_label, p.month, p.amount, p.created_at, g.full_name
  from public.payments p
  join public.subscribers s on s.id = p.subscriber_id
  left join public.profiles g on g.id = p.agent_id
  where p.area_id = p_area_id and p.method = 'agent_cash'
    and p.reversal_of is null and p.reversed_by is null
    and (p.created_at at time zone 'Asia/Damascus')::date = p_day
  order by p.created_at desc;
end $$;

revoke execute on function public.area_subscribers(text, uuid), public.daily_collections(int), public.day_payments(uuid, date) from public, anon;
grant execute on function public.area_subscribers(text, uuid), public.daily_collections(int), public.day_payments(uuid, date) to authenticated;
