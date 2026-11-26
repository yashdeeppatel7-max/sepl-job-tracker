-- Sheet check, money part: finds what makes "To receive from customers" too high:
-- a PO billed above its value (duplicate / renumbered invoices), a credit note the sheet shows
-- but the app doesn't have, and unpaid invoices that the sheet no longer has.

create or replace function public.sheet_check()
returns table (job_no text, line_no int, area text, problem text, sheet text, app text, serious boolean)
language plpgsql stable security invoker set search_path = public as $$
begin
  if not (public.is_mgmt() or current_user in ('service_role','postgres')) then
    raise exception 'Only Director, CEO or Admin can run the sheet check' using errcode = '42501';
  end if;

  return query
  with sr as (select s.job_no, s.line_no, s.row, public.sheet_item_state(s.row) as want from sheet_rows s),
  it as (
    select li.id, j.id as job_id, j.job_no, li.line_no, li.qty, li.description, li.current_stage, li.current_status,
           public.app_item_state(li.current_stage, li.current_status) as have,
           exists (select 1 from stage_events e where e.line_item_id = li.id and e.stage_code = 'rejected') as rejected
      from line_items li join jobs j on j.id = li.job_id),
  -- the stage the item should show, worked out again from its history (current cycle only)
  recalc as (
    select it.id,
           (select e.stage_code from stage_events e join stages s on s.code = e.stage_code
             where e.line_item_id = it.id
               and e.created_at >= coalesce((select max(x.created_at) from stage_events x
                                             where x.line_item_id = it.id and x.stage_code = 'rejected'), '-infinity')
             order by s.seq desc, e.created_at desc limit 1) as stage,
           (select e.status from stage_events e join stages s on s.code = e.stage_code
             where e.line_item_id = it.id
               and e.created_at >= coalesce((select max(x.created_at) from stage_events x
                                             where x.line_item_id = it.id and x.stage_code = 'rejected'), '-infinity')
             order by s.seq desc, e.created_at desc limit 1) as status
      from it),
  inv as (select i.*, s.payment_status, s.paid_amount, s.credited_amount from invoices i join invoice_status s on s.id = i.id),
  sheet_inv as (   -- one row per (sheet item, invoice no) with its date
    select sr.job_no, sr.line_no, x->>'no' as no, nullif(x->>'date','')::date as on_date
      from sr cross join jsonb_array_elements(coalesce(sr.row->'invoices','[]')) x),
  -- expected invoice amounts: every item on it names only that invoice and has a value
  inv_amt as (
    select si.no, sum(nullif(sr.row->>'total_value','')::numeric) as total,
           bool_and(jsonb_array_length(sr.row->'invoices') = 1 and nullif(sr.row->>'total_value','') is not null) as ok
      from sheet_inv si join sr on sr.job_no = si.job_no and sr.line_no = si.line_no
     group by si.no)

  -- 1. items in the sheet missing from the app, or different
  select sr.job_no, sr.line_no, 'Item', 'Item is in the sheet but not in the app', sr.row->>'description', null::text, true
    from sr where not exists (select 1 from it where it.job_no = sr.job_no and it.line_no = sr.line_no)
  union all
  select it.job_no, it.line_no, 'Item', 'Item is in the app but not in the sheet', null, it.description, false
    from it where exists (select 1 from sheet_rows) and exists (select 1 from sr where sr.job_no = it.job_no)
     and not exists (select 1 from sr where sr.job_no = it.job_no and sr.line_no = it.line_no)
  union all
  select sr.job_no, sr.line_no, 'Item', 'Quantity differs',
         sr.row->>'qty', it.qty::text, true
    from sr join it on it.job_no = sr.job_no and it.line_no = sr.line_no
   where nullif(sr.row->>'qty','') is not null and (sr.row->>'qty')::numeric <> it.qty

  -- 2. despatch / cancelled state of each item
  union all
  select sr.job_no, sr.line_no, 'Despatch',
         case sr.want when 'cancelled' then 'Cancelled in the sheet, not in the app'
                      when 'despatched' then 'Despatched (invoiced / Complete) in the sheet, not in the app'
                      when 'part' then 'Part despatched in the sheet, not in the app'
                      else 'Shown as despatched in the app, but the sheet has no invoice or Complete' end,
         sr.want || coalesce(' (' || (sr.row->>'status_text') || ')', ''),
         it.have || coalesce(' (' || it.current_stage || coalesce('/' || it.current_status, '') || ')', ''),
         -- the app being ahead of the sheet because someone updated it in the app is fine
         not (sr.want = 'open' and not exists (select 1 from stage_events e where e.line_item_id = it.id
                                                 and e.stage_code = 'despatched' and e.note = 'From Excel import'))
    from sr join it on it.job_no = sr.job_no and it.line_no = sr.line_no
   where not it.rejected and sr.want <> it.have
     and not (sr.want = 'part' and it.have = 'despatched')         -- rest despatched later in the app
     and not (sr.want = 'despatched' and it.have = 'cancelled')    -- cancelled in the app on purpose
     and not (sr.want = 'open' and it.have = 'cancelled' and exists (
              select 1 from jobs j where j.id = it.job_id and j.status = 'cancelled'))

  -- 3. invoices
  union all
  select si.job_no, si.line_no, 'Invoice', 'Invoice in the sheet is missing in the app', si.no, null, true
    from sheet_inv si where not exists (select 1 from inv where inv.invoice_no = si.no)
  union all
  select si.job_no, si.line_no, 'Invoice', 'Invoice not linked to this item in the app', si.no,
         'on ' || coalesce((select string_agg(i2.invoice_no, ', ') from invoice_items ii join invoices i2 on i2.id = ii.invoice_id
                             where ii.line_item_id = it.id), 'no invoice'), true
    from sheet_inv si join it on it.job_no = si.job_no and it.line_no = si.line_no
    join inv on inv.invoice_no = si.no
   where not exists (select 1 from invoice_items ii where ii.invoice_id = inv.id and ii.line_item_id = it.id)
  union all
  select si.job_no, si.line_no, 'Invoice', 'Invoice belongs to a different PO in the app', si.no,
         (select j.job_no from jobs j where j.id = inv.job_id), true
    from sheet_inv si join inv on inv.invoice_no = si.no join jobs j on j.id = inv.job_id
   where j.job_no <> si.job_no
     and not exists (select 1 from sheet_inv o where o.no = si.no and o.job_no = j.job_no)
  union all
  select distinct on (si.no) si.job_no, si.line_no, 'Invoice', 'Invoice date differs', si.no || ' ' || to_char(si.on_date, 'DD.MM.YYYY'),
         to_char(inv.invoice_date, 'DD.MM.YYYY'), inv.edited_at is null
    from sheet_inv si join inv on inv.invoice_no = si.no
   where si.on_date is not null and inv.invoice_date is distinct from si.on_date
     and not exists (select 1 from sheet_inv o where o.no = si.no and o.on_date = inv.invoice_date)
  union all
  select it.job_no, it.line_no, 'Invoice', 'Item has an invoice in the app that the sheet no longer lists', i.invoice_no, i.invoice_no, true
    from it join invoice_items ii on ii.line_item_id = it.id join inv i on i.id = ii.invoice_id
   where i.from_sheet and not i.is_credit_note and exists (select 1 from sr where sr.job_no = it.job_no and sr.line_no = it.line_no)
     and not exists (select 1 from sheet_inv si where si.job_no = it.job_no and si.line_no = it.line_no and si.no = i.invoice_no)
  union all
  select j.job_no, null::int, 'Invoice', 'Invoice amount not entered', i.invoice_no,
         'blank', false
    from inv i join jobs j on j.id = i.job_id
   where i.amount is null and not i.is_credit_note and not i.settled
  union all
  select j.job_no, null::int, 'Invoice', 'Invoice amount differs from the sheet items', i.invoice_no || ' = ' || a.total::text,
         i.amount::text, i.edited_at is null
    from inv i join jobs j on j.id = i.job_id join inv_amt a on a.no = i.invoice_no
   where a.ok and i.amount is not null and not i.is_credit_note and abs(i.amount - a.total) > 1

  -- 4. credit notes the sheet mentions
  union all
  select sr.job_no, sr.line_no, 'Credit note', 'Sheet mentions a credit note but the PO has none in the app',
         substring(sr.row->>'finance_notes' from 'Invoice cell: ([^|]*)'), null, false
    from sr
   where (sr.row->>'finance_notes') ~* 'Invoice cell:[^|]*\mCR\M'
     and not exists (select 1 from invoices i join jobs j on j.id = i.job_id where j.job_no = sr.job_no and i.is_credit_note)
  union all
  select j.job_no, null::int, 'Credit note', 'Credit note is not raised against any invoice', i.invoice_no,
         coalesce(i.amount::text, 'no amount'), false
    from inv i join jobs j on j.id = i.job_id
   where i.is_credit_note and i.against_invoice_id is null

  -- 5. payments vs Paid / Part paid on items
  union all
  select it.job_no, it.line_no, 'Payment',
         case when x.n_paid = x.n then 'All its invoices are paid but the item does not show Paid'
              else 'Some money received but the item does not show Part paid' end,
         x.n_paid || ' of ' || x.n || ' invoices paid', coalesce(it.current_stage || '/' || it.current_status, 'no stage'), true
    from it cross join lateral (
      select count(*) as n, count(*) filter (where i.payment_status = 'paid') as n_paid,
             count(*) filter (where i.payment_status in ('paid','part_paid')) as n_some
        from invoice_items ii join inv i on i.id = ii.invoice_id
       where ii.line_item_id = it.id and not i.is_credit_note) x
   where x.n > 0 and not it.rejected and it.have = 'despatched'
     and ((x.n_paid = x.n and not (it.current_stage = 'payment_received' and it.current_status = 'done'))
          or (x.n_some > 0 and x.n_paid < x.n and it.current_stage not in ('payment_received')))
  union all
  select it.job_no, it.line_no, 'Payment', 'Item shows Paid but its invoices are not paid',
         x.n_paid || ' of ' || x.n || ' invoices paid', 'Paid', true
    from it cross join lateral (
      select count(*) as n, count(*) filter (where i.payment_status = 'paid') as n_paid
        from invoice_items ii join inv i on i.id = ii.invoice_id
       where ii.line_item_id = it.id and not i.is_credit_note) x
   where it.current_stage = 'payment_received' and it.current_status = 'done' and x.n_paid < x.n
     and exists (select 1 from stage_events e where e.line_item_id = it.id and e.note = 'From payments')
     -- whole PO settled (outstanding zero) also counts as paid
     and exists (select 1 from invoices i join jobs j on j.id = i.job_id where j.job_no = it.job_no
                  and not i.settled and not i.is_credit_note
                  and coalesce(i.amount, 1) > coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                                             + coalesce((select -sum(c.amount) from invoices c where c.against_invoice_id = i.id and c.is_credit_note), 0))

  -- 6. the stage an item shows vs its own history
  union all
  select it.job_no, it.line_no, 'Stage', 'Item shows a stage that does not match its updates',
         coalesce(r.stage || '/' || r.status, 'no updates'), coalesce(it.current_stage || '/' || it.current_status, 'no stage'), true
    from it join recalc r on r.id = it.id
   where r.stage is distinct from it.current_stage or r.status is distinct from it.current_status

  -- 7. PO status (Ongoing / RFD / Completed / Cancelled) vs its items and the sheet
  union all
  select j.job_no, null::int, 'PO status', x.problem, x.want, j.status::text, true
    from jobs j cross join lateral (
      select case
          when not exists (select 1 from line_items li where li.job_id = j.id) then null
          when not exists (select 1 from line_items li where li.job_id = j.id
                            and coalesce(li.current_stage,'') not in ('item_cancelled','po_cancelled')) then 'cancelled'
          when not exists (select 1 from line_items li where li.job_id = j.id
                            and not public.item_finished(li.current_stage, li.current_status)) then 'completed'
          else 'open' end as want_items) w
    cross join lateral (
      select case
        when j.status in ('cancelled','on_hold') then null
        when w.want_items = 'completed' and j.status <> 'completed' then 'All items are despatched or cancelled but the PO is not Completed'
        when w.want_items = 'cancelled' and j.status <> 'cancelled' then 'All items are cancelled but the PO is not Cancelled'
        when w.want_items = 'open' and j.status = 'completed' then 'PO shows Completed but some items are not despatched'
        end as problem,
        w.want_items as want) x
   where x.problem is not null
  union all
  select sr.job_no, null::int, 'PO status', 'PO is cancelled in the sheet but not in the app', 'cancelled', j.status::text, true
    from (select s.job_no from sr s group by s.job_no having bool_and(s.want = 'cancelled')) sr
    join jobs j on j.job_no = sr.job_no
   where j.status <> 'cancelled'
  union all
  select j.job_no, null::int, 'PO status', 'PO is Cancelled in the app but the sheet has items going ahead', 'not cancelled', 'cancelled', false
    from jobs j
   where j.status = 'cancelled' and exists (select 1 from sr where sr.job_no = j.job_no and sr.want in ('despatched','part'))

  -- 8. money: things that make "To receive from customers" too high
  union all
  select j.job_no, null::int, 'Finance', 'Invoices on this PO add up to more than the PO value',
         'PO value ' || round(x.po)::text, 'invoiced ' || round(x.inv)::text || ', unpaid ' || round(x.unpaid)::text, x.unpaid > 0
    from jobs j cross join lateral (
      select (select sum(p.total_value) from line_items li join line_item_prices p on p.line_item_id = li.id
               where li.job_id = j.id and coalesce(li.current_stage,'') not in ('item_cancelled','po_cancelled')) as po,
             (select sum(i.amount) from invoices i where i.job_id = j.id and i.amount is not null) as inv,
             (select coalesce(sum(greatest(0, i.amount - i.paid_amount - i.credited_amount)), 0) from inv i
               where i.job_id = j.id and not i.is_credit_note and not i.settled and i.amount is not null) as unpaid) x
   where x.po > 0 and x.inv > x.po * 1.02 + 100
  union all
  select sr.job_no, sr.line_no, 'Finance', 'Sheet shows a credit note but the app has none, and this PO still has money to receive',
         substring(sr.row->>'finance_notes' from 'Invoice cell: ([^|]*)'), null, true
    from sr
   where (sr.row->>'finance_notes') ~* 'Invoice cell:[^|]*\mCR'
     and not exists (select 1 from invoices i join jobs j on j.id = i.job_id where j.job_no = sr.job_no and i.is_credit_note)
     and exists (select 1 from inv i join jobs j on j.id = i.job_id where j.job_no = sr.job_no
                  and not i.is_credit_note and not i.settled and i.amount is not null and i.payment_status <> 'paid')
  union all
  select j.job_no, null::int, 'Finance', 'Unpaid invoice is only in the app (not in the sheet): check it is not a duplicate',
         null, i.invoice_no || ' ' || coalesce(round(i.amount - i.paid_amount - i.credited_amount)::text, ''), false
    from inv i join jobs j on j.id = i.job_id
   where not i.from_sheet and not i.is_credit_note and not i.settled and i.payment_status <> 'paid'
     and exists (select 1 from sheet_rows)
     and not exists (select 1 from sheet_inv si where si.no = i.invoice_no)
  union all
  select j.job_no, null::int, 'Finance', 'Unpaid invoice whose items the sheet has moved to other invoices',
         null, i.invoice_no || ' ' || coalesce(round(i.amount - i.paid_amount - i.credited_amount)::text, ''), true
    from inv i join jobs j on j.id = i.job_id
   where i.from_sheet and not i.is_credit_note and not i.settled and i.payment_status <> 'paid'
     and exists (select 1 from sheet_rows) and exists (select 1 from sr where sr.job_no = j.job_no)
     and not exists (select 1 from sheet_inv si where si.no = i.invoice_no)
  ;
end $$;
