-- =============================================================================
-- SledWerx — ROLLBACK for Migration 4
--   20261118090000_service_records.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 4 created (category and edited_at columns,
--   the service-date trigger, update_maintenance_entry(), the item guard and
--   entry_created_by()) and restores what it replaced to the exact
--   Migration 2 definitions: save_maintenance_entry() without a category,
--   the item view and edit policies, and Migration 1's guard on items.
--   Also removes Migration 4's migration-history entry. All in ONE
--   transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261118090000';
-- * REFUSES to run while any service record has a category, so it can never
--   delete category data. (edited_at only marks edited records; it is
--   dropped.)
-- * Service records, items and readings are ordinary Migration 2 data and
--   are kept. Migrations 1-3 are untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261118090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261118090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'maintenance_entries' and column_name = 'category') then
    execute 'select count(*) from public.maintenance_entries where category is not null' into strict v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % service record(s) have a category. Do not roll back once categories are used; fix forward instead.', v_rows;
    end if;
  end if;
end $$;

-- 2. Functions Migration 4 added or replaced. No CASCADE: anything unexpected
--    depending on them stops the rollback.
drop function if exists public.update_maintenance_entry(
  uuid, integer, date, text, text, text, text, numeric, numeric, jsonb, jsonb, jsonb);
drop function if exists public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb, text);

-- 3. Items: Migration 1's guard and Migration 2's policies, exactly.
drop trigger if exists guard on public.maintenance_entry_tasks;
drop trigger if exists guard on public.maintenance_entry_parts;
create trigger guard before insert or update on public.maintenance_entry_tasks
  for each row execute function private.tg_sled_record_guard();
create trigger guard before insert or update on public.maintenance_entry_parts
  for each row execute function private.tg_sled_record_guard();

drop policy if exists "Sled users can view entry tasks" on public.maintenance_entry_tasks;
drop policy if exists "Permitted users can edit entry tasks" on public.maintenance_entry_tasks;
drop policy if exists "Sled users can view entry parts" on public.maintenance_entry_parts;
drop policy if exists "Permitted users can edit entry parts" on public.maintenance_entry_parts;
create policy "Sled users can view entry tasks"
  on public.maintenance_entry_tasks for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Permitted users can edit entry tasks"
  on public.maintenance_entry_tasks for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));
create policy "Sled users can view entry parts"
  on public.maintenance_entry_parts for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Permitted users can edit entry parts"
  on public.maintenance_entry_parts for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

drop function if exists private.tg_entry_items_guard();
drop function if exists private.entry_created_by(uuid);

-- 4. Service dates and columns.
drop trigger if exists date_check on public.maintenance_entries;
drop function if exists private.tg_maintenance_entries_date_check();
alter table public.maintenance_entries drop column if exists edited_at;
alter table public.maintenance_entries drop column if exists category;

-- 5. save_maintenance_entry exactly as in Migration 2.
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
      sled_id, performed_on, title, done_by, notes, labor_cost, other_cost, completed,
      reading_id, client_request_id
    ) values (
      p_sled_id, p_performed_on, p_title, p_done_by, p_notes, p_labor_cost, p_other_cost,
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
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb
) from public, anon;
grant execute on function public.save_maintenance_entry(
  uuid, uuid, date, text, text, text, numeric, numeric, boolean, jsonb, jsonb, jsonb
) to authenticated;

-- 6. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261118090000';

-- 7. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'maintenance_entries' and column_name in ('category', 'edited_at'))
     or to_regprocedure('public.update_maintenance_entry(uuid,integer,date,text,text,text,text,numeric,numeric,jsonb,jsonb,jsonb)') is not null
     or to_regprocedure('public.save_maintenance_entry(uuid,uuid,date,text,text,text,numeric,numeric,boolean,jsonb,jsonb,jsonb,text)') is not null
     or to_regprocedure('public.save_maintenance_entry(uuid,uuid,date,text,text,text,numeric,numeric,boolean,jsonb,jsonb,jsonb)') is null
     or to_regprocedure('private.tg_entry_items_guard()') is not null
     or to_regprocedure('private.entry_created_by(uuid)') is not null
     or to_regprocedure('private.tg_maintenance_entries_date_check()') is not null
     or (select count(*) from pg_trigger where tgname = 'guard' and tgfoid = 'private.tg_sled_record_guard'::regproc
           and tgrelid in ('public.maintenance_entry_tasks'::regclass, 'public.maintenance_entry_parts'::regclass)) <> 2
  then
    raise exception 'Rollback verification failed: Migration 4 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 4 removed; Migrations 1-3 untouched.';
end $$;

commit;
