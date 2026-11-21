-- =====================================================================
-- Show each person's email on the app's Users screen, so people added
-- straight in Supabase (with no name) can be told apart and given a role.
-- Safe to run more than once.
-- =====================================================================
alter table profiles add column if not exists email text;

update profiles p set email = u.email from auth.users u where u.id = p.id and p.email is distinct from u.email;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
