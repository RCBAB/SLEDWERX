-- =============================================================================
-- SledWerx — ROLLBACK for Migration 12
--   20261126090000_suspension_turns.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes sled_turn_adjustments, sled_trail_settings and
--   sled_measurement_records, record_suspension_measurement,
--   suspension_trail_status, the 10-argument save_suspension_configuration,
--   the input-method guard, suspension_settings.input_methods and
--   sled_measurement_photos.outdated; puts back Migration 10's
--   save_suspension_configuration and add_suspension_measurement_photo exactly
--   as they were. Also removes Migration 12's migration-history entry. All in
--   ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261126090000';
-- * REFUSES to run while any turns data exists (an adjustment, a Trail status
--   row or a documented measurement) or any setting uses Turns, so no turns
--   history is ever lost. The "outdated" photo labels are the only information
--   removed (labels only; every photo row and file stays).
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261126090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261126090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if to_regclass('public.sled_trail_settings') is not null then
    select (select count(*) from public.sled_turn_adjustments) + (select count(*) from public.sled_trail_settings)
           + (select count(*) from public.sled_measurement_records) into v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % turns row(s) exist. Fix forward instead.', v_rows;
    end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'suspension_settings' and column_name = 'input_methods') then
    execute 'select count(*) from public.suspension_settings where input_methods <> ''measurement''' into v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % setting(s) use Turns. Switch them to Measurement only first, or fix forward.', v_rows;
    end if;
  end if;
end $$;

-- 2. Migration 10's save_suspension_configuration (9 arguments), exactly as it was.
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

-- 3. Migration 10's add_suspension_measurement_photo, exactly as it was.
create or replace function public.add_suspension_measurement_photo(p_revision_id uuid, p_setting_id uuid, p_path text)
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

-- 4. Migration 12's functions, trigger, tables and columns (tables empty, checked above). No CASCADE.
drop function if exists public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid, jsonb);
drop function if exists public.record_suspension_measurement(uuid, uuid, text);
drop function if exists public.suspension_trail_status(uuid[]);
drop function if exists private.take_outdated_photo_slot(uuid, uuid);
drop trigger if exists turns_guard on public.suspension_settings;
drop function if exists private.tg_suspension_settings_turns_guard();
drop table if exists public.sled_measurement_records;
drop table if exists public.sled_trail_settings;
drop table if exists public.sled_turn_adjustments;
alter table public.sled_measurement_photos drop column if exists outdated;
alter table public.suspension_settings drop constraint if exists suspension_settings_turns_number;
alter table public.suspension_settings drop column if exists input_methods;

-- 5. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261126090000';

-- 6. Verify; any leftover undoes the whole rollback.
do $$
begin
  if to_regclass('public.sled_trail_settings') is not null or to_regclass('public.sled_turn_adjustments') is not null
     or to_regclass('public.sled_measurement_records') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and ((table_name = 'suspension_settings' and column_name = 'input_methods')
                     or (table_name = 'sled_measurement_photos' and column_name = 'outdated')))
     or exists (select 1 from pg_proc where proname in ('record_suspension_measurement', 'suspension_trail_status',
                                                        'take_outdated_photo_slot', 'tg_suspension_settings_turns_guard'))
     or (select count(*) from pg_proc where proname = 'save_suspension_configuration') <> 1
     or position('Migration 12' in pg_get_functiondef('public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)'::regprocedure)) > 0
     or position('Migration 12' in pg_get_functiondef('public.add_suspension_measurement_photo(uuid,uuid,text)'::regprocedure)) > 0
  then
    raise exception 'Rollback verification failed: Migration 12 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 12 removed; Migrations 1-11 untouched.';
end $$;

commit;
