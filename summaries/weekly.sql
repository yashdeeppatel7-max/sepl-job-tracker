-- Weekly WhatsApp summary of money due, for the Director only.
-- Returns one JSON object. Read-only. Dates are India time.
with p as (
  select coalesce(nullif(current_setting('app.today', true), ''),
                  ((now() at time zone 'Asia/Kolkata')::date)::text)::date as today
),
due as (
  select s.invoice_no, s.job_no, coalesce(s.customer_code, '') as cust, s.invoice_date, s.due_date,
         s.amount - s.paid_amount as balance, s.payment_status = 'part_paid' as part_paid,
         p.today - coalesce(s.invoice_date, s.created_at::date) as age
    from invoice_status s, p
   where s.payment_status in ('unpaid', 'part_paid') and not s.is_credit_note
     and s.amount is not null and s.amount - s.paid_amount > 0
),
bills as (
  select b.bill_no, coalesce(v.name, '') as vendor, b.amount, p.today - coalesce(b.bill_date, b.created_at::date) as age
    from vendor_bills b left join vendors v on v.id = b.vendor_id, p
   where not b.paid
)
select json_build_object(
  'today', (select today from p),
  'total', coalesce((select sum(balance) from due), 0),
  'count', (select count(*) from due),
  'aging', json_build_object(
     'd0_30',  coalesce((select sum(balance) from due where age <= 30), 0),
     'd31_60', coalesce((select sum(balance) from due where age between 31 and 60), 0),
     'd61_90', coalesce((select sum(balance) from due where age between 61 and 90), 0),
     'd90',    coalesce((select sum(balance) from due where age > 90), 0)),
  'past_due_date', coalesce((select json_agg(row_to_json(d) order by d.due_date)
                               from due d, p where d.due_date < p.today), '[]'),
  'by_customer', coalesce((select json_agg(x order by x.balance desc) from (
       select cust, sum(balance) as balance, count(*) as n, max(age) as oldest from due group by cust) x), '[]'),
  'oldest', coalesce((select json_agg(d order by d.age desc) from (select * from due order by age desc limit 15) d), '[]'),
  'received_7d', coalesce((select sum(pm.amount) from payments pm, p
                            where (pm.created_at at time zone 'Asia/Kolkata')::date > p.today - 7), 0),
  'no_amount', (select count(*) from invoice_status s
                 where s.amount is null and not s.is_credit_note and s.payment_status <> 'paid'),
  'bills_total', coalesce((select sum(amount) from bills), 0),
  'bills', coalesce((select json_agg(b order by b.age desc) from (select * from bills order by age desc limit 10) b), '[]')
);
