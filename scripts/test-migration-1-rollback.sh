#!/usr/bin/env bash
# Tests supabase/rollback/20261112180000_rollback.sql against a THROWAWAY
# database. It deletes every user in that database, so it must never point at
# the live project.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-1-rollback.sh
#
# PSQL is a psql command prefix that reads SQL from stdin.
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261112180000_rollback.sql
MIGRATION=supabase/migrations/20261112180000_foundation_garages_sleds_sharing.sql
CONFIRM="set sledwerx.confirm_rollback = '20261112180000';"
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
tables_present() {
  query "select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('profiles','user_preferences','garages','sleds','sled_invitations','sled_shares','audit_log');"
}

# --- The rollback can never run automatically ------------------------------
check '[[ ! -e supabase/migrations/$(basename "$ROLLBACK") ]] && ! ls supabase/migrations | grep -qi rollback' \
  "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' \
  "supabase/config.toml does not reference the rollback folder"

# --- Refuses without explicit confirmation ---------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then
  not_ok "refuses to run without confirmation"
else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"
fi
check '[[ "$(tables_present)" == "7" ]]' "nothing was removed after the refusal"

# --- Refuses while any data exists -----------------------------------------
query "insert into auth.users (id, email, email_confirmed_at)
       values ('99999999-9999-9999-9999-999999999999', 'rollback-test@example.com', now());" > /dev/null
if { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; then
  not_ok "refuses to run while data exists"
else
  check 'grep -q "Rollback aborted" "$OUT"' "refuses to run while data exists"
fi
check '[[ "$(tables_present)" == "7" ]]' "nothing was removed after the refusal"

# --- Runs when confirmed and all seven tables are empty --------------------
query "delete from auth.users;" > /dev/null
check '[[ "$(query "select count(*) from public.profiles") $(query "select count(*) from public.audit_log")" == "0 0" ]]' \
  "deleting users empties the SledWerx tables"
if { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and tables are empty"
else
  not_ok "rollback completes when confirmed and tables are empty"; cat "$OUT"
fi
check '[[ "$(tables_present)" == "0" ]]' "all seven tables are removed"
check '[[ -z "$(query "select 1 from pg_namespace where nspname = '\''private'\''")" ]]' "the private schema is removed"
check '[[ -z "$(query "select 1 from pg_trigger where tgname = '\''on_auth_user_created'\''")" ]]' "the sign-up trigger is removed"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261112180000'\''")" ]]' \
  "the migration-history entry is removed"
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"

# --- Migration 1 can be re-applied cleanly ---------------------------------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261112180000', 'foundation_garages_sleds_sharing');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(tables_present)" == "7" ]]' "Migration 1 re-applies cleanly after the rollback"
else
  not_ok "Migration 1 re-applies cleanly after the rollback"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All rollback checks passed."
else
  echo "$failures rollback check(s) failed."
  exit 1
fi
