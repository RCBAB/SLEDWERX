# SledWerx database

SledWerx uses Supabase Postgres. The schema is defined by version-controlled
SQL migrations in `supabase/migrations/` and tested with pgTAP tests in
`supabase/tests/`. Migrations are applied to the live project **manually**,
after review and approval (see [Applying a migration](#applying-a-migration)).

## Migration plan

The database is built in small, reviewable stages. Each later stage depends on
the helpers created in stage 1.

| # | Migration | Status |
|---|---|---|
| 1 | Foundation: profiles, preferences, garages, sleds, per-sled sharing, audit log, Recently Deleted, row versioning | Applied |
| 2 | Personal maintenance logbook: mileage and engine-hour history (with meter resets and engine replacements), user-created tasks and packages, maintenance schedules (miles, engine hours, days), logbook entries with tasks, parts and USD costs, version restore | This PR |
| 3 | Stored reminders (upcoming / due / overdue, user thresholds) for mileage, **engine-hour** and calendar intervals, recalculated on maintenance, reading and interval changes | Planned |
| 4 | Issues and repairs; installed parts and modifications with install/removal history (can link to logbook parts); shopping list | Planned |
| 5 | Suspension setups (standard + manufacturer-specific fields), revisions, tuning journal, test sessions; manual ride logs | Planned |
| 6 | Attachments: private Storage bucket, file metadata, size/type validation, storage RLS, cleanup with Recently Deleted and account deletion | Planned |
| 7 | Community library: opt-in rider profiles, published setup copies, reviews, moderation | Planned |
| 8 | Offline sync: change feed, conflict records and resolution | Planned |

## Ownership model

- Each user has one or more **garages**. A default garage is created at sign-up.
  Garages are private to their owner and never visible to anyone else.
- Each **sled** (snowmobile) belongs to one garage. Its owner is the garage
  owner (`sleds.owner_id`, kept in sync by trigger).
- Sleds are shared **individually** through `sled_shares`. Sharing one sled
  gives no access to the garage or to any other sled.
- Every record in later modules carries a `sled_id`, and its RLS policies call
  `private.has_sled_permission(sled_id, '<permission>')`. See
  [Building a record table](#building-a-record-table-for-a-later-module).
- **Ownership transfer** is deferred until after 1.0. The schema is ready for
  it: ownership is a single column (`sleds.owner_id`) derived from the garage,
  history is keyed by sled, and shares are per sled. A later migration will
  add a transfer function that moves the sled into the recipient's garage.
  Today the guard trigger refuses any change to `owner_id`.

## Roles and permissions

The owner role is implicit (garage owner). Shares grant `editor`, `mechanic`,
or `viewer`. `private.has_sled_permission()` is the single source of truth:

| Permission | Owner | Editor | Mechanic | Viewer |
|---|:-:|:-:|:-:|:-:|
| `view` – see the sled and its records | ✓ | ✓ | ✓ | ✓ |
| `edit_sled` – edit sled details | ✓ | ✓ | | |
| `add_records` – add maintenance/service records and notes | ✓ | ✓ | ✓ | |
| `edit_records` – edit any existing record | ✓ | ✓ | | |
| edit records **they created** – `can_modify_sled_record(sled_id, created_by)` | ✓ | ✓ | ✓ | |
| `soft_delete_records` / `restore_records` – move records to Recently Deleted and restore them | ✓ | ✓ | | |
| `manage_sled` – delete/restore/permanently delete the sled, sharing, ownership | ✓ | | | |

While a sled is in Recently Deleted, only `view` and `manage_sled` apply.

- **Owners** can delete and restore whole sleds and individual records.
- **Editors** (Decision 2, option A) can delete and restore individual
  records, but cannot move a whole sled to Recently Deleted, restore it,
  permanently delete it, or manage sharing.
- **Mechanics** (Decision 3) can create records and edit the records they
  created (`created_by` is set by the database and cannot be changed). They
  cannot delete or restore records (even their own), edit other people's
  records, delete or restore the sled, manage sharing, or transfer ownership.
- **Viewers** are read-only: no edits, deletions or restores.
- Every record deletion is a soft delete into Recently Deleted, restorable for
  30 days and audited (who deleted or restored it, and when).

Shares and invitations can only be changed through these functions, so
nobody can grant themselves access or raise their own role:

| Function | Who |
|---|---|
| `create_sled_invitation(sled_id, email, role, expires_in_days)` | Owner. Returns a one-time token; only its SHA-256 hash is stored. |
| `revoke_sled_invitation(invitation_id)` | Owner |
| `accept_sled_invitation(token)` | The invited person. Their account email must match and be confirmed. |
| `update_sled_share_role(share_id, role)` | Owner |
| `revoke_sled_share(share_id)` | Owner, or the shared user (to leave) |
| `reactivate_sled_share(share_id)` | Owner, after restoring a sled (see below) |
| `permanently_delete_sled(sled_id)` | Owner, only from Recently Deleted |

**Invitation emails** (Decision 7): 1.0 sends invitations by email and also
offers a copyable link. Email delivery belongs in a server-side route (or Edge
Function) that calls `create_sled_invitation` as the signed-in owner and sends
the returned token through a transactional email provider. The provider's API
key lives only in server environment variables, never in browser code. The
database design does not change: the token is returned once and only its hash
is stored. The provider is chosen when the sharing interface is built.

### Deleted sleds and sharing (Decision 6)

- Moving a sled to Recently Deleted immediately **suspends** every active share
  (`sled_shares.suspended_at`) and revokes pending invitations. Shared users
  lose all access through the API at once.
- Suspended shares are kept during the 30-day recovery period, so the owner
  can see who had access and with which role. Each shared user can see that
  their own share is suspended, so their devices can clear cached data.
- Restoring the sled does **not** reactivate anyone. The owner chooses who
  regains access with `reactivate_sled_share`, and can still change roles or
  revoke suspended shares. Shared users cannot reactivate themselves.
- If the sled is permanently deleted, its shares are deleted with it.

## Recently Deleted

- User-facing records have `deleted_at`/`deleted_by`. Setting `deleted_at`
  moves a record to Recently Deleted; clearing it restores it.
- Restores are allowed for 30 days (`private.recovery_window()`), and the
  database refuses them afterwards.
- Deleted sleds are hidden from shared users and are read-only until restored:
  `has_sled_permission` allows only `view` and `manage_sled` on them, so later
  modules cannot add or change their records.
- A sled cannot be restored into a garage that is itself in Recently Deleted.
  Restore the garage first, or restore the sled into another garage.
- A garage row can never be removed while it still has sleds (no cascade), so
  a mistaken garage delete cannot wipe out sleds and their history.
- `private.purge_expired_records()` permanently removes records past 30 days,
  resolved invitations (which contain email addresses), and revoked shares
  older than 30 days. It is **not scheduled**. Run it manually from the SQL
  editor, or schedule it later (for example with `pg_cron`) once approved.

## Audit history

- `audit_log` records every insert and update (including deletes and restores)
  on garages, sleds, shares and invitations: who, when, which fields, and the
  previous and new values. Invitation token hashes are never recorded.
- It is written only by triggers. The API cannot insert, update or delete
  audit rows.
- Each row has a `category`, set by the table's trigger, which controls who
  can read it (Decision 5):

  | Category | Tables | Owner | Editor | Mechanic | Viewer |
  |---|---|:-:|:-:|:-:|:-:|
  | `garage` | garages | ✓ | | | |
  | `sharing` | invitations, shares (emails, user ids) | ✓ | | | |
  | `sled` | sleds | ✓ | ✓ | | |
  | `maintenance` | maintenance tables (migration 2) | ✓ | ✓ | own records | |

  "Own records" means rows whose `record_created_by` is the mechanic. This is
  copied from the record's `created_by`, which nobody can change. Editors and
  mechanics see history only while their share is active and the sled is not
  in Recently Deleted.
- **Personal library rows** (library tasks, packages and their items) belong
  to no sled. They are stored with `library_owner_id` and only that user can
  read them. Shared users never see the owner's library history.
- Retention: a sled's history is removed when the sled is permanently deleted
  or the owner's account is deleted. A user's library history is removed when
  their account is deleted.
- **Restoring a previous version** (Decision 6):
  `restore_record_version(audit_id)` puts back the values a reading,
  schedule, entry, entry task or entry part had before the change recorded in
  that audit row. Only people allowed to edit the record can use it (mechanics:
  their own records), deleted records must be restored first, and the restore
  is itself an audited update.

## Building a record table for a later module

Every table that stores records for a sled (service records, issues, parts,
setups, ride logs, ...) must follow this pattern, which
`supabase/tests/database/001_foundation.test.sql` exercises on a stand-in
table:

1. Columns: `id uuid`, `sled_id uuid not null references public.sleds (id) on
   delete cascade`, `deleted_at`, `deleted_by`, `created_at`, `created_by`,
   `updated_at`, `updated_by`, `version`.
2. Triggers:
   - `before insert or update`: `private.tg_sled_record_guard()`. Requires
     `add_records` to create and `can_modify_sled_record` to edit. Allows
     soft delete and restore only to owners and editors, within 30 days. Stops
     records moving to another sled, and makes deleted records read-only until
     restored.
   - `before insert or update`: `private.tg_stamp()`. Fills in the metadata
     and enforces the version check.
   - `after insert or update`: `private.tg_audit('maintenance')`, or another
     category if one is added.
3. Revoke all privileges from `anon` and `authenticated`, then grant
   `select, insert, update` to `authenticated`. Never grant `delete`.
4. RLS policies:
   ```sql
   -- select
   using (private.has_sled_permission(sled_id, 'view')
          and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')))
   -- insert
   with check (private.has_sled_permission(sled_id, 'add_records'))
   -- update
   using (private.can_modify_sled_record(sled_id, created_by))
   with check (private.can_modify_sled_record(sled_id, created_by))
   ```

## Offline sync contract

- Every table has a `uuid` primary key that the device may generate, so records
  can be created offline.
- `version` starts at 1 and is incremented by the database whenever a row
  actually changes. Updates that change nothing keep the version, so they
  never create false conflicts. `updated_at` is set by the server.
- **Conflict detection:** every update must include the version the device
  last saw, for example `.update({ nickname, version: knownVersion })`. If the
  row has changed since, the database rejects the update with error code
  `PT409` (HTTP 409 through the API). The device then keeps both versions and
  asks the user; conflict records and resolution arrive in migration 8.
  Nothing is overwritten silently. An update that omits `version` cannot be
  checked, so the app's data layer must always send it.
- **Retries:** if a device's update succeeded but the response was lost, the
  retry gets `PT409`. The device should re-read the row: if it already matches
  the local edit, there is no conflict.
- **Revocation and deletion:** a revoked share stays visible to the affected
  user (with `revoked_at`) for 30 days. A suspended share stays visible (with
  `suspended_at`) until the owner reactivates or revokes it. On every sync, devices should also
  fetch the list of sled ids they can currently read (`select id from sleds`)
  and delete cached data for any sled not in it. This covers revoked access
  and sleds moved to Recently Deleted. The server refuses all access
  immediately either way.
- **Long offline periods:** permanently removed records leave no trace, so a
  device that has not synced for more than 30 days must do a full resync
  rather than an incremental one.
- **Incremental pulls:** `updated_at` is set when a transaction starts, so a
  slow transaction can commit a row with an `updated_at` older than a cursor a
  device has already used. Migration 8 must use an overlap window or a
  commit-ordered change feed, not a plain `updated_at > cursor` query.
- Indexes on `(owner_id, updated_at)` and `(user_id, updated_at)` support
  "changes since" queries.

## Maintenance logbook (Migration 2)

SledWerx is a personal maintenance book for owners of one or more sleds, not
repair-shop software: no work orders, assignments or shop scheduling.

| Table | Belongs to | Purpose |
|---|---|---|
| `sled_readings` | sled | Odometer miles and/or engine hours on a date. `odometer_reset` / `hour_meter_reset` mark a replaced or reset meter; `engine_event` marks an engine replacement or rebuild. |
| `maintenance_tasks` | user library **or** one sled | User-created tasks. Library tasks are reusable across the user's sleds; sled tasks let owners and editors add a task to one sled without touching the owner's library. There are **no built-in tasks or preset intervals**. |
| `maintenance_packages`, `maintenance_package_tasks` | user library | Reusable task lists. Private to their owner. |
| `maintenance_plans` | sled | The owner's interval for a task: **miles, engine hours and/or days**, any combination (at least one). Optional "last done" starting point. Owners and editors only. |
| `maintenance_entries` | sled | Logbook entry: date, title, done by (free text), notes, labor and other cost, completed (unticked = open checklist), and the reading logged with it. |
| `maintenance_entry_tasks` | entry | What was done: a task or free text. The task name is copied so history survives renames and deletions. |
| `maintenance_entry_parts` | entry | Parts used: name, brand, part number, supplier, quantity, unit cost. |

Views (callers' RLS applies): `sled_reading_history` adds `total_mi` and
`total_engine_hours`. These are calculated, never stored, and continue
across meter resets. `maintenance_entry_costs` gives labor + other + parts
totals.

**Rules**
- Readings on the same meter never go down. A lower value must be recorded as
  a reset. A back-dated reading must fit the existing history.
- Deleting an entry sends its tasks and parts to Recently Deleted with it
  (restoring brings them back) but **never deletes its reading**. A reading
  used by an active entry cannot be deleted on its own.
- Deleting a task that is in use is allowed (the app shows a warning first).
  The task's active schedules and package memberships are deleted with it
  atomically, and restoring the task within 30 days restores them. Completed
  maintenance history keeps the task name. Schedules on a sled that is itself
  in Recently Deleted stay frozen with that sled.
- Shared users see the sled's tasks plus only those library tasks of the
  owner that are used on the shared sled. The rest of the owner's library and
  all packages stay private. Mechanics log work with existing tasks or free
  text, and cannot create tasks or schedules.
- Costs are USD. There is no currency setting.
- Engine hours: Decision 1 of Migration 2 approves engine-hour intervals.
  This replaces the original 1.0 note "no hour-based service reminders".
  Reminders (Migration 3) must support hours as well as miles and days.

## Units

1.0 uses US units, stored in the unit named by the column: `*_mi` (miles),
`*_in` (inches), `*_f` (°F), and engine hours as shown on the hour meter.
Values are stored once in that unit and never converted on write. A future
metric display converts on read. Costs are USD.

## Account deletion

Deleting a user through the Supabase Auth admin API (server side, never from
the browser) cascades through `auth.users` foreign keys and removes their
profile, preferences, garages, sleds, shares, invitations for their sleds, and
those sleds' audit history. Actor columns (`created_by`, `updated_by`, etc.)
are plain ids without foreign keys, so deletion never rewrites other owners'
records. Once the account is gone, those ids no longer identify anyone.
Storage files are removed by the attachments cleanup (migration 6), which must
run before the auth user is deleted.

## Testing

```bash
npm run db:start   # local Supabase stack (requires Docker)
npm run db:test    # pgTAP tests in supabase/tests
npm run db:stop
```

CI runs the same tests on every pull request against a throwaway local
Supabase stack:
- the pgTAP tests in `supabase/tests/database/`, one file per migration
- `scripts/db-api-smoke-test.mjs`, which signs up real users through Supabase
  Auth and exercises sharing, RLS, the maintenance logbook and conflict
  detection through the REST API with `supabase-js`
- the rollback tests: Migration 2 is rolled back first, then the Migration 1
  tests run on the resulting state, then Migration 1's rollback is tested

CI never connects to the live project.

## Applying a migration

Only after the pull request has been reviewed and approved:

1. In the Supabase dashboard, under **Authentication → Sign In / Providers →
   Email**, check that **Confirm email** and **Secure email change** are both
   **on**. Sharing invitations are matched to confirmed email addresses. With
   either setting off, someone could claim another person's address and
   accept an invitation meant for them.
2. From a local checkout of the approved branch (or `main` after merge):

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push --dry-run
   npx supabase db push
   ```

   `link` asks for the database password (from the Supabase dashboard). It is
   stored only on your computer. `--dry-run` lists the migrations that would
   be applied, without changing anything.
3. Verify in the dashboard: **Table Editor** shows the new tables with RLS
   enabled, and **Advisors → Security** reports no issues.

### If something goes wrong

- If `db push` fails, the migration is undone automatically as one
  transaction. Nothing needs rolling back; re-run the read-only checks and
  investigate.
- If Migration 1 was applied but a post-deployment check fails **and no real
  users exist yet**, follow [`supabase/rollback/README.md`](../supabase/rollback/README.md).
  The rollback script requires explicit confirmation, refuses to run if any of
  the seven tables has data, and is never run by the CLI or CI.
- Once real users exist, never roll back. Fix forward with a new migration.
