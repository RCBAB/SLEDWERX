-- Tests for migration 20261119090000_maintenance_board: seasonal and
-- unscheduled plans, the "done before SledWerx" date rule, and the
-- maintenance_board view (last done, due, remaining, status, order, access).
-- Run with: npx supabase test db   (requires the local Supabase stack)
-- Everything runs in one transaction that is rolled back.
--
-- Timeline used below (days before today -> lifetime miles / engine hours):
--   -200: 900 mi / 60 h    Oil        (every 1,000 mi)       -> overdue
--   -100: 1,200 mi / 80 h  Belt       (every 1,000 mi)       -> good
--    -50: no mileage       Plugs      (every 1,000 mi)       -> mileage unknown
--    -40: 1,300 mi         Clutch     (5,000 mi or 30 days)  -> overdue by date
--    -30: 1,520 mi         Chain      (every 500 mi)         -> upcoming
--    -20: 1,600 mi / 95 h  Coolant    (every 50 hrs)         -> overdue by hours
--  today: 2,000 mi / 150 h (the sled's first reading)

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(62);

insert into auth.users (id, email, email_confirmed_at) values
  ('a1111111-1111-1111-1111-111111111111', 'olive5@example.com', now()),
  ('a2222222-2222-2222-2222-222222222222', 'eli5@example.com',   now()),
  ('a3333333-3333-3333-3333-333333333333', 'max5@example.com',   now()),
  ('a4444444-4444-4444-4444-444444444444', 'val5@example.com',   now()),
  ('a5555555-5555-5555-5555-555555555555', 'xena5@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

-- Board row of a task, as the current user sees it.
create function pg_temp.row_of(p_task text) returns public.maintenance_board
language sql stable as $$
  select b.* from public.maintenance_board b
  where b.sled_id = (select v::uuid from t where k = 'sled') and b.task_name = p_task;
$$;
grant execute on function pg_temp.row_of(text) to authenticated, anon;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150)::text;

-- Library tasks and plans (the board).
with created as (
  insert into public.maintenance_tasks (name)
  select n from unnest(array['Oil', 'Belt', 'Plugs', 'Clutch', 'Chain', 'Coolant', 'Days30', 'Days365',
                             'Season', 'Wax', 'Paused', 'Never', 'NoMiles']) n
  returning id, name
)
insert into t select 'task_' || name, id::text from created;
insert into public.maintenance_plans (sled_id, task_id, interval_mi, interval_hours, interval_days, paused, last_done_on)
select (select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_' || p.name),
       p.mi, p.hrs, p.days, p.paused, p.baseline
from (values
  ('Oil', 1000, null, null, false, null::date),
  ('Belt', 1000, null, null, false, null),
  ('Plugs', 1000, null, null, false, null),
  ('Clutch', 5000, null, 30, false, null),
  ('Chain', 500, null, null, false, null),
  ('Coolant', null, 50, null, false, null),
  ('Days30', null, null, 30, false, current_date - 25),
  ('Days365', null, null, 365, false, current_date - 10),
  ('Paused', 100, null, null, true, null),
  ('Never', null, null, 90, false, null),
  ('NoMiles', 1000, null, 60, false, null)
) as p(name, mi, hrs, days, paused, baseline);

-- Seasonal: due by today's month/day this season (never done).
select lives_ok($$ insert into public.maintenance_plans (sled_id, task_id, season_due_month, season_due_day)
  values ((select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_Season'),
          extract(month from current_date)::smallint, extract(day from current_date)::smallint) $$,
  'a seasonal schedule (once per season, due by a date) can be set');
select lives_ok($$ insert into public.maintenance_plans (sled_id, task_id)
  values ((select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_Wax')) $$,
  'a plan without any interval is allowed (on the board, not scheduled)');

-- Service history (backdated; each completion links the task).
create function pg_temp.done(p_task text, p_days_ago int, p_mi numeric, p_hours numeric default null)
returns void language sql as $$
  select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date - p_days_ago, p_task,
    p_reading => case when p_mi is null and p_hours is null then null
                      else jsonb_strip_nulls(jsonb_build_object('odometer_mi', p_mi, 'engine_hours', p_hours)) end,
    p_tasks => jsonb_build_array(jsonb_build_object('task_id', (select v from t where k = 'task_' || p_task))));
$$;
grant execute on function pg_temp.done(text, int, numeric, numeric) to authenticated;

select lives_ok($$ select pg_temp.done('Oil', 200, 900, 60) $$, 'last season''s oil change is logged at 900 mi');
select lives_ok($$ select pg_temp.done('Belt', 100, 1200, 80) $$, 'belt service at 1,200 mi');
select lives_ok($$ select pg_temp.done('Plugs', 50, null) $$, 'plugs service without mileage');
select lives_ok($$ select pg_temp.done('NoMiles', 45, null) $$, 'another service without mileage');
select lives_ok($$ select pg_temp.done('Clutch', 40, 1300) $$, 'clutch service at 1,300 mi');
select lives_ok($$ select pg_temp.done('Chain', 30, 1520) $$, 'chain service at 1,520 mi');
select lives_ok($$ select pg_temp.done('Coolant', 20, 1600, 95) $$, 'coolant service at 95 hrs');
-- A free-text task with the same name does not count (no task link).
select lives_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled'),
  current_date - 1, 'Never', p_tasks => '[{"task_name": "Never"}]') $$, 'a free-text task with a board task''s name');

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.maintenance_board'::regclass),
  'the board view runs with the caller''s permissions (security_invoker)');
select ok(not has_table_privilege('anon', 'public.maintenance_board', 'select'), 'anonymous users cannot read the board');
select ok(not has_function_privilege('anon', 'private.maintenance_warning_settings(uuid)', 'execute'),
  'anonymous users cannot call the warning settings');
select is((select format('%s|%s|%s|%s|%s|%s', percent, min_mi, min_hours, min_days, max_days, season_days)
           from private.maintenance_warning_settings(null)),
  '0.10|50|2|7|30|30', 'warning windows come from one settings function (defaults)');
select is_empty($$ select table_name from information_schema.tables where table_schema = 'public'
  and table_name in ('maintenance_reminders', 'maintenance_board_items') $$, 'nothing is stored: no reminder tables');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- Last done, due, remaining and status
-- ---------------------------------------------------------------------------
select is((select format('%s|%s|%s|%s|%s', status, last_done_on = current_date - 200, last_done_mi, due_mi, remaining_mi)
           from pg_temp.row_of('Oil')),
  'overdue|t|900.0|1900.0|-100.0', 'Oil: last done 900 mi, due 1,900, overdue by 100 mi');
select is((select format('%s|%s|%s', status, due_mi, remaining_mi) from pg_temp.row_of('Belt')),
  'good|2200.0|200.0', 'Belt: due 2,200 mi, 200 mi left is outside the warning window (good)');
select is((select format('%s|%s|%s', status, remaining_mi, warn_mi) from pg_temp.row_of('Chain')),
  'upcoming|20.0|50', 'Chain: 20 mi left is within the warning window (at least 50 mi)');
select is((select format('%s|%s|%s', status, due_hours, remaining_hours) from pg_temp.row_of('Coolant')),
  'overdue|145.0|-5.0', 'Coolant: engine hours count the same way (overdue by 5 hrs)');
select is((select format('%s|%s', status, remaining_days) from pg_temp.row_of('Clutch')),
  'overdue|-10', 'Clutch: whichever comes first; 30 days passed, so overdue though miles are fine');
select is((select format('%s|%s|%s|%s', status, last_done_source, remaining_days, warn_days) from pg_temp.row_of('Days30')),
  'upcoming|baseline|5|7', 'Days30: counted from the "done before SledWerx" date; 5 days left is upcoming');
select is((select format('%s|%s', status, remaining_days) from pg_temp.row_of('Days365')),
  'good|355', 'Days365: 355 days left is good (window at most 30 days)');
select is((select format('%s|%s|%s|%s', status, due_on = current_date, remaining_days, last_done_on is null) from pg_temp.row_of('Season')),
  'upcoming|t|0|t', 'Season: never done, due by today''s date this season');
select is((select format('%s|%s', status, status_rank) from pg_temp.row_of('Wax')),
  'unscheduled|3', 'Wax: on the board without a schedule');
select is((select format('%s|%s', status, status_rank) from pg_temp.row_of('Paused')),
  'paused|3', 'Paused: not counted as due');
select is((select format('%s|%s|%s', status, status_rank, last_done_source is null) from pg_temp.row_of('Never')),
  'no_record|1|t', 'Never: scheduled but no record yet (a free-text task with the same name does not count)');

-- Mileage is never estimated.
select is((select format('%s|%s|%s|%s', status, last_done_on = current_date - 50, last_done_mi is null, mileage_unknown) from pg_temp.row_of('Plugs')),
  'mileage_unknown|t|t|t', 'Plugs: the service had no mileage, so mileage is unknown (not estimated from readings)');
select is((select format('%s|%s|%s|%s', status, last_done_mi is null, mileage_unknown, remaining_days) from pg_temp.row_of('NoMiles')),
  'good|t|t|15', 'NoMiles: the date interval still works; the mileage part is flagged unknown');

-- Order: overdue, then upcoming / no record / unknown, then good, then unscheduled / paused.
select is((select array_agg(status_rank order by status_rank, urgency nulls last, task_name)
           from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled')),
  array[0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3], 'rows sort overdue, upcoming, good, unscheduled');
select is((select array_agg(task_name order by status_rank, urgency nulls last, task_name)
           from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled') and status_rank = 0),
  array['Clutch', 'Coolant', 'Oil'], 'most overdue first (largest share of the interval past due)');
select is((select (array_agg(task_name order by status_rank, urgency nulls last, task_name))[1]
           from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled') and status_rank = 1),
  'Never', 'no record yet sorts first among the yellow rows');

-- ---------------------------------------------------------------------------
-- Mark Done is an ordinary service record; the board recalculates
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into t select 'oil_today', (public.save_maintenance_entry(gen_random_uuid(),
    (select v::uuid from t where k = 'sled'), current_date, 'Oil',
    p_reading => '{"odometer_mi": 2000, "engine_hours": 150}',
    p_tasks => jsonb_build_array(jsonb_build_object('task_id', (select v from t where k = 'task_Oil'))))) ->> 'entry_id' $$,
  'Mark Done saves a service record');
select is((select format('%s|%s|%s|%s', status, last_done_on = current_date, due_mi, last_done_entry_id::text = (select v from t where k = 'oil_today'))
           from pg_temp.row_of('Oil')),
  'good|t|3000.0|t', 'the board shows it as last done, with the next due recalculated');

select lives_ok($$ select pg_temp.done('Belt', 150, 1100) $$, 'an older, backdated belt service is logged');
select is((select format('%s|%s', last_done_mi, status) from pg_temp.row_of('Belt')), '1200.0|good',
  'older history never replaces a newer last done');

select lives_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date,
    'Preseason', p_tasks => jsonb_build_array(
      jsonb_build_object('task_id', (select v from t where k = 'task_Chain')),
      jsonb_build_object('task_id', (select v from t where k = 'task_Season')))) $$,
  'several tasks completed in one service record');
select is((select status from pg_temp.row_of('Chain')), 'mileage_unknown',
  'Chain done today without mileage: its mileage is now unknown, not carried over');
select is((select format('%s|%s', status, due_on > current_date + 300) from pg_temp.row_of('Season')), 'good|t',
  'Season done this season: due again by next season''s date');

-- Editing and deleting a service recalculates the board.
select lives_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'oil_today'),
    (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'oil_today')),
    current_date, 'Oil', p_reading => '{"odometer_mi": 2000, "engine_hours": 150}',
    p_tasks => '[]') $$, 'the Oil task is removed from today''s record');
select is((select format('%s|%s', status, last_done_mi) from pg_temp.row_of('Oil')), 'overdue|900.0',
  'the board falls back to the previous completion');
select lives_ok($$ update public.maintenance_entries set deleted_at = now(),
    version = (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'oil_today'))
  where id = (select v::uuid from t where k = 'oil_today') $$, 'a service record is deleted');
select is((select status from pg_temp.row_of('Oil')), 'overdue', 'deleted records do not count');

-- Meter replacement: lifetime totals keep counting. (Dated tomorrow, the
-- latest allowed, so it is the only reading of its day in this one-transaction
-- test, where every row shares the same timestamp.)
select lives_ok($$ insert into public.sled_readings (sled_id, read_on, odometer_mi, odometer_reset)
  values ((select v::uuid from t where k = 'sled'), current_date + 1, 10, true) $$, 'the odometer is replaced (reads 10)');
select is((select format('%s|%s', current_mi, remaining_mi) from pg_temp.row_of('Belt')), '2000.0|200.0',
  'due mileage counts lifetime miles: the new meter reads 10, the sled is still at 2,000');

-- ---------------------------------------------------------------------------
-- Rules on plans
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, season_due_month, season_due_day)
  values ((select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_Never'), 2, 30) $$,
  '23514', null, 'season dates must be real (no Feb 30)');
select throws_ok($$ update public.maintenance_plans set season_due_month = 11
  where task_id = (select v::uuid from t where k = 'task_Wax') $$,
  '23514', null, 'a season month needs a day');
select throws_ok($$ update public.maintenance_plans set season_due_day = 1
  where task_id = (select v::uuid from t where k = 'task_Wax') $$,
  '23514', null, 'and a season day needs a month');
select throws_ok($$ update public.maintenance_plans set last_done_on = current_date + 5,
    version = (select version from public.maintenance_plans where task_id = (select v::uuid from t where k = 'task_Wax'))
  where task_id = (select v::uuid from t where k = 'task_Wax') $$,
  '22023', 'The last-done date cannot be in the future.', '"done before SledWerx" cannot be in the future');
select lives_ok($$ update public.maintenance_plans set season_due_month = 2, season_due_day = 29,
    version = (select version from public.maintenance_plans where task_id = (select v::uuid from t where k = 'task_Wax'))
  where task_id = (select v::uuid from t where k = 'task_Wax') $$, 'Feb 29 is allowed');
select ok((select extract(month from due_on) = 2 and extract(day from due_on) in (28, 29) from pg_temp.row_of('Wax')),
  'and falls on Feb 28 in other years');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_mi)
  values ((select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_Oil'), 10) $$,
  '23505', null, 'one active plan per task and sled');

-- ---------------------------------------------------------------------------
-- Sharing roles
-- ---------------------------------------------------------------------------
insert into t select 'tok_eli', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'eli5@example.com', 'editor');
insert into t select 'tok_max', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'max5@example.com', 'mechanic');
insert into t select 'tok_val', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'val5@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"a2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_eli')) $$, 'editor joins');
set local request.jwt.claims = '{"sub":"a3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_max')) $$, 'mechanic joins');
set local request.jwt.claims = '{"sub":"a4444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_val')) $$, 'viewer joins');

select is((select count(*)::int from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled')), 13,
  'a viewer sees the whole board');
select is((select task_name from pg_temp.row_of('Oil')), 'Oil', 'including the owner''s task names');

set local request.jwt.claims = '{"sub":"a3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date,
    'Never', p_tasks => jsonb_build_array(jsonb_build_object('task_id', (select v from t where k = 'task_Never')))) $$,
  'a mechanic marks a board task done');
select is((select status from pg_temp.row_of('Never')), 'good', 'and the board shows it done');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_days)
  values ((select v::uuid from t where k = 'sled'), (select v::uuid from t where k = 'task_Plugs'), 10) $$,
  '42501', null, 'mechanics cannot set up schedules');

set local request.jwt.claims = '{"sub":"a2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ with task as (insert into public.maintenance_tasks (sled_id, name)
    values ((select v::uuid from t where k = 'sled'), 'Studs') returning id)
  insert into public.maintenance_plans (sled_id, task_id, season_due_month, season_due_day)
  select (select v::uuid from t where k = 'sled'), id, 11, 1 from task $$,
  'an editor adds a snowmobile task to the board with a seasonal schedule');

set local request.jwt.claims = '{"sub":"a5555555-5555-5555-5555-555555555555","role":"authenticated"}';
select is((select count(*)::int from public.maintenance_board), 0, 'someone the sled is not shared with sees no board');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select 1 from public.maintenance_board $$, '42501', null, 'anonymous users cannot read the board');

select * from finish();
rollback;
