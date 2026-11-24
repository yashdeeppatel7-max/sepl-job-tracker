-- Payments entered in Finance now move the invoiced items to "Payment received".
--   all invoices of the item paid (and item fully despatched) -> Payment received (done)
--   some money received                                      -> Payment received (in progress = "Part paid")
-- These automatic updates carry the note 'From payments'. A payment update someone
-- entered by hand is left alone. Only the current cycle (since the last "Rejected") counts.

-- a part-paid item is not finished yet
create or replace function public.item_finished(p_stage text, p_status text) returns boolean
language sql immutable as $$
  select coalesce(p_stage in ('item_cancelled','po_cancelled','documents_sent')
                  or (p_stage in ('despatched','payment_received') and coalesce(p_status,'done') <> 'in_progress'), false)
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

  v_target := case when v_n > 0 and v_paid = v_n and not v_part_desp then 'done'
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
revoke all on function public.sync_item_payment(uuid) from public, anon, authenticated;

create or replace function public.sync_invoice_items(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_item uuid;
begin
  for v_item in select distinct line_item_id from invoice_items where invoice_id = p_invoice loop
    perform public.sync_item_payment(v_item);
  end loop;
end $$;
revoke all on function public.sync_invoice_items(uuid) from public, anon, authenticated;

create or replace function public.payments_sync_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then perform public.sync_invoice_items(old.invoice_id); end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id) then
    perform public.sync_invoice_items(new.invoice_id);
  end if;
  return null;
end $$;

create or replace function public.invoices_sync_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_invoice_items(new.id);
  return null;
end $$;

create or replace function public.invoice_items_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_item_payment(coalesce(new.line_item_id, old.line_item_id));
  if tg_op = 'UPDATE' and old.line_item_id is distinct from new.line_item_id then
    perform public.sync_item_payment(old.line_item_id);
  end if;
  return null;
end $$;

drop trigger if exists payments_sync_items on payments;
create trigger payments_sync_items after insert or update or delete on payments
  for each row execute function public.payments_sync_items();

drop trigger if exists invoices_sync_items on invoices;
create trigger invoices_sync_items after update of amount, settled, is_credit_note, invoice_date on invoices
  for each row execute function public.invoices_sync_items();

drop trigger if exists invoice_items_sync on invoice_items;
create trigger invoice_items_sync after insert or update or delete on invoice_items
  for each row execute function public.invoice_items_sync();

-- a despatch or rejection changes what the payments mean for the item
create or replace function public.stage_events_payment_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.stage_code, old.stage_code) in ('despatched','rejected') then
    perform public.sync_item_payment(coalesce(new.line_item_id, old.line_item_id));
  end if;
  return null;
end $$;
drop trigger if exists stage_events_payment_sync on stage_events;
create trigger stage_events_payment_sync after insert or update or delete on stage_events
  for each row execute function public.stage_events_payment_sync();

-- backfill: every item that is on an invoice
do $$
declare v uuid;
begin
  for v in select distinct line_item_id from invoice_items loop
    perform public.sync_item_payment(v);
  end loop;
end $$;
