-- ⚠️ DESTRUCTIVE — DELETES ALL MONEY RECORDS. There is no undo. Take a backup first
--    (Supabase → Database → Backups, or export the four tables below).
--
-- Deletes: every payment, exemption, agent transaction (deliveries / deductions / salary) and
--          manager notification.
-- Keeps:   subscribers, areas, profiles (manager + agents), agent ↔ area links, invoices,
--          billing months, settings and the audit log — so every invoice shows as UNPAID again.
--
-- BEFORE RUNNING: every agent must have NO unsent offline payments («قيد الإرسال»).
--   Ask each agent to open the app with internet until the pending list is empty. A payment
--   still waiting on a phone would be sent AFTER the reset and mark that subscriber paid again.
--
-- Run in Supabase → SQL Editor, as one script. Do not run it in the app.
begin;
truncate public.payments, public.exemptions, public.agent_transactions, public.notifications
         restart identity;
commit;

select (select count(*) from public.payments)            as payments,
       (select count(*) from public.exemptions)          as exemptions,
       (select count(*) from public.agent_transactions)  as agent_transactions,
       (select count(*) from public.notifications)       as notifications,
       (select count(*) from public.subscribers)         as subscribers,
       (select count(*) from public.areas)               as areas,
       (select count(*) from public.profiles)            as profiles,
       (select count(*) from public.billing_months)      as billing_months,
       (select count(*) from public.invoices)            as invoices,
       (select count(*) from public.invoices where amount > 0) as invoices_now_unpaid;
