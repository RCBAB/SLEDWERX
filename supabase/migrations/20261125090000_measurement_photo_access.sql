-- =============================================================================
-- SledWerx migration 11 (Phase 6.2): access to shared measurement photos
--
-- A measurement photo's file sits in the folder of the configuration it was
-- first uploaded to (<sled>/<revision>/<uuid>.jpg). Migration 10 lets later
-- configurations refer to the same file. The storage policies decide who may
-- view (and, for owners and editors, remove) a suspension-photos file through
-- private.suspension_photo_sled_id(name), which until now only looked at the
-- folder's setting or revision. If that original configuration were ever
-- purged by the Migration 8 cleanup while another configuration of the same
-- snowmobile still refers to the file, nobody could open the file any more.
--
-- With the app's own functions this cannot happen today (a new configuration
-- is always saved into the setup it was made from, and a setup's
-- configurations are only ever deleted together), but rows can be added
-- through the API with any file in the snowmobile's folder. This makes the
-- lookup also accept a file that a measurement photo row (active or in
-- Recently Deleted) of the SAME snowmobile still refers to.
--
-- Access is not widened: the result is still that snowmobile, so the
-- policies still require the caller's permission on it, and the path must
-- still start with that snowmobile's id. No policy is changed; only this
-- helper's definition.
--
-- The same case also blocked saving: when a new configuration carries the
-- photos forward, Migration 10's check required each file's folder
-- configuration to still exist, so after such a purge EVERY save of the
-- snowmobile would fail. The check now also accepts a file another row of the
-- same snowmobile already refers to (part 2).
--
-- Rollback: supabase/rollback/20261125090000_rollback.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Who may view (or, owners and editors, remove) a suspension-photos file
-- -----------------------------------------------------------------------------
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
     where r.id = private.suspension_photo_parent_id(p_name) and r.sled_id::text = split_part(p_name, '/', 1)),
    -- Migration 11: a measurement photo row of the same snowmobile still refers to this file.
    (select m.sled_id from public.sled_measurement_photos m
     where m.path = p_name and m.sled_id::text = split_part(p_name, '/', 1)
     limit 1)
  );
$$;

-- -----------------------------------------------------------------------------
-- 2. Measurement photo check (Migration 10), accepting files already in use
--    by this snowmobile. Identical otherwise.
-- -----------------------------------------------------------------------------
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
  -- The file is in this sled's folder, under one of its configurations, or
  -- (Migration 11) it is a file another row of this sled already refers to,
  -- e.g. carried forward from a configuration that has since been purged.
  if split_part(new.path, '/', 1) <> new.sled_id::text or not (
    exists (select 1 from public.suspension_revisions r
            where r.id::text = split_part(new.path, '/', 2) and r.sled_id = new.sled_id)
    or exists (select 1 from public.sled_measurement_photos m
               where m.path = new.path and m.sled_id = new.sled_id)
  ) then
    raise exception 'That photo is not in the right folder.' using errcode = '23514';
  end if;
  return new;
end;
$$;
