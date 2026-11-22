-- =====================================================================
-- One-off clean-up (22.11.2026): every unpaid invoice is marked paid,
-- EXCEPT all FY26-27 invoices (26/...) and FY25-26 invoices
-- 25/026, 25/058, 25/070, 25/091, 25/092, 25/102.
-- Invoices with an amount get a payment for the balance (so "received"
-- totals are right); invoices with no amount are marked settled.
-- Credit notes are left alone. Safe to run more than once.
-- =====================================================================

alter table invoices add column if not exists settled boolean not null default false;

-- invoice_status counts "settled" invoices as paid
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

drop table if exists pg_temp.to_clear;
create temp table to_clear as
select s.id, s.amount, s.paid_amount, s.invoice_date
  from invoice_status s
 where s.payment_status <> 'paid'
   and not s.is_credit_note and coalesce(s.amount, 0) >= 0
   and s.invoice_no not like '26/%'
   and s.invoice_no not in ('25/026','25/058','25/070','25/091','25/092','25/102');

insert into payments (invoice_id, paid_on, amount, reference)
select id, coalesce(invoice_date, current_date), amount - paid_amount, 'Old invoice marked paid (22.11.2026)'
  from to_clear where amount is not null and amount > paid_amount;

update invoices set settled = true where id in (select id from to_clear where amount is null or amount = 0);

select count(*) as invoices_marked_paid from to_clear;
drop table to_clear;
