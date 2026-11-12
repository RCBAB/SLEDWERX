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

CI tests this script on every pull request against a throwaway local
Supabase database. It checks that the script:

- refuses to run without confirmation
- refuses to run while data exists
- removes every Migration 1 object when allowed
- leaves sign-up working
- leaves the database ready for Migration 1 to be re-applied

CI never connects to the live project.
