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
| 1 | Foundation: profiles, preferences, garages, sleds, per-sled sharing, audit log, Recently Deleted, row versioning | This PR |
| 2 | Odometer history (including odometer/engine replacements), maintenance task catalog (built-in + custom), schedules, service sessions/packages, checklists, completed service records with versioned corrections | Planned |
| 3 | Stored reminders (upcoming / due / overdue, user thresholds), recalculated on service, odometer and interval changes | Planned |
| 4 | Issues and repairs; parts and modifications with install/removal history; shopping list | Planned |
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
  `private.has_sled_permission(sled_id, '<permission>')`.

## Roles and permissions

The owner role is implicit (garage owner). Shares grant `editor`, `mechanic`,
or `viewer`. `private.has_sled_permission()` is the single source of truth:

| Permission | Owner | Editor | Mechanic | Viewer |
|---|:-:|:-:|:-:|:-:|
| `view` – see the sled and its records | ✓ | ✓ | ✓ | ✓ |
| `edit_sled` – edit sled details | ✓ | ✓ | | |
| `add_records` – add maintenance/service records and notes | ✓ | ✓ | ✓ | |
| `edit_records` – edit existing records | ✓ | ✓ | | |
| `soft_delete_records` / `restore_records` – Recently Deleted | ✓ | ✓ | | |
| `manage_sled` – delete/restore/permanently delete the sled, sharing, ownership | ✓ | | | |

Shares and invitations can only be changed through these functions, so
nobody can grant themselves access or raise their own role:

| Function | Who |
|---|---|
| `create_sled_invitation(sled_id, email, role, expires_in_days)` | Owner. Returns a one-time token; only its SHA-256 hash is stored. |
| `revoke_sled_invitation(invitation_id)` | Owner |
| `accept_sled_invitation(token)` | The invited person. Their account email must match and be confirmed. |
| `update_sled_share_role(share_id, role)` | Owner |
| `revoke_sled_share(share_id)` | Owner, or the shared user (to leave) |
| `permanently_delete_sled(sled_id)` | Owner, only from Recently Deleted |

Email delivery of invitations is not part of 1.0: the app shows the invitation
link for the owner to send.

## Recently Deleted

- User-facing records have `deleted_at`/`deleted_by`. Setting `deleted_at`
  moves a record to Recently Deleted; clearing it restores it.
- Restores are allowed for 30 days (`private.recovery_window()`), and the
  database refuses them afterwards.
- Deleted sleds are hidden from shared users and cannot be edited until restored.
- `private.purge_expired_records()` permanently removes records past 30 days,
  resolved invitations (which contain email addresses), and revoked shares
  older than 30 days. It is **not scheduled**. Run it manually from the SQL
  editor, or schedule it later (for example with `pg_cron`) once approved.

## Audit history

- `audit_log` records every insert and update (including deletes and restores)
  on garages, sleds, shares and invitations: who, when, which fields, and the
  previous and new values. Invitation token hashes are never recorded.
- It is written only by triggers. The API cannot insert, update or delete
  audit rows. Owners can read the history of their own sleds and garages.
- Retention: a sled's history is removed when the sled is permanently deleted
  or the owner's account is deleted. Maintenance version history and restore
  (Decision 6) build on this table in migration 2.

## Offline sync contract

- Every table has a `uuid` primary key that the device may generate, so records
  can be created offline.
- `version` starts at 1 and is incremented by the database on every update.
  `updated_at` is set by the server.
- **Conflict detection:** devices update with
  `.eq('id', id).eq('version', knownVersion)`. If zero rows are updated, the
  record changed elsewhere: the device keeps both versions and asks the user
  (conflict records and resolution arrive in migration 8). Nothing is
  overwritten silently.
- **Revocation:** a revoked share stays visible to the affected user (with
  `revoked_at`) for 30 days so their devices can delete cached data for that
  sled. The server refuses all access immediately.
- Indexes on `(owner_id, updated_at)` and `(user_id, updated_at)` support
  "changes since" queries.

## Units

1.0 uses US units, stored in the unit named by the column: `*_mi` (miles),
`*_in` (inches), `*_f` (°F). Values are stored once in that unit and never
converted on write. A future metric display converts on read.

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
Supabase database. CI never connects to the live project.

## Applying a migration

Only after the pull request has been reviewed and approved:

1. In the Supabase dashboard, check **Authentication → Sign In / Providers →
   Email → Confirm email** is **on**. Sharing invitations rely on confirmed
   email addresses.
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
