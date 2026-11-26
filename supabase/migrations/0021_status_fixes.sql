-- A PO's status (Ongoing / RFD / Completed / Cancelled) was only worked out when an item's stage
-- changed. A PO whose last item was added after the others were despatched (the sheet sync adds
-- items one by one) stayed "Completed" with an item still to make. The status is now worked out
-- in one place and also whenever an item is added to or removed from a PO.

create or replace function public.refresh_job_status(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update jobs j set
     status = case
       when j.status in ('cancelled','on_hold','enquiry','quoted') then j.status
       when not exists (select 1 from line_items li where li.job_id = j.id
                          and coalesce(li.current_stage,'') not in ('item_cancelled','po_cancelled'))
         then 'cancelled'
       when not exists (select 1 from line_items li where li.job_id = j.id
                          and not public.item_finished(li.current_stage, li.current_status))
         then 'completed'
       -- everything not yet despatched is ready for despatch (or the PO was marked RFD by hand)
       when j.marked_rfd or not exists (
              select 1 from line_items li left join stages s on s.code = li.current_stage
               where li.job_id = j.id
                 and not public.item_finished(li.current_stage, li.current_status)
                 and not (coalesce(s.seq, 0) >= 125 and s.seq < 900
                          and not (li.current_stage = 'despatched' and li.current_status = 'in_progress')))
         then 'rfd'
       else 'in_progress' end,
     updated_at = now()
   where j.id = p_job;
end $$;
revoke all on function public.refresh_job_status(uuid) from public, anon, authenticated;

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

  -- only the current cycle counts: updates since the last "Rejected" (if any)
  select e.stage_code, e.status, e.created_at into r
    from stage_events e join stages s on s.code = e.stage_code
   where e.line_item_id = v_item
     and e.created_at >= coalesce((select max(x.created_at) from stage_events x
                                    where x.line_item_id = v_item and x.stage_code = 'rejected'), '-infinity')
   order by s.seq desc, e.created_at desc
   limit 1;
  update line_items
     set current_stage = r.stage_code, current_status = r.status, stage_updated_at = r.created_at
   where id = v_item;

  perform public.refresh_job_status(v_job);
  return null;
end $$;

create or replace function public.line_items_job_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_job_status(coalesce(new.job_id, old.job_id));
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then perform public.refresh_job_status(old.job_id); end if;
  return null;
end $$;
drop trigger if exists line_items_job_status on line_items;
create trigger line_items_job_status after insert or delete or update of job_id on line_items
  for each row execute function public.line_items_job_status();

-- put every PO right now
do $$ declare v uuid; begin
  for v in select id from jobs loop perform public.refresh_job_status(v); end loop;
end $$;

-- An invoice can cover items of more than one PO (e.g. 25/096). A payment or credit note on it
-- only refreshed the items of the PO the invoice was first created under, so the other PO's
-- items never showed Paid. Now every PO with an item on the invoice is refreshed.
create or replace function public.sync_invoice_items(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  for v in select job_id from invoices where id = p_invoice
           union
           select li.job_id from invoice_items ii join line_items li on li.id = ii.line_item_id
            where ii.invoice_id = p_invoice loop
    perform public.sync_job_payments(v);
  end loop;
end $$;
revoke all on function public.sync_invoice_items(uuid) from public, anon, authenticated;

create or replace function public.invoices_sync_items() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if tg_op <> 'INSERT' then perform public.sync_job_payments(old.job_id); end if;
  if tg_op <> 'DELETE' then
    if tg_op = 'INSERT' or new.job_id is distinct from old.job_id then perform public.sync_job_payments(new.job_id); end if;
    -- other POs with items on this invoice
    for v in select distinct li.job_id from invoice_items ii join line_items li on li.id = ii.line_item_id
              where ii.invoice_id = new.id and li.job_id is distinct from new.job_id loop
      perform public.sync_job_payments(v);
    end loop;
    -- a credit note settles the invoice it is raised against, which may be on other POs too
    if new.against_invoice_id is not null then perform public.sync_invoice_items(new.against_invoice_id); end if;
  end if;
  if tg_op <> 'INSERT' and old.against_invoice_id is not null
     and (tg_op = 'DELETE' or old.against_invoice_id is distinct from new.against_invoice_id) then
    perform public.sync_invoice_items(old.against_invoice_id);
  end if;
  return null;
end $$;

-- refresh Paid / Part paid on every PO now
do $$ declare v uuid; begin
  for v in select distinct li.job_id from invoice_items ii join line_items li on li.id = ii.line_item_id loop
    perform public.sync_job_payments(v);
  end loop;
end $$;
