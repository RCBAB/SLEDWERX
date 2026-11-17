-- =============================================================================
-- SledWerx — ROLLBACK for Migration 3
--   20261117150000_sled_photos_and_create_sled.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 3 created: sleds.photo_path, the
--   sled-photos bucket and its four storage policies, create_sled() and
--   photo_sled_id(), and Migration 3's migration-history entry. All in ONE
--   transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261117150000';
-- * REFUSES to run while any sled has a photo or any file exists in the
--   sled-photos bucket, so it can never orphan or lose a photo.
-- * Sleds and readings created with create_sled() are ordinary Migration 1/2
--   data and are kept. Migrations 1 and 2 are untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261117150000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261117150000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sleds' and column_name = 'photo_path') then
    execute 'select count(*) from public.sleds where photo_path is not null' into strict v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % snowmobile(s) have a photo. Do not roll back once photos exist; fix forward instead.', v_rows;
    end if;
  end if;

  select count(*) into v_rows from storage.objects where bucket_id = 'sled-photos';
  if v_rows > 0 then
    raise exception 'Rollback aborted: the sled-photos bucket contains % file(s). Do not roll back once photos exist; fix forward instead.', v_rows;
  end if;
end $$;

-- 2. Storage policies and the bucket (empty, checked above). Supabase may
--    block direct deletes from storage tables; this setting allows it for
--    this transaction only.
drop policy if exists "SledWerx: sled users can view sled photos" on storage.objects;
drop policy if exists "SledWerx: owners and editors can upload sled photos" on storage.objects;
drop policy if exists "SledWerx: owners and editors can replace sled photos" on storage.objects;
drop policy if exists "SledWerx: owners and editors can remove sled photos" on storage.objects;
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.buckets where id = 'sled-photos';

-- 3. Functions and the column. No CASCADE: anything unexpected depending on
--    them stops the rollback.
drop function if exists public.create_sled(text, text, integer, numeric, numeric, text, text, date, uuid);
drop function if exists private.photo_sled_id(text);
alter table public.sleds drop column if exists photo_path;

-- 4. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261117150000';

-- 5. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sleds' and column_name = 'photo_path')
     or exists (select 1 from storage.buckets where id = 'sled-photos')
     or exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'SledWerx:%')
     or to_regprocedure('public.create_sled(text,text,integer,numeric,numeric,text,text,date,uuid)') is not null
     or to_regprocedure('private.photo_sled_id(text)') is not null
  then
    raise exception 'Rollback verification failed: Migration 3 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 3 removed; Migrations 1 and 2 untouched.';
end $$;

commit;
