-- =============================================================================
-- SledWerx migration 10 (Phase 6.2): suspension measurement photos
--
-- Up to 2 photos documenting a measurement (a setting) as it was on one Trail
-- configuration of one snowmobile. Photos are documentation only: adding,
-- replacing or removing them never creates a configuration and never changes
-- values, numbers or which configuration is active.
--
-- * sled_measurement_photos: one row per (configuration, setting, slot
--   1|2). The image file is an immutable object in the private
--   suspension-photos bucket at <sled>/<revision it was uploaded to>/<uuid>.jpg
--   (the existing storage policies: everyone on the sled views, owners,
--   editors and mechanics upload, owners and editors remove).
-- * Shared files, independent history: a new configuration gets NEW rows
--   pointing at the SAME files as the configuration it was made from
--   (save_suspension_configuration, re-created below). Replacing a photo in
--   Trail 7 moves Trail 7's row to Recently Deleted and adds a row with a new
--   file; Trail 6's row is untouched. Files are never removed by the app; a
--   file is only ever removed by the Migration 8 cleanup once NO row (active
--   or deleted, in any configuration) refers to it.
-- * Record-table pattern (Migration 1 guard, metadata, audit, Recently
--   Deleted); Migration 8 registries updated (purge, delete counter, photo
--   reference column with its claim guard).
-- * Functions: add_suspension_measurement_photo, replace_suspension_measurement_photo
--   (SECURITY INVOKER: RLS and every trigger apply to the caller).
--
-- Additive except that save_suspension_configuration (Migration 9) is
-- re-created with the photo carry-forward (same signature, same behaviour
-- otherwise). Rollback: supabase/rollback/20261124090000_rollback.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
create table public.sled_measurement_photos (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  revision_id uuid not null references public.suspension_revisions (id) on delete cascade,
  setting_id uuid not null references public.suspension_settings (id) on delete cascade,
  path text not null check (path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'),
  slot smallint not null check (slot in (1, 2)),
  -- The row this one was carried forward from (informational; no foreign key).
  carried_from_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

-- At most 2 active photos per measurement per configuration (slots 1 and 2).
create unique index sled_measurement_photos_slot_uniq
  on public.sled_measurement_photos (revision_id, setting_id, slot) where deleted_at is null;
create index sled_measurement_photos_sled_idx on public.sled_measurement_photos (sled_id);
create index sled_measurement_photos_path_idx on public.sled_measurement_photos (path);

comment on table public.sled_measurement_photos is
  'Measurement photos (Migration 10): up to 2 per setting per configuration. Rows are per configuration; files are shared and immutable.';

-- -----------------------------------------------------------------------------
-- 2. Checks
-- -----------------------------------------------------------------------------
create function private.tg_sled_measurement_photos_check()
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

-- A configuration moved to Recently Deleted (with its setup) or restored:
-- its measurement photos follow, with the same timestamp.
create function private.tg_suspension_revisions_measurement_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.sled_measurement_photos set deleted_at = new.deleted_at
      where revision_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.sled_measurement_photos set deleted_at = null
      where revision_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

revoke all on function
  private.tg_sled_measurement_photos_check(),
  private.tg_suspension_revisions_measurement_cascade()
from public, anon, authenticated;

create trigger guard before insert or update on public.sled_measurement_photos
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.sled_measurement_photos
  for each row execute function private.tg_sled_measurement_photos_check();
create trigger stamp before insert or update on public.sled_measurement_photos
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.sled_measurement_photos
  for each row execute function private.tg_audit('maintenance');
create trigger cascade_measurement_photos after update of deleted_at on public.suspension_revisions
  for each row execute function private.tg_suspension_revisions_measurement_cascade();

-- -----------------------------------------------------------------------------
-- 3. Privileges and Row Level Security (never delete: Recently Deleted)
-- -----------------------------------------------------------------------------
revoke all on public.sled_measurement_photos from anon, authenticated;
grant select, insert, update on public.sled_measurement_photos to authenticated;
alter table public.sled_measurement_photos enable row level security;

create policy "Sled users can view measurement photos"
  on public.sled_measurement_photos for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add measurement photos"
  on public.sled_measurement_photos for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Owners and editors can remove measurement photos"
  on public.sled_measurement_photos for update to authenticated
  using (private.has_sled_permission(sled_id, 'soft_delete_records'))
  with check (private.has_sled_permission(sled_id, 'soft_delete_records'));

-- -----------------------------------------------------------------------------
-- 4. Migration 8 (cleanup) registries: purge expired rows (children first),
--    count their deletes, and treat their paths as references (a file is kept
--    while ANY row, in any configuration, active or deleted, points at it).
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.cleanup_record_tables') is not null then
    insert into private.cleanup_record_tables (table_name, sort_order, expiry, result_key)
    values ('sled_measurement_photos', 9, 'deleted_at', 'sled_measurement_photos');
    insert into private.storage_reference_columns (bucket_id, table_name, column_name)
    values ('suspension-photos', 'sled_measurement_photos', 'path');
    create trigger cleanup_count_deletes after delete on public.sled_measurement_photos
      referencing old table as old_rows
      for each statement execute function private.tg_cleanup_count_deletes();
    create trigger storage_claim_guard before insert or update of path on public.sled_measurement_photos
      for each row execute function private.tg_storage_claim_guard('suspension-photos', 'path');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Functions (SECURITY INVOKER: the caller's RLS and every trigger apply)
-- -----------------------------------------------------------------------------

-- Add a photo to a measurement of one configuration: the next free slot (1 or
-- 2). A repeat with the same file returns the photo already saved. Owners,
-- editors and mechanics. Never touches the configuration itself.
create function public.add_suspension_measurement_photo(p_revision_id uuid, p_setting_id uuid, p_path text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_existing record;
  v_slot smallint;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to add photos.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sledwerx.measurement_photos:' || p_revision_id::text || ':' || p_setting_id::text, 0));
  select m.id, m.slot into v_existing from public.sled_measurement_photos m
  where m.revision_id = p_revision_id and m.setting_id = p_setting_id and m.path = p_path and m.deleted_at is null;
  if found then
    return jsonb_build_object('id', v_existing.id, 'slot', v_existing.slot, 'duplicate', true);
  end if;
  select s into v_slot from unnest(array[1, 2]::smallint[]) s
  where not exists (select 1 from public.sled_measurement_photos m
                    where m.revision_id = p_revision_id and m.setting_id = p_setting_id and m.slot = s and m.deleted_at is null)
  order by s limit 1;
  if v_slot is null then
    raise exception 'At most 2 photos per measurement.' using errcode = '23514';
  end if;
  insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot)
  values ((select r.sled_id from public.suspension_revisions r where r.id = p_revision_id), p_revision_id, p_setting_id, p_path, v_slot)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'slot', v_slot, 'duplicate', false);
end;
$$;

-- Replace one photo of one configuration: its row goes to Recently Deleted and
-- a row with the new file takes the same slot. Other configurations that share
-- the old file keep it. Owners and editors (Migration 1 guard). Refused if the
-- photo changed meanwhile (version).
create function public.replace_suspension_measurement_photo(p_photo_id uuid, p_version integer, p_path text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_old record;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to replace photos.' using errcode = '42501';
  end if;
  select m.revision_id, m.setting_id, m.slot, m.sled_id, m.deleted_at into v_old
  from public.sled_measurement_photos m where m.id = p_photo_id;
  if not found or v_old.deleted_at is not null then
    raise exception 'Photo not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sledwerx.measurement_photos:' || v_old.revision_id::text || ':' || v_old.setting_id::text, 0));
  update public.sled_measurement_photos set deleted_at = now(), version = p_version
  where id = p_photo_id and deleted_at is null;
  if not found then
    raise exception 'You can''t replace this photo.' using errcode = '42501';
  end if;
  insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot)
  values (v_old.sled_id, v_old.revision_id, v_old.setting_id, p_path, v_old.slot)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'slot', v_old.slot);
end;
$$;

revoke all on function
  public.add_suspension_measurement_photo(uuid, uuid, text),
  public.replace_suspension_measurement_photo(uuid, integer, text)
from public, anon;
grant execute on function
  public.add_suspension_measurement_photo(uuid, uuid, text),
  public.replace_suspension_measurement_photo(uuid, integer, text)
to authenticated;

-- -----------------------------------------------------------------------------
-- 6. save_suspension_configuration (Migration 9) with photo carry-forward.
--    Identical to Migration 9 except the block marked "Migration 10".
-- -----------------------------------------------------------------------------
create or replace function public.save_suspension_configuration(
  p_sled_id uuid,
  p_base_revision_id uuid default null,
  p_changes jsonb default '{}'::jsonb,
  p_ski_model text default null,
  p_carbide_length text default null,
  p_note text default null,
  p_odometer_mi numeric default null,
  p_engine_hours numeric default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing record;
  v_state record;
  v_base record;
  v_base_values jsonb := '{}'::jsonb;
  v_values jsonb;
  v_ski text;
  v_carbide text;
  v_setup uuid;
  v_revision record;
begin
  if v_uid is null then
    raise exception 'Sign in to record suspension changes.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  if p_changes is null then
    p_changes := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Changes must be an object.' using errcode = '22023';
  end if;

  select r.id, r.config_number into v_existing
  from public.suspension_revisions r where r.created_by = v_uid and r.client_request_id = p_idempotency_key;
  if found then
    return jsonb_build_object('revision_id', v_existing.id, 'config_number', v_existing.config_number, 'duplicate', true);
  end if;

  if not exists (select 1 from public.sleds s where s.id = p_sled_id) or not private.has_sled_permission(p_sled_id, 'add_records') then
    raise exception 'You do not have permission to change this snowmobile''s suspension.' using errcode = '42501';
  end if;
  if p_ski_model is not null and p_ski_model not in ('ca_pro_xpt', 'ca_pro_xcs') then
    raise exception 'Choose a ski model.' using errcode = '22023';
  end if;
  if p_carbide_length is not null and p_carbide_length not in ('6', '7.5', '9') then
    raise exception 'Choose a carbide length.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_config:' || p_sled_id::text, 0));

  select st.active_revision_id, st.ski_model, st.carbide_length into v_state
  from public.sled_suspension_state st where st.sled_id = p_sled_id;
  if v_state.active_revision_id is distinct from p_base_revision_id then
    raise exception 'The active configuration was changed by someone else. Reload it and try again.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;

  if p_base_revision_id is not null then
    select r.setup_id, r.setting_values into v_base
    from public.suspension_revisions r where r.id = p_base_revision_id and r.deleted_at is null;
    if not found then
      raise exception 'The active configuration was changed by someone else. Reload it and try again.'
        using errcode = 'PT409', hint = 'version_conflict';
    end if;
    v_base_values := private.suspension_current_values(v_base.setting_values, p_sled_id);
    v_setup := v_base.setup_id;
  end if;

  -- Carry every unchanged value forward; apply the changes (null or "" clears).
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_values
  from (
    select key as k, value as v from jsonb_each(v_base_values) where not p_changes ? key
    union all
    select key, to_jsonb(btrim(value #>> '{}')) from jsonb_each(p_changes)
    where jsonb_typeof(value) in ('string', 'number') and btrim(value #>> '{}') <> ''
  ) merged;

  v_ski := coalesce(p_ski_model, v_state.ski_model);
  v_carbide := coalesce(p_carbide_length, v_state.carbide_length);
  if p_base_revision_id is not null and v_values = v_base_values
     and v_ski is not distinct from v_state.ski_model and v_carbide is not distinct from v_state.carbide_length then
    raise exception 'Nothing changed.' using errcode = '22023';
  end if;
  if p_base_revision_id is null and v_values = '{}'::jsonb and v_ski is null and v_carbide is null then
    raise exception 'Nothing changed.' using errcode = '22023';
  end if;

  -- The first configuration of a sled goes into its setup (made if needed).
  if v_setup is null then
    select s.id into v_setup from public.suspension_setups s
    where s.sled_id = p_sled_id and s.deleted_at is null
    order by s.is_active desc, s.created_at desc limit 1;
    if v_setup is null then
      insert into public.suspension_setups (sled_id, name) values (p_sled_id, 'Trail') returning id into v_setup;
    end if;
  end if;

  insert into public.suspension_revisions (
    setup_id, sled_id, revision_number, setting_values, note, odometer_mi, engine_hours,
    ski_model, carbide_length, based_on_revision_id, client_request_id
  ) values (
    v_setup, p_sled_id, 1, v_values, nullif(btrim(p_note), ''), p_odometer_mi, p_engine_hours,
    v_ski, v_carbide, p_base_revision_id, p_idempotency_key
  )
  returning id, config_number into v_revision;

  -- Migration 10: the new configuration starts with the measurement photos of
  -- the one it was made from (new rows pointing at the same files; the older
  -- configuration keeps its own rows). Only settings that still exist.
  if p_base_revision_id is not null then
    insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot, carried_from_id)
    select p_sled_id, v_revision.id, m.setting_id, m.path, m.slot, m.id
    from public.sled_measurement_photos m
    join public.suspension_settings st on st.id = m.setting_id and st.deleted_at is null
    where m.revision_id = p_base_revision_id and m.deleted_at is null;
  end if;

  insert into public.sled_suspension_state (sled_id, active_revision_id, ski_model, carbide_length)
  values (p_sled_id, v_revision.id, v_ski, v_carbide)
  on conflict (sled_id) do update
    set active_revision_id = excluded.active_revision_id,
        ski_model = excluded.ski_model,
        carbide_length = excluded.carbide_length;

  return jsonb_build_object('revision_id', v_revision.id, 'config_number', v_revision.config_number, 'duplicate', false);
end;
$$;

