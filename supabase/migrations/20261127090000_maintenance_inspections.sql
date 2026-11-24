-- =============================================================================
-- SledWerx migration 13 (Phase 7): maintenance inspection & replacement tracking
--
-- One maintenance item (a task on a sled's board) can track inspections
-- (Checked), replacements (Replaced), or both, each with its own schedule.
--
-- * A Check is an ordinary service record (category inspection) whose items
--   carry an outcome: maintenance_entry_tasks.outcome = good | needs_replacement.
--   An item without an outcome is done / Replaced, exactly as before. Saved by
--   save_maintenance_inspection (one record for one or many checks), which
--   uses save_maintenance_entry: readings, idempotency, RLS, audit, editing
--   and Recently Deleted all work as for any service record.
-- * maintenance_plans gains:
--   - tracks: replacement (default: every existing schedule) | inspection | both;
--   - the inspection schedule (miles, hours, days, once a season, every mileage
--     update) beside the existing interval columns (the replacement schedule);
--   - replace_as_needed, season labels (season | preseason | postseason);
--   - an inspection starting point, and a kind (known | tracking) for both
--     starting points: a tracking start is never shown as a replacement.
-- * maintenance_board is re-created with the same columns plus new ones at the
--   end. Existing columns are calculated exactly as before, except that a done
--   item with an outcome (a Check) is not a completion.
--   - Replaced resets both schedules; Checked resets only the inspection one.
--   - Inspection only items (Decision D): earlier completions count as checks.
--   - Needs Replacement: a check said so and nothing was replaced since; a
--     later Good check does not clear it (derived, never stored).
--
-- Additive; existing data is not changed.
-- Rollback (manual only): supabase/rollback/20261127090000_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Check outcomes on service record items
-- -----------------------------------------------------------------------------
alter table public.maintenance_entry_tasks
  add column outcome text check (outcome in ('good', 'needs_replacement')),
  add constraint maintenance_entry_tasks_outcome_done check (outcome is null or done);

comment on column public.maintenance_entry_tasks.outcome is
  'Migration 13: a Check (good | needs_replacement). Empty: done / Replaced, as before.';

-- -----------------------------------------------------------------------------
-- 2. What an item tracks, and the inspection schedule
-- -----------------------------------------------------------------------------
alter table public.maintenance_plans
  add column tracks text not null default 'replacement' check (tracks in ('replacement', 'inspection', 'both')),
  add column replace_as_needed boolean not null default false,
  add column season_kind text check (season_kind in ('season', 'preseason', 'postseason')),
  add column replace_baseline_kind text check (replace_baseline_kind in ('known', 'tracking')),
  add column inspect_interval_mi numeric(8, 1) check (inspect_interval_mi > 0),
  add column inspect_interval_hours numeric(7, 1) check (inspect_interval_hours > 0),
  add column inspect_interval_days integer check (inspect_interval_days between 1 and 3650),
  add column inspect_season_month smallint,
  add column inspect_season_day smallint,
  add column inspect_season_kind text check (inspect_season_kind in ('season', 'preseason', 'postseason')),
  add column inspect_each_reading boolean not null default false,
  add column inspect_baseline_on date,
  add column inspect_baseline_mi numeric(9, 1) check (inspect_baseline_mi >= 0),
  add column inspect_baseline_hours numeric(8, 1) check (inspect_baseline_hours >= 0),
  add column inspect_baseline_kind text check (inspect_baseline_kind in ('known', 'tracking'));

alter table public.maintenance_plans
  add constraint maintenance_plans_inspect_season_check check (
    (inspect_season_month is null) = (inspect_season_day is null)
    and (
      inspect_season_month is null
      or (
        inspect_season_month between 1 and 12
        and inspect_season_day between 1 and 31
        and inspect_season_day <= extract(day from (make_date(2000, inspect_season_month, 1) + interval '1 month - 1 day'))
      )
    )
  );

comment on column public.maintenance_plans.tracks is
  'Migration 13: replacement (the existing interval columns), inspection (the inspect_* columns), or both.';
comment on column public.maintenance_plans.inspect_each_reading is
  'Migration 13: an inspection is due once a mileage reading newer than the last check exists (Every Mileage Update; engine-hours-only readings do not count).';

-- The inspection starting point cannot be in the future either (same rule as last_done_on).
create function private.tg_maintenance_plans_inspect_date_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.inspect_baseline_on > current_date + 1
     and (tg_op = 'INSERT' or new.inspect_baseline_on is distinct from old.inspect_baseline_on) then
    raise exception 'The last-checked date cannot be in the future.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.tg_maintenance_plans_inspect_date_check() from public, anon, authenticated;

create trigger inspect_date_check before insert or update of inspect_baseline_on on public.maintenance_plans
  for each row execute function private.tg_maintenance_plans_inspect_date_check();

-- -----------------------------------------------------------------------------
-- 3. save_maintenance_inspection: one Inspection service record for one or
--    many checks (Quick Check, Mark All as Good). SECURITY INVOKER: the
--    caller's permissions apply, through save_maintenance_entry.
--    p_checks: [{ "task_id": uuid, "outcome": "good" | "needs_replacement", "note": text }]
-- -----------------------------------------------------------------------------
create function public.save_maintenance_inspection(
  p_idempotency_key uuid,
  p_sled_id uuid,
  p_performed_on date,
  p_checks jsonb,
  p_reading jsonb default null,
  p_notes text default null,
  p_done_by text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
  v_entry uuid;
begin
  if p_checks is null or jsonb_typeof(p_checks) <> 'array' or jsonb_array_length(p_checks) = 0 then
    raise exception 'Choose at least one item to check.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_checks) > 100 then
    raise exception 'At most 100 items can be checked at once.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_checks) c
    where jsonb_typeof(c) <> 'object'
       or coalesce(c ->> 'task_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(c ->> 'outcome', '') not in ('good', 'needs_replacement')
  ) then
    raise exception 'Each check needs an item and an outcome (Good or Needs Replacement).' using errcode = '22023';
  end if;
  if (select count(distinct c ->> 'task_id') from jsonb_array_elements(p_checks) c) <> jsonb_array_length(p_checks) then
    raise exception 'Each item can be checked once per record.' using errcode = '22023';
  end if;

  v_result := public.save_maintenance_entry(
    p_idempotency_key => p_idempotency_key,
    p_sled_id => p_sled_id,
    p_performed_on => p_performed_on,
    p_title => 'Inspection',
    p_done_by => p_done_by,
    p_notes => p_notes,
    p_completed => true,
    p_reading => p_reading,
    p_tasks => (select jsonb_agg(jsonb_build_object('task_id', c ->> 'task_id', 'note', nullif(btrim(c ->> 'note'), '')))
                from jsonb_array_elements(p_checks) c),
    p_category => 'inspection'
  );
  if (v_result ->> 'duplicate')::boolean then
    return v_result;
  end if;

  v_entry := (v_result ->> 'entry_id')::uuid;
  update public.maintenance_entry_tasks et
  set outcome = c ->> 'outcome'
  from jsonb_array_elements(p_checks) c
  where et.entry_id = v_entry and et.task_id = (c ->> 'task_id')::uuid;
  return v_result;
end;
$$;

revoke all on function public.save_maintenance_inspection(uuid, uuid, date, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.save_maintenance_inspection(uuid, uuid, date, jsonb, jsonb, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. The board, with both schedules (same columns as Migration 5, new ones at the end)
-- -----------------------------------------------------------------------------
create or replace view public.maintenance_board
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
         et.sled_id, et.task_id, e.id as entry_id, e.performed_on, e.reading_id, e.created_at as entry_created_at,
         h.total_mi, h.total_engine_hours
  from public.maintenance_entry_tasks et
  join public.maintenance_entries e on e.id = et.entry_id
  left join public.sled_reading_history h on h.id = e.reading_id
  -- Migration 13: an item with an outcome is a Check, not a completion.
  where et.deleted_at is null and et.done and et.task_id is not null and et.outcome is null
    and e.deleted_at is null and e.completed
  order by et.sled_id, et.task_id, e.performed_on desc, e.created_at desc, e.id desc
),
-- Migration 13: the newest Check of each task.
checks as (
  select distinct on (et.sled_id, et.task_id)
         et.sled_id, et.task_id, e.id as entry_id, e.performed_on, e.created_at as entry_created_at, et.outcome,
         h.total_mi, h.total_engine_hours
  from public.maintenance_entry_tasks et
  join public.maintenance_entries e on e.id = et.entry_id
  left join public.sled_reading_history h on h.id = e.reading_id
  where et.deleted_at is null and et.done and et.task_id is not null and et.outcome is not null
    and e.deleted_at is null and e.completed
  order by et.sled_id, et.task_id, e.performed_on desc, e.created_at desc, e.id desc
),
-- Migration 13: the newest Needs Replacement check of each task (a later Good
-- check does not clear it; only a replacement does).
flagged as (
  select distinct on (et.sled_id, et.task_id)
         et.sled_id, et.task_id, e.performed_on, e.created_at as entry_created_at
  from public.maintenance_entry_tasks et
  join public.maintenance_entries e on e.id = et.entry_id
  where et.deleted_at is null and et.done and et.task_id is not null and et.outcome = 'needs_replacement'
    and e.deleted_at is null and e.completed
  order by et.sled_id, et.task_id, e.performed_on desc, e.created_at desc, e.id desc
),
last_done as (
  select p.id as plan_id,
         case
           when c.entry_id is not null and (p.last_done_on is null or c.performed_on >= p.last_done_on) then 'service'
           when p.last_done_on is not null or p.last_done_mi is not null or p.last_done_hours is not null then 'baseline'
         end as source,
         c.entry_id, c.performed_on, c.reading_id, c.total_mi, c.total_engine_hours, c.entry_created_at
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
         case when ld.source = 'service' then ld.entry_created_at end as done_created_at,
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
),
-- Migration 13: what the inspection schedule counts from. The newest of: the
-- newest Check; the newest replacement (Replaced resets both schedules; for an
-- inspection only item, an earlier completion counts as a check, Decision D);
-- a known replacement starting point; the inspection starting point.
inspect_basis as (
  select c.*,
         ck.entry_id as check_entry_id, ck.outcome as check_outcome, ck.performed_on as check_on,
         ck.entry_created_at as check_created_at,
         fl.performed_on as flagged_on, fl.entry_created_at as flagged_created_at,
         b.source as basis_source, b.on_date as basis_on, b.created as basis_created, b.mi as basis_mi, b.hours as basis_hours
  from classified c
  left join checks ck on ck.sled_id = c.sled_id and ck.task_id = c.task_id
  left join flagged fl on fl.sled_id = c.sled_id and fl.task_id = c.task_id
  left join lateral (
    select v.source, v.on_date, v.created, v.mi, v.hours
    from (values
      ('check', ck.performed_on, ck.entry_created_at, ck.total_mi, ck.total_engine_hours),
      (case when c.last_done_source = 'service' then case when c.tracks = 'inspection' then 'service' else 'replacement' end
            when c.last_done_source = 'baseline' and c.replace_baseline_kind is distinct from 'tracking' then 'baseline' end,
       c.done_on, c.done_created_at, c.done_mi, c.done_hours),
      (case when num_nonnulls(c.inspect_baseline_on, c.inspect_baseline_mi, c.inspect_baseline_hours) > 0
            then case when c.inspect_baseline_kind = 'tracking' then 'tracking' else 'baseline' end end,
       c.inspect_baseline_on, null::timestamptz, c.inspect_baseline_mi, c.inspect_baseline_hours)
    ) as v(source, on_date, created, mi, hours)
    where v.source is not null and num_nonnulls(v.on_date, v.mi, v.hours) > 0
    order by v.on_date desc nulls last, v.created desc nulls last
    limit 1
  ) b on true
),
inspect_due as (
  select i.*,
         case when i.inspect_interval_days is not null and i.basis_on is not null then i.basis_on + i.inspect_interval_days end
           as i_due_by_days,
         case when i.inspect_season_month is not null then
           (
             with s as (
               select (extract(year from i.season_start)::int
                        + case when i.inspect_season_month < 7 then 1 else 0 end
                        + case when i.basis_on >= i.season_start then 1 else 0 end) as y
             )
             select least(make_date(s.y, i.inspect_season_month, 1) + (i.inspect_season_day - 1),
                          (make_date(s.y, i.inspect_season_month, 1) + interval '1 month - 1 day')::date)
             from s
           )
         end as i_due_by_season,
         case when i.inspect_interval_mi is not null and i.basis_mi is not null then i.basis_mi + i.inspect_interval_mi end as i_due_mi,
         case when i.inspect_interval_hours is not null and i.basis_hours is not null then i.basis_hours + i.inspect_interval_hours end
           as i_due_hours,
         -- Every Mileage Update: a mileage reading newer than what the schedule
         -- counts from (an engine-hours-only reading doesn't count).
         (i.inspect_each_reading and i.basis_on is not null and exists (
           select 1 from public.sled_readings r
           where r.sled_id = i.sled_id and r.deleted_at is null and r.odometer_mi is not null
             and (r.read_on > i.basis_on or (r.read_on = i.basis_on and i.basis_created is not null and r.created_at > i.basis_created))
         )) as i_reading_due,
         -- Needs Replacement: a check said so and nothing was replaced since
         -- (a later Good check does not clear it).
         (i.flagged_on is not null and not coalesce(
           i.last_done_source = 'service'
           and (i.done_on > i.flagged_on or (i.done_on = i.flagged_on and i.done_created_at > i.flagged_created_at)),
           false
         )) as i_needs_replacement
  from inspect_basis i
),
inspect_measured as (
  select d.*,
         least(d.i_due_by_days, d.i_due_by_season) as i_due_on,
         case when d.i_due_mi is not null and d.current_mi is not null then
           case when d.current_mi > d.i_due_mi then 2
                when d.i_due_mi - d.current_mi <= greatest(d.min_mi, d.percent * d.inspect_interval_mi) then 1 else 0 end
         end as i_state_mi,
         case when d.i_due_hours is not null and d.current_hours is not null then
           case when d.current_hours > d.i_due_hours then 2
                when d.i_due_hours - d.current_hours <= greatest(d.min_hours, d.percent * d.inspect_interval_hours) then 1 else 0 end
         end as i_state_hours,
         case when d.i_due_by_days is not null then
           case when current_date > d.i_due_by_days then 2
                when d.i_due_by_days - current_date <= least(d.max_days, greatest(d.min_days, ceil(d.percent * d.inspect_interval_days)::int)) then 1
                else 0 end
         end as i_state_days,
         case when d.i_due_by_season is not null then
           case when current_date > d.i_due_by_season then 2
                when d.i_due_by_season - current_date <= d.season_days then 1 else 0 end
         end as i_state_season
  from inspect_due d
),
inspect_status as (
  select m.*,
         case
           when m.tracks = 'replacement' then null
           when m.paused then 'paused'
           when m.inspect_interval_mi is null and m.inspect_interval_hours is null and m.inspect_interval_days is null
                and m.inspect_season_month is null and not m.inspect_each_reading then 'unscheduled'
           when m.basis_source is null then 'initial_check'
           when greatest(m.i_state_mi, m.i_state_hours, m.i_state_days, m.i_state_season) = 2 then 'overdue'
           when m.i_reading_due then 'due'
           when greatest(m.i_state_mi, m.i_state_hours, m.i_state_days, m.i_state_season) = 1 then 'upcoming'
           when greatest(m.i_state_mi, m.i_state_hours, m.i_state_days, m.i_state_season) is null
                and ((m.inspect_interval_mi is not null and m.basis_mi is null)
                     or (m.inspect_interval_hours is not null and m.basis_hours is null)) then 'mileage_unknown'
           else 'good'
         end as i_status
  from inspect_measured m
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
  end as urgency,
  -- Migration 13 (new columns; everything above is calculated as in Migration 5)
  c.tracks,
  c.replace_as_needed,
  c.season_kind,
  c.replace_baseline_kind,
  c.inspect_interval_mi,
  c.inspect_interval_hours,
  c.inspect_interval_days,
  c.inspect_season_month,
  c.inspect_season_day,
  c.inspect_season_kind,
  c.inspect_each_reading,
  c.inspect_baseline_on,
  c.inspect_baseline_mi,
  c.inspect_baseline_hours,
  c.inspect_baseline_kind,
  -- The replacement schedule's status (null for inspection only items).
  case
    when c.tracks = 'inspection' then null
    when c.replace_as_needed and c.interval_mi is null and c.interval_hours is null and c.interval_days is null
         and c.season_due_month is null and not c.paused then 'as_needed'
    when c.paused then 'paused'
    when c.unscheduled then 'unscheduled'
    when c.worst = 2 then 'overdue'
    when c.worst = 1 then 'upcoming'
    when c.last_done_source is null and c.season_due_month is null then 'no_record'
    when c.worst is null and (c.mileage_unknown or c.hours_unknown) then 'mileage_unknown'
    when c.worst is null then 'no_record'
    else 'good'
  end as replace_status,
  c.basis_source as last_checked_source,
  c.basis_on as last_checked_on,
  c.basis_mi as last_checked_mi,
  c.basis_hours as last_checked_hours,
  c.check_outcome as last_check_outcome,
  c.check_entry_id as last_check_entry_id,
  coalesce(c.i_needs_replacement, false) as needs_replacement,
  case when c.tracks <> 'replacement' then c.i_due_on end as inspect_due_on,
  case when c.tracks <> 'replacement' then c.i_due_mi end as inspect_due_mi,
  case when c.tracks <> 'replacement' then c.i_due_hours end as inspect_due_hours,
  case when c.tracks <> 'replacement' then c.i_due_mi - c.current_mi end as inspect_remaining_mi,
  case when c.tracks <> 'replacement' then c.i_due_hours - c.current_hours end as inspect_remaining_hours,
  case when c.tracks <> 'replacement' then c.i_due_on - current_date end as inspect_remaining_days,
  coalesce(c.tracks <> 'replacement' and c.i_reading_due, false) as inspect_due_on_reading,
  c.i_status as inspect_status,
  case c.i_status
    when 'overdue' then 0
    when 'due' then 1 when 'initial_check' then 1 when 'upcoming' then 1 when 'mileage_unknown' then 1
    when 'good' then 2
    when 'unscheduled' then 3 when 'paused' then 3
  end as inspect_status_rank,
  -- The item's place on the board: Needs Replacement first, then the more urgent schedule.
  case
    when coalesce(c.i_needs_replacement, false) then -1
    else least(
      case when c.tracks <> 'inspection' then
        case
          when c.paused or c.unscheduled then 3
          when c.worst = 2 then 0
          when c.worst = 1 or c.worst is null or (c.last_done_source is null and c.season_due_month is null) then 1
          else 2
        end
      end,
      case c.i_status
        when 'overdue' then 0
        when 'due' then 1 when 'initial_check' then 1 when 'upcoming' then 1 when 'mileage_unknown' then 1
        when 'good' then 2
        when 'unscheduled' then 3 when 'paused' then 3
      end)
  end as item_rank,
  -- Miles on the component: since the last known replacement, or since tracking began.
  case
    when c.tracks = 'inspection' then null
    when c.last_done_source = 'service' or c.last_done_source = 'baseline' then c.current_mi - c.done_mi
  end as component_mi,
  case
    when c.tracks = 'inspection' then null
    when c.last_done_source = 'service' then 'replacement'
    when c.last_done_source = 'baseline' and c.replace_baseline_kind = 'tracking' then 'tracking'
    when c.last_done_source = 'baseline' then 'replacement'
  end as component_since
from inspect_status c;

comment on view public.maintenance_board is
  'Maintenance Board: every active plan with last done / replaced, last checked, both schedules (next due, remaining, status), Needs Replacement and miles on the component, calculated from the service history (security_invoker).';

revoke all on public.maintenance_board from anon, authenticated;
grant select on public.maintenance_board to authenticated;
