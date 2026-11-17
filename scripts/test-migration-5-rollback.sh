#!/usr/bin/env bash
# Tests supabase/rollback/20261119090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-5 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 4 state, so the Migration 4 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-5-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261119090000_rollback.sql
MIGRATION=supabase/migrations/20261119090000_maintenance_board.sql
CONFIRM="set sledwerx.confirm_rollback = '20261119090000';"
USER_ID=99999999-9999-9999-9999-999999999995
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_board() { query "select count(*) from pg_views where schemaname = 'public' and viewname = 'maintenance_board';"; }
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema = 'public'
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
    union all select 'trg '||tgrelid::regclass::text||' '||tgname||' '||tgfoid::regproc::text from pg_trigger where not tgisinternal
      and tgrelid::regclass::text like 'public.%'
    union all select 'view '||viewname from pg_views where schemaname = 'public'
    union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
    order by 1;"
}

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' "supabase/config.toml does not reference the rollback folder"
check '[[ "$(has_board)" == "1" ]]' "Migration 5 is applied before the test"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback5-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | grep -E '^[0-9a-f-]{36}$')"
TASK_ID="$(query "begin; $(as_user) insert into public.maintenance_tasks (name) values ('Rollback task') returning id; commit;" | grep -E '^[0-9a-f-]{36}$')"
query "begin; $(as_user) insert into public.maintenance_plans (sled_id, task_id, season_due_month, season_due_day) values ('$SLED_ID', '$TASK_ID', 11, 1); commit;" > /dev/null
if rollback; then not_ok "refuses to run while a plan is seasonal"; else
  check 'grep -q "seasonal schedule" "$OUT"' "refuses to run while a plan is seasonal"; fi

query "update public.maintenance_plans set season_due_month = null, season_due_day = null;" > /dev/null
if rollback; then not_ok "refuses to run while a plan has no interval"; else
  check 'grep -q "have no interval" "$OUT"' "refuses to run while a plan has no interval"; fi
check '[[ "$(has_board)" == "1" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
query "update public.maintenance_plans set interval_mi = 1000;" > /dev/null
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and every plan has an interval"
else
  not_ok "rollback completes when confirmed and every plan has an interval"; cat "$OUT"
fi
check '[[ "$(has_board)" == "0" ]]' "the maintenance_board view is removed"
check '[[ -z "$(query "select 1 from information_schema.columns where table_name = '\''maintenance_plans'\'' and column_name like '\''season_due_%'\''")" ]]' \
  "the seasonal columns are removed"
check '[[ "$(query "select pg_get_constraintdef(oid) from pg_constraint where conname = '\''maintenance_plans_check'\''")" == "CHECK ((num_nonnulls(interval_mi, interval_hours, interval_days) >= 1))" ]]' \
  "Migration 2's interval rule is back, exactly"
check '! query "insert into public.maintenance_plans (sled_id, task_id) values ('\''$SLED_ID'\'', '\''$TASK_ID'\'');" > /dev/null 2>&1' \
  "a plan without an interval is refused again"
check '[[ "$(query "select count(*) from public.maintenance_plans where task_id = '\''$TASK_ID'\''")" == "1" ]]' \
  "plans are kept"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261119090000'\''")" ]]' \
  "the Migration 5 history entry is removed"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback5@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261119090000', 'maintenance_board');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_board)" == "1" ]]' "Migration 5 re-applies cleanly after the rollback"
else
  not_ok "Migration 5 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 4 state"
else
  not_ok "a second rollback leaves exactly the same Migration 4 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 5 rollback checks passed."
else
  echo "$failures Migration 5 rollback check(s) failed."
  exit 1
fi
