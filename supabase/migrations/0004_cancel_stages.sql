-- =====================================================================
-- Two cancellation stages, recorded only by Director, CEO or Admin:
--   Item cancelled : this item was dropped from the PO (e.g. drawing mismatch)
--   PO cancelled   : the whole PO is short-closed; every item of the job is
--                    marked cancelled and the job status becomes Cancelled.
-- A job whose remaining (not cancelled) items are all despatched is Completed.
-- Safe to run more than once.
-- =====================================================================

alter table stages drop constraint if exists stages_owner_check;
alter table stages add constraint stages_owner_check check (owner in ('production','finance','mgmt'));

insert into stages (code, seq, label, owner, optional_for) values
  ('item_cancelled', 900, 'Item cancelled', 'mgmt', null),
  ('po_cancelled',   910, 'PO cancelled',   'mgmt', null)
on conflict (code) do update set seq = excluded.seq, label = excluded.label, owner = excluded.owner;

create or replace function public.can_update_stage(p_stage text) returns boolean
language sql stable as $$
  select case (select owner from stages where code = p_stage)
           when 'production' then public.is_mgmt() or public.my_role() = 'production_manager'
           when 'finance'    then public.is_finance()
           when 'mgmt'       then public.is_mgmt()
           else false end
$$;

create or replace function public.sync_current_stage() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r      record;
  v_item uuid := coalesce(new.line_item_id, old.line_item_id);
  v_job  uuid;
begin
  select job_id into v_job from line_items where id = v_item;

  -- PO cancelled on one item = cancel every item of the job and the job itself
  if tg_op = 'INSERT' and new.stage_code = 'po_cancelled' then
    insert into stage_events (line_item_id, stage_code, status, note, happened_on, created_by)
    select li.id, 'po_cancelled', 'done', coalesce(new.note, 'PO cancelled'), new.happened_on, new.created_by
      from line_items li
     where li.job_id = v_job and li.id <> v_item
       and not exists (select 1 from stage_events e where e.line_item_id = li.id and e.stage_code = 'po_cancelled');
    update jobs set status = 'cancelled', updated_at = now() where id = v_job;
  end if;

  select e.stage_code, e.status, e.created_at into r
    from stage_events e join stages s on s.code = e.stage_code
   where e.line_item_id = v_item
   order by s.seq desc, e.created_at desc
   limit 1;
  update line_items
     set current_stage = r.stage_code, current_status = r.status, stage_updated_at = r.created_at
   where id = v_item;

  update jobs j set
     status = case
       when j.status in ('cancelled','on_hold','enquiry','quoted') then j.status
       when not exists (select 1 from line_items li where li.job_id = j.id
                          and coalesce(li.current_stage,'') not in ('item_cancelled','po_cancelled'))
         then 'cancelled'
       when not exists (select 1 from line_items li where li.job_id = j.id
                          and coalesce(li.current_stage,'') not in ('despatched','documents_sent','payment_received','item_cancelled','po_cancelled'))
         then 'completed'
       else 'in_progress' end,
     updated_at = now()
   where j.id = v_job;
  return null;
end $$;

-- Cancelled items no longer count towards item totals or the slowest stage
create or replace view job_overview with (security_invoker = true) as
select j.id, j.job_no, j.customer_po_no, j.po_date, j.delivery_date, j.status,
       j.tpi_required, c.code as customer_code, c.name as customer_name,
       count(li.id) filter (where coalesce(li.current_stage,'') not in ('item_cancelled','po_cancelled')) as item_count,
       count(li.id) filter (where li.current_stage in ('despatched','documents_sent','payment_received')) as items_despatched,
       min(s.seq) filter (where s.code not in ('item_cancelled','po_cancelled'))          as slowest_stage_seq,
       (j.delivery_date < current_date and j.status not in ('completed','cancelled')) as overdue
  from jobs j
  left join customers c on c.id = j.customer_id
  left join line_items li on li.job_id = j.id
  left join stages s on s.code = li.current_stage
 group by j.id, c.code, c.name;
