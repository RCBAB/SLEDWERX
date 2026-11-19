#!/usr/bin/env bash
# Migration 8: checks the cleanup's locking with two real database sessions
# (pgTAP runs in one session and cannot). Runs against a THROWAWAY database
# with Migration 8 applied; it creates and then removes its own test data.
#
#   1. A record being attached to a file makes a concurrent claim wait, and
#      the claim then sees the record (file kept).
#   2. A claim makes a concurrent attach wait, and the attach is then refused.
#   3. A restore committed while the purge waits on the row: not deleted.
#   4. A purge committed while the restore waits: the restore finds nothing.
#   5. Two sessions processing records at once: the second is refused.
#   6. A claim makes a concurrent overwrite of the file wait, and the
#      overwrite is then refused (restrictive storage policy).
#   7. An overwrite in progress makes a claim wait; the claim then sees a
#      changed (new) file and does not claim it.
#   8. While claimed, an owner may still remove the file, but cannot upload
#      a new one at the same path.
#
# Usage (CI does this against the local Supabase stack):
#   THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
#     scripts/test-cleanup-concurrency.sh
set -euo pipefail

if [[ "${THROWAWAY_DATABASE:-}" != "yes" ]]; then
  echo "Refusing to run: set THROWAWAY_DATABASE=yes to confirm PSQL points at a disposable local database." >&2
  exit 1
fi
: "${PSQL:?PSQL must be set}"

USER_ID=99999999-9999-9999-9999-999999999988
OUT_A="$(mktemp)"
OUT_B="$(mktemp)"
failures=0

psql_run() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
query() { psql_run -tA <<<"$1"; }
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$1"; then ok "$2"; else not_ok "$2"; fi; }
uuid() { cat /proc/sys/kernel/random/uuid; }
# Session A holds its transaction open for 3 seconds in the background.
session_a() { { echo "begin;"; echo "$1"; echo "select pg_sleep(3);"; echo "commit;"; } | $PSQL -X -q -tA > "$OUT_A" 2>&1 & A_PID=$!; sleep 1; }
# Session B runs while A holds its lock; returns how long it waited (seconds).
session_b() {
  local start end
  start=$(date +%s.%N)
  { echo "$1"; } | $PSQL -X -q -tA > "$OUT_B" 2>&1 || true
  end=$(date +%s.%N)
  wait "$A_PID" || true
  WAITED=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.1f", e - s }')
}
waited() { awk -v w="$WAITED" 'BEGIN { exit !(w >= 1.0) }'; }

cleanup() {
  query "select private.revoke_cleanup_deletion();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';
         delete from private.storage_cleanup_claims;
         delete from private.cleanup_runs where id > ${FIRST_RUN_ID:-0};
         update private.cleanup_settings set bucket_threshold_percent = 10;
         select set_config('storage.allow_delete_query', 'true', false);
         delete from storage.objects where bucket_id in ('issue-photos', 'sled-photos') and name like '%-%-%-%-%/%';
         delete from public.sleds where owner_id = '$USER_ID';
         delete from auth.users where id = '$USER_ID';" > /dev/null 2>&1 || true
  rm -f "$OUT_A" "$OUT_B"
}
trap cleanup EXIT

# --- Fixtures ---------------------------------------------------------------
FIRST_RUN_ID="$(query "select coalesce(max(id), 0) from private.cleanup_runs;")"
query "insert into auth.users (id, email, email_confirmed_at) values ('$USER_ID', 'cleanup-concurrency@example.com', now());" > /dev/null
SLED="$(query "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';
               select public.create_sled('Polaris', 'RMK', 2024, 500); commit;" | grep -E '^[0-9a-f-]{36}$')"
ISSUE="$(query "insert into public.sled_issues (sled_id, title) values ('$SLED', 'Concurrency') returning id;" | grep -E '^[0-9a-f-]{36}$')"
I_RESTORE="$(query "insert into public.sled_issues (sled_id, title) values ('$SLED', 'Restore race') returning id;" | grep -E '^[0-9a-f-]{36}$')"
I_PURGE="$(query "insert into public.sled_issues (sled_id, title) values ('$SLED', 'Purge race') returning id;" | grep -E '^[0-9a-f-]{36}$')"
query "update public.sled_issues set deleted_at = now() - interval '31 days' where id in ('$I_RESTORE', '$I_PURGE');" > /dev/null
P1="$SLED/$ISSUE/$(uuid).jpg"
P2="$SLED/$ISSUE/$(uuid).jpg"
S1="$SLED/$(uuid).jpg"
S2="$SLED/$(uuid).jpg"
S3="$SLED/$(uuid).jpg"
# Statements run as the snowmobile's owner (signed in), so storage policies apply.
as_owner() { echo "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER_ID\",\"role\":\"authenticated\"}';"; }
etag() { query "select metadata ->> 'eTag' from storage.objects where bucket_id = 'sled-photos' and name = '$1';"; }
query "insert into storage.objects (bucket_id, name, created_at, updated_at, metadata) values
         ('issue-photos', '$P1', now() - interval '2 days', now() - interval '2 days', '{\"eTag\": \"p1\", \"size\": 10}'),
         ('issue-photos', '$P2', now() - interval '2 days', now() - interval '2 days', '{\"eTag\": \"p2\", \"size\": 10}'),
         ('sled-photos', '$S1', now() - interval '2 days', now() - interval '2 days', '{\"eTag\": \"s1\", \"size\": 10}'),
         ('sled-photos', '$S2', now() - interval '2 days', now() - interval '2 days', '{\"eTag\": \"s2\", \"size\": 10}'),
         ('sled-photos', '$S3', now() - interval '2 days', now() - interval '2 days', '{\"eTag\": \"s3\", \"size\": 10}');
       insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
       select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now(), now()
       from generate_series(1, 7) d;
       update private.cleanup_settings set bucket_threshold_percent = 100;
       select private.authorize_cleanup_deletion('concurrency test');" > /dev/null
RUN="$(query "select private.cleanup_begin_run('delete', 'manual');")"
query "select private.cleanup_report_files($RUN);" > /dev/null
check '[[ "$(query "select count(*) from private.cleanup_candidates where run_id = $RUN and outcome = '\''eligible'\''")" == "5" ]]' \
  "the five test files are listed as removable"

# --- 1. Attach first, then claim ---------------------------------------------
session_a "insert into public.sled_issue_photos (issue_id, sled_id, path) values ('$ISSUE', '$SLED', '$P1');"
session_b "select private.cleanup_claim_file($RUN, 'issue-photos', '$P1') ->> 'reason';"
check 'waited' "a claim waits while a record is being attached to the file (waited ${WAITED}s)"
check 'grep -qx "referenced" "$OUT_B"' "and then sees the record and does not claim the file"

# --- 2. Claim first, then attach ---------------------------------------------
session_a "select private.cleanup_claim_file($RUN, 'issue-photos', '$P2');"
session_b "insert into public.sled_issue_photos (issue_id, sled_id, path) values ('$ISSUE', '$SLED', '$P2');"
check 'waited' "attaching waits while the file is being claimed (waited ${WAITED}s)"
check 'grep -q "This photo is being removed" "$OUT_B"' "and is then refused"
check '[[ "$(query "select count(*) from public.sled_issue_photos where path = '\''$P2'\''")" == "0" ]]' "no record points at the claimed file"

# --- 6. Claim first, then overwrite --------------------------------------------
session_a "select private.cleanup_claim_file($RUN, 'sled-photos', '$S1');"
session_b "begin; $(as_owner) update storage.objects set metadata = metadata || '{\"eTag\": \"overwritten\"}', updated_at = now()
           where bucket_id = 'sled-photos' and name = '$S1' returning id; commit;"
check 'waited' "an owner's overwrite waits while the file is being claimed (waited ${WAITED}s)"
check '! grep -qE "[0-9a-f-]{36}" "$OUT_B" && [[ "$(etag "$S1")" == "s1" ]]' "and then changes nothing: the claimed file cannot be overwritten"

# --- 7. Overwrite first, then claim --------------------------------------------
session_a "$(as_owner) update storage.objects set metadata = metadata || '{\"eTag\": \"new-content\"}', updated_at = now()
           where bucket_id = 'sled-photos' and name = '$S2';"
session_b "select private.cleanup_claim_file($RUN, 'sled-photos', '$S2') ->> 'reason';"
check 'waited' "a claim waits while an owner is overwriting the file (waited ${WAITED}s)"
check 'grep -qx "too_new" "$OUT_B"' "and then sees the new file and does not claim it"
check '[[ "$(etag "$S2")" == "new-content" ]]' "the owner's overwrite of an unclaimed file went through (existing permission)"

# --- 8. Remove and upload again while claimed ----------------------------------
query "select private.cleanup_claim_file($RUN, 'sled-photos', '$S3');" > /dev/null
query "begin; $(as_owner) select set_config('storage.allow_delete_query', 'true', true);
       delete from storage.objects where bucket_id = 'sled-photos' and name = '$S3'; commit;" > /dev/null
check '[[ -z "$(etag "$S3")" ]]' "an owner can still remove a claimed file"
if query "begin; $(as_owner) insert into storage.objects (bucket_id, name, metadata)
          values ('sled-photos', '$S3', '{\"eTag\": \"again\", \"size\": 10}'); commit;" > "$OUT_B" 2>&1; then
  not_ok "but cannot upload a new file at the same path"
else
  check 'grep -q "row-level security" "$OUT_B"' "but cannot upload a new file at the same path"
fi

# --- 3. Restore first, then purge ----------------------------------------------
session_a "update public.sled_issues set deleted_at = null where id = '$I_RESTORE';"
session_b "select private.cleanup_delete_root('sled_issues', '$I_RESTORE', now() - interval '30 days');"
check 'waited' "the purge waits for a restore in progress (waited ${WAITED}s)"
check 'grep -qx "0" "$OUT_B"' "and then does not delete the restored record"
check '[[ "$(query "select count(*) from public.sled_issues where id = '\''$I_RESTORE'\'' and deleted_at is null")" == "1" ]]' "the record is restored"

# --- 4. Purge first, then restore ----------------------------------------------
session_a "select private.cleanup_delete_root('sled_issues', '$I_PURGE', now() - interval '30 days');"
session_b "update public.sled_issues set deleted_at = null where id = '$I_PURGE' returning id;"
check 'waited' "a restore waits for a purge in progress (waited ${WAITED}s)"
check '! grep -qE "[0-9a-f-]{36}" "$OUT_B"' "and then finds nothing to restore"

# --- 5. Two record steps at once -----------------------------------------------
query "select private.cleanup_finish_run($RUN);" > /dev/null
RUN2="$(query "select private.cleanup_begin_run('delete', 'manual');")"
session_a "select private.cleanup_process_records($RUN2);"
session_b "select private.cleanup_process_records($RUN2);"
check 'grep -q "Another cleanup is processing records" "$OUT_B"' "a second session processing records at the same time is refused"
query "select private.cleanup_finish_run($RUN2);" > /dev/null

if [[ $failures -eq 0 ]]; then
  echo "All cleanup concurrency checks passed."
else
  echo "$failures cleanup concurrency check(s) failed."
  exit 1
fi
