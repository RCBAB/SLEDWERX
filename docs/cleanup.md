# Recently Deleted & storage cleanup (Migration 8)

Permanently removes records whose 30-day recovery period has passed, and
photo files that no record points at. Two parts:

- **Database** (`supabase/migrations/20261122090000_recently_deleted_cleanup.sql`):
  decides what may be deleted, deletes records, claims and checks files,
  enforces every limit and keeps the run history.
- **Daily job** (`src/app/api/cron/cleanup/route.ts`): a server-only endpoint
  for Vercel Cron that calls the database and removes the files the database
  has claimed, through the Storage API.

> **Status:** Checkpoints 1–2 built on a branch. **Not applied to production,
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
            5. cleanup_finish_run(run, error)
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

Not done yet (needs approval): the `crons` entry in `vercel.json`, e.g.

```json
{ "crons": [{ "path": "/api/cron/cleanup", "schedule": "17 9 * * *" }] }
```

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
still cannot delete files; no storage policy was changed), photos of purged
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

Supabase Storage removes by path and has **no conditional delete** ("remove
only if this is still version X"). The job therefore uses a fail-closed
protocol:

1. **Claim** (`cleanup_claim_file`, under a per-path lock): repeats every
   check and records exactly which object it is: Storage row `id`, `eTag`
   and `size`. While claimed, no record can be given that path.
2. **Verify** (`cleanup_verify_claim`, immediately before the Storage call):
   the object at the path must still be the claimed one (same id, eTag, size)
   and still an orphan. If it was replaced (same row with new content, or
   deleted and uploaded again), the claim is released and the file is **not**
   removed.
3. **Remove** through the Storage API.
4. **Record** (`cleanup_record_file_result`) with the object Storage reports
   it removed. If that is not the claimed object (a replacement uploaded in
   the milliseconds between steps 2 and 3), the result is `replaced` and
   flagged for review.
5. **The path is blocked for good** once removed (`deleted`, `replaced`,
   `missing`): `storage_claim_guard` refuses to attach any record to it
   ("This photo was removed. Add it again."). The app always uploads to a new
   random path, so nothing legitimate needs an old one.

Together: a file is only ever removed while no record can reference its path,
and after removal no record ever can. In the residual window (between step 2
and step 3) only an **unreferenceable** file can be lost, and the loss is
detected and reported. Tests cover replacement after the claim, delete and
re-upload, and replacement in the last moment, against the real Storage API.

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

## Known limitations and release blockers

- **Release blockers:** Migration 8 applied to production; 7 successful daily
  report runs reviewed; verified database and photo backups; deletion
  authorized and a delete run verified, all before Phase 6.2 is released. The
  cron schedule and production credentials also still need approval.
- **No conditional delete in Storage:** see the replacement race above; the
  residual window can only remove an unreferenceable file, and is reported.
- **Oversized snowmobiles** are skipped daily until a one-time higher limit
  is approved.
- **Run history** is not trimmed yet (belongs with the dashboard).
- **Backup reference** is a recorded attestation; the database cannot verify
  the backup.
- **Offline devices** that have not synced for more than 30 days must do a
  full resync.
- The administrator dashboard (Decision 9) is not built.

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
