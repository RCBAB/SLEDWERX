#!/usr/bin/env bash
# Tests supabase/rollback/20261122090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-8 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 7 state, so the Migration 7 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-8-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261122090000_rollback.sql
MIGRATION=supabase/migrations/20261122090000_recently_deleted_cleanup.sql
M2=supabase/migrations/20261112210000_maintenance_logbook.sql
CONFIRM="set sledwerx.confirm_rollback = '20261122090000';"
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_cleanup() { query "select count(*) from pg_tables where schemaname = 'private' and tablename in ('cleanup_settings', 'cleanup_runs', 'cleanup_candidates', 'storage_cleanup_claims');"; }
purge_md5() { query "select md5(pg_get_functiondef('private.purge_expired_records()'::regprocedure));"; }
# Migration 2's own definition of purge_expired_records(), re-created and fingerprinted.
m2_purge_md5() {
  { echo "begin;"; awk '/^create or replace function private.purge_expired_records\(\)/,/^\$\$;/' "$M2";
    echo "select md5(pg_get_functiondef('private.purge_expired_records()'::regprocedure));"; echo "rollback;"; } | psql_run -tA
}
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema in ('public', 'private')
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'pol '||tablename||' '||policyname||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
    union all select 'trg '||tgrelid::regclass::text||' '||tgname||' '||tgfoid::regproc::text from pg_trigger where not tgisinternal
      and tgrelid::regclass::text like 'public.%'
    union all select 'idx '||indexrelid::regclass::text from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
    union all select 'view '||viewname from pg_views where schemaname = 'public'
    union all select 'bucket '||id from storage.buckets
    union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
    order by 1;"
}
M8_OBJECTS='cleanup|storage_cleanup|storage_reference_columns|storage_(lock_key|path_|file_|reference_count)|expired_record|purge_expired_records|sleds_photo_path_idx|storage_claim_guard'

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' "supabase/config.toml does not reference the rollback folder"
check '[[ "$(has_cleanup)" == "4" ]]' "Migration 8 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M8_OBJECTS")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
       select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now(), now()
       from generate_series(1, 7) d;
       select private.authorize_cleanup_deletion('rollback test');" > /dev/null
if rollback; then not_ok "refuses to run while deletion is switched on"; else
  check 'grep -q "cleanup deletion is switched on" "$OUT"' "refuses to run while deletion is switched on"; fi
query "select private.revoke_cleanup_deletion();" > /dev/null

query "select private.cleanup_begin_run('report', 'manual');" > /dev/null
if rollback; then not_ok "refuses to run while a cleanup run is in progress"; else
  check 'grep -q "a cleanup run is in progress" "$OUT"' "refuses to run while a cleanup run is in progress"; fi
query "select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';" > /dev/null

query "insert into private.storage_cleanup_claims (bucket_id, object_path, status) values ('issue-photos', 'x', 'claimed');" > /dev/null
if rollback; then not_ok "refuses to run while a file is claimed"; else
  check 'grep -q "claimed for removal" "$OUT"' "refuses to run while a file is claimed"; fi
query "delete from private.storage_cleanup_claims;" > /dev/null
check '[[ "$(has_cleanup)" == "4" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed, deletion is off and nothing is running"
else
  not_ok "rollback completes when confirmed, deletion is off and nothing is running"; cat "$OUT"
fi
check '[[ "$(has_cleanup)" == "0" ]]' "the cleanup tables are removed"
check '[[ "$(query "select count(*) from pg_proc where pronamespace in ('\''public'\''::regnamespace, '\''private'\''::regnamespace) and (proname like '\''%cleanup%'\'' or proname like '\''expired\\_record%'\'')")" == "0" ]]' \
  "the cleanup functions are removed"
check '[[ "$(query "select count(*) from pg_trigger where tgname in ('\''cleanup_count_deletes'\'', '\''storage_claim_guard'\'')")" == "0" ]]' \
  "the delete-counting and claim-guard triggers are removed"
check '[[ "$(purge_md5)" == "$(m2_purge_md5)" ]]' "purge_expired_records() is exactly Migration 2's definition again"
check '[[ "$(query "select count(*) from pg_policies where schemaname = '\''storage'\'' and policyname like '\''SledWerx%'\''")" == "10" ]]' \
  "the ten storage policies are untouched"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261122090000'\''")" ]]' \
  "the Migration 8 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M8_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger, index and function is exactly as before"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback8@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261122090000', 'recently_deleted_cleanup');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_cleanup)" == "4" ]]' "Migration 8 re-applies cleanly after the rollback"
else
  not_ok "Migration 8 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 7 state"
else
  not_ok "a second rollback leaves exactly the same Migration 7 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 8 rollback checks passed."
else
  echo "$failures Migration 8 rollback check(s) failed."
  exit 1
fi
