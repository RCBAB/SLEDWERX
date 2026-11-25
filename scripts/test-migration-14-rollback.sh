#!/usr/bin/env bash
# Tests supabase/rollback/20261128090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-14 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 13 state, so the Migration 13
# rollback test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-14-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261128090000_rollback.sql
MIGRATION=supabase/migrations/20261128090000_inspection_baseline_time.sql
M13=supabase/migrations/20261127090000_maintenance_inspections.sql
CONFIRM="set sledwerx.confirm_rollback = '20261128090000';"
USER_ID=99999999-9999-9999-9999-999999999914
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
reapply() {
  { echo "begin;"; cat "$MIGRATION";
    echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261128090000', 'inspection_baseline_time');";
    echo "commit;"; } | psql_run > "$OUT" 2>&1
}
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
uuid_of() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
has_m14() { query "select count(*) from information_schema.columns where table_name = 'maintenance_plans' and column_name = 'inspect_baseline_at';"; }
view_md5() { query "select md5(pg_get_viewdef('public.maintenance_board'::regclass, true));"; }
# Migration 13's own board, created in a rolled-back transaction (after Migration 14's column is dropped there) and fingerprinted.
m13_view_md5() {
  { echo "begin; drop view public.maintenance_board; drop trigger inspect_baseline_time on public.maintenance_plans;";
    echo "alter table public.maintenance_plans drop column inspect_baseline_at;";
    awk '/^create or replace view public.maintenance_board/,/^from inspect_status c;/' "$M13";
    echo "select md5(pg_get_viewdef('public.maintenance_board'::regclass, true));"; echo "rollback;"; } | psql_run -tA | tail -1
}
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name from information_schema.columns where table_schema in ('public', 'private')
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
    union all select 'trg '||tgrelid::regclass::text||' '||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'public.%'
    union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
    order by 1;"
}
# Schedules, starting points and service history (everything but the new time).
data() {
  query "
    select md5(coalesce(string_agg(x, '|' order by x), '')) from (
      select (to_jsonb(p) - 'inspect_baseline_at')::text as x from public.maintenance_plans p
      union all select to_jsonb(e)::text from public.maintenance_entries e
      union all select to_jsonb(et)::text from public.maintenance_entry_tasks et
      union all select to_jsonb(r)::text from public.sled_readings r) s;"
}
M14_OBJECTS='maintenance_board|inspect_baseline_at|inspect_baseline_time'

check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '[[ "$(has_m14)" == "1" ]]' "Migration 14 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M14_OBJECTS")"
EXPECTED_VIEW="$(m13_view_md5)"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi
if { echo "set sledwerx.confirm_rollback = '20261127090000';"; cat supabase/rollback/20261127090000_rollback.sql; } | psql_run > "$OUT" 2>&1; then
  not_ok "Migration 13's rollback refuses while Migration 14 is applied"
else
  check 'grep -q "Roll back Migration 14 first" "$OUT"' "Migration 13's rollback refuses while Migration 14 is applied"
fi
check '[[ "$(has_m14)" == "1" ]]' "nothing changed after the refusals"

# --- Data is kept ----------------------------------------------------------
query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback14-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | uuid_of)"
TASK_ID="$(query "begin; $(as_user) insert into public.maintenance_tasks (name) values ('Plugs') returning id; commit;" | uuid_of)"
query "begin; $(as_user) insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading, inspect_baseline_on, inspect_baseline_mi, inspect_baseline_kind) values ('$SLED_ID', '$TASK_ID', 'inspection', true, current_date, 500, 'tracking'); commit;" > /dev/null
query "begin; $(as_user) select public.save_maintenance_inspection(gen_random_uuid(), '$SLED_ID', current_date, '[{\"task_id\": \"$TASK_ID\", \"outcome\": \"good\"}]'); commit;" > /dev/null
check '[[ -n "$(query "select inspect_baseline_at from public.maintenance_plans where task_id = '\''$TASK_ID'\''")" ]]' "a starting point gets its time"
DATA_BEFORE="$(data)"

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes"
else
  not_ok "rollback completes"; cat "$OUT"
fi
check '[[ "$(has_m14)" == "0" ]]' "the new column is removed"
check '[[ "$(view_md5)" == "$EXPECTED_VIEW" ]]' "maintenance_board is exactly Migration 13's again"
check '[[ "$(data)" == "$DATA_BEFORE" ]]' "schedules, starting points and service history are unchanged"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261128090000'\''")" ]]' \
  "the Migration 14 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M14_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again ----------------------------------------
if reapply; then check '[[ "$(has_m14)" == "1" ]]' "Migration 14 re-applies cleanly"; else not_ok "Migration 14 re-applies cleanly"; cat "$OUT"; fi
check '[[ "$(data)" == "$DATA_BEFORE" ]]' "re-applying changes no data (existing starting points have no time)"
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 13 state"
else
  not_ok "a second rollback leaves exactly the same Migration 13 state"; cat "$OUT"
fi
query "delete from public.sleds where id = '$SLED_ID';" > /dev/null
query "delete from auth.users;" > /dev/null

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 14 rollback checks passed."
else
  echo "$failures Migration 14 rollback check(s) failed."
  exit 1
fi
