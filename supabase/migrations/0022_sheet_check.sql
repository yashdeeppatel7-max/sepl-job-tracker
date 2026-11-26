-- "Sheet check": compares every PO row in the Google Sheet with what the app shows.
--  * sheet_rows keeps a copy of the rows the last sheet sync sent (import_po_rows saves them).
--  * sheet_check() lists every place the app disagrees with the sheet, or with itself
--    (payments vs Paid / Part paid, items vs Ongoing / Completed, stale stages).
-- Used by the app's "Sheet check" screen (Director, CEO, Admin) and by the GitHub check that
-- runs before database changes go live. Read-only: it never changes data.

create table if not exists sheet_rows (
  job_no    text not null,
  line_no   int  not null,
  row       jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (job_no, line_no)
);
alter table sheet_rows enable row level security;
drop policy if exists sheet_rows_read on sheet_rows;
create policy sheet_rows_read on sheet_rows for select using (public.is_mgmt());
drop policy if exists sheet_rows_write on sheet_rows;
create policy sheet_rows_write on sheet_rows for all using (public.is_mgmt()) with check (public.is_mgmt());
grant select, insert, update, delete on sheet_rows to authenticated;
revoke all on sheet_rows from anon;

-- The sheet sync saves its rows here (same as before otherwise)
create or replace function public.import_po_rows(p_rows jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  r            jsonb;
  v_customer   uuid;
  v_job        uuid;
  v_item       uuid;
  v_inv        uuid;
  v_status     text;
  v_partial    boolean;
  v_cycle      timestamptz;
  v_rej_on     date;
  v_invs       jsonb;
  v_dstatus    text;
  v_jobs_new   int := 0;
  v_jobs_upd   int := 0;
  v_items_new  int := 0;
  v_items_upd  int := 0;
  v_invoices   int := 0;
  v_inserted   boolean;
  v_seen_jobs  text[] := '{}';
  inv          jsonb;
  v_amt        jsonb := '{}';  -- invoice no -> {sum, ok}: value of items whose sheet cell lists only that invoice
begin
  if not (public.is_mgmt() or current_user = 'service_role') then
    raise exception 'Only Director, CEO or Admin can import POs' using errcode = '42501';
  end if;

  -- keep a copy of what the sheet said, for the Sheet check
  delete from sheet_rows where true;
  insert into sheet_rows (job_no, line_no, row)
  select x->>'job_no', (x->>'line_no')::int, x from jsonb_array_elements(p_rows) x
  on conflict (job_no, line_no) do update set row = excluded.row, synced_at = now();

  for r in select * from jsonb_array_elements(p_rows) loop
    -- customer
    insert into customers (code) values (upper(trim(r->>'customer')))
      on conflict (code) do update set code = excluded.code
      returning id into v_customer;

    v_status := lower(coalesce(r->>'status_text', ''));

    -- job (first row of a job decides header fields)
    if not (r->>'job_no' = any(v_seen_jobs)) then
      insert into jobs (job_no, customer_id, customer_po_no, po_date, delivery_date, tpi_required, status)
      values (r->>'job_no', v_customer, nullif(r->>'customer_po_no',''),
              nullif(r->>'po_date','')::date, nullif(r->>'delivery_date','')::date,
              coalesce((r->>'tpi')::boolean, false),
              case when v_status like '%cancel%' then 'cancelled'
                   when v_status like '%hold%'   then 'on_hold'
                   else 'po_received' end::job_status)
      on conflict (job_no) do update set
        customer_id    = excluded.customer_id,
        customer_po_no = coalesce(excluded.customer_po_no, jobs.customer_po_no),
        po_date        = coalesce(excluded.po_date, jobs.po_date),
        delivery_date  = coalesce(excluded.delivery_date, jobs.delivery_date),
        tpi_required   = excluded.tpi_required or jobs.tpi_required,
        status         = case when excluded.status in ('cancelled','on_hold') then excluded.status else jobs.status end,
        updated_at     = now()
      returning id, (xmax = 0) into v_job, v_inserted;
      if v_inserted then v_jobs_new := v_jobs_new + 1; else v_jobs_upd := v_jobs_upd + 1; end if;
      v_seen_jobs := v_seen_jobs || (r->>'job_no');
    else
      select id into v_job from jobs where job_no = r->>'job_no';
    end if;

    -- line item
    insert into line_items (job_id, line_no, description, item_code, qty)
    values (v_job, (r->>'line_no')::int, coalesce(nullif(r->>'description',''), '(no description)'),
            nullif(r->>'item_code',''), coalesce(nullif(r->>'qty','')::numeric, 1))
    on conflict (job_id, line_no) do update set
      description = excluded.description, item_code = excluded.item_code, qty = excluded.qty
    returning id, (xmax = 0) into v_item, v_inserted;
    if v_inserted then v_items_new := v_items_new + 1; else v_items_upd := v_items_upd + 1; end if;

    -- prices
    insert into line_item_prices as p (line_item_id, rate, basic_value, pf_pct, pf_value, freight_pct, freight_value,
                                  discount, taxable_value, gst_pct, gst_value, total_value, finance_notes)
    values (v_item,
            nullif(r->>'rate','')::numeric, nullif(r->>'basic_value','')::numeric,
            coalesce(nullif(r->>'pf_pct','')::numeric, 0), coalesce(nullif(r->>'pf_value','')::numeric, 0),
            coalesce(nullif(r->>'freight_pct','')::numeric, 0), coalesce(nullif(r->>'freight_value','')::numeric, 0),
            coalesce(nullif(r->>'discount','')::numeric, 0),
            nullif(r->>'taxable_value','')::numeric, nullif(r->>'gst_pct','')::numeric,
            nullif(r->>'gst_value','')::numeric, nullif(r->>'total_value','')::numeric,
            nullif(r->>'finance_notes',''))
    on conflict (line_item_id) do update set
      rate = excluded.rate, basic_value = excluded.basic_value, pf_pct = excluded.pf_pct, pf_value = excluded.pf_value,
      freight_pct = excluded.freight_pct, freight_value = excluded.freight_value, discount = excluded.discount,
      taxable_value = excluded.taxable_value, gst_pct = excluded.gst_pct, gst_value = excluded.gst_value,
      total_value = excluded.total_value, finance_notes = excluded.finance_notes;

    -- invoice amounts from the sheet row: an item whose cell names one invoice counts fully toward it;
    -- an item split over several invoices makes those amounts unknown (Accounts fills them in)
    for inv in select * from jsonb_array_elements(coalesce(r->'invoices', '[]'::jsonb)) loop
      v_amt := jsonb_set(v_amt, array[inv->>'no'], jsonb_build_object(
        'sum', coalesce((v_amt->(inv->>'no')->>'sum')::numeric, 0) + coalesce(nullif(r->>'total_value','')::numeric, 0),
        'ok',  coalesce((v_amt->(inv->>'no')->>'ok')::boolean, true)
               and jsonb_array_length(r->'invoices') = 1 and nullif(r->>'total_value','') is not null));
    end loop;

    -- invoices (historical rows already billed; one item can be on several invoices)
    for inv in select * from jsonb_array_elements(coalesce(r->'invoices', '[]'::jsonb)) loop
      insert into invoices (job_id, invoice_no, invoice_date, from_sheet)
      values (v_job, inv->>'no', nullif(inv->>'date','')::date, true)
      on conflict (invoice_no) do update set invoice_date = coalesce(excluded.invoice_date, invoices.invoice_date)
      returning id, (xmax = 0) into v_inv, v_inserted;
      if v_inserted then v_invoices := v_invoices + 1; end if;
      insert into invoice_items (invoice_id, line_item_id) values (v_inv, v_item) on conflict do nothing;
    end loop;

    -- Rejected by the customer: the item starts a new cycle. Only invoices dated on or
    -- after the rejection count for the new cycle, and the sheet's old "Complete" is ignored.
    select max(created_at), (array_agg(happened_on order by created_at desc))[1] into v_cycle, v_rej_on
      from stage_events where line_item_id = v_item and stage_code = 'rejected';
    if v_cycle is null then
      v_invs := coalesce(r->'invoices', '[]'::jsonb);
      v_dstatus := v_status;
      v_cycle := '-infinity';
    else
      select coalesce(jsonb_agg(x), '[]'::jsonb) into v_invs
        from jsonb_array_elements(coalesce(r->'invoices','[]'::jsonb)) x
       where nullif(x->>'date','')::date >= v_rej_on;
      v_dstatus := '';
    end if;

    -- Cells cleared in the sheet: undo what an earlier sync added for this item.
    -- Only touches invoices the sheet created that have no payments, and stage
    -- updates marked "From Excel import" in the current cycle; app updates are kept.
    delete from invoice_items ii using invoices i
     where ii.invoice_id = i.id and ii.line_item_id = v_item and i.from_sheet
       and not exists (select 1 from payments p where p.invoice_id = i.id)
       and not (i.invoice_no in (select x->>'no' from jsonb_array_elements(coalesce(r->'invoices','[]'::jsonb)) x));
    if jsonb_array_length(v_invs) = 0 then
      delete from stage_events where line_item_id = v_item and stage_code = 'invoiced'
         and note = 'From Excel import' and created_at >= v_cycle;
      if v_dstatus !~ '(complete|done|pend|pndng)' then
        delete from stage_events where line_item_id = v_item and stage_code = 'despatched'
           and note = 'From Excel import' and created_at >= v_cycle;
      end if;
    elsif not exists (select 1 from stage_events where line_item_id = v_item and stage_code = 'invoiced' and created_at >= v_cycle) then
      insert into stage_events (line_item_id, stage_code, status, note, happened_on)
      values (v_item, 'invoiced', 'done', 'From Excel import',
              coalesce((select min(nullif(i->>'date','')::date) from jsonb_array_elements(v_invs) i), current_date));
    end if;

    -- Invoiced, or "Complete"/"Done" in the sheet = despatched (invoice and despatch go together).
    -- "Pending" in the status (e.g. "Pending - 03 Nos") = only part despatched (recorded as Started).
    -- A later "Complete" after the last "pending" counts as done.
    v_partial := v_dstatus ~ '(pend|pndng)'
                 and regexp_replace(v_dstatus, '^.*(pend|pndng)', '') !~ '(complete|done)';
    if v_dstatus ~ '(complete|done|pend|pndng)' or jsonb_array_length(v_invs) > 0 then
      if exists (select 1 from stage_events where line_item_id = v_item and stage_code = 'despatched' and created_at >= v_cycle) then
        update stage_events set status = case when v_partial then 'in_progress' else 'done' end
         where line_item_id = v_item and stage_code = 'despatched' and note = 'From Excel import'
           and created_at >= v_cycle
           and status <> case when v_partial then 'in_progress' else 'done' end;
      elsif jsonb_array_length(v_invs) > 0 or not v_partial then
        insert into stage_events (line_item_id, stage_code, status, note, happened_on)
        values (v_item, 'despatched', case when v_partial then 'in_progress' else 'done' end, 'From Excel import',
                coalesce((select max(nullif(i->>'date','')::date) from jsonb_array_elements(v_invs) i), current_date));
      end if;
    end if;
  end loop;

  -- sheet invoices no longer on any item (and never paid) are removed
  delete from invoices i where i.from_sheet
     and not exists (select 1 from invoice_items ii where ii.invoice_id = i.id)
     and not exists (select 1 from payments p where p.invoice_id = i.id);

  update invoices i set amount = (x.value->>'sum')::numeric
    from jsonb_each(v_amt) x
   where i.invoice_no = x.key and i.amount is null and not i.is_credit_note
     and (x.value->>'ok')::boolean and (x.value->>'sum')::numeric > 0;

  -- invoice amounts: an item on one invoice counts fully; split items are left for Accounts to fill
  update invoices i set amount = x.total
    from (select ii.invoice_id, sum(p.total_value) as total
            from invoice_items ii join line_item_prices p on p.line_item_id = ii.line_item_id
           where (select count(*) from invoice_items o where o.line_item_id = ii.line_item_id) = 1
           group by ii.invoice_id) x
   where i.id = x.invoice_id and i.amount is null;

  return jsonb_build_object('jobs_new', v_jobs_new, 'jobs_updated', v_jobs_upd,
                            'items_new', v_items_new, 'items_updated', v_items_upd,
                            'invoices_new', v_invoices);
end $$;

-- What the sheet says about one item: cancelled / part (part despatched) / despatched / open
create or replace function public.sheet_item_state(p_row jsonb) returns text
language sql immutable as $$
  select case
    when s ~ 'cancel' then 'cancelled'
    when s ~ '(pend|pndng)' and regexp_replace(s, '^.*(pend|pndng)', '') !~ '(complete|done)' then 'part'
    when jsonb_array_length(coalesce(p_row->'invoices','[]')) > 0 or s ~ '(complete|done)' then 'despatched'
    else 'open' end
  from (select lower(coalesce(p_row->>'status_text','')) as s) x
$$;

-- What the app shows for one item, in the same words
create or replace function public.app_item_state(p_stage text, p_status text) returns text
language sql immutable as $$
  select case
    when p_stage in ('item_cancelled','po_cancelled') then 'cancelled'
    when p_stage = 'despatched' and p_status = 'in_progress' then 'part'
    when public.item_finished(p_stage, p_status) then 'despatched'
    else 'open' end
$$;

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
  ;
end $$;
grant execute on function public.sheet_check() to authenticated;
revoke execute on function public.sheet_check() from anon;
