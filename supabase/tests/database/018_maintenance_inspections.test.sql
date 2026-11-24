-- Tests for migration 20261127090000_maintenance_inspections: Checked /
-- Replaced tracking, the inspection schedule, Needs Replacement, starting
-- points, Every Mileage Update, Decision D, and that existing schedules and
-- history behave exactly as before.
-- Everything runs in one transaction that is rolled back.
--
-- The sled starts at 1,000 mi / 100 h today; backdated records use less.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(67);

insert into auth.users (id, email, email_confirmed_at) values
  ('b1111111-1111-1111-1111-111111111111', 'mi-owner@example.com', now()),
  ('b2222222-2222-2222-2222-222222222222', 'mi-mech@example.com',  now()),
  ('b3333333-3333-3333-3333-333333333333', 'mi-view@example.com',  now()),
  ('b4444444-4444-4444-4444-444444444444', 'mi-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
create function pg_temp.row_of(p_task text) returns public.maintenance_board language sql stable as $$
  select b.* from public.maintenance_board b where b.sled_id = pg_temp.v('sled')::uuid and b.task_name = p_task;
$$;
grant execute on function pg_temp.row_of(text) to authenticated, anon;
-- A Check (one item) or several, as the current user.
create function pg_temp.check_(p_tasks text[], p_outcome text, p_days_ago int, p_mi numeric default null) returns jsonb
language sql volatile as $$
  select public.save_maintenance_inspection(
    gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - p_days_ago,
    (select jsonb_agg(jsonb_build_object('task_id', pg_temp.v('task_' || n), 'outcome', p_outcome)) from unnest(p_tasks) n),
    case when p_mi is null then null else jsonb_build_object('odometer_mi', p_mi) end);
$$;
grant execute on function pg_temp.check_(text[], text, int, numeric) to authenticated;
-- Replaced: an ordinary service record (Mark Done), as the current user.
create function pg_temp.replaced(p_task text, p_days_ago int, p_mi numeric default null) returns jsonb language sql volatile as $$
  select public.save_maintenance_entry(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - p_days_ago, p_task,
    p_reading => case when p_mi is null then null else jsonb_build_object('odometer_mi', p_mi) end,
    p_tasks => jsonb_build_array(jsonb_build_object('task_id', pg_temp.v('task_' || p_task))));
$$;
grant execute on function pg_temp.replaced(text, int, numeric) to authenticated;

set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Arctic Cat', 'Catalyst', 2025, 1000, 100)::text;
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'mi-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'mi-view@example.com', 'viewer');
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('b3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');

with created as (
  insert into public.maintenance_tasks (name)
  select n from unnest(array['Oil', 'Belt', 'Track', 'Plugs', 'Skid', 'Carbides', 'Clutch', 'Legacy', 'Wear']) n
  returning id, name
)
insert into t select 'task_' || name, id::text from created;

-- ---------------------------------------------------------------------------
-- Structure and defaults
-- ---------------------------------------------------------------------------
reset role;
select has_column('public', 'maintenance_entry_tasks', 'outcome', 'service record items have an outcome');
select has_column('public', 'maintenance_plans', 'tracks', 'plans say what they track');
select is((select column_default from information_schema.columns where table_name = 'maintenance_plans' and column_name = 'tracks'),
  '''replacement''::text', 'every existing schedule tracks replacement');
select is(has_function_privilege('anon', 'public.save_maintenance_inspection(uuid,uuid,date,jsonb,jsonb,text,text)', 'execute'), false,
  'anonymous users cannot record checks');
select ok(has_function_privilege('authenticated', 'public.save_maintenance_inspection(uuid,uuid,date,jsonb,jsonb,text,text)', 'execute'),
  'signed-in users can (permissions follow save_maintenance_entry)');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
           where table_name = 'maintenance_board' and ordinal_position <= 5),
  array['plan_id', 'sled_id', 'task_id', 'task_name', 'interval_mi'], 'the board''s existing columns come first, unchanged');
select ok((select count(*) from information_schema.columns where table_name = 'maintenance_board'
           and column_name in ('inspect_status', 'needs_replacement', 'last_checked_on', 'component_mi', 'item_rank', 'replace_status')) = 6,
  'the new board columns exist');
select is((select cardinality(private.cleanup_registry_problems())), 0, 'the cleanup registry is complete');

set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
insert into public.maintenance_plans (sled_id, task_id, interval_mi) values (pg_temp.v('sled')::uuid, pg_temp.v('task_Oil')::uuid, 500);
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Belt')::uuid, 'inspection', 30);
insert into public.maintenance_plans (sled_id, task_id, tracks, interval_mi, inspect_interval_mi)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Track')::uuid, 'both', 2000, 100);
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Plugs')::uuid, 'inspection', true);
insert into public.maintenance_plans (sled_id, task_id, tracks, replace_as_needed, inspect_season_month, inspect_season_day, inspect_season_kind)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Skid')::uuid, 'both', true, 12, 1, 'preseason');
insert into public.maintenance_plans (sled_id, task_id, tracks, interval_mi, last_done_on, last_done_mi, replace_baseline_kind, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Carbides')::uuid, 'both', 1500, current_date - 5, 900, 'tracking', 60);
insert into public.maintenance_plans (sled_id, task_id, tracks, interval_mi, last_done_on, last_done_mi, replace_baseline_kind, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Clutch')::uuid, 'both', 1500, current_date - 5, 900, 'known', 60);

select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, inspect_season_month)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Wear')::uuid, 12) $$, '23514', null, 'season month and day go together');
select throws_ok($$ update public.maintenance_plans set inspect_baseline_on = current_date + 10 where task_id = pg_temp.v('task_Belt')::uuid $$,
  '22023', 'The last-checked date cannot be in the future.', 'the last-checked date cannot be in the future');
select throws_ok($$ update public.maintenance_plans set tracks = 'sometimes' where task_id = pg_temp.v('task_Oil')::uuid $$,
  '23514', null, 'only replacement, inspection or both');

-- ---------------------------------------------------------------------------
-- Existing behaviour: a replacement-only schedule is calculated as before
-- ---------------------------------------------------------------------------
select is((pg_temp.row_of('Oil')).status, 'no_record', 'Oil: never done, as before');
select is((pg_temp.row_of('Oil')).replace_status, 'no_record', 'its replacement status matches');
select is((pg_temp.row_of('Oil')).inspect_status, null, 'no inspection schedule on a replacement-only item');
select lives_ok($$ select pg_temp.replaced('Oil', 10, 800) $$, 'Oil replaced at 800 mi');
select is((pg_temp.row_of('Oil')).status, 'good', 'due at 1,300 mi: good, as before');
select is((pg_temp.row_of('Oil')).remaining_mi, 300.0, '300 mi to go');
select is((pg_temp.row_of('Oil')).component_mi, 200.0, '200 mi on the component since it was replaced');
select is((pg_temp.row_of('Oil')).component_since, 'replacement', 'counted from the replacement');
select lives_ok($$ select pg_temp.check_(array['Oil'], 'good', 2) $$, 'a check of a replacement-only item can be recorded');
select is((pg_temp.row_of('Oil')).last_done_on, current_date - 10, 'a Check is not a completion: last replaced is unchanged');

-- ---------------------------------------------------------------------------
-- Inspection only (Belt): initial check, Good, overdue, Needs Replacement, Replaced
-- ---------------------------------------------------------------------------
select is((pg_temp.row_of('Belt')).inspect_status, 'initial_check', 'unknown history prompts an initial check');
select is((pg_temp.row_of('Belt')).replace_status, null, 'no replacement status on an inspection only item');
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select is((pg_temp.check_(array['Belt'], 'good', 40, 300) ->> 'duplicate')::boolean, false, 'a mechanic records a Good check 40 days ago');
select is((select category || ' / ' || title from public.maintenance_entries where id = (pg_temp.row_of('Belt')).last_check_entry_id),
  'inspection / Inspection', 'as an ordinary service record (category Inspection)');
select is((pg_temp.row_of('Belt')).inspect_status, 'overdue', 'every 30 days: overdue');
select is((pg_temp.row_of('Belt')).last_checked_mi, 300.0, 'last checked at 300 mi');
select is((pg_temp.row_of('Belt')).last_check_outcome, 'good', 'outcome Good');
select lives_ok($$ select pg_temp.check_(array['Belt'], 'needs_replacement', 1) $$, 'checked again: Needs Replacement');
select is((pg_temp.row_of('Belt')).needs_replacement, true, 'the item is flagged');
select is((pg_temp.row_of('Belt')).item_rank, -1, 'and comes first on the board');
select is((pg_temp.row_of('Belt')).inspect_status, 'good', 'the inspection schedule itself is reset');
select lives_ok($$ select pg_temp.replaced('Belt', 0) $$, 'the belt is replaced');
select is((pg_temp.row_of('Belt')).needs_replacement, false, 'the flag clears once replaced');
select is((pg_temp.row_of('Belt')).last_checked_source, 'service', 'an inspection only item counts the completion as its last check');

-- ---------------------------------------------------------------------------
-- Both (Track): Checked resets only the inspection schedule; Replaced resets both
-- ---------------------------------------------------------------------------
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
select lives_ok($$ select pg_temp.replaced('Track', 30, 500) $$, 'track replaced at 500 mi');
select is((pg_temp.row_of('Track')).last_checked_source, 'replacement', 'Replaced counts as the last check too');
select is((pg_temp.row_of('Track')).inspect_status, 'overdue', 'checks every 100 mi: overdue at 1,000 mi');
select is((pg_temp.row_of('Track')).inspect_due_mi, 600.0, 'the check was due at 600 mi');
select lives_ok($$ select pg_temp.check_(array['Track'], 'good', 3, 950) $$, 'checked Good at 950 mi');
select is((pg_temp.row_of('Track')).inspect_due_mi, 1050.0, 'next check due at 1,050 mi');
select is((pg_temp.row_of('Track')).last_done_on, current_date - 30, 'last replaced is unchanged by the check');
select is((pg_temp.row_of('Track')).due_mi, 2500.0, 'and so is the replacement schedule (2,500 mi)');

-- Several items in one Quick Check: one record, Mark All as Good.
select lives_ok($$ select pg_temp.check_(array['Track', 'Carbides', 'Clutch'], 'good', 0) $$, 'Quick Check: three items Good at once');
select is((select count(*)::int from public.maintenance_entry_tasks where entry_id = (pg_temp.row_of('Track')).last_check_entry_id), 3,
  'one service record with three checked items');

-- ---------------------------------------------------------------------------
-- Starting points: known vs tracking start (never a false replacement)
-- ---------------------------------------------------------------------------
select is((pg_temp.row_of('Carbides')).component_since, 'tracking', 'a tracking start shows miles since tracking began');
select is((pg_temp.row_of('Carbides')).component_mi, 100.0, '100 mi since tracking began');
select is((pg_temp.row_of('Clutch')).component_since, 'replacement', 'a known starting point is a replacement');

-- ---------------------------------------------------------------------------
-- Every Mileage Update (Plugs)
-- ---------------------------------------------------------------------------
select lives_ok($$ select pg_temp.check_(array['Plugs'], 'good', 0) $$, 'plugs checked today');
select is((pg_temp.row_of('Plugs')).inspect_status, 'good', 'no newer reading: not due');
select lives_ok($$ select pg_temp.check_(array['Plugs'], 'good', 1) $$, 'an earlier check (yesterday) does not change the newest');
select is((pg_temp.row_of('Plugs')).last_checked_on, current_date, 'the newest check is still today''s');
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_each_reading)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Wear')::uuid, 'inspection', true);
select lives_ok($$ select pg_temp.check_(array['Wear'], 'good', 1) $$, 'wear bars checked yesterday');
select is((pg_temp.row_of('Wear')).inspect_status, 'due', 'today''s mileage reading is newer: the check is due again');

-- ---------------------------------------------------------------------------
-- Seasonal check (preseason) and Replace as needed (Skid)
-- ---------------------------------------------------------------------------
select is((pg_temp.row_of('Skid')).inspect_season_kind, 'preseason', 'labelled preseason');
select is((pg_temp.row_of('Skid')).replace_status, 'as_needed', 'replacement as needed');
select is((pg_temp.row_of('Skid')).inspect_status, 'initial_check', 'never checked: initial check');

-- ---------------------------------------------------------------------------
-- Decision D: converting an item to inspection only keeps its history
-- ---------------------------------------------------------------------------
insert into public.maintenance_plans (sled_id, task_id, interval_days) values (pg_temp.v('sled')::uuid, pg_temp.v('task_Legacy')::uuid, 30);
select lives_ok($$ select pg_temp.replaced('Legacy', 12) $$, 'done 12 days ago (an old-style completion)');
update public.maintenance_plans set tracks = 'inspection', inspect_interval_days = interval_days, interval_days = null
  where task_id = pg_temp.v('task_Legacy')::uuid;
select is((pg_temp.row_of('Legacy')).last_checked_source, 'service', 'after conversion, the completion counts as a check');
select is((pg_temp.row_of('Legacy')).last_checked_on, current_date - 12, 'with its date');
select is((pg_temp.row_of('Legacy')).inspect_status, 'good', 'next check in 18 days');

-- ---------------------------------------------------------------------------
-- Refusals and access
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.save_maintenance_inspection(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date, '[]') $$,
  '22023', 'Choose at least one item to check.', 'at least one item');
select throws_ok($$ select public.save_maintenance_inspection(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date,
  jsonb_build_array(jsonb_build_object('task_id', pg_temp.v('task_Belt'), 'outcome', 'fine'))) $$, '22023', null, 'Good or Needs Replacement only');
select throws_ok($$ select public.save_maintenance_inspection(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date,
  jsonb_build_array(jsonb_build_object('task_id', pg_temp.v('task_Belt'), 'outcome', 'good'),
                    jsonb_build_object('task_id', pg_temp.v('task_Belt'), 'outcome', 'good'))) $$, '22023', null, 'each item once');
select throws_ok($$ update public.maintenance_entry_tasks set done = false where outcome is not null $$,
  '23514', null, 'a check is always a done item');
select pg_temp.as_user('b3333333-3333-3333-3333-333333333333');
select throws_ok($$ select pg_temp.check_(array['Belt'], 'good', 0) $$, '42501', null, 'a viewer cannot record a check');
select pg_temp.as_user('b4444444-4444-4444-4444-444444444444');
select is((select count(*)::int from public.maintenance_board where sled_id = pg_temp.v('sled')::uuid), 0, 'others see nothing');

select * from finish();
rollback;
