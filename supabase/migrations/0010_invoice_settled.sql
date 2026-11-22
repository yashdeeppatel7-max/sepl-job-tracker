-- An invoice can be marked settled (paid) without a payment amount, e.g. old invoices with no amount.
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
