-- Tests for save_maintenance_entry() in migration 20261112210000.
-- Run with: npx supabase test db   (requires the local Supabase stack)
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(52);

-- ---------------------------------------------------------------------------
-- Fixtures: Opal (owner), Ed (editor), Mo (mechanic), Vi (viewer), Xu (no
-- access). Sled A is shared with Ed, Mo and Vi; sled B is not shared.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('71111111-1111-1111-1111-111111111111', 'opal@example.com', now()),
  ('72222222-2222-2222-2222-222222222222', 'ed@example.com',   now()),
  ('73333333-3333-3333-3333-333333333333', 'mo@example.com',   now()),
  ('74444444-4444-4444-4444-444444444444', 'vi@example.com',   now()),
  ('75555555-5555-5555-5555-555555555555', 'xu@example.com',   now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

-- Counts of everything the function writes, to prove failed calls save nothing.
create function pg_temp.saved_rows() returns bigint language sql as $$
  select (select count(*) from public.sled_readings)
       + (select count(*) from public.maintenance_entries)
       + (select count(*) from public.maintenance_entry_tasks)
       + (select count(*) from public.maintenance_entry_parts)
$$;
grant execute on function pg_temp.saved_rows() to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.sleds (id, garage_id, model_year, make, model)
select s.id, g.id, 2024, 'Arctic Cat', 'Catalyst'
from (values ('7aaaaaaa-0000-0000-0000-000000000001'::uuid), ('7aaaaaaa-0000-0000-0000-000000000002'::uuid)) s(id)
cross join public.garages g;
insert into public.maintenance_tasks (id, name) values
  ('7b000000-0000-0000-0000-000000000001', 'Change chaincase oil'),
  ('7b000000-0000-0000-0000-000000000002', 'Unrelated private task');
insert into public.maintenance_plans (sled_id, task_id, interval_mi)
  values ('7aaaaaaa-0000-0000-0000-000000000001', '7b000000-0000-0000-0000-000000000001', 1000);
insert into t select 'tok_ed', token from public.create_sled_invitation('7aaaaaaa-0000-0000-0000-000000000001', 'ed@example.com', 'editor');
insert into t select 'tok_mo', token from public.create_sled_invitation('7aaaaaaa-0000-0000-0000-000000000001', 'mo@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation('7aaaaaaa-0000-0000-0000-000000000001', 'vi@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"72222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_ed')) $$, 'editor joins');
set local request.jwt.claims = '{"sub":"73333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_mo')) $$, 'mechanic joins');
set local request.jwt.claims = '{"sub":"74444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_vi')) $$, 'viewer joins');

-- ---------------------------------------------------------------------------
-- Successful save
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$
  insert into t select 'save1', public.save_maintenance_entry(
    p_idempotency_key => '7c000000-0000-0000-0000-000000000001',
    p_sled_id => '7aaaaaaa-0000-0000-0000-000000000001',
    p_performed_on => '2026-08-01',
    p_title => 'Chaincase and track service',
    p_done_by => 'Me',
    p_labor_cost => 30,
    p_reading => '{"odometer_mi": 1500, "engine_hours": 60}',
    p_tasks => '[{"task_id": "7b000000-0000-0000-0000-000000000001"},
                 {"task_name": "Adjusted track tension", "note": "Two turns"}]',
    p_parts => '[{"name": "Chaincase oil", "part_number": "CC-1", "quantity": 2, "unit_cost": 11.25},
                 {"name": "Shop rags", "unit_cost": 4}]'
  )::text
$$, 'owner saves a complete entry in one call');
insert into t select 'entry1', (v::jsonb ->> 'entry_id') from t where k = 'save1';
insert into t select 'reading1', (v::jsonb ->> 'reading_id') from t where k = 'save1';

select is((select (v::jsonb ->> 'duplicate')::boolean from t where k = 'save1'), false, 'a first save is not a duplicate');
select is((select reading_id::text from public.maintenance_entries where id = (select v::uuid from t where k = 'entry1')),
  (select v from t where k = 'reading1'), 'the entry is linked to its reading');
select is((select odometer_mi::text || '/' || engine_hours::text || '/' || read_on::text from public.sled_readings
           where id = (select v::uuid from t where k = 'reading1')),
  '1500.0/60.0/2026-08-01', 'the reading is saved with the entry date by default');
select results_eq($$ select task_name, position from public.maintenance_entry_tasks
                     where entry_id = (select v::uuid from t where k = 'entry1') order by position $$,
  $$ values ('Change chaincase oil'::text, 0), ('Adjusted track tension'::text, 1) $$,
  'checklist tasks are saved in order, with library task names filled in');
select is((select count(*)::int from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'entry1')),
  2, 'parts are saved');
select is((select total_cost from public.maintenance_entry_costs where entry_id = (select v::uuid from t where k = 'entry1')),
  56.50, 'costs total labor and parts (USD)');
select is((select version::text || '/' || created_by::text from public.maintenance_entries
           where id = (select v::uuid from t where k = 'entry1')),
  '1/71111111-1111-1111-1111-111111111111', 'versioning and authorship are applied as for direct inserts');
select is((select count(*)::int from public.audit_log
           where record_id in (select id from public.maintenance_entries where id = (select v::uuid from t where k = 'entry1'))
              or record_id = (select v::uuid from t where k = 'reading1')
              or record_id in (select id from public.maintenance_entry_tasks where entry_id = (select v::uuid from t where k = 'entry1'))
              or record_id in (select id from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'entry1'))),
  6, 'every saved row is audited');
insert into t select 'rows_after_save1', pg_temp.saved_rows()::text;

-- ---------------------------------------------------------------------------
-- Duplicate submissions
-- ---------------------------------------------------------------------------
select is(public.save_maintenance_entry(
    p_idempotency_key => '7c000000-0000-0000-0000-000000000001',
    p_sled_id => '7aaaaaaa-0000-0000-0000-000000000001',
    p_performed_on => '2026-08-01', p_title => 'Chaincase and track service',
    p_reading => '{"odometer_mi": 1500, "engine_hours": 60}',
    p_parts => '[{"name": "Chaincase oil", "quantity": 2, "unit_cost": 11.25}]') ->> 'entry_id',
  (select v from t where k = 'entry1'), 'resubmitting with the same key returns the saved entry');
select is((public.save_maintenance_entry('7c000000-0000-0000-0000-000000000001', '7aaaaaaa-0000-0000-0000-000000000001',
             '2026-08-01', 'Chaincase and track service') ->> 'duplicate')::boolean,
  true, 'the response marks it as a duplicate');
select is(pg_temp.saved_rows()::text, (select v from t where k = 'rows_after_save1'),
  'duplicate submissions save nothing new');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000001',
                    '7aaaaaaa-0000-0000-0000-000000000002', '2026-08-01', 'Other sled') $$,
  '22023', null, 'a key already used for another sled is rejected');
select throws_ok($$ insert into public.maintenance_entries (sled_id, performed_on, title, client_request_id)
                    values ('7aaaaaaa-0000-0000-0000-000000000001', '2026-08-01', 'Race', '7c000000-0000-0000-0000-000000000001') $$,
  '23505', null, 'the database itself rejects a second entry with the same key (simultaneous submissions)');
select throws_ok($$ update public.maintenance_entries set client_request_id = gen_random_uuid()
                    where id = (select v::uuid from t where k = 'entry1') $$,
  '42501', null, 'the idempotency key cannot be changed');

-- Keys are per user: another user's identical key does not collide.
set local request.jwt.claims = '{"sub":"72222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((public.save_maintenance_entry('7c000000-0000-0000-0000-000000000001', '7aaaaaaa-0000-0000-0000-000000000001',
             '2026-08-02', 'Editor entry') ->> 'duplicate')::boolean,
  false, 'idempotency keys are scoped to the user');

-- ---------------------------------------------------------------------------
-- Complete rollback on failure (nothing partially saved)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'rows_before_failures', pg_temp.saved_rows()::text;

select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000010',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Bad part',
    p_reading => '{"odometer_mi": 1600}', p_tasks => '[{"task_name": "Inspect"}]',
    p_parts => '[{"name": "Belt", "quantity": 0}]') $$,
  '23514', null, 'an invalid part fails the save');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000011',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Odometer went down',
    p_reading => '{"odometer_mi": 1400}', p_tasks => '[{"task_name": "Inspect"}]') $$,
  '23514', null, 'a reading lower than the history fails the save');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000012',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Bad task',
    p_reading => '{"odometer_mi": 1600}', p_tasks => '[{"task_name": "Fine"}, {"note": "no name or id"}]') $$,
  '22023', null, 'a task without a name or id fails the save');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000013',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', '',
    p_reading => '{"odometer_mi": 1600}') $$,
  '23514', null, 'an entry without a title fails the save');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000014',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Bad JSON', p_tasks => '{"task_name": "x"}') $$,
  '22023', null, 'malformed input fails the save');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000015',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Bad reading', p_reading => '{"note": "no values"}') $$,
  '23514', null, 'a reading without miles or hours fails the save');
select is(pg_temp.saved_rows()::text, (select v from t where k = 'rows_before_failures'),
  'failed saves leave no reading, entry, task or part behind');
select is_empty($$ select 1 from public.audit_log a
                   where a.table_name = 'sled_readings'
                     and (a.new_data ->> 'odometer_mi')::numeric in (1600, 1400) $$,
  'failed saves leave no audit history either');
select is((public.save_maintenance_entry('7c000000-0000-0000-0000-000000000010',
             '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-03', 'Retry after fixing the part',
             p_reading => '{"odometer_mi": 1600}', p_parts => '[{"name": "Belt", "quantity": 1}]') ->> 'duplicate')::boolean,
  false, 'a failed save can be retried with the same key');

-- ---------------------------------------------------------------------------
-- Replacement events in readings
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into t select 'reset', public.save_maintenance_entry('7c000000-0000-0000-0000-000000000020',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-01', 'Replaced speedometer',
    p_reading => '{"odometer_mi": 0, "odometer_reset": true, "note": "New gauge"}')::text $$,
  'an odometer replacement saves with the entry');
select is((select total_mi from public.sled_reading_history
           where id = (select (v::jsonb ->> 'reading_id')::uuid from t where k = 'reset')),
  1600.0, 'total miles continue across the replacement');
select lives_ok($$ insert into t select 'engine', public.save_maintenance_entry('7c000000-0000-0000-0000-000000000021',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-02', 'Engine replaced',
    p_labor_cost => 900,
    p_reading => '{"odometer_mi": 20, "engine_hours": 0, "hour_meter_reset": true, "engine_event": "engine_replaced"}',
    p_parts => '[{"name": "Engine assembly", "unit_cost": 4200}]')::text $$,
  'an engine replacement with a new hour meter saves with the entry');
select is((select total_engine_hours::text || '/' || engine_event::text from public.sled_reading_history
           where id = (select (v::jsonb ->> 'reading_id')::uuid from t where k = 'engine')),
  '60.0/engine_replaced', 'engine hours continue across the hour-meter reset');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000022',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-03', 'Bad event',
    p_reading => '{"engine_hours": 1, "engine_event": "engine_exploded"}') $$,
  '22P02', null, 'an unknown engine event is rejected');
select lives_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000023',
    '7aaaaaaa-0000-0000-0000-000000000002', '2026-09-03', 'Quick note, no reading') $$,
  'an entry without a reading, tasks or parts saves');

-- ---------------------------------------------------------------------------
-- Authorization: the function cannot bypass permissions
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"73333333-3333-3333-3333-333333333333","role":"authenticated"}';
insert into t select 'rows_mechanic', pg_temp.saved_rows()::text;
select lives_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000030',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-04', 'Mechanic service',
    p_reading => '{"odometer_mi": 30}',
    p_tasks => '[{"task_name": "Checked brakes"}, {"task_id": "7b000000-0000-0000-0000-000000000001"}]') $$,
  'mechanics can save entries with free text or tasks already used on the sled');
insert into t select 'rows_mechanic2', pg_temp.saved_rows()::text;
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000031',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-05', 'Sneaky',
    p_reading => '{"odometer_mi": 40}',
    p_tasks => '[{"task_id": "7b000000-0000-0000-0000-000000000002"}]') $$,
  '42501', null, 'mechanics cannot use the owner''s unrelated library tasks');
select is(pg_temp.saved_rows()::text, (select v from t where k = 'rows_mechanic2'),
  'the rejected save left nothing behind, not even its reading');
select is((select created_by from public.maintenance_entries where client_request_id = '7c000000-0000-0000-0000-000000000030'),
  '73333333-3333-3333-3333-333333333333'::uuid, 'entries are owned by the user who saved them');

set local request.jwt.claims = '{"sub":"74444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000040',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'Viewer') $$,
  '42501', null, 'viewers cannot save entries');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000041',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'Viewer with reading', p_reading => '{"odometer_mi": 99}') $$,
  '42501', null, 'viewers cannot save readings through the function');

set local request.jwt.claims = '{"sub":"75555555-5555-5555-5555-555555555555","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000050',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'Intruder', p_reading => '{"odometer_mi": 99}') $$,
  '42501', null, 'users without access cannot save to someone else''s sled');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000051',
    '7aaaaaaa-0000-0000-0000-000000000002', '2026-09-06', 'Intruder 2') $$,
  '42501', null, 'users without access cannot save to an unshared sled');
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000001',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-08-01', 'Replay someone else''s key') $$,
  '42501', null, 'reusing another user''s key reveals nothing and saves nothing');

set local request.jwt.claims = '{"sub":"72222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000060',
    '7aaaaaaa-0000-0000-0000-000000000002', '2026-09-06', 'Not shared with editor') $$,
  '42501', null, 'editors cannot save to sleds not shared with them');

set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.sleds set deleted_at = now() where id = '7aaaaaaa-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"72222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000061',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'Suspended') $$,
  '42501', null, 'suspended sharing blocks saves');
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry('7c000000-0000-0000-0000-000000000062',
    '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'Deleted sled') $$,
  '42501', null, 'nothing can be saved to a sled in Recently Deleted');
update public.sleds set deleted_at = null where id = '7aaaaaaa-0000-0000-0000-000000000001';

reset role;
select is(
  (select prosecdef from pg_proc where proname = 'save_maintenance_entry'), false,
  'the function runs with the caller''s permissions (security invoker)');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.save_maintenance_entry(gen_random_uuid(), '7aaaaaaa-0000-0000-0000-000000000001', '2026-09-06', 'x') $$,
  '42501', null, 'anonymous users cannot call the function');

-- ---------------------------------------------------------------------------
-- Recently Deleted behaves as for any entry
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update public.maintenance_entries set deleted_at = now() where id = (select v::uuid from t where k = 'entry1') $$,
  'a saved entry can be moved to Recently Deleted');
select is((select count(*)::int from public.maintenance_entry_tasks where entry_id = (select v::uuid from t where k = 'entry1') and deleted_at is not null)
        + (select count(*)::int from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'entry1') and deleted_at is not null),
  4, 'its tasks and parts go with it');
select is((select deleted_at from public.sled_readings where id = (select v::uuid from t where k = 'reading1')), null,
  'its reading stays in mileage history');
select is((public.save_maintenance_entry('7c000000-0000-0000-0000-000000000001', '7aaaaaaa-0000-0000-0000-000000000001',
             '2026-08-01', 'Chaincase and track service') ->> 'entry_id'),
  (select v from t where k = 'entry1'), 'a retry after deletion still does not create a duplicate');

select * from finish();
rollback;
