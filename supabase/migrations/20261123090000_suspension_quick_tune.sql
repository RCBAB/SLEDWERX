-- =============================================================================
-- SledWerx migration 9 (Phase 6.2 redesign): Suspension Quick Tune
--
-- * Numbered configurations: every suspension revision gets a sled-wide
--   number (config_number), shown as "Trail 1", "Trail 2", ... Existing
--   revisions are numbered in the order they were saved. Nothing is deleted
--   or renamed; setups stay as an internal grouping.
-- * Equipment snapshots: each revision records the ski model and carbide
--   length it was saved with (ski_model, carbide_length; null = not recorded,
--   which is what every existing revision has).
-- * based_on_revision_id: the configuration a new one was made from (for
--   "Trail 3 -> Trail 5"). Informational only (no foreign key, so purging an
--   old revision never has to update history).
-- * sled_suspension_state: one row per sled: the ACTIVE configuration and the
--   INSTALLED equipment. Read by everyone on the sled; written only by the two
--   functions below (SECURITY DEFINER, with explicit permission checks).
-- * Ride evaluations: suspension_feedback gets trail conditions (any of five)
--   and the day's high temperature (degF, optional), and the ratings liked /
--   neutral / disliked. The earlier ratings (improved / worse / no_change)
--   stay valid, so existing feedback is kept exactly as it was.
-- * Functions:
--   - save_suspension_configuration: new numbered configuration from the
--     active one, with changed values and/or new equipment; becomes active.
--   - activate_suspension_configuration: make an older configuration active
--     (never creates one). Different equipment needs explicit confirmation
--     that it is installed.
-- * A setup that holds the active configuration can't be moved to Recently
--   Deleted.
--
-- Additive: no table, column or row is removed; Migration 7's functions keep
-- working. The rating check is widened (old values still allowed).
-- Rollback: supabase/rollback/20261123090000_rollback.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
alter table public.suspension_revisions
  add column config_number integer check (config_number >= 1),
  add column ski_model text check (ski_model in ('ca_pro_xpt', 'ca_pro_xcs')),
  add column carbide_length text check (carbide_length in ('6', '7.5', '9')),
  add column based_on_revision_id uuid;

comment on column public.suspension_revisions.config_number is
  'Sled-wide configuration number (shown as "Trail N"). Assigned by the database; never reused or changed.';
comment on column public.suspension_revisions.ski_model is
  'Ski model this configuration was saved with (ca_pro_xpt | ca_pro_xcs); null = not recorded.';
comment on column public.suspension_revisions.carbide_length is
  'Carbide length in inches this configuration was saved with (6 | 7.5 | 9); null = not recorded.';
comment on column public.suspension_revisions.based_on_revision_id is
  'The configuration this one was made from (informational; no foreign key).';

alter table public.suspension_feedback
  add column conditions text[] not null default '{}'
    check (conditions <@ array['loose_snow', 'hard_pack', 'perfect_groomed', 'sloppy', 'fresh_snow']::text[]
           and cardinality(conditions) <= 5),
  add column high_temp_f smallint check (high_temp_f between -60 and 120);

alter table public.suspension_feedback drop constraint suspension_feedback_rating_check;
alter table public.suspension_feedback add constraint suspension_feedback_rating_check
  check (rating in ('liked', 'neutral', 'disliked', 'improved', 'worse', 'no_change'));

comment on column public.suspension_feedback.conditions is
  'Trail conditions of the ride: any of loose_snow, hard_pack, perfect_groomed, sloppy, fresh_snow.';
comment on column public.suspension_feedback.high_temp_f is 'Day''s high temperature in degF (optional).';

-- -----------------------------------------------------------------------------
-- 2. Number the existing revisions (per sled, in the order they were saved).
--    Migration 7's triggers forbid editing revisions, so they are switched off
--    for this one update only, inside this migration's transaction.
-- -----------------------------------------------------------------------------
alter table public.suspension_revisions disable trigger user;
update public.suspension_revisions r
set config_number = n.num
from (
  select id, row_number() over (partition by sled_id order by created_at, setup_id, revision_number, id) as num
  from public.suspension_revisions
) n
where n.id = r.id;
alter table public.suspension_revisions enable trigger user;

alter table public.suspension_revisions alter column config_number set not null;
create unique index suspension_revisions_config_number_uniq on public.suspension_revisions (sled_id, config_number);

-- -----------------------------------------------------------------------------
-- 3. sled_suspension_state: active configuration and installed equipment
-- -----------------------------------------------------------------------------
create table public.sled_suspension_state (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null unique references public.sleds (id) on delete cascade,
  active_revision_id uuid references public.suspension_revisions (id) on delete set null,
  ski_model text check (ski_model in ('ca_pro_xpt', 'ca_pro_xcs')),
  carbide_length text check (carbide_length in ('6', '7.5', '9')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

comment on table public.sled_suspension_state is
  'Per sled (Migration 9): the active suspension configuration and the installed skis and carbides. Written only by save_suspension_configuration and activate_suspension_configuration.';

create trigger stamp before insert or update on public.sled_suspension_state
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.sled_suspension_state
  for each row execute function private.tg_audit('maintenance');

revoke all on public.sled_suspension_state from anon, authenticated;
grant select on public.sled_suspension_state to authenticated;
alter table public.sled_suspension_state enable row level security;
create policy "Sled users can view the suspension state"
  on public.sled_suspension_state for select to authenticated
  using (private.has_sled_permission(sled_id, 'view'));

-- Migration 8 (cleanup): a purged sled's state goes with it; count those rows.
do $$
begin
  if to_regprocedure('private.tg_cleanup_count_deletes()') is not null then
    create trigger cleanup_count_deletes after delete on public.sled_suspension_state
      referencing old table as old_rows
      for each statement execute function private.tg_cleanup_count_deletes();
  end if;
end;
$$;

-- Existing sleds: the active configuration is the latest revision of the
-- active setup (or, without one, the latest revision). Equipment not recorded.
insert into public.sled_suspension_state (sled_id, active_revision_id)
select distinct on (r.sled_id) r.sled_id, r.id
from public.suspension_revisions r
join public.suspension_setups s on s.id = r.setup_id
where r.deleted_at is null and s.deleted_at is null
order by r.sled_id, s.is_active desc, r.created_at desc, r.config_number desc;

-- -----------------------------------------------------------------------------
-- 4. New revisions: sled-wide number; equipment defaults to what is installed
--    (runs after Migration 7's "links" trigger, which sets sled_id).
-- -----------------------------------------------------------------------------
create function private.tg_suspension_revisions_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state record;
begin
  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_config:' || new.sled_id::text, 0));
  new.config_number := coalesce(
    (select max(r.config_number) from public.suspension_revisions r where r.sled_id = new.sled_id), 0) + 1;
  if new.ski_model is null and new.carbide_length is null then
    select st.ski_model, st.carbide_length into v_state from public.sled_suspension_state st where st.sled_id = new.sled_id;
    if found then
      new.ski_model := v_state.ski_model;
      new.carbide_length := v_state.carbide_length;
    end if;
  end if;
  return new;
end;
$$;

create trigger number before insert on public.suspension_revisions
  for each row execute function private.tg_suspension_revisions_number();

-- The setup holding the active configuration stays (like the active setup).
create function private.tg_suspension_setups_active_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and exists (
    select 1 from public.sled_suspension_state st
    join public.suspension_revisions r on r.id = st.active_revision_id
    where st.sled_id = old.sled_id and r.setup_id = old.id
  ) then
    raise exception 'This setup holds the active configuration. Make another configuration active first.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger quick_tune before update on public.suspension_setups
  for each row execute function private.tg_suspension_setups_active_config();

revoke all on function
  private.tg_suspension_revisions_number(),
  private.tg_suspension_setups_active_config()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Functions. SECURITY DEFINER because mechanics may record configurations
--    and switch the active one but may not write the state row or setups
--    directly; every call checks the caller's permission on the sled, and the
--    revision triggers (Migration 1's guard included) still run as the caller.
-- -----------------------------------------------------------------------------

-- Save a new configuration from the active one: the given value changes
-- ({"<setting id>": "<value>" or null to clear}) and/or new equipment (null =
-- keep what is installed). It becomes the active configuration. Refused when
-- nothing changed, or when the active configuration is no longer
-- p_base_revision_id (someone else saved or switched meanwhile). A repeat with
-- the same idempotency key returns the configuration already saved.
-- Owners, editors and mechanics.
create function public.save_suspension_configuration(
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

-- Make an earlier configuration the active one. Never creates a
-- configuration. If it was saved with skis or carbides other than the ones
-- installed, p_equipment_installed must confirm they have been fitted; the
-- installed equipment is then updated to match. Owners, editors and mechanics.
create function public.activate_suspension_configuration(
  p_revision_id uuid,
  p_equipment_installed boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rev record;
  v_state record;
  v_mismatch boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in to change the active configuration.' using errcode = '42501';
  end if;
  select r.id, r.sled_id, r.config_number, r.ski_model, r.carbide_length, r.deleted_at into v_rev
  from public.suspension_revisions r where r.id = p_revision_id;
  if not found or not private.has_sled_permission(v_rev.sled_id, 'view') then
    raise exception 'Configuration not found.' using errcode = 'P0002';
  end if;
  if not private.has_sled_permission(v_rev.sled_id, 'add_records') then
    raise exception 'You do not have permission to change this snowmobile''s suspension.' using errcode = '42501';
  end if;
  if v_rev.deleted_at is not null then
    raise exception 'Configuration not found.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sledwerx.suspension_config:' || v_rev.sled_id::text, 0));

  select st.active_revision_id, st.ski_model, st.carbide_length into v_state
  from public.sled_suspension_state st where st.sled_id = v_rev.sled_id;
  if v_state.active_revision_id is not distinct from v_rev.id then
    return jsonb_build_object('revision_id', v_rev.id, 'config_number', v_rev.config_number, 'already_active', true);
  end if;

  v_mismatch := (v_rev.ski_model is not null and v_rev.ski_model is distinct from v_state.ski_model)
             or (v_rev.carbide_length is not null and v_rev.carbide_length is distinct from v_state.carbide_length);
  if v_mismatch and not coalesce(p_equipment_installed, false) then
    raise exception 'Trail % uses different skis or carbides than the ones installed. Confirm the equipment is installed first.', v_rev.config_number
      using errcode = 'P0001', hint = 'equipment_mismatch';
  end if;

  insert into public.sled_suspension_state (sled_id, active_revision_id, ski_model, carbide_length)
  values (v_rev.sled_id, v_rev.id, v_rev.ski_model, v_rev.carbide_length)
  on conflict (sled_id) do update
    set active_revision_id = excluded.active_revision_id,
        ski_model = coalesce(excluded.ski_model, public.sled_suspension_state.ski_model),
        carbide_length = coalesce(excluded.carbide_length, public.sled_suspension_state.carbide_length);

  return jsonb_build_object('revision_id', v_rev.id, 'config_number', v_rev.config_number, 'already_active', false,
    'equipment_changed', v_mismatch);
end;
$$;

revoke all on function
  public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid),
  public.activate_suspension_configuration(uuid, boolean)
from public, anon;
grant execute on function
  public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid),
  public.activate_suspension_configuration(uuid, boolean)
to authenticated;
