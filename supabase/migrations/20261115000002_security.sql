-- Tahseel — row-level security.
-- Apps can only SELECT, and only what their role allows. Every write goes through the
-- SECURITY DEFINER functions in 0003, which check the caller's role and the business rules.

create or replace function public.my_profile()
returns public.profiles language sql stable security definer set search_path = public as $$
  select p.* from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'manager')
$$;

create or replace function public.is_agent()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'agent')
$$;

create or replace function public.my_area_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select aa.area_id from public.agent_areas aa
  join public.profiles p on p.id = aa.agent_id
  where aa.agent_id = auth.uid() and p.active and p.role = 'agent'
$$;

-- Lock everything down first.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Read access only (RLS decides which rows).
grant select on public.settings, public.profiles, public.areas, public.agent_areas, public.agent_invites,
  public.subscribers, public.billing_months, public.invoices, public.payments, public.exemptions,
  public.agent_transactions, public.notifications, public.audit_log to authenticated;

alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.areas enable row level security;
alter table public.agent_areas enable row level security;
alter table public.agent_invites enable row level security;
alter table public.subscribers enable row level security;
alter table public.billing_months enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.exemptions enable row level security;
alter table public.agent_transactions enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

create policy settings_read on public.settings for select to authenticated
  using (public.is_manager() or public.is_agent());

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());

create policy areas_read on public.areas for select to authenticated
  using (public.is_manager() or id in (select public.my_area_ids()));

create policy agent_areas_read on public.agent_areas for select to authenticated
  using (public.is_manager() or (agent_id = auth.uid() and public.is_agent()));

create policy agent_invites_read on public.agent_invites for select to authenticated
  using (public.is_manager());

create policy subscribers_read on public.subscribers for select to authenticated
  using (public.is_manager() or area_id in (select public.my_area_ids()));

create policy billing_months_read on public.billing_months for select to authenticated
  using (public.is_manager() or public.is_agent());

create policy invoices_read on public.invoices for select to authenticated
  using (public.is_manager() or area_id in (select public.my_area_ids()));

create policy payments_read on public.payments for select to authenticated
  using (public.is_manager() or area_id in (select public.my_area_ids()));

create policy exemptions_read on public.exemptions for select to authenticated
  using (public.is_manager() or area_id in (select public.my_area_ids()));

create policy agent_transactions_read on public.agent_transactions for select to authenticated
  using (public.is_manager() or (agent_id = auth.uid() and public.is_agent()));

create policy notifications_read on public.notifications for select to authenticated
  using (public.is_manager());

create policy audit_read on public.audit_log for select to authenticated
  using (public.is_manager());

-- Live updates: the manager's notification feed and payment lists.
alter publication supabase_realtime add table public.notifications, public.payments;

grant execute on function public.is_manager(), public.is_agent(), public.my_area_ids(), public.my_profile() to authenticated;
