#!/usr/bin/env bash
# Tries the given migration files on the live database inside transactions that are always
# rolled back, and compares the Sheet check before and after. Fails (so nothing is applied) if a
# file errors or if the changes would create new "needs fixing" problems.
# "Before" is measured with the NEW version of the check, so adding a check never blocks itself.
# Usage: DB_URL=... supabase/check/dry-run.sh file1.sql file2.sql ...
set -euo pipefail
[ $# -gt 0 ] || { echo "Nothing to try."; exit 0; }
tmp=$(mktemp -d)
CHECK_FNS="'sheet_check','sheet_item_state','app_item_state','item_finished'"

# 1. apply the files, keep the new check's code, then also replay the last sheet sync and count
{
  echo '\set ON_ERROR_STOP 1'
  echo 'begin;'
  for f in "$@"; do echo "\\echo == trying $f"; echo "\\i $f"; done
  echo "\\t on"
  echo "\\a"
  echo "select string_agg(pg_get_functiondef(p.oid) || ';', E'\\n') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ($CHECK_FNS) \\g $tmp/check_fns.sql"
  echo "\\t off"
  echo "\\a"
  # replay the last sheet sync, as the next hourly sync would (as a Director, so the import is allowed)
  echo "\\echo == replaying the last sheet sync"
  echo "select 'as Director' as replay from (select set_config('request.jwt.claims', json_build_object('sub', (select id from profiles where role = 'director' order by created_at limit 1), 'role', 'authenticated')::text, true),
               set_config('request.jwt.claim.sub', (select id from profiles where role = 'director' order by created_at limit 1)::text, true)) x;"
  echo "select public.import_po_rows(rows) is not null as synced from (select jsonb_agg(row order by job_no, line_no) as rows from sheet_rows) x where rows is not null;"
  echo "\\copy (select area, problem, count(*) from public.sheet_check() where serious group by 1, 2) to '$tmp/after.tsv'"
  echo 'rollback;'
} > "$tmp/after.sql"
psql "$DB_URL" -X -q -f "$tmp/after.sql"

# 2. today's data, measured with the new check
{
  echo '\set ON_ERROR_STOP 1'
  echo 'begin;'
  echo "\\i $tmp/check_fns.sql"
  echo "\\copy (select area, problem, count(*) from public.sheet_check() where serious group by 1, 2) to '$tmp/before.tsv'"
  echo 'rollback;'
} > "$tmp/before.sql"
psql "$DB_URL" -X -q -f "$tmp/before.sql" >/dev/null

# 3. compare (counts only: the repository is public)
echo "== Sheet check 'needs fixing', before -> after (counts only)"
worse=0
while IFS=$'\t' read -r area problem n; do
  b=$(awk -F'\t' -v a="$area" -v p="$problem" '$1==a && $2==p {print $3}' "$tmp/before.tsv"); b=${b:-0}
  printf '  %-10s %-75s %5s -> %s\n' "$area" "$problem" "$b" "$n"
  [ "$n" -gt "$b" ] && worse=1
done < "$tmp/after.tsv"
while IFS=$'\t' read -r area problem n; do
  grep -qF "$area	$problem	" "$tmp/after.tsv" || printf '  %-10s %-75s %5s -> 0\n' "$area" "$problem" "$n"
done < "$tmp/before.tsv"
if [ "$worse" = 1 ]; then
  echo "::error::These database changes would make the app disagree with the sheet in more places. Nothing was applied."
  exit 1
fi
echo "Dry run OK: no new problems."
