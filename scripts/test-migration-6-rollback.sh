#!/usr/bin/env bash
# Tests supabase/rollback/20261120090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-6 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 5 state, so the Migration 5 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-6-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261120090000_rollback.sql
MIGRATION=supabase/migrations/20261120090000_sled_issues.sql
CONFIRM="set sledwerx.confirm_rollback = '20261120090000';"
USER_ID=99999999-9999-9999-9999-999999999996
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_issues() { query "select count(*) from pg_tables where schemaname = 'public' and tablename = 'sled_issues';"; }
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
check '[[ "$(has_issues)" == "1" ]]' "Migration 6 is applied before the test"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback6-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | grep -E '^[0-9a-f-]{36}$')"
ISSUE_ID="$(query "begin; $(as_user) insert into public.sled_issues (sled_id, title) values ('$SLED_ID', 'Rollback issue') returning id; commit;" | grep -E '^[0-9a-f-]{36}$')"
if rollback; then not_ok "refuses to run while an issue exists"; else
  check 'grep -q "issue(s) exist" "$OUT"' "refuses to run while an issue exists"; fi
query "begin; $(as_user) update public.sled_issues set deleted_at = now() where id = '$ISSUE_ID'; commit;" > /dev/null
if rollback; then not_ok "refuses to run while an issue is in Recently Deleted"; else
  check 'grep -q "issue(s) exist" "$OUT"' "refuses to run while an issue is in Recently Deleted"; fi
query "delete from public.sled_issues;" > /dev/null

query "insert into storage.objects (bucket_id, name) values ('issue-photos', '$SLED_ID/$ISSUE_ID/$(cat /proc/sys/kernel/random/uuid).jpg');" > /dev/null
if rollback; then not_ok "refuses to run while issue-photo files exist"; else
  check 'grep -q "issue-photos bucket contains" "$OUT"' "refuses to run while issue-photo files exist"; fi
query "select set_config('storage.allow_delete_query', 'true', false); delete from storage.objects where bucket_id = 'issue-photos';" > /dev/null
check '[[ "$(has_issues)" == "1" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and nothing uses issues"
else
  not_ok "rollback completes when confirmed and nothing uses issues"; cat "$OUT"
fi
check '[[ "$(has_issues)" == "0" ]]' "the issue tables are removed"
check '[[ -z "$(query "select 1 from storage.buckets where id = '\''issue-photos'\''")" ]]' "the issue-photos bucket is removed"
check '[[ "$(query "select count(*) from pg_policies where schemaname = '\''storage'\'' and policyname like '\''SledWerx%'\''")" == "4" ]]' \
  "only the four sled-photo storage policies remain"
check '! query "select pg_get_functiondef('\''public.restore_record_version(bigint)'\''::regprocedure)" | grep -q sled_issues' \
  "restore_record_version is back to Migration 2's tables"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261120090000'\''")" ]]' \
  "the Migration 6 history entry is removed"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback6@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261120090000', 'sled_issues');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_issues)" == "1" ]]' "Migration 6 re-applies cleanly after the rollback"
else
  not_ok "Migration 6 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 5 state"
else
  not_ok "a second rollback leaves exactly the same Migration 5 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 6 rollback checks passed."
else
  echo "$failures Migration 6 rollback check(s) failed."
  exit 1
fi
