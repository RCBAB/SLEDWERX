-- =============================================================================
-- SledWerx 1.0 — Migration 2: personal maintenance logbook
--
-- Builds on Migration 1 (20261112180000). Creates:
--   sled_readings            mileage / engine-hour history with reset events
--   maintenance_tasks        the user's task library, or tasks for one sled
--   maintenance_packages     reusable task lists (personal library, private)
--   maintenance_package_tasks
--   maintenance_plans        the owner's intervals: miles, engine hours, days
--   maintenance_entries      the logbook
--   maintenance_entry_tasks  what was done (checklist)
--   maintenance_entry_parts  parts used (USD)
-- plus the views sled_reading_history and maintenance_entry_costs, and
-- restore_record_version() for Decision 6.
--
-- A personal maintenance book: no shop workflows. Sharing uses Migration 1's
-- roles unchanged. Costs are USD; there is no currency configuration.
-- No built-in tasks or intervals: users create their own.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit log: personal-library rows (tasks and packages in a user's library)
-- belong to no sled or garage. They are scoped to their owner and readable
-- only by that owner.
-- -----------------------------------------------------------------------------
alter table public.audit_log
  add column library_owner_id uuid references auth.users (id) on delete cascade;
alter table public.audit_log drop constraint audit_log_check;
alter table public.audit_log
  add constraint audit_log_scope_check check (num_nonnulls(garage_id, sled_id, library_owner_id) = 1);
create index audit_log_library_owner_idx on public.audit_log (library_owner_id, occurred_at desc);

drop policy "Role-based access to audit history" on public.audit_log;
create policy "Role-based access to audit history"
  on public.audit_log for select to authenticated
  using (
    sled_id in (select private.owned_sled_ids())
    or garage_id in (select private.owned_garage_ids())
    or library_owner_id = (select auth.uid())
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

-- Same as Migration 1, plus: rows without a sled are keyed by their library
-- owner.
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
  v_library_owner_id uuid;
  v_changed text[];
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old) - 'token_hash';
  end if;
  v_new := to_jsonb(new) - 'token_hash';
  v_row := v_new;

  if tg_table_name = 'garages' then
    v_garage_id := (v_row ->> 'id')::uuid;
  elsif tg_table_name = 'sleds' then
    v_sled_id := (v_row ->> 'id')::uuid;
  elsif v_row ->> 'sled_id' is not null then
    v_sled_id := (v_row ->> 'sled_id')::uuid;
  else
    v_library_owner_id := (v_row ->> 'owner_id')::uuid;
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
    garage_id, sled_id, library_owner_id, changed_fields, old_data, new_data
  ) values (
    auth.uid(), lower(tg_op), tg_argv[0], tg_table_name, (v_row ->> 'id')::uuid,
    (v_row ->> 'created_by')::uuid, v_garage_id, v_sled_id, v_library_owner_id,
    v_changed, v_old, v_new
  );

  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
create type public.engine_event as enum ('engine_replaced', 'engine_rebuilt');

-- -----------------------------------------------------------------------------
-- maintenance_tasks: a task lives in exactly one place.
--   owner_id set: the user's personal library, reusable across their sleds.
--   sled_id set:  a task for one sled, e.g. added by an editor on a shared
--                 sled without touching the owner's library.
-- -----------------------------------------------------------------------------
create table public.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  sled_id uuid references public.sleds (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  notes text check (char_length(notes) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (num_nonnulls(owner_id, sled_id) = 1)
);

create unique index maintenance_tasks_library_name_uniq
  on public.maintenance_tasks (owner_id, lower(btrim(name)))
  where deleted_at is null and owner_id is not null;
create unique index maintenance_tasks_sled_name_uniq
  on public.maintenance_tasks (sled_id, lower(btrim(name)))
  where deleted_at is null and sled_id is not null;
create index maintenance_tasks_owner_id_idx on public.maintenance_tasks (owner_id);
create index maintenance_tasks_sled_id_idx on public.maintenance_tasks (sled_id);

-- -----------------------------------------------------------------------------
-- maintenance_packages / maintenance_package_tasks: reusable task lists in
-- the user's private library. Only library tasks of the same user.
-- -----------------------------------------------------------------------------
create table public.maintenance_packages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  notes text check (char_length(notes) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create unique index maintenance_packages_name_uniq
  on public.maintenance_packages (owner_id, lower(btrim(name)))
  where deleted_at is null;

create table public.maintenance_package_tasks (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.maintenance_packages (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.maintenance_tasks (id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create unique index maintenance_package_tasks_uniq
  on public.maintenance_package_tasks (package_id, task_id)
  where deleted_at is null;
create index maintenance_package_tasks_task_id_idx on public.maintenance_package_tasks (task_id);
create index maintenance_package_tasks_owner_id_idx on public.maintenance_package_tasks (owner_id);

-- -----------------------------------------------------------------------------
-- sled_readings: odometer and engine-hour history.
--   odometer_mi / engine_hours are what the gauges show (US units, Decision 3).
--   odometer_reset / hour_meter_reset mark a replaced or reset meter: that
--   reading's value starts a new count, and totals continue from before.
--   engine_event records an engine replacement or rebuild on that date.
-- Totals are calculated by the view sled_reading_history, never stored, so
-- they stay correct when history is corrected.
-- -----------------------------------------------------------------------------
create table public.sled_readings (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  read_on date not null,
  odometer_mi numeric(9, 1) check (odometer_mi >= 0 and odometer_mi < 1000000),
  engine_hours numeric(8, 1) check (engine_hours >= 0 and engine_hours < 100000),
  odometer_reset boolean not null default false,
  hour_meter_reset boolean not null default false,
  engine_event public.engine_event,
  note text check (char_length(note) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (num_nonnulls(odometer_mi, engine_hours) >= 1),
  check (not odometer_reset or odometer_mi is not null),
  check (not hour_meter_reset or engine_hours is not null)
);

create index sled_readings_sled_id_read_on_idx on public.sled_readings (sled_id, read_on, created_at);

-- -----------------------------------------------------------------------------
-- maintenance_plans: the owner's own interval for a task on a sled, in miles,
-- engine hours and/or days (any combination, at least one).
-- last_done_* is an optional starting point for maintenance done before the
-- sled was in SledWerx (last_done_mi is total sled miles).
-- -----------------------------------------------------------------------------
create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  task_id uuid not null references public.maintenance_tasks (id) on delete cascade,
  interval_mi numeric(8, 1) check (interval_mi > 0),
  interval_hours numeric(7, 1) check (interval_hours > 0),
  interval_days integer check (interval_days between 1 and 3650),
  last_done_on date,
  last_done_mi numeric(9, 1) check (last_done_mi >= 0),
  last_done_hours numeric(8, 1) check (last_done_hours >= 0),
  paused boolean not null default false,
  notes text check (char_length(notes) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (num_nonnulls(interval_mi, interval_hours, interval_days) >= 1)
);

create unique index maintenance_plans_one_active_per_task
  on public.maintenance_plans (sled_id, task_id)
  where deleted_at is null;
create index maintenance_plans_task_id_idx on public.maintenance_plans (task_id);

-- -----------------------------------------------------------------------------
-- maintenance_entries: the logbook. completed = false is an open checklist.
-- reading_id is the reading logged with the entry. Deleting the entry never
-- deletes that reading.
-- -----------------------------------------------------------------------------
create table public.maintenance_entries (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  performed_on date not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  done_by text check (char_length(done_by) <= 120),
  notes text check (char_length(notes) <= 10000),
  labor_cost numeric(10, 2) check (labor_cost >= 0),
  other_cost numeric(10, 2) check (other_cost >= 0),
  completed boolean not null default true,
  reading_id uuid references public.sled_readings (id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create index maintenance_entries_sled_id_idx on public.maintenance_entries (sled_id, performed_on desc);
create index maintenance_entries_reading_id_idx on public.maintenance_entries (reading_id);

-- -----------------------------------------------------------------------------
-- maintenance_entry_tasks: what was done. task_name is copied from the task
-- so history reads correctly even if the task is renamed or deleted.
-- task_id is optional: free-text descriptions are allowed.
-- -----------------------------------------------------------------------------
create table public.maintenance_entry_tasks (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.maintenance_entries (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  task_id uuid references public.maintenance_tasks (id) on delete set null,
  task_name text not null check (char_length(btrim(task_name)) between 1 and 120),
  done boolean not null default true,
  note text check (char_length(note) <= 2000),
  position integer not null default 0 check (position >= 0),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create index maintenance_entry_tasks_entry_id_idx on public.maintenance_entry_tasks (entry_id);
create index maintenance_entry_tasks_task_id_idx on public.maintenance_entry_tasks (task_id);
create index maintenance_entry_tasks_sled_id_idx on public.maintenance_entry_tasks (sled_id);

-- -----------------------------------------------------------------------------
-- maintenance_entry_parts: parts used, in USD.
-- -----------------------------------------------------------------------------
create table public.maintenance_entry_parts (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.maintenance_entries (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  brand text check (char_length(brand) <= 120),
  part_number text check (char_length(part_number) <= 120),
  supplier text check (char_length(supplier) <= 120),
  quantity numeric(10, 2) not null default 1 check (quantity > 0),
  unit_cost numeric(10, 2) check (unit_cost >= 0),
  note text check (char_length(note) <= 2000),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create index maintenance_entry_parts_entry_id_idx on public.maintenance_entry_parts (entry_id);
create index maintenance_entry_parts_sled_id_idx on public.maintenance_entry_parts (sled_id);

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Library tasks of other users that the current user may see: only those
-- used by an active plan or entry on a sled shared with them. The owner's
-- unrelated library stays private.
create function private.shared_visible_task_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.task_id
  from public.maintenance_plans p
  where p.deleted_at is null
    and p.sled_id in (select private.shared_sled_ids())
  union
  select et.task_id
  from public.maintenance_entry_tasks et
  where et.task_id is not null
    and et.deleted_at is null
    and et.sled_id in (select private.shared_sled_ids());
$$;

-- Whether a task may be used (in a plan or entry) on a sled:
--   * a task of that sled; or
--   * a library task of the sled's owner, used by the owner, or already in use
--     on that sled (so shared users never reach unrelated library tasks).
create function private.task_usable_on_sled(p_task_id uuid, p_sled_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.maintenance_tasks t
    join public.sleds s on s.id = p_sled_id
    where t.id = p_task_id
      and t.deleted_at is null
      and (
        t.sled_id = p_sled_id
        or (
          t.owner_id = s.owner_id
          and (
            (select auth.uid()) is null
            or s.owner_id = (select auth.uid())
            or exists (
              select 1 from public.maintenance_plans p
              where p.task_id = t.id and p.sled_id = p_sled_id and p.deleted_at is null
            )
            or exists (
              select 1 from public.maintenance_entry_tasks et
              where et.task_id = t.id and et.sled_id = p_sled_id and et.deleted_at is null
            )
          )
        )
      )
  );
$$;

revoke all on function
  private.shared_visible_task_ids(),
  private.task_usable_on_sled(uuid, uuid)
from public;
grant execute on function
  private.shared_visible_task_ids(),
  private.task_usable_on_sled(uuid, uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- Guards and validation
-- A null auth.uid() is a trusted server context, as in Migration 1.
-- -----------------------------------------------------------------------------

-- Shared soft-delete handling for library rows (owner-only by RLS).
create function private.tg_library_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null and tg_table_name = 'maintenance_packages' then
      new.owner_id := v_uid;
    end if;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed.' using errcode = '42501';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is null then
      new.deleted_at := now();
      new.deleted_by := v_uid;
    elsif new.deleted_at is null then
      if old.deleted_at < now() - private.recovery_window() then
        raise exception 'This item is past the 30-day recovery period.' using errcode = '42501';
      end if;
      new.deleted_by := null;
    else
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
  else
    new.deleted_by := old.deleted_by;
    if old.deleted_at is not null and v_uid is not null then
      raise exception 'Restore this item before editing it.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create function private.tg_maintenance_tasks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      if new.sled_id is null then
        new.owner_id := v_uid;
      else
        new.owner_id := null;
        if not private.has_sled_permission(new.sled_id, 'edit_records') then
          raise exception 'Only owners and editors can add tasks to this snowmobile.'
            using errcode = '42501';
        end if;
      end if;
    end if;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  if new.owner_id is distinct from old.owner_id or new.sled_id is distinct from old.sled_id then
    raise exception 'A task cannot be moved between a library and a snowmobile.' using errcode = '42501';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if v_uid is not null and old.sled_id is not null
       and not private.has_sled_permission(
         old.sled_id, case when old.deleted_at is null then 'soft_delete_records' else 'restore_records' end)
    then
      raise exception 'You do not have permission to delete or restore this task.' using errcode = '42501';
    end if;
    if old.deleted_at is null then
      new.deleted_at := now();
      new.deleted_by := v_uid;
    elsif new.deleted_at is null then
      if old.deleted_at < now() - private.recovery_window() then
        raise exception 'This task is past the 30-day recovery period.' using errcode = '42501';
      end if;
      new.deleted_by := null;
    else
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
  else
    new.deleted_by := old.deleted_by;
    if old.deleted_at is not null and v_uid is not null then
      raise exception 'Restore this task before editing it.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- Package items: same owner, library tasks of that owner only.
create function private.tg_package_tasks_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'UPDATE' then
    if new.package_id is distinct from old.package_id or new.task_id is distinct from old.task_id then
      raise exception 'Package items cannot be moved.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Runs with the caller's RLS: only their own packages are visible.
  select p.owner_id into v_owner
  from public.maintenance_packages p
  where p.id = new.package_id and p.deleted_at is null;
  if v_owner is null then
    raise exception 'Package not found.' using errcode = '23503';
  end if;
  new.owner_id := v_owner;

  if not exists (
    select 1 from public.maintenance_tasks t
    where t.id = new.task_id and t.owner_id = v_owner and t.deleted_at is null
  ) then
    raise exception 'Only tasks from your own library can be added to a package.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Plans: owners and editors only; the task must be usable on the sled.
create function private.tg_maintenance_plans_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' and v_uid is not null
     and not private.has_sled_permission(new.sled_id, 'edit_records') then
    raise exception 'Only owners and editors can set up maintenance schedules.' using errcode = '42501';
  end if;

  if (tg_op = 'INSERT' or new.task_id is distinct from old.task_id)
     and not private.task_usable_on_sled(new.task_id, new.sled_id) then
    raise exception 'This task cannot be used on this snowmobile.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null
     and exists (select 1 from public.maintenance_tasks t where t.id = new.task_id and t.deleted_at is not null) then
    raise exception 'Restore the task before restoring its schedule.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Entries: the linked reading must be an active reading of the same sled.
create function private.tg_maintenance_entries_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reading_id is not null
     and (tg_op = 'INSERT' or new.reading_id is distinct from old.reading_id)
     and not exists (
       select 1 from public.sled_readings r
       where r.id = new.reading_id and r.sled_id = new.sled_id and r.deleted_at is null
     ) then
    raise exception 'The reading must be an active reading of the same snowmobile.' using errcode = '23503';
  end if;
  return new;
end;
$$;

-- Entry tasks and parts: take the sled from the entry; the entry must be
-- active; tasks must be usable on the sled; task names are copied.
-- Named "derive" so it runs before the record guard (triggers run in name order).
create function private.tg_entry_children_derive()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sled uuid;
  v_task_name text;
begin
  if tg_op = 'UPDATE' then
    if new.entry_id is distinct from old.entry_id then
      raise exception 'Items cannot be moved to another entry.' using errcode = '42501';
    end if;
  else
    -- Runs with the caller's RLS: only entries the caller can see.
    select e.sled_id into v_sled
    from public.maintenance_entries e
    where e.id = new.entry_id and e.deleted_at is null;
    if v_sled is null then
      raise exception 'Maintenance entry not found.' using errcode = '23503';
    end if;
    new.sled_id := v_sled;
  end if;

  -- Checked in nested IFs: parts have no task_id column, and PL/pgSQL does
  -- not short-circuit references to missing fields.
  if tg_table_name = 'maintenance_entry_tasks' then
    if new.task_id is not null
       and (tg_op = 'INSERT' or new.task_id is distinct from old.task_id) then
      if not private.task_usable_on_sled(new.task_id, new.sled_id) then
        raise exception 'This task cannot be used on this snowmobile.' using errcode = '42501';
      end if;
      if new.task_name is null or btrim(new.task_name) = '' then
        select t.name into v_task_name from public.maintenance_tasks t where t.id = new.task_id;
        new.task_name := v_task_name;
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Readings: values on the same meter never go down (a lower value must be
-- recorded as a reset), and a reading logged with an active entry cannot be
-- deleted on its own.
create function private.tg_sled_readings_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null
     and exists (
       select 1 from public.maintenance_entries e
       where e.reading_id = old.id and e.deleted_at is null
     ) then
    raise exception 'This reading belongs to a maintenance entry. Edit the entry''s reading instead.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create function private.tg_sled_readings_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from (
      select r.odometer_mi,
             lag(r.odometer_mi) over (partition by r.seg order by r.read_on, r.created_at, r.id) as prev
      from (
        select x.*, sum(x.odometer_reset::int) over (order by x.read_on, x.created_at, x.id) as seg
        from public.sled_readings x
        where x.sled_id = new.sled_id and x.deleted_at is null and x.odometer_mi is not null
      ) r
    ) o
    where o.odometer_mi < o.prev
  ) then
    raise exception 'Odometer readings cannot go down. If the odometer was replaced or reset, mark the reading as an odometer reset.'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from (
      select r.engine_hours,
             lag(r.engine_hours) over (partition by r.seg order by r.read_on, r.created_at, r.id) as prev
      from (
        select x.*, sum(x.hour_meter_reset::int) over (order by x.read_on, x.created_at, x.id) as seg
        from public.sled_readings x
        where x.sled_id = new.sled_id and x.deleted_at is null and x.engine_hours is not null
      ) r
    ) h
    where h.engine_hours < h.prev
  ) then
    raise exception 'Engine-hour readings cannot go down. If the hour meter was replaced or reset, mark the reading as an hour-meter reset.'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Cascades for Recently Deleted (same timestamp, so a restore brings back
-- exactly what was deleted together). Permissions are still checked by each
-- row's guard using the caller's identity.
-- -----------------------------------------------------------------------------

-- Entry deleted/restored: its tasks and parts follow. Its reading does NOT.
create function private.tg_entries_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.maintenance_entry_tasks set deleted_at = new.deleted_at
      where entry_id = new.id and deleted_at is null;
    update public.maintenance_entry_parts set deleted_at = new.deleted_at
      where entry_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.maintenance_entry_tasks set deleted_at = null
      where entry_id = new.id and deleted_at = old.deleted_at;
    update public.maintenance_entry_parts set deleted_at = null
      where entry_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

-- Task deleted/restored: its active schedules and package memberships follow,
-- atomically. Completed history (entry tasks) is kept. Schedules on a sled in
-- Recently Deleted are frozen with that sled and left as they are.
create function private.tg_tasks_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.maintenance_plans p set deleted_at = new.deleted_at
      where p.task_id = new.id and p.deleted_at is null
        and exists (select 1 from public.sleds s where s.id = p.sled_id and s.deleted_at is null);
    update public.maintenance_package_tasks set deleted_at = new.deleted_at
      where task_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.maintenance_plans p set deleted_at = null
      where p.task_id = new.id and p.deleted_at = old.deleted_at
        and exists (select 1 from public.sleds s where s.id = p.sled_id and s.deleted_at is null);
    update public.maintenance_package_tasks pt set deleted_at = null
      where pt.task_id = new.id and pt.deleted_at = old.deleted_at
        and exists (select 1 from public.maintenance_packages p where p.id = pt.package_id and p.deleted_at is null);
  end if;
  return null;
end;
$$;

create function private.tg_packages_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.maintenance_package_tasks set deleted_at = new.deleted_at
      where package_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.maintenance_package_tasks set deleted_at = null
      where package_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

revoke all on function
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
  private.tg_packages_cascade()
from public;

-- -----------------------------------------------------------------------------
-- Triggers (same-timing triggers run in name order)
-- -----------------------------------------------------------------------------
-- Library tables
create trigger guard before insert or update on public.maintenance_tasks
  for each row execute function private.tg_maintenance_tasks_guard();
create trigger guard before insert or update on public.maintenance_packages
  for each row execute function private.tg_library_guard();
create trigger check_links before insert or update on public.maintenance_package_tasks
  for each row execute function private.tg_package_tasks_check();
create trigger guard before insert or update on public.maintenance_package_tasks
  for each row execute function private.tg_library_guard();

-- Sled tables: Migration 1's record guard
create trigger guard before insert or update on public.sled_readings
  for each row execute function private.tg_sled_record_guard();
create trigger guard before insert or update on public.maintenance_plans
  for each row execute function private.tg_sled_record_guard();
create trigger guard before insert or update on public.maintenance_entries
  for each row execute function private.tg_sled_record_guard();
create trigger derive before insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_entry_children_derive();
create trigger guard before insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_sled_record_guard();
create trigger derive before insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_entry_children_derive();
create trigger guard before insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_sled_record_guard();

-- Extra checks
create trigger links before insert or update on public.maintenance_plans
  for each row execute function private.tg_maintenance_plans_check();
create trigger links before insert or update on public.maintenance_entries
  for each row execute function private.tg_maintenance_entries_check();
create trigger links before update on public.sled_readings
  for each row execute function private.tg_sled_readings_check();
create trigger reading_order after insert or update on public.sled_readings
  for each row execute function private.tg_sled_readings_order();

-- Cascades
create trigger cascade_children after update on public.maintenance_entries
  for each row execute function private.tg_entries_cascade();
create trigger cascade_schedules after update on public.maintenance_tasks
  for each row execute function private.tg_tasks_cascade();
create trigger cascade_items after update on public.maintenance_packages
  for each row execute function private.tg_packages_cascade();

-- Metadata, versioning and audit on every table
create trigger stamp before insert or update on public.maintenance_tasks
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_packages
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_package_tasks
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.sled_readings
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_plans
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_entries
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_stamp();
create trigger stamp before insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_stamp();

create trigger audit after insert or update on public.maintenance_tasks
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_packages
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_package_tasks
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.sled_readings
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_plans
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_entries
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_audit('maintenance');
create trigger audit after insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_audit('maintenance');

-- -----------------------------------------------------------------------------
-- Views (security_invoker: the caller's RLS applies)
-- -----------------------------------------------------------------------------

-- Readings with calculated totals. Each meter reset starts a new segment;
-- totals continue from the last value of the previous segment.
create view public.sled_reading_history
with (security_invoker = true)
as
with odo as (
  select r.id, r.sled_id, r.odometer_mi, r.read_on, r.created_at,
         sum(r.odometer_reset::int) over (partition by r.sled_id order by r.read_on, r.created_at, r.id) as seg
  from public.sled_readings r
  where r.deleted_at is null and r.odometer_mi is not null
),
odo_seg as (
  select sled_id, seg,
         (array_agg(odometer_mi order by read_on, created_at, id))[1] as first_value,
         (array_agg(odometer_mi order by read_on desc, created_at desc, id desc))[1] as last_value
  from odo group by sled_id, seg
),
odo_offset as (
  select sled_id, seg,
         coalesce(sum(prev_last - first_value) over (partition by sled_id order by seg), 0) as offset_value
  from (
    select s.*, lag(s.last_value) over (partition by s.sled_id order by s.seg) as prev_last
    from odo_seg s
  ) x
),
hrs as (
  select r.id, r.sled_id, r.engine_hours, r.read_on, r.created_at,
         sum(r.hour_meter_reset::int) over (partition by r.sled_id order by r.read_on, r.created_at, r.id) as seg
  from public.sled_readings r
  where r.deleted_at is null and r.engine_hours is not null
),
hrs_seg as (
  select sled_id, seg,
         (array_agg(engine_hours order by read_on, created_at, id))[1] as first_value,
         (array_agg(engine_hours order by read_on desc, created_at desc, id desc))[1] as last_value
  from hrs group by sled_id, seg
),
hrs_offset as (
  select sled_id, seg,
         coalesce(sum(prev_last - first_value) over (partition by sled_id order by seg), 0) as offset_value
  from (
    select s.*, lag(s.last_value) over (partition by s.sled_id order by s.seg) as prev_last
    from hrs_seg s
  ) x
)
select
  r.id,
  r.sled_id,
  r.read_on,
  r.odometer_mi,
  r.engine_hours,
  r.odometer_reset,
  r.hour_meter_reset,
  r.engine_event,
  r.note,
  o.odometer_mi + oo.offset_value as total_mi,
  h.engine_hours + ho.offset_value as total_engine_hours,
  r.created_at,
  r.created_by,
  r.version
from public.sled_readings r
left join odo o on o.id = r.id
left join odo_offset oo on oo.sled_id = o.sled_id and oo.seg = o.seg
left join hrs h on h.id = r.id
left join hrs_offset ho on ho.sled_id = h.sled_id and ho.seg = h.seg
where r.deleted_at is null;

-- Entry cost totals in USD: labor + other + parts (quantity x unit cost).
create view public.maintenance_entry_costs
with (security_invoker = true)
as
select
  e.id as entry_id,
  e.sled_id,
  coalesce(e.labor_cost, 0) as labor_cost,
  coalesce(e.other_cost, 0) as other_cost,
  coalesce((
    select sum(p.quantity * coalesce(p.unit_cost, 0))
    from public.maintenance_entry_parts p
    where p.entry_id = e.id and p.deleted_at is null
  ), 0) as parts_cost,
  coalesce(e.labor_cost, 0) + coalesce(e.other_cost, 0) + coalesce((
    select sum(p.quantity * coalesce(p.unit_cost, 0))
    from public.maintenance_entry_parts p
    where p.entry_id = e.id and p.deleted_at is null
  ), 0) as total_cost
from public.maintenance_entries e;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke all on
  public.maintenance_tasks, public.maintenance_packages, public.maintenance_package_tasks,
  public.sled_readings, public.maintenance_plans, public.maintenance_entries,
  public.maintenance_entry_tasks, public.maintenance_entry_parts,
  public.sled_reading_history, public.maintenance_entry_costs
from anon, authenticated;

grant select, insert, update on
  public.maintenance_tasks, public.maintenance_packages, public.maintenance_package_tasks,
  public.sled_readings, public.maintenance_plans, public.maintenance_entries,
  public.maintenance_entry_tasks, public.maintenance_entry_parts
to authenticated;
grant select on public.sled_reading_history, public.maintenance_entry_costs to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.maintenance_tasks enable row level security;
alter table public.maintenance_packages enable row level security;
alter table public.maintenance_package_tasks enable row level security;
alter table public.sled_readings enable row level security;
alter table public.maintenance_plans enable row level security;
alter table public.maintenance_entries enable row level security;
alter table public.maintenance_entry_tasks enable row level security;
alter table public.maintenance_entry_parts enable row level security;

-- Tasks: your library (including Recently Deleted); tasks of sleds you can
-- view; other owners' library tasks only where used on a sled shared with you.
create policy "Users can view their library and relevant sled tasks"
  on public.maintenance_tasks for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (
      sled_id is not null
      and private.has_sled_permission(sled_id, 'view')
      and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records'))
    )
    or (deleted_at is null and id in (select private.shared_visible_task_ids()))
  );
create policy "Users add library tasks; owners and editors add sled tasks"
  on public.maintenance_tasks for insert to authenticated
  with check (
    (sled_id is null and owner_id = (select auth.uid()))
    or (sled_id is not null and private.has_sled_permission(sled_id, 'edit_records'))
  );
create policy "Users edit library tasks; owners and editors edit sled tasks"
  on public.maintenance_tasks for update to authenticated
  using (
    owner_id = (select auth.uid())
    or (sled_id is not null and private.has_sled_permission(sled_id, 'edit_records'))
  )
  with check (
    owner_id = (select auth.uid())
    or (sled_id is not null and private.has_sled_permission(sled_id, 'edit_records'))
  );

-- Packages: private to their owner.
create policy "Owners can view their packages"
  on public.maintenance_packages for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Users can create packages"
  on public.maintenance_packages for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Owners can update their packages"
  on public.maintenance_packages for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "Owners can view their package items"
  on public.maintenance_package_tasks for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Owners can add package items"
  on public.maintenance_package_tasks for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Owners can update their package items"
  on public.maintenance_package_tasks for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Sled records: the standard pattern from Migration 1 (docs/database.md).
create policy "Sled users can view readings"
  on public.sled_readings for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add readings"
  on public.sled_readings for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit readings"
  on public.sled_readings for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view schedules"
  on public.maintenance_plans for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners and editors can add schedules"
  on public.maintenance_plans for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'edit_records'));
create policy "Permitted users can edit schedules"
  on public.maintenance_plans for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view entries"
  on public.maintenance_entries for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add entries"
  on public.maintenance_entries for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit entries"
  on public.maintenance_entries for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view entry tasks"
  on public.maintenance_entry_tasks for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add entry tasks"
  on public.maintenance_entry_tasks for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit entry tasks"
  on public.maintenance_entry_tasks for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view entry parts"
  on public.maintenance_entry_parts for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add entry parts"
  on public.maintenance_entry_parts for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit entry parts"
  on public.maintenance_entry_parts for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

-- -----------------------------------------------------------------------------
-- Restore a previous version (Decision 6). Puts back the values a record had
-- before the change recorded in the given audit row. Only for people allowed
-- to edit that record; the restore is itself a normal, audited update.
-- -----------------------------------------------------------------------------
create function public.restore_record_version(p_audit_id bigint)
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
      'updated_at', 'updated_by', 'version', 'deleted_at', 'deleted_by'
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
