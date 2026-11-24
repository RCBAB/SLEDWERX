-- =============================================================================
-- SledWerx — ROLLBACK for Migration 11
--   20261125090000_measurement_photo_access.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Puts back Migration 7's private.suspension_photo_sled_id and Migration
--   10's private.tg_sled_measurement_photos_check exactly as they were, and
--   removes Migration 11's migration-history entry. One transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261125090000';
-- * REFUSES while any measurement photo row refers to a file whose folder
--   configuration no longer exists: after the rollback nobody could open that
--   file, and saving that snowmobile's next configuration would fail.
-- * Changes no data, policy or file.
-- =============================================================================
begin;

do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261125090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261125090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if to_regclass('public.sled_trail_settings') is not null then
    raise exception 'Rollback aborted: Migration 12 (suspension turns) is applied. Roll back Migration 12 first.';
  end if;
  select count(*) into v_rows from public.sled_measurement_photos m
  where not exists (select 1 from public.suspension_revisions r
                    where r.id::text = split_part(m.path, '/', 2) and r.sled_id = m.sled_id);
  if v_rows > 0 then
    raise exception 'Rollback aborted: % measurement photo row(s) use a file whose folder configuration is gone. Fix forward instead.', v_rows;
  end if;
end $$;

-- Migration 7's definition.
create or replace function private.suspension_photo_sled_id(p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select st.sled_id from public.suspension_settings st
     where st.id = private.suspension_photo_parent_id(p_name) and st.sled_id::text = split_part(p_name, '/', 1)),
    (select r.sled_id from public.suspension_revisions r
     where r.id = private.suspension_photo_parent_id(p_name) and r.sled_id::text = split_part(p_name, '/', 1))
  );
$$;

-- Migration 10's definition.
create or replace function private.tg_sled_measurement_photos_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_revision record;
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['deleted_at', 'deleted_by', 'updated_at', 'updated_by', 'version'])
       is distinct from (to_jsonb(old) - array['deleted_at', 'deleted_by', 'updated_at', 'updated_by', 'version']) then
      raise exception 'A measurement photo cannot be changed. Replace it instead.' using errcode = '42501';
    end if;
    return new;
  end if;

  select r.sled_id, r.deleted_at into v_revision from public.suspension_revisions r where r.id = new.revision_id;
  if not found then
    raise exception 'Configuration not found.' using errcode = '23503';
  end if;
  if v_revision.deleted_at is not null then
    raise exception 'Restore it before adding photos.' using errcode = '42501';
  end if;
  new.sled_id := v_revision.sled_id;
  if not exists (select 1 from public.suspension_settings st
                 where st.id = new.setting_id and st.sled_id = new.sled_id and st.deleted_at is null) then
    raise exception 'That setting is not on this snowmobile.' using errcode = '23514';
  end if;
  -- The file is in this sled's folder, under one of its configurations.
  if split_part(new.path, '/', 1) <> new.sled_id::text or not exists (
    select 1 from public.suspension_revisions r
    where r.id::text = split_part(new.path, '/', 2) and r.sled_id = new.sled_id
  ) then
    raise exception 'That photo is not in the right folder.' using errcode = '23514';
  end if;
  return new;
end;
$$;

delete from supabase_migrations.schema_migrations where version = '20261125090000';

do $$
begin
  if position('sled_measurement_photos' in (select prosrc from pg_proc where proname = 'suspension_photo_sled_id')) > 0
     or position('Migration 11' in (select prosrc from pg_proc where proname = 'tg_sled_measurement_photos_check')) > 0 then
    raise exception 'Rollback verification failed: Migration 11 definitions remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 11 removed; Migrations 1-10 untouched.';
end $$;

commit;
