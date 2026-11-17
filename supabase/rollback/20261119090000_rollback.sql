-- =============================================================================
-- SledWerx — ROLLBACK for Migration 5
--   20261119090000_maintenance_board.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes everything Migration 5 created (the maintenance_board view, the
--   warning settings function, the "done before SledWerx" date trigger, the
--   seasonal columns and their check) and restores Migration 2's rule that a
--   plan needs at least one interval, exactly. Also removes Migration 5's
--   migration-history entry. All in ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261119090000';
-- * REFUSES to run while any plan is seasonal or has no interval (it would
--   lose the season, or break Migration 2's rule).
-- * Plans, tasks and service records are ordinary Migration 2 data and are
--   kept. Migrations 1-4 are untouched.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261119090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261119090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'maintenance_plans' and column_name = 'season_due_month') then
    execute 'select count(*) from public.maintenance_plans where season_due_month is not null' into strict v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % plan(s) have a seasonal schedule. Do not roll back once they are used; fix forward instead.', v_rows;
    end if;
  end if;

  select count(*) into v_rows from public.maintenance_plans
  where num_nonnulls(interval_mi, interval_hours, interval_days) = 0;
  if v_rows > 0 then
    raise exception 'Rollback aborted: % plan(s) have no interval (unscheduled board items). Do not roll back once they are used; fix forward instead.', v_rows;
  end if;
end $$;

-- 2. The board and its settings. No CASCADE: anything unexpected depending on
--    them stops the rollback.
drop view if exists public.maintenance_board;
drop function if exists private.maintenance_warning_settings(uuid);

-- 3. Plans: date trigger, seasonal columns, and Migration 2's interval rule.
drop trigger if exists date_check on public.maintenance_plans;
drop function if exists private.tg_maintenance_plans_date_check();
alter table public.maintenance_plans drop constraint if exists maintenance_plans_season_check;
alter table public.maintenance_plans drop column if exists season_due_day;
alter table public.maintenance_plans drop column if exists season_due_month;
alter table public.maintenance_plans
  add constraint maintenance_plans_check check (num_nonnulls(interval_mi, interval_hours, interval_days) >= 1);

-- 4. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261119090000';

-- 5. Verify; any leftover undoes the whole rollback.
do $$
begin
  if to_regclass('public.maintenance_board') is not null
     or to_regprocedure('private.maintenance_warning_settings(uuid)') is not null
     or to_regprocedure('private.tg_maintenance_plans_date_check()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and table_name = 'maintenance_plans' and column_name in ('season_due_month', 'season_due_day'))
     or (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid = 'public.maintenance_plans'::regclass and conname = 'maintenance_plans_check')
        is distinct from 'CHECK ((num_nonnulls(interval_mi, interval_hours, interval_days) >= 1))'
  then
    raise exception 'Rollback verification failed: Migration 5 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 5 removed; Migrations 1-4 untouched.';
end $$;

commit;
