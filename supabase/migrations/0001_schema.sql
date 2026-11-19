-- =====================================================================
-- Job & PO tracker: schema, role rules (row-level security), helpers
-- Runs on Supabase (Postgres 15+). Money lives in separate tables so the
-- Production manager role can never read it, not even through the API.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Roles -----------------------------------------------------
create type app_role as enum ('director', 'ceo', 'admin', 'accounts', 'production_manager');

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  role        app_role,                       -- null = no access yet
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Current user's role (null if not set up or deactivated)
create or replace function public.my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

-- Director, CEO: everything incl. user management
create or replace function public.is_owner() returns boolean
language sql stable as $$ select coalesce(public.my_role() in ('director','ceo'), false) $$;

-- Director, CEO, Admin: full PO, finance, despatch
create or replace function public.is_mgmt() returns boolean
language sql stable as $$ select coalesce(public.my_role() in ('director','ceo','admin'), false) $$;

-- Anyone who may see money: mgmt + Accounts
create or replace function public.is_finance() returns boolean
language sql stable as $$ select coalesce(public.my_role() in ('director','ceo','admin','accounts'), false) $$;

-- Any active user with a role
create or replace function public.is_member() returns boolean
language sql stable as $$ select public.my_role() is not null $$;

-- New accounts get a profile with NO role; only Director/CEO assign roles
-- (user-editable sign-up metadata is never trusted for the role).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Master data ----------------------------------------------
create table customers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,           -- e.g. RIL-JAM, IFFCO-PH
  name        text,
  created_at  timestamptz not null default now()
);

create table vendors (                         -- RM suppliers and job-work shops
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  kind        text not null default 'job_work' check (kind in ('raw_material','job_work','tpi','other')),
  phone       text,
  created_at  timestamptz not null default now()
);

-- ---------- Process stages --------------------------------------------
-- owner: who may update it. 'production' = Production manager + mgmt,
-- 'finance' = Accounts + mgmt. optional_for: shown only when the job/item needs it.
create table stages (
  code          text primary key,
  seq           int  not null unique,
  label         text not null,
  owner         text not null check (owner in ('production','finance')),
  optional_for  text check (optional_for in ('tpi','rectification'))
);

insert into stages (code, seq, label, owner, optional_for) values
  ('rm_ordered',        10, 'Raw material ordered',          'production', null),
  ('rm_received',       20, 'Raw material received',         'production', null),
  ('rm_testing',        30, 'Raw material testing',          'production', null),
  ('tpi_rm_witness',    35, 'TPI witness of RM testing',     'production', 'tpi'),
  ('proof_machining',   40, 'Proof machining',               'production', null),
  ('final_lathe',       50, 'Final lathe machining',         'production', null),
  ('other_ops',         60, 'Drilling / keyway / other ops', 'production', null),
  ('testing',           70, 'DP / other testing',            'production', null),
  ('rectification',     75, 'Defect rectification',          'production', 'rectification'),
  ('grinding_cnc',      80, 'Grinding / final CNC finish',   'production', null),
  ('balancing',         90, 'Balancing / final activity',    'production', null),
  ('dimensional_check',100, 'Dimensional check',             'production', null),
  ('tpi_inspection',   110, 'TPI inspection (as per QAP)',   'production', 'tpi'),
  ('customer_approval',120, 'Customer approval',             'production', null),
  ('invoiced',         130, 'Invoice prepared',              'finance',    null),
  ('despatched',       140, 'Despatched',                    'finance',    null),
  ('documents_sent',   150, 'Despatch documents sent',       'finance',    null),
  ('payment_received', 160, 'Payment received',              'finance',    null);

-- ---------- Jobs (one per customer PO) --------------------------------
create type job_status as enum ('enquiry','quoted','po_received','in_progress','completed','on_hold','cancelled');

create table jobs (
  id              uuid primary key default gen_random_uuid(),
  job_no          text not null unique,        -- SEPL P.O No., e.g. 25-1061
  customer_id     uuid references customers(id),
  customer_po_no  text,
  po_date         date,
  delivery_date   date,
  status          job_status not null default 'po_received',
  tpi_required    boolean not null default false,
  tpi_agency      text,
  qap_ref         text,
  remarks         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table line_items (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references jobs(id) on delete cascade,
  line_no            int  not null,             -- order within the job in the sheet
  description        text not null,
  item_code          text,
  qty                numeric not null default 1,
  unit               text not null default 'Nos',
  needs_rectification boolean not null default false,
  current_stage      text references stages(code),
  current_status     text check (current_status in ('in_progress','done','skipped')),
  stage_updated_at   timestamptz,
  created_at         timestamptz not null default now(),
  unique (job_id, line_no)
);

-- ---------- Money (finance roles only) -------------------------------
create table line_item_prices (
  line_item_id  uuid primary key references line_items(id) on delete cascade,
  rate          numeric,          -- ITEM VALUE (per unit)
  basic_value   numeric,          -- qty * rate
  pf_pct        numeric default 0,
  pf_value      numeric default 0,
  freight_pct   numeric default 0,
  freight_value numeric default 0,
  discount      numeric default 0,
  taxable_value numeric,          -- Total Basic Value
  gst_pct       numeric default 18,
  gst_value     numeric,
  total_value   numeric,          -- incl. GST
  finance_notes text              -- sheet status / sale notes; may mention money, so finance-only
);

create table invoices (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  invoice_no    text not null unique,
  invoice_date  date,
  amount        numeric,          -- incl. GST
  due_date      date,
  notes         text,
  created_at    timestamptz not null default now()
);

create table invoice_items (
  invoice_id    uuid references invoices(id) on delete cascade,
  line_item_id  uuid references line_items(id) on delete cascade,
  qty           numeric,
  primary key (invoice_id, line_item_id)
);

create table payments (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id) on delete cascade,
  paid_on       date not null default current_date,
  amount        numeric not null check (amount > 0),
  reference     text,             -- UTR / cheque no.
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

-- Purchases: bills from RM suppliers / job-work vendors
create table vendor_bills (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid references vendors(id),
  job_id        uuid references jobs(id) on delete set null,
  bill_no       text not null,
  bill_date     date,
  amount        numeric not null,  -- incl. GST
  paid          boolean not null default false,
  paid_on       date,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------- Despatches -----------------------------------------------
create table despatches (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references jobs(id) on delete cascade,
  invoice_id     uuid references invoices(id) on delete set null,
  despatched_on  date not null default current_date,
  transporter    text,
  vehicle_no     text,
  lr_no          text,
  documents_sent boolean not null default false,
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

create table despatch_items (
  despatch_id   uuid references despatches(id) on delete cascade,
  line_item_id  uuid references line_items(id) on delete cascade,
  qty           numeric,
  primary key (despatch_id, line_item_id)
);

-- ---------- Stage history --------------------------------------------
create table stage_events (
  id            uuid primary key default gen_random_uuid(),
  line_item_id  uuid not null references line_items(id) on delete cascade,
  stage_code    text not null references stages(code),
  status        text not null default 'done' check (status in ('in_progress','done','skipped')),
  mode          text not null default 'in_house' check (mode in ('in_house','job_work')),
  vendor_id     uuid references vendors(id),
  note          text,
  happened_on   date not null default current_date,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create index on line_items (job_id);
create index on stage_events (line_item_id, created_at desc);
create index on invoices (job_id);
create index on despatches (job_id);
create index on jobs (customer_id);

-- Keep line_items.current_stage in sync with the latest event (by stage order)
create or replace function public.sync_current_stage() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select e.stage_code, e.status, e.created_at into r
    from stage_events e join stages s on s.code = e.stage_code
   where e.line_item_id = coalesce(new.line_item_id, old.line_item_id)
   order by s.seq desc, e.created_at desc
   limit 1;
  update line_items
     set current_stage = r.stage_code, current_status = r.status, stage_updated_at = r.created_at
   where id = coalesce(new.line_item_id, old.line_item_id);
  -- mark the job in progress / completed automatically
  update jobs j set
     status = case
       when j.status in ('cancelled','on_hold','enquiry','quoted') then j.status
       when not exists (select 1 from line_items li where li.job_id = j.id
                          and coalesce(li.current_stage,'') not in ('despatched','documents_sent','payment_received'))
         then 'completed'
       else 'in_progress' end,
     updated_at = now()
   where j.id = (select job_id from line_items where id = coalesce(new.line_item_id, old.line_item_id));
  return null;
end $$;

create trigger stage_events_sync after insert or update or delete on stage_events
  for each row execute function public.sync_current_stage();

-- Who may record a given stage
create or replace function public.can_update_stage(p_stage text) returns boolean
language sql stable as $$
  select case (select owner from stages where code = p_stage)
           when 'production' then public.is_mgmt() or public.my_role() = 'production_manager'
           when 'finance'    then public.is_finance()
           else false end
$$;

-- ---------- Views ----------------------------------------------------
-- Value-free view for everyone. security_invoker keeps RLS of the caller.
create view job_overview with (security_invoker = true) as
select j.id, j.job_no, j.customer_po_no, j.po_date, j.delivery_date, j.status,
       j.tpi_required, c.code as customer_code, c.name as customer_name,
       count(li.id)                                                        as item_count,
       count(li.id) filter (where li.current_stage in ('despatched','documents_sent','payment_received')) as items_despatched,
       min(s.seq)                                                          as slowest_stage_seq,
       (j.delivery_date < current_date and j.status not in ('completed','cancelled')) as overdue
  from jobs j
  left join customers c on c.id = j.customer_id
  left join line_items li on li.job_id = j.id
  left join stages s on s.code = li.current_stage
 group by j.id, c.code, c.name;

-- Money per job (finance roles only, enforced by RLS on the price table)
create view job_values with (security_invoker = true) as
select li.job_id,
       sum(p.taxable_value) as taxable_value,
       sum(p.gst_value)     as gst_value,
       sum(p.total_value)   as total_value
  from line_items li join line_item_prices p on p.line_item_id = li.id
 group by li.job_id;

create view invoice_status with (security_invoker = true) as
select i.*, j.job_no, c.code as customer_code,
       coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) as paid_amount,
       case when coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) >= coalesce(i.amount, 0) and i.amount is not null then 'paid'
            when exists (select 1 from payments p where p.invoice_id = i.id) then 'part_paid'
            else 'unpaid' end as payment_status
  from invoices i join jobs j on j.id = i.job_id left join customers c on c.id = j.customer_id;

-- Despatch status without money, for Accounts and mgmt
create view despatch_overview with (security_invoker = true) as
select d.id, d.job_id, j.job_no, c.code as customer_code, d.despatched_on, d.transporter,
       d.vehicle_no, d.lr_no, d.documents_sent, d.notes, i.invoice_no
  from despatches d join jobs j on j.id = d.job_id
  left join customers c on c.id = j.customer_id
  left join invoices i on i.id = d.invoice_id;

-- ---------- Row-level security ----------------------------------------
alter table profiles          enable row level security;
alter table customers         enable row level security;
alter table vendors           enable row level security;
alter table stages            enable row level security;
alter table jobs              enable row level security;
alter table line_items        enable row level security;
alter table line_item_prices  enable row level security;
alter table invoices          enable row level security;
alter table invoice_items     enable row level security;
alter table payments          enable row level security;
alter table vendor_bills      enable row level security;
alter table despatches        enable row level security;
alter table despatch_items    enable row level security;
alter table stage_events      enable row level security;

-- profiles: see yourself; owners see and manage everyone
create policy profiles_self_read  on profiles for select using (id = auth.uid() or public.is_owner() or public.is_mgmt());
create policy profiles_owner_write on profiles for update using (public.is_owner()) with check (public.is_owner());

-- master data: all members read; mgmt writes customers; finance writes vendors
create policy customers_read  on customers for select using (public.is_member());
create policy customers_write on customers for all    using (public.is_mgmt()) with check (public.is_mgmt());
create policy vendors_read    on vendors   for select using (public.is_member());
create policy vendors_write   on vendors   for all    using (public.is_finance() or public.my_role() = 'production_manager')
                                                 with check (public.is_finance() or public.my_role() = 'production_manager');
create policy stages_read     on stages    for select using (public.is_member());

-- jobs & items (no money): everyone reads, mgmt writes
create policy jobs_read   on jobs       for select using (public.is_member());
create policy jobs_write  on jobs       for all    using (public.is_mgmt()) with check (public.is_mgmt());
create policy items_read  on line_items for select using (public.is_member());
create policy items_write on line_items for all    using (public.is_mgmt()) with check (public.is_mgmt());

-- money: finance roles only
create policy prices_read   on line_item_prices for select using (public.is_finance());
create policy prices_write  on line_item_prices for all    using (public.is_finance()) with check (public.is_finance());
create policy inv_read      on invoices         for select using (public.is_finance());
create policy inv_write     on invoices         for all    using (public.is_finance()) with check (public.is_finance());
create policy invi_read     on invoice_items    for select using (public.is_finance());
create policy invi_write    on invoice_items    for all    using (public.is_finance()) with check (public.is_finance());
create policy pay_read      on payments         for select using (public.is_finance());
create policy pay_write     on payments         for all    using (public.is_finance()) with check (public.is_finance());
create policy bills_read    on vendor_bills     for select using (public.is_finance());
create policy bills_write   on vendor_bills     for all    using (public.is_finance()) with check (public.is_finance());

-- despatches: Accounts can see status; mgmt records them
create policy desp_read   on despatches     for select using (public.is_finance());
create policy desp_write  on despatches     for all    using (public.is_mgmt()) with check (public.is_mgmt());
create policy despi_read  on despatch_items for select using (public.is_finance());
create policy despi_write on despatch_items for all    using (public.is_mgmt()) with check (public.is_mgmt());

-- stage history: everyone reads; insert only stages you own; only mgmt edits/deletes
create policy ev_read   on stage_events for select using (public.is_member());
create policy ev_insert on stage_events for insert with check (public.can_update_stage(stage_code) and created_by = auth.uid());
create policy ev_mgmt   on stage_events for update using (public.is_mgmt()) with check (public.is_mgmt());
create policy ev_del    on stage_events for delete using (public.is_mgmt());

-- API access for signed-in users (RLS above does the filtering)
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
