#!/usr/bin/env bash
# Tries the given migration files on the live database inside a transaction that is always
# rolled back, and compares the Sheet check before and after. Fails (so nothing is applied) if a
# file errors or if the changes would create new "needs fixing" problems.
# Usage: DB_URL=... supabase/check/dry-run.sh file1.sql file2.sql ...
set -euo pipefail
[ $# -gt 0 ] || { echo "Nothing to try."; exit 0; }
out=$(mktemp)
{
  echo '\set ON_ERROR_STOP 1'
  echo 'begin;'
  echo "create temp table _before as select serious, area, problem from public.sheet_check();"
  for f in "$@"; do echo "\\echo == trying $f"; echo "\\i $f"; done
  echo "create temp table _after as select serious, area, problem from public.sheet_check();"
  echo "\\echo == Sheet check before -> after (counts only)"
  echo "select coalesce(a.area, b.area) as area, coalesce(a.problem, b.problem) as problem,
               coalesce(b.n, 0) as before, coalesce(a.n, 0) as after
          from (select area, problem, count(*) n from _after where serious group by 1, 2) a
          full join (select area, problem, count(*) n from _before where serious group by 1, 2) b
            on a.area = b.area and a.problem = b.problem order by 1, 2;"
  echo "select (select count(*) from _after where serious) > (select count(*) from _before where serious) as worse \\gset"
  echo "rollback;"
  echo "\\if :worse"
  echo "  \\echo NEW-PROBLEMS"
  echo "\\endif"
} > "$out"
psql "$DB_URL" -X -q -f "$out" | tee "$out.log"
if grep -q NEW-PROBLEMS "$out.log"; then
  echo "::error::These database changes would make the app disagree with the sheet in more places. Nothing was applied."
  exit 1
fi
echo "Dry run OK: no new problems."
