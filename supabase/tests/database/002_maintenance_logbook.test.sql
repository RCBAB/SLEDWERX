-- Tests for migration 20261112210000_maintenance_logbook.
-- Run with: npx supabase test db   (requires the local Supabase stack)
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(107);

-- ---------------------------------------------------------------------------
-- Fixtures: Olive (owner), Eli (editor), Max (mechanic), Val (viewer),
-- Xena (unrelated user). Sled 1 is shared with Eli, Max and Val; sled 2 is not.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('51111111-1111-1111-1111-111111111111', 'olive@example.com', now()),
  ('52222222-2222-2222-2222-222222222222', 'eli@example.com',   now()),
  ('53333333-3333-3333-3333-333333333333', 'max@example.com',   now()),
  ('54444444-4444-4444-4444-444444444444', 'val@example.com',   now()),
  ('55555555-5555-5555-5555-555555555555', 'xena@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
insert into t select 'garage_olive', id::text from public.garages
  where owner_id = '51111111-1111-1111-1111-111111111111';

set local role authenticated;
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.sleds (id, garage_id, model_year, make, model) values
  ('5aaaaaaa-0000-0000-0000-000000000001', (select v::uuid from t where k = 'garage_olive'), 2024, 'Polaris', 'RMK'),
  ('5aaaaaaa-0000-0000-0000-000000000002', (select v::uuid from t where k = 'garage_olive'), 2021, 'Ski-Doo', 'Summit');
insert into t select 'tok_eli', token from public.create_sled_invitation('5aaaaaaa-0000-0000-0000-000000000001', 'eli@example.com', 'editor');
insert into t select 'tok_max', token from public.create_sled_invitation('5aaaaaaa-0000-0000-0000-000000000001', 'max@example.com', 'mechanic');
insert into t select 'tok_val', token from public.create_sled_invitation('5aaaaaaa-0000-0000-0000-000000000001', 'val@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_eli')) $$, 'editor joins sled 1');
set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_max')) $$, 'mechanic joins sled 1');
set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_val')) $$, 'viewer joins sled 1');

-- ---------------------------------------------------------------------------
-- Blanket checks
-- ---------------------------------------------------------------------------
reset role;
select is_empty($$ select tablename from pg_tables where schemaname = 'public' and not rowsecurity $$,
  'every table has Row Level Security enabled');
select is_empty($$ select table_name from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public' $$, 'anonymous users have no privileges on any table or view');
select is_empty($$ select table_name || ':' || privilege_type from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema = 'public'
    and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') $$,
  'signed-in users cannot hard-delete or truncate anything');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') $$,
  'anonymous users cannot execute any SledWerx function');
select is_empty($$ select table_name from information_schema.columns
  where table_schema = 'public' and column_name ilike '%currency%' $$, 'no currency configuration (USD only)');
select ok(pg_get_functiondef('private.tg_sled_readings_order'::regproc) like '%pg_advisory_xact_lock%',
  'reading validation is serialized per sled, so simultaneous saves cannot break the history');

-- ---------------------------------------------------------------------------
-- Personal library: tasks and packages
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ insert into public.maintenance_tasks (id, name) values ('5b000000-0000-0000-0000-000000000001', 'Chaincase oil') $$,
  'owner can add a task to their library');
select is((select owner_id from public.maintenance_tasks where id = '5b000000-0000-0000-0000-000000000001'),
  '51111111-1111-1111-1111-111111111111'::uuid, 'library tasks belong to the user who created them');
insert into public.maintenance_tasks (id, name) values ('5b000000-0000-0000-0000-000000000002', 'Secret task');
select throws_ok($$ insert into public.maintenance_tasks (name) values (' chaincase OIL') $$,
  '23505', null, 'task names are unique within a library');
select is_empty($$ select 1 from public.maintenance_tasks where owner_id is null and sled_id is null $$,
  'there are no built-in tasks');
select lives_ok($$ insert into public.maintenance_packages (id, name) values ('5c000000-0000-0000-0000-000000000001', 'Preseason') $$,
  'owner can create a package');
select lives_ok($$ insert into public.maintenance_package_tasks (package_id, task_id)
  values ('5c000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000001') $$,
  'owner can add library tasks to a package');

set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
insert into public.maintenance_tasks (id, name) values ('5b000000-0000-0000-0000-000000000004', 'Xena task');
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ insert into public.maintenance_package_tasks (package_id, task_id)
  values ('5c000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000004') $$,
  '42501', null, 'packages accept only tasks from your own library');

-- Shared users cannot see the owner's unrelated library or packages.
set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is_empty($$ select 1 from public.maintenance_tasks where owner_id = '51111111-1111-1111-1111-111111111111' $$,
  'shared users cannot see the owner''s library tasks that are not used on the shared sled');
select is_empty($$ select 1 from public.maintenance_packages $$, 'shared users cannot see the owner''s packages');
update public.maintenance_packages set name = 'Hijacked' where id = '5c000000-0000-0000-0000-000000000001';

-- Sled-specific tasks
select lives_ok($$ insert into public.maintenance_tasks (id, sled_id, name)
  values ('5b000000-0000-0000-0000-000000000003', '5aaaaaaa-0000-0000-0000-000000000001', 'Grease suspension') $$,
  'editors can create a task on a shared sled');
select is((select owner_id from public.maintenance_tasks where id = '5b000000-0000-0000-0000-000000000003'),
  null, 'a sled task does not go into anyone''s library');

set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ insert into public.maintenance_tasks (sled_id, name)
  values ('5aaaaaaa-0000-0000-0000-000000000001', 'Mechanic task') $$, '42501', null,
  'mechanics cannot create tasks');
set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ insert into public.maintenance_tasks (sled_id, name)
  values ('5aaaaaaa-0000-0000-0000-000000000001', 'Viewer task') $$, '42501', null,
  'viewers cannot create tasks');

-- ---------------------------------------------------------------------------
-- Maintenance schedules (plans)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select name from public.maintenance_packages where id = '5c000000-0000-0000-0000-000000000001'),
  'Preseason', 'editors cannot modify the owner''s packages');
select lives_ok($$ insert into public.maintenance_plans (id, sled_id, task_id, interval_mi, interval_days)
  values ('5d000000-0000-0000-0000-000000000001', '5aaaaaaa-0000-0000-0000-000000000001',
          '5b000000-0000-0000-0000-000000000001', 500, 365) $$,
  'owner can schedule a library task by miles and days');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id)
  values ('5aaaaaaa-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000001') $$,
  '23514', null, 'a schedule needs at least one interval');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_days)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000001', 30) $$,
  '23505', null, 'one active schedule per task per sled');
select lives_ok($$ insert into public.maintenance_plans (id, sled_id, task_id, interval_days)
  values ('5d000000-0000-0000-0000-000000000003', '5aaaaaaa-0000-0000-0000-000000000002',
          '5b000000-0000-0000-0000-000000000002', 90) $$, 'owner can schedule on an unshared sled');

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ insert into public.maintenance_plans (id, sled_id, task_id, interval_hours)
  values ('5d000000-0000-0000-0000-000000000002', '5aaaaaaa-0000-0000-0000-000000000001',
          '5b000000-0000-0000-0000-000000000003', 25) $$,
  'editors can schedule by engine hours');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_days)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000002', 30) $$,
  '42501', 'This task cannot be used on this snowmobile.',
  'editors cannot use the owner''s unrelated library tasks');
select results_eq($$ select id from public.maintenance_tasks order by id $$,
  $$ values ('5b000000-0000-0000-0000-000000000001'::uuid), ('5b000000-0000-0000-0000-000000000003'::uuid) $$,
  'shared users see only the tasks used on the shared sled');
select is_empty($$ select 1 from public.maintenance_plans where sled_id = '5aaaaaaa-0000-0000-0000-000000000002' $$,
  'shared users cannot see schedules of unshared sleds');

set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_days)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000003', 30) $$,
  '42501', null, 'mechanics cannot set up schedules');

set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select results_eq($$ select id from public.maintenance_tasks order by id $$,
  $$ values ('5b000000-0000-0000-0000-000000000001'::uuid), ('5b000000-0000-0000-0000-000000000003'::uuid) $$,
  'viewers see the same sled-related tasks');

set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
select results_eq($$ select id from public.maintenance_tasks $$,
  $$ values ('5b000000-0000-0000-0000-000000000004'::uuid) $$, 'unrelated users see only their own library');
select is_empty($$ select 1 from public.maintenance_plans $$, 'unrelated users see no schedules');

-- ---------------------------------------------------------------------------
-- Mileage and engine-hour history
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ insert into public.sled_readings (id, sled_id, read_on, odometer_mi, engine_hours)
  values ('5e000000-0000-0000-0000-000000000001', '5aaaaaaa-0000-0000-0000-000000000001', '2026-01-01', 1000, 50) $$,
  'owner can record miles and engine hours');

set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ insert into public.sled_readings (id, sled_id, read_on, odometer_mi)
  values ('5e000000-0000-0000-0000-000000000002', '5aaaaaaa-0000-0000-0000-000000000001', '2026-02-01', 1200) $$,
  'mechanics can record readings');
select throws_ok($$ insert into public.sled_readings (sled_id, read_on, odometer_mi)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-03-01', 1100) $$,
  '23514', null, 'odometer readings cannot go down');
select throws_ok($$ insert into public.sled_readings (sled_id, read_on, odometer_mi)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-01-15', 1300) $$,
  '23514', null, 'a back-dated reading must fit the existing history');
select lives_ok($$ update public.sled_readings set note = 'Before trip' where id = '5e000000-0000-0000-0000-000000000002' $$,
  'mechanics can edit their own readings');
update public.sled_readings set note = 'changed by mechanic' where id = '5e000000-0000-0000-0000-000000000001';
select throws_ok($$ update public.sled_readings set deleted_at = now() where id = '5e000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'mechanics cannot delete readings');

set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select note from public.sled_readings where id = '5e000000-0000-0000-0000-000000000001'), null,
  'mechanics cannot edit other people''s readings');
select lives_ok($$ insert into public.sled_readings (id, sled_id, read_on, odometer_mi, odometer_reset, note)
  values ('5e000000-0000-0000-0000-000000000003', '5aaaaaaa-0000-0000-0000-000000000001', '2026-03-01', 0, true, 'New gauge') $$,
  'an odometer replacement is recorded as a reset');
insert into public.sled_readings (id, sled_id, read_on, odometer_mi)
  values ('5e000000-0000-0000-0000-000000000004', '5aaaaaaa-0000-0000-0000-000000000001', '2026-04-01', 150);
select is((select total_mi from public.sled_reading_history where id = '5e000000-0000-0000-0000-000000000004'),
  1350.0, 'total miles continue across an odometer replacement');
select is((select total_mi from public.sled_reading_history where id = '5e000000-0000-0000-0000-000000000003'),
  1200.0, 'the reset reading keeps the previous total');
select lives_ok($$ insert into public.sled_readings (id, sled_id, read_on, engine_hours, hour_meter_reset, engine_event)
  values ('5e000000-0000-0000-0000-000000000005', '5aaaaaaa-0000-0000-0000-000000000001', '2026-05-01', 0, true, 'engine_replaced') $$,
  'an engine replacement with a new hour meter is recorded');
insert into public.sled_readings (id, sled_id, read_on, engine_hours)
  values ('5e000000-0000-0000-0000-000000000006', '5aaaaaaa-0000-0000-0000-000000000001', '2026-06-01', 10);
select is((select total_engine_hours from public.sled_reading_history where id = '5e000000-0000-0000-0000-000000000006'),
  60.0, 'total engine hours continue across an hour-meter reset');
select throws_ok($$ insert into public.sled_readings (sled_id, read_on, engine_hours)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-06-15', 5) $$,
  '23514', null, 'engine-hour readings cannot go down');
select throws_ok($$ insert into public.sled_readings (sled_id, read_on) values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-06-20') $$,
  '23514', null, 'a reading needs miles or engine hours');
select throws_ok($$ insert into public.sled_readings (sled_id, read_on, engine_hours, odometer_reset)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-06-20', 11, true) $$,
  '23514', null, 'an odometer reset needs an odometer value');
insert into public.sled_readings (id, sled_id, read_on, odometer_mi, engine_hours)
  values ('5e000000-0000-0000-0000-000000000007', '5aaaaaaa-0000-0000-0000-000000000001', '2026-07-01', 400, 12),
         ('5e000000-0000-0000-0000-000000000008', '5aaaaaaa-0000-0000-0000-000000000002', '2026-01-01', 10, 1);

-- ---------------------------------------------------------------------------
-- Logbook entries, checklist tasks and parts
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.maintenance_entries (id, sled_id, performed_on, title, labor_cost, reading_id)
  values ('5f000000-0000-0000-0000-000000000001', '5aaaaaaa-0000-0000-0000-000000000001', '2026-07-01',
          'Chaincase service', 50, '5e000000-0000-0000-0000-000000000007') $$,
  'owner can log maintenance with its reading');
select throws_ok($$ insert into public.maintenance_entries (sled_id, performed_on, title, reading_id)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-07-01', 'Wrong reading', '5e000000-0000-0000-0000-000000000008') $$,
  '23503', null, 'an entry cannot use another sled''s reading');
select lives_ok($$ insert into public.maintenance_entry_tasks (id, entry_id, task_id)
  values ('60000000-0000-0000-0000-000000000001', '5f000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000001') $$,
  'owner can record a completed task');
select is((select task_name from public.maintenance_entry_tasks where id = '60000000-0000-0000-0000-000000000001'),
  'Chaincase oil', 'the task name is copied into history');
select lives_ok($$ insert into public.maintenance_entry_parts (id, entry_id, name, part_number, quantity, unit_cost)
  values ('61000000-0000-0000-0000-000000000001', '5f000000-0000-0000-0000-000000000001', 'Chaincase oil 12 oz', 'CC-12', 2, 12.50) $$,
  'owner can record parts used');
select is((select total_cost from public.maintenance_entry_costs where entry_id = '5f000000-0000-0000-0000-000000000001'),
  75.00, 'entry cost totals labor and parts in USD');
select throws_ok($$ update public.maintenance_entries set title = 'Old copy', version = version - 1
  where id = '5f000000-0000-0000-0000-000000000001' $$, 'PT409', null,
  'an out-of-date update is rejected as a conflict');

set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ insert into public.maintenance_entries (id, sled_id, performed_on, title)
  values ('5f000000-0000-0000-0000-000000000002', '5aaaaaaa-0000-0000-0000-000000000001', '2026-07-02', 'Track check') $$,
  'mechanics can log maintenance');
select lives_ok($$ insert into public.maintenance_entry_tasks (entry_id, task_name)
  values ('5f000000-0000-0000-0000-000000000002', 'Checked track tension') $$,
  'mechanics can log free-text work');
select lives_ok($$ insert into public.maintenance_entry_tasks (entry_id, task_id)
  values ('5f000000-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000003') $$,
  'mechanics can log work using an existing sled task');
select lives_ok($$ insert into public.maintenance_entry_tasks (entry_id, task_id)
  values ('5f000000-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000001') $$,
  'mechanics can log work using a library task already used on the sled');
select throws_ok($$ insert into public.maintenance_entry_tasks (entry_id, task_id)
  values ('5f000000-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000002') $$,
  '42501', null, 'mechanics cannot reach the owner''s unrelated library tasks');
select throws_ok($$ update public.maintenance_entries set deleted_at = now() where id = '5f000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'mechanics cannot delete entries, even their own');
select throws_ok($$ insert into public.maintenance_entry_parts (entry_id, name, unit_cost)
  values ('5f000000-0000-0000-0000-000000000001', 'Gold-plated bolt', 999) $$,
  '42501', 'You do not have permission to change this maintenance entry.',
  'mechanics cannot add parts to someone else''s entry');
select throws_ok($$ insert into public.maintenance_entry_tasks (entry_id, task_name)
  values ('5f000000-0000-0000-0000-000000000001', 'Added by mechanic') $$,
  '42501', 'You do not have permission to change this maintenance entry.',
  'mechanics cannot add tasks to someone else''s entry');
update public.maintenance_entries set title = 'Mechanic edit' where id = '5f000000-0000-0000-0000-000000000001';

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ insert into public.maintenance_entry_parts (entry_id, name, unit_cost)
  values ('5f000000-0000-0000-0000-000000000002', 'Track clip', 3) $$,
  'editors can add parts to other people''s entries');

set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ insert into public.maintenance_entries (sled_id, performed_on, title)
  values ('5aaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'Viewer entry') $$, '42501', null,
  'viewers cannot log maintenance');
select is((select count(*)::int from public.maintenance_entries), 2, 'viewers can read the logbook');

set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select title from public.maintenance_entries where id = '5f000000-0000-0000-0000-000000000001'),
  'Chaincase service', 'mechanics cannot edit other people''s entries');
select throws_ok($$ update public.maintenance_entry_tasks set entry_id = '5f000000-0000-0000-0000-000000000002'
  where id = '60000000-0000-0000-0000-000000000001' $$, '42501', null, 'entry items cannot be moved to another entry');

-- ---------------------------------------------------------------------------
-- Deleting entries: dependants follow, the reading stays
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.sled_readings set deleted_at = now() where id = '5e000000-0000-0000-0000-000000000007' $$,
  '42501', null, 'a reading used by an active entry cannot be deleted on its own');

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ update public.maintenance_entries set deleted_at = now() where id = '5f000000-0000-0000-0000-000000000001' $$,
  'editors can move an entry to Recently Deleted');
select is((select count(*)::int from public.maintenance_entry_tasks where entry_id = '5f000000-0000-0000-0000-000000000001' and deleted_at is not null)
        + (select count(*)::int from public.maintenance_entry_parts where entry_id = '5f000000-0000-0000-0000-000000000001' and deleted_at is not null),
  2, 'the entry''s tasks and parts go to Recently Deleted with it');
select is((select deleted_at from public.sled_readings where id = '5e000000-0000-0000-0000-000000000007'), null,
  'deleting an entry does not delete its odometer reading');
select ok(exists (select 1 from public.sled_reading_history where id = '5e000000-0000-0000-0000-000000000007'),
  'the reading stays in mileage history');

set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is_empty($$ select 1 from public.maintenance_entries where id = '5f000000-0000-0000-0000-000000000001' $$,
  'viewers cannot see entries in Recently Deleted');

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ update public.maintenance_entries set deleted_at = null where id = '5f000000-0000-0000-0000-000000000001' $$,
  'editors can restore an entry');
select is((select count(*)::int from public.maintenance_entry_tasks where entry_id = '5f000000-0000-0000-0000-000000000001' and deleted_at is null)
        + (select count(*)::int from public.maintenance_entry_parts where entry_id = '5f000000-0000-0000-0000-000000000001' and deleted_at is null),
  2, 'restoring the entry restores its tasks and parts');

-- ---------------------------------------------------------------------------
-- Restoring a previous version (Decision 6)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.maintenance_entries set title = 'Chaincase servise' where id = '5f000000-0000-0000-0000-000000000001';
insert into t select 'audit_typo', max(id)::text from public.audit_log
  where record_id = '5f000000-0000-0000-0000-000000000001' and 'title' = any (changed_fields);
insert into t select 'audit_count', count(*)::text from public.audit_log where record_id = '5f000000-0000-0000-0000-000000000001';
select lives_ok($$ select public.restore_record_version((select v::bigint from t where k = 'audit_typo')) $$,
  'owner can restore a previous version');
select is((select title from public.maintenance_entries where id = '5f000000-0000-0000-0000-000000000001'),
  'Chaincase service', 'the previous version is back');
select ok((select count(*) from public.audit_log where record_id = '5f000000-0000-0000-0000-000000000001')
          > (select v::int from t where k = 'audit_count'), 'the restore is itself audited');

set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ select public.restore_record_version((select v::bigint from t where k = 'audit_typo')) $$,
  'P0002', null, 'mechanics cannot restore versions of other people''s records');
update public.maintenance_entries set title = 'Track chek' where id = '5f000000-0000-0000-0000-000000000002';
select lives_ok($$ select public.restore_record_version((select max(id) from public.audit_log
  where record_id = '5f000000-0000-0000-0000-000000000002' and 'title' = any (changed_fields))) $$,
  'mechanics can restore versions of their own records');

-- ---------------------------------------------------------------------------
-- Audit visibility
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_log where record_id = '5f000000-0000-0000-0000-000000000002'),
  'mechanics see the history of their own entries');
select is_empty($$ select 1 from public.audit_log where record_id = '5f000000-0000-0000-0000-000000000001' $$,
  'mechanics cannot see the history of other people''s entries');

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select ok(exists (select 1 from public.audit_log where record_id = '5f000000-0000-0000-0000-000000000001'),
  'editors see maintenance history of the shared sled');
select is_empty($$ select 1 from public.audit_log where library_owner_id is not null $$,
  'editors cannot see the owner''s library history');

set local request.jwt.claims = '{"sub":"54444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is_empty($$ select 1 from public.audit_log where sled_id = '5aaaaaaa-0000-0000-0000-000000000001' $$,
  'viewers cannot see audit history');

set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select ok(exists (select 1 from public.audit_log where library_owner_id = '51111111-1111-1111-1111-111111111111'
                  and record_id = '5b000000-0000-0000-0000-000000000001'),
  'owners see the history of their library');

-- ---------------------------------------------------------------------------
-- Deleting tasks that are in use
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"53333333-3333-3333-3333-333333333333","role":"authenticated"}';
update public.maintenance_tasks set deleted_at = now() where id = '5b000000-0000-0000-0000-000000000003';
set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
update public.maintenance_tasks set deleted_at = now() where id = '5b000000-0000-0000-0000-000000000001';

set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.maintenance_tasks where deleted_at is null
           and id in ('5b000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000003')),
  2, 'mechanics cannot delete tasks, and editors cannot delete the owner''s library tasks');
select lives_ok($$ update public.maintenance_tasks set deleted_at = now() where id = '5b000000-0000-0000-0000-000000000001' $$,
  'owner can delete a library task that is in use');
select is((select deleted_at is not null from public.maintenance_plans where id = '5d000000-0000-0000-0000-000000000001'),
  true, 'deleting a task removes its active schedules');
select is((select count(*)::int from public.maintenance_package_tasks where task_id = '5b000000-0000-0000-0000-000000000001' and deleted_at is null),
  0, 'deleting a task removes it from packages');
select is((select count(*)::int from public.maintenance_entry_tasks where task_name = 'Chaincase oil' and deleted_at is null),
  2, 'completed maintenance history is preserved');
select throws_ok($$ insert into public.maintenance_plans (sled_id, task_id, interval_days)
  values ('5aaaaaaa-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000001', 30) $$,
  '42501', null, 'a deleted task cannot be scheduled');
select lives_ok($$ update public.maintenance_tasks set deleted_at = null where id = '5b000000-0000-0000-0000-000000000001' $$,
  'owner can restore a deleted task within 30 days');
select is((select deleted_at from public.maintenance_plans where id = '5d000000-0000-0000-0000-000000000001'), null,
  'restoring the task restores the schedules deleted with it');

set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ update public.maintenance_tasks set deleted_at = now() where id = '5b000000-0000-0000-0000-000000000003' $$,
  'editors can delete a sled task');
select is((select deleted_at is not null from public.maintenance_plans where id = '5d000000-0000-0000-0000-000000000002'),
  true, 'the sled task''s schedule is removed with it');

-- ---------------------------------------------------------------------------
-- Moving the sled to Recently Deleted hides everything from shared users
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.sleds set deleted_at = now() where id = '5aaaaaaa-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"52222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.maintenance_tasks) + (select count(*)::int from public.maintenance_plans)
        + (select count(*)::int from public.maintenance_entries) + (select count(*)::int from public.sled_readings),
  0, 'shared users lose access to tasks, schedules, entries and readings of a deleted sled');

-- ---------------------------------------------------------------------------
-- Cleanup after 30 days keeps the reading; anonymous access; account deletion
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"51111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.sled_readings (id, sled_id, read_on, odometer_mi)
  values ('5e000000-0000-0000-0000-000000000009', '5aaaaaaa-0000-0000-0000-000000000002', '2026-02-01', 20);
insert into public.maintenance_entries (id, sled_id, performed_on, title, reading_id)
  values ('5f000000-0000-0000-0000-000000000004', '5aaaaaaa-0000-0000-0000-000000000002', '2026-02-01',
          'Entry whose reading gets deleted', '5e000000-0000-0000-0000-000000000009');
update public.maintenance_entries set deleted_at = now() where id = '5f000000-0000-0000-0000-000000000004';
update public.sled_readings set deleted_at = now() where id = '5e000000-0000-0000-0000-000000000009';
select throws_ok($$ update public.maintenance_entries set deleted_at = null where id = '5f000000-0000-0000-0000-000000000004' $$,
  '42501', 'Restore this entry''s reading first.',
  'an entry cannot be restored while its reading is in Recently Deleted');
update public.sled_readings set deleted_at = null where id = '5e000000-0000-0000-0000-000000000009';
select lives_ok($$ update public.maintenance_entries set deleted_at = null where id = '5f000000-0000-0000-0000-000000000004' $$,
  'after restoring the reading, the entry can be restored');

insert into public.maintenance_entries (id, sled_id, performed_on, title, reading_id)
  values ('5f000000-0000-0000-0000-000000000003', '5aaaaaaa-0000-0000-0000-000000000002', '2026-01-01',
          'Old entry', '5e000000-0000-0000-0000-000000000008');
update public.maintenance_entries set deleted_at = now() where id = '5f000000-0000-0000-0000-000000000003';

reset role;
set local request.jwt.claims = '';
alter table public.maintenance_entries disable trigger guard;
update public.maintenance_entries set deleted_at = now() - interval '31 days' where id = '5f000000-0000-0000-0000-000000000003';
alter table public.maintenance_entries enable trigger guard;
select is((private.purge_expired_records() ->> 'entries')::int, 1, 'cleanup removes entries past 30 days');
select is((select count(*)::int from public.sled_readings where id = '5e000000-0000-0000-0000-000000000008'), 1,
  'cleanup keeps the entry''s reading');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select 1 from public.sled_reading_history $$, '42501', null, 'anonymous users cannot read mileage history');
select throws_ok($$ select public.restore_record_version(1) $$, '42501', null, 'anonymous users cannot restore versions');

reset role;
set local request.jwt.claims = '';
delete from auth.users where id = '51111111-1111-1111-1111-111111111111';
select is((select count(*)::int from public.maintenance_tasks where owner_id = '51111111-1111-1111-1111-111111111111')
        + (select count(*)::int from public.maintenance_packages)
        + (select count(*)::int from public.sled_readings)
        + (select count(*)::int from public.maintenance_entries)
        + (select count(*)::int from public.maintenance_plans)
        + (select count(*)::int from public.audit_log where library_owner_id = '51111111-1111-1111-1111-111111111111'),
  0, 'deleting an account removes their library, logbook and history');

select * from finish();
rollback;
