-- Counts of sheet-vs-app problems by kind. No PO numbers, names or amounts: the repository is public.
select case when serious then 'FIX ' else 'note' end as kind, area, problem, count(*) as n
  from public.sheet_check() group by 1, 2, 3 order by 1, 2, 3;
