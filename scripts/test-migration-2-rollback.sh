#!/usr/bin/env bash
# Tests supabase/rollback/20261112210000_rollback.sql against a THROWAWAY
# database that has Migrations 1 and 2 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 1 state, so the Migration 1 tests and
# rollback test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-2-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261112210000_rollback.sql
MIGRATION=supabase/migrations/20261112210000_maintenance_logbook.sql
CONFIRM="set sledwerx.confirm_rollback = '20261112210000';"
M2_TABLES="'maintenance_tasks','maintenance_packages','maintenance_package_tasks','sled_readings','maintenance_plans','maintenance_entries','maintenance_entry_tasks','maintenance_entry_parts'"
M1_TABLES="'profiles','user_preferences','garages','sleds','sled_invitations','sled_shares','audit_log'"
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
count_tables() { query "select count(*) from pg_tables where schemaname = 'public' and tablename in ($1);"; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
fingerprint() {
  query "
    select 'rel '||n.nspname||'.'||c.relname||' '||c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','private') and c.relkind in ('r','v','i','S')
    union all select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema = 'public'
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname = 'public'
    union all select 'fn '||n.nspname||'.'||p.proname||' '||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private')
    order by 1;"
}

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' "supabase/config.toml does not reference the rollback folder"
check '[[ "$(count_tables "$M2_TABLES")" == "8" ]]' "Migration 2 is applied before the test"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at)
       values ('99999999-9999-9999-9999-999999999998', 'rollback2-test@example.com', now());
       insert into public.maintenance_tasks (owner_id, name)
       values ('99999999-9999-9999-9999-999999999998', 'Rollback test task');" > /dev/null
if rollback; then not_ok "refuses to run while Migration 2 data exists"; else
  check 'grep -q "Rollback aborted: public.maintenance_tasks" "$OUT"' "refuses to run while Migration 2 data exists"; fi

query "delete from public.maintenance_tasks;" > /dev/null
if rollback; then not_ok "refuses to run while Migration 2 audit history exists"; else
  check 'grep -q "audit row" "$OUT"' "refuses to run while Migration 2 audit history exists"; fi
check '[[ "$(count_tables "$M2_TABLES")" == "8" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
query "delete from auth.users;" > /dev/null
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and no Migration 2 data exists"
else
  not_ok "rollback completes when confirmed and no Migration 2 data exists"; cat "$OUT"
fi
check '[[ "$(count_tables "$M2_TABLES")" == "0" ]]' "all eight Migration 2 tables are removed"
check '[[ "$(count_tables "$M1_TABLES")" == "7" ]]' "Migration 1's seven tables remain"
check '[[ -z "$(query "select 1 from pg_views where schemaname = '\''public'\'' and viewname in ('\''sled_reading_history'\'','\''maintenance_entry_costs'\'')")" ]]' \
  "the views are removed"
check '[[ -z "$(query "select 1 from information_schema.columns where table_name = '\''audit_log'\'' and column_name = '\''library_owner_id'\''")" ]]' \
  "the audit log is back to its Migration 1 columns"
check '[[ "$(query "select pg_get_constraintdef(oid) from pg_constraint where conname = '\''audit_log_check'\''")" == "CHECK ((num_nonnulls(garage_id, sled_id) = 1))" ]]' \
  "the audit log check is back to its Migration 1 definition"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261112210000'\''")" ]]' \
  "the Migration 2 history entry is removed"
check '[[ -n "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261112180000'\''")" ]]' \
  "the Migration 1 history entry is kept"
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback2@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261112210000', 'maintenance_logbook');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(count_tables "$M2_TABLES")" == "8" ]]' "Migration 2 re-applies cleanly after the rollback"
else
  not_ok "Migration 2 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 1 state"
else
  not_ok "a second rollback leaves exactly the same Migration 1 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 2 rollback checks passed."
else
  echo "$failures Migration 2 rollback check(s) failed."
  exit 1
fi
