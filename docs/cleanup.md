# Recently Deleted & storage cleanup (Migration 8)

Migration 8 (`supabase/migrations/20261122090000_recently_deleted_cleanup.sql`)
is the **database part** of the approved cleanup: permanently removing records
whose 30-day recovery period has passed, and finding photo files no record
points at. Nothing runs on its own. A daily server-side job (Checkpoint 2,
not built yet) calls the functions below with the service-role key.

> **Status:** built and tested on a branch (Checkpoint 1). **Not applied to
> production.** Deletion is **off** by default and needs separate approval.
> Phase 6.2 (suspension photos) must not be released before this cleanup has
> been verified in deletion mode.

## Approved decisions this follows

1. One daily Vercel job for expired records and orphaned photos.
2. Eligible orphaned photos are deleted directly (no quarantine), only after
   explicit authorization.
3. Daily runs.
4. At most **200 database rows** (cascaded rows included) and **100 photos**
   per run; **10% bucket threshold**.
5. At least **7 successful daily report-only runs** before deletion can be
   considered.
6. The existing backlog is included.
7. Audit history of deleted issues and suspension records is kept until
   their snowmobile is permanently purged.
8. Verified database and Storage-photo backups before deletion is enabled.
9. A read-only monitoring dashboard for the SledWerx administrator (later
   checkpoint).
10. Verified in deletion mode before Phase 6.2 is released.

## What is purged, and when

| Table | Eligible when |
|---|---|
| Snowmobiles, maintenance tables, issues, issue photos, the five suspension tables | in Recently Deleted for more than 30 days |
| Garages | in Recently Deleted for more than 30 days **and** no snowmobile is left in them |
| Invitations | accepted, revoked or expired more than 30 days ago (they contain email addresses) |
| Shares | revoked more than 30 days ago |

- "More than 30 days" is exactly the opposite of the restore rule
  (`deleted_at < now() - 30 days`): a record becomes deletable at the moment
  it stops being restorable, never earlier. Deleted exactly 30 days ago: still
  restorable, not deletable.
- **Deletion groups.** Deleting a row also deletes what references it with
  `ON DELETE CASCADE` (an issue's photos, a setup's revisions, feedback and
  photos, a snowmobile's records and audit history). A row whose parent is
  also eligible is not deleted on its own: it goes with its parent's group.
- **Order:** child tables first (photos, feedback, …), then records, then
  snowmobiles, then garages, oldest first within a table.
- **Backlog:** rows that were already eligible when Migration 8 was installed
  (`cleanup_settings.installed_at`) are flagged `backlog = true`; rows that
  expire later are "newly expired". Run summaries count both.
- **Links to purged rows** (`ON DELETE SET NULL`): an active issue resolved by
  a purged service record loses that link; a service record linked to a
  purged reading or task loses that link. Those rows stay; the change shows in
  their history and bumps their version (devices with an old copy reload).
- **Audit history** is unchanged: deletes are not audited, and the history of
  a purged issue or suspension record stays until its snowmobile is purged.

## Files: what counts as an orphan

Only these buckets are swept, and only object names in the app's exact path
format (`private.storage_cleanup_buckets`):

| Bucket | Path | Referenced by |
|---|---|---|
| `sled-photos` | `<sled>/<uuid>.jpg\|webp` | `sleds.photo_path` |
| `issue-photos` | `<sled>/<issue>/<uuid>.jpg\|webp` | `sled_issue_photos.path` |
| `suspension-photos` | `<sled>/<setting or revision>/<uuid>.jpg\|webp` | `suspension_photos.path` |

A file is an **orphan** (removable) only if all of these are true:

1. its name matches the bucket's pattern (anything else is reported as
   **unrecognized** and never removed);
2. **no row of any state** holds exactly that path (rows in Recently Deleted
   count, so a restore always finds its file);
3. it is **at least 24 hours old** by Storage's own timestamps, using the
   later of `created_at` and `updated_at` (no timestamp = never old enough).

This covers a mechanic's upload whose record could not be saved (mechanics
still cannot delete files; no storage policy was changed), the photos of
purged or permanently deleted records, replaced snowmobile photos, and the
files of deleted accounts.

The columns that hold paths are listed in `private.storage_reference_columns`.
A database test fails if any `path`/`*_path` column, or any column checked
against the photo-path format, is missing from it, so a future photo table
cannot be left out silently.

## How a run works

The job will call, with the service-role key:

1. `cleanup_begin_run('report' | 'delete')` → run id. A delete run is refused
   unless deletion is authorized. One run at a time; a run that never finished
   is marked `abandoned` after 2 hours.
2. `cleanup_process_records(run_id)`: lists every eligible row and the size
   of each deletion group. In a **report** run it deletes nothing. In a
   **delete** run it deletes group by group (see limits).
3. `cleanup_report_files(run_id)`: counts each bucket (referenced, orphans,
   too new, unrecognized), applies the 10% threshold, and lists orphans
   (oldest first) and unrecognized files.
4. Delete runs only, for each `eligible` file:
   `cleanup_claim_file(run_id, bucket, path)` → `{claimed: true}` or a reason;
   then the job removes the file through the Storage API (Checkpoint 2) and
   reports back with `cleanup_record_file_result(run_id, bucket, path,
   removed, error)`.
5. `cleanup_finish_run(run_id, error)`: closes the run and releases any claim
   it never reported on.

`private.purge_expired_records()` (manual, SQL editor) now runs the same
limited, logged, authorized engine as a delete run (`source = 'manual'`).

## Safety controls

| Control | How |
|---|---|
| Deletion off by default | `cleanup_settings.deletion_enabled = false`; every deleting step checks it again |
| 7 report runs + backup first | Switching deletion on is refused unless 7 completed scheduled report runs (both steps done) exist on 7 different days **and** a backup reference is recorded (`private.authorize_cleanup_deletion('<backup reference>')`) |
| Report runs cannot delete | The candidate and file lists come from `STABLE` functions; PostgreSQL refuses any data change inside them. Tests check nothing changes |
| 200 rows per run, cascades included | Each group is deleted in its own subtransaction while a statement trigger on every reachable table counts the rows actually deleted. A group that would go over the limit is **undone** and the run stops; the rest waits for the next run |
| Groups larger than the whole limit | Skipped and reported as `too_large` (never partly deleted) |
| Re-checked at deletion | The `DELETE` itself repeats the eligibility test; a row restored meanwhile is not deleted (`not_eligible`) |
| 100 files per run | Enforced when claiming |
| 10% per bucket | If more than 10% of a bucket's files would be removed, nothing in that bucket is claimable (`blocked_threshold`) |
| Storage unreadable | If Storage looks empty while records point at files, every bucket is blocked |
| 24-hour minimum | Cannot be configured below 24 hours |
| Claim lock | Claiming and attaching a path to a record take the same per-path lock. A claimed path cannot be attached (`55006 This photo is being removed`); a file attached first is never claimed |
| 3 attempts | A file that fails to delete 3 times is marked `failed` and left for review |
| Only listed files | Only a file this delete run listed as `eligible` can be claimed |
| No user content | Logs hold table names, ids, snowmobile ids, timestamps, storage paths and error messages only |
| Access | Cleanup tables: RLS on, no policies, no grants to signed-in users or visitors. Functions: service role (API) and database owner only |

## Tables and functions

**Tables** (all in `private`): `cleanup_settings` (one row), `cleanup_runs`,
`cleanup_candidates`, `cleanup_record_tables` (purge registry),
`storage_cleanup_buckets`, `storage_reference_columns` (file registries),
`storage_cleanup_claims`. **Index:** `public.sleds_photo_path_idx`.

**Triggers on existing tables:** `cleanup_count_deletes` (statement-level,
after delete; only counts while a cleanup group is being deleted) on every
purged table and `audit_log`; `storage_claim_guard` on the three photo-path
columns.

**API (service role only):** `public.cleanup_begin_run`,
`cleanup_process_records`, `cleanup_report_files`, `cleanup_claim_file`,
`cleanup_record_file_result`, `cleanup_finish_run`.

**Private:** `expired_records_report`, `expired_record_candidates`,
`cleanup_cascade_rows`, `cleanup_delete_root`, `cleanup_process_records`,
`storage_file_candidates`, `storage_file_status`, `storage_path_referenced`,
`storage_path_recognized`, `cleanup_report_files`, `cleanup_claim_file`,
`cleanup_record_file_result`, `cleanup_begin_run`, `cleanup_finish_run`,
`authorize_cleanup_deletion`, `revoke_cleanup_deletion`,
`purge_expired_records`.

## Reviewing report runs (SQL editor, read-only)

```sql
-- Latest runs.
select id, mode, source, status, started_at, records_deleted, files_deleted,
       summary -> 'records' -> 'outcomes' as records, summary -> 'files' -> 'buckets' as files, error
from private.cleanup_runs order by id desc limit 14;

-- What the latest run would delete, by table.
select table_name, outcome, backlog, count(*), sum(group_rows) as rows
from private.cleanup_candidates
where run_id = (select max(id) from private.cleanup_runs) and kind = 'record'
group by 1, 2, 3 order by 1, 2;

-- Files it would remove, and unrecognised files.
select bucket_id, outcome, object_path, object_created_at, detail
from private.cleanup_candidates
where run_id = (select max(id) from private.cleanup_runs) and kind = 'file'
order by bucket_id, outcome, object_created_at;
```

## Known limitations and open points

- **Large snowmobile groups.** A snowmobile's group includes its whole audit
  history, so a well-used snowmobile can exceed 200 rows and is then reported
  as `too_large` every day instead of being purged. Purging it needs an
  approved, temporary higher `max_records_per_run`.
- **Small buckets and the 10% threshold.** In a bucket with few files, a
  single orphan can exceed 10% (1 of 5 files = 20%), which blocks that bucket
  every run. Applied exactly as approved; a minimum file count before the
  percentage applies would need a decision.
- **Same-path replacement.** Snowmobile photos may be replaced at the same
  path by owners and editors (the app always uses a new path). A replacement
  in the seconds between a claim and the Storage removal would be removed with
  the claimed file. The claim re-checks the file's age, so only a file
  untouched for 24 hours is ever claimed.
- **Storage access.** The functions read `storage.objects` as the database
  owner. If that ever returns nothing while records point at files, every
  bucket is blocked (`storage_unreadable`) instead of treating every file as
  an orphan.
- **Run history** (`cleanup_runs`, `cleanup_candidates`) is not trimmed yet;
  a retention rule belongs with the monitoring dashboard.
- **Backup reference** is a recorded attestation; the database cannot verify
  that the backup exists.
- **Offline devices.** As before, a device that has not synced for more than
  30 days must do a full resync.
- **Rollback cannot undo deletions.** Records and files removed by a delete
  run are gone; only the backup can bring them back.

## Tests

- `supabase/tests/database/011_cleanup.test.sql` (pgTAP): recovery
  boundaries, report-only behavior, backlog, deletion groups, the suspension
  restore chain, `SET NULL` links, limits and the undo safety net, files
  (references in every state, 24-hour boundary, unrecognised paths, the
  mechanic's orphaned upload, claims and the attach guard), registries,
  access control, settings guard, repeated runs.
- `scripts/test-cleanup-concurrency.sh`: two real sessions (claim vs
  attach both ways, restore vs purge both ways, two record steps at once).
- `scripts/test-migration-8-rollback.sh`: refusals, the purge function back
  to its Migration 2 form, nothing else changed, re-apply and roll back again.
