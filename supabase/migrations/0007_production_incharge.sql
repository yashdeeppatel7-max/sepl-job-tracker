-- =====================================================================
-- New role: Production incharge. Same access as Production manager:
-- sees POs, items and quantities (no values, invoices or despatches),
-- updates production stages, adds job-work vendors.
-- Safe to run more than once.
-- =====================================================================
alter type app_role add value if not exists 'production_incharge';

-- Production manager or Production incharge (compared as text so this file can run in one go)
create or replace function public.is_production() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role()::text in ('production_manager','production_incharge'), false)
$$;

create or replace function public.can_update_stage(p_stage text) returns boolean
language sql stable as $$
  select case (select owner from stages where code = p_stage)
           when 'production' then public.is_mgmt() or public.is_production()
           when 'finance'    then public.is_finance()
           when 'mgmt'       then public.is_mgmt()
           else false end
$$;

drop policy if exists vendors_write on vendors;
create policy vendors_write on vendors for all
  using (public.is_finance() or public.is_production())
  with check (public.is_finance() or public.is_production());

grant execute on function public.is_production() to authenticated;
