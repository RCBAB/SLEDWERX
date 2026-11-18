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
| 2 | Personal maintenance logbook: mileage and engine-hour history (with meter resets and engine replacements), user-created tasks and packages, maintenance schedules (miles, engine hours, days), logbook entries with tasks, parts and USD costs, version restore | Applied |
| 3 | Snowmobile photos (private Storage bucket, `sleds.photo_path`, storage policies that follow sled sharing), atomic `create_sled()`, and no future-dated readings | Applied |
| 4 | Service records: categories, `edited_at`, no future service dates, `save_maintenance_entry` with a category, atomic `update_maintenance_entry()`, items that follow their record (mechanics can fix their own records) | Applied |
| 5 | Maintenance Board: a calculated `maintenance_board` view (last done, next due, status) for mileage, **engine-hour**, calendar and once-a-season schedules; plans without an interval; no future "done before" dates. Replaces the planned stored reminders | Applied |
| 6 | Issues and repairs; installed parts and modifications with install/removal history (can link to logbook parts); shopping list | Planned |
| 7 | Suspension setups (standard + manufacturer-specific fields), revisions, tuning journal, test sessions; manual ride logs | Planned |
| 8 | Attachments: private Storage bucket, file metadata, size/type validation, storage RLS, cleanup with Recently Deleted and account deletion | Planned |
| 9 | Community library: opt-in rider profiles, published setup copies, reviews, moderation | Planned |
| 10 | Offline sync: change feed, conflict records and resolution | Planned |

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

### Saving an entry: `save_maintenance_entry`

The app should save logbook entries with one call to
`save_maintenance_entry`, which saves the reading (optional), the entry, its
checklist tasks and its parts **in one transaction**. If anything fails
(validation, a reading lower than the history, a task the user may not use,
missing permission), **nothing is saved**.

```ts
const { data, error } = await supabase.rpc("save_maintenance_entry", {
  p_idempotency_key: key,            // crypto.randomUUID(), generated once per new entry
  p_sled_id: sledId,
  p_performed_on: "2026-08-01",
  p_title: "Chaincase service",
  p_done_by: "Me",                   // optional
  p_notes: null,                     // optional
  p_labor_cost: 30,                  // optional, USD
  p_other_cost: null,                // optional, USD
  p_completed: true,                 // false = open checklist
  p_reading: { odometer_mi: 1500, engine_hours: 60 },  // optional; also odometer_reset,
                                     // hour_meter_reset, engine_event, note, read_on
  p_tasks: [{ task_id }, { task_name: "Adjusted track tension", note: "Two turns" }],
  p_parts: [{ name: "Chaincase oil", part_number: "CC-1", quantity: 2, unit_cost: 11.25 }],
});
// data: { entry_id, reading_id, duplicate }
```

- **Permissions are not bypassed.** The function runs with the caller's own
  permissions (`SECURITY INVOKER`). Every row goes through the same RLS
  policies, guards, reading validation, versioning and audit triggers as a
  direct insert.
- **Duplicates.** Generate the idempotency key once per new entry and reuse
  it for retries (for example after a timeout or a double tap). A repeat
  returns the existing entry with `duplicate: true` and saves nothing. The key
  is stored as `maintenance_entries.client_request_id`, cannot be changed, and
  a unique index on `(created_by, client_request_id)` blocks duplicates even
  when two submissions arrive at the same moment. Keys are per user. Reusing
  a key for a different sled is rejected.
- **Limits.** At most 100 tasks and 100 parts per entry. Each task needs a
  `task_id` or a `task_name`.

Views (callers' RLS applies): `sled_reading_history` adds `total_mi` and
`total_engine_hours`. These are calculated, never stored, and continue
across meter resets. `maintenance_entry_costs` gives labor + other + parts
totals.

**Rules**
- Readings on the same meter never go down. A lower value must be recorded as
  a reset. A back-dated reading must fit the existing history. Reading
  changes are serialized per sled (a transaction-level advisory lock), so two
  simultaneous saves cannot each pass the check and together break it.
- Adding tasks or parts to an entry counts as changing that entry. Mechanics
  can add them only to entries they created; owners and editors can add them
  to any entry on the sled.
- An entry cannot be restored while its reading is in Recently Deleted.
  Restore the reading first.
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
  The Maintenance Board (Migration 5) supports hours as well as miles and days.

## Snowmobile photos and `create_sled` (Migration 3)

`supabase/migrations/20261117150000_sled_photos_and_create_sled.sql`. Additive
only; Migrations 1 and 2 are unchanged.

- **`sleds.photo_path`**: the sled's photo in the private `sled-photos`
  bucket, named `<sled id>/<random uuid>.jpg` (or `.webp`). A check
  constraint requires the first segment to be the sled's own id, so a sled
  can never point at another sled's photo. Changes are audited like any
  other sled field.
- **Bucket `sled-photos`**: private, 5 MB per file, JPEG and WebP only. The
  app resizes photos in the browser (longest side 1600 px, re-encoded as
  JPEG, which also strips EXIF data such as GPS) and uploads them with the
  user's own session. Photos are shown through signed URLs valid for one
  hour.
- **Storage policies** (signed-in users only) reuse the sled permissions:

  | Action on a photo | Allowed for |
  |---|---|
  | View (and create signed URLs) | Anyone who can view the sled: owner, editor, mechanic, viewer |
  | Upload, replace, remove | Owner and editors (`edit_sled`), and not while the sled is in Recently Deleted |

  `private.photo_sled_id(name)` reads the sled id from an object name and
  returns null for anything that isn't a valid photo path, so such objects
  match no policy. Revoking or suspending a share removes photo access
  immediately.
- **`create_sled(p_make, p_model, p_model_year, p_odometer_mi, p_engine_hours,
  p_nickname, p_vin, p_read_on, p_garage_id)`** creates a sled and its first
  odometer/engine-hour reading in one transaction: both or neither. It runs
  as the caller (`SECURITY INVOKER`), so RLS and every existing trigger
  (ownership, audit, reading checks) apply unchanged. It defaults to the
  caller's oldest garage. The odometer is required (0 allowed); engine hours
  are optional; the date defaults to today and may be at most one day ahead
  (time zones ahead of UTC).
- **No future-dated readings** (`date_check` trigger on `sled_readings`):
  every write path (Update mileage, Fix last reading, `create_sled`,
  `save_maintenance_entry`, direct API calls) refuses a `read_on` more than
  one day past the database's UTC date. Migration 2 had no such rule, and a
  far-future reading would become the "latest" one and block every later
  real reading. The one day of slack covers time zones ahead of UTC; the app
  additionally checks against the user's own local date (browser time zone),
  so in practice no reading is dated after the user's today. Only new dates
  are checked: editing other fields of an existing reading is unaffected.
- **Reading corrections** in the app ("Fix last reading") use Migration 2's
  existing rules: owners and editors can correct or remove any reading,
  mechanics can correct only readings they added and cannot remove them.
  Removal is a soft delete. Every correction keeps the old values in the
  audit history and uses the row version (conflicts are refused).
- **Known limitation:** when a sled is permanently deleted (after 30 days in
  Recently Deleted, or by `permanently_delete_sled`), its photo file stays in
  the bucket until the Phase 7 cleanup, which removes files through the
  Storage API. Such files are unreachable: no sled matches their path.

## Service records (Migration 4)

`supabase/migrations/20261118090000_service_records.sql`. No new tables:
Phase 3 builds on Migration 2's logbook. Migrations 1-3 are unchanged.

- **Category** (`maintenance_entries.category`, optional): engine, drivetrain,
  track_suspension, fuel_oil, cooling, electrical, brakes, steering_skis,
  body_accessories, inspection, other.
- **No future service dates**: `performed_on` at most one day past the
  database's UTC date (same rule as readings).
- **`save_maintenance_entry(..., p_category)`**: Migration 2's function with a
  category added at the end. The old signature is dropped (the app is its
  only caller); everything else is identical.
- **`update_maintenance_entry(p_entry_id, p_version, ...)`** edits a whole
  record in one transaction, as the caller (RLS, guards, audit):
  - the record is version-checked; every edit sets `edited_at`, so the
    version changes even when only items or mileage changed;
  - the linked reading is **corrected in place** and follows the service
    date, so mileage history never gains stray readings;
  - tasks and parts with an id are updated, without an id added, and missing
    ones soft-deleted;
  - `p_reading => null` unlinks and soft-deletes the reading (owners and
    editors only).
- **Historical services**: a service's mileage is an ordinary reading dated
  with the service date. Readings are validated in date order (then entry
  time), so a 1,200 mi service from last season fits before today's 2,000
  mi reading, the current mileage stays 2,000, and a value that doesn't fit
  its neighbours is refused. Readings on the same day are ordered by when
  they were entered (accepted limitation).
- **Items follow their record**: tasks and parts of a service record can be
  edited, removed (soft delete), seen when removed and restored by anyone
  who may modify the record: owners, editors, and the mechanic who created
  it. The item guard is `private.tg_entry_items_guard()`; the view and edit
  policies use `private.entry_created_by(entry_id)`. Deleting a record, and
  deleting readings, keep Migration 1's rule (owners and editors only).

| Action on a service record | Owner / editor | Mechanic (own record) | Mechanic (other's) | Viewer |
|---|---|---|---|---|
| View, including costs | ✅ | ✅ | ✅ | ✅ |
| Log a new service | ✅ | ✅ | — | ❌ |
| Edit details, tasks, parts, costs | ✅ | ✅ | ❌ | ❌ |
| Correct mileage / hours | ✅ | ✅ | ❌ | ❌ |
| Remove the mileage (reading) | ✅ | ❌ | ❌ | ❌ |
| Delete the record | ✅ | ❌ | ❌ | ❌ |

## Maintenance Board (Migration 5)

`supabase/migrations/20261119090000_maintenance_board.sql`. No new tables:
the board is **calculated** from the schedules (`maintenance_plans`) and the
service history every time it is read, so there is nothing to keep in sync
and no stored reminders. Editing, deleting or backdating a service updates the
board automatically. Migrations 1-4 are unchanged.

- **Schema changes to `maintenance_plans`:**
  - `season_due_month`, `season_due_day` (both or neither): "once a season,
    due by Nov 1". Seasons run July to June. Feb 29 is accepted and treated
    as Feb 28 in years without it.
  - Migration 2's rule "at least one interval" (`maintenance_plans_check`) is
    replaced by `maintenance_plans_season_check`: a plan may now have no
    interval at all, which keeps the task on the board as "Not scheduled".
  - `last_done_on` (the "done before SledWerx" starting point) cannot be in
    the future (trigger `date_check`, same one-day margin as readings).
- **`public.maintenance_board`** (view, `security_invoker = true`, so the
  caller's RLS applies; `select` for `authenticated` only). One row per active
  plan with: last done (date, mileage, hours and whether it came from a
  service or the "done before" starting point), next due (date, mileage,
  hours), remaining, the warning window used, `status`, `status_rank` and
  `urgency`.
- **What counts as done**: a task linked to the board task (`task_id`) and
  ticked done, on a completed, non-deleted service record. The newest by
  service date wins; a "done before SledWerx" date counts only if no service
  is newer. Free-text tasks with the same name do not count.
- **Mileage is never estimated.** A completion's mileage and hours are the
  service's own reading (lifetime totals, so meter resets and engine
  replacements are handled). A service without mileage shows "Mileage
  unknown" (`mileage_unknown = true`); a nearby reading is never used.
- **Status** (`status_rank` sorts the board; `urgency`, the share of the
  interval left on the closest dimension, sorts within a rank):

  | Status | Colour | Rank |
  |---|---|---|
  | `overdue` | red | 0 |
  | `no_record` (scheduled, never done, no starting point) | yellow, first | 1 |
  | `upcoming` (inside the warning window) | yellow | 1 |
  | `mileage_unknown` (nothing else to measure) | yellow | 1 |
  | `good` | green | 2 |
  | `unscheduled`, `paused` | grey | 3 |

- **Warning window**: 10% of the interval, at least 50 mi, 2 hrs or 7 days,
  and at most 30 days. Seasonal items warn 30 days before their date. The
  values come from `private.maintenance_warning_settings(user_id)`, so
  per-user settings can be added later by changing only that function (and a
  settings table) without changing the view or the app.
- **Mark Done** is an ordinary service record created with
  `save_maintenance_entry` (Migration 4). Completing several tasks, or a
  package, creates one record. All the usual rules apply: RLS, audit,
  idempotency key, no future dates, mileage validated against the history.

| Action on the board | Owner / editor | Mechanic | Viewer |
|---|---|---|---|
| See the board | ✅ | ✅ | ✅ |
| Mark tasks done (creates a service record) | ✅ | ✅ | ❌ |
| Add, schedule, pause, remove | ✅ | ❌ | ❌ |

## Garage Board (Phase 5, no migration)

The Garage Board (`/garage/board`) shows every sled the user can see and its
maintenance, like a dry-erase board on the garage wall. It adds **no tables,
views, functions or policies**:

- It reads `maintenance_board` (Migration 5) for all visible sleds in one
  query (`sled_id in (...)`). The view is `security_invoker`, so RLS returns
  exactly the sleds the user owns or that are shared with them.
- Done and Complete package call the same `completeTasks` action as the
  sled's own Maintenance Board, which saves an ordinary service record with
  `save_maintenance_entry`. There is no second maintenance system.
- Garage Board settings are kept in `user_preferences.garage_mode`
  (Migration 1), private to the user (RLS). The app merges each change into
  the existing object:
  - `layout`: `"cards"` (default) or `"compact"`;
  - `keyboard`: the Wall Display on-screen keyboard, `true` (default) or
    `false` (Phase 5.1).

Tests: `supabase/tests/database/007_garage_board.test.sql` (multi-sled reads
follow sharing, a mechanic's completion updates the shared sled's board, the
preference is private).

## Mileage and engine-hour updates (Phase 5.1, no migration)

"Update mileage / hours" (sled page and Garage Board) inserts an ordinary
`sled_readings` row through the `updateMeters` server action, as the user, so
RLS, the audit log and Migration 2's reading rules all apply. Earlier readings
are never changed.

- A value equal to the current reading is treated as unchanged and not saved
  again, so an hours-only update stores only hours (`odometer_mi` null). If
  nothing changed, nothing is saved.
- A normal update can't be lower than the current reading. The action says so
  next to the field; the rule itself is the database's reading-order trigger
  (`private.tg_sled_readings_order`), which checks each meter on its own,
  across the whole history (backdated readings must fit between their
  neighbours) and for every caller.
- A lower value is only possible as a meter reset or replacement
  (`odometer_reset` / `hour_meter_reset`, Migration 2), which the dialog
  requires the user to confirm explicitly. Lifetime totals carry on.
- Done and Complete package can save optional notes, in the service record's
  existing `notes` field (`save_maintenance_entry`'s `p_notes`).

Tests: `supabase/tests/database/008_meter_updates.test.sql`.

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
Storage files (sled photos, and later attachments) are removed by the
Storage cleanup (Phase 7 / migration 8), which must run before the auth user
is deleted.

## Testing

```bash
npm run db:start   # local Supabase stack (requires Docker)
npm run db:test    # pgTAP tests in supabase/tests
npm run db:stop
```

CI runs the same tests on every pull request against a throwaway local
Supabase stack:
- the pgTAP tests in `supabase/tests/database/`, one file per migration
  (plus `007_garage_board` and `008_meter_updates`, which test Phases 5 and
  5.1 against existing objects)
- `scripts/db-api-smoke-test.mjs`, which signs up real users through Supabase
  Auth and exercises sharing, RLS, the maintenance logbook and conflict
  detection through the REST API with `supabase-js`
- the rollback tests, newest first: 5, 4, 3, 2, 1. After each rollback, the
  tests of the remaining migrations run again on the result

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
