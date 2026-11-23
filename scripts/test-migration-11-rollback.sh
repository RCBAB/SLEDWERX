#!/usr/bin/env bash
# Tests supabase/rollback/20261125090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-11 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 10 state, so the Migration 10
# rollback test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-11-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261125090000_rollback.sql
MIGRATION=supabase/migrations/20261125090000_measurement_photo_access.sql
CONFIRM="set sledwerx.confirm_rollback = '20261125090000';"
USER_ID=99999999-9999-9999-9999-999999999911
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
    echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261125090000', 'measurement_photo_access');";
    echo "commit;"; } | psql_run > "$OUT" 2>&1
}
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
uuid_of() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
has_m11() { query "select (position('sled_measurement_photos' in prosrc) > 0)::int from pg_proc where proname = 'suspension_photo_sled_id';"; }
fn_md5() { query "select md5(prosrc) from pg_proc where proname = '$1';"; }
# A migration's own definition of a function, re-created in a rolled-back transaction and fingerprinted.
original_md5() {
  { echo "begin;"; awk "/^create function private\\.$2\\(/,/^\\\$\\\$;/" "$1" | sed 's/^create function/create or replace function/';
    echo "select md5(prosrc) from pg_proc where proname = '$2';"; echo "rollback;"; } | psql_run -tA
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
M11_OBJECTS='suspension_photo_sled_id|tg_sled_measurement_photos_check'

check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '[[ "$(has_m11)" == "1" ]]' "Migration 11 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M11_OBJECTS")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi
if { echo "set sledwerx.confirm_rollback = '20261124090000';"; cat supabase/rollback/20261124090000_rollback.sql; } | psql_run > "$OUT" 2>&1; then
  not_ok "Migration 10's rollback refuses while Migration 11 is applied"
else
  check 'grep -q "Roll back Migration 11 first" "$OUT"' "Migration 10's rollback refuses while Migration 11 is applied"
fi

# A photo row whose file's folder configuration is gone (it relies on Migration 11).
query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback11-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | uuid_of)"
SETTING_ID="$(query "begin; $(as_user) insert into public.suspension_settings (sled_id, name, zone) values ('$SLED_ID', 'Sag', 'rear_general') returning id; commit;" | uuid_of)"
REV_ID="$(query "begin; $(as_user) select public.save_suspension_configuration('$SLED_ID', null, '{\"$SETTING_ID\": \"30\"}', null, null, null, null, null, gen_random_uuid()) ->> 'revision_id'; commit;" | uuid_of)"
GONE="$(cat /proc/sys/kernel/random/uuid)"
query "alter table public.sled_measurement_photos disable trigger links;
       insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot)
       values ('$SLED_ID', '$REV_ID', '$SETTING_ID', '$SLED_ID/$GONE/' || gen_random_uuid() || '.jpg', 1);
       alter table public.sled_measurement_photos enable trigger links;" > /dev/null
if rollback; then not_ok "refuses while a photo relies on Migration 11"; else
  check 'grep -q "folder configuration is gone" "$OUT"' "refuses while a photo relies on Migration 11"; fi
check '[[ "$(has_m11)" == "1" ]]' "nothing changed after the refusals"
query "delete from public.sled_measurement_photos;" > /dev/null

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes"
else
  not_ok "rollback completes"; cat "$OUT"
fi
check '[[ "$(fn_md5 suspension_photo_sled_id)" == "$(original_md5 supabase/migrations/20261121090000_suspension_tuning.sql suspension_photo_sled_id)" ]]' \
  "suspension_photo_sled_id is exactly Migration 7's again"
check '[[ "$(fn_md5 tg_sled_measurement_photos_check)" == "$(original_md5 supabase/migrations/20261124090000_suspension_measurement_photos.sql tg_sled_measurement_photos_check)" ]]' \
  "tg_sled_measurement_photos_check is exactly Migration 10's again"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261125090000'\''")" ]]' \
  "the Migration 11 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M11_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again ----------------------------------------
if reapply; then check '[[ "$(has_m11)" == "1" ]]' "Migration 11 re-applies cleanly"; else not_ok "Migration 11 re-applies cleanly"; cat "$OUT"; fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 10 state"
else
  not_ok "a second rollback leaves exactly the same Migration 10 state"; cat "$OUT"
fi
query "delete from auth.users;" > /dev/null

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 11 rollback checks passed."
else
  echo "$failures Migration 11 rollback check(s) failed."
  exit 1
fi
