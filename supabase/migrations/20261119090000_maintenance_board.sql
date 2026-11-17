-- =============================================================================
-- SledWerx — Migration 5: maintenance board
--
-- The Maintenance Board is calculated, never stored: the view
-- public.maintenance_board works out last done, next due, remaining and
-- status from the service history every time it is read. Marking a task done
-- is an ordinary service record (save_maintenance_entry), so there is nothing
-- to keep in sync: editing, backdating or deleting a service updates the
-- board immediately.
--
-- * maintenance_plans (Migration 2) is the board: one active plan per sled
--   and task. A plan may now have no interval ("on the board, not
--   scheduled"), and may be seasonal ("once per season, due by Nov 1").
-- * "Done before SledWerx" (last_done_on/mi/hours) cannot be in the future.
-- * Warning windows ("upcoming") come from
--   private.maintenance_warning_settings(user), so per-user settings can be
--   added later without changing the view.
-- * Mileage of a completion is only ever the service's own recorded reading.
--   A service without mileage gives "mileage unknown"; nothing is estimated.
--
-- No new tables. Migrations 1-4 are not modified.
-- Rollback (manual only): supabase/rollback/20261119090000_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plans: seasonal schedules, and plans without an interval
-- -----------------------------------------------------------------------------
alter table public.maintenance_plans
  add column season_due_month smallint,
  add column season_due_day smallint;

-- Was: at least one of interval_mi, interval_hours, interval_days. A plan with
-- no interval is now a board item that is not scheduled.
alter table public.maintenance_plans drop constraint maintenance_plans_check;

alter table public.maintenance_plans
  add constraint maintenance_plans_season_check check (
    -- Month and day are set together (explicit IS NULL tests: a CHECK passes
    -- when its expression is NULL, so comparisons alone would let one through).
    (season_due_month is null) = (season_due_day is null)
    and (
      season_due_month is null
      or (
        season_due_month between 1 and 12
        and season_due_day between 1 and 31
        -- A real calendar day (Feb 29 allowed; it falls back to Feb 28).
        and season_due_day <= extract(day from (make_date(2000, season_due_month, 1) + interval '1 month - 1 day'))
      )
    )
  );

comment on column public.maintenance_plans.season_due_month is
  'Seasonal schedule: once per season (July-June), due by this month and day.';

-- "Done before SledWerx" cannot be in the future (one day of slack for time
-- zones ahead of UTC, as for readings and services). Only new dates are checked.
create function private.tg_maintenance_plans_date_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_done_on > current_date + 1
     and (tg_op = 'INSERT' or new.last_done_on is distinct from old.last_done_on) then
    raise exception 'The last-done date cannot be in the future.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.tg_maintenance_plans_date_check() from public, anon, authenticated;

create trigger date_check before insert or update of last_done_on on public.maintenance_plans
  for each row execute function private.tg_maintenance_plans_date_check();

-- -----------------------------------------------------------------------------
-- Warning windows: when a task turns "upcoming". The board view reads them
-- through this function, so per-user settings (for example columns on
-- user_preferences) can replace these defaults later without changing the
-- view. Defaults: 10% of the interval, at least 50 mi / 2 hrs / 7 days, at most
-- 30 days; seasonal tasks 30 days before their date.
-- -----------------------------------------------------------------------------
create function private.maintenance_warning_settings(p_user_id uuid)
returns table (
  percent numeric,
  min_mi numeric,
  min_hours numeric,
  min_days integer,
  max_days integer,
  season_days integer
)
language sql
stable
set search_path = ''
as $$
  select 0.10::numeric, 50::numeric, 2::numeric, 7, 30, 30;
$$;

revoke all on function private.maintenance_warning_settings(uuid) from public, anon;
grant execute on function private.maintenance_warning_settings(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The board. SECURITY INVOKER: plans, tasks, service records and readings are
-- all read through the caller's Row Level Security.
--
-- Last done: the newest completed service record that lists the plan's task
-- (by task id), or the plan's "done before SledWerx" starting point if that
-- is newer or there is no record. Mileage and hours are the lifetime totals
-- of that service's own reading (sled_reading_history), so meter
-- replacements are handled; a service without a reading has unknown mileage.
--
-- Status: paused | unscheduled | no_record | overdue | upcoming |
--         mileage_unknown | good
-- status_rank: 0 overdue, 1 upcoming / no record / mileage unknown, 2 good,
--              3 unscheduled / paused. urgency orders rows within a rank.
-- -----------------------------------------------------------------------------
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
