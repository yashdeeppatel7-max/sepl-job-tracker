-- =====================================================================
-- Correcting wrong entries.
--  * Stage updates: the person who made an update can edit (date, status,
--    note) or delete it; Director, CEO and Admin can edit or delete any.
--  * Invoices: Accounts, Admin, Director, CEO can edit no., date, amount,
--    items, delete payments, and delete an invoice with no payments.
--  * Every edit is stamped "edited by <name> on <date>".
-- Safe to run more than once.
-- =====================================================================

alter table stage_events add column if not exists edited_at timestamptz;
alter table stage_events add column if not exists edited_by_name text;
alter table invoices     add column if not exists edited_at timestamptz;
alter table invoices     add column if not exists edited_by_name text;

create or replace function public.stamp_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'stage_events' then
    -- who made it and which item it belongs to never change
    new.created_by := old.created_by; new.created_by_name := old.created_by_name;
    new.line_item_id := old.line_item_id; new.created_at := old.created_at;
  end if;
  if auth.uid() is not null then
    new.edited_at := now();
    new.edited_by_name := coalesce((select nullif(full_name,'') from profiles where id = auth.uid()), 'someone');
  end if;
  return new;
end $$;

drop trigger if exists stage_events_edit on stage_events;
create trigger stage_events_edit before update on stage_events
  for each row execute function public.stamp_edit();
drop trigger if exists invoices_edit on invoices;
create trigger invoices_edit before update on invoices
  for each row when (old.invoice_no is distinct from new.invoice_no or old.invoice_date is distinct from new.invoice_date
                     or old.amount is distinct from new.amount)
  execute function public.stamp_edit();

-- your own stage updates: edit or delete (still only stages your role may record)
drop policy if exists ev_own_update on stage_events;
create policy ev_own_update on stage_events for update
  using (created_by = auth.uid() and public.can_update_stage(stage_code))
  with check (created_by = auth.uid() and public.can_update_stage(stage_code));
drop policy if exists ev_own_delete on stage_events;
create policy ev_own_delete on stage_events for delete
  using (created_by = auth.uid() and public.can_update_stage(stage_code));
-- recreate so the view shows the new edited_* columns
drop view if exists invoice_status;
create view invoice_status with (security_invoker = true) as
select i.*, j.job_no, c.code as customer_code,
       coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) as paid_amount,
       case when i.settled then 'paid'
            when coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) >= coalesce(i.amount, 0) and i.amount is not null then 'paid'
            when exists (select 1 from payments p where p.invoice_id = i.id) then 'part_paid'
            else 'unpaid' end as payment_status
  from invoices i join jobs j on j.id = i.job_id left join customers c on c.id = j.customer_id;
grant select on invoice_status to authenticated;
