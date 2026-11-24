-- =============================================================================
-- SledWerx — ROLLBACK for Migration 13
--   20261127090000_maintenance_inspections.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes save_maintenance_inspection, the inspection columns of
--   maintenance_plans (tracks, the inspection schedule and starting point,
--   replace as needed, season labels, starting-point kinds) and
--   maintenance_entry_tasks.outcome; puts back Migration 5's maintenance_board
--   exactly as it was. Also removes Migration 13's migration-history entry.
--   All in ONE transaction.
-- * REFUSES to run unless confirmed in the same session:
--       set sledwerx.confirm_rollback = '20261127090000';
-- * REFUSES to run while any Check (an item with an outcome) exists or any
--   schedule uses inspection tracking, so no inspection history is lost.
-- * Lives outside supabase/migrations/ and is never run by the CLI or CI
--   against a real database.
-- =============================================================================
begin;

-- 1. Safety checks.
do $$
declare
  v_rows bigint;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261127090000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261127090000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'maintenance_entry_tasks' and column_name = 'outcome') then
    execute 'select count(*) from public.maintenance_entry_tasks where outcome is not null' into v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % checked item(s) exist. Fix forward instead.', v_rows;
    end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'maintenance_plans' and column_name = 'tracks') then
    execute $q$select count(*) from public.maintenance_plans
               where tracks <> 'replacement' or replace_as_needed or season_kind is not null or replace_baseline_kind is not null
                  or num_nonnulls(inspect_interval_mi, inspect_interval_hours, inspect_interval_days, inspect_season_month,
                                  inspect_season_kind, inspect_baseline_on, inspect_baseline_mi, inspect_baseline_hours,
                                  inspect_baseline_kind) > 0
                  or inspect_each_reading$q$ into v_rows;
    if v_rows > 0 then
      raise exception 'Rollback aborted: % schedule(s) use inspection tracking. Fix forward instead.', v_rows;
    end if;
  end if;
end $$;

-- 2. The board is re-created below, after the columns are gone (its plans CTE selects p.*).
drop view if exists public.maintenance_board;


-- 3. Migration 13's function, trigger, constraints and columns (unused, checked above). No CASCADE.
drop function if exists public.save_maintenance_inspection(uuid, uuid, date, jsonb, jsonb, text, text);
drop trigger if exists inspect_date_check on public.maintenance_plans;
drop function if exists private.tg_maintenance_plans_inspect_date_check();
alter table public.maintenance_plans drop constraint if exists maintenance_plans_inspect_season_check;
alter table public.maintenance_plans
  drop column if exists tracks,
  drop column if exists replace_as_needed,
  drop column if exists season_kind,
  drop column if exists replace_baseline_kind,
  drop column if exists inspect_interval_mi,
  drop column if exists inspect_interval_hours,
  drop column if exists inspect_interval_days,
  drop column if exists inspect_season_month,
  drop column if exists inspect_season_day,
  drop column if exists inspect_season_kind,
  drop column if exists inspect_each_reading,
  drop column if exists inspect_baseline_on,
  drop column if exists inspect_baseline_mi,
  drop column if exists inspect_baseline_hours,
  drop column if exists inspect_baseline_kind;
alter table public.maintenance_entry_tasks drop constraint if exists maintenance_entry_tasks_outcome_done;
alter table public.maintenance_entry_tasks drop column if exists outcome;

-- 4. Migration 5's board, exactly as it was.
create view public.maintenance_board
with (security_invoker = true)
as
with plans as (
  select p.*, t.name as task_name
  from public.maintenance_plans p
  join public.maintenance_tasks t on t.id = p.task_id and t.deleted_at is null
  join public.sleds s on s.id = p.sled_id and s.deleted_at is null
  where p.deleted_at is null
),
meters as (
  select h.sled_id,
         (array_agg(h.total_mi order by h.read_on desc, h.created_at desc, h.id desc)
            filter (where h.total_mi is not null))[1] as current_mi,
         (array_agg(h.total_engine_hours order by h.read_on desc, h.created_at desc, h.id desc)
            filter (where h.total_engine_hours is not null))[1] as current_hours
  from public.sled_reading_history h
  group by h.sled_id
),
completions as (
  select distinct on (et.sled_id, et.task_id)
         et.sled_id, et.task_id, e.id as entry_id, e.performed_on, e.reading_id,
         h.total_mi, h.total_engine_hours
  from public.maintenance_entry_tasks et
  join public.maintenance_entries e on e.id = et.entry_id
  left join public.sled_reading_history h on h.id = e.reading_id
  where et.deleted_at is null and et.done and et.task_id is not null
    and e.deleted_at is null and e.completed
  order by et.sled_id, et.task_id, e.performed_on desc, e.created_at desc, e.id desc
),
last_done as (
  select p.id as plan_id,
         case
           when c.entry_id is not null and (p.last_done_on is null or c.performed_on >= p.last_done_on) then 'service'
           when p.last_done_on is not null or p.last_done_mi is not null or p.last_done_hours is not null then 'baseline'
         end as source,
         c.entry_id, c.performed_on, c.reading_id, c.total_mi, c.total_engine_hours
  from plans p
  left join completions c on c.sled_id = p.sled_id and c.task_id = p.task_id
),
resolved as (
  select p.*,
         ld.source as last_done_source,
         case when ld.source = 'service' then ld.entry_id end as last_done_entry_id,
         case ld.source when 'service' then ld.performed_on when 'baseline' then p.last_done_on end as done_on,
         case ld.source when 'service' then ld.total_mi when 'baseline' then p.last_done_mi end as done_mi,
         case ld.source when 'service' then ld.total_engine_hours when 'baseline' then p.last_done_hours end as done_hours,
         m.current_mi,
         m.current_hours,
         w.percent, w.min_mi, w.min_hours, w.min_days, w.max_days, w.season_days,
         -- The current season (July-June) starts on July 1 of this year or last.
         make_date(extract(year from current_date)::int - case when extract(month from current_date) < 7 then 1 else 0 end, 7, 1)
           as season_start
  from plans p
  join last_done ld on ld.plan_id = p.id
  left join meters m on m.sled_id = p.sled_id
  cross join lateral private.maintenance_warning_settings((select auth.uid())) w
),
due as (
  select r.*,
         case when r.interval_days is not null and r.done_on is not null then r.done_on + r.interval_days end as due_by_days,
         case when r.season_due_month is not null then
           (
             -- This season's due date, or next season's if already done this season.
             with s as (
               select (extract(year from r.season_start)::int
                        + case when r.season_due_month < 7 then 1 else 0 end
                        + case when r.done_on >= r.season_start then 1 else 0 end) as y
             )
             select least(make_date(s.y, r.season_due_month, 1) + (r.season_due_day - 1),
                          (make_date(s.y, r.season_due_month, 1) + interval '1 month - 1 day')::date)
             from s
           )
         end as due_by_season,
         case when r.interval_mi is not null and r.done_mi is not null then r.done_mi + r.interval_mi end as due_mi,
         case when r.interval_hours is not null and r.done_hours is not null then r.done_hours + r.interval_hours end as due_hours
  from resolved r
),
measured as (
  select d.*,
         least(d.due_by_days, d.due_by_season) as due_on,
         d.due_mi - d.current_mi as remaining_mi,
         d.due_hours - d.current_hours as remaining_hours,
         least(d.due_by_days, d.due_by_season) - current_date as remaining_days,
         -- Warning windows for this plan.
         greatest(d.min_mi, d.percent * d.interval_mi) as warn_mi,
         greatest(d.min_hours, d.percent * d.interval_hours) as warn_hours,
         least(d.max_days, greatest(d.min_days, ceil(d.percent * d.interval_days)::int)) as warn_days,
         -- Each dimension: 2 overdue, 1 upcoming, 0 good, null not measurable.
         case when d.due_mi is not null and d.current_mi is not null then
           case when d.current_mi > d.due_mi then 2
                when d.due_mi - d.current_mi <= greatest(d.min_mi, d.percent * d.interval_mi) then 1 else 0 end
         end as state_mi,
         case when d.due_hours is not null and d.current_hours is not null then
           case when d.current_hours > d.due_hours then 2
                when d.due_hours - d.current_hours <= greatest(d.min_hours, d.percent * d.interval_hours) then 1 else 0 end
         end as state_hours,
         case when d.due_by_days is not null then
           case when current_date > d.due_by_days then 2
                when d.due_by_days - current_date <= least(d.max_days, greatest(d.min_days, ceil(d.percent * d.interval_days)::int)) then 1
                else 0 end
         end as state_days,
         case when d.due_by_season is not null then
           case when current_date > d.due_by_season then 2
                when d.due_by_season - current_date <= d.season_days then 1 else 0 end
         end as state_season
  from due d
),
classified as (
  select m.*,
         greatest(m.state_mi, m.state_hours, m.state_days, m.state_season) as worst,
         (m.interval_mi is null and m.interval_hours is null and m.interval_days is null and m.season_due_month is null) as unscheduled,
         -- A mileage interval exists but the last service didn't record its mileage.
         (m.interval_mi is not null and m.last_done_source is not null and m.done_mi is null) as mileage_unknown,
         (m.interval_hours is not null and m.last_done_source is not null and m.done_hours is null) as hours_unknown
  from measured m
)
select
  c.id as plan_id,
  c.sled_id,
  c.task_id,
  c.task_name,
  c.interval_mi,
  c.interval_hours,
  c.interval_days,
  c.season_due_month,
  c.season_due_day,
  c.paused,
  c.notes,
  c.last_done_on as baseline_on,
  c.last_done_mi as baseline_mi,
  c.last_done_hours as baseline_hours,
  c.version,
  c.created_by,
  c.last_done_source,
  c.last_done_entry_id,
  c.done_on as last_done_on,
  c.done_mi as last_done_mi,
  c.done_hours as last_done_hours,
  c.mileage_unknown,
  c.hours_unknown,
  c.current_mi,
  c.current_hours,
  c.due_on,
  c.due_mi,
  c.due_hours,
  c.remaining_mi,
  c.remaining_hours,
  c.remaining_days,
  c.warn_mi,
  c.warn_hours,
  c.warn_days,
  c.season_days as warn_season_days,
  case
    when c.paused then 'paused'
    when c.unscheduled then 'unscheduled'
    when c.worst = 2 then 'overdue'
    when c.worst = 1 then 'upcoming'
    when c.last_done_source is null and c.season_due_month is null then 'no_record'
    when c.worst is null and (c.mileage_unknown or c.hours_unknown) then 'mileage_unknown'
    when c.worst is null then 'no_record'
    else 'good'
  end as status,
  case
    when c.paused or c.unscheduled then 3
    when c.worst = 2 then 0
    when c.worst = 1 or c.worst is null or (c.last_done_source is null and c.season_due_month is null) then 1
    else 2
  end as status_rank,
  -- Fraction of the interval left on the closest dimension (lower = sooner).
  -- Never done with no starting point sorts first among the yellow rows.
  case
    when not (c.paused or c.unscheduled) and coalesce(c.worst, 0) not in (1, 2)
         and c.last_done_source is null and c.season_due_month is null then -1
    else least(
    c.remaining_mi / nullif(c.interval_mi, 0),
    c.remaining_hours / nullif(c.interval_hours, 0),
    c.remaining_days::numeric / nullif(coalesce(c.interval_days, 365), 0))
  end as urgency
from classified c;

comment on view public.maintenance_board is
  'Maintenance Board: every active plan with last done, next due, remaining and status, calculated from the service history (security_invoker).';

revoke all on public.maintenance_board from anon, authenticated;
grant select on public.maintenance_board to authenticated;

-- 5. Migration history.
delete from supabase_migrations.schema_migrations where version = '20261127090000';

-- 6. Verify; any leftover undoes the whole rollback.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and ((table_name = 'maintenance_plans' and column_name in ('tracks', 'inspect_interval_mi', 'inspect_each_reading'))
                  or (table_name = 'maintenance_entry_tasks' and column_name = 'outcome')))
     or exists (select 1 from pg_proc where proname in ('save_maintenance_inspection', 'tg_maintenance_plans_inspect_date_check'))
     or exists (select 1 from information_schema.columns where table_name = 'maintenance_board' and column_name = 'inspect_status')
     or to_regclass('public.maintenance_board') is null
  then
    raise exception 'Rollback verification failed: Migration 13 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: Migration 13 removed; Migrations 1-12 untouched.';
end $$;

commit;
