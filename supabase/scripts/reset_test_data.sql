-- ⚠️ DELETES ALL BUSINESS DATA. Use only to clear test data before the real import.
-- Keeps: the manager account, settings, and the audit log.
-- Run in Supabase → SQL Editor. There is no undo.
begin;
truncate public.notifications, public.payments, public.exemptions, public.agent_transactions,
         public.invoices, public.billing_months, public.agent_areas, public.agent_invites
         restart identity;
delete from public.subscribers;
delete from public.areas;
-- test agents: profile + login (their audit lines stay, without a link)
update public.audit_log set actor = null where actor in (select id from public.profiles where role = 'agent');
delete from public.profiles where role = 'agent';
delete from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id);
commit;

select (select count(*) from public.subscribers) as subscribers,
       (select count(*) from public.invoices) as invoices,
       (select count(*) from public.profiles where role = 'manager') as managers;
