#!/usr/bin/env bash
# Tests supabase/rollback/20261124090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-10 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 9 state, so the Migration 9 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-10-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261124090000_rollback.sql
MIGRATION=supabase/migrations/20261124090000_suspension_measurement_photos.sql
CONFIRM="set sledwerx.confirm_rollback = '20261124090000';"
USER_ID=99999999-9999-9999-9999-999999999910
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
    echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261124090000', 'suspension_measurement_photos');";
    echo "commit;"; } | psql_run > "$OUT" 2>&1
}
has_m10() { query "select count(*) from pg_tables where schemaname = 'public' and tablename = 'sled_measurement_photos';"; }
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
uuid_of() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema in ('public', 'private')
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
    union all select 'trg '||tgrelid::regclass::text||' '||tgname||' '||tgfoid::regproc::text from pg_trigger where not tgisinternal
      and tgrelid::regclass::text like 'public.%'
    union all select 'idx '||indexrelid::regclass::text from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
    union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
    union all select 'reg '||table_name from private.cleanup_record_tables
    union all select 'ref '||table_name||'.'||column_name from private.storage_reference_columns
    order by 1;"
}
M10_OBJECTS='measurement|save_suspension_configuration'
SAVE_FN="public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)"
save_md5() { query "select md5(pg_get_functiondef('$SAVE_FN'::regprocedure));"; }
# Migration 9's own definition, re-created in a transaction that is rolled back, and fingerprinted.
m9_save_md5() {
  { echo "begin;"; awk '/^create function public.save_suspension_configuration/,/^\$\$;/' supabase/migrations/20261123090000_suspension_quick_tune.sql \
      | sed 's/^create function/create or replace function/';
    echo "select md5(pg_get_functiondef('$SAVE_FN'::regprocedure));"; echo "rollback;"; } | psql_run -tA
}

check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '[[ "$(has_m10)" == "1" ]]' "Migration 10 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M10_OBJECTS")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback10-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | uuid_of)"
SETTING_ID="$(query "begin; $(as_user) insert into public.suspension_settings (sled_id, name, zone) values ('$SLED_ID', 'Sag', 'rear_general') returning id; commit;" | uuid_of)"
REV_ID="$(query "begin; $(as_user) select public.save_suspension_configuration('$SLED_ID', null, '{\"$SETTING_ID\": \"30\"}', null, null, null, null, null, gen_random_uuid()) ->> 'revision_id'; commit;" | uuid_of)"
query "begin; $(as_user) select public.add_suspension_measurement_photo('$REV_ID', '$SETTING_ID', '$SLED_ID/$REV_ID/' || gen_random_uuid() || '.jpg'); commit;" > /dev/null
if rollback; then not_ok "refuses to run while a measurement photo exists"; else
  check 'grep -q "measurement photo row(s) exist" "$OUT"' "refuses to run while a measurement photo exists"; fi
check '[[ "$(has_m10)" == "1" ]]' "nothing was removed after the refusal"
query "delete from public.sled_measurement_photos;" > /dev/null

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when no measurement photo exists"
else
  not_ok "rollback completes when no measurement photo exists"; cat "$OUT"
fi
check '[[ "$(has_m10)" == "0" ]]' "the table is removed"
check '[[ "$(query "select count(*) from private.storage_reference_columns where table_name = '\''sled_measurement_photos'\''")" == "0" ]]' \
  "the cleanup registries no longer list it"
check '[[ "$(query "select cardinality(private.cleanup_registry_problems())")" == "0" ]]' "the cleanup registry is still complete"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261124090000'\''")" ]]' \
  "the Migration 10 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M10_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
check '[[ "$(save_md5)" == "$(m9_save_md5)" ]]' "save_suspension_configuration is exactly Migration 9's again"
# Saving still works (Migration 9 behaviour).
check 'query "begin; $(as_user) select public.save_suspension_configuration('\''$SLED_ID'\'', '\''$REV_ID'\'', '\''{\"$SETTING_ID\": \"31\"}'\'', null, null, null, null, null, gen_random_uuid()); commit;" > /dev/null' \
  "saving a configuration works with Migration 9's function"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again ----------------------------------------
if reapply; then check '[[ "$(has_m10)" == "1" ]]' "Migration 10 re-applies cleanly"; else not_ok "Migration 10 re-applies cleanly"; cat "$OUT"; fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 9 state"
else
  not_ok "a second rollback leaves exactly the same Migration 9 state"; cat "$OUT"
fi
query "delete from auth.users;" > /dev/null

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 10 rollback checks passed."
else
  echo "$failures Migration 10 rollback check(s) failed."
  exit 1
fi
