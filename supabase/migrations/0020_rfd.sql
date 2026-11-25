-- "Ready for despatch (RFD)": an item stage (after Customer approval, before Invoice) that
-- production records, and a PO status. A PO moves to RFD by itself once every item still to go
-- is at RFD or later; Director/CEO/Admin can also set the PO status to RFD by hand (jobs.marked_rfd).
-- It leaves RFD when everything is despatched (Completed).
alter table jobs add column if not exists marked_rfd boolean not null default false;

insert into stages (code, seq, label, owner, optional_for) values
  ('rfd', 125, 'Ready for despatch (RFD)', 'production', null)
on conflict (code) do update set seq = excluded.seq, label = excluded.label, owner = excluded.owner;

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
   where j.id = v_job;
  return null;
end $$;
