-- =============================================================================
-- SledWerx — Migration 4: service records
--
-- Builds the Phase 3 service history on Migration 2's logbook tables. No new
-- tables; Migrations 1-3 are not modified.
--
-- * maintenance_entries.category: optional, from a fixed list.
-- * maintenance_entries.edited_at: set on every edit, so the record's version
--   covers its items and mileage too.
-- * Service dates: no performed_on in the future (same one-day bound as
--   readings in Migration 3).
-- * save_maintenance_entry(): replaced by the same function plus p_category
--   (the old signature is dropped; the app is its only caller).
-- * update_maintenance_entry(): edits a whole service record in one
--   transaction: the entry (version-checked), its linked reading (updated in
--   place, so mileage history stays accurate), and its tasks and parts
--   (changed, added or removed). SECURITY INVOKER: RLS, guards, reading
--   validation and audit logging apply to every row it touches.
-- * Items (tasks and parts) of a service record follow the record: whoever
--   may modify the record (owner, editor, or the mechanic who created it) may
--   edit, remove, see removed, and restore its items. Deleting the record itself, and
--   deleting readings, keep Migration 1's rule (owners and editors only).
--
-- Rollback (manual only): supabase/rollback/20261118090000_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Category
-- -----------------------------------------------------------------------------
alter table public.maintenance_entries
  add column category text
  constraint maintenance_entries_category_check check (category in (
    'engine', 'drivetrain', 'track_suspension', 'fuel_oil', 'cooling', 'electrical',
    'brakes', 'steering_skis', 'body_accessories', 'inspection', 'other'
  ));

-- When the record was last edited through update_maintenance_entry(). Every
-- edit sets it, so the record's version changes even when only its items or
-- mileage changed: the version protects the whole record against
-- simultaneous edits, and the app can show "Edited on ...".
alter table public.maintenance_entries add column edited_at timestamptz;

comment on column public.maintenance_entries.category is
  'Optional service category: engine, drivetrain, track_suspension, fuel_oil, cooling, electrical, brakes, steering_skis, body_accessories, inspection, other.';

-- -----------------------------------------------------------------------------
-- No future service dates (one day of slack for time zones ahead of UTC).
-- Only new dates are checked.
-- -----------------------------------------------------------------------------
create function private.tg_maintenance_entries_date_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.performed_on > current_date + 1
     and (tg_op = 'INSERT' or new.performed_on is distinct from old.performed_on) then
    raise exception 'The service date cannot be in the future.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.tg_maintenance_entries_date_check() from public, anon, authenticated;

create trigger date_check before insert or update of performed_on on public.maintenance_entries
  for each row execute function private.tg_maintenance_entries_date_check();

-- -----------------------------------------------------------------------------
-- Items follow their service record
-- -----------------------------------------------------------------------------

-- Who created a service record (readable for policies and guards).
create function private.entry_created_by(p_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.created_by from public.maintenance_entries e where e.id = p_entry_id;
$$;

revoke all on function private.entry_created_by(uuid) from public, anon;
grant execute on function private.entry_created_by(uuid) to authenticated;

-- Guard for maintenance_entry_tasks and maintenance_entry_parts. Same rules
-- as Migration 1's tg_sled_record_guard, except that permission to edit,
-- remove or restore an item comes from its service record: anyone who may
-- modify the record (private.can_modify_sled_record with the record's
-- creator) may change its items. Inserts are checked by the existing
-- "derive" trigger, which already uses the record's creator.
create function private.tg_entry_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_entry_created_by uuid;
  v_entry_deleted_at timestamptz;
begin
  if tg_op = 'INSERT' then
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  if new.sled_id is distinct from old.sled_id then
    raise exception 'Records cannot be moved to another snowmobile.' using errcode = '42501';
  end if;

  if v_uid is null then
    return new;
  end if;

  select private.entry_created_by(old.entry_id) into v_entry_created_by;
  select e.deleted_at into v_entry_deleted_at from public.maintenance_entries e where e.id = old.entry_id;

  if not private.can_modify_sled_record(old.sled_id, v_entry_created_by) then
    raise exception 'You do not have permission to change this service record.' using errcode = '42501';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is null then
      new.deleted_at := now();
      new.deleted_by := v_uid;
    elsif new.deleted_at is null then
      if v_entry_deleted_at is not null then
        raise exception 'Restore the service record first.' using errcode = '42501';
      end if;
      if old.deleted_at < now() - private.recovery_window() then
        raise exception 'This record is past the 30-day recovery period.' using errcode = '42501';
      end if;
      new.deleted_by := null;
    else
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
  else
    new.deleted_by := old.deleted_by;
    if old.deleted_at is not null then
      raise exception 'Restore this record before editing it.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.tg_entry_items_guard() from public, anon, authenticated;

drop trigger guard on public.maintenance_entry_tasks;
drop trigger guard on public.maintenance_entry_parts;
create trigger guard before insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_entry_items_guard();
create trigger guard before insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_entry_items_guard();

-- Viewing removed items: also whoever may modify the record (so a mechanic
-- can remove and restore items of their own records; Postgres requires an
-- updated row to stay visible to the person updating it).
drop policy "Sled users can view entry tasks" on public.maintenance_entry_tasks;
drop policy "Sled users can view entry parts" on public.maintenance_entry_parts;
create policy "Sled users can view entry tasks"
  on public.maintenance_entry_tasks for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null
              or private.has_sled_permission(sled_id, 'restore_records')
              or private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id))));
create policy "Sled users can view entry parts"
  on public.maintenance_entry_parts for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null
              or private.has_sled_permission(sled_id, 'restore_records')
              or private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id))));

-- Editing items: based on who created the service record, not the item.
drop policy "Permitted users can edit entry tasks" on public.maintenance_entry_tasks;
drop policy "Permitted users can edit entry parts" on public.maintenance_entry_parts;
create policy "Permitted users can edit entry tasks"
  on public.maintenance_entry_tasks for update to authenticated
  using (private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id)))
  with check (private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id)));
create policy "Permitted users can edit entry parts"
  on public.maintenance_entry_parts for update to authenticated
  using (private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id)))
  with check (private.can_modify_sled_record(sled_id, private.entry_created_by(entry_id)));

-- -----------------------------------------------------------------------------
-- save_maintenance_entry, now with a category. Otherwise identical to
-- Migration 2's version (same checks, idempotency and SECURITY INVOKER).
-- -----------------------------------------------------------------------------
drop function public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb
);

create function public.save_maintenance_entry(
  p_idempotency_key uuid,
  p_sled_id uuid,
  p_performed_on date,
  p_title text,
  p_done_by text default null,
  p_notes text default null,
  p_labor_cost numeric default null,
  p_other_cost numeric default null,
  p_completed boolean default true,
  p_reading jsonb default null,
  p_tasks jsonb default '[]'::jsonb,
  p_parts jsonb default '[]'::jsonb,
  p_category text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tasks jsonb := coalesce(p_tasks, '[]'::jsonb);
  v_parts jsonb := coalesce(p_parts, '[]'::jsonb);
  v_entry_id uuid;
  v_reading_id uuid;
  v_existing record;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'Sign in to save maintenance.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  if p_reading is not null and jsonb_typeof(p_reading) <> 'object' then
    raise exception 'p_reading must be an object.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tasks) <> 'array' or jsonb_typeof(v_parts) <> 'array' then
    raise exception 'p_tasks and p_parts must be arrays.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_tasks) > 100 or jsonb_array_length(v_parts) > 100 then
    raise exception 'An entry can have at most 100 tasks and 100 parts.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_tasks) t
    where jsonb_typeof(t) <> 'object'
       or (coalesce(t ->> 'task_id', '') = '' and coalesce(btrim(t ->> 'task_name'), '') = '')
  ) then
    raise exception 'Each task needs a task_id or a task_name.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_parts) p where jsonb_typeof(p) <> 'object') then
    raise exception 'Each part must be an object.' using errcode = '22023';
  end if;

  -- Already saved by this user with this key: return it, save nothing.
  select e.id, e.sled_id, e.reading_id into v_existing
  from public.maintenance_entries e
  where e.created_by = v_uid and e.client_request_id = p_idempotency_key;
  if found then
    if v_existing.sled_id is distinct from p_sled_id then
      raise exception 'This idempotency key was already used for a different snowmobile.' using errcode = '22023';
    end if;
    return jsonb_build_object('entry_id', v_existing.id, 'reading_id', v_existing.reading_id, 'duplicate', true);
  end if;

  begin
    if p_reading is not null then
      insert into public.sled_readings (
        sled_id, read_on, odometer_mi, engine_hours, odometer_reset, hour_meter_reset, engine_event, note
      )
      select p_sled_id, coalesce(r.read_on, p_performed_on), r.odometer_mi, r.engine_hours,
             coalesce(r.odometer_reset, false), coalesce(r.hour_meter_reset, false), r.engine_event, r.note
      from jsonb_to_record(p_reading) as r(
        read_on date, odometer_mi numeric, engine_hours numeric, odometer_reset boolean,
        hour_meter_reset boolean, engine_event public.engine_event, note text
      )
      returning id into v_reading_id;
    end if;

    insert into public.maintenance_entries (
      sled_id, performed_on, title, category, done_by, notes, labor_cost, other_cost, completed,
      reading_id, client_request_id
    ) values (
      p_sled_id, p_performed_on, p_title, p_category, p_done_by, p_notes, p_labor_cost, p_other_cost,
      coalesce(p_completed, true), v_reading_id, p_idempotency_key
    )
    returning id into v_entry_id;

    insert into public.maintenance_entry_tasks (entry_id, task_id, task_name, done, note, position)
    select v_entry_id, t.task_id, nullif(btrim(t.task_name), ''), coalesce(t.done, true), t.note, (t.ord - 1)::integer
    from rows from (jsonb_to_recordset(v_tasks) as (task_id uuid, task_name text, done boolean, note text))
         with ordinality as t(task_id, task_name, done, note, ord);

    insert into public.maintenance_entry_parts (entry_id, name, brand, part_number, supplier, quantity, unit_cost, note)
    select v_entry_id, p.name, p.brand, p.part_number, p.supplier, coalesce(p.quantity, 1), p.unit_cost, p.note
    from jsonb_to_recordset(v_parts) as p(
      name text, brand text, part_number text, supplier text, quantity numeric, unit_cost numeric, note text
    );
  exception
    when unique_violation then
      -- A simultaneous submission with the same key won the race: everything
      -- in this block (including the reading) is undone; return the winner.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'maintenance_entries_client_request_uniq' then
        select e.id, e.sled_id, e.reading_id into v_existing
        from public.maintenance_entries e
        where e.created_by = v_uid and e.client_request_id = p_idempotency_key;
        if found and v_existing.sled_id is not distinct from p_sled_id then
          return jsonb_build_object('entry_id', v_existing.id, 'reading_id', v_existing.reading_id, 'duplicate', true);
        end if;
      end if;
      raise;
  end;

  return jsonb_build_object('entry_id', v_entry_id, 'reading_id', v_reading_id, 'duplicate', false);
end;
$$;

revoke all on function public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb, text
) from public, anon;
grant execute on function public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb, text
) to authenticated;

-- -----------------------------------------------------------------------------
-- update_maintenance_entry: edit a whole service record in one transaction.
--
-- p_version: the record's version as the app last read it. A stale version
--   is refused ("changed elsewhere"), so two devices never overwrite each
--   other. Every edit sets edited_at, so the version changes on every edit,
--   including edits that only change items or mileage.
-- p_reading: null removes the record's reading (owners and editors only; the
--   reading is soft-deleted and stays in the audit history); an object
--   {"odometer_mi", "engine_hours", "odometer_reset", "hour_meter_reset"}
--   updates the linked reading in place, or adds one if the record had none.
--   The reading's date always follows the service date. Every change is
--   validated against the rest of the mileage history.
-- p_tasks: [{"id"?, "task_id" or "task_name", "done", "note"}, ...]
-- p_parts: [{"id"?, "name", "brand", "part_number", "supplier", "quantity",
--            "unit_cost", "note"}, ...]
--   Items with an id are updated, items without one are added, and current
--   items missing from the list are removed (soft delete). List order is
--   kept for tasks. At most 100 of each.
-- Returns {"entry_id", "reading_id"}.
-- -----------------------------------------------------------------------------
create function public.update_maintenance_entry(
  p_entry_id uuid,
  p_version integer,
  p_performed_on date,
  p_title text,
  p_category text default null,
  p_done_by text default null,
  p_notes text default null,
  p_labor_cost numeric default null,
  p_other_cost numeric default null,
  p_reading jsonb default null,
  p_tasks jsonb default '[]'::jsonb,
  p_parts jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tasks jsonb := coalesce(p_tasks, '[]'::jsonb);
  v_parts jsonb := coalesce(p_parts, '[]'::jsonb);
  v_entry public.maintenance_entries%rowtype;
  v_reading public.sled_readings%rowtype;
  v_reading_id uuid;
  v_rows integer;
  v_item record;
begin
  if v_uid is null then
    raise exception 'Sign in to edit maintenance.' using errcode = '42501';
  end if;
  if p_version is null then
    raise exception 'The record version is required.' using errcode = '22023';
  end if;
  if p_reading is not null and jsonb_typeof(p_reading) <> 'object' then
    raise exception 'p_reading must be an object.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tasks) <> 'array' or jsonb_typeof(v_parts) <> 'array' then
    raise exception 'p_tasks and p_parts must be arrays.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_tasks) > 100 or jsonb_array_length(v_parts) > 100 then
    raise exception 'An entry can have at most 100 tasks and 100 parts.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_tasks) t
    where jsonb_typeof(t) <> 'object'
       or (coalesce(t ->> 'task_id', '') = '' and coalesce(btrim(t ->> 'task_name'), '') = '')
  ) then
    raise exception 'Each task needs a task_id or a task_name.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_parts) p where jsonb_typeof(p) <> 'object') then
    raise exception 'Each part must be an object.' using errcode = '22023';
  end if;

  -- The record, as the caller can see it (RLS). Not locked here: SELECT ... FOR
  -- UPDATE would hide records the caller may only view. The update below locks
  -- the row, and its version check refuses a simultaneous edit.
  select * into v_entry from public.maintenance_entries e where e.id = p_entry_id;
  if not found then
    raise exception 'Service record not found.' using errcode = 'P0002';
  end if;
  if v_entry.deleted_at is not null then
    raise exception 'Restore this record before editing it.' using errcode = '42501';
  end if;
  if v_entry.version <> p_version then
    raise exception 'This record was changed elsewhere. Reload it and try again.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  if not private.can_modify_sled_record(v_entry.sled_id, v_entry.created_by) then
    raise exception 'You do not have permission to edit this service record.' using errcode = '42501';
  end if;

  -- Item ids must belong to this record.
  if exists (
    select 1 from jsonb_array_elements(v_tasks) t
    where t ? 'id' and not exists (
      select 1 from public.maintenance_entry_tasks it
      where it.id = (t ->> 'id')::uuid and it.entry_id = p_entry_id and it.deleted_at is null)
  ) or exists (
    select 1 from jsonb_array_elements(v_parts) p
    where p ? 'id' and not exists (
      select 1 from public.maintenance_entry_parts ip
      where ip.id = (p ->> 'id')::uuid and ip.entry_id = p_entry_id and ip.deleted_at is null)
  ) then
    raise exception 'An item does not belong to this service record. Reload it and try again.'
      using errcode = '22023';
  end if;

  -- Reading: remove, update in place, or add.
  v_reading_id := v_entry.reading_id;
  if v_entry.reading_id is not null then
    select * into v_reading from public.sled_readings r where r.id = v_entry.reading_id;
  end if;

  if p_reading is null and v_entry.reading_id is not null then
    if not private.has_sled_permission(v_entry.sled_id, 'soft_delete_records') then
      raise exception 'Only the owner or an editor can remove the mileage from a service record.'
        using errcode = '42501';
    end if;
    v_reading_id := null;
  elsif p_reading is not null and v_entry.reading_id is null then
    insert into public.sled_readings (sled_id, read_on, odometer_mi, engine_hours, odometer_reset, hour_meter_reset)
    select v_entry.sled_id, p_performed_on, r.odometer_mi, r.engine_hours,
           coalesce(r.odometer_reset, false), coalesce(r.hour_meter_reset, false)
    from jsonb_to_record(p_reading) as r(
      odometer_mi numeric, engine_hours numeric, odometer_reset boolean, hour_meter_reset boolean)
    returning id into v_reading_id;
  end if;

  -- The record itself (guards, versioning and audit apply).
  update public.maintenance_entries e
  set performed_on = p_performed_on,
      title = p_title,
      category = p_category,
      done_by = p_done_by,
      notes = p_notes,
      labor_cost = p_labor_cost,
      other_cost = p_other_cost,
      reading_id = v_reading_id,
      edited_at = now(),
      version = p_version
  where e.id = p_entry_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'You do not have permission to edit this service record.' using errcode = '42501';
  end if;

  if p_reading is null and v_entry.reading_id is not null then
    -- Unlinked above, so the reading can now be soft-deleted.
    update public.sled_readings r
    set deleted_at = now(), version = v_reading.version
    where r.id = v_entry.reading_id;
  elsif p_reading is not null and v_entry.reading_id is not null then
    update public.sled_readings r
    set read_on = p_performed_on,
        odometer_mi = x.odometer_mi,
        engine_hours = x.engine_hours,
        odometer_reset = coalesce(x.odometer_reset, false),
        hour_meter_reset = coalesce(x.hour_meter_reset, false),
        version = v_reading.version
    from jsonb_to_record(p_reading) as x(
      odometer_mi numeric, engine_hours numeric, odometer_reset boolean, hour_meter_reset boolean)
    where r.id = v_entry.reading_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'You do not have permission to change this service record''s mileage.'
        using errcode = '42501';
    end if;
  end if;

  -- Tasks: remove, update, add.
  for v_item in
    select it.id, it.version from public.maintenance_entry_tasks it
    where it.entry_id = p_entry_id and it.deleted_at is null
      and not exists (select 1 from jsonb_array_elements(v_tasks) t where (t ->> 'id')::uuid = it.id)
  loop
    update public.maintenance_entry_tasks set deleted_at = now(), version = v_item.version where id = v_item.id;
  end loop;

  for v_item in
    select t.id, t.task_id, nullif(btrim(t.task_name), '') as task_name, coalesce(t.done, true) as done,
           t.note, (t.ord - 1)::integer as position
    from rows from (jsonb_to_recordset(v_tasks) as (id uuid, task_id uuid, task_name text, done boolean, note text))
         with ordinality as t(id, task_id, task_name, done, note, ord)
  loop
    if v_item.id is null then
      insert into public.maintenance_entry_tasks (entry_id, task_id, task_name, done, note, position)
      values (p_entry_id, v_item.task_id, v_item.task_name, v_item.done, v_item.note, v_item.position);
    else
      update public.maintenance_entry_tasks it
      set task_id = v_item.task_id,
          task_name = coalesce(v_item.task_name, it.task_name),
          done = v_item.done,
          note = v_item.note,
          position = v_item.position
      where it.id = v_item.id;
    end if;
  end loop;

  -- Parts: remove, update, add.
  for v_item in
    select ip.id, ip.version from public.maintenance_entry_parts ip
    where ip.entry_id = p_entry_id and ip.deleted_at is null
      and not exists (select 1 from jsonb_array_elements(v_parts) p where (p ->> 'id')::uuid = ip.id)
  loop
    update public.maintenance_entry_parts set deleted_at = now(), version = v_item.version where id = v_item.id;
  end loop;

  for v_item in
    select * from jsonb_to_recordset(v_parts) as p(
      id uuid, name text, brand text, part_number text, supplier text, quantity numeric, unit_cost numeric, note text)
  loop
    if v_item.id is null then
      insert into public.maintenance_entry_parts (entry_id, name, brand, part_number, supplier, quantity, unit_cost, note)
      values (p_entry_id, v_item.name, v_item.brand, v_item.part_number, v_item.supplier,
              coalesce(v_item.quantity, 1), v_item.unit_cost, v_item.note);
    else
      update public.maintenance_entry_parts ip
      set name = v_item.name,
          brand = v_item.brand,
          part_number = v_item.part_number,
          supplier = v_item.supplier,
          quantity = coalesce(v_item.quantity, 1),
          unit_cost = v_item.unit_cost,
          note = v_item.note
      where ip.id = v_item.id;
    end if;
  end loop;

  return jsonb_build_object('entry_id', p_entry_id, 'reading_id', v_reading_id);
end;
$$;

revoke all on function public.update_maintenance_entry(
  uuid, integer, date, text, text, text, text, numeric, numeric, jsonb, jsonb, jsonb
) from public, anon;
grant execute on function public.update_maintenance_entry(
  uuid, integer, date, text, text, text, text, numeric, numeric, jsonb, jsonb, jsonb
) to authenticated;
