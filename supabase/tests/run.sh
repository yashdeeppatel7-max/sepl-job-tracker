#!/usr/bin/env bash
# Usage: PGHOST=/tmp PGPORT=54329 PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dropdb --if-exists po_test && createdb po_test
psql -q -v ON_ERROR_STOP=1 -d po_test -f tests/auth_stub.sql
for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d po_test -f "$f"; done
psql -q -v ON_ERROR_STOP=1 -d po_test -f tests/rls_test.sql
