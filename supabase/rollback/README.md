# Rollback scripts

**Manual use only.** These scripts undo a migration. They are never run by the
Supabase CLI, by CI, or by any deployment:

- They live outside `supabase/migrations/`, the only folder `supabase db push`
  applies.
- `supabase/config.toml` does not reference this folder (`schema_paths` is
  empty and seed files are only `./seed.sql`).
- CI checks both of these on every pull request.
- Each script refuses to run unless the operator confirms it in the same
  session (see below).

Rolling back deletes database objects. Run a rollback only when the steps
below call for it, and preferably after talking it through.

---

## Order matters

Roll back the newest migration first: Migration 8, then 7, then 6, then 5, then 4, then 3, then 2, then 1. Each
older rollback fails safely (changing nothing) while a newer migration that
depends on it is still applied.

---

## `20261122090000_rollback.sql` (Migration 8)

Undoes `supabase/migrations/20261122090000_recently_deleted_cleanup.sql`: the
cleanup tables (settings, runs, candidates, registries, file claims), the
cleanup functions including the eight `public.cleanup_*` API functions, the `cleanup_review` view, the
`cleanup_count_deletes` and `storage_claim_guard` triggers, and
`sleds_photo_path_idx`. It puts `private.purge_expired_records()` back exactly
as Migration 2 left it. Storage policies and every other object are untouched.

**It cannot bring back anything the cleanup already deleted.** Records and
files removed by a delete run are gone; restore them from the backup taken
before deletion was authorized. The run history is dropped with the tables.

### When to use it

Only when **all** of these are true:

1. Migration 8 was applied (`20261122090000` is listed under Remote).
2. A post-deployment check failed, or the cleanup must be withdrawn.
3. Deletion is switched off, no cleanup run is in progress and no file is
   claimed. Otherwise the script refuses and changes nothing.
4. The scheduled cleanup job is disabled (or not deployed).

### Step 1: Switch deletion off and keep the history (if needed)

```sql
select private.revoke_cleanup_deletion();
select * from private.cleanup_runs where status = 'running';             -- must be empty
select * from private.storage_cleanup_claims where status = 'claimed';  -- must be empty
-- Optional: export private.cleanup_runs and private.cleanup_candidates (Table Editor → Export).
```

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261122090000';
```
then paste the whole of `20261122090000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 8 removed;
purge_expired_records() is back to its Migration 2 form; Migrations 1-7
untouched.` Any error means nothing changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261122090000` under
Local only, and this should return no rows:

```sql
select tablename from pg_tables where schemaname = 'private' and tablename like 'cleanup%';
```

---

## `20261121090000_rollback.sql` (Migration 7)

Undoes `supabase/migrations/20261121090000_suspension_tuning.sql`: the five
`suspension_*` tables (with their triggers and policies), their functions,
the `suspension-photos` bucket and its three storage policies. Migration 7
changed nothing that existed before, so nothing has to be put back. Issues,
service records and everything else are untouched.

### When to use it

Only when **all** of these are true:

1. Migration 7 was applied (`20261121090000` is listed under Remote).
2. A post-deployment check failed.
3. Migration 8 is not applied (or was rolled back first; the script refuses
   otherwise).
4. No suspension setting, setup, revision, feedback, photo or
   suspension-photo file exists (Step 1), including Recently Deleted.
   Otherwise the script refuses and changes nothing: once people use
   suspension tuning, fix forward instead.
5. The app version that uses Migration 7 is not deployed (roll back in
   Vercel first).

### Step 1: Confirm nothing uses suspension tuning (read-only)

```sql
select (select count(*) from public.suspension_settings) as settings,
       (select count(*) from public.suspension_setups) as setups,
       (select count(*) from public.suspension_revisions) as revisions,
       (select count(*) from public.suspension_feedback) as feedback,
       (select count(*) from public.suspension_photos) as photos,
       (select count(*) from storage.objects where bucket_id = 'suspension-photos') as files;
```

All six must be `0`.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261121090000';
```
then paste the whole of `20261121090000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 7 removed;
Migrations 1-6 untouched.` Any error means nothing changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261121090000` under
Local only, and this should return no rows:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename like 'suspension%';
```

---

## `20261120090000_rollback.sql` (Migration 6)

Undoes `supabase/migrations/20261120090000_sled_issues.sql`: the
`sled_issues` and `sled_issue_photos` tables (with their triggers, policies
and functions), the `issue-photos` bucket and its three storage policies. It
puts back Migration 2's `restore_record_version` exactly. Service records,
readings and everything else are untouched.

### When to use it

Only when **all** of these are true:

1. Migration 6 was applied (`20261120090000` is listed under Remote).
2. A post-deployment check failed.
3. No issue, issue photo or issue-photo file exists (Step 1), including
   issues in Recently Deleted. Otherwise the script refuses and changes
   nothing: once people use issues, fix forward instead.
4. The app version that uses Migration 6 is not deployed (roll back in
   Vercel first): its pages read `sled_issues`.

### Step 1: Confirm nothing uses issues (read-only)

```sql
select (select count(*) from public.sled_issues) as issues,
       (select count(*) from public.sled_issue_photos) as photos,
       (select count(*) from storage.objects where bucket_id = 'issue-photos') as files;
```

All three must be `0`.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261120090000';
```
then paste the whole of `20261120090000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 6 removed;
Migrations 1-5 untouched.` Any error means nothing changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261120090000` under
Local only, and this should return no rows:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename like 'sled_issue%';
```

---

## `20261119090000_rollback.sql` (Migration 5)

Undoes `supabase/migrations/20261119090000_maintenance_board.sql`: the
`maintenance_board` view, `private.maintenance_warning_settings()`, the
"done before" date trigger, the season rule and the `season_due_month` /
`season_due_day` columns. It restores Migration 2's rule that every schedule
has at least one interval (`maintenance_plans_check`), exactly as it was.
**Schedules and service records are kept.**

### When to use it

Only when **all** of these are true:

1. Migration 5 was applied (`20261119090000` is listed under Remote).
2. A post-deployment check failed.
3. No schedule is seasonal and every schedule has an interval (Step 1).
4. The app version that uses Migration 5 is not deployed (roll back in
   Vercel first): its sled page reads `maintenance_board`.

### Step 1: Confirm nothing depends on Migration 5 (read-only)

```sql
select count(*) from public.maintenance_plans
where season_due_month is not null
   or num_nonnulls(interval_mi, interval_hours, interval_days) = 0;
```

The count must be `0` (removed schedules count too, because the restored
rule applies to every row). Otherwise the script refuses to run and changes
nothing: once people use these features, fix forward instead of rolling back.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261119090000';
```
then paste the whole of `20261119090000_rollback.sql` and run it once. The
expected result is a `Rollback complete` notice. Any error means nothing
changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261119090000` under
Local only, and this should return no rows:

```sql
select viewname from pg_views where schemaname = 'public' and viewname = 'maintenance_board';
```

---

## `20261118090000_rollback.sql` (Migration 4)

Undoes `supabase/migrations/20261118090000_service_records.sql`: the
`category` and `edited_at` columns, the service-date trigger,
`update_maintenance_entry()`, the item guard and `entry_created_by()`. It
restores what Migration 4 replaced to the exact Migration 2 definitions:
`save_maintenance_entry()` without a category, the item view and edit
policies, and Migration 1's guard on items. **Service records, items and
readings are kept.**

### When to use it

Only when **all** of these are true:

1. Migration 4 was applied (`20261118090000` is listed under Remote).
2. A post-deployment check failed.
3. No service record has a category.
4. The app version that uses Migration 4 is not deployed (roll back in
   Vercel first): it calls `update_maintenance_entry` and saves categories.

### Step 1: Confirm no categories are used (read-only)

```sql
select count(*) from public.maintenance_entries where category is not null;
```

The count must be `0`.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261118090000';
```
then paste the whole of `20261118090000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 4 removed;
Migrations 1-3 untouched.` Any error means nothing changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261118090000` under
Local only, and this should return no rows:

```sql
select column_name from information_schema.columns
where table_name = 'maintenance_entries' and column_name in ('category', 'edited_at');
```

---

## `20261117150000_rollback.sql` (Migration 3)

Undoes `supabase/migrations/20261117150000_sled_photos_and_create_sled.sql`:
`sleds.photo_path`, the `sled-photos` bucket and its four storage policies,
`create_sled()`, `private.photo_sled_id()`, the reading-date trigger
(`date_check` on `sled_readings`) and the migration-history entry.
**Sleds and readings created with `create_sled()` are kept**: they are
ordinary Migration 1 and 2 data.

### When to use it

Only when **all** of these are true:

1. Migration 3 was applied (`npx supabase migration list --remote` shows
   `20261117150000` under Remote).
2. A post-deployment check failed.
3. No sled has a photo **and** the `sled-photos` bucket is empty.
4. The app version that uses photos and `create_sled` is not deployed (or
   has been rolled back in Vercel first), since it needs these objects.

Never use it once photos exist. Fix forward instead. The script refuses in
that case anyway.

### Step 1: Confirm there are no photos (read-only)

```sql
select count(*) from public.sleds where photo_path is not null;
select count(*) from storage.objects where bucket_id = 'sled-photos';
```

Both counts must be `0`.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261117150000';
```
then paste the whole of `20261117150000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 3 removed;
Migrations 1 and 2 untouched.` Any error means nothing changed.

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261117150000` under
Local only. In SQL Editor, both of these should return no rows:

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'sleds' and column_name = 'photo_path';
select id from storage.buckets where id = 'sled-photos';
```

---

## `20261112210000_rollback.sql` (Migration 2)

Undoes `supabase/migrations/20261112210000_maintenance_logbook.sql`: the eight
logbook tables, two views, `save_maintenance_entry`, `restore_record_version`,
its helper functions and
the `engine_event` type. It restores the three Migration 1 objects Migration 2
changed (audit trigger, audit read policy and scope check, cleanup function) to
their exact Migration 1 definitions. **Migration 1 and its data are untouched.**

### When to use it

Only when **all** of these are true:

1. Migration 2 was applied (`npx supabase migration list --remote` shows
   `20261112210000` under Remote).
2. A post-deployment check failed.
3. All eight Migration 2 tables are empty **and** no audit history for them
   exists (in practice: nobody has used the logbook yet, and any test user
   has been deleted).
4. No later migration that depends on Migration 2 has been applied.

Never use it once real logbook data exists. Fix forward instead. The script
refuses in that case anyway.

### Step 1: Confirm there is no Migration 2 data (read-only)

```sql
select 'maintenance_tasks' as t, count(*) from public.maintenance_tasks
union all select 'maintenance_packages', count(*) from public.maintenance_packages
union all select 'maintenance_package_tasks', count(*) from public.maintenance_package_tasks
union all select 'sled_readings', count(*) from public.sled_readings
union all select 'maintenance_plans', count(*) from public.maintenance_plans
union all select 'maintenance_entries', count(*) from public.maintenance_entries
union all select 'maintenance_entry_tasks', count(*) from public.maintenance_entry_tasks
union all select 'maintenance_entry_parts', count(*) from public.maintenance_entry_parts
union all select 'audit history', count(*) from public.audit_log
  where library_owner_id is not null
     or table_name in ('maintenance_tasks','maintenance_packages','maintenance_package_tasks','sled_readings',
                       'maintenance_plans','maintenance_entries','maintenance_entry_tasks','maintenance_entry_parts');
```

Every count must be `0`. Deleting a test user under **Authentication →
Users** removes its data and history.

### Step 2: Run the rollback

In **SQL Editor**, first line:
```sql
set sledwerx.confirm_rollback = '20261112210000';
```
then paste the whole of `20261112210000_rollback.sql` and run it once. The
expected result is the notice `Rollback complete: Migration 2 removed;
Migration 1 restored.` Any error means nothing changed (see the message table
in the Migration 1 section; the same messages apply).

### Step 3: Verify (read-only)

`npx supabase migration list --remote` should show `20261112210000` under
Local only. In SQL Editor, this should return no rows:

```sql
select table_name from information_schema.tables
where table_schema = 'public' and (table_name like 'maintenance%' or table_name = 'sled_readings');
```

### Risks

Same safeguards as Migration 1: an explicit confirmation, data and history
checks, one transaction with a final verification, and no `CASCADE`.
Additionally, the restored Migration 1 objects are copied verbatim from the
Migration 1 file. Tests confirm the database afterwards matches a database
that only ever had Migration 1, object for object.

---

## `20261112180000_rollback.sql` (Migration 1)

Undoes `supabase/migrations/20261112180000_foundation_garages_sleds_sharing.sql`.
That means the profiles, preferences, garages, sleds, sharing, audit log, the
`private` helper schema, the sign-up trigger on `auth.users`, and the
migration-history entry.

### When to use it

Use it **only** when all of these are true:

1. Migration 1 was applied (`npx supabase migration list --remote` shows
   `20261112180000` under Remote).
2. A post-deployment check failed, for example: tables missing RLS, the
   sign-up trigger missing, a test sign-up not creating a profile and garage,
   or an Advisors security error.
3. **All seven SledWerx tables are empty** (see the check below). In practice,
   this means no real user has signed up yet.
4. Migration 2 (or any later migration that depends on these tables) has
   **not** been applied.

Do **not** use it:

- if `supabase db push` failed. A failed push is undone automatically as one
  transaction and leaves nothing to roll back. Check that with the read-only
  queries below instead.
- once real users exist. Fix forward with a new migration instead. The script
  refuses to run in that case anyway.

### Step 1: Confirm all seven tables are empty (read-only)

In the Supabase dashboard **SQL Editor**:

```sql
select 'profiles' as table_name, count(*) from public.profiles
union all select 'user_preferences', count(*) from public.user_preferences
union all select 'garages', count(*) from public.garages
union all select 'sleds', count(*) from public.sleds
union all select 'sled_invitations', count(*) from public.sled_invitations
union all select 'sled_shares', count(*) from public.sled_shares
union all select 'audit_log', count(*) from public.audit_log;
```

Every count must be `0`. If you created a test user during verification,
delete it first under **Authentication → Users**. Deleting it removes its
profile, preferences, garage and their history.

### Step 2: Run the rollback

1. Open **SQL Editor** and start a new query.
2. Type this confirmation as the **first line**:
   ```sql
   set sledwerx.confirm_rollback = '20261112180000';
   ```
3. Paste the entire contents of `20261112180000_rollback.sql` below it.
4. Run it once.

The expected result is the notice `Rollback complete: all Migration 1 objects
removed.`

If it stops with an error, **nothing has changed** and the whole script is
undone. Common messages:

| Message | Meaning |
|---|---|
| `Rollback not confirmed` | The `set sledwerx.confirm_rollback` line was missing or mistyped. |
| `Rollback aborted: public.<table> contains N row(s)` | Data exists. Do not roll back; fix forward. |
| `cannot drop ... because other objects depend on it` | Something created after Migration 1 depends on it, for example Migration 2. Stop and investigate. |
| `Rollback verification failed` | Some objects were not removed, so the rollback was undone. Stop and investigate. |

### Step 3: Verify (read-only)

```bash
npx supabase migration list --remote
```

`20261112180000` should show under Local only, with Remote empty. In SQL
Editor, each of these should return no rows:

```sql
select table_name from information_schema.tables where table_schema = 'public';
select schema_name from information_schema.schemata where schema_name = 'private';
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```

The database is now back to its state before Migration 1. After the cause is
fixed in a new pull request, `npx supabase db push --remote` applies the
corrected migration.

### Risks of rolling back

| Risk | Safeguard |
|---|---|
| Deleting user data | The script checks all seven tables and stops if any has a row. |
| Breaking sign-up | The trigger on `auth.users` is removed first, so sign-ups never call a function that no longer exists. Tested: sign-up works after the rollback. |
| A half-finished rollback | Everything runs in one transaction with a final check; any failure undoes the whole script. |
| Removing objects it should not | Each object is dropped by name with no `CASCADE`. If anything else depends on them, the rollback fails without changing anything. |
| Migration history out of step | The script removes the `20261112180000` history entry, so the CLI sees Migration 1 as not applied. Never drop these objects by hand without also removing that entry. |
| Running by accident | It requires the explicit confirmation setting and is never picked up by the CLI or CI. |

RLS policies, triggers and indexes are removed together with their tables
inside the same transaction, so no table is ever left without its security
rules. Supabase-managed schemas, Auth settings and default privileges are not
touched.

### Testing

CI tests every rollback script on every pull request against a throwaway
local Supabase database (Migration 6 first, then 5, 4, 3, 2 and 1). It checks that
each script:

- refuses to run without confirmation
- refuses to run while data exists
- removes every Migration 1 object when allowed
- leaves sign-up working
- leaves the database ready for Migration 1 to be re-applied

CI never connects to the live project.
