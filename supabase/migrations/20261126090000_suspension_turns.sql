-- =============================================================================
-- SledWerx migration 12 (Phase 6.3): suspension Measurement / Turns
--
-- A suspension setting can be measured (Measurement only, the default and
-- every existing setting), adjusted in turns (Turns only), or both. A turns
-- adjustment is a signed change (+2, -1, +0.5), not a total. Each adjustment
-- is a new numbered Trail (save_suspension_configuration, as today); while
-- turns are outstanding the setting's measurement is blank. Back in the
-- garage the actual measurement is documented on the SAME Trail
-- (record_suspension_measurement), which never creates a Trail.
--
-- * suspension_settings.input_methods: measurement | turns | both (number
--   settings only for turns). A setting can't drop Turns while its active
--   Trail shows turns instead of a measurement (record the measurement first).
-- * sled_turn_adjustments: one row per adjustment, written with its Trail by
--   save_suspension_configuration, never changed.
-- * sled_trail_settings: per Trail, per turns-tracked setting: cumulative
--   turns, the documented measurement, Measurement Needed, and whether that
--   Trail requires a new photo. Copied forward on save (a photo requirement
--   only while unmet); only ever written for the Trail being saved or, by
--   record_suspension_measurement, the ACTIVE Trail. Never for other Trails.
-- * sled_measurement_records: each documented measurement and correction,
--   never changed.
-- * sled_measurement_photos.outdated: set on photos carried forward for a
--   setting whose value changed (measurement or turns) in that save.
-- * Photo Needed is derived (suspension_trail_status): the Trail requires a
--   photo and has no active photo of its own (carried_from_id is null) for
--   that setting. Replace, remove and restore therefore need no change; add
--   lets a new photo take the place of an outdated inherited one when both
--   slots are full (part 7).
--
-- Reminders (Both settings only): turns raise Measurement Needed and the
-- photo requirement; a measurement clears Measurement Needed only.
--
-- save_suspension_configuration gains p_turns (a new 10-argument function);
-- the 9-argument Migration 10 function stays, unchanged in behaviour, as a
-- wrapper with p_turns null, so every existing caller keeps working.
-- Additive otherwise. Rollback: supabase/rollback/20261126090000_rollback.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Input methods
-- -----------------------------------------------------------------------------
alter table public.suspension_settings
  add column input_methods text not null default 'measurement'
    check (input_methods in ('measurement', 'turns', 'both')),
  add constraint suspension_settings_turns_number check (input_methods = 'measurement' or value_type = 'number');

comment on column public.suspension_settings.input_methods is
  'Migration 12: how the setting is adjusted: measurement (default), turns, or both.';

-- -----------------------------------------------------------------------------
-- 2. Tables (written only by the functions below; read by everyone on the sled)
-- -----------------------------------------------------------------------------
create table public.sled_turn_adjustments (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  revision_id uuid not null references public.suspension_revisions (id) on delete cascade,
  setting_id uuid not null references public.suspension_settings (id) on delete cascade,
  amount numeric(8, 2) not null check (amount <> 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (revision_id, setting_id)
);
create index sled_turn_adjustments_sled_idx on public.sled_turn_adjustments (sled_id);
create index sled_turn_adjustments_setting_idx on public.sled_turn_adjustments (setting_id);

comment on table public.sled_turn_adjustments is
  'Migration 12: one turns adjustment (signed) per Trail per setting, written with the Trail. Never changed.';

create table public.sled_trail_settings (
  revision_id uuid not null references public.suspension_revisions (id) on delete cascade,
  setting_id uuid not null references public.suspension_settings (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  -- Turns since the last documented measurement (null: none outstanding).
  cumulative_turns numeric(10, 2),
  -- The measurement documented on this Trail (latest record), if any.
  measurement text check (char_length(measurement) between 1 and 200),
  measured_at timestamptz,
  measured_by uuid,
  measurement_needed boolean not null default false,
  photo_required boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (revision_id, setting_id)
);
create index sled_trail_settings_sled_idx on public.sled_trail_settings (sled_id);
create index sled_trail_settings_setting_idx on public.sled_trail_settings (setting_id);

comment on table public.sled_trail_settings is
  'Migration 12: per Trail, per turns-tracked setting: cumulative turns, documented measurement and reminders.';

create table public.sled_measurement_records (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  revision_id uuid not null references public.suspension_revisions (id) on delete cascade,
  setting_id uuid not null references public.suspension_settings (id) on delete cascade,
  value text not null check (char_length(value) between 1 and 200),
  -- The cumulative turns this measurement documents ("after +2.5 turns").
  cumulative_turns numeric(10, 2),
  created_at timestamptz not null default now(),
  created_by uuid
);
create index sled_measurement_records_trail_idx on public.sled_measurement_records (revision_id, setting_id, created_at);
create index sled_measurement_records_sled_idx on public.sled_measurement_records (sled_id);
create index sled_measurement_records_setting_idx on public.sled_measurement_records (setting_id);

comment on table public.sled_measurement_records is
  'Migration 12: each documented measurement and correction on a Trail. Never changed.';

revoke all on public.sled_turn_adjustments, public.sled_trail_settings, public.sled_measurement_records from public, anon, authenticated;
grant select on public.sled_turn_adjustments, public.sled_trail_settings, public.sled_measurement_records to authenticated;
alter table public.sled_turn_adjustments enable row level security;
alter table public.sled_trail_settings enable row level security;
alter table public.sled_measurement_records enable row level security;

create policy "Sled users can view turns adjustments" on public.sled_turn_adjustments
  for select to authenticated using (private.has_sled_permission(sled_id, 'view'));
create policy "Sled users can view Trail settings status" on public.sled_trail_settings
  for select to authenticated using (private.has_sled_permission(sled_id, 'view'));
create policy "Sled users can view measurement records" on public.sled_measurement_records
  for select to authenticated using (private.has_sled_permission(sled_id, 'view'));

-- Carried-forward photos of a setting that changed: "Previous Trail photo, outdated".
alter table public.sled_measurement_photos add column outdated boolean not null default false;

-- Migration 8 cleanup: these rows go with their Trail, setting or sled; count them.
do $$
begin
  if to_regclass('private.cleanup_record_tables') is not null then
    create trigger cleanup_count_deletes after delete on public.sled_turn_adjustments
      referencing old table as old_rows for each statement execute function private.tg_cleanup_count_deletes();
    create trigger cleanup_count_deletes after delete on public.sled_trail_settings
      referencing old table as old_rows for each statement execute function private.tg_cleanup_count_deletes();
    create trigger cleanup_count_deletes after delete on public.sled_measurement_records
      referencing old table as old_rows for each statement execute function private.tg_cleanup_count_deletes();
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. A setting can't drop Turns while its active Trail shows turns
-- -----------------------------------------------------------------------------
create function private.tg_suspension_settings_turns_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.input_methods = 'measurement' and old.input_methods <> 'measurement' and exists (
    select 1 from public.sled_trail_settings t
    join public.sled_suspension_state s on s.active_revision_id = t.revision_id
    where t.setting_id = new.id and t.cumulative_turns is not null and t.measurement is null
  ) then
    raise exception 'Record a measurement for % on the active Trail before switching it to Measurement only.', old.name
      using errcode = '23514', hint = 'turns_outstanding';
  end if;
  return new;
end;
$$;

revoke all on function private.tg_suspension_settings_turns_guard() from public, anon, authenticated;

create trigger turns_guard before update of input_methods on public.suspension_settings
  for each row execute function private.tg_suspension_settings_turns_guard();

-- -----------------------------------------------------------------------------
-- 4. save_suspension_configuration with turns (new 10-argument function).
--    Migration 10's behaviour plus the blocks marked "Migration 12".
-- -----------------------------------------------------------------------------
create function public.save_suspension_configuration(
  p_sled_id uuid,
  p_base_revision_id uuid,
  p_changes jsonb,
  p_ski_model text,
  p_carbide_length text,
  p_note text,
  p_odometer_mi numeric,
  p_engine_hours numeric,
  p_idempotency_key uuid,
  p_turns jsonb
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
  v_turns jsonb := '{}'::jsonb;
  v_key text;
  v_raw jsonb;
  v_amount numeric;
  v_setting record;
  v_row record;
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
  if p_turns is not null and jsonb_typeof(p_turns) <> 'object' then
    raise exception 'Turns must be an object.' using errcode = '22023';
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
    -- Migration 12: a measurement documented on the base Trail is its value.
    select v_base_values || coalesce(jsonb_object_agg(t.setting_id::text, to_jsonb(t.measurement)), '{}'::jsonb)
    into v_base_values
    from public.sled_trail_settings t
    join public.suspension_settings st on st.id = t.setting_id and st.deleted_at is null
    where t.revision_id = p_base_revision_id and t.measurement is not null;
  end if;

  -- Migration 12: check the turns (setting -> signed amount; 0 means no change).
  for v_key, v_raw in select key, value from jsonb_each(coalesce(p_turns, '{}'::jsonb)) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Unknown setting.' using errcode = '22023';
    end if;
    select st.name, st.input_methods into v_setting from public.suspension_settings st
    where st.id = v_key::uuid and st.sled_id = p_sled_id and st.deleted_at is null;
    if not found then
      raise exception 'That setting is not on this snowmobile.' using errcode = '23514';
    end if;
    if v_setting.input_methods = 'measurement' then
      raise exception '% is not adjusted in turns.', v_setting.name using errcode = '22023';
    end if;
    if jsonb_typeof(v_raw) not in ('number', 'string') or btrim(v_raw #>> '{}') !~ '^[-+]?[0-9]+(\.[0-9]+)?$' then
      raise exception 'Enter the turns for % as a number.', v_setting.name using errcode = '22023';
    end if;
    v_amount := btrim(v_raw #>> '{}')::numeric;
    if v_amount <> round(v_amount, 2) or abs(v_amount) >= 1000000 then
      raise exception 'Enter the turns for % with at most two decimals.', v_setting.name using errcode = '22023';
    end if;
    if p_changes ? v_key then
      raise exception 'Enter either a measurement or turns for %, not both.', v_setting.name using errcode = '22023';
    end if;
    if v_amount <> 0 then
      v_turns := v_turns || jsonb_build_object(v_key, v_amount);
    end if;
  end loop;

  -- Migration 12: measurements can't be entered for a Turns only setting, or
  -- while the base Trail shows turns for it (document the measurement first).
  for v_key in select key from jsonb_each(p_changes) loop
    select st.name, st.input_methods into v_setting from public.suspension_settings st
    where st.id::text = v_key and st.sled_id = p_sled_id and st.deleted_at is null;
    continue when not found;
    if v_setting.input_methods = 'turns' then
      raise exception '% is adjusted in turns.', v_setting.name using errcode = '22023';
    end if;
    if exists (select 1 from public.sled_trail_settings t
               where t.revision_id = p_base_revision_id and t.setting_id::text = v_key
                 and t.cumulative_turns is not null and t.measurement is null) then
      raise exception 'Record the measurement for % first.', v_setting.name using errcode = '22023', hint = 'turns_outstanding';
    end if;
  end loop;

  -- Carry every unchanged value forward; apply the changes (null or "" clears).
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_values
  from (
    select key as k, value as v from jsonb_each(v_base_values) where not p_changes ? key
    union all
    select key, to_jsonb(btrim(value #>> '{}')) from jsonb_each(p_changes)
    where jsonb_typeof(value) in ('string', 'number') and btrim(value #>> '{}') <> ''
  ) merged;
  -- Migration 12: a turned setting's measurement is blank until documented.
  v_values := v_values - array(select jsonb_object_keys(v_turns));

  v_ski := coalesce(p_ski_model, v_state.ski_model);
  v_carbide := coalesce(p_carbide_length, v_state.carbide_length);
  if p_base_revision_id is not null and v_values = v_base_values and v_turns = '{}'::jsonb
     and v_ski is not distinct from v_state.ski_model and v_carbide is not distinct from v_state.carbide_length then
    raise exception 'Nothing changed.' using errcode = '22023';
  end if;
  if p_base_revision_id is null and v_values = '{}'::jsonb and v_turns = '{}'::jsonb and v_ski is null and v_carbide is null then
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
  -- Migration 12: outdated when that setting's value changed in this save.
  if p_base_revision_id is not null then
    insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot, carried_from_id, outdated)
    select p_sled_id, v_revision.id, m.setting_id, m.path, m.slot, m.id,
           m.outdated or v_turns ? m.setting_id::text
             or (v_values -> m.setting_id::text) is distinct from (v_base_values -> m.setting_id::text)
    from public.sled_measurement_photos m
    join public.suspension_settings st on st.id = m.setting_id and st.deleted_at is null
    where m.revision_id = p_base_revision_id and m.deleted_at is null;
  end if;

  -- Migration 12: the turns adjustments and the new Trail's per-setting status.
  insert into public.sled_turn_adjustments (sled_id, revision_id, setting_id, amount, created_by)
  select p_sled_id, v_revision.id, t.key::uuid, t.value::text::numeric, v_uid from jsonb_each(v_turns) t;

  for v_row in
    select st.id as setting_id, st.input_methods, b.cumulative_turns, b.measurement, b.measurement_needed,
           b.photo_required and not exists (
             select 1 from public.sled_measurement_photos m
             where m.revision_id = p_base_revision_id and m.setting_id = st.id and m.deleted_at is null and m.carried_from_id is null
           ) as photo_unmet,
           (v_turns ->> st.id::text)::numeric as amount
    from public.suspension_settings st
    left join public.sled_trail_settings b on b.revision_id = p_base_revision_id and b.setting_id = st.id
    where st.sled_id = p_sled_id and st.deleted_at is null and (b.setting_id is not null or v_turns ? st.id::text)
  loop
    if v_row.amount is not null then
      insert into public.sled_trail_settings (revision_id, setting_id, sled_id, cumulative_turns, measurement_needed, photo_required)
      values (v_revision.id, v_row.setting_id, p_sled_id,
              case when v_row.cumulative_turns is not null and v_row.measurement is null
                   then v_row.cumulative_turns + v_row.amount else v_row.amount end,
              v_row.input_methods = 'both', v_row.input_methods = 'both');
    else
      -- Unchanged (or measured in this save): outstanding turns and reminders
      -- carry forward; a documented measurement is now the Trail's value.
      insert into public.sled_trail_settings (revision_id, setting_id, sled_id, cumulative_turns, measurement_needed, photo_required)
      select v_revision.id, v_row.setting_id, p_sled_id, c.turns, coalesce(v_row.measurement_needed, false) and c.turns is not null,
             coalesce(v_row.photo_unmet, false)
      from (select case when v_row.measurement is null and not p_changes ? v_row.setting_id::text
                        then v_row.cumulative_turns end as turns) c
      where c.turns is not null or coalesce(v_row.photo_unmet, false);
    end if;
  end loop;

  insert into public.sled_suspension_state (sled_id, active_revision_id, ski_model, carbide_length)
  values (p_sled_id, v_revision.id, v_ski, v_carbide)
  on conflict (sled_id) do update
    set active_revision_id = excluded.active_revision_id,
        ski_model = excluded.ski_model,
        carbide_length = excluded.carbide_length;

  return jsonb_build_object('revision_id', v_revision.id, 'config_number', v_revision.config_number, 'duplicate', false);
end;
$$;

-- The 9-argument function (Migrations 9 and 10): the same save without turns.
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
language sql
volatile
security definer
set search_path = ''
as $$
  select public.save_suspension_configuration(p_sled_id, p_base_revision_id, p_changes, p_ski_model, p_carbide_length,
                                              p_note, p_odometer_mi, p_engine_hours, p_idempotency_key, null::jsonb);
$$;

-- -----------------------------------------------------------------------------
-- 5. Document the measurement on the ACTIVE Trail (no new Trail). Owners,
--    editors and mechanics. A repeat with another value is a correction; every
--    record is kept. Never touches any other Trail.
-- -----------------------------------------------------------------------------
create function public.record_suspension_measurement(p_revision_id uuid, p_setting_id uuid, p_value text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_rev record;
  v_setting record;
  v_row record;
  v_value text := btrim(p_value);
begin
  if v_uid is null then
    raise exception 'Sign in to record measurements.' using errcode = '42501';
  end if;
  select r.sled_id, r.deleted_at into v_rev from public.suspension_revisions r where r.id = p_revision_id;
  if not found or v_rev.deleted_at is not null or not private.has_sled_permission(v_rev.sled_id, 'add_records') then
    raise exception 'You do not have permission to change this snowmobile''s suspension.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_config:' || v_rev.sled_id::text, 0));

  if not exists (select 1 from public.sled_suspension_state s where s.sled_id = v_rev.sled_id and s.active_revision_id = p_revision_id) then
    raise exception 'Make this Trail active before recording a measurement on it.' using errcode = 'PT409', hint = 'not_active';
  end if;
  select st.name, st.input_methods into v_setting from public.suspension_settings st
  where st.id = p_setting_id and st.sled_id = v_rev.sled_id and st.deleted_at is null;
  if not found then
    raise exception 'That setting is not on this snowmobile.' using errcode = '23514';
  end if;
  if v_setting.input_methods <> 'both' then
    raise exception 'Switch % to Measurement and Turns to record a measurement.', v_setting.name using errcode = '22023';
  end if;
  select t.cumulative_turns, t.measurement into v_row from public.sled_trail_settings t
  where t.revision_id = p_revision_id and t.setting_id = p_setting_id for update;
  if not found or (v_row.cumulative_turns is null and v_row.measurement is null) then
    raise exception 'There are no turns to document for % on this Trail.', v_setting.name using errcode = '22023';
  end if;
  if v_value is null or v_value = '' or char_length(v_value) > 200 or v_value !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception 'Enter a number for %.', v_setting.name using errcode = '22023';
  end if;
  if v_value = v_row.measurement then
    return jsonb_build_object('revision_id', p_revision_id, 'setting_id', p_setting_id, 'measurement', v_value, 'duplicate', true);
  end if;

  insert into public.sled_measurement_records (sled_id, revision_id, setting_id, value, cumulative_turns, created_by)
  values (v_rev.sled_id, p_revision_id, p_setting_id, v_value, v_row.cumulative_turns, v_uid);
  update public.sled_trail_settings
  set measurement = v_value, measured_at = now(), measured_by = v_uid, measurement_needed = false, updated_at = now()
  where revision_id = p_revision_id and setting_id = p_setting_id;

  return jsonb_build_object('revision_id', p_revision_id, 'setting_id', p_setting_id, 'measurement', v_value,
                            'correction', v_row.measurement is not null, 'duplicate', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Status of turns-tracked settings on some Trails (the active one for the
--    dashboards, any for History). SECURITY INVOKER: the caller's RLS applies.
-- -----------------------------------------------------------------------------
create function public.suspension_trail_status(p_revision_ids uuid[])
returns table (
  revision_id uuid,
  setting_id uuid,
  cumulative_turns numeric,
  measurement text,
  measured_at timestamptz,
  measurement_needed boolean,
  photo_needed boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.revision_id, t.setting_id, t.cumulative_turns, t.measurement, t.measured_at, t.measurement_needed,
         t.photo_required and not exists (
           select 1 from public.sled_measurement_photos m
           where m.revision_id = t.revision_id and m.setting_id = t.setting_id and m.deleted_at is null and m.carried_from_id is null
         ) as photo_needed
  from public.sled_trail_settings t
  join public.suspension_settings st on st.id = t.setting_id and st.deleted_at is null
  where t.revision_id = any(p_revision_ids);
$$;

revoke all on function
  public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid, jsonb),
  public.record_suspension_measurement(uuid, uuid, text),
  public.suspension_trail_status(uuid[])
from public, anon;
grant execute on function
  public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid, jsonb),
  public.record_suspension_measurement(uuid, uuid, text),
  public.suspension_trail_status(uuid[])
to authenticated;

-- -----------------------------------------------------------------------------
-- 7. add_suspension_measurement_photo (Migration 10) when both slots hold
--    photos: a new photo takes the place of an OUTDATED INHERITED one (a
--    reference copy carried from an earlier Trail; that Trail keeps its own
--    photo and the file). Otherwise identical: still at most 2 photos per
--    measurement, and a measurement with current photos is still refused.
--    Without this, a mechanic (who can add but not remove photos) could never
--    clear Photo Needed on a Trail that inherited two outdated photos.
-- -----------------------------------------------------------------------------
create function private.take_outdated_photo_slot(p_revision_id uuid, p_setting_id uuid)
returns smallint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_photo record;
begin
  select m.id, m.slot, m.sled_id into v_photo from public.sled_measurement_photos m
  where m.revision_id = p_revision_id and m.setting_id = p_setting_id and m.deleted_at is null
    and m.carried_from_id is not null and m.outdated
  order by m.slot limit 1;
  if not found or not private.has_sled_permission(v_photo.sled_id, 'add_records') then
    return null;
  end if;
  delete from public.sled_measurement_photos where id = v_photo.id;
  return v_photo.slot;
end;
$$;

revoke all on function private.take_outdated_photo_slot(uuid, uuid) from public, anon;
grant execute on function private.take_outdated_photo_slot(uuid, uuid) to authenticated;

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
    -- Migration 12: take the place of an outdated inherited photo, if any.
    v_slot := private.take_outdated_photo_slot(p_revision_id, p_setting_id);
  end if;
  if v_slot is null then
    raise exception 'At most 2 photos per measurement.' using errcode = '23514';
  end if;
  insert into public.sled_measurement_photos (sled_id, revision_id, setting_id, path, slot)
  values ((select r.sled_id from public.suspension_revisions r where r.id = p_revision_id), p_revision_id, p_setting_id, p_path, v_slot)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'slot', v_slot, 'duplicate', false);
end;
$$;
