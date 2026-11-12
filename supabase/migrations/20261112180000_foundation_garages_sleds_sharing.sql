-- =============================================================================
-- SledWerx 1.0 — Migration 1: secure foundation
--
-- Creates: user profiles and preferences, garages, snowmobiles (sleds),
-- per-sled sharing (shares + invitations), the audit log, the 30-day
-- Recently Deleted rules, and row versioning for offline conflict detection.
--
-- Later modules (maintenance, reminders, parts, suspension, ride logs,
-- attachments, community library, sync conflicts) build on the helper
-- functions defined here, chiefly private.has_sled_permission().
--
-- Conventions used by this and later migrations:
--   * Every user-data table has: id (uuid, may be generated on the device for
--     offline creation), created_at/created_by, updated_at/updated_by, and
--     version. These are maintained by private.tg_stamp() and cannot be set
--     by clients.
--   * Offline conflicts: clients send the version they last saw in every
--     update (`version: knownVersion`). If the row has changed since, the
--     update fails with error code PT409 (HTTP 409 through the API) instead
--     of overwriting newer data.
--     Updates that change nothing do not bump the version.
--   * User-facing records are soft-deleted (deleted_at) and recoverable for
--     30 days; see private.recovery_window().
--   * US units in 1.0, stored in the column's named unit (e.g. *_mi, *_in,
--     *_f) so a metric display can convert later without data changes.
--   * No table is readable or writable by the anon role.
--   * Actor columns (created_by, updated_by, deleted_by, revoked_by,
--     accepted_by, audit_log.actor_id) are plain uuids without foreign keys:
--     deleting an account must not rewrite other owners' records. Once the
--     account and profile are gone, the id no longer identifies anyone.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Private schema: helper functions that RLS policies call. Not exposed through
-- the Supabase Data API (only schemas listed in the API settings are).
-- -----------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
create type public.sled_status as enum (
  'ready',
  'needs_attention',
  'out_of_service',
  'stored'
);

-- The owner role is not stored as a share: the owner of a sled is the owner of
-- its garage (sleds.owner_id). Shares grant one of these three roles.
create type public.sled_share_role as enum ('editor', 'mechanic', 'viewer');

create type public.theme_preference as enum ('dark', 'light');

-- -----------------------------------------------------------------------------
-- Shared trigger functions
-- -----------------------------------------------------------------------------

-- How long soft-deleted records stay recoverable.
create function private.recovery_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

-- Maintains id/created_*/updated_*/version. Clients cannot forge these.
-- On update, a version that differs from the stored one means the client
-- edited an out-of-date copy: reject it rather than overwrite newer data.
create function private.tg_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_meta constant text[] := array['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'];
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
    new.version := 1;
    return new;
  end if;

  if new.version is distinct from old.version then
    raise exception 'This record was changed elsewhere. Reload it and try again.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;

  new.id := old.id;
  new.created_at := old.created_at;
  new.created_by := old.created_by;

  -- Nothing changed: keep the version so other devices see no conflict.
  if (to_jsonb(new) - v_meta) = (to_jsonb(old) - v_meta) then
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    return new;
  end if;

  new.updated_at := now();
  new.updated_by := auth.uid();
  new.version := old.version + 1;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles: display information. Visible to the user and to people they
-- share a sled with. Contains no email or private preferences.
-- (Public rider profiles for the community library come in a later migration
-- as a separate, opt-in table.)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

-- -----------------------------------------------------------------------------
-- user_preferences: private to the user (theme, dashboard, Garage Mode).
-- -----------------------------------------------------------------------------
create table public.user_preferences (
  id uuid primary key references auth.users (id) on delete cascade,
  theme public.theme_preference not null default 'dark',
  dashboard jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dashboard) = 'object' and pg_column_size(dashboard) <= 16384),
  garage_mode jsonb not null default '{}'::jsonb
    check (jsonb_typeof(garage_mode) = 'object' and pg_column_size(garage_mode) <= 16384),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

-- -----------------------------------------------------------------------------
-- garages: private to their owner. Never visible to people a sled is shared
-- with. Every user gets one default garage at sign-up.
-- -----------------------------------------------------------------------------
create table public.garages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  is_default boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create unique index garages_one_default_per_owner
  on public.garages (owner_id) where is_default;
create index garages_owner_id_idx on public.garages (owner_id);

-- -----------------------------------------------------------------------------
-- sleds: snowmobiles. owner_id always equals the garage owner (kept in sync
-- by trigger) so permission checks do not need a join.
-- Mileage/odometer history arrives with the maintenance migration as its own
-- table, so engine and odometer replacements never overwrite history.
-- Photos arrive with the attachments migration.
-- -----------------------------------------------------------------------------
create table public.sleds (
  id uuid primary key default gen_random_uuid(),
  -- No cascade: a garage can only be removed once it has no sleds. (Account
  -- deletion removes sleds through owner_id in the same statement.)
  garage_id uuid not null references public.garages (id),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model_year smallint not null check (model_year between 1950 and 2100),
  make text not null check (char_length(btrim(make)) between 1 and 60),
  model text not null check (char_length(btrim(model)) between 1 and 80),
  nickname text check (char_length(btrim(nickname)) between 1 and 60),
  vin text check (char_length(btrim(vin)) between 1 and 32),
  engine_description text check (char_length(engine_description) <= 200),
  engine_displacement_cc integer check (engine_displacement_cc between 1 and 3000),
  purchase_date date,
  status public.sled_status not null default 'ready',
  notes text check (char_length(notes) <= 10000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create index sleds_garage_id_idx on public.sleds (garage_id);
create index sleds_owner_id_updated_at_idx on public.sleds (owner_id, updated_at);

-- -----------------------------------------------------------------------------
-- sled_invitations: pending invitations to share one sled. Only a SHA-256
-- hash of the invitation token is stored; the token itself is returned once
-- to the owner by create_sled_invitation().
-- -----------------------------------------------------------------------------
create table public.sled_invitations (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  email text not null check (
    email = lower(btrim(email))
    and char_length(email) <= 254
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  role public.sled_share_role not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (not (accepted_at is not null and revoked_at is not null))
);

create unique index sled_invitations_one_pending_per_email
  on public.sled_invitations (sled_id, email)
  where accepted_at is null and revoked_at is null;
create index sled_invitations_sled_id_idx on public.sled_invitations (sled_id);

-- -----------------------------------------------------------------------------
-- sled_shares: who has access to which sled, and with which role.
-- Revoked shares are kept (revoked_at) so offline devices learn about the
-- revocation and remove cached data; they are purged after 30 days.
-- -----------------------------------------------------------------------------
create table public.sled_shares (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.sled_share_role not null,
  invitation_id uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create unique index sled_shares_one_active_per_user
  on public.sled_shares (sled_id, user_id) where revoked_at is null;
create index sled_shares_user_id_updated_at_idx on public.sled_shares (user_id, updated_at);
create index sled_shares_sled_id_idx on public.sled_shares (sled_id);

-- -----------------------------------------------------------------------------
-- audit_log: append-only change history, written only by triggers.
-- Readable by the owner of the garage/sled it belongs to; nobody can modify
-- it through the API. History for a sled is removed when the sled is
-- permanently deleted or the owner's account is deleted.
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  action text not null check (action in ('insert', 'update')),
  table_name text not null,
  record_id uuid not null,
  garage_id uuid references public.garages (id) on delete cascade,
  sled_id uuid references public.sleds (id) on delete cascade,
  changed_fields text[],
  old_data jsonb,
  new_data jsonb,
  check (num_nonnulls(garage_id, sled_id) = 1)
);

create index audit_log_sled_id_idx on public.audit_log (sled_id, occurred_at desc);
create index audit_log_garage_id_idx on public.audit_log (garage_id, occurred_at desc);
create index audit_log_record_idx on public.audit_log (table_name, record_id, occurred_at desc);
create index audit_log_actor_id_idx on public.audit_log (actor_id);

-- -----------------------------------------------------------------------------
-- Permission helpers (SECURITY DEFINER so policies do not recurse through
-- each other's RLS). All read auth.uid() and never trust client input for
-- identity.
-- -----------------------------------------------------------------------------

-- Sleds owned by the current user, including ones in Recently Deleted.
create function private.owned_sled_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.sleds s where s.owner_id = (select auth.uid());
$$;

create function private.owned_garage_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select g.id from public.garages g where g.owner_id = (select auth.uid());
$$;

-- Sleds shared with the current user through an active share, optionally
-- limited to some roles. Sleds in Recently Deleted are excluded.
create function private.shared_sled_ids(p_roles public.sled_share_role[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sh.sled_id
  from public.sled_shares sh
  join public.sleds s on s.id = sh.sled_id
  where sh.user_id = (select auth.uid())
    and sh.revoked_at is null
    and s.deleted_at is null
    and (p_roles is null or sh.role = any (p_roles));
$$;

-- The current user's role on a sled: 'owner', 'editor', 'mechanic',
-- 'viewer', or null for no access.
create function private.sled_role(p_sled_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when s.owner_id = (select auth.uid()) then 'owner'
    when s.deleted_at is null then (
      select sh.role::text
      from public.sled_shares sh
      where sh.sled_id = s.id
        and sh.user_id = (select auth.uid())
        and sh.revoked_at is null
    )
  end
  from public.sleds s
  where s.id = p_sled_id;
$$;

-- Single source of truth for role permissions. Later migrations' RLS
-- policies call this instead of repeating role lists.
--
--   permission            owner editor mechanic viewer
--   view                    x     x       x       x
--   edit_sled               x     x
--   add_records             x     x       x
--   edit_records            x     x
--   soft_delete_records     x     x
--   restore_records         x     x
--   manage_sled             x                         (delete/restore sled,
--                                                      permanent delete,
--                                                      sharing, ownership)
--
--   While a sled is in Recently Deleted, only view and manage_sled apply.
create function private.has_sled_permission(p_sled_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.sled_role(p_sled_id);
  v_sled_deleted boolean := exists (
    select 1 from public.sleds s where s.id = p_sled_id and s.deleted_at is not null
  );
begin
  case p_permission
    when 'view' then
      return v_role is not null;
    when 'manage_sled' then
      return coalesce(v_role = 'owner', false);
    when 'edit_sled', 'edit_records', 'soft_delete_records', 'restore_records' then
      -- A sled in Recently Deleted is read-only until it is restored.
      return coalesce(v_role in ('owner', 'editor'), false) and not v_sled_deleted;
    when 'add_records' then
      return coalesce(v_role in ('owner', 'editor', 'mechanic'), false) and not v_sled_deleted;
    else
      raise exception 'unknown sled permission: %', p_permission
        using errcode = '22023';
  end case;
end;
$$;

-- Users whose display name the current user may see: owners of sleds shared
-- with them, and people they share their own sleds with.
create function private.connected_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.owner_id
  from public.sled_shares sh
  join public.sleds s on s.id = sh.sled_id
  where sh.user_id = (select auth.uid())
    and sh.revoked_at is null
    and s.deleted_at is null
  union
  select sh.user_id
  from public.sled_shares sh
  join public.sleds s on s.id = sh.sled_id
  where s.owner_id = (select auth.uid())
    and sh.revoked_at is null;
$$;

revoke all on all functions in schema private from public;
grant execute on function
  private.owned_sled_ids(),
  private.owned_garage_ids(),
  private.shared_sled_ids(public.sled_share_role[]),
  private.sled_role(uuid),
  private.has_sled_permission(uuid, text),
  private.connected_user_ids(),
  private.recovery_window()
to authenticated;

-- -----------------------------------------------------------------------------
-- Guard triggers: rules that RLS cannot express (immutable owners, who may
-- delete/restore, the 30-day recovery window).
-- A null auth.uid() means a trusted server context (migration, signup
-- trigger, service role, maintenance function); anon has no table access.
-- -----------------------------------------------------------------------------
create function private.tg_garages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new.owner_id := v_uid;
      new.is_default := false;
    end if;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  new.owner_id := old.owner_id;
  new.is_default := old.is_default;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is null then
      if old.is_default then
        raise exception 'The default garage cannot be deleted.' using errcode = '42501';
      end if;
      if exists (
        select 1 from public.sleds s where s.garage_id = old.id and s.deleted_at is null
      ) then
        raise exception 'Move or delete the snowmobiles in this garage first.'
          using errcode = '23503';
      end if;
      new.deleted_at := now();
      new.deleted_by := v_uid;
    elsif new.deleted_at is null then
      if old.deleted_at < now() - private.recovery_window() then
        raise exception 'This garage is past the 30-day recovery period.' using errcode = '42501';
      end if;
      new.deleted_by := null;
    else
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
  else
    new.deleted_by := old.deleted_by;
    if old.deleted_at is not null and v_uid is not null then
      raise exception 'Restore this garage before editing it.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create function private.tg_sleds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_garage_owner uuid;
begin
  if tg_op = 'INSERT' then
    -- Runs with the caller's RLS: a user only sees their own garages.
    select g.owner_id into v_garage_owner
    from public.garages g
    where g.id = new.garage_id and g.deleted_at is null;

    if v_garage_owner is null then
      raise exception 'Garage not found.' using errcode = '23503';
    end if;

    new.owner_id := v_garage_owner;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  -- Ownership changes only through a dedicated transfer function (future).
  new.owner_id := old.owner_id;

  if old.deleted_at is not null and new.deleted_at is not null and v_uid is not null then
    raise exception 'Restore this snowmobile before editing it.' using errcode = '42501';
  end if;

  if new.garage_id is distinct from old.garage_id then
    if v_uid is not null and v_uid is distinct from old.owner_id then
      raise exception 'Only the owner can move a snowmobile.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.garages g
      where g.id = new.garage_id and g.owner_id = old.owner_id and g.deleted_at is null
    ) then
      raise exception 'Garage not found.' using errcode = '23503';
    end if;
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if v_uid is not null and v_uid is distinct from old.owner_id then
      raise exception 'Only the owner can delete or restore a snowmobile.' using errcode = '42501';
    end if;
    if old.deleted_at is null then
      new.deleted_at := now();
      new.deleted_by := v_uid;
    elsif new.deleted_at is null then
      if old.deleted_at < now() - private.recovery_window() then
        raise exception 'This snowmobile is past the 30-day recovery period.' using errcode = '42501';
      end if;
      if exists (
        select 1 from public.garages g where g.id = new.garage_id and g.deleted_at is not null
      ) then
        raise exception 'Restore the garage first, or move the snowmobile to another garage.'
          using errcode = '42501';
      end if;
      new.deleted_by := null;
    else
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
  else
    new.deleted_by := old.deleted_by;
  end if;

  return new;
end;
$$;

-- Shares and invitations change only through the functions below; these
-- guards keep their identifying columns immutable even for trusted callers.
create function private.tg_sharing_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_column text;
begin
  -- Columns that identify who/what a share or invitation is for.
  foreach v_column in array case tg_table_name
    when 'sled_shares' then array['sled_id', 'user_id', 'invitation_id']
    else array['sled_id', 'email', 'role', 'token_hash', 'expires_at']
  end loop
    if v_new -> v_column is distinct from v_old -> v_column then
      raise exception '% cannot be changed.', v_column using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit trigger. Records inserts and updates (soft deletes and restores are
-- updates). Never stores invitation token hashes. Skips no-op updates.
-- -----------------------------------------------------------------------------
create function private.tg_audit()
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
    actor_id, action, table_name, record_id, garage_id, sled_id,
    changed_fields, old_data, new_data
  ) values (
    auth.uid(), lower(tg_op), tg_table_name, (v_row ->> 'id')::uuid, v_garage_id, v_sled_id,
    v_changed, v_old, v_new
  );

  return null;
end;
$$;

revoke all on function
  private.tg_stamp(),
  private.tg_garages_guard(),
  private.tg_sleds_guard(),
  private.tg_sharing_guard(),
  private.tg_audit()
from public;

-- -----------------------------------------------------------------------------
-- Attach triggers
-- -----------------------------------------------------------------------------
create trigger stamp before insert or update on public.profiles
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.user_preferences
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.garages
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.sleds
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.sled_invitations
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.sled_shares
  for each row execute function private.tg_stamp();

create trigger guard before insert or update on public.garages
  for each row execute function private.tg_garages_guard();
create trigger guard before insert or update on public.sleds
  for each row execute function private.tg_sleds_guard();
create trigger guard before update on public.sled_invitations
  for each row execute function private.tg_sharing_guard();
create trigger guard before update on public.sled_shares
  for each row execute function private.tg_sharing_guard();

create trigger audit after insert or update on public.garages
  for each row execute function private.tg_audit();
create trigger audit after insert or update on public.sleds
  for each row execute function private.tg_audit();
create trigger audit after insert or update on public.sled_invitations
  for each row execute function private.tg_audit();
create trigger audit after insert or update on public.sled_shares
  for each row execute function private.tg_audit();

-- -----------------------------------------------------------------------------
-- Table privileges. Supabase grants everything to anon/authenticated by
-- default; narrow that to exactly what the policies below allow.
-- -----------------------------------------------------------------------------
revoke all on public.profiles, public.user_preferences, public.garages, public.sleds,
  public.sled_invitations, public.sled_shares, public.audit_log
  from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.user_preferences to authenticated;
grant select, insert, update on public.garages to authenticated;
grant select, insert, update on public.sleds to authenticated;
grant select on public.sled_invitations to authenticated;
grant select on public.sled_shares to authenticated;
grant select on public.audit_log to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.garages enable row level security;
alter table public.sleds enable row level security;
alter table public.sled_invitations enable row level security;
alter table public.sled_shares enable row level security;
alter table public.audit_log enable row level security;

-- profiles
create policy "Users can view their own and connected profiles"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or id in (select private.connected_user_ids())
  );
create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- user_preferences
create policy "Users can view their own preferences"
  on public.user_preferences for select to authenticated
  using (id = (select auth.uid()));
create policy "Users can create their own preferences"
  on public.user_preferences for insert to authenticated
  with check (id = (select auth.uid()));
create policy "Users can update their own preferences"
  on public.user_preferences for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- garages: owner only (shared users never see the garage)
create policy "Owners can view their garages"
  on public.garages for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Users can create garages"
  on public.garages for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Owners can update their garages"
  on public.garages for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- sleds
create policy "Owners and shared users can view sleds"
  on public.sleds for select to authenticated
  using (
    owner_id = (select auth.uid())
    or id in (select private.shared_sled_ids())
  );
create policy "Owners can add sleds to their garages"
  on public.sleds for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Owners and editors can update sleds"
  on public.sleds for update to authenticated
  using (
    owner_id = (select auth.uid())
    or id in (select private.shared_sled_ids(array['editor']::public.sled_share_role[]))
  )
  with check (
    owner_id = (select auth.uid())
    or id in (select private.shared_sled_ids(array['editor']::public.sled_share_role[]))
  );
-- No DELETE policy: sleds are soft-deleted; permanent deletion is
-- permanently_delete_sled() or the cleanup function.

-- sled_invitations: visible to the sled owner; written only by functions
create policy "Owners can view invitations for their sleds"
  on public.sled_invitations for select to authenticated
  using (sled_id in (select private.owned_sled_ids()));

-- sled_shares: visible to the sled owner and to the shared user (including
-- their revoked shares, so their devices can clear cached data)
create policy "Owners and recipients can view shares"
  on public.sled_shares for select to authenticated
  using (
    user_id = (select auth.uid())
    or sled_id in (select private.owned_sled_ids())
  );

-- audit_log: readable by the owner of the sled or garage; no write policies
create policy "Owners can view audit history"
  on public.audit_log for select to authenticated
  using (
    sled_id in (select private.owned_sled_ids())
    or garage_id in (select private.owned_garage_ids())
  );

-- -----------------------------------------------------------------------------
-- Sharing functions (the only way to create or change shares)
-- -----------------------------------------------------------------------------

-- Owner invites someone by email. Returns the one-time token to build the
-- invitation link; only its hash is stored. Email delivery is not part of
-- 1.0 (the app shows the link to copy).
create function public.create_sled_invitation(
  p_sled_id uuid,
  p_email text,
  p_role public.sled_share_role,
  p_expires_in_days integer default 7
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(p_email));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_uid is null or not private.has_sled_permission(p_sled_id, 'manage_sled') then
    raise exception 'Only the owner can share this snowmobile.' using errcode = '42501';
  end if;
  if exists (select 1 from public.sleds s where s.id = p_sled_id and s.deleted_at is not null) then
    raise exception 'Restore this snowmobile before sharing it.' using errcode = '42501';
  end if;
  if p_role is null then
    raise exception 'A role is required.' using errcode = '22023';
  end if;
  if p_expires_in_days is null or p_expires_in_days not between 1 and 30 then
    raise exception 'Invitations must expire within 1 to 30 days.' using errcode = '22023';
  end if;
  if v_email is null or v_email = '' then
    raise exception 'An email address is required.' using errcode = '22023';
  end if;
  if v_email = (select lower(u.email) from auth.users u where u.id = v_uid) then
    raise exception 'You already own this snowmobile.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.sled_shares sh
    join auth.users u on u.id = sh.user_id
    where sh.sled_id = p_sled_id and sh.revoked_at is null and lower(u.email) = v_email
  ) then
    raise exception 'This person already has access to this snowmobile.' using errcode = '23505';
  end if;
  if (
    select count(*) from public.sled_invitations i
    where i.sled_id = p_sled_id and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > now()
  ) >= 25 then
    raise exception 'Too many pending invitations for this snowmobile.' using errcode = '54000';
  end if;

  -- Replace any earlier pending invitation for the same email.
  update public.sled_invitations i
  set revoked_at = now(), revoked_by = v_uid
  where i.sled_id = p_sled_id and i.email = v_email
    and i.accepted_at is null and i.revoked_at is null;

  -- 244 random bits from two v4 UUIDs (gen_random_uuid uses a CSPRNG).
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(days => p_expires_in_days);

  insert into public.sled_invitations (sled_id, email, role, token_hash, expires_at)
  values (p_sled_id, v_email, p_role, sha256(convert_to(v_token, 'UTF8')), v_expires)
  returning id into v_id;

  return query select v_id, v_token, v_expires;
end;
$$;

create function public.revoke_sled_invitation(p_invitation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sled_id uuid;
begin
  select i.sled_id into v_sled_id
  from public.sled_invitations i
  where i.id = p_invitation_id and i.accepted_at is null and i.revoked_at is null;

  if v_sled_id is null or not private.has_sled_permission(v_sled_id, 'manage_sled') then
    raise exception 'Invitation not found.' using errcode = 'P0002';
  end if;

  update public.sled_invitations
  set revoked_at = now(), revoked_by = auth.uid()
  where id = p_invitation_id;
end;
$$;

-- The invited person accepts with the token. Their account email must match
-- the invitation and be confirmed. Errors are deliberately generic.
create function public.accept_sled_invitation(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.sled_invitations%rowtype;
  v_user_email text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    raise exception 'Sign in to accept this invitation.' using errcode = '42501';
  end if;

  select * into v_inv
  from public.sled_invitations i
  where i.token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
  for update;

  select lower(u.email), u.email_confirmed_at into v_user_email, v_confirmed
  from auth.users u where u.id = v_uid;

  if v_inv.id is null
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or v_inv.email is distinct from v_user_email
     or v_confirmed is null
     or exists (
       select 1 from public.sleds s
       where s.id = v_inv.sled_id and (s.deleted_at is not null or s.owner_id = v_uid)
     )
  then
    raise exception 'This invitation is invalid or has expired.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.sled_shares sh
    where sh.sled_id = v_inv.sled_id and sh.user_id = v_uid and sh.revoked_at is null
  ) then
    raise exception 'You already have access to this snowmobile.' using errcode = '23505';
  end if;

  insert into public.sled_shares (sled_id, user_id, role, invitation_id)
  values (v_inv.sled_id, v_uid, v_inv.role, v_inv.id);

  update public.sled_invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id;

  return v_inv.sled_id;
end;
$$;

create function public.update_sled_share_role(p_share_id uuid, p_role public.sled_share_role)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sled_id uuid;
begin
  select sh.sled_id into v_sled_id
  from public.sled_shares sh
  where sh.id = p_share_id and sh.revoked_at is null;

  if v_sled_id is null or not private.has_sled_permission(v_sled_id, 'manage_sled') then
    raise exception 'Share not found.' using errcode = 'P0002';
  end if;
  if p_role is null then
    raise exception 'A role is required.' using errcode = '22023';
  end if;

  update public.sled_shares set role = p_role where id = p_share_id;
end;
$$;

-- The owner removes someone's access, or a shared user leaves.
create function public.revoke_sled_share(p_share_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_share public.sled_shares%rowtype;
begin
  select * into v_share
  from public.sled_shares sh
  where sh.id = p_share_id and sh.revoked_at is null;

  if v_share.id is null
     or v_uid is null
     or not (
       v_share.user_id = v_uid
       or exists (select 1 from public.sleds s where s.id = v_share.sled_id and s.owner_id = v_uid)
     )
  then
    raise exception 'Share not found.' using errcode = 'P0002';
  end if;

  update public.sled_shares
  set revoked_at = now(), revoked_by = v_uid
  where id = p_share_id;
end;
$$;

-- "Delete permanently" from Recently Deleted. Owner only; the sled must
-- already be in Recently Deleted. Removes the sled's shares, invitations and
-- audit history. (Attachment files are handled by the attachments migration.)
create function public.permanently_delete_sled(p_sled_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.has_sled_permission(p_sled_id, 'manage_sled') then
    raise exception 'Snowmobile not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.sleds s where s.id = p_sled_id and s.deleted_at is not null) then
    raise exception 'Move the snowmobile to Recently Deleted first.' using errcode = '42501';
  end if;

  delete from public.sleds where id = p_sled_id;
end;
$$;

revoke all on function
  public.create_sled_invitation(uuid, text, public.sled_share_role, integer),
  public.revoke_sled_invitation(uuid),
  public.accept_sled_invitation(text),
  public.update_sled_share_role(uuid, public.sled_share_role),
  public.revoke_sled_share(uuid),
  public.permanently_delete_sled(uuid)
from public, anon;

grant execute on function
  public.create_sled_invitation(uuid, text, public.sled_share_role, integer),
  public.revoke_sled_invitation(uuid),
  public.accept_sled_invitation(text),
  public.update_sled_share_role(uuid, public.sled_share_role),
  public.revoke_sled_share(uuid),
  public.permanently_delete_sled(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- Cleanup (not scheduled). Permanently removes records past the 30-day
-- recovery window, resolved invitations (which contain email addresses) and
-- old revoked shares. Run manually from the SQL editor, or schedule later
-- (for example with pg_cron) once approved. Not callable through the API.
-- -----------------------------------------------------------------------------
create function private.purge_expired_records()
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

-- -----------------------------------------------------------------------------
-- New users: profile, preferences and a default garage.
-- Account deletion (auth admin API, server side) cascades through every
-- table above via the auth.users foreign keys.
-- -----------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 80), '')
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (id)
  values (new.id)
  on conflict (id) do nothing;

  insert into public.garages (owner_id, name, is_default)
  select new.id, 'My Garage', true
  where not exists (select 1 from public.garages g where g.owner_id = new.id and g.is_default);

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Backfill for accounts that existed before this migration.
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;

insert into public.user_preferences (id)
select u.id from auth.users u
on conflict (id) do nothing;

insert into public.garages (owner_id, name, is_default)
select u.id, 'My Garage', true
from auth.users u
where not exists (select 1 from public.garages g where g.owner_id = u.id and g.is_default);
