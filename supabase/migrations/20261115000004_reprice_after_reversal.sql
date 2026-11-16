-- A fully reversed payment/exemption leaves the invoice clean (net 0), so a speed
-- change may re-price it. Previously any payment row, even reversed, blocked it.

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
       and coalesce((select sum(amount) from public.payments where invoice_id = inv.id), 0) = 0
       and coalesce((select sum(amount) from public.exemptions where invoice_id = inv.id), 0) = 0 then
      update public.invoices set amount = new_amount where id = inv.id;
      repriced := true;
    end if;
  end if;
  perform public._audit(me, 'update_subscriber', 'subscriber', p_id::text,
    'تعديل ' || trim(p_full_name) || coalesce(' — السعر ' || public._fmt(old.monthly_amount) || ' → ' || public._fmt(new_amount), '')
    || case when repriced then ' (طُبّق على فاتورة ' || p_apply_month || ')' else '' end);
  return jsonb_build_object('monthly_amount', new_amount, 'repriced', repriced);
end $$;
