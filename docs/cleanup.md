# Recently Deleted & storage cleanup (Migration 8)

Permanently removes records whose 30-day recovery period has passed, and
photo files that no record points at. Two parts:

- **Database** (`supabase/migrations/20261122090000_recently_deleted_cleanup.sql`):
  decides what may be deleted, deletes records, claims and checks files,
  enforces every limit and keeps the run history.
- **Daily job** (`src/app/api/cron/cleanup/route.ts`): a server-only endpoint
  for Vercel Cron that calls the database and removes the files the database
  has claimed, through the Storage API.

> **Status:** Checkpoints 1–4 built on a branch (database, daily job,
> administrator dashboard, operational-history retention, release runbook:
> [cleanup-release-runbook.md](cleanup-release-runbook.md)). **Not applied to production,
> no cron schedule, no production credentials.** Deletion is **off** and needs
> two switches plus separate approval. Phase 6.2 (suspension photos) must not
> be released before this cleanup has been verified in deletion mode.

## Approved decisions this follows

1. One daily Vercel job for expired records and orphaned photos.
2. Eligible orphaned photos are deleted directly (no quarantine), only after
   explicit authorization.
3. Daily runs.
4. At most **200 database rows** (cascaded rows included) and **100 photos**
   per run.
5. At least **7 successful daily report-only runs** before deletion can be
   considered.
6. The existing backlog is included.
7. Audit history of deleted issues and suspension records is kept until
   their snowmobile is permanently purged.
8. Verified database and Storage-photo backups before deletion is enabled.
9. A read-only monitoring dashboard for the SledWerx administrator (later
   checkpoint).
10. Verified in deletion mode before Phase 6.2 is released.
11. **Oversized groups:** a deletion group larger than 200 rows is skipped
    whole, recorded (id, size, reason) and flagged for review. The limit is
    never raised automatically.
12. **Small buckets:** the 10% threshold applies only to buckets of **100
    files or more**. Every other safeguard applies to every bucket.
13. **Operational-history retention:** run summaries 400 days; report-run
    details 30 days (the latest seven completed report runs always kept);
    delete-run details 180 days; removed-path records forever; released
    claims 180 days; failed claims until reviewed and resolved. Its own
    switch, off by default.

## Architecture

```
Vercel Cron (daily, GET + Authorization: Bearer CRON_SECRET)
  └─ /api/cron/cleanup          server-only; checks the secret, reads config
       └─ runCleanup()          src/lib/cleanup/run.ts
            1. cleanup_begin_run(mode)          one run at a time
            2. cleanup_process_records(run)     records (all rules in SQL)
            3. cleanup_report_files(run)        files: counts, checks, candidates
            4. delete runs only, for each listed file:
                 cleanup_claim_file  → cleanup_verify_claim
                 → Storage API remove → cleanup_record_file_result
            5. cleanup_retention(run)           operational history (own switch)
            6. cleanup_finish_run(run, error)
```

The database makes every decision. The job never decides on its own that a
file or record may go; it only removes a file the database has just claimed
and verified, and reports back exactly what Storage says it removed.

## Configuration (server environment)

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Random string, 16+ characters. Vercel Cron sends it as `Authorization: Bearer …`. Without it the endpoint answers 503 to everyone. |
| `SUPABASE_SECRET_KEY` | The Supabase **secret** key (`sb_secret_…`, service role). Server-only. |
| `NEXT_PUBLIC_SUPABASE_URL` | Already set for the app. |
| `CLEANUP_MODE` | Unset or `report`: report-only. `delete`: ask for deletion (the database switch must also be on). Anything else: report-only with a warning. |

Credential protections:

- The secret key is read only in `src/lib/cleanup/admin-client.ts`, which
  imports `server-only` (the build fails if browser code imports it). It is
  never logged or returned.
- The job refuses to start if the secret key is the publishable key, or if
  the same value is in any `NEXT_PUBLIC_` variable (those are built into the
  browser bundle).
- **In Vercel, set `CRON_SECRET`, `SUPABASE_SECRET_KEY` and `CLEANUP_MODE`
  for the Production environment only**, so preview deployments (built from
  any branch) never receive them. As a second line, the code never deletes
  when `VERCEL_ENV` is `preview` or `development`, even if configured.
- Every Supabase request times out after 15 s; the route's `maxDuration` is
  60 s, and new file removals start only during the first 40 s.

The daily schedule is in `vercel.json` (see "Cron schedule" below); it runs
only once this branch is merged and deployed to production.

## Deletion authorization (two switches)

Deletion happens only when **both** are on:

1. `CLEANUP_MODE=delete` in the production environment, and
2. the database switch, which can only be turned on after **7 successful
   daily scheduled report runs** (both steps completed, 7 different UTC days)
   and with a **backup reference** recorded:
   `select private.authorize_cleanup_deletion('<backup reference>');`

If the environment asks for deletion but the database switch is off (or
cannot be read), the run continues **report-only** and says so. Every
deleting step re-checks the database switch. Switch off at any time with
`select private.revoke_cleanup_deletion();` or by removing `CLEANUP_MODE`.

## Report-only runs

- List every expired record (table, id, snowmobile, deletion time, when it
  became eligible), flag the **backlog** (already overdue when Migration 8 was
  installed), and size each deletion group including cascades.
- List orphaned photos, unrecognised files and files with incomplete
  metadata, with per-bucket counts and safety warnings.
- **Cannot delete:** the candidate lists come from `STABLE` functions, which
  PostgreSQL does not allow to change data, and a report run never calls the
  claim, verify or Storage remove steps (tests check that nothing changes).
- Work whether or not deletion is authorized.

## What is purged, and when

| Table | Eligible when |
|---|---|
| Snowmobiles, maintenance tables, issues, issue photos, the five suspension tables | in Recently Deleted for more than 30 days |
| Garages | in Recently Deleted for more than 30 days **and** no snowmobile is left in them |
| Invitations | accepted, revoked or expired more than 30 days ago (they contain email addresses) |
| Shares | revoked more than 30 days ago |

- "More than 30 days" is exactly the opposite of the restore rule: a record
  becomes deletable at the moment it stops being restorable.
- **Deletion groups:** deleting a row also deletes what references it with
  `ON DELETE CASCADE`. A row whose parent is also eligible goes with its
  parent's group. Order: child tables first, oldest first.
- **Limit:** each group is deleted in its own subtransaction while a trigger
  counts the rows actually deleted (cascades included). A group that would go
  over 200 rows this run is undone and the run stops; the rest waits.
- **Oversized groups (Decision 11):** a group larger than 200 rows on its own
  (typically a well-used snowmobile with its audit history) is never started:
  it is recorded as `too_large` with its id and size, listed in the run's
  `too_large` summary and in `private.cleanup_review`, and the run continues
  with other groups. A one-time higher limit needs separate approval.
- **Links to purged rows** (`ON DELETE SET NULL`) are cleared on rows that
  stay (e.g. an issue resolved by a purged service record).
- **Audit history** is unchanged (Decision 7).

## Files: what counts as an orphan

| Bucket | Path | Referenced by |
|---|---|---|
| `sled-photos` | `<sled>/<uuid>.jpg\|webp` | `sleds.photo_path` |
| `issue-photos` | `<sled>/<issue>/<uuid>.jpg\|webp` | `sled_issue_photos.path` |
| `suspension-photos` | `<sled>/<setting or revision>/<uuid>.jpg\|webp` | `suspension_photos.path` |

A file may be removed only if **all** of these hold:

1. it is in one of these buckets and its name matches the bucket's exact
   pattern (otherwise: `unrecognized`, never removed);
2. **no row of any state** holds exactly that path (Recently Deleted rows
   count, so a restore always finds its photo);
3. its Storage metadata is complete: timestamps, `eTag` and `size`
   (otherwise: `metadata_missing`, never removed);
4. it is **at least 24 hours old** (the later of Storage's `created_at` and
   `updated_at`).

This covers a mechanic's upload whose record could not be saved (mechanics
still cannot delete files; no existing storage policy was changed), photos of purged
or permanently deleted records, replaced snowmobile photos, and the files of
deleted accounts.

### Bucket safeguards

A bucket is **blocked** (nothing in it is removed that run, the reason is
recorded) when:

| Check | Applies to |
|---|---|
| The registry is incomplete (`private.cleanup_registry_problems()` is not empty: an unregistered Recently Deleted table or photo column, a missing guard or counter trigger, an unregistered or missing bucket) | every bucket; a delete run's record step also stops |
| Storage looks empty while records point at files (unreadable Storage, wrong project) | every bucket |
| Any file in the bucket has incomplete metadata | that bucket |
| The bucket has files and records point at it, but **no** file matches any record (the reference lookup is not trusted) | that bucket |
| More than 10% of the files would be removed | buckets of **100 files or more** only (Decision 12) |

In buckets under 100 files the percentage does not apply, but the
100-files-per-run limit, the 24-hour age, the reference checks, the
metadata checks and the claim lock all still do. A failed reference lookup
raises an error (stopping the run); it is never read as "not referenced".

## File removal and the same-path replacement race

### How photos are written (review, Checkpoint 2 follow-up)

| Bucket | App upload | Same-path overwrite (upsert) by users | Delete, then upload again at the same path |
|---|---|---|---|
| `sled-photos` | New random path (`<sled>/<uuid>.jpg`), `upsert: false` | Allowed to owners and editors by the existing policy "owners and editors can replace sled photos" (the app never does it) | Owners and editors |
| `issue-photos` | New random path, `upsert: false` | Not possible (no update policy) | Owners and editors (delete), then anyone who may edit the issue (upload) |
| `suspension-photos` | New random path, `upsert: false` | Not possible (no update policy) | Owners and editors (delete), then anyone who may add that photo (upload) |

The app itself never writes to an existing path. But the policies allowed a
signed-in owner or editor, using the Storage API directly, to overwrite a
snowmobile photo or to put a new file at an old path in any bucket. The
service role (the job, administrators) bypasses all policies.

### Prevention: claimed and removed paths are write-protected

Supabase Storage removes by path and has **no conditional delete** ("remove
only if this is still version X"). Instead of only detecting a replacement,
Migration 8 now **refuses the write**:

- Two **restrictive** storage policies on `storage.objects`
  ("SledWerx cleanup: no uploads to claimed or removed paths" for INSERT,
  "… no overwrites of claimed or removed paths" for UPDATE) call
  `private.storage_path_writable(bucket, name)`. It returns false while the
  path is `claimed`, and for good once the cleanup removed it (`deleted`,
  `replaced`, `missing`). A restrictive policy can only narrow what the
  existing policies allow: none of the existing policies changed, reading and
  deleting are unaffected, and no one gained any permission.
- That check takes **the same per-path lock as a claim** and reads the claims
  at that moment (`VOLATILE`), so a write and a claim of the same path are
  always serialised: a write in progress makes the claim wait (and the claim
  then sees the new, too-new file and does not claim it); a claim in progress
  makes the write wait (and the write is then refused).
- `cleanup_verify_claim` also **locks the object's row** (`FOR UPDATE`, at
  most 5 seconds), so any write that still held the row finishes first and is
  then seen as a change.

Writes covered: upload to a claimed or removed path, overwrite (upsert),
Storage `update`, and a move into or out of a claimed path (all go through
INSERT/UPDATE on `storage.objects` under the user's role). Normal uploads to
new paths, overwrites of unclaimed snowmobile photos, and authorized removals
(owners and editors, even of a claimed file) work exactly as before.

### The removal protocol

1. **Claim** (`cleanup_claim_file`, under the per-path lock): repeats every
   check and records exactly which object it is (Storage row `id`, `eTag`,
   `size`). From now on no user can write to the path or attach a record to
   it.
2. **Verify** (`cleanup_verify_claim`, immediately before the Storage call,
   row locked): still exactly the claimed object and still an orphan, or the
   claim is released and nothing is removed.
3. **Remove** through the Storage API.
4. **Record** (`cleanup_record_file_result`) with the object Storage reports
   it removed; anything other than the claimed object is recorded as
   `replaced` and flagged for review.
5. The path stays closed for good: no upload and no record can use it again
   ("This photo was removed. Add it again."). The app always uploads to a new
   random path, so nothing legitimate needs an old one.

### What remains

- **For users (signed-in owners, editors, mechanics, viewers): the race is
  closed.** Between claim and removal they cannot write to the path at all,
  and tests show the overwrite waiting and then refused, the claim waiting for
  an overwrite in progress, and a re-upload after removal refused, with two
  real sessions and through the real Storage API.
- **The service role bypasses storage policies.** Only the cleanup job and
  administrators hold that key; a service-role write between steps 2 and 3
  would still be removed. Steps 4–5 detect and report it (`replaced`), and no
  record can point at that path, so nothing referenced is lost. Do not upload
  photos with the service role.
- Database row locks cannot span the Storage API call (Storage uses its own
  connection), so the guarantee for users rests on the policies refusing the
  write, not on holding a lock during the removal.
- The new policies must be applied with Migration 8 (production Storage
  policy change, needs approval like the rest of the migration).

## Failure handling

| Situation | What happens |
|---|---|
| Missing/short `CRON_SECRET` | 503 to every caller; nothing runs |
| Missing or wrong `Authorization` | 401; nothing runs, no configuration revealed |
| Missing URL or secret key, publishable key used, secret in a `NEXT_PUBLIC_` variable | 503 with the problem (to an authenticated caller); nothing runs |
| Duplicate cron invocation | Only one run at a time (database); the second gets 409 `busy` |
| Job crashed or timed out | The run is marked `abandoned` after 30 minutes. Claims it left open are released by the next finish (a file already gone keeps its path blocked) |
| Any database error | The run stops and is closed as `failed` with the message; nothing more is removed |
| Storage error or timeout on a file | Recorded as failed; the claim is released and the file is retried next run; after 3 failed attempts it is left for review. Three failures in a row stop the run's removals |
| Storage says it removed nothing | Recorded as `missing` (nothing removed by us) |
| Storage reports success but the file is still there | Recorded as failed, retried next run |
| Time budget (40 s) used up | Remaining files wait for the next run |
| Expired or invalid claim | Verify/result refuse anything not claimed by this run; open claims are released when the run finishes |
| Very large backlog | Records: 200 rows per run, oldest first, `large_backlog` warning above 1,000 candidates. Files: 100 per run |

A failed safety check is never read as permission to delete.

## Logging and review

- One JSON log line per run (`event: "sledwerx.cleanup"`): status, run id,
  requested and actual mode, record counts and outcomes, removal counts,
  `needs_review`, warnings, error. No paths, names, titles, notes, emails or
  keys.
- The database keeps the details: `private.cleanup_runs` (summary per run)
  and `private.cleanup_candidates` (every record and file with its outcome).
- `private.cleanup_review`: what needs an administrator: from the latest
  finished run, `too_large` groups, failures, replaced files, unrecognised
  files, files with incomplete metadata and blocked files; plus every claim
  that failed or removed a replaced file.

```sql
-- Latest runs.
select id, mode, source, status, started_at, records_deleted, files_deleted,
       summary -> 'records' -> 'outcomes' as records, summary -> 'files' -> 'buckets' as files, error
from private.cleanup_runs order by id desc limit 14;

-- What needs review.
select * from private.cleanup_review order by at desc;

-- What the latest run would delete, by table.
select table_name, outcome, backlog, count(*), sum(group_rows) as rows
from private.cleanup_candidates
where run_id = (select max(id) from private.cleanup_runs) and kind = 'record'
group by 1, 2, 3 order by 1, 2;
```

## Recovery limitations

- **Deletion is permanent.** Database rows and Storage files removed by a
  delete run cannot be restored by the app, by switching cleanup off, or by
  the rollback script. Only the backup taken before authorization can bring
  them back (database backups do not include Storage files, so the photo
  backup is a separate export).
- The rollback script removes Migration 8 and its run history (export first
  if needed); see `supabase/rollback/README.md`.

## Local testing

```bash
npm test                      # unit tests (cron auth, config, run logic, route)
npm run db:start && npm run db:test   # pgTAP, including 011_cleanup
```

Against the local stack (CI's database job runs exactly this):

```bash
eval "$(npx supabase status -o env)"
THROWAWAY_DATABASE=yes CLEANUP_IT_URL="$API_URL" \
  CLEANUP_IT_SECRET_KEY="${SECRET_KEY:-$SERVICE_ROLE_KEY}" \
  CLEANUP_IT_PUBLISHABLE_KEY="${PUBLISHABLE_KEY:-$ANON_KEY}" \
  CLEANUP_IT_PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" \
  npx vitest run src/lib/cleanup/cleanup.integration.test.ts
THROWAWAY_DATABASE=yes PSQL="docker exec -i supabase_db_sledwerx psql -U postgres" scripts/test-cleanup-concurrency.sh
```

To call the endpoint locally: set `CRON_SECRET`, `SUPABASE_SECRET_KEY` (the
local stack's secret key) in `.env.local`, run the app, then
`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/cleanup`.
Never use production keys locally.

## Tables and functions

**Tables** (`private`): `cleanup_settings`, `cleanup_runs`,
`cleanup_candidates`, `cleanup_record_tables`, `storage_cleanup_buckets`,
`storage_reference_columns`, `storage_cleanup_claims` (with the claimed
object's id, eTag and size). **View:** `cleanup_review`. **Index:**
`public.sleds_photo_path_idx`. **Triggers:** `cleanup_count_deletes` on every
table a purge can reach; `storage_claim_guard` on the three photo-path
columns.

**API (service role only):** `cleanup_begin_run`, `cleanup_process_records`,
`cleanup_report_files`, `cleanup_eligible_files`, `cleanup_claim_file`,
`cleanup_verify_claim`, `cleanup_record_file_result`, `cleanup_finish_run`.

**Owner only (SQL editor):** `authorize_cleanup_deletion`,
`revoke_cleanup_deletion`, `purge_expired_records` (manual delete run through
the same limits), `cleanup_registry_problems`.

## Administrator dashboard (read-only)

`/admin/cleanup` shows SledWerx application administrators what the cleanup
is doing across the whole installation. It is not a garage feature: owners,
editors, mechanics and viewers have no access, and nothing on it changes data.

### Who is an administrator

- Administrators are listed in `private.app_administrators` (user id, date,
  optional note). The table is in the private schema with RLS on and no
  grants: no user, not even an administrator, can read or change it through
  the API.
- Access is decided **in the database** on every request:
  `public.cleanup_dashboard()` checks the caller's verified user id
  (`auth.uid()` from the signed JWT) against that table and refuses everyone
  else (`42501 Not authorized.`). It runs with the user's own session; the
  page uses no service-role key.
- Nothing else grants access: not an email address, a profile field, user
  metadata, a client-side flag or a role in a JWT claim (tests check each).
- The page itself only renders what the function returns. Anyone refused
  sees the standard "This page could not be found." page (the dashboard's
  existence is not confirmed; the response is streamed, so its HTTP status is
  200). Signed-out visitors are sent to sign in.
- Default: **no administrators.** None is created by the migration, and none
  was granted in production.

### Provisioning and revoking (database owner, SQL editor)

```sql
-- Find the user's id: Supabase dashboard > Authentication > Users.
-- The account must have a confirmed email address.
select private.grant_app_administrator('<user id>', 'Who and why, e.g. "SledWerx operator, approved 2026-11-20"');

-- Who is an administrator?
select a.user_id, u.email, a.granted_at, a.note
from private.app_administrators a join auth.users u on u.id = a.user_id;

-- Revoke (takes effect on the next page load).
select private.revoke_app_administrator('<user id>');
```

Deleting the account also removes its administrator access. Grant and revoke
only with approval; keep the list short.

### What it shows

- **Mode:** report-only or deletion, with both switches (database and the
  server's `CLEANUP_MODE`), so "one switch on" is visible.
- **Daily report runs** counted toward the required seven (the same rule as
  the deletion gate).
- **Backup attestation:** recorded or not, and when deletion was authorized.
  The reference text itself is never shown.
- **Last run** with status, duration and error.
- **Expired records** of the latest report: eligible, backlog, newly expired,
  rows, outcomes.
- **Orphaned photos by bucket**, with blocked buckets and the reason.
- **Oversized groups** awaiting review (table, short ids, size).
- **Needs attention:** blocked files, unrecognised paths, incomplete metadata,
  failed and replaced removals.
- **Security and safety warnings** (incomplete registry, unreadable Storage,
  replaced files, failed or abandoned runs, deletion on with too few report
  runs).
- **Recent runs** (last 14) and the safety limits.

It shows ids, counts, timestamps and storage paths only: never names, email
addresses, titles, notes or the backup reference. It has no buttons, forms or
inputs: switches, limits, backups, the schedule and manual runs are changed
only in the database or the deployment settings, with approval.

## Operational-history retention

Retention trims the cleanup system's **own** history: run summaries, run
details (candidates) and released file claims. It is not user data and has
nothing to do with the 30-day recovery period for user-deleted records.

### Approved periods

| Data | Kept | Never removed |
|---|---|---|
| Run summaries (`cleanup_runs`) | 400 days | A running run; the latest 7 completed report runs |
| Report-run details | 30 days | Details of the latest 7 completed report runs (however old) |
| Delete-run details | 180 days | |
| Released file claims | 180 days | |
| Removed-path tombstones (`deleted`, `replaced`, `missing`) | Forever | Always kept: they keep removed paths closed |
| Active (`claimed`), `failed` and `closed` claims | Forever, until resolved | See "Failed removals" |

The periods are columns of `private.cleanup_settings` that can only be
**raised** (database checks), and at most 1,000 rows (up to 5,000) are
removed per run.

### How it runs and who allows it

- It is a step of the existing daily job (`cleanup_retention`, after the file
  work, in report and delete runs alike). There is no second schedule.
- **Its own switch, off by default:** `retention_enabled`. Switching it on
  needs an approval note: `select private.authorize_retention_maintenance('<who approved, when>');`
  Off again: `select private.revoke_retention_maintenance();`. It is
  independent of deleting user data (and does not authorize it).
- **While off,** each run records a preview: how many rows of each kind
  qualify. Exactly which rows: `select * from private.retention_candidates();`
  (read-only).
- **While on,** it removes details first, then released claims, then run
  summaries that no longer have details (so nothing is removed by cascade),
  each `DELETE` repeating its rule, all in one transaction.
- **Fails closed:** if the latest report runs would not be protected, or any
  protected claim count changes, or anything else fails, the whole step is
  undone and the run is marked failed ("Applying retention failed…"), shown
  on the dashboard.
- Repeating is harmless (what is gone no longer qualifies); one retention
  step per run; two at once are refused.

### Tombstones do not depend on run history

A tombstone is a row in `private.storage_cleanup_claims` keyed by bucket and
path. Its `run_id` only points back to the run that removed the file and is
set to null when that run summary expires. Protection comes from the row
itself: the restrictive storage policies and the record guard read only the
bucket, path and status. Tests remove the run summary of a removed photo and
show that uploads (real Storage API) and records are still refused.

## Failed removals (failed claims)

A file whose removal failed 3 times is marked `failed`. It stays in Storage,
is never retried automatically, and is never removed by retention.

**Investigate:** `select * from private.cleanup_review where outcome = 'failed';`
and `select * from private.storage_cleanup_claims where status = 'failed';`
(last error, attempts, run). Check Storage (does the file exist; can it be
removed with the dashboard's project settings; was there an outage).

**Resolve (database owner, SQL editor; dashboard has no controls):**

```sql
-- 1. Record the review. Changes nothing else (no release, no deletion).
select private.review_failed_claim('<bucket>', '<path>', 'What was checked and found');

-- 2. Resolve - only after a review - as one of:
select private.resolve_failed_claim('<bucket>', '<path>', 'removed', 'How it was removed');
--    the file must already be gone (checked) -> a permanent tombstone
select private.resolve_failed_claim('<bucket>', '<path>', 'retry', 'What was fixed');
--    the file must still exist -> released, attempts reset; next delete run retries
select private.resolve_failed_claim('<bucket>', '<path>', 'keep', 'Why it is kept');
--    the file must still exist -> closed: never removed automatically
```

The review and resolution (who wrote what, and when) stay on the claim.
A dashboard workflow for this (with its own administrator permission) is a
possible future change and would need approval.

## Cron schedule

`vercel.json` (on this branch only):

```json
{ "crons": [{ "path": "/api/cron/cleanup", "schedule": "17 9 * * *" }] }
```

- **Once a day at 09:17 UTC** (01:17 Pacific / 04:17 Eastern in winter; one
  hour later in summer clock terms).
- **Plan compatibility:** Vercel Hobby allows cron jobs that run at most once
  a day (on Hobby they may fire any time within the scheduled hour); Pro and
  above run at the minute. A once-daily schedule works on every plan. The
  route's `maxDuration` is 60 seconds, within every plan's limit.
- **Production only:** Vercel runs cron jobs only for the production
  deployment, never for preview deployments. In addition, the endpoint needs
  `CRON_SECRET` and `SUPABASE_SECRET_KEY` (set for Production only) and never
  deletes when `VERCEL_ENV` is not `production`.
- **Deletion stays off:** without `CLEANUP_MODE=delete` **and** the database
  switch, runs only report; retention has its own switch, also off.
- The cron entry becomes active only when this branch is merged and deployed
  to production (a release step that needs approval).

## Security and reliability review (Checkpoint 4)

| Area | Status |
|---|---|
| Cron authentication | `Authorization: Bearer CRON_SECRET`, constant-time; no secret configured → 503 for all; wrong → 401 without detail |
| Environment isolation | Secrets for Production only; no deletion when `VERCEL_ENV` ≠ production; Vercel runs crons for production only |
| Service-role key | Only in a `server-only` module; refused if publishable or present in a `NEXT_PUBLIC_` variable; never logged or returned; not used by the dashboard |
| Database access | Cleanup tables private (RLS on, no grants); API functions service role only; dashboard function checks the administrators list; existing RLS unchanged |
| Administrators | Private list, managed by the database owner only; nothing client-controlled grants access; revocation immediate |
| Storage | Ten existing policies unchanged; two restrictive policies close claimed and removed paths to uploads and overwrites; tombstones kept forever and independent of run history |
| Same-path replacement | Prevented for every signed-in user; only a service-role write in the last moment remains, detected and flagged |
| Deleting user data | Two switches; 7 daily report runs and a backup attestation before the database switch can be turned on |
| Limits | 200 rows per run counted as actually deleted (cascades included); 100 photos; 10% for buckets of 100+ files; oversized groups skipped whole |
| Failures | Storage errors retried next run, 3 attempts then kept for review; database errors stop the run; Storage/database disagreement after a crash is resolved by closing paths of missing files |
| Concurrency | One run at a time; per-step advisory locks; claim/attach/upload serialised per path; restore vs purge serialised per row |
| Timeouts | 15 s per request; 60 s per run; removals start only in the first 40 s; stuck runs abandoned after 30 minutes |
| Retention | Its own switch (off); periods can only be raised; tombstones, active, failed and closed claims never removed; bounded batches; one transaction; fails closed |
| Rollback | Removes the cleanup, cannot restore anything it deleted (backups required) |

Unresolved risks: a service-role write in the last moment before a removal
(detected, not prevented); the backup reference is an attestation the
database cannot verify; Hobby-plan crons fire within the scheduled hour.

## Known limitations and release blockers

- **Release blockers:** Migration 8 applied to production; 7 successful daily
  report runs reviewed; verified database and photo backups; deletion
  authorized and a delete run verified, all before Phase 6.2 is released. The
  cron schedule and production credentials also still need approval.
- **No conditional delete in Storage:** users cannot write to a claimed or
  removed path (restrictive policies); only a service-role write in the last
  moment could still be removed, and it is detected and reported (see above).
- **Oversized snowmobiles** are skipped daily until a one-time higher limit
  is approved.
- **Operational-history retention** is built but off; it needs its own
  approval to switch on.
- **Backup reference** is a recorded attestation; the database cannot verify
  the backup.
- **Offline devices** that have not synced for more than 30 days must do a
  full resync.
- No administrator exists anywhere yet; production access needs approval.

## Tests

- `supabase/tests/database/011_cleanup.test.sql` (pgTAP): recovery
  boundaries, report-only behavior, backlog, deletion groups, limits and the
  undo safety net, oversized groups and review, files (references in every
  state, 24-hour boundary, metadata, unrecognised paths, the mechanic's
  upload), claims, verification, replacement detection, blocked paths,
  registry self-check, small and large bucket thresholds, access control.
- `src/lib/cleanup/*.test.ts`, `src/app/api/cron/cleanup/route.test.ts`
  (unit): cron authentication, both deletion switches, preview refusal,
  report-only behaviour, Storage failures and timeouts, replacement handling,
  time budget, busy runs, database errors.
- `src/lib/cleanup/cleanup.integration.test.ts` (CI, local stack): real
  users and uploads, mechanic's orphan removed, active and recoverable photos
  protected, both switches, duplicate invocation, replacement after claim and
  in the last moment, Storage failure and retry.
- `scripts/test-cleanup-concurrency.sh` (two real sessions) and
  `scripts/test-migration-8-rollback.sh`.
- `e2e/public.spec.ts`: the endpoint refuses calls without the secret.
- `supabase/tests/database/013_cleanup_retention.test.sql` (pgTAP): every
  retention boundary, the latest 7 report runs, tombstones and failed claims
  kept, switch off by default, batches, an interrupted step, the failed-claim
  lifecycle; the integration test shows a tombstone still closing its path
  through the real Storage API after its run summary was removed.
- `supabase/tests/database/012_cleanup_dashboard.test.sql` (pgTAP) and
  `e2e/admin-cleanup.spec.ts` (CI, local stack): administrator access, every
  other role refused (page and API), empty, report and deletion states,
  warnings, read-only, phone/tablet/desktop, accessibility, keyboard.
