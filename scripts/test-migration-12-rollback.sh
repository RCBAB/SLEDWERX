#!/usr/bin/env bash
# Tests supabase/rollback/20261126090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-12 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# It leaves the database at the Migration 11 state, so the Migration 11
# rollback test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-12-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261126090000_rollback.sql
MIGRATION=supabase/migrations/20261126090000_suspension_turns.sql
M10=supabase/migrations/20261124090000_suspension_measurement_photos.sql
CONFIRM="set sledwerx.confirm_rollback = '20261126090000';"
USER_ID=99999999-9999-9999-9999-999999999912
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
    echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261126090000', 'suspension_turns');";
    echo "commit;"; } | psql_run > "$OUT" 2>&1
}
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
uuid_of() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
has_m12() { query "select (to_regclass('public.sled_trail_settings') is not null)::int;"; }
fn_md5() { query "select md5(pg_get_functiondef('$1'::regprocedure));"; }
# Migration 10's own definition of a public function, re-created in a rolled-back transaction and fingerprinted.
original_md5() {
  { echo "begin;"; awk "/^create (or replace )?function public\\.$1\\(/,/^\\\$\\\$;/" "$M10" | sed -E 's/^create (or replace )?function/create or replace function/';
    echo "select md5(pg_get_functiondef('$2'::regprocedure));"; echo "rollback;"; } | psql_run -tA | tail -1
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
M12_OBJECTS='input_methods|outdated|sled_turn_adjustments|sled_trail_settings|sled_measurement_records|record_suspension_measurement|suspension_trail_status|add_photo_in_outdated_slot|turns_guard|save_suspension_configuration|add_suspension_measurement_photo'
SAVE9="public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)"
ADD="public.add_suspension_measurement_photo(uuid,uuid,text)"

check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '[[ "$(has_m12)" == "1" ]]' "Migration 12 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M12_OBJECTS")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi
if { echo "set sledwerx.confirm_rollback = '20261125090000';"; cat supabase/rollback/20261125090000_rollback.sql; } | psql_run > "$OUT" 2>&1; then
  not_ok "Migration 11's rollback refuses while Migration 12 is applied"
else
  check 'grep -q "Roll back Migration 12 first" "$OUT"' "Migration 11's rollback refuses while Migration 12 is applied"
fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback12-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | uuid_of)"
SETTING_ID="$(query "begin; $(as_user) insert into public.suspension_settings (sled_id, name, zone, input_methods) values ('$SLED_ID', 'Preload', 'rear_general', 'both') returning id; commit;" | uuid_of)"
if rollback; then not_ok "refuses while a setting uses Turns"; else
  check 'grep -q "setting(s) use Turns" "$OUT"' "refuses while a setting uses Turns"; fi
query "begin; $(as_user) select public.save_suspension_configuration('$SLED_ID', null, '{}', null, null, null, null, null, gen_random_uuid(), '{\"$SETTING_ID\": 2}'); commit;" > /dev/null
query "alter table public.suspension_settings disable trigger turns_guard;
       update public.suspension_settings set input_methods = 'measurement' where id = '$SETTING_ID';
       alter table public.suspension_settings enable trigger turns_guard;" > /dev/null
if rollback; then not_ok "refuses while turns history exists"; else
  check 'grep -q "turns row(s) exist" "$OUT"' "refuses while turns history exists"; fi
check '[[ "$(has_m12)" == "1" ]]' "nothing changed after the refusals"
query "delete from public.sleds where id = '$SLED_ID';" > /dev/null

# --- Rollback --------------------------------------------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes"
else
  not_ok "rollback completes"; cat "$OUT"
fi
check '[[ "$(has_m12)" == "0" ]]' "the turns tables are removed"
check '[[ "$(query "select count(*) from pg_proc where proname = '\''save_suspension_configuration'\''")" == "1" ]]' \
  "only the 9-argument save remains"
check '[[ "$(fn_md5 "$SAVE9")" == "$(original_md5 save_suspension_configuration "$SAVE9")" ]]' \
  "save_suspension_configuration is exactly Migration 10's again"
check '[[ "$(fn_md5 "$ADD")" == "$(original_md5 add_suspension_measurement_photo "$ADD")" ]]' \
  "add_suspension_measurement_photo is exactly Migration 10's again"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261126090000'\''")" ]]' \
  "the Migration 12 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M12_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
FIRST="$(fingerprint)"

# --- Re-apply, then roll back again ----------------------------------------
if reapply; then check '[[ "$(has_m12)" == "1" ]]' "Migration 12 re-applies cleanly"; else not_ok "Migration 12 re-applies cleanly"; cat "$OUT"; fi
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 11 state"
else
  not_ok "a second rollback leaves exactly the same Migration 11 state"; cat "$OUT"
fi
query "delete from auth.users;" > /dev/null

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 12 rollback checks passed."
else
  echo "$failures Migration 12 rollback check(s) failed."
  exit 1
fi
