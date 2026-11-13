-- =============================================================================
-- SledWerx — ROLLBACK for Migration 2
--   20261112210000_maintenance_logbook.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 2 created and restores the three Migration 1
--   objects it changed (audit trigger, audit policy and scope check, cleanup
--   function) to their exact Migration 1 definitions. Also removes Migration 2's
--   migration-history entry. All in ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261112210000';
-- * REFUSES to run if any Migration 2 table has a row, or any audit history
--   for Migration 2 tables exists, so it can never delete user data.
-- * Leaves Migration 1 and its data untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
  v_table text;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261112210000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261112210000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  foreach v_table in array array[
    'maintenance_tasks', 'maintenance_packages', 'maintenance_package_tasks', 'sled_readings',
    'maintenance_plans', 'maintenance_entries', 'maintenance_entry_tasks', 'maintenance_entry_parts'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('select count(*) from public.%I', v_table) into strict v_rows;
      if v_rows > 0 then
        raise exception 'Rollback aborted: public.% contains % row(s). Do not roll back once data exists; fix forward instead.', v_table, v_rows;
      end if;
    end if;
  end loop;

  select count(*) into v_rows from public.audit_log
  where library_owner_id is not null
     or table_name in ('maintenance_tasks', 'maintenance_packages', 'maintenance_package_tasks', 'sled_readings',
                       'maintenance_plans', 'maintenance_entries', 'maintenance_entry_tasks', 'maintenance_entry_parts');
  if v_rows > 0 then
    raise exception 'Rollback aborted: % audit row(s) exist for Migration 2 records. Do not roll back once data has existed; fix forward instead.', v_rows;
  end if;
end $$;

-- 2. API functions and views.
drop function if exists public.restore_record_version(bigint);
drop function if exists public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb);
drop view if exists public.maintenance_entry_costs;
drop view if exists public.sled_reading_history;

-- 3. Tables, children first (their triggers, policies and indexes go with them).
--    No CASCADE: anything unexpected depending on them stops the rollback.
drop table if exists public.maintenance_entry_parts;
drop table if exists public.maintenance_entry_tasks;
drop table if exists public.maintenance_entries;
drop table if exists public.maintenance_plans;
drop table if exists public.sled_readings;
drop table if exists public.maintenance_package_tasks;
drop table if exists public.maintenance_packages;
drop table if exists public.maintenance_tasks;

-- 4. Migration 2 functions and type.
drop function if exists
  private.shared_visible_task_ids(),
  private.task_usable_on_sled(uuid, uuid),
  private.tg_library_guard(),
  private.tg_maintenance_tasks_guard(),
  private.tg_package_tasks_check(),
  private.tg_maintenance_plans_check(),
  private.tg_maintenance_entries_check(),
  private.tg_entry_children_derive(),
  private.tg_sled_readings_check(),
  private.tg_sled_readings_order(),
  private.tg_entries_cascade(),
  private.tg_tasks_cascade(),
  private.tg_packages_cascade();
drop type if exists public.engine_event;

-- 5. Restore Migration 1's audit log: policy, scope check, column.
drop policy if exists "Role-based access to audit history" on public.audit_log;
alter table public.audit_log drop constraint if exists audit_log_scope_check;
drop index if exists public.audit_log_library_owner_idx;
alter table public.audit_log drop column if exists library_owner_id;
alter table public.audit_log add constraint audit_log_check check (num_nonnulls(garage_id, sled_id) = 1);

-- Migration 1 definition (copied verbatim):
create policy "Role-based access to audit history"
  on public.audit_log for select to authenticated
  using (
    sled_id in (select private.owned_sled_ids())
    or garage_id in (select private.owned_garage_ids())
    or (
      category in ('sled', 'maintenance')
      and sled_id in (select private.shared_sled_ids(array['editor']::public.sled_share_role[]))
    )
    or (
      category = 'maintenance'
      and record_created_by = (select auth.uid())
      and sled_id in (select private.shared_sled_ids(array['mechanic']::public.sled_share_role[]))
    )
  );

-- 6. Restore Migration 1's functions (copied verbatim).
create or replace function private.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_sled_id uuid;
  v_garage_id uuid;
  v_changed text[];
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old) - 'token_hash';
  end if;
  v_new := to_jsonb(new) - 'token_hash';
  v_row := v_new;

  -- Garage history is keyed by garage; everything else by sled, so a sled's
  -- history follows it if it moves between garages.
  if tg_table_name = 'garages' then
    v_garage_id := (v_row ->> 'id')::uuid;
  elsif tg_table_name = 'sleds' then
    v_sled_id := (v_row ->> 'id')::uuid;
  else
    v_sled_id := (v_row ->> 'sled_id')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key
      and n.key not in ('updated_at', 'updated_by', 'version');

    if v_changed is null then
      return null;
    end if;
  end if;

  insert into public.audit_log (
    actor_id, action, category, table_name, record_id, record_created_by,
    garage_id, sled_id, changed_fields, old_data, new_data
  ) values (
    auth.uid(), lower(tg_op), tg_argv[0], tg_table_name, (v_row ->> 'id')::uuid,
    (v_row ->> 'created_by')::uuid, v_garage_id, v_sled_id, v_changed, v_old, v_new
  );

  return null;
end;
$$;

create or replace function private.purge_expired_records()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - private.recovery_window();
  v_sleds integer;
  v_garages integer;
  v_invitations integer;
  v_shares integer;
begin
  delete from public.sleds where deleted_at < v_cutoff;
  get diagnostics v_sleds = row_count;

  delete from public.garages g
  where g.deleted_at < v_cutoff
    and not exists (select 1 from public.sleds s where s.garage_id = g.id);
  get diagnostics v_garages = row_count;

  delete from public.sled_invitations
  where coalesce(accepted_at, revoked_at, expires_at) < v_cutoff;
  get diagnostics v_invitations = row_count;

  delete from public.sled_shares where revoked_at < v_cutoff;
  get diagnostics v_shares = row_count;

  return jsonb_build_object(
    'sleds', v_sleds,
    'garages', v_garages,
    'invitations', v_invitations,
    'revoked_shares', v_shares
  );
end;
$$;

revoke all on function private.purge_expired_records() from public;

-- 7. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261112210000';

-- 8. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename in (
               'maintenance_tasks', 'maintenance_packages', 'maintenance_package_tasks', 'sled_readings',
               'maintenance_plans', 'maintenance_entries', 'maintenance_entry_tasks', 'maintenance_entry_parts'))
     or exists (select 1 from pg_views where schemaname = 'public'
                and viewname in ('sled_reading_history', 'maintenance_entry_costs'))
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and table_name = 'audit_log' and column_name = 'library_owner_id')
     or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where n.nspname = 'public' and t.typname = 'engine_event')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where (n.nspname = 'public' and p.proname in ('restore_record_version', 'save_maintenance_entry'))
                   or (n.nspname = 'private' and p.proname in ('shared_visible_task_ids', 'task_usable_on_sled')))
     or not exists (select 1 from pg_constraint where conname = 'audit_log_check'
                    and conrelid = 'public.audit_log'::regclass)
  then
    raise exception 'Rollback verification failed: Migration 2 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 2 removed; Migration 1 restored.';
end $$;

commit;
