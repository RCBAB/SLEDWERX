-- =============================================================================
-- SledWerx — ROLLBACK for Migration 7
--   20261121090000_suspension_tuning.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 7 created: the five suspension tables (with
--   their triggers and policies), their trigger and helper functions, the four
--   public suspension functions, the suspension-photos bucket and its three
--   storage policies. Also removes Migration 7's migration-history entry.
--   All in ONE transaction.
-- * Migration 7 changed nothing that existed before it, so nothing has to be
--   put back.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261121090000';
-- * REFUSES to run while any suspension setting, setup, revision, feedback,
--   photo record or suspension-photo file exists (including Recently
--   Deleted), so it can never lose data.
-- * Their audit-log rows (if any were written and then removed) are left as
--   history. Migrations 1-6 are untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_table text;
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261121090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261121090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  foreach v_table in array array['suspension_settings', 'suspension_setups', 'suspension_revisions',
                                 'suspension_feedback', 'suspension_photos'] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('select count(*) from public.%I', v_table) into strict v_rows;
      if v_rows > 0 then
        raise exception 'Rollback aborted: % row(s) exist in %. Do not roll back once suspension tuning is used; fix forward instead.', v_rows, v_table;
      end if;
    end if;
  end loop;

  select count(*) into v_rows from storage.objects where bucket_id = 'suspension-photos';
  if v_rows > 0 then
    raise exception 'Rollback aborted: the suspension-photos bucket contains % file(s). Fix forward instead.', v_rows;
  end if;
end $$;

-- 2. Storage policies and the bucket (empty, checked above). Supabase may
--    block direct deletes from storage tables; this setting allows it for
--    this transaction only.
drop policy if exists "SledWerx suspension photos: sled users can view" on storage.objects;
drop policy if exists "SledWerx suspension photos: permitted users can upload" on storage.objects;
drop policy if exists "SledWerx suspension photos: owners and editors can remove" on storage.objects;
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.buckets where id = 'suspension-photos';

-- 3. Public functions.
drop function if exists public.restore_suspension_revision(uuid, text, numeric, numeric, uuid);
drop function if exists public.save_suspension_revision(uuid, uuid, jsonb, text, numeric, numeric, uuid);
drop function if exists public.activate_suspension_setup(uuid);
drop function if exists public.create_suspension_setup(uuid, text, text, uuid);

-- 4. Tables (empty, checked above; their triggers and policies go with them),
--    children first. No CASCADE: anything unexpected depending on them stops
--    the rollback.
drop table if exists public.suspension_photos;
drop table if exists public.suspension_feedback;
drop table if exists public.suspension_revisions;
drop table if exists public.suspension_setups;
drop table if exists public.suspension_settings;

-- 5. Private helpers and trigger functions.
drop function if exists private.suspension_current_values(jsonb, uuid);
drop function if exists private.can_add_suspension_photo(text);
drop function if exists private.suspension_photo_sled_id(text);
drop function if exists private.suspension_photo_parent_id(text);
drop function if exists private.tg_suspension_settings_cascade();
drop function if exists private.tg_suspension_setups_cascade();
drop function if exists private.tg_suspension_photos_check();
drop function if exists private.tg_suspension_feedback_check();
drop function if exists private.tg_suspension_revisions_check();
drop function if exists private.tg_suspension_setups_check();

-- 6. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261121090000';

-- 7. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname like 'suspension\_%')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'private') and p.proname like '%suspension%')
     or exists (select 1 from storage.buckets where id = 'suspension-photos')
     or exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'SledWerx suspension photos:%')
  then
    raise exception 'Rollback verification failed: Migration 7 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 7 removed; Migrations 1-6 untouched.';
end $$;

commit;
