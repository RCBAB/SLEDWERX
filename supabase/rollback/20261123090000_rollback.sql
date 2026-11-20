-- =============================================================================
-- SledWerx — ROLLBACK for Migration 9
--   20261123090000_suspension_quick_tune.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 9 added: sled_suspension_state, the two
--   public functions, the two trigger functions and their triggers, the new
--   revision and feedback columns, and the configuration-number index; puts
--   back Migration 7's rating check (improved / worse / no_change). Also
--   removes Migration 9's migration-history entry. All in ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261123090000';
-- * REFUSES to run while anything exists that Migration 7 can't hold: a
--   configuration with recorded skis or carbides, installed equipment, a ride
--   evaluation with a liked / neutral / disliked rating, trail conditions or a
--   temperature. Configuration numbers and the active-configuration pointer
--   are worked out again if Migration 9 is re-applied (numbers in save order;
--   active = latest revision of the active setup), so they are not kept.
-- * Revisions saved by save_suspension_configuration stay as ordinary
--   Migration 7 revisions of their setup.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261123090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261123090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if to_regclass('public.sled_suspension_state') is not null then
    select count(*) into v_rows from public.sled_suspension_state where ski_model is not null or carbide_length is not null;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % snowmobile(s) have installed skis or carbides recorded. Fix forward instead.', v_rows;
    end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'suspension_revisions' and column_name = 'ski_model') then
    select count(*) into v_rows from public.suspension_revisions where ski_model is not null or carbide_length is not null;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % configuration(s) have skis or carbides recorded. Fix forward instead.', v_rows;
    end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'suspension_feedback' and column_name = 'conditions') then
    select count(*) into v_rows from public.suspension_feedback
    where rating in ('liked', 'neutral', 'disliked') or cardinality(conditions) > 0 or high_temp_f is not null;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % ride evaluation(s) use Migration 9 ratings, conditions or temperatures. Fix forward instead.', v_rows;
    end if;
  end if;
end $$;

-- 2. Functions and triggers.
drop function if exists public.activate_suspension_configuration(uuid, boolean);
drop function if exists public.save_suspension_configuration(uuid, uuid, jsonb, text, text, text, numeric, numeric, uuid);
drop trigger if exists quick_tune on public.suspension_setups;
drop trigger if exists number on public.suspension_revisions;
drop function if exists private.tg_suspension_setups_active_config();
drop function if exists private.tg_suspension_revisions_number();

-- 3. The state table (its triggers and policy go with it). No CASCADE.
drop table if exists public.sled_suspension_state;

-- 4. Columns, index and the rating check.
drop index if exists public.suspension_revisions_config_number_uniq;
alter table public.suspension_revisions
  drop column if exists based_on_revision_id,
  drop column if exists carbide_length,
  drop column if exists ski_model,
  drop column if exists config_number;
alter table public.suspension_feedback
  drop column if exists high_temp_f,
  drop column if exists conditions;
alter table public.suspension_feedback drop constraint if exists suspension_feedback_rating_check;
alter table public.suspension_feedback add constraint suspension_feedback_rating_check
  check (rating in ('improved', 'worse', 'no_change'));

-- 5. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261123090000';

-- 6. Verify; any leftover undoes the whole rollback.
do $$
begin
  if to_regclass('public.sled_suspension_state') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'private')
                  and p.proname in ('save_suspension_configuration', 'activate_suspension_configuration',
                                    'tg_suspension_revisions_number', 'tg_suspension_setups_active_config'))
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and ((table_name = 'suspension_revisions' and column_name in ('config_number', 'ski_model', 'carbide_length', 'based_on_revision_id'))
                  or (table_name = 'suspension_feedback' and column_name in ('conditions', 'high_temp_f'))))
  then
    raise exception 'Rollback verification failed: Migration 9 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 9 removed; Migrations 1-8 untouched.';
end $$;

commit;
