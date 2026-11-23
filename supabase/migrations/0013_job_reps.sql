-- =====================================================================
-- POs handled through a representative (e.g. C Anant & Co.).
-- Kept in its own table so only Director, CEO and Admin can see or set it.
-- Safe to run more than once.
-- =====================================================================
create table if not exists job_reps (
  job_id     uuid primary key references jobs(id) on delete cascade,
  rep        text not null,
  created_at timestamptz not null default now()
);
alter table job_reps enable row level security;
drop policy if exists job_reps_mgmt on job_reps;
create policy job_reps_mgmt on job_reps for all using (public.is_mgmt()) with check (public.is_mgmt());
grant select, insert, update, delete on job_reps to authenticated;
