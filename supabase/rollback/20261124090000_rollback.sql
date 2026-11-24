-- =============================================================================
-- SledWerx — ROLLBACK for Migration 10
--   20261124090000_suspension_measurement_photos.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes sled_measurement_photos (with its triggers and policies), the two
--   photo functions, the revision cascade trigger and the trigger functions,
--   and Migration 10's entries in the Migration 8 cleanup registries; puts
--   back Migration 9's save_suspension_configuration (no photo carry-forward).
--   Also removes Migration 10's migration-history entry. All in ONE
--   transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261124090000';
-- * REFUSES to run while any measurement photo row exists (including Recently
--   Deleted), so no photo reference is ever lost. Files in Storage are never
--   touched by this script.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261124090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261124090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if position('sled_measurement_photos' in coalesce((select prosrc from pg_proc where proname = 'suspension_photo_sled_id'), '')) > 0 then
    raise exception 'Rollback aborted: Migration 11 (measurement photo access) is applied. Roll back Migration 11 first.';
  end if;
  if to_regclass('public.sled_measurement_photos') is not null then
    select count(*) into v_rows from public.sled_measurement_photos;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % measurement photo row(s) exist. Fix forward instead.', v_rows;
    end if;
  end if;
end $$;

-- 2. Functions, triggers and the table (empty, checked above). No CASCADE.
drop function if exists public.replace_suspension_measurement_photo(uuid, integer, text);
drop function if exists public.add_suspension_measurement_photo(uuid, uuid, text);
drop trigger if exists cascade_measurement_photos on public.suspension_revisions;
drop table if exists public.sled_measurement_photos;
drop function if exists private.tg_suspension_revisions_measurement_cascade();
drop function if exists private.tg_sled_measurement_photos_check();

-- 3. Migration 8 registries.
do $$
begin
  if to_regclass('private.cleanup_record_tables') is not null then
    delete from private.storage_reference_columns where table_name = 'sled_measurement_photos';
    delete from private.cleanup_record_tables where table_name = 'sled_measurement_photos';
  end if;
end $$;

-- 4. Migration 9's save_suspension_configuration, exactly as it was.
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

  insert into public.sled_suspension_state (sled_id, active_revision_id, ski_model, carbide_length)
  values (p_sled_id, v_revision.id, v_ski, v_carbide)
  on conflict (sled_id) do update
    set active_revision_id = excluded.active_revision_id,
        ski_model = excluded.ski_model,
        carbide_length = excluded.carbide_length;

  return jsonb_build_object('revision_id', v_revision.id, 'config_number', v_revision.config_number, 'duplicate', false);
end;
$$;

-- 5. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261124090000';

-- 6. Verify; any leftover undoes the whole rollback.
do $$
begin
  if to_regclass('public.sled_measurement_photos') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'private') and p.proname like '%measurement%')
     or exists (select 1 from pg_trigger where tgname = 'cascade_measurement_photos')
     or position('measurement' in pg_get_functiondef('public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)'::regprocedure)) > 0
  then
    raise exception 'Rollback verification failed: Migration 10 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 10 removed; Migrations 1-9 untouched.';
end $$;

commit;
