-- Tests for migration 20261128090000_inspection_baseline_time: Every Mileage
-- Update counts a mileage reading recorded after the inspection starting
-- point, even on the same day.
-- Everything runs in one transaction that is rolled back. Inside one
-- transaction now() never moves, so the times of starting points and
-- readings are set explicitly (fixtures, with triggers skipped) to model
-- "earlier today" and "later today".

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(30);

insert into auth.users (id, email, email_confirmed_at) values
  ('d1111111-1111-1111-1111-111111111111', 'ib-owner@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.row_of(p_task text) returns public.maintenance_board language sql stable as $$
  select b.* from public.maintenance_board b where b.sled_id = pg_temp.v('sled')::uuid and b.task_name = p_task;
$$;
grant execute on function pg_temp.row_of(text) to authenticated, anon;
create function pg_temp.at_of(p_task text) returns timestamptz language sql stable as $$
  select p.inspect_baseline_at from public.maintenance_plans p where p.task_id = pg_temp.v('task_' || p_task)::uuid;
$$;
grant execute on function pg_temp.at_of(text) to authenticated, anon;
-- A new reading, as the owner; returns its id.
create function pg_temp.reading(p_mi numeric, p_hours numeric, p_days_ago int default 0) returns text language sql volatile as $$
  insert into public.sled_readings (sled_id, read_on, odometer_mi, engine_hours)
  values (pg_temp.v('sled')::uuid, current_date - p_days_ago, p_mi, p_hours) returning id::text;
$$;
grant execute on function pg_temp.reading(numeric, numeric, int) to authenticated;
-- Fixtures only (as postgres): set a row's time without its triggers.
create function pg_temp.reading_time(p_id text, p_at timestamptz) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update public.sled_readings set created_at = p_at where id = p_id::uuid;
  set local session_replication_role = origin;
end;
$$;
-- A reading recorded later today (inside one transaction its own time would tie with earlier ones).
create function pg_temp.later_reading(p_mi numeric, p_at timestamptz) returns text language plpgsql as $$
declare v_id uuid;
begin
  insert into public.sled_readings (sled_id, read_on, odometer_mi)
  values (pg_temp.v('sled')::uuid, current_date, p_mi) returning id into v_id;
  perform pg_temp.reading_time(v_id::text, p_at);
  return v_id::text;
end;
$$;
create function pg_temp.start_time(p_task text, p_at timestamptz) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update public.maintenance_plans set inspect_baseline_at = p_at where task_id = pg_temp.v('task_' || p_task)::uuid;
  set local session_replication_role = origin;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
insert into t select 'sled', public.create_sled('Polaris', 'Khaos', 2025, 1000, 50)::text;
with created as (
  insert into public.maintenance_tasks (name) select n from unnest(array['Plugs', 'Legacy', 'Belt', 'Track']) n returning id, name
)
insert into t select 'task_' || name, id::text from created;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select has_column('public', 'maintenance_plans', 'inspect_baseline_at', 'plans record when the inspection starting point was set');
select has_trigger('public', 'maintenance_plans', 'inspect_baseline_time', 'a trigger maintains it');
select is(has_function_privilege('authenticated', 'private.tg_maintenance_plans_inspect_baseline_time()', 'execute'), false,
  'the trigger function is not callable by users');
select is((select count(*)::int from information_schema.columns where table_name = 'maintenance_board'), 73,
  'the board has exactly the same 73 columns');

-- The sled's first reading was recorded "this morning".
select pg_temp.reading_time((select id::text from public.sled_readings where sled_id = pg_temp.v('sled')::uuid),
  now() - interval '3 hours');

-- ---------------------------------------------------------------------------
-- Start tracking now, then readings later the same day
-- ---------------------------------------------------------------------------
set local role authenticated;
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading, inspect_baseline_on, inspect_baseline_mi,
                                      inspect_baseline_hours, inspect_baseline_kind)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Plugs')::uuid, 'inspection', true, current_date, 1000, 50, 'tracking');
select is(pg_temp.at_of('Plugs'), now(), 'the starting point''s time is set when it is set');
reset role;
select pg_temp.start_time('Plugs', now() - interval '2 hours');
set local role authenticated;

select is((pg_temp.row_of('Plugs')).inspect_status, 'good', 'a reading recorded before the starting point (same day) does not count');
select is((pg_temp.row_of('Plugs')).last_checked_source, 'tracking', 'it counts from the tracking start');
insert into t select 'backdated', pg_temp.reading(1000, 50, 1);
select is((pg_temp.row_of('Plugs')).inspect_status, 'good', 'nor does a reading for an earlier day, entered afterwards');

insert into t select 'hours_only', pg_temp.reading(null, 55);
select is((pg_temp.row_of('Plugs')).inspect_status, 'good', 'an hours-only reading later the same day does not count');
select is((pg_temp.row_of('Plugs')).inspect_due_on_reading, false, 'not due on reading');

insert into t select 'later', pg_temp.reading(1015, null);
select is((pg_temp.row_of('Plugs')).inspect_status, 'due', 'a mileage reading recorded after the starting point, same day: due');
select is((pg_temp.row_of('Plugs')).inspect_due_on_reading, true, 'due on the mileage update');

-- ---------------------------------------------------------------------------
-- Completing the inspection resets it; the next mileage update makes it due again
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.save_maintenance_inspection(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date,
  jsonb_build_array(jsonb_build_object('task_id', pg_temp.v('task_Plugs'), 'outcome', 'good')),
  jsonb_build_object('odometer_mi', 1015)) $$, 'Checked: Good, with the current mileage');
select is((pg_temp.row_of('Plugs')).last_checked_source, 'check', 'the schedule now counts from the check');
select is((pg_temp.row_of('Plugs')).inspect_status, 'good', 'the inspection requirement is reset (its own reading does not count)');
reset role;
set local session_replication_role = replica;
insert into t select 'after_check', pg_temp.later_reading(1030, now() + interval '1 hour');
set local session_replication_role = origin;
set local role authenticated;
select is((pg_temp.row_of('Plugs')).inspect_status, 'due', 'a mileage update after the check makes it due again');

-- ---------------------------------------------------------------------------
-- Unrelated edits keep the time; changing the starting point sets it
-- ---------------------------------------------------------------------------
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading, inspect_interval_days, inspect_baseline_on,
                                      inspect_baseline_mi, inspect_baseline_kind)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Belt')::uuid, 'inspection', true, 30, current_date, 1000, 'tracking');
reset role;
select pg_temp.start_time('Belt', '2026-01-01 08:00+00');
set local role authenticated;
update public.maintenance_plans set inspect_interval_days = 60, version = version where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), '2026-01-01 08:00+00'::timestamptz, 'changing the schedule keeps it');
update public.maintenance_plans set paused = true, version = version where task_id = pg_temp.v('task_Belt')::uuid;
update public.maintenance_plans set paused = false, notes = 'checked by Sam', version = version where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), '2026-01-01 08:00+00'::timestamptz, 'pausing and notes keep it');
-- Re-saving the dialog sends the same starting point again (1000 as 1000.0).
update public.maintenance_plans
set inspect_baseline_on = current_date, inspect_baseline_mi = 1000.0, inspect_baseline_hours = null, inspect_baseline_kind = 'tracking',
    interval_mi = null, inspect_interval_days = 60, version = version
where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), '2026-01-01 08:00+00'::timestamptz, 're-saving the same starting point keeps it');
update public.maintenance_plans set inspect_baseline_at = '2030-01-01', version = version where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), '2026-01-01 08:00+00'::timestamptz, 'users cannot set it themselves');
update public.maintenance_plans set inspect_baseline_mi = 1010, version = version where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), now(), 'changing the starting point sets it again');
update public.maintenance_plans set inspect_baseline_on = null, inspect_baseline_mi = null, inspect_baseline_kind = null, version = version
where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), null, 'removing the starting point clears it');
select is((pg_temp.row_of('Belt')).last_checked_source, null, 'and the schedule has no starting point');

-- Switching back to replacement only (the app clears the inspection fields) clears it too.
update public.maintenance_plans set inspect_baseline_on = current_date, inspect_baseline_kind = 'known', version = version
where task_id = pg_temp.v('task_Belt')::uuid;
select isnt(pg_temp.at_of('Belt'), null, 'a known starting point gets a time as well');
update public.maintenance_plans
set tracks = 'replacement', inspect_interval_days = null, inspect_each_reading = false, inspect_baseline_on = null, inspect_baseline_kind = null,
    version = version
where task_id = pg_temp.v('task_Belt')::uuid;
select is(pg_temp.at_of('Belt'), null, 'converting to replacement only clears it');

-- ---------------------------------------------------------------------------
-- Existing starting points (set before Migration 14) behave exactly as before
-- ---------------------------------------------------------------------------
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading, inspect_baseline_on, inspect_baseline_mi,
                                      inspect_baseline_kind)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Legacy')::uuid, 'inspection', true, current_date, 1000, 'tracking');
reset role;
select pg_temp.start_time('Legacy', null);
set local role authenticated;
select is((pg_temp.row_of('Legacy')).inspect_status, 'good',
  'an existing starting point without a time: same-day readings do not count, as before Migration 14');
update public.maintenance_plans set notes = 'unrelated', version = version where task_id = pg_temp.v('task_Legacy')::uuid;
select is(pg_temp.at_of('Legacy'), null, 'an unrelated edit leaves it without a time (nothing changes for it)');
insert into t select 'next_day', pg_temp.reading(1040, null, -1);
select is((pg_temp.row_of('Legacy')).inspect_status, 'due', 'a mileage reading on a later day counts, as before');

-- A known last check in the past still counts readings since that date (unchanged).
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading, inspect_baseline_on, inspect_baseline_kind)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Track')::uuid, 'inspection', true, current_date - 5, 'known');
select is((pg_temp.row_of('Track')).inspect_status, 'due', 'a known last check 5 days ago: later readings count');
select is((pg_temp.row_of('Track')).last_checked_on, current_date - 5, 'counted from its own date');

select * from finish();
rollback;
