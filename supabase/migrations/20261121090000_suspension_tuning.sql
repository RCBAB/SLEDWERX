-- =============================================================================
-- SledWerx migration 7 (Phase 6.2): suspension setup & tuning
--
-- * suspension_settings: one master list of settings per sled (custom names,
--   a zone on the sled diagram, number or text, optional unit). Every sled
--   starts with an EMPTY list: nothing is pre-filled and no factory values
--   are assumed.
-- * suspension_setups: named setups per sled; at most one active per sled.
--   The active setup cannot be deleted until another one is activated.
-- * suspension_revisions: the history of a setup. Each revision holds a full
--   snapshot of the values (unchanged settings are carried forward), the
--   mileage/hours at the time (copies; never a reading) and a note. Revisions
--   cannot be edited; restoring an old one creates a NEW revision.
-- * suspension_feedback: Improved / Worse / No change entries per revision.
-- * suspension_photos: reference photos (per setting) and adjustment photos
--   (per revision), up to 6 each, in the private `suspension-photos` bucket.
-- * Functions: create_suspension_setup, activate_suspension_setup,
--   save_suspension_revision, restore_suspension_revision (SECURITY INVOKER:
--   RLS and every trigger apply to the caller).
--
-- All tables follow the record-table pattern (docs/database.md): RLS from the
-- sled's sharing permissions, Migration 1's record guard, metadata and version
-- checks, the audit log ('maintenance' category), Recently Deleted.
--
-- Additive only: no existing table, column, policy, trigger or function is
-- changed. Rollback: supabase/rollback/20261121090000_rollback.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- suspension_settings: the master list of settings for a sled
-- -----------------------------------------------------------------------------
create table public.suspension_settings (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  zone text not null check (zone in (
    'front_left_shock', 'front_right_shock', 'front_general',
    'rear_front_shock', 'rear_rear_shock', 'rear_springs_limiter', 'rear_general'
  )),
  value_type text not null default 'number' check (value_type in ('number', 'text')),
  -- Free text, e.g. clicks, turns, mm, in, psi. Optional.
  unit text check (char_length(btrim(unit)) between 1 and 20),
  position smallint not null default 0 check (position between 0 and 999),
  notes text check (char_length(notes) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create unique index suspension_settings_name_uniq
  on public.suspension_settings (sled_id, zone, lower(btrim(name))) where deleted_at is null;
create index suspension_settings_sled_idx on public.suspension_settings (sled_id, zone, position);

comment on table public.suspension_settings is
  'Suspension settings tracked on a sled (Phase 6.2). One list per sled, shared by all its setups. Starts empty; no default settings or values.';

-- -----------------------------------------------------------------------------
-- suspension_setups: named setups; at most one active per sled
-- -----------------------------------------------------------------------------
create table public.suspension_setups (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  notes text check (char_length(notes) <= 2000),
  is_active boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  constraint suspension_setups_deleted_inactive check (deleted_at is null or not is_active)
);

create unique index suspension_setups_one_active
  on public.suspension_setups (sled_id) where is_active and deleted_at is null;
create unique index suspension_setups_name_uniq
  on public.suspension_setups (sled_id, lower(btrim(name))) where deleted_at is null;
create index suspension_setups_sled_idx on public.suspension_setups (sled_id);

comment on table public.suspension_setups is
  'Named suspension setups of a sled (Phase 6.2). At most one active per sled; the active one cannot be deleted.';

-- -----------------------------------------------------------------------------
-- suspension_revisions: the history of a setup (cannot be edited)
-- -----------------------------------------------------------------------------
create table public.suspension_revisions (
  id uuid primary key default gen_random_uuid(),
  setup_id uuid not null references public.suspension_setups (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  -- 1, 2, 3, ... within the setup; assigned by the database.
  revision_number integer not null check (revision_number >= 1),
  -- {"<setting id>": {"value", "name", "zone", "unit", "type"}, ...}: a full
  -- snapshot. Blank settings are simply absent. Built by the database from the
  -- settings at the time, so history stays readable after renames.
  setting_values jsonb not null default '{}'::jsonb,
  note text check (char_length(note) <= 2000),
  -- Copies of the readings at the time, editable; never a reading.
  odometer_mi numeric(9, 1) check (odometer_mi >= 0 and odometer_mi < 1000000),
  engine_hours numeric(8, 1) check (engine_hours >= 0 and engine_hours < 100000),
  -- Set when this revision restored an earlier one of the same setup.
  restored_from_revision_id uuid references public.suspension_revisions (id),
  -- Idempotency key from save/restore: a repeat returns the saved revision.
  client_request_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  unique (setup_id, revision_number)
);

create index suspension_revisions_sled_idx on public.suspension_revisions (sled_id, created_at desc);
create unique index suspension_revisions_client_request_uniq
  on public.suspension_revisions (created_by, client_request_id) where client_request_id is not null;

comment on table public.suspension_revisions is
  'Revision history of a suspension setup (Phase 6.2). Immutable; a restore creates a new revision. Mileage/hours are copies, never readings.';

-- -----------------------------------------------------------------------------
-- suspension_feedback: Improved / Worse / No change, several per revision
-- -----------------------------------------------------------------------------
create table public.suspension_feedback (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.suspension_revisions (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  ridden_on date not null default current_date,
  rating text not null check (rating in ('improved', 'worse', 'no_change')),
  note text check (char_length(note) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create index suspension_feedback_revision_idx on public.suspension_feedback (revision_id, ridden_on desc);

-- -----------------------------------------------------------------------------
-- suspension_photos: reference (per setting) and adjustment (per revision)
-- -----------------------------------------------------------------------------
create table public.suspension_photos (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  setting_id uuid references public.suspension_settings (id) on delete cascade,
  revision_id uuid references public.suspension_revisions (id) on delete cascade,
  path text not null check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
  ),
  position smallint not null default 0 check (position between 0 and 99),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  unique (path),
  -- Exactly one parent: a setting (reference photo) or a revision (adjustment photo).
  constraint suspension_photos_one_parent check (num_nonnulls(setting_id, revision_id) = 1)
);

create index suspension_photos_setting_idx on public.suspension_photos (setting_id, position) where setting_id is not null;
create index suspension_photos_revision_idx on public.suspension_photos (revision_id, position) where revision_id is not null;

comment on table public.suspension_photos is
  'Suspension photos (Phase 6.2): reference photos of a setting or adjustment photos of a revision, at most 6 active each, in the private suspension-photos bucket at <sled id>/<setting or revision id>/<uuid>.jpg|webp.';

-- -----------------------------------------------------------------------------
-- Checks (BEFORE triggers named "links", after Migration 1's "guard")
-- -----------------------------------------------------------------------------

-- Setups: the active setup can't be deleted; a deleted setup can't be active.
create function private.tg_suspension_setups_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null and old.is_active then
    raise exception 'Make another setup active before deleting this one.' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Revisions: numbered, validated and snapshotted by the database; never edited.
create function private.tg_suspension_revisions_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_setup record;
  v_values jsonb := '{}'::jsonb;
  v_key text;
  v_entry jsonb;
  v_value text;
  v_setting record;
begin
  if tg_op = 'UPDATE' then
    -- Only moving into / out of Recently Deleted together with the setup.
    if (to_jsonb(new) - array['deleted_at', 'deleted_by', 'updated_at', 'updated_by', 'version'])
       is distinct from (to_jsonb(old) - array['deleted_at', 'deleted_by', 'updated_at', 'updated_by', 'version']) then
      raise exception 'Suspension revisions cannot be changed. Save a new revision instead.' using errcode = '42501';
    end if;
    if new.deleted_at is distinct from old.deleted_at
       and new.deleted_at is distinct from (select s.deleted_at from public.suspension_setups s where s.id = new.setup_id) then
      raise exception 'Revisions are deleted and restored together with their setup.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- One revision at a time per setup, so numbers never collide.
  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_setup:' || new.setup_id::text, 0));

  select s.sled_id, s.deleted_at into v_setup from public.suspension_setups s where s.id = new.setup_id;
  if not found then
    raise exception 'Setup not found.' using errcode = '23503';
  end if;
  if v_setup.deleted_at is not null then
    raise exception 'Restore this setup before changing it.' using errcode = '42501';
  end if;
  new.sled_id := v_setup.sled_id;
  new.revision_number := coalesce(
    (select max(r.revision_number) from public.suspension_revisions r where r.setup_id = new.setup_id), 0) + 1;

  if new.restored_from_revision_id is not null and not exists (
    select 1 from public.suspension_revisions r
    where r.id = new.restored_from_revision_id and r.setup_id = new.setup_id
  ) then
    raise exception 'Only a revision of the same setup can be restored.' using errcode = '23514';
  end if;

  -- Values: {"<setting id>": {"value": "..."}} for current settings of this sled.
  if new.setting_values is null or jsonb_typeof(new.setting_values) <> 'object' then
    raise exception 'Setting values must be an object.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(new.setting_values)) > 200 then
    raise exception 'A revision can have at most 200 settings.' using errcode = '22023';
  end if;
  for v_key, v_entry in select * from jsonb_each(new.setting_values) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Unknown setting.' using errcode = '22023';
    end if;
    select st.name, st.zone, st.unit, st.value_type into v_setting
    from public.suspension_settings st
    where st.id = v_key::uuid and st.sled_id = new.sled_id and st.deleted_at is null;
    if not found then
      raise exception 'That setting is not on this snowmobile.' using errcode = '23514';
    end if;
    v_value := case jsonb_typeof(v_entry)
      when 'object' then v_entry ->> 'value'
      when 'string' then v_entry #>> '{}'
      when 'number' then v_entry #>> '{}'
    end;
    v_value := btrim(v_value);
    if v_value is null or v_value = '' then
      continue; -- blank: left out of the snapshot
    end if;
    if char_length(v_value) > 200 then
      raise exception 'Setting values must be 200 characters or fewer.' using errcode = '22023';
    end if;
    if v_setting.value_type = 'number' and v_value !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception 'Enter a number for %.', v_setting.name using errcode = '22023';
    end if;
    v_values := v_values || jsonb_build_object(v_key, jsonb_build_object(
      'value', v_value, 'name', v_setting.name, 'zone', v_setting.zone,
      'unit', v_setting.unit, 'type', v_setting.value_type));
  end loop;
  new.setting_values := v_values;
  return new;
end;
$$;

-- Feedback: belongs to the revision's sled; not on a deleted revision; no future dates.
create function private.tg_suspension_feedback_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_revision record;
begin
  if tg_op = 'UPDATE' and new.revision_id is distinct from old.revision_id then
    raise exception 'Feedback cannot be moved to another revision.' using errcode = '42501';
  end if;
  select r.sled_id, r.deleted_at into v_revision from public.suspension_revisions r where r.id = new.revision_id;
  if not found then
    raise exception 'Revision not found.' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    new.sled_id := v_revision.sled_id;
    if v_revision.deleted_at is not null then
      raise exception 'Restore this setup before adding feedback.' using errcode = '42501';
    end if;
  end if;
  if new.ridden_on > current_date + 1
     and (tg_op = 'INSERT' or new.ridden_on is distinct from old.ridden_on) then
    raise exception 'The ride date cannot be in the future.' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- Photos: belong to their parent's sled and folder; reference photos only by
-- people who may customize settings; at most 6 active per parent.
create function private.tg_suspension_photos_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_id uuid := coalesce(new.setting_id, new.revision_id);
  v_sled uuid;
  v_deleted timestamptz;
begin
  if tg_op = 'UPDATE' and (new.setting_id is distinct from old.setting_id
     or new.revision_id is distinct from old.revision_id or new.path is distinct from old.path) then
    raise exception 'A photo cannot be moved.' using errcode = '42501';
  end if;

  if new.setting_id is not null then
    select st.sled_id, st.deleted_at into v_sled, v_deleted from public.suspension_settings st where st.id = new.setting_id;
  else
    select r.sled_id, r.deleted_at into v_sled, v_deleted from public.suspension_revisions r where r.id = new.revision_id;
  end if;
  if v_sled is null then
    raise exception 'Photo parent not found.' using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    new.sled_id := v_sled;
    if v_deleted is not null then
      raise exception 'Restore it before adding photos.' using errcode = '42501';
    end if;
    if new.setting_id is not null and auth.uid() is not null
       and not private.has_sled_permission(v_sled, 'edit_records') then
      raise exception 'Only the owner or an editor can add reference photos.' using errcode = '42501';
    end if;
  end if;
  if split_part(new.path, '/', 1) <> new.sled_id::text or split_part(new.path, '/', 2) <> v_parent_id::text then
    raise exception 'That photo is not in the right folder.' using errcode = '23514';
  end if;

  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_photos:' || v_parent_id::text, 0));
    if (select count(*) from public.suspension_photos p
        where coalesce(p.setting_id, p.revision_id) = v_parent_id and p.deleted_at is null and p.id <> new.id) >= 6 then
      raise exception 'At most 6 photos can be added here.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Setup deleted/restored: its revisions, their feedback and adjustment photos
-- follow (same timestamp, so a restore brings back exactly what went together).
create function private.tg_suspension_setups_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.suspension_revisions set deleted_at = new.deleted_at
      where setup_id = new.id and deleted_at is null;
    update public.suspension_feedback f set deleted_at = new.deleted_at
      from public.suspension_revisions r
      where f.revision_id = r.id and r.setup_id = new.id and f.deleted_at is null;
    update public.suspension_photos p set deleted_at = new.deleted_at
      from public.suspension_revisions r
      where p.revision_id = r.id and r.setup_id = new.id and p.deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.suspension_revisions set deleted_at = null
      where setup_id = new.id and deleted_at = old.deleted_at;
    update public.suspension_feedback f set deleted_at = null
      from public.suspension_revisions r
      where f.revision_id = r.id and r.setup_id = new.id and f.deleted_at = old.deleted_at;
    update public.suspension_photos p set deleted_at = null
      from public.suspension_revisions r
      where p.revision_id = r.id and r.setup_id = new.id and p.deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

-- Setting deleted/restored: its reference photos follow. (Revision snapshots
-- keep the setting's name, so history stays readable.)
create function private.tg_suspension_settings_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.suspension_photos set deleted_at = new.deleted_at
      where setting_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.suspension_photos set deleted_at = null
      where setting_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

revoke all on function
  private.tg_suspension_setups_check(),
  private.tg_suspension_revisions_check(),
  private.tg_suspension_feedback_check(),
  private.tg_suspension_photos_check(),
  private.tg_suspension_setups_cascade(),
  private.tg_suspension_settings_cascade()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Triggers (record-table pattern: guard, checks, stamp, cascades, audit)
-- -----------------------------------------------------------------------------
create trigger guard before insert or update on public.suspension_settings
  for each row execute function private.tg_sled_record_guard();
create trigger stamp before insert or update on public.suspension_settings
  for each row execute function private.tg_stamp();
create trigger cascade_photos after update on public.suspension_settings
  for each row execute function private.tg_suspension_settings_cascade();
create trigger audit after insert or update on public.suspension_settings
  for each row execute function private.tg_audit('maintenance');

create trigger guard before insert or update on public.suspension_setups
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.suspension_setups
  for each row execute function private.tg_suspension_setups_check();
create trigger stamp before insert or update on public.suspension_setups
  for each row execute function private.tg_stamp();
create trigger cascade_history after update on public.suspension_setups
  for each row execute function private.tg_suspension_setups_cascade();
create trigger audit after insert or update on public.suspension_setups
  for each row execute function private.tg_audit('maintenance');

create trigger guard before insert or update on public.suspension_revisions
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.suspension_revisions
  for each row execute function private.tg_suspension_revisions_check();
create trigger stamp before insert or update on public.suspension_revisions
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.suspension_revisions
  for each row execute function private.tg_audit('maintenance');

create trigger guard before insert or update on public.suspension_feedback
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.suspension_feedback
  for each row execute function private.tg_suspension_feedback_check();
create trigger stamp before insert or update on public.suspension_feedback
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.suspension_feedback
  for each row execute function private.tg_audit('maintenance');

create trigger guard before insert or update on public.suspension_photos
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.suspension_photos
  for each row execute function private.tg_suspension_photos_check();
create trigger stamp before insert or update on public.suspension_photos
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.suspension_photos
  for each row execute function private.tg_audit('maintenance');

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security (never delete: Recently Deleted instead)
-- -----------------------------------------------------------------------------
revoke all on
  public.suspension_settings, public.suspension_setups, public.suspension_revisions,
  public.suspension_feedback, public.suspension_photos
from anon, authenticated;
grant select, insert, update on
  public.suspension_settings, public.suspension_setups, public.suspension_revisions,
  public.suspension_feedback, public.suspension_photos
to authenticated;

alter table public.suspension_settings enable row level security;
alter table public.suspension_setups enable row level security;
alter table public.suspension_revisions enable row level security;
alter table public.suspension_feedback enable row level security;
alter table public.suspension_photos enable row level security;

-- Settings and setups: everyone on the sled sees them; owners and editors manage them.
create policy "Sled users can view suspension settings"
  on public.suspension_settings for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners and editors can add suspension settings"
  on public.suspension_settings for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'edit_records'));
create policy "Owners and editors can edit suspension settings"
  on public.suspension_settings for update to authenticated
  using (private.has_sled_permission(sled_id, 'edit_records'))
  with check (private.has_sled_permission(sled_id, 'edit_records'));

create policy "Sled users can view suspension setups"
  on public.suspension_setups for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners and editors can add suspension setups"
  on public.suspension_setups for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'edit_records'));
create policy "Owners and editors can edit suspension setups"
  on public.suspension_setups for update to authenticated
  using (private.has_sled_permission(sled_id, 'edit_records'))
  with check (private.has_sled_permission(sled_id, 'edit_records'));

-- Revisions: owners, editors and mechanics record them; only owners and
-- editors can move them (with their setup) to Recently Deleted and back.
create policy "Sled users can view suspension revisions"
  on public.suspension_revisions for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can record suspension revisions"
  on public.suspension_revisions for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Owners and editors can delete and restore suspension revisions"
  on public.suspension_revisions for update to authenticated
  using (private.has_sled_permission(sled_id, 'soft_delete_records'))
  with check (private.has_sled_permission(sled_id, 'soft_delete_records'));

create policy "Sled users can view suspension feedback"
  on public.suspension_feedback for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add suspension feedback"
  on public.suspension_feedback for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit suspension feedback"
  on public.suspension_feedback for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view suspension photos"
  on public.suspension_photos for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add suspension photos"
  on public.suspension_photos for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit suspension photos"
  on public.suspension_photos for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

-- -----------------------------------------------------------------------------
-- Private bucket for suspension photos
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('suspension-photos', 'suspension-photos', false, 5242880, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The parent (setting or revision) id an object belongs to, or null if the
-- name is not a valid suspension photo path (such objects match no policy).
create function private.suspension_photo_parent_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
    then split_part(p_name, '/', 2)::uuid
  end;
$$;

-- The sled a suspension photo object belongs to: its parent's sled, which must
-- also be the sled named in the path.
create function private.suspension_photo_sled_id(p_name text)
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

-- Whether the caller may add files to this folder: reference photos (setting)
-- for owners and editors; adjustment photos (revision) for owners, editors and
-- mechanics. The parent must not be in Recently Deleted.
create function private.can_add_suspension_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.suspension_settings st
    where st.id = private.suspension_photo_parent_id(p_name)
      and st.sled_id::text = split_part(p_name, '/', 1)
      and st.deleted_at is null
      and private.has_sled_permission(st.sled_id, 'edit_records')
  ) or exists (
    select 1 from public.suspension_revisions r
    where r.id = private.suspension_photo_parent_id(p_name)
      and r.sled_id::text = split_part(p_name, '/', 1)
      and r.deleted_at is null
      and private.has_sled_permission(r.sled_id, 'add_records')
  );
$$;

revoke all on function
  private.suspension_photo_parent_id(text),
  private.suspension_photo_sled_id(text),
  private.can_add_suspension_photo(text)
from public, anon;
grant execute on function
  private.suspension_photo_parent_id(text),
  private.suspension_photo_sled_id(text),
  private.can_add_suspension_photo(text)
to authenticated;

create policy "SledWerx suspension photos: sled users can view"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'suspension-photos'
    and private.has_sled_permission(private.suspension_photo_sled_id(name), 'view')
  );

create policy "SledWerx suspension photos: permitted users can upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'suspension-photos'
    and private.can_add_suspension_photo(name)
  );

create policy "SledWerx suspension photos: owners and editors can remove"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'suspension-photos'
    and private.has_sled_permission(private.suspension_photo_sled_id(name), 'soft_delete_records')
  );

-- -----------------------------------------------------------------------------
-- Functions (SECURITY INVOKER: the caller's RLS and every trigger apply)
-- -----------------------------------------------------------------------------

-- Values of a revision, kept only for settings that still exist, as
-- {"<setting id>": "<value>"} (the shape the revision trigger accepts).
create function private.suspension_current_values(p_values jsonb, p_sled_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(v.key, v.value -> 'value'), '{}'::jsonb)
  from jsonb_each(coalesce(p_values, '{}'::jsonb)) v
  join public.suspension_settings st
    on st.id::text = v.key and st.sled_id = p_sled_id and st.deleted_at is null;
$$;

revoke all on function private.suspension_current_values(jsonb, uuid) from public, anon;
grant execute on function private.suspension_current_values(jsonb, uuid) to authenticated;

-- Create a setup with its first revision: blank, or copying another revision
-- of the same sled. Owners and editors (RLS on suspension_setups).
create function public.create_suspension_setup(
  p_sled_id uuid,
  p_name text,
  p_notes text default null,
  p_copy_from_revision_id uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_setup_id uuid;
  v_revision_id uuid;
  v_values jsonb := '{}'::jsonb;
  v_source record;
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage suspension setups.' using errcode = '42501';
  end if;
  if p_copy_from_revision_id is not null then
    select r.setting_values, r.sled_id, r.deleted_at into v_source
    from public.suspension_revisions r where r.id = p_copy_from_revision_id;
    if not found or v_source.sled_id <> p_sled_id or v_source.deleted_at is not null then
      raise exception 'That revision can''t be copied to this snowmobile.' using errcode = '23514';
    end if;
    v_values := private.suspension_current_values(v_source.setting_values, p_sled_id);
  end if;

  insert into public.suspension_setups (sled_id, name, notes)
  values (p_sled_id, btrim(p_name), nullif(btrim(p_notes), ''))
  returning id into v_setup_id;

  insert into public.suspension_revisions (setup_id, sled_id, revision_number, setting_values, note)
  values (v_setup_id, p_sled_id, 1, v_values, case when p_copy_from_revision_id is null then 'Created' else 'Created as a copy' end)
  returning id into v_revision_id;

  return jsonb_build_object('setup_id', v_setup_id, 'revision_id', v_revision_id);
end;
$$;

-- Make a setup the active one for its sled (the previous one becomes
-- inactive). Owners and editors. Serialized per sled.
create function public.activate_suspension_setup(p_setup_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_setup record;
  v_rows integer;
begin
  select s.sled_id, s.deleted_at into v_setup from public.suspension_setups s where s.id = p_setup_id;
  if not found then
    raise exception 'Setup not found.' using errcode = 'P0002';
  end if;
  if v_setup.deleted_at is not null then
    raise exception 'Restore this setup before making it active.' using errcode = '42501';
  end if;
  if not private.has_sled_permission(v_setup.sled_id, 'edit_records') then
    raise exception 'Only the owner or an editor can change the active setup.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_active:' || v_setup.sled_id::text, 0));
  update public.suspension_setups set is_active = false
    where sled_id = v_setup.sled_id and is_active and id <> p_setup_id;
  update public.suspension_setups set is_active = true
    where id = p_setup_id and not is_active;
  get diagnostics v_rows = row_count;
  if v_rows = 0 and not exists (select 1 from public.suspension_setups where id = p_setup_id and is_active) then
    raise exception 'Only the owner or an editor can change the active setup.' using errcode = '42501';
  end if;
end;
$$;

-- Record an adjustment: the latest revision's values with only the given
-- changes applied ({"<setting id>": "<value>" or null to clear}). Refused if
-- someone else saved a revision since p_base_revision_id. Owners, editors and
-- mechanics. A repeat with the same idempotency key returns the saved one.
create function public.save_suspension_revision(
  p_setup_id uuid,
  p_base_revision_id uuid,
  p_changes jsonb,
  p_note text default null,
  p_odometer_mi numeric default null,
  p_engine_hours numeric default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing record;
  v_latest record;
  v_sled uuid;
  v_values jsonb;
  v_revision record;
begin
  if v_uid is null then
    raise exception 'Sign in to record suspension changes.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Changes must be an object.' using errcode = '22023';
  end if;

  select r.id, r.revision_number into v_existing
  from public.suspension_revisions r where r.created_by = v_uid and r.client_request_id = p_idempotency_key;
  if found then
    return jsonb_build_object('revision_id', v_existing.id, 'revision_number', v_existing.revision_number, 'duplicate', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_setup:' || p_setup_id::text, 0));

  select s.sled_id into v_sled from public.suspension_setups s where s.id = p_setup_id and s.deleted_at is null;
  if v_sled is null then
    raise exception 'Setup not found.' using errcode = 'P0002';
  end if;
  select r.id, r.setting_values into v_latest
  from public.suspension_revisions r
  where r.setup_id = p_setup_id
  order by r.revision_number desc limit 1;
  if v_latest.id is distinct from p_base_revision_id then
    raise exception 'This setup was changed by someone else. Reload it and try again.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;

  -- Carry every unchanged value forward; apply the changes (null or "" clears).
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_values
  from (
    select key as k, value as v from jsonb_each(private.suspension_current_values(v_latest.setting_values, v_sled))
    where not p_changes ? key
    union all
    select key, to_jsonb(btrim(value #>> '{}')) from jsonb_each(p_changes)
    where jsonb_typeof(value) in ('string', 'number') and btrim(value #>> '{}') <> ''
  ) merged;

  if v_values = private.suspension_current_values(v_latest.setting_values, v_sled) then
    raise exception 'Nothing changed.' using errcode = '22023';
  end if;

  insert into public.suspension_revisions (
    setup_id, sled_id, revision_number, setting_values, note, odometer_mi, engine_hours, client_request_id
  ) values (
    p_setup_id, v_sled, 1, v_values, nullif(btrim(p_note), ''), p_odometer_mi, p_engine_hours, p_idempotency_key
  )
  returning id, revision_number into v_revision;

  return jsonb_build_object('revision_id', v_revision.id, 'revision_number', v_revision.revision_number, 'duplicate', false);
end;
$$;

-- Restore an earlier revision: a NEW revision of the same setup with that
-- revision's values (for settings that still exist). Nothing is erased.
-- Owners, editors and mechanics.
create function public.restore_suspension_revision(
  p_revision_id uuid,
  p_note text default null,
  p_odometer_mi numeric default null,
  p_engine_hours numeric default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing record;
  v_source record;
  v_latest jsonb;
  v_values jsonb;
  v_revision record;
begin
  if v_uid is null then
    raise exception 'Sign in to restore suspension revisions.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;

  select r.id, r.revision_number into v_existing
  from public.suspension_revisions r where r.created_by = v_uid and r.client_request_id = p_idempotency_key;
  if found then
    return jsonb_build_object('revision_id', v_existing.id, 'revision_number', v_existing.revision_number, 'duplicate', true);
  end if;

  select r.setup_id, r.sled_id, r.setting_values, r.revision_number, r.deleted_at into v_source
  from public.suspension_revisions r where r.id = p_revision_id;
  if not found or v_source.deleted_at is not null then
    raise exception 'Revision not found.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_setup:' || v_source.setup_id::text, 0));

  v_values := private.suspension_current_values(v_source.setting_values, v_source.sled_id);
  select private.suspension_current_values(r.setting_values, r.sled_id) into v_latest
  from public.suspension_revisions r where r.setup_id = v_source.setup_id
  order by r.revision_number desc limit 1;
  if v_values = v_latest then
    raise exception 'The latest revision already has these values.' using errcode = '22023';
  end if;

  insert into public.suspension_revisions (
    setup_id, sled_id, revision_number, setting_values, note, odometer_mi, engine_hours,
    restored_from_revision_id, client_request_id
  ) values (
    v_source.setup_id, v_source.sled_id, 1, v_values,
    coalesce(nullif(btrim(p_note), ''), 'Restored revision ' || v_source.revision_number),
    p_odometer_mi, p_engine_hours, p_revision_id, p_idempotency_key
  )
  returning id, revision_number into v_revision;

  return jsonb_build_object('revision_id', v_revision.id, 'revision_number', v_revision.revision_number, 'duplicate', false);
end;
$$;

revoke all on function
  public.create_suspension_setup(uuid, text, text, uuid),
  public.activate_suspension_setup(uuid),
  public.save_suspension_revision(uuid, uuid, jsonb, text, numeric, numeric, uuid),
  public.restore_suspension_revision(uuid, text, numeric, numeric, uuid)
from public, anon;
grant execute on function
  public.create_suspension_setup(uuid, text, text, uuid),
  public.activate_suspension_setup(uuid),
  public.save_suspension_revision(uuid, uuid, jsonb, text, numeric, numeric, uuid),
  public.restore_suspension_revision(uuid, text, numeric, numeric, uuid)
to authenticated;
