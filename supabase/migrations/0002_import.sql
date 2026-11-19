-- =====================================================================
-- Excel import. The app parses the sheet on the phone and sends clean rows
-- here; this function saves them in one transaction. Running the same
-- sheet again updates jobs and items instead of duplicating them.
-- Only Director, CEO and Admin may import.
-- =====================================================================

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
  v_jobs_new   int := 0;
  v_jobs_upd   int := 0;
  v_items_new  int := 0;
  v_items_upd  int := 0;
  v_invoices   int := 0;
  v_inserted   boolean;
  v_seen_jobs  text[] := '{}';
  inv          jsonb;
begin
  if not public.is_mgmt() then
    raise exception 'Only Director, CEO or Admin can import POs' using errcode = '42501';
  end if;

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

    -- invoices (historical rows already billed; one item can be on several invoices)
    for inv in select * from jsonb_array_elements(coalesce(r->'invoices', '[]'::jsonb)) loop
      insert into invoices (job_id, invoice_no, invoice_date)
      values (v_job, inv->>'no', nullif(inv->>'date','')::date)
      on conflict (invoice_no) do update set invoice_date = coalesce(excluded.invoice_date, invoices.invoice_date)
      returning id, (xmax = 0) into v_inv, v_inserted;
      if v_inserted then v_invoices := v_invoices + 1; end if;
      insert into invoice_items (invoice_id, line_item_id) values (v_inv, v_item) on conflict do nothing;
      if not exists (select 1 from stage_events where line_item_id = v_item and stage_code = 'invoiced') then
        insert into stage_events (line_item_id, stage_code, status, note, happened_on)
        values (v_item, 'invoiced', 'done', 'From Excel import',
                coalesce(nullif(inv->>'date','')::date, current_date));
      end if;
    end loop;

    -- "Complete" in the sheet = despatched
    if v_status like '%complete%' and not exists
         (select 1 from stage_events where line_item_id = v_item and stage_code = 'despatched') then
      insert into stage_events (line_item_id, stage_code, status, note, happened_on)
      values (v_item, 'despatched', 'done', 'From Excel import',
              coalesce((select max(nullif(i->>'date','')::date) from jsonb_array_elements(coalesce(r->'invoices','[]'::jsonb)) i), current_date));
    end if;
  end loop;

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

grant execute on function public.import_po_rows(jsonb) to authenticated;
