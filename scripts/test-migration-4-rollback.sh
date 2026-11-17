#!/usr/bin/env bash
# Tests supabase/rollback/20261118090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-4 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 3 state, so the Migration 3 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-4-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261118090000_rollback.sql
MIGRATION=supabase/migrations/20261118090000_service_records.sql
M2=supabase/migrations/20261112210000_maintenance_logbook.sql
CONFIRM="set sledwerx.confirm_rollback = '20261118090000';"
USER_ID=99999999-9999-9999-9999-999999999996
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_category() { query "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'maintenance_entries' and column_name = 'category';"; }
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema = 'public'
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
    union all select 'trg '||tgrelid::regclass::text||' '||tgname||' '||tgfoid::regproc::text from pg_trigger where not tgisinternal
      and tgrelid::regclass::text like 'public.%'
    union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
    order by 1;"
}
# The body of save_maintenance_entry exactly as written in Migration 2.
m2_save_body() {
  python3 - "$M2" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.index('create function public.save_maintenance_entry(')
body = s[s.index('as $$', i) + 5:s.index('$$;', i)]
sys.stdout.write(body)
PY
}

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' "supabase/config.toml does not reference the rollback folder"
check '[[ "$(has_category)" == "1" ]]' "Migration 4 is applied before the test"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback4-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | grep -E '^[0-9a-f-]{36}$')"
ENTRY_ID="$(query "begin; $(as_user) select public.save_maintenance_entry(gen_random_uuid(), '$SLED_ID', current_date, 'Oil change',
  p_category => 'engine', p_parts => '[{\"name\": \"Oil\", \"quantity\": 2, \"unit_cost\": 9}]') ->> 'entry_id'; commit;" | grep -E '^[0-9a-f-]{36}$')"
if rollback; then not_ok "refuses to run while service records have a category"; else
  check 'grep -q "have a category" "$OUT"' "refuses to run while service records have a category"; fi
check '[[ "$(has_category)" == "1" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
query "update public.maintenance_entries set category = null;" > /dev/null
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and no categories are used"
else
  not_ok "rollback completes when confirmed and no categories are used"; cat "$OUT"
fi
check '[[ "$(has_category)" == "0" ]]' "the category column is removed"
check '[[ -z "$(query "select 1 from information_schema.columns where table_name = '\''maintenance_entries'\'' and column_name = '\''edited_at'\''")" ]]' \
  "the edited_at column is removed"
check '[[ -z "$(query "select to_regprocedure('\''public.update_maintenance_entry(uuid,integer,date,text,text,text,text,numeric,numeric,jsonb,jsonb,jsonb)'\'')")" ]]' \
  "update_maintenance_entry is removed"
check '[[ "$(query "select prosrc from pg_proc where proname = '\''save_maintenance_entry'\''")" == "$(m2_save_body)" ]]' \
  "save_maintenance_entry is exactly Migration 2's again"
check '[[ "$(query "select count(*) from pg_proc where proname = '\''save_maintenance_entry'\''")" == "1" ]]' \
  "only one save_maintenance_entry exists"
check '[[ "$(query "select count(*) from pg_trigger where tgname = '\''guard'\'' and tgfoid = '\''private.tg_sled_record_guard'\''::regproc and tgrelid in ('\''public.maintenance_entry_tasks'\''::regclass, '\''public.maintenance_entry_parts'\''::regclass)")" == "2" ]]' \
  "items use Migration 1's guard again"
check '[[ "$(query "select count(*) from pg_policies where tablename in ('\''maintenance_entry_tasks'\'','\''maintenance_entry_parts'\'') and coalesce(qual,'\'''\'') like '\''%entry_created_by%'\''")" == "0" ]]' \
  "item policies are Migration 2's again"
check '[[ "$(query "select count(*) from public.maintenance_entries where id = '\''$ENTRY_ID'\''") $(query "select count(*) from public.maintenance_entry_parts where entry_id = '\''$ENTRY_ID'\''")" == "1 1" ]]' \
  "service records and their items are kept"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261118090000'\''")" ]]' \
  "the Migration 4 history entry is removed"
check '[[ -n "$(query "begin; $(as_user) select public.save_maintenance_entry(gen_random_uuid(), '\''$SLED_ID'\'', current_date, '\''After rollback'\''); commit;")" ]]' \
  "Migration 2's save_maintenance_entry works after the rollback"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback4@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261118090000', 'service_records');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_category)" == "1" ]]' "Migration 4 re-applies cleanly after the rollback"
else
  not_ok "Migration 4 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 3 state"
else
  not_ok "a second rollback leaves exactly the same Migration 3 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 4 rollback checks passed."
else
  echo "$failures Migration 4 rollback check(s) failed."
  exit 1
fi
