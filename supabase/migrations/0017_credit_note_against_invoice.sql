-- A credit note can name the invoice it is raised against. That invoice's balance is reduced
-- by the credit note, so an invoice fully covered by credit notes (+ payments) shows as paid.
alter table invoices add column if not exists against_invoice_id uuid references invoices(id) on delete set null;
create index if not exists invoices_against_idx on invoices (against_invoice_id);

-- link existing credit notes: same PO, an invoice of exactly the same amount, dated on or before
-- the credit note, not already used by another credit note
do $$
declare cn record; v uuid;
begin
  for cn in select * from invoices where is_credit_note and against_invoice_id is null and amount is not null
            order by invoice_date nulls last, created_at loop
    select i.id into v from invoices i
     where i.job_id = cn.job_id and not i.is_credit_note and i.amount = -cn.amount
       and (cn.invoice_date is null or i.invoice_date is null or i.invoice_date <= cn.invoice_date)
       and not exists (select 1 from invoices o where o.against_invoice_id = i.id)
     order by i.invoice_date desc nulls last limit 1;
    if v is not null then update invoices set against_invoice_id = v where id = cn.id; end if;
  end loop;
end $$;

drop view if exists invoice_status;
create view invoice_status with (security_invoker = true) as
select i.*, j.job_no, c.code as customer_code,
       x.paid as paid_amount,
       x.credited as credited_amount,
       case when i.is_credit_note or i.settled then 'paid'
            when i.amount is not null and x.paid + x.credited >= i.amount then 'paid'
            when x.paid > 0 or x.credited > 0 then 'part_paid'
            else 'unpaid' end as payment_status
  from invoices i join jobs j on j.id = i.job_id left join customers c on c.id = j.customer_id
  cross join lateral (select
       coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0) as paid,
       coalesce((select -sum(cn.amount) from invoices cn where cn.against_invoice_id = i.id and cn.is_credit_note), 0) as credited) x;
grant select on invoice_status to authenticated;

drop trigger if exists invoices_sync_items on invoices;
create trigger invoices_sync_items after insert or delete or update of amount, settled, is_credit_note, invoice_date, job_id, against_invoice_id on invoices
  for each row execute function public.invoices_sync_items();

do $$
declare v uuid;
begin
  for v in select distinct job_id from invoices where is_credit_note loop
    perform public.sync_job_payments(v);
  end loop;
end $$;
