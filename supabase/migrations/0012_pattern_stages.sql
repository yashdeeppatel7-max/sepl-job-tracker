-- Two production stages before raw material: Pattern started, Pattern sent to casting.
-- Safe to run more than once.
insert into stages (code, seq, label, owner, optional_for) values
  ('pattern_started', 6, 'Pattern started',         'production', null),
  ('pattern_to_casting', 7, 'Pattern sent to casting', 'production', null)
on conflict (code) do update set seq = excluded.seq, label = excluded.label, owner = excluded.owner;
