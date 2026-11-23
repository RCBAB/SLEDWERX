#!/usr/bin/env bash
# Tests supabase/rollback/20261123090000_rollback.sql against a THROWAWAY
# database that has Migrations 1-9 applied. It deletes every user in that
# database, so it must never point at the live project.
#
# Also checks that re-applying Migration 9 to existing Migration 7 data numbers
# the configurations in save order and picks the active one.
#
# It leaves the database at the Migration 8 state, so the Migration 8 rollback
# test can run afterwards.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-migration-9-rollback.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

ROLLBACK=supabase/rollback/20261123090000_rollback.sql
MIGRATION=supabase/migrations/20261123090000_suspension_quick_tune.sql
CONFIRM="set sledwerx.confirm_rollback = '20261123090000';"
USER_ID=99999999-9999-9999-9999-999999999990
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
    echo "insert into supabase_migrations.schema_migrations (version, name) values ('20261123090000', 'suspension_quick_tune');";
    echo "commit;"; } | psql_run > "$OUT" 2>&1
}
has_m9() { query "select count(*) from pg_tables where schemaname = 'public' and tablename = 'sled_suspension_state';"; }
as_user() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
uuid_of() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
rating_check() { query "select pg_get_constraintdef(oid) from pg_constraint where conname = 'suspension_feedback_rating_check';"; }
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
    order by 1;"
}
M9_OBJECTS='sled_suspension_state|config_number|ski_model|carbide_length|based_on_revision_id|suspension_feedback\.(conditions|high_temp_f)|suspension_feedback_(conditions|high_temp_f|rating)_check|suspension_configuration|revisions_number|setups_active_config|suspension_setups quick_tune|suspension_revisions number'
ORIGINAL_RATING="CHECK ((rating = ANY (ARRAY['improved'::text, 'worse'::text, 'no_change'::text])))"

# --- The rollback can never run automatically ------------------------------
check '! ls supabase/migrations | grep -qi rollback' "no rollback script is inside supabase/migrations/"
check '[[ "$(has_m9)" == "1" ]]' "Migration 9 is applied before the test"
BEFORE_OTHER="$(fingerprint | grep -vE "$M9_OBJECTS")"

# --- Refusals ---------------------------------------------------------------
if psql_run < "$ROLLBACK" > "$OUT" 2>&1; then not_ok "refuses to run without confirmation"; else
  check 'grep -q "Rollback not confirmed" "$OUT"' "refuses to run without confirmation"; fi

query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'rollback9-test@example.com', now());" > /dev/null
SLED_ID="$(query "begin; $(as_user) select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | uuid_of)"
SETTING_ID="$(query "begin; $(as_user) insert into public.suspension_settings (sled_id, name, zone) values ('$SLED_ID', 'Compression', 'front_left_shock') returning id; commit;" | uuid_of)"
REV_ID="$(query "begin; $(as_user) select public.save_suspension_configuration('$SLED_ID', null, '{\"$SETTING_ID\": \"10\"}', 'ca_pro_xpt', '6', null, null, null, gen_random_uuid()) ->> 'revision_id'; commit;" | uuid_of)"
if rollback; then not_ok "refuses to run while installed equipment is recorded"; else
  check 'grep -q "have installed skis or carbides recorded" "$OUT"' "refuses to run while installed equipment is recorded"; fi
query "update public.sled_suspension_state set ski_model = null, carbide_length = null;" > /dev/null
if rollback; then not_ok "refuses to run while a configuration has equipment recorded"; else
  check 'grep -q "configuration(s) have skis or carbides recorded" "$OUT"' "refuses to run while a configuration has equipment recorded"; fi
query "alter table public.suspension_revisions disable trigger user;
       update public.suspension_revisions set ski_model = null, carbide_length = null;
       alter table public.suspension_revisions enable trigger user;" > /dev/null
query "begin; $(as_user) insert into public.suspension_feedback (revision_id, sled_id, rating, conditions) values ('$REV_ID', '$SLED_ID', 'liked', '{hard_pack}'); commit;" > /dev/null
if rollback; then not_ok "refuses to run while a ride evaluation uses the new fields"; else
  check 'grep -q "ride evaluation(s) use Migration 9" "$OUT"' "refuses to run while a ride evaluation uses the new fields"; fi
query "delete from public.suspension_feedback;" > /dev/null
check '[[ "$(has_m9)" == "1" ]]' "nothing was removed after the refusals"

# --- Rollback with plain Migration 7 data present ---------------------------
if rollback; then
  check 'grep -q "Rollback complete" "$OUT"' "rollback completes when only Migration 7 data exists"
else
  not_ok "rollback completes when only Migration 7 data exists"; cat "$OUT"
fi
check '[[ "$(has_m9)" == "0" ]]' "the state table is removed"
check '[[ "$(query "select count(*) from public.suspension_revisions where id = '\''$REV_ID'\''")" == "1" ]]' \
  "configurations stay as Migration 7 revisions"
check '[[ "$(rating_check)" == "$ORIGINAL_RATING" ]]' "Migration 7's rating check is back"
check '[[ -z "$(query "select 1 from supabase_migrations.schema_migrations where version = '\''20261123090000'\''")" ]]' \
  "the Migration 9 history entry is removed"
check '[[ "$(fingerprint | grep -vE "$M9_OBJECTS")" == "$BEFORE_OTHER" ]]' "every other table, policy, trigger and function is exactly as before"
FIRST="$(fingerprint)"

# --- Existing Migration 7 data is numbered on re-apply ----------------------
# Two setups: Trail (2 revisions in total) then Powder (1, made active).
query "begin; $(as_user) select public.save_suspension_revision(
         (select setup_id from public.suspension_revisions where id = '$REV_ID'), '$REV_ID', '{\"$SETTING_ID\": \"11\"}', null, null, null, gen_random_uuid()); commit;" > /dev/null
POWDER="$(query "begin; $(as_user) select public.create_suspension_setup('$SLED_ID', 'Powder') ->> 'setup_id'; commit;" | uuid_of)"
query "begin; $(as_user) select public.activate_suspension_setup('$POWDER'); commit;" > /dev/null
if reapply; then ok "Migration 9 re-applies cleanly to Migration 7 data"; else not_ok "Migration 9 re-applies cleanly to Migration 7 data"; cat "$OUT"; fi
check '[[ "$(query "select string_agg(config_number::text, '\'','\'' order by created_at) from public.suspension_revisions where sled_id = '\''$SLED_ID'\''")" == "1,2,3" ]]' \
  "existing revisions are numbered Trail 1-3 in save order"
check '[[ "$(query "select r.setup_id from public.sled_suspension_state st join public.suspension_revisions r on r.id = st.active_revision_id where st.sled_id = '\''$SLED_ID'\''")" == "$POWDER" ]]' \
  "the active setup's latest revision becomes the active configuration"
check '[[ "$(query "select count(*) from public.suspension_revisions where sled_id = '\''$SLED_ID'\'' and ski_model is null")" == "3" ]]' \
  "existing revisions have no equipment recorded"

# --- Roll back again: the same Migration 8 state ---------------------------
if rollback; then
  check '[[ "$(fingerprint)" == "$FIRST" ]]' "a second rollback leaves exactly the same Migration 8 state"
else
  not_ok "a second rollback leaves exactly the same Migration 8 state"; cat "$OUT"
fi
query "delete from auth.users;" > /dev/null
check '[[ "$(query "select count(*) from public.suspension_revisions")" == "0" ]]' "test data removed"

rm -f "$OUT"
if [[ $failures -eq 0 ]]; then
  echo "All Migration 9 rollback checks passed."
else
  echo "$failures Migration 9 rollback check(s) failed."
  exit 1
fi
