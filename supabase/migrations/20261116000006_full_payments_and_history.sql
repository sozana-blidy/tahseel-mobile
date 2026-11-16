-- Manager feedback (16 Nov 2026):
-- 1) No partial payments. A subscriber either paid the full invoice or did not.
--    - manager_record_payment accepts only the full remaining amount (p_amount null or equal to it).
--    - area_subscribers never returns 'partial': an invoice with money still due is 'unpaid'
--      (legacy part-paid invoices show as unpaid with the remaining amount).
--    - area_overview loses partial_count (return type change → drop and recreate).
-- 2) subscriber_history: last 3 billing months of one subscriber, manager only.

/* ======================= 1. full payments only ======================= */

-- Manager: full remaining invoice only, any method. agent_cash is attributed to the area's agent.
-- Signature unchanged (p_amount kept for compatibility; null = full remaining).
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
  if p_amount is not null and p_amount <> st.remaining then
    perform public._fail('تُدفع الفاتورة كاملة فقط: ' || public._fmt(st.remaining));
  end if;
  amt := st.remaining;
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

-- Same return type as 0005; only the status rule changes (no 'partial').
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
      else 'unpaid' end,
    coalesce(inv.by_agent, false), inv.last_paid, inv.via
  from public.subscribers s
  join public.areas a on a.id = s.area_id
  left join inv on inv.subscriber_id = s.id
  where s.area_id in (select scope.id from scope)
    and (inv.id is not null or s.status = 'active')
  order by a.sort_order, s.full_name;
end $$;

drop function if exists public.area_overview(text);

create function public.area_overview(p_month text)
returns table (
  area_id uuid, area_name text, agent_id uuid, agent_name text, subscribers bigint, expected bigint, paid bigint, exempt bigint, remaining bigint,
  paid_count bigint, unpaid_count bigint, exempt_count bigint
) language sql stable security definer set search_path = public as $$
  select r.area_id, r.area_name, ag.id, ag.full_name, count(*),
    coalesce(sum(r.amount), 0)::bigint, coalesce(sum(r.paid), 0)::bigint, coalesce(sum(r.exempt), 0)::bigint, coalesce(sum(r.remaining), 0)::bigint,
    count(*) filter (where r.status = 'paid'), count(*) filter (where r.status = 'unpaid'), count(*) filter (where r.status = 'exempt')
  from public.area_subscribers(p_month) r
  left join lateral (select p.id, p.full_name from public.agent_areas aa join public.profiles p on p.id = aa.agent_id where aa.area_id = r.area_id and p.active limit 1) ag on true
  group by r.area_id, r.area_name, ag.id, ag.full_name
  order by min((select sort_order from public.areas where id = r.area_id)), r.area_name
$$;

revoke execute on function public.area_overview(text) from public, anon;
grant execute on function public.area_overview(text) to authenticated;

/* ======================= 2. subscriber history (manager only) ======================= */

-- The 3 most recent billing months for one subscriber. status: paid | unpaid | exempt | no_invoice.
-- paid_amount is net (reversals included); paid_at / recorded_by come from the latest live payment;
-- paid_at is Damascus wall time "YYYY-MM-DD HH24:MI". Agents are refused by _require_manager.
create or replace function public.subscriber_history(p_subscriber_id uuid)
returns table (month text, invoice_amount bigint, status text, paid_amount bigint, paid_at text, method text, recorded_by text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public._require_manager();
  if not exists (select 1 from public.subscribers s where s.id = p_subscriber_id) then perform public._fail('المشترك غير موجود'); end if;
  return query
  with months as (
    select bm.month as m from public.billing_months bm order by bm.month desc limit 3
  ), inv as (
    select ms.m, i.id as invoice_id, i.amount as inv_amount,
      coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)::bigint as paid,
      coalesce((select sum(e.amount) from public.exemptions e where e.invoice_id = i.id), 0)::bigint as exempt
    from months ms
    left join public.invoices i on i.subscriber_id = p_subscriber_id and i.month = ms.m
  ), last_pay as (
    select distinct on (p.invoice_id) p.invoice_id, p.created_at, pr.full_name as who
    from public.payments p
    left join public.profiles pr on pr.id = p.recorded_by
    where p.invoice_id in (select x.invoice_id from inv x where x.invoice_id is not null)
      and p.reversal_of is null and p.reversed_by is null
    order by p.invoice_id, p.created_at desc
  )
  select inv.m,
    inv.inv_amount,
    case
      when inv.invoice_id is null then 'no_invoice'
      when inv.inv_amount = 0 or (inv.exempt > 0 and inv.paid + inv.exempt >= inv.inv_amount) then 'exempt'
      when inv.paid >= inv.inv_amount then 'paid'
      else 'unpaid' end,
    case when inv.invoice_id is null then null else inv.paid end,
    to_char(lp.created_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI'),
    (select string_agg(distinct p.method, ',' order by p.method) from public.payments p
      where p.invoice_id = inv.invoice_id and p.reversal_of is null and p.reversed_by is null),
    lp.who
  from inv
  left join last_pay lp on lp.invoice_id = inv.invoice_id
  order by inv.m desc;
end $$;

revoke execute on function public.subscriber_history(uuid) from public, anon;
grant execute on function public.subscriber_history(uuid) to authenticated;
