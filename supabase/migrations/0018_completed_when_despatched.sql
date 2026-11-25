-- A PO whose items are all despatched is Completed, whether or not the customer has paid yet
-- (money still owed is followed in Finance). "Part paid" no longer keeps a PO in Ongoing.
-- A part-despatched item keeps showing "Part despatched" (payments don't hide that).
create or replace function public.item_finished(p_stage text, p_status text) returns boolean
language sql immutable as $$
  select coalesce(p_stage in ('item_cancelled','po_cancelled','documents_sent','payment_received')
                  or (p_stage = 'despatched' and coalesce(p_status,'done') <> 'in_progress'), false)
$$;

create or replace function public.sync_item_payment(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_cycle  timestamptz;
  v_rej_on date;
  v_n      int;
  v_paid   int;
  v_any    boolean;
  v_on     date;
  v_part_desp boolean;
  v_target text;
  v_job_clear boolean;
  v_cur    record;
begin
  if not exists (select 1 from line_items where id = p_item) then return; end if;

  select max(created_at), (array_agg(happened_on order by created_at desc))[1] into v_cycle, v_rej_on
    from stage_events where line_item_id = p_item and stage_code = 'rejected';

  -- invoices of this item in the current cycle (credit notes don't count)
  with inv as (
    select i.id, i.invoice_date, s.payment_status
      from invoice_items ii join invoices i on i.id = ii.invoice_id
      join invoice_status s on s.id = i.id
     where ii.line_item_id = p_item and not i.is_credit_note
       and (v_cycle is null or coalesce(i.invoice_date, i.created_at::date) >= v_rej_on))
  select count(*), count(*) filter (where payment_status = 'paid'),
         bool_or(payment_status in ('paid','part_paid')),
         coalesce((select max(p.paid_on) from payments p where p.invoice_id in (select id from inv)),
                  max(invoice_date))
    into v_n, v_paid, v_any, v_on
    from inv;

  select exists (select 1 from stage_events e where e.line_item_id = p_item and e.stage_code = 'despatched'
                   and e.created_at >= coalesce(v_cycle, '-infinity')
                   and e.created_at = (select max(x.created_at) from stage_events x
                                        where x.line_item_id = p_item and x.stage_code = 'despatched')
                   and e.status = 'in_progress')
    into v_part_desp;

  -- the whole PO is settled (credit notes and payments on any invoice counted): Outstanding is zero
  select count(*) > 0
         and coalesce(sum(i.amount) filter (where not i.settled), 0)
             <= coalesce(sum((select sum(p.amount) from payments p where p.invoice_id = i.id)) filter (where not i.settled), 0)
         and not bool_or(i.amount is null and not i.settled and not i.is_credit_note)
    into v_job_clear
    from invoices i where i.job_id = (select job_id from line_items where id = p_item);

  -- a part-despatched item stays "Part despatched" until the rest goes out
  v_target := case when v_part_desp then null
                   when v_n > 0 and (v_paid = v_n or v_job_clear) then 'done'
                   when coalesce(v_any, false) then 'in_progress' end;

  -- someone recorded the payment by hand in this cycle: leave it
  if exists (select 1 from stage_events where line_item_id = p_item and stage_code = 'payment_received'
               and coalesce(note, '') <> 'From payments' and created_at >= coalesce(v_cycle, '-infinity')) then
    return;
  end if;

  select id, status, happened_on into v_cur from stage_events
   where line_item_id = p_item and stage_code = 'payment_received' and note = 'From payments'
     and created_at >= coalesce(v_cycle, '-infinity')
   order by created_at desc limit 1;

  if v_target is null then
    delete from stage_events where line_item_id = p_item and stage_code = 'payment_received'
       and note = 'From payments' and created_at >= coalesce(v_cycle, '-infinity');
  elsif v_cur.id is null then
    insert into stage_events (line_item_id, stage_code, status, note, happened_on)
    values (p_item, 'payment_received', v_target, 'From payments', coalesce(v_on, current_date));
  elsif v_cur.status <> v_target or v_cur.happened_on is distinct from coalesce(v_on, current_date) then
    delete from stage_events where id = v_cur.id;
    insert into stage_events (line_item_id, stage_code, status, note, happened_on)
    values (p_item, 'payment_received', v_target, 'From payments', coalesce(v_on, current_date));
  end if;
end $$;


do $$
declare v uuid;
begin
  for v in select distinct li.job_id from invoice_items ii join line_items li on li.id = ii.line_item_id loop
    perform public.sync_job_payments(v);
  end loop;
end $$;
