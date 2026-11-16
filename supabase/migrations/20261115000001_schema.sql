-- Tahseel — mobile version, schema.
-- Money is BIGINT full Syrian pounds. Financial rows are append-only: a correction
-- inserts a reversal row (reversal_of) and marks the original (reversed_by).
-- Clients never write tables directly — only through the functions in 0003.

create table public.settings (
  key text primary key,
  value text not null
);
insert into public.settings (key, value) values ('price_per_mbps', '50000');

-- Who is who. One row per Supabase auth user that has been given a role.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('manager', 'agent')),
  full_name text not null,
  username text not null unique,
  phone text,
  active boolean not null default true,
  -- Agent compensation (informational until the manager approves a deduction)
  comp_type text not null default 'none' check (comp_type in ('none', 'monthly_salary', 'per_invoice')),
  comp_amount bigint not null default 0 check (comp_amount >= 0),
  created_at timestamptz not null default now()
);

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  aliases text[] not null default '{}',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Agent ↔ area assignment, set by the manager only. An agent may have several areas.
create table public.agent_areas (
  agent_id uuid not null references public.profiles (id) on delete cascade,
  area_id uuid not null references public.areas (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (agent_id, area_id)
);
-- One agent per area at a time.
create unique index agent_areas_one_agent_per_area on public.agent_areas (area_id);

-- One-time invite codes: the manager creates one; the agent claims it once.
create table public.agent_invites (
  code text primary key,
  full_name text not null,
  username text not null,
  phone text,
  area_ids uuid[] not null,
  comp_type text not null default 'none' check (comp_type in ('none', 'monthly_salary', 'per_invoice')),
  comp_amount bigint not null default 0,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  claimed_by uuid references public.profiles (id),
  claimed_at timestamptz,
  revoked_at timestamptz
);

create table public.subscribers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  full_name text not null,
  father_name text,
  username text,
  phone text,
  area_id uuid not null references public.areas (id),
  speed_mbps numeric(6, 2),
  package_label text,
  monthly_amount bigint check (monthly_amount is null or monthly_amount >= 0),
  standing_exempt boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disconnected')),
  -- first month with no invoice after a disconnect
  disconnected_from text check (disconnected_from is null or disconnected_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  notes text,
  source_sheet text,
  source_row int,
  import_flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subscribers_username on public.subscribers (lower(username)) where username is not null;
create index subscribers_area on public.subscribers (area_id);

create table public.billing_months (
  month text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  opened_at timestamptz not null default now(),
  opened_by uuid references public.profiles (id)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.subscribers (id),
  area_id uuid not null references public.areas (id),
  month text not null references public.billing_months (month),
  amount bigint not null check (amount >= 0),
  package_label text,
  created_at timestamptz not null default now(),
  unique (subscriber_id, month)
);
create index invoices_area_month on public.invoices (area_id, month);

-- method: agent_cash (agent holds the money) | manager_cash | shamcash (to the company)
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id),
  subscriber_id uuid not null references public.subscribers (id),
  area_id uuid not null references public.areas (id),
  month text not null,
  amount bigint not null check (amount <> 0),
  method text not null check (method in ('agent_cash', 'manager_cash', 'shamcash')),
  agent_id uuid references public.profiles (id),
  reference text,
  paid_on date not null default current_date,
  notes text,
  client_key text unique,
  recorded_by uuid not null references public.profiles (id),
  reversal_of uuid unique references public.payments (id),
  reversed_by uuid references public.payments (id),
  created_at timestamptz not null default now()
);
create index payments_invoice on public.payments (invoice_id);
create index payments_area_month on public.payments (area_id, month);
create index payments_agent on public.payments (agent_id, month);
create unique index payments_reference on public.payments (reference)
  where reference is not null and reversal_of is null and reversed_by is null;

create table public.exemptions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id),
  subscriber_id uuid not null references public.subscribers (id),
  area_id uuid not null references public.areas (id),
  month text not null,
  amount bigint not null,
  reason text not null,
  client_key text unique,
  recorded_by uuid not null references public.profiles (id),
  reversal_of uuid unique references public.exemptions (id),
  reversed_by uuid references public.exemptions (id),
  created_at timestamptz not null default now()
);
create index exemptions_invoice on public.exemptions (invoice_id);

-- type: delivery (agent hands cash to manager) | deduction (approved salary/commission
-- kept by agent) | salary_paid (paid separately — does not change what the agent holds)
create table public.agent_transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles (id),
  area_id uuid references public.areas (id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  type text not null check (type in ('delivery', 'deduction', 'salary_paid')),
  amount bigint not null check (amount <> 0),
  paid_on date not null default current_date,
  notes text,
  client_key text unique,
  recorded_by uuid not null references public.profiles (id),
  reversal_of uuid unique references public.agent_transactions (id),
  reversed_by uuid references public.agent_transactions (id),
  created_at timestamptz not null default now()
);
create index agent_transactions_agent_month on public.agent_transactions (agent_id, month);

-- Manager notification feed (live via Supabase Realtime).
create table public.notifications (
  id bigint generated always as identity primary key,
  kind text not null,
  title text not null,
  body text not null,
  area_id uuid references public.areas (id),
  agent_id uuid references public.profiles (id),
  payment_id uuid references public.payments (id),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_unread on public.notifications (created_at desc) where read_at is null;

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text,
  action text not null,
  entity text not null,
  entity_id text,
  summary text not null,
  data jsonb
);
