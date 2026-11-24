-- Login emails of the active Director(s) and CEO(s), from the Users screen. Read-only.
select json_build_object(
  'director', coalesce((select json_agg(email) from profiles where active and role = 'director' and email is not null), '[]'),
  'ceo',      coalesce((select json_agg(email) from profiles where active and role = 'ceo'      and email is not null), '[]'));
