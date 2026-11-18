-- =============================================================================
-- SledWerx — ROLLBACK for Migration 6
--   20261120090000_sled_issues.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 6 created: the sled_issues and
--   sled_issue_photos tables (with their triggers, policies and functions),
--   the issue-photos bucket and its three storage policies, and puts back
--   Migration 2's restore_record_version exactly. Also removes Migration 6's
--   migration-history entry. All in ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261120090000';
-- * REFUSES to run while any issue, issue photo or issue-photo file exists
--   (including issues in Recently Deleted), so it can never lose data.
-- * Their audit-log rows (if any were written and then removed) are left as
--   history. Migrations 1-5 are untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261120090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261120090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  if to_regclass('public.sled_issues') is not null then
    execute 'select count(*) from public.sled_issues' into strict v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % issue(s) exist. Do not roll back once issues are used; fix forward instead.', v_rows;
    end if;
  end if;
  if to_regclass('public.sled_issue_photos') is not null then
    execute 'select count(*) from public.sled_issue_photos' into strict v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % issue photo record(s) exist. Fix forward instead.', v_rows;
    end if;
  end if;
  select count(*) into v_rows from storage.objects where bucket_id = 'issue-photos';
  if v_rows > 0 then
    raise exception 'Rollback aborted: the issue-photos bucket contains % file(s). Fix forward instead.', v_rows;
  end if;
end $$;

-- 2. Storage policies and the bucket (empty, checked above). Supabase may
--    block direct deletes from storage tables; this setting allows it for
--    this transaction only.
drop policy if exists "SledWerx issue photos: sled users can view" on storage.objects;
drop policy if exists "SledWerx issue photos: issue editors can upload" on storage.objects;
drop policy if exists "SledWerx issue photos: owners and editors can remove" on storage.objects;
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.buckets where id = 'issue-photos';

-- 3. Tables (empty, checked above; their triggers and policies go with them)
--    and functions. No CASCADE: anything unexpected depending on them stops
--    the rollback.
drop table if exists public.sled_issue_photos;
drop table if exists public.sled_issues;
drop function if exists private.can_add_issue_photo(text);
drop function if exists private.issue_photo_sled_id(text);
drop function if exists private.issue_photo_issue_id(text);
drop function if exists private.tg_sled_issue_photos_check();
drop function if exists private.tg_sled_issues_check();
drop function if exists private.tg_sled_issues_cascade();

-- 4. restore_record_version: Migration 2's definition, exactly.
create or replace function public.restore_record_version(p_audit_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_audit public.audit_log%rowtype;
  v_columns text;
  v_rows integer;
begin
  select * into v_audit from public.audit_log a where a.id = p_audit_id;

  if v_audit.id is null
     or v_audit.old_data is null
     or v_audit.sled_id is null
     or v_audit.table_name not in (
       'sled_readings', 'maintenance_plans', 'maintenance_entries',
       'maintenance_entry_tasks', 'maintenance_entry_parts'
     )
     or not private.can_modify_sled_record(v_audit.sled_id, v_audit.record_created_by)
  then
    raise exception 'Version not found.' using errcode = 'P0002';
  end if;

  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
  into v_columns
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = v_audit.table_name
    and c.column_name not in (
      'id', 'sled_id', 'entry_id', 'created_at', 'created_by',
      'updated_at', 'updated_by', 'version', 'deleted_at', 'deleted_by',
      'client_request_id'
    );

  -- The row's own guard re-checks permission with the caller's identity,
  -- refuses deleted records, and the stamp/audit triggers record the change.
  execute format(
    'update public.%1$I t set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $1)) where t.id = $2',
    v_audit.table_name, v_columns
  ) using v_audit.old_data, v_audit.record_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Version not found.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.restore_record_version(bigint) from public, anon;
grant execute on function public.restore_record_version(bigint) to authenticated;

-- 5. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261120090000';

-- 6. Verify; any leftover undoes the whole rollback.
do $$
begin
  if to_regclass('public.sled_issues') is not null
     or to_regclass('public.sled_issue_photos') is not null
     or to_regprocedure('private.can_add_issue_photo(text)') is not null
     or to_regprocedure('private.issue_photo_sled_id(text)') is not null
     or to_regprocedure('private.issue_photo_issue_id(text)') is not null
     or exists (select 1 from storage.buckets where id = 'issue-photos')
     or exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'SledWerx issue photos:%')
     or pg_get_functiondef('public.restore_record_version(bigint)'::regprocedure) like '%sled_issues%'
  then
    raise exception 'Rollback verification failed: Migration 6 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 6 removed; Migrations 1-5 untouched.';
end $$;

commit;
