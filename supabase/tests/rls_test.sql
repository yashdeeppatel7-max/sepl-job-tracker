-- Role-rule tests. Run with supabase/tests/run.sh (plain Postgres + auth stub).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- users, one per role (the trigger creates profiles; owner sets roles)
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001','dir@x', '{"full_name":"Director","role":"director"}'),
  ('00000000-0000-0000-0000-000000000002','ceo@x', '{"full_name":"CEO","role":"ceo"}'),
  ('00000000-0000-0000-0000-000000000003','adm@x', '{"full_name":"Admin","role":"admin"}'),
  ('00000000-0000-0000-0000-000000000004','acc@x', '{"full_name":"Accounts","role":"accounts"}'),
  ('00000000-0000-0000-0000-000000000005','pm@x',  '{"full_name":"Production","role":"production_manager"}'),
  ('00000000-0000-0000-0000-000000000006','new@x', '{"full_name":"Nobody"}');
update profiles set role = (select (raw_user_meta_data->>'role')::app_role from auth.users u where u.id = profiles.id);
-- sign-up metadata must not grant a role by itself
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000007','sneaky@x', '{"full_name":"Sneaky","role":"director"}');

create or replace function pg_temp.as_user(n int) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000' || n, false);
end $$;

create table pg_temp.results (name text, ok boolean);
grant all on pg_temp.results to authenticated;

-- ---------- Admin imports two jobs ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
set role authenticated;
select public.import_po_rows('[
 {"job_no":"23-1000","line_no":1,"customer":"RIL-JAM","customer_po_no":"MYB/240576617","po_date":"2023-03-27","delivery_date":"2023-08-04",
  "description":"STUB SHAFT;MOC:AISI 329","item_code":"2002341322","qty":3,"rate":50350,"basic_value":151050,"taxable_value":151050,
  "gst_pct":18,"gst_value":27189,"total_value":178239,"invoices":[{"no":"23/049","date":"2023-08-09"}],"status_text":""},
 {"job_no":"23-1000","line_no":2,"customer":"RIL-JAM","customer_po_no":"MYB/240576617","po_date":"2023-03-27","delivery_date":"2023-08-04",
  "description":"BOTTOM INTERMEDIATE SHAFT","item_code":"2002341323","qty":2,"rate":58500,"basic_value":117000,"taxable_value":117000,
  "gst_pct":18,"gst_value":21060,"total_value":138060,"invoices":[{"no":"23/051","date":"2023-08-12"},{"no":"23/059","date":"2023-08-26"}],"status_text":"COMPLETE ORDER DONE"},
 {"job_no":"25-1061","line_no":1,"customer":"INDORMA-NG","customer_po_no":"524816","po_date":"2025-12-31",
  "description":"PUMP SHAFT","item_code":"57-01-12-082","qty":1,"rate":213769.36,"basic_value":213769.36,"taxable_value":213769.36,"gst_pct":0,"total_value":213769.36}
]'::jsonb) \gset imp_
reset role;
insert into pg_temp.results values ('admin import created 2 jobs', (:'imp_import_po_rows'::jsonb->>'jobs_new')::int = 2);

-- re-import is idempotent
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[{"job_no":"25-1061","line_no":1,"customer":"INDORMA-NG","description":"PUMP SHAFT","qty":2,"total_value":1}]'::jsonb) \gset re_
reset role;
insert into pg_temp.results values ('re-import updates, no duplicates',
  (:'re_import_po_rows'::jsonb->>'items_updated')::int = 1 and (select count(*) from line_items) = 3
  and (select qty from line_items li join jobs j on j.id=li.job_id where job_no='25-1061') = 2);
insert into pg_temp.results values ('import marked invoiced + despatched stages',
  (select current_stage from line_items where description='BOTTOM INTERMEDIATE SHAFT') = 'despatched'
  and (select current_stage from line_items where description like 'STUB%') = 'despatched');

-- ---------- Production manager ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005'; set role authenticated;
insert into pg_temp.results values ('PM sees jobs and items', (select count(*) from jobs) = 2 and (select count(*) from line_items) = 3);
insert into pg_temp.results values ('PM sees NO prices',    (select count(*) from line_item_prices) = 0);
insert into pg_temp.results values ('PM sees NO job values',(select count(*) from job_values) = 0);
insert into pg_temp.results values ('PM sees NO invoices',  (select count(*) from invoices) = 0 and (select count(*) from invoice_status) = 0);
insert into pg_temp.results values ('PM sees NO despatches',(select count(*) from despatches) = 0);
insert into pg_temp.results values ('PM sees NO finance notes', not exists (select 1 from line_item_prices where finance_notes is not null));
insert into pg_temp.results values ('PM sees NO vendor bills',(select count(*) from vendor_bills) = 0);
insert into stage_events (line_item_id, stage_code, status, mode)
  select id, 'rm_ordered', 'done', 'in_house' from line_items where description = 'PUMP SHAFT';
insert into stage_events (line_item_id, stage_code, status, mode)
  select id, 'final_lathe', 'in_progress', 'job_work' from line_items where description = 'PUMP SHAFT';
insert into pg_temp.results values ('PM can update production stage',
  (select current_stage||'/'||current_status from line_items where description = 'PUMP SHAFT') = 'final_lathe/in_progress');
do $$ begin
  insert into stage_events (line_item_id, stage_code) select id, 'payment_received' from line_items where description = 'PUMP SHAFT';
  insert into pg_temp.results values ('PM blocked from finance stage', false);
exception when insufficient_privilege then insert into pg_temp.results values ('PM blocked from finance stage', true);
end $$;
do $$ begin
  update jobs set customer_po_no = 'hacked';
  insert into pg_temp.results values ('PM cannot edit jobs', not exists (select 1 from jobs where customer_po_no='hacked'));
end $$;
do $$ begin
  perform public.import_po_rows('[]'::jsonb);
  insert into pg_temp.results values ('PM cannot import', false);
exception when insufficient_privilege then insert into pg_temp.results values ('PM cannot import', true);
end $$;
do $$ begin
  update profiles set role = 'director' where id = auth.uid();
  insert into pg_temp.results values ('PM cannot promote self', (select role from profiles where id = auth.uid()) = 'production_manager');
end $$;
reset role;

-- ---------- Accounts ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
insert into pg_temp.results values ('Accounts sees prices', (select count(*) from line_item_prices) = 3);
insert into pg_temp.results values ('Accounts sees invoices', (select count(*) from invoice_status) = 3);
insert into payments (invoice_id, amount, reference) select id, 178239, 'UTR1' from invoices where invoice_no = '23/049';
insert into pg_temp.results values ('Accounts records payment -> paid',
  (select payment_status from invoice_status where invoice_no = '23/049') = 'paid');
insert into stage_events (line_item_id, stage_code) select id, 'payment_received' from line_items where description like 'STUB%';
insert into pg_temp.results values ('Accounts can mark payment stage', true);
do $$ begin
  insert into stage_events (line_item_id, stage_code) select id, 'final_lathe' from line_items where description like 'STUB%';
  insert into pg_temp.results values ('Accounts blocked from production stage', false);
exception when insufficient_privilege then insert into pg_temp.results values ('Accounts blocked from production stage', true);
end $$;
reset role;

-- Admin records a despatch; Accounts can see its status but not create one
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
insert into despatches (job_id, vehicle_no, lr_no) select id, 'GJ06AB1234', 'LR55' from jobs where job_no='23-1000';
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
insert into pg_temp.results values ('Accounts sees despatch status', (select count(*) from despatch_overview) = 1);
do $$ begin
  insert into despatches (job_id) select id from jobs limit 1;
  insert into pg_temp.results values ('Accounts cannot create despatch', false);
exception when insufficient_privilege then insert into pg_temp.results values ('Accounts cannot create despatch', true);
end $$;
reset role;

-- ---------- No role / owners ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000006'; set role authenticated;
insert into pg_temp.results values ('Sign-up cannot self-assign a role', (select role from profiles where full_name='Sneaky') is null);
insert into pg_temp.results values ('User without role sees nothing', (select count(*) from jobs) = 0 and (select count(*) from customers) = 0);
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
insert into pg_temp.results values ('Admin cannot assign roles', (select role from profiles where full_name='Nobody') is null);
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002'; set role authenticated;
update profiles set role = 'accounts' where full_name = 'Nobody';
insert into pg_temp.results values ('CEO assigns roles', (select role from profiles where full_name='Nobody') = 'accounts');
insert into pg_temp.results values ('CEO sees everything',
  (select count(*) from line_item_prices) = 3 and (select count(*) from despatches) = 1 and (select count(*) from payments) = 1);
reset role;

-- anon sees nothing
set role anon;
do $$ begin
  perform count(*) from jobs;
  insert into pg_temp.results values ('Anonymous blocked', false);
exception when insufficient_privilege then null; end $$;
reset role;
insert into pg_temp.results select 'Anonymous blocked', true where not exists (select 1 from pg_temp.results where name='Anonymous blocked');

-- ---------- Cancellation stages ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[
 {"job_no":"26-2000","line_no":1,"customer":"GNFC","description":"CANCEL ME","qty":1},
 {"job_no":"26-2000","line_no":2,"customer":"GNFC","description":"KEEP ME","qty":1},
 {"job_no":"26-2001","line_no":1,"customer":"GNFC","description":"SHORT A","qty":1},
 {"job_no":"26-2001","line_no":2,"customer":"GNFC","description":"SHORT B","qty":1}]'::jsonb);
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005'; set role authenticated;
do $$ begin
  insert into stage_events (line_item_id, stage_code) select id, 'item_cancelled' from line_items where description = 'CANCEL ME';
  insert into pg_temp.results values ('PM blocked from cancelling', false);
exception when insufficient_privilege then insert into pg_temp.results values ('PM blocked from cancelling', true);
end $$;
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
insert into stage_events (line_item_id, stage_code, status) select id, 'item_cancelled', 'done' from line_items where description = 'CANCEL ME';
insert into stage_events (line_item_id, stage_code, status) select id, 'despatched', 'done' from line_items where description = 'KEEP ME';
insert into pg_temp.results values ('item cancelled + rest despatched = job completed',
  (select status from jobs where job_no = '26-2000') = 'completed'
  and (select item_count from job_overview where job_no = '26-2000') = 1);
insert into stage_events (line_item_id, stage_code, status, note) select id, 'po_cancelled', 'done', 'Short closed' from line_items where description = 'SHORT A';
insert into pg_temp.results values ('PO cancelled cancels every item and the job',
  (select status from jobs where job_no = '26-2001') = 'cancelled'
  and (select count(*) from line_items li join jobs j on j.id = li.job_id where j.job_no = '26-2001' and li.current_stage = 'po_cancelled') = 2);
reset role;

-- ---------- Part despatch from the sheet ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[
 {"job_no":"25-3000","line_no":1,"customer":"GNFC","description":"PART ONE","qty":2,"invoices":[{"no":"26/018","date":"2026-05-25"}],"status_text":"Complete"},
 {"job_no":"25-3000","line_no":2,"customer":"GNFC","description":"PART TWO","qty":2,"invoices":[{"no":"26/030","date":"2026-06-19"}],"status_text":"01 No. Pending"}]'::jsonb);
reset role;
insert into pg_temp.results values ('sheet "Pending" = part despatched, PO stays open',
  (select current_stage||'/'||current_status from line_items where description = 'PART TWO') = 'despatched/in_progress'
  and (select status from jobs where job_no = '25-3000') = 'in_progress'
  and (select items_despatched from job_overview where job_no = '25-3000') = 1);
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[
 {"job_no":"25-3000","line_no":1,"customer":"GNFC","description":"PART ONE","qty":2,"invoices":[{"no":"26/018","date":"2026-05-25"}],"status_text":"Complete"},
 {"job_no":"25-3000","line_no":2,"customer":"GNFC","description":"PART TWO","qty":2,"invoices":[{"no":"26/030","date":"2026-06-19"}],"status_text":"Dsp-1_01 No. Pndng-01 No. Dsp-2 Completed"}]'::jsonb);
reset role;
insert into pg_temp.results values ('later "Completed" closes the PO',
  (select current_status from line_items where description = 'PART TWO') = 'done'
  and (select status from jobs where job_no = '25-3000') = 'completed');

-- ---------- Production incharge ----------
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000008','pi@x','{"full_name":"Incharge"}');
update profiles set role = 'production_incharge' where id = '00000000-0000-0000-0000-000000000008';
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000008'; set role authenticated;
insert into pg_temp.results values ('Incharge sees items, NO prices or invoices',
  (select count(*) from line_items) > 0 and (select count(*) from line_item_prices) = 0 and (select count(*) from invoices) = 0);
insert into stage_events (line_item_id, stage_code, status) select id, 'rm_ordered', 'done' from line_items where description = 'KEEP ME';
insert into pg_temp.results values ('Incharge can update production stage', exists (select 1 from stage_events where created_by = '00000000-0000-0000-0000-000000000008'));
do $$ begin
  insert into stage_events (line_item_id, stage_code) select id, 'invoiced' from line_items where description = 'KEEP ME';
  insert into pg_temp.results values ('Incharge blocked from finance stage', false);
exception when insufficient_privilege then insert into pg_temp.results values ('Incharge blocked from finance stage', true);
end $$;
reset role;

-- ---------- Sheet cleared = undo ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[{"job_no":"26-4000","line_no":1,"customer":"RIL-JAM","description":"UNDO ME","qty":1,"invoices":[{"no":"26/999","date":"2026-11-20"}]}]'::jsonb);
select public.import_po_rows('[{"job_no":"26-4000","line_no":1,"customer":"RIL-JAM","description":"UNDO ME","qty":1,"invoices":[]}]'::jsonb);
reset role;
insert into pg_temp.results values ('cleared invoice in sheet removes Excel stages + invoice',
  (select current_stage from line_items where description = 'UNDO ME') is null
  and not exists (select 1 from invoices where invoice_no = '26/999')
  and (select status from jobs where job_no = '26-4000') <> 'completed');
-- PM sees who made an update by someone else
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005'; set role authenticated;
insert into pg_temp.results values ('everyone sees updater names',
  exists (select 1 from stage_events where created_by_name = 'Incharge'));
reset role;

-- ---------- Rejected after despatch ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[{"job_no":"26-5000","line_no":1,"customer":"GNFC","description":"REJECT ME","qty":1,"invoices":[{"no":"26/500","date":"2026-10-01"}],"status_text":"Complete"}]'::jsonb);
insert into stage_events (line_item_id, stage_code, status, note, happened_on)
  select id, 'rejected', 'done', 'Customer rejected: OD undersize', '2026-11-10' from line_items where description = 'REJECT ME';
select public.import_po_rows('[{"job_no":"26-5000","line_no":1,"customer":"GNFC","description":"REJECT ME","qty":1,"invoices":[{"no":"26/500","date":"2026-10-01"}],"status_text":"Complete"}]'::jsonb);
reset role;
insert into pg_temp.results values ('rejection restarts item and reopens PO, old sheet invoice ignored',
  (select current_stage from line_items where description = 'REJECT ME') = 'rejected'
  and (select status from jobs where job_no = '26-5000') = 'in_progress');
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005'; set role authenticated;
insert into stage_events (line_item_id, stage_code, status) select id, 'rm_ordered', 'done' from line_items where description = 'REJECT ME';
reset role;
insert into pg_temp.results values ('new cycle continues from RM ordered',
  (select current_stage from line_items where description = 'REJECT ME') = 'rm_ordered');
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[{"job_no":"26-5000","line_no":1,"customer":"GNFC","description":"REJECT ME","qty":1,"invoices":[{"no":"26/500","date":"2026-10-01"},{"no":"26/600","date":"2026-12-01"}],"status_text":"Complete"}]'::jsonb);
reset role;
insert into pg_temp.results values ('new invoice after rejection = despatched again',
  (select current_stage from line_items where description = 'REJECT ME') = 'despatched'
  and (select status from jobs where job_no = '26-5000') = 'completed'
  and (select count(*) from stage_events e join line_items li on li.id = e.line_item_id where li.description = 'REJECT ME') = 6);

-- ---------- Editing entries ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000008'; set role authenticated;
update stage_events set note = 'fixed by incharge' where created_by = '00000000-0000-0000-0000-000000000008';
update stage_events set note = 'hacked' where created_by = '00000000-0000-0000-0000-000000000005';
reset role;
insert into pg_temp.results values ('own update can be edited, stamped with editor',
  exists (select 1 from stage_events where note = 'fixed by incharge' and edited_by_name = 'Incharge' and created_by_name = 'Incharge'));
insert into pg_temp.results values ('someone else''s update cannot be edited', not exists (select 1 from stage_events where note = 'hacked'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
update stage_events set note = 'admin fix' where created_by = '00000000-0000-0000-0000-000000000005' and stage_code = 'rm_ordered';
reset role;
insert into pg_temp.results values ('admin can edit anyone''s update', exists (select 1 from stage_events where note = 'admin fix' and edited_by_name = 'Admin'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
update invoices set invoice_no = '26/601' where invoice_no = '26/600';
reset role;
insert into pg_temp.results values ('accounts can correct an invoice no.', exists (select 1 from invoices where invoice_no = '26/601' and edited_by_name = 'Accounts'));

-- ---------- Representative tag ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
insert into job_reps (job_id, rep) select id, 'C Anant & Co.' from jobs where job_no = '26-5000';
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
insert into pg_temp.results values ('Accounts cannot see representative tags', (select count(*) from job_reps) = 0);
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005'; set role authenticated;
insert into pg_temp.results values ('Production cannot see representative tags', (select count(*) from job_reps) = 0);
reset role;

-- ---------- Payments move items to Payment received ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003'; set role authenticated;
select public.import_po_rows('[{"job_no":"26-6000","line_no":1,"customer":"GNFC","description":"PAY A","qty":1,"invoices":[{"no":"26/700","date":"2026-11-01"}],"status_text":"Complete"},
  {"job_no":"26-6000","line_no":2,"customer":"GNFC","description":"PAY B","qty":1,"invoices":[{"no":"26/700","date":"2026-11-01"}],"status_text":"Complete"}]'::jsonb);
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
update invoices set amount = 1000 where invoice_no = '26/700';
insert into payments (invoice_id, amount, paid_on) select id, 400, '2026-11-15' from invoices where invoice_no = '26/700';
reset role;
insert into pg_temp.results values ('part payment = Payment received in progress, PO stays open',
  (select current_stage || '/' || current_status from line_items where description = 'PAY A') = 'payment_received/in_progress'
  and (select status from jobs where job_no = '26-6000') = 'in_progress'
  and exists (select 1 from stage_events where note = 'From payments' and created_by_name = 'Accounts'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
insert into payments (invoice_id, amount, paid_on) select id, 600, '2026-11-20' from invoices where invoice_no = '26/700';
reset role;
insert into pg_temp.results values ('full payment = items Payment received, PO completed',
  (select count(*) from line_items where description like 'PAY _' and current_stage = 'payment_received' and current_status = 'done') = 2
  and (select status from jobs where job_no = '26-6000') = 'completed'
  and (select count(*) from stage_events e join line_items li on li.id = e.line_item_id where li.description like 'PAY _' and e.note = 'From payments') = 2
  and (select max(e.happened_on) from stage_events e join line_items li on li.id = e.line_item_id where li.description like 'PAY _' and e.note = 'From payments') = '2026-11-20');
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
delete from payments where invoice_id = (select id from invoices where invoice_no = '26/700');
reset role;
insert into pg_temp.results values ('payments removed = back to Despatched',
  (select count(*) from line_items where description like 'PAY _' and current_stage = 'despatched') = 2
  and not exists (select 1 from stage_events e join line_items li on li.id = e.line_item_id where li.description like 'PAY _' and e.note = 'From payments'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004'; set role authenticated;
update invoices set settled = true where invoice_no = '26/700';
reset role;
insert into pg_temp.results values ('invoice marked settled = items paid',
  (select count(*) from line_items where description like 'PAY _' and current_stage = 'payment_received' and current_status = 'done') = 2);

select case when ok then 'PASS' else 'FAIL' end as result, name from pg_temp.results;
select count(*) filter (where not ok) > 0 as failed, count(*) filter (where not ok) as failures from pg_temp.results \gset
\if :failed
  \echo :failures test(s) FAILED
  select 1/0;
\else
  \echo ALL PASSED
\endif
