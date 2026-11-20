-- =============================================================================
-- SledWerx — ROLLBACK for Migration 8
--   20261122090000_recently_deleted_cleanup.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 8 created: the cleanup settings, runs,
--   candidates, registries, file claims and review view; the application
--   administrators list and the cleanup dashboard function; the cleanup
--   functions (private and the eight public API functions); the delete-counting triggers on the
--   purged tables; the claim guard on the three photo-path columns; and the
--   index on sleds.photo_path, and the two restrictive storage policies that
--   refuse uploads to claimed or removed photo paths. Also removes Migration 8's migration-history
--   entry. All in ONE transaction.
-- * Puts back private.purge_expired_records() exactly as Migration 2 left it
--   (unscheduled; it does not cover issues or suspension records).
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261122090000';
-- * REFUSES to run while deletion is switched on, or while a cleanup run is
--   in progress or a file is claimed: switch deletion off and let the run
--   finish first.
-- * It CANNOT bring back anything the cleanup already deleted. Records and
--   files removed by a delete run are gone; restore them from the verified
--   backup taken before deletion was enabled. The run history (what was
--   deleted, when) is removed with the cleanup tables: export it first if it
--   is needed (see the README).
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261122090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261122090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if to_regclass('private.cleanup_settings') is not null then
    if exists (select 1 from private.cleanup_settings where deletion_enabled) then
      raise exception 'Rollback aborted: cleanup deletion is switched on. Run  select private.revoke_cleanup_deletion();  first.';
    end if;
    if exists (select 1 from private.cleanup_runs where status = 'running') then
      raise exception 'Rollback aborted: a cleanup run is in progress. Let it finish first.';
    end if;
    if exists (select 1 from private.storage_cleanup_claims where status = 'claimed') then
      raise exception 'Rollback aborted: a photo file is claimed for removal. Let the run finish first.';
    end if;
  end if;
end $$;

-- 2. Triggers on existing tables.
do $$
declare
  v_t record;
begin
  for v_t in
    select tgrelid::regclass as rel, tgname from pg_trigger
    where not tgisinternal and tgname in ('cleanup_count_deletes', 'storage_claim_guard')
  loop
    execute format('drop trigger %I on %s', v_t.tgname, v_t.rel);
  end loop;
end $$;

-- 3a. Administrators and the dashboard.
drop function if exists public.cleanup_dashboard();
drop function if exists private.revoke_app_administrator(uuid);
drop function if exists private.grant_app_administrator(uuid, text);
drop function if exists private.is_app_administrator(uuid);
drop table if exists private.app_administrators;

-- 3. The two restrictive storage policies, the review view and the public
--    API functions.
drop policy if exists "SledWerx cleanup: no uploads to claimed or removed paths" on storage.objects;
drop policy if exists "SledWerx cleanup: no overwrites of claimed or removed paths" on storage.objects;
drop view if exists private.cleanup_review;
drop function if exists public.cleanup_begin_run(text);
drop function if exists public.cleanup_process_records(bigint);
drop function if exists public.cleanup_report_files(bigint);
drop function if exists public.cleanup_eligible_files(bigint);
drop function if exists public.cleanup_claim_file(bigint, text, text);
drop function if exists public.cleanup_verify_claim(bigint, text, text);
drop function if exists public.cleanup_record_file_result(bigint, text, text, boolean, text, jsonb);
drop function if exists public.cleanup_finish_run(bigint, text);

-- 4. The purge as Migration 2 left it.
-- -----------------------------------------------------------------------------
-- Cleanup: same as Migration 1, plus Migration 2's tables. Still unscheduled.
-- Readings are removed only after the entries that used them.
-- -----------------------------------------------------------------------------
create or replace function private.purge_expired_records()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - private.recovery_window();
  v_counts jsonb := '{}'::jsonb;
  v_rows integer;
begin
  delete from public.maintenance_entry_parts where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('entry_parts', v_rows);
  delete from public.maintenance_entry_tasks where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('entry_tasks', v_rows);
  delete from public.maintenance_entries where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('entries', v_rows);
  delete from public.maintenance_plans where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('plans', v_rows);
  delete from public.sled_readings where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('readings', v_rows);
  delete from public.maintenance_package_tasks where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('package_tasks', v_rows);
  delete from public.maintenance_packages where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('packages', v_rows);
  delete from public.maintenance_tasks where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tasks', v_rows);

  delete from public.sleds where deleted_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('sleds', v_rows);

  delete from public.garages g
  where g.deleted_at < v_cutoff
    and not exists (select 1 from public.sleds s where s.garage_id = g.id);
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('garages', v_rows);

  delete from public.sled_invitations
  where coalesce(accepted_at, revoked_at, expires_at) < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('invitations', v_rows);

  delete from public.sled_shares where revoked_at < v_cutoff;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('revoked_shares', v_rows);

  return v_counts;
end;
$$;

revoke all on function private.purge_expired_records() from public;

-- 5. Private functions (no CASCADE: anything unexpected depending on them
--    stops the rollback).
drop function if exists private.cleanup_finish_run(bigint, text);
drop function if exists private.cleanup_begin_run(text, text);
drop function if exists private.tg_storage_claim_guard();
drop function if exists private.storage_path_writable(text, text);
drop function if exists private.cleanup_record_file_result(bigint, text, text, boolean, text, jsonb);
drop function if exists private.cleanup_verify_claim(bigint, text, text);
drop function if exists private.cleanup_claim_file(bigint, text, text);
drop function if exists private.cleanup_eligible_files(bigint);
drop function if exists private.cleanup_report_files(bigint);
drop function if exists private.storage_file_candidates(timestamptz);
drop function if exists private.storage_file_status(text, text, timestamptz, timestamptz, jsonb, timestamptz);
drop function if exists private.cleanup_registry_problems();
drop function if exists private.storage_reference_count(text);
drop function if exists private.storage_path_referenced(text, text);
drop function if exists private.storage_path_recognized(text, text);
drop function if exists private.storage_lock_key(text, text);
drop function if exists private.cleanup_process_records(bigint);
drop function if exists private.cleanup_delete_root(text, uuid, timestamptz);
drop function if exists private.expired_records_report(timestamptz);
drop function if exists private.cleanup_cascade_rows(text, uuid);
drop function if exists private.expired_record_candidates(timestamptz);
drop function if exists private.cleanup_eligibility(text, boolean);
drop function if exists private.cleanup_expiry_expr(text);
drop function if exists private.tg_cleanup_count_deletes();
drop function if exists private.revoke_cleanup_deletion();
drop function if exists private.authorize_cleanup_deletion(text);

-- 6. Tables (their triggers go with them), dependants first.
drop table if exists private.cleanup_candidates;
drop table if exists private.storage_cleanup_claims;
drop table if exists private.cleanup_runs;
drop table if exists private.storage_reference_columns;
drop table if exists private.storage_cleanup_buckets;
drop table if exists private.cleanup_record_tables;
drop table if exists private.cleanup_settings;
drop function if exists private.tg_cleanup_settings_guard();
drop index if exists public.sleds_photo_path_idx;

-- 7. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261122090000';

-- 8. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'private' and (c.relname like 'cleanup\_%' or c.relname like 'storage\_cleanup%'
                                              or c.relname = 'storage_reference_columns'))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'private')
                  and (p.proname like '%cleanup%' or p.proname like 'storage\_%' or p.proname like 'expired\_record%'))
     or exists (select 1 from pg_trigger where tgname in ('cleanup_count_deletes', 'storage_claim_guard'))
     or to_regclass('public.sleds_photo_path_idx') is not null
     or exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'SledWerx cleanup:%')
     or to_regclass('private.app_administrators') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'private' and p.proname like '%app\_administrator%')
  then
    raise exception 'Rollback verification failed: Migration 8 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 8 removed; purge_expired_records() is back to its Migration 2 form; Migrations 1-7 untouched.';
end $$;

commit;
