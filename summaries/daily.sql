-- Daily WhatsApp summary: what moved since the last report, and what is stuck.
-- Returns one JSON object. Read-only. Dates are India time.
-- app.today can be set for testing (e.g. PGOPTIONS='-c app.today=2026-11-24').
with p as (
  select d as today,
         d - case when extract(isodow from d) = 1 then 2 else 1 end as since   -- Monday covers Sat + Sun
    from (select coalesce(nullif(current_setting('app.today', true), ''),
                          ((now() at time zone 'Asia/Kolkata')::date)::text)::date as d) x
),
ev as (
  select j.job_no, coalesce(c.code, '') as cust, li.line_no, li.description as item, li.qty,
         e.stage_code, s.label as stage, s.seq, e.status, coalesce(e.created_by_name, '') as by_name, e.created_at
    from stage_events e
    join line_items li on li.id = e.line_item_id
    join jobs j on j.id = li.job_id
    left join customers c on c.id = j.customer_id
    join stages s on s.code = e.stage_code, p
   where (e.created_at at time zone 'Asia/Kolkata')::date >= p.since
     and (e.created_at at time zone 'Asia/Kolkata')::date <  p.today
     and e.stage_code not in ('invoiced', 'payment_received')     -- shown under invoices / payments
),
-- latest move per item in the window
last_ev as (
  select distinct on (job_no, line_no) * from ev order by job_no, line_no, seq desc, created_at desc
),
moves as (
  select job_no, cust,
         json_agg(json_build_object('item', item, 'qty', qty, 'stage', stage, 'status', status, 'by', by_name)
                  order by line_no) as items,
         max(created_at) as at
    from last_ev where stage_code <> 'despatched'
   group by job_no, cust
),
desp as (
  select job_no, cust,
         json_agg(json_build_object('item', item, 'qty', qty, 'part', status = 'in_progress') order by line_no) as items
    from last_ev where stage_code = 'despatched'
   group by job_no, cust
),
inv as (
  select i.invoice_no, j.job_no, coalesce(c.code, '') as cust, i.amount, i.is_credit_note as credit_note
    from invoices i join jobs j on j.id = i.job_id left join customers c on c.id = j.customer_id, p
   where (i.created_at at time zone 'Asia/Kolkata')::date >= p.since
     and (i.created_at at time zone 'Asia/Kolkata')::date <  p.today
),
pay as (
  select i.invoice_no, j.job_no, coalesce(c.code, '') as cust, pm.amount
    from payments pm join invoices i on i.id = pm.invoice_id join jobs j on j.id = i.job_id
    left join customers c on c.id = j.customer_id, p
   where (pm.created_at at time zone 'Asia/Kolkata')::date >= p.since
     and (pm.created_at at time zone 'Asia/Kolkata')::date <  p.today
),
-- open jobs with where their slowest unfinished item stands
open_items as (
  select li.job_id, li.current_stage, coalesce(li.stage_updated_at, li.created_at) as touched, s.seq, s.label
    from line_items li left join stages s on s.code = li.current_stage
   where not public.item_finished(li.current_stage, li.current_status)
     and coalesce(li.current_stage, '') not in ('item_cancelled', 'po_cancelled')
),
open_jobs as (
  select j.job_no, coalesce(c.code, '') as cust, j.delivery_date,
         count(oi.*) as items_left,
         (array_agg(coalesce(oi.label, 'Not started') order by coalesce(oi.seq, 0)))[1] as at_stage,
         max(oi.touched) as last_update
    from jobs j left join customers c on c.id = j.customer_id
    join open_items oi on oi.job_id = j.id
   where j.status not in ('completed', 'cancelled')
   group by j.id, c.code
),
o as (
  select oj.*, p.today - oj.delivery_date as days_late,
         p.today - (oj.last_update at time zone 'Asia/Kolkata')::date as idle_days
    from open_jobs oj, p
)
select json_build_object(
  'today', (select today from p),
  'since', (select since from p),
  'moves', coalesce((select json_agg(json_build_object('job', job_no, 'cust', cust, 'items', items) order by at desc) from moves), '[]'),
  'despatches', coalesce((select json_agg(json_build_object('job', job_no, 'cust', cust, 'items', items) order by job_no) from desp), '[]'),
  'invoices', coalesce((select json_agg(row_to_json(inv) order by invoice_no) from inv), '[]'),
  'payments', coalesce((select json_agg(row_to_json(pay) order by amount desc) from pay), '[]'),
  'due_soon', coalesce((select json_agg(json_build_object('job', job_no, 'cust', cust, 'in', -days_late, 'stage', at_stage, 'left', items_left)
                                 order by delivery_date) from o where days_late between -7 and 0), '[]'),
  'idle', coalesce((select json_agg(json_build_object('job', job_no, 'cust', cust, 'days', idle_days, 'stage', at_stage, 'left', items_left)
                                 order by idle_days desc) from o
                     where idle_days >= 10 and coalesce(days_late, 0) <= 90), '[]')   -- skip very old POs nobody closed
);
