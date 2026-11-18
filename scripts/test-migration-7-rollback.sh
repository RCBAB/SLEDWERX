#!/usr/bin/env bash
# Tests supabase/rollback/20261121090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-7 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 6 state, so the Migration 6 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-7-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261121090000_rollback.sql
MIGRATION=supabase/migrations/20261121090000_suspension_tuning.sql
CONFIRM="set sledwerx.confirm_rollback = '20261121090000';"
USER_ID=99999999-9999-9999-9999-999999999997
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_suspension() { query "select count(*) from pg_tables where schemaname = 'public' and tablename like 'suspension\\_%';"; }
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
check '[[ "$(has_suspension)" == "5" ]]' "Migration 7 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "suspension_(settings|setups|revisions|feedback|photos|photo_|current_values)|_suspension_|SledWerx suspension photos")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback7-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | grep -E '^[0-9a-f-]{36}$')"
SETTING_ID="$(query "begin; $(as_user) insert into public.suspension_settings (sled_id, name, zone) values ('$SLED_ID', 'Compression', 'front_left_shock') returning id; commit;" | grep -E '^[0-9a-f-]{36}$')"
if rollback; then not_ok "refuses to run while a suspension setting exists"; else
  check 'grep -q "row(s) exist in suspension_settings" "$OUT"' "refuses to run while a suspension setting exists"; fi
query "begin; $(as_user) update public.suspension_settings set deleted_at = now() where id = '$SETTING_ID'; commit;" > /dev/null
if rollback; then not_ok "refuses to run while a setting is in Recently Deleted"; else
  check 'grep -q "row(s) exist in suspension_settings" "$OUT"' "refuses to run while a setting is in Recently Deleted"; fi
query "delete from public.suspension_settings;" > /dev/null

query "begin; $(as_user) select public.create_suspension_setup('$SLED_ID', 'Trail'); commit;" > /dev/null
if rollback; then not_ok "refuses to run while a setup exists"; else
  check 'grep -q "row(s) exist in suspension_setups" "$OUT"' "refuses to run while a setup exists"; fi
query "delete from public.suspension_setups;" > /dev/null

query "insert into storage.objects (bucket_id, name) values ('suspension-photos', '$SLED_ID/$SETTING_ID/$(cat /proc/sys/kernel/random/uuid).jpg');" > /dev/null
if rollback; then not_ok "refuses to run while suspension-photo files exist"; else
  check 'grep -q "suspension-photos bucket contains" "$OUT"' "refuses to run while suspension-photo files exist"; fi
query "select set_config('storage.allow_delete_query', 'true', false); delete from storage.objects where bucket_id = 'suspension-photos';" > /dev/null
check '[[ "$(has_suspension)" == "5" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and nothing uses suspension tuning"
else
  not_ok "rollback completes when confirmed and nothing uses suspension tuning"; cat "$OUT"
fi
check '[[ "$(has_suspension)" == "0" ]]' "the suspension tables are removed"
check '[[ "$(query "select count(*) from pg_proc where proname like '\''%suspension%'\''")" == "0" ]]' "the suspension functions are removed"
check '[[ -z "$(query "select 1 from storage.buckets where id = '\''suspension-photos'\''")" ]]' "the suspension-photos bucket is removed"
check '[[ "$(query "select count(*) from pg_policies where schemaname = '\''storage'\'' and policyname like '\''SledWerx%'\''")" == "7" ]]' \
  "only the four sled-photo and three issue-photo storage policies remain"
check '[[ -n "$(query "select 1 from storage.buckets where id = '\''issue-photos'\''")" ]]' "the issue-photos bucket is untouched"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261121090000'\''")" ]]' \
  "the Migration 7 history entry is removed"
check '[[ "$(fingerprint)" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback7@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261121090000', 'suspension_tuning');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_suspension)" == "5" ]]' "Migration 7 re-applies cleanly after the rollback"
else
  not_ok "Migration 7 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 6 state"
else
  not_ok "a second rollback leaves exactly the same Migration 6 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 7 rollback checks passed."
else
  echo "$failures Migration 7 rollback check(s) failed."
  exit 1
fi
