# Migration 8 cleanup: production release runbook

Step-by-step release of the Recently Deleted & storage cleanup
([cleanup.md](cleanup.md)). **Nothing here has been done.** Each step needs
explicit approval before it is executed; stop at the first failed check.

- **Part A — Preparation** can be done any time and changes nothing in
  production.
- **Part B — Execution** changes production, one approved step at a time.

**Measurement photo uploads are on in production** (since 2026-11-24;
`SUSPENSION_PHOTO_UPLOADS=on`). They were separated from this runbook by
decision (Decision 10, amended again 2026-11-24): photo uploads, viewing,
replacement, removal and carry-forward work with the cleanup in report-only
mode, and do not wait for deletion to be verified. Step B9 below is kept as
the record of the original plan. Deletion and retention stay off and are a
separate decision.

---

## Part A — Preparation (no production changes)

### A1. Review and approvals to collect

- [ ] PR #18 reviewed; all eight CI checks green on its final commit.
- [ ] Written approval for each of: B1 (apply migration), B2 (first
      administrator), B3 (deploy report-only), B6 (backups), B7 (authorize
      deletion), B8 (operational-history retention), B9 (turn on Phase 6.2
      photo uploads).
- [ ] Who is on call for the first two weeks, and who may switch deletion off.

### A2. Credentials to prepare (do not add them yet)

| Variable | Value | Vercel environment |
|---|---|---|
| `CRON_SECRET` | Fresh random string, 32+ characters (e.g. `openssl rand -base64 48`) | **Production only** |
| `SUPABASE_SECRET_KEY` | Supabase › Project Settings › API Keys › a dedicated **secret** key (`sb_secret_…`) for the cleanup | **Production only** |
| `CLEANUP_MODE` | Leave **unset** (report-only) | — |

Never put either secret in a `NEXT_PUBLIC_` variable, `.env.local` copies
shared with others, chat or the repository. The job refuses to start if the
secret key is the publishable key or appears in a `NEXT_PUBLIC_` variable.

### A3. Dry runs

- [ ] `npx supabase db push --dry-run` against production lists only
      `20261122090000_recently_deleted_cleanup.sql`.
- [ ] Confirm the Vercel plan (Hobby runs daily crons within the scheduled
      hour; Pro at the minute). The schedule is once daily, 09:17 UTC.
- [ ] Read the rollback limits ([supabase/rollback/README.md](../supabase/rollback/README.md)):
      the rollback cannot restore anything already deleted.

### A4. Backup plan (needed before B7)

- Database: confirm what the Supabase plan offers (daily backups, PITR) and
  how a restore is requested; also take a manual `pg_dump` of the affected
  tables right before B7.
- Photos: Storage files are **not** in database backups. Plan a full export
  of `sled-photos`, `issue-photos` and `suspension-photos` (e.g. with the
  Supabase CLI or an S3-compatible copy) to storage you control.

---

## Part B — Execution (each step separately approved)

### B1. Apply Migration 8 (approval required)

1. Deploy nothing yet. From the approved commit: `npx supabase db push`.
2. Verify (read-only, SQL editor):
   ```sql
   select deletion_enabled, retention_enabled from private.cleanup_settings;   -- false, false
   select private.cleanup_registry_problems();                                 -- {}
   select count(*) from pg_policies where policyname like 'SledWerx cleanup:%'; -- 2
   select count(*) from private.app_administrators;                            -- 0
   ```
3. The app keeps working as before: uploads to new paths, removals, records.

### B2. Grant the first application administrator (approval required)

1. Find the approved person's user id (Authentication › Users; confirmed email).
2. `select private.grant_app_administrator('<user id>', '<name, approval reference>');`
3. That person opens `/admin/cleanup`: "No cleanup runs yet", Report-only,
   0 of 7 report runs, backup not recorded, retention off.
4. Everyone else still gets "not found".

### B3. Deploy the cleanup job in report-only mode (approval required)

1. In Vercel, add `CRON_SECRET` and `SUPABASE_SECRET_KEY` for **Production
   only**. Do not set `CLEANUP_MODE`.
2. Merge PR #18 to `main` (this deploys the endpoint and the `vercel.json`
   cron) — only with approval.
3. Check: `curl -i https://<production domain>/api/cron/cleanup` → `401`.
4. Optionally trigger one run by hand with the secret:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/cleanup`
   (from a trusted machine; never paste the secret anywhere else). Manual
   runs are `scheduled` source runs too.
5. In Vercel › Cron Jobs, the job is listed for production.

### B4. First report

- The dashboard shows the run: eligible records (backlog vs new), orphans per
  bucket, oversized groups, warnings. Nothing was deleted
  (`records_deleted = 0`, `files_deleted = 0`).

### B5. Review seven successful daily reports

For at least seven different days:
- [ ] The run completed (no failed/abandoned runs unexplained).
- [ ] Expired records look right (spot-check ids in the SQL editor:
      `select * from private.cleanup_candidates where run_id = <id> and kind = 'record' limit 50;`).
- [ ] Orphaned photos look right: spot-check that listed paths really have no
      record (`select * from private.cleanup_candidates where run_id = <id> and kind = 'file';`).
- [ ] No registry problems, unreadable-Storage or replaced-file warnings.
- [ ] Oversized groups noted (they stay skipped; a one-time higher limit
      needs its own approval).
The dashboard's "Daily report runs" reaches 7 of 7.

### B6. Verify backups (approval required)

- [ ] A fresh database backup exists and a restore path is confirmed.
- [ ] A complete export of the three photo buckets exists, with a file count
      that matches `select bucket_id, count(*) from storage.objects group by 1;`.
- [ ] Record a reference for both (date, location, who checked) — not
      credentials or links with tokens.

### B7. Authorize the first controlled deletion (approval required)

1. Database switch (SQL editor):
   `select private.authorize_cleanup_deletion('<backup reference from B6>');`
   (refused unless 7 daily report runs and a reference exist).
2. Server switch: set `CLEANUP_MODE=delete` for Production in Vercel and
   redeploy.
3. The dashboard shows Mode: **Deletion** (both switches on).
4. The next run deletes at most 200 rows (cascades included) and 100 photos.

### B8. Review deletion results and handle failures

After each of the first few delete runs:
- [ ] `records_deleted` and `files_deleted` match the previous report's
      expectations; no unexpected tables.
- [ ] "Needs attention": `failed` removals → follow "Failed removals" in
      [cleanup.md](cleanup.md) (review, then resolve as removed, retry or
      keep); `replaced` → investigate who used the service role.
- [ ] Spot-check that active and recoverable photos still load in the app.
- [ ] Optionally switch on operational-history retention (separate approval):
      `select private.authorize_retention_maintenance('<approval reference>');`
      and check its preview first: `select private.retention_counts();`.

### B9. Turn on measurement photo uploads (done 2026-11-24, without B6–B8)

> Done: uploads were turned on after Migration 11 was applied and verified, a
> production read-only check, and a live smoke test, with the cleanup in
> report-only mode (Decision 10, amended again 2026-11-24). The prerequisites
> below that involve deletion (B8) no longer apply to photo uploads.

Only **measurement photos** (Migration 10) are added from the app. The older
reference and adjustment photo uploads stay off in the code whatever the
flag says; existing ones remain viewable and removable.

Before (all must hold):
- [ ] Migration 11 (`20261125090000_measurement_photo_access.sql`) applied
      and verified (shared photos stay viewable and can still be carried
      forward after an old configuration is purged).
- [ ] At least one delete run verified (B8), **including a photo removal**:
      for example a controlled test orphan uploaded to the Photo Test
      snowmobile's folder without a record, reported after 24 hours, then
      removed, while every Photo Test photo still loads.
- [ ] No unresolved replaced or failed removals, no warnings, registry
      problems `{}`.
- [ ] Read-only check: every active measurement photo row points at an
      existing file, and every file in `suspension-photos` is either referenced
      or listed by the latest report:
      ```sql
      select count(*) as rows_without_file from public.sled_measurement_photos m
      where m.deleted_at is null and not exists (
        select 1 from storage.objects o where o.bucket_id = 'suspension-photos' and o.name = m.path);
      select f.status, count(*) from private.storage_file_candidates() f
      where f.bucket_id = 'suspension-photos' group by 1;
      ```
      Expected: `rows_without_file = 0`; statuses only `referenced`,
      `too_new`, and the orphans the report listed.

Then, under its own approval:
1. Set `SUSPENSION_PHOTO_UPLOADS=on` for **Production only** in Vercel and
   redeploy (leave Preview and Development unset unless testing).
2. Smoke test on Photo Test, as the owner: add a photo, add a second, see
   that a third can't be added, view one enlarged, replace one, remove one,
   save an adjustment and see the photos carried to the new Trail, replace a
   photo there and check the previous Trail still shows its own. Then, as a
   mechanic shared on Photo Test: add a photo; Replace and Remove are not
   offered.
3. Check that no "Add reference photos", Record-adjustment photo picker or
   History "Photos" upload appears.
4. Watch the next daily runs: no warnings; new photos counted as referenced;
   only true orphans (for example a mechanic's upload whose save failed)
   listed and, in deletion mode, removed after 24 hours.

To turn uploads off again: delete the variable and redeploy. Photos already
added stay visible and removable.

---

## Emergency shutdown and recovery

**Stop deleting immediately (either one is enough):**
1. Database: `select private.revoke_cleanup_deletion();` — takes effect for
   the next step of any run.
2. Vercel: remove `CLEANUP_MODE` (or set `report`) and redeploy.

**Stop the job entirely:** remove `CRON_SECRET` in Vercel (the endpoint then
answers 503 to everyone) or remove the cron in Vercel › Cron Jobs.

**Stop operational-history retention:** `select private.revoke_retention_maintenance();`.

**Revoke administrator access:** `select private.revoke_app_administrator('<user id>');`.

**A run stuck "running":** it is marked abandoned after 30 minutes; open file
claims are released (paths whose files are gone stay closed).

**Rotate a leaked secret:** create a new Supabase secret key, update
`SUPABASE_SECRET_KEY`, revoke the old key; generate a new `CRON_SECRET`.

**Recovery of deleted data:** deleted rows and photos cannot be restored by
the app, the switches, or the rollback script. Restore from the B6 backups
(database: Supabase restore/PITR or the `pg_dump`; photos: re-upload from the
export to the same paths with the service role — paths the cleanup removed
are closed to normal uploads by design).

**Withdraw Migration 8 entirely:** follow
[supabase/rollback/README.md](../supabase/rollback/README.md) (deletion off,
no run in progress, no claimed file). It removes the cleanup but keeps all
user data as it is.
