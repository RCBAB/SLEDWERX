#!/usr/bin/env bash
# Tests supabase/rollback/20261117150000_rollback.sql against a THROWAWAY
# database that has Migrations 1-3 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 2 state, so the Migration 2 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-3-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261117150000_rollback.sql
MIGRATION=supabase/migrations/20261117150000_sled_photos_and_create_sled.sql
CONFIRM="set sledwerx.confirm_rollback = '20261117150000';"
USER_ID=99999999-9999-9999-9999-999999999997
OUT="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
rollback() { { echo "$CONFIRM"; cat "$ROLLBACK"; } | psql_run > "$OUT" 2>&1; }
has_column() { query "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sleds' and column_name = 'photo_path';"; }
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
fingerprint() {
  query "
    select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema = 'public'
    union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol '||schemaname||'.'||tablename||' '||policyname from pg_policies where schemaname in ('public','storage')
    union all select 'fn '||n.nspname||'.'||p.proname||' '||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private')
    union all select 'bucket '||id from storage.buckets
    order by 1;"
}

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '! grep -Eqi "rollback" supabase/config.toml' "supabase/config.toml does not reference the rollback folder"
check '[[ "$(has_column)" == "1" ]]' "Migration 3 is applied before the test"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback3-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 10); commit;" | grep -E '^[0-9a-f-]{36}$')"
PHOTO="$SLED_ID/0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00.jpg"
query "update public.sleds set photo_path = '$PHOTO' where id = '$SLED_ID';" > /dev/null
if rollback; then not_ok "refuses to run while a sled has a photo"; else
  check 'grep -q "have a photo" "$OUT"' "refuses to run while a sled has a photo"; fi

query "update public.sleds set photo_path = null where id = '$SLED_ID';
       insert into storage.objects (bucket_id, name) values ('sled-photos', '$PHOTO');" > /dev/null
if rollback; then not_ok "refuses to run while photo files exist"; else
  check 'grep -q "contains 1 file" "$OUT"' "refuses to run while photo files exist"; fi
check '[[ "$(has_column)" == "1" ]]' "nothing was removed after the refusals"

# --- Rollback --------------------------------------------------------------
query "select set_config('storage.allow_delete_query', 'true', false);
       delete from storage.objects where bucket_id = 'sled-photos';" > /dev/null
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when confirmed and no photos exist"
else
  not_ok "rollback completes when confirmed and no photos exist"; cat "$OUT"
fi
check '[[ "$(has_column)" == "0" ]]' "photo_path is removed"
check '[[ -z "$(query "select 1 from storage.buckets where id = '\''sled-photos'\''")" ]]' "the sled-photos bucket is removed"
check '[[ -z "$(query "select 1 from pg_policies where schemaname = '\''storage'\'' and policyname like '\''SledWerx:%'\''")" ]]' \
  "the storage policies are removed"
check '[[ -z "$(query "select to_regprocedure('\''public.create_sled(text,text,integer,numeric,numeric,text,text,date,uuid)'\'')")" ]]' \
  "create_sled is removed"
check '[[ "$(query "select count(*) from public.sleds where id = '\''$SLED_ID'\''") $(query "select count(*) from public.sled_readings where sled_id = '\''$SLED_ID'\''")" == "1 1" ]]' \
  "sleds and readings created with create_sled are kept"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261117150000'\''")" ]]' \
  "the Migration 3 history entry is removed"
query "delete from auth.users;" > /dev/null
check 'query "insert into auth.users (id, email) values (gen_random_uuid(), '\''after-rollback3@example.com'\''); delete from auth.users;" > /dev/null' \
  "sign-up still works after the rollback"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again: the result must be identical ----------
if { echo "begin;"; cat "$MIGRATION";
     echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261117150000', 'sled_photos_and_create_sled');";
     echo "commit;"; } | psql_run > "$OUT" 2>&1; then
  check '[[ "$(has_column)" == "1" ]]' "Migration 3 re-applies cleanly after the rollback"
else
  not_ok "Migration 3 re-applies cleanly after the rollback"; cat "$OUT"
fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 2 state"
else
  not_ok "a second rollback leaves exactly the same Migration 2 state"; cat "$OUT"
fi

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 3 rollback checks passed."
else
  echo "$failures Migration 3 rollback check(s) failed."
  exit 1
fi
