-- Tests for migration 20261118090000_service_records: categories, service
-- dates, save_maintenance_entry with a category, update_maintenance_entry,
-- historical (backdated) mileage, and items following their service record.
-- Run with: npx supabase test db   (requires the local Supabase stack)
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(80);

-- ---------------------------------------------------------------------------
-- Fixtures: Olive (owner), Eli (editor), Max (mechanic), Val (viewer),
-- Xena (unrelated). The sled is added today at 2,000 mi / 150 hrs.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('91111111-1111-1111-1111-111111111111', 'olive4@example.com', now()),
  ('92222222-2222-2222-2222-222222222222', 'eli4@example.com',   now()),
  ('93333333-3333-3333-3333-333333333333', 'max4@example.com',   now()),
  ('94444444-4444-4444-4444-444444444444', 'val4@example.com',   now()),
  ('95555555-5555-5555-5555-555555555555', 'xena4@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

set local role authenticated;
set local request.jwt.claims = '{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150)::text;
insert into t select 'tok_eli', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'eli4@example.com', 'editor');
insert into t select 'tok_max', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'max4@example.com', 'mechanic');
insert into t select 'tok_val', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'val4@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"92222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_eli')) $$, 'editor joins');
set local request.jwt.claims = '{"sub":"93333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_max')) $$, 'mechanic joins');
set local request.jwt.claims = '{"sub":"94444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_val')) $$, 'viewer joins');

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------
reset role;
select has_column('public', 'maintenance_entries', 'category', 'service records have a category');
select is((select count(*)::int from pg_proc where proname = 'save_maintenance_entry'), 1,
  'save_maintenance_entry has exactly one version (the old signature is gone)');
select has_function('public', 'save_maintenance_entry',
  array['uuid', 'uuid', 'date', 'text', 'text', 'text', 'numeric', 'numeric', 'boolean', 'jsonb', 'jsonb', 'jsonb', 'text'],
  'save_maintenance_entry accepts a category');
select is((select bool_or(prosecdef) from pg_proc where proname in ('save_maintenance_entry', 'update_maintenance_entry')), false,
  'both save functions run as the caller (SECURITY INVOKER), so RLS applies');
select ok(not has_function_privilege('anon', 'public.update_maintenance_entry(uuid,integer,date,text,text,text,text,numeric,numeric,jsonb,jsonb,jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.update_maintenance_entry(uuid,integer,date,text,text,text,text,numeric,numeric,jsonb,jsonb,jsonb)', 'execute'),
  'only signed-in users can call update_maintenance_entry');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') $$,
  'anonymous users still cannot execute any SledWerx function');
select is((select count(*)::int from pg_trigger
           where tgname = 'guard' and tgfoid = 'private.tg_entry_items_guard'::regproc), 2,
  'service-record items use the record-based guard');
select is((select count(*)::int from pg_trigger
           where tgname = 'guard' and tgfoid = 'private.tg_sled_record_guard'::regproc
             and tgrelid in ('public.maintenance_entries'::regclass, 'public.sled_readings'::regclass)), 2,
  'service records and readings keep Migration 1''s guard');

-- ---------------------------------------------------------------------------
-- Historical service: last season, 1,200 mi / 95 hrs, while the sled is at 2,000
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$
  insert into t select 'e1', (public.save_maintenance_entry(
    p_idempotency_key => '9c000000-0000-0000-0000-000000000001',
    p_sled_id => (select v::uuid from t where k = 'sled'),
    p_performed_on => '2025-12-05',
    p_title => 'Chaincase service',
    p_category => 'drivetrain',
    p_labor_cost => 30,
    p_reading => '{"odometer_mi": 1200, "engine_hours": 95}',
    p_tasks => '[{"task_name": "Drain and refill chaincase"}, {"task_name": "Inspect sprockets"}]',
    p_parts => '[{"name": "Chaincase oil", "part_number": "CC-1", "quantity": 2, "unit_cost": 12.5}]'
  ) ->> 'entry_id')
$$, 'the owner saves a service from last season with its mileage');
select is((select format('%s|%s|%s|%s', e.performed_on, e.category, r.odometer_mi, r.engine_hours)
           from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
           where e.id = (select v::uuid from t where k = 'e1')),
  '2025-12-05|drivetrain|1200.0|95.0', 'the historical service shows 1,200 mi and 95 hrs');
select is((select format('%s|%s', odometer_mi, engine_hours) from public.sled_reading_history
           where sled_id = (select v::uuid from t where k = 'sled') order by read_on desc, created_at desc limit 1),
  '2000.0|150.0', 'the current mileage and hours stay 2,000 mi / 150 hrs');
select is((select array_agg(total_mi::text order by read_on) from public.sled_reading_history
           where sled_id = (select v::uuid from t where k = 'sled')),
  array['1200.0', '2000.0'], 'mileage history is in date order with correct totals');

insert into t select 'entry_count', count(*)::text from public.maintenance_entries;
select throws_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), '2026-01-10', 'Out of order',
    p_reading => '{"odometer_mi": 1100}') $$,
  '23514', null, 'a backdated reading that does not fit the history is refused');
select throws_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), '2026-01-10', 'Hours out of order',
    p_reading => '{"engine_hours": 80}') $$,
  '23514', null, 'engine hours are validated the same way');
select is((select count(*)::text from public.maintenance_entries), (select v from t where k = 'entry_count'),
  'refused saves leave nothing behind');
select lives_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), '2026-01-10', 'Mileage unknown') $$,
  'a historical service can be saved without mileage');

select throws_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date, 'Bad category', p_category => 'paint') $$,
  '23514', null, 'unknown categories are refused');
select throws_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date + 2, 'Future') $$,
  '22023', 'The service date cannot be in the future.', 'future service dates are refused');
select lives_ok($$ select public.save_maintenance_entry(
    gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date + 1, 'Tomorrow UTC') $$,
  'tomorrow (UTC) is allowed for time zones ahead of the database clock');
select is((public.save_maintenance_entry(
    '9c000000-0000-0000-0000-000000000001', (select v::uuid from t where k = 'sled'), '2025-12-05', 'Retry',
    p_category => 'engine') ->> 'duplicate')::boolean, true,
  'a retried save is still recognised as a duplicate');

-- ---------------------------------------------------------------------------
-- update_maintenance_entry (owner)
-- ---------------------------------------------------------------------------
insert into t select 'e1_reading', reading_id::text from public.maintenance_entries where id = (select v::uuid from t where k = 'e1');
select lives_ok($$ select public.update_maintenance_entry(
    p_entry_id => (select v::uuid from t where k = 'e1'),
    p_version => 1,
    p_performed_on => '2025-12-06',
    p_title => 'Chaincase and chain service',
    p_category => 'drivetrain',
    p_notes => 'Used synthetic oil',
    p_labor_cost => 40,
    p_other_cost => 5,
    p_reading => '{"odometer_mi": 1250, "engine_hours": 96}',
    p_tasks => (select jsonb_agg(jsonb_build_object('id', id, 'task_name', task_name)) from public.maintenance_entry_tasks
                where entry_id = (select v::uuid from t where k = 'e1') and task_name = 'Drain and refill chaincase')
               || '[{"task_name": "Check chain tension"}]'::jsonb,
    p_parts => (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'part_number', part_number, 'quantity', 3, 'unit_cost', unit_cost))
                from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e1'))
               || '[{"name": "Gasket", "part_number": "G-1", "quantity": 1, "unit_cost": 4.25}]'::jsonb) $$,
  'the owner edits the whole record in one call');
select is((select format('%s|%s|%s|%s|%s|%s', title, performed_on, labor_cost, other_cost, version, edited_at is not null)
           from public.maintenance_entries where id = (select v::uuid from t where k = 'e1')),
  'Chaincase and chain service|2025-12-06|40.00|5.00|2|t', 'the record is updated, its version increases and it is marked edited');
select is((select format('%s|%s|%s|%s', r.id = (select v::uuid from t where k = 'e1_reading'), r.read_on, r.odometer_mi, r.engine_hours)
           from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
           where e.id = (select v::uuid from t where k = 'e1')),
  't|2025-12-06|1250.0|96.0', 'the linked reading is corrected in place and follows the service date');
select is((select count(*)::int from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled') and deleted_at is null), 2,
  'editing a service never adds stray readings');
select is((select array_agg(task_name order by position) from public.maintenance_entry_tasks
           where entry_id = (select v::uuid from t where k = 'e1') and deleted_at is null),
  array['Drain and refill chaincase', 'Check chain tension'], 'tasks are kept, added and removed as listed');
select ok((select deleted_at is not null and deleted_by = '91111111-1111-1111-1111-111111111111'
           from public.maintenance_entry_tasks where entry_id = (select v::uuid from t where k = 'e1') and task_name = 'Inspect sprockets'),
  'a removed task is soft-deleted, not erased');
select is((select format('%s|%s|%s|%s', parts_cost, labor_cost, other_cost, total_cost) from public.maintenance_entry_costs
           where entry_id = (select v::uuid from t where k = 'e1')),
  '41.7500|40.00|5.00|86.7500', 'costs recalculate: parts 3 x 12.50 + 4.25, plus labor and other');
reset role;
select is((select old_data ->> 'odometer_mi' from public.audit_log
           where table_name = 'sled_readings' and record_id = (select v::uuid from t where k = 'e1_reading') and action = 'update'),
  '1200.0', 'the mileage correction keeps the old value in the audit history');
select ok((select count(*) >= 4 from public.audit_log
           where sled_id = (select v::uuid from t where k = 'sled') and action = 'update'
             and table_name in ('maintenance_entries', 'maintenance_entry_tasks', 'maintenance_entry_parts', 'sled_readings')),
  'every changed row is audited');
set local role authenticated;
set local request.jwt.claims = '{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 1, '2025-12-06', 'Stale') $$,
  'PT409', null, 'a stale version is refused (changed elsewhere)');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 2, '2025-12-06', 'Too far',
    p_reading => '{"odometer_mi": 2500}') $$,
  '23514', null, 'a mileage correction that breaks the history is refused');
select is((select title from public.maintenance_entries where id = (select v::uuid from t where k = 'e1')),
  'Chaincase and chain service', 'a refused edit changes nothing (atomic)');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 2, current_date + 3, 'Future',
    p_reading => '{"odometer_mi": 1250}') $$,
  '22023', null, 'an edit cannot move a service into the future');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 2, '2025-12-06', 'Wrong item',
    p_parts => '[{"id": "9f000000-0000-0000-0000-000000000000", "name": "x"}]') $$,
  '22023', null, 'items from other records cannot be edited through this record');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 2, '2025-12-06', 'Bad',
    p_category => 'paint') $$,
  '23514', null, 'edits are checked against the category list');

-- Removing and re-adding the mileage (owners and editors).
select lives_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 2, '2025-12-06', 'No mileage', p_category => 'drivetrain', p_reading => null,
    p_tasks => (select jsonb_agg(jsonb_build_object('id', id, 'task_name', task_name)) from public.maintenance_entry_tasks
                where entry_id = (select v::uuid from t where k = 'e1') and deleted_at is null),
    p_parts => (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'quantity', quantity, 'unit_cost', unit_cost))
                from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e1') and deleted_at is null)) $$,
  'the owner can remove the mileage from a record');
select ok((select reading_id is null from public.maintenance_entries where id = (select v::uuid from t where k = 'e1'))
          and (select deleted_at is not null from public.sled_readings where id = (select v::uuid from t where k = 'e1_reading')),
  'the reading is unlinked and soft-deleted (kept in history)');
select is((select count(*)::int from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e1') and deleted_at is null), 2,
  'items listed again are kept');
select lives_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 3, '2025-12-06', 'Mileage back',
    p_category => 'drivetrain', p_reading => '{"odometer_mi": 1210}') $$,
  'mileage can be added to a record that had none');
select is((select format('%s|%s', r.read_on, r.odometer_mi) from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
           where e.id = (select v::uuid from t where k = 'e1')),
  '2025-12-06|1210.0', 'a new reading is added on the service date and linked');
select is((select count(*)::int from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e1') and deleted_at is null), 0,
  'an empty item list removes all items');

-- ---------------------------------------------------------------------------
-- Mechanic: their own records
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"93333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$
  insert into t select 'e2', (public.save_maintenance_entry(
    p_idempotency_key => '9c000000-0000-0000-0000-000000000002',
    p_sled_id => (select v::uuid from t where k = 'sled'),
    p_performed_on => '2026-02-01',
    p_title => 'Belt swap',
    p_reading => '{"odometer_mi": 1400}',
    p_tasks => '[{"task_name": "Replace belt"}, {"task_name": "Wrong task"}]',
    p_parts => '[{"name": "Drive belt", "quantity": 1, "unit_cost": 180}, {"name": "Wrong part", "quantity": 1, "unit_cost": 5}]'
  ) ->> 'entry_id')
$$, 'the mechanic logs a service');

set local request.jwt.claims = '{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ insert into public.maintenance_entry_parts (entry_id, name, quantity, unit_cost)
                   values ((select v::uuid from t where k = 'e2'), 'Added by owner', 1, 1) $$,
  'the owner adds a part to the mechanic''s record');

set local request.jwt.claims = '{"sub":"93333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'), 1, '2026-02-01', 'Belt swap',
    p_reading => '{"odometer_mi": 1450}',
    p_tasks => (select jsonb_agg(jsonb_build_object('id', id, 'task_name', task_name)) from public.maintenance_entry_tasks
                where entry_id = (select v::uuid from t where k = 'e2') and task_name = 'Replace belt')
               || '[{"task_name": "Check clutch alignment"}]'::jsonb,
    p_parts => (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'quantity', quantity,
                       'unit_cost', case when name = 'Drive belt' then 175 else unit_cost end))
                from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e2') and name <> 'Wrong part')) $$,
  'the mechanic corrects, adds and removes tasks and parts on their own record');
select is((select array_agg(name || ':' || unit_cost order by name) from public.maintenance_entry_parts
           where entry_id = (select v::uuid from t where k = 'e2') and deleted_at is null),
  array['Added by owner:1.00', 'Drive belt:175.00'], 'their part changes are saved, including a part the owner added');
select ok((select deleted_by = '93333333-3333-3333-3333-333333333333' from public.maintenance_entry_parts
           where entry_id = (select v::uuid from t where k = 'e2') and name = 'Wrong part'),
  'the removed part is soft-deleted by the mechanic');
select is((select array_agg(task_name order by position) from public.maintenance_entry_tasks
           where entry_id = (select v::uuid from t where k = 'e2') and deleted_at is null),
  array['Replace belt', 'Check clutch alignment'], 'their task changes are saved');
select is((select r.odometer_mi::text from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
           where e.id = (select v::uuid from t where k = 'e2')), '1450.0', 'the mechanic corrects the mileage on their own record');
select is((select version from public.maintenance_entries where id = (select v::uuid from t where k = 'e2')), 2,
  'an edit that changes only items and mileage still changes the record''s version');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'), 2, '2026-02-01', 'Belt swap', p_reading => null) $$,
  '42501', 'Only the owner or an editor can remove the mileage from a service record.',
  'the mechanic cannot remove the linked reading');
select ok((select reading_id is not null and version = 2 from public.maintenance_entries where id = (select v::uuid from t where k = 'e2')),
  'and nothing changed');
select throws_ok($$ update public.maintenance_entries set deleted_at = now(), version = 2 where id = (select v::uuid from t where k = 'e2') $$,
  '42501', null, 'the mechanic cannot delete their own service record');
select lives_ok($$ update public.maintenance_entry_parts set deleted_at = null,
                     version = (select version from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e2') and name = 'Wrong part')
                   where entry_id = (select v::uuid from t where k = 'e2') and name = 'Wrong part' $$,
  'the mechanic can restore an item they removed from their own record');
select lives_ok($$ update public.maintenance_entry_parts set deleted_at = now(),
                     version = (select version from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e2') and name = 'Wrong part')
                   where entry_id = (select v::uuid from t where k = 'e2') and name = 'Wrong part' $$,
  'and remove it again directly');

-- Mechanic: other people's records
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'), 4, '2025-12-06', 'Mechanic edit') $$,
  '42501', null, 'the mechanic cannot edit the owner''s record');
select is_empty($$ update public.maintenance_entry_tasks set note = 'x' where entry_id = (select v::uuid from t where k = 'e1') returning 1 $$,
  'or its items directly');
select is_empty($$ update public.maintenance_entry_tasks set deleted_at = now() where entry_id = (select v::uuid from t where k = 'e1') returning 1 $$,
  'or remove its items');

-- ---------------------------------------------------------------------------
-- Viewer, unrelated user, editor
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"94444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'), 2, '2026-02-01', 'Viewer edit') $$,
  '42501', null, 'a viewer cannot edit service records');
select is_empty($$ update public.maintenance_entry_parts set unit_cost = 0 where entry_id = (select v::uuid from t where k = 'e2') returning 1 $$,
  'or their items');

set local request.jwt.claims = '{"sub":"95555555-5555-5555-5555-555555555555","role":"authenticated"}';
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'), 2, '2026-02-01', 'Stranger') $$,
  'P0002', null, 'someone the sled is not shared with cannot even find the record');

set local request.jwt.claims = '{"sub":"92222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'), 2, '2026-02-01', 'Edited by editor', p_reading => null,
    p_tasks => '[{"task_name": "Replace belt"}]', p_parts => '[]') $$,
  'an editor can edit the mechanic''s record and remove its mileage and items');
select is((select count(*)::int from public.maintenance_entry_parts where entry_id = (select v::uuid from t where k = 'e2') and deleted_at is null), 0,
  'the editor''s removals are saved');

-- ---------------------------------------------------------------------------
-- Deleting and restoring a service record still cascades to its items
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update public.maintenance_entries set deleted_at = now(),
                     version = (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'e2'))
                   where id = (select v::uuid from t where k = 'e2') $$,
  'the owner deletes a service record');
select is((select count(*)::int from public.maintenance_entry_tasks where entry_id = (select v::uuid from t where k = 'e2') and deleted_at is null), 0,
  'its items are removed with it');
select throws_ok($$ update public.maintenance_entry_tasks set deleted_at = null,
                      version = (select version from public.maintenance_entry_tasks where entry_id = (select v::uuid from t where k = 'e2') and task_name = 'Replace belt' and created_by = '92222222-2222-2222-2222-222222222222')
                    where entry_id = (select v::uuid from t where k = 'e2') and task_name = 'Replace belt' and created_by = '92222222-2222-2222-2222-222222222222' $$,
  '42501', 'Restore the service record first.', 'an item cannot be restored while its record is deleted');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e2'),
                      (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'e2')), '2026-02-01', 'Edit deleted') $$,
  '42501', 'Restore this record before editing it.', 'a deleted record cannot be edited');
select lives_ok($$ update public.maintenance_entries set deleted_at = null,
                     version = (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'e2'))
                   where id = (select v::uuid from t where k = 'e2') $$,
  'the owner restores it');
-- (Restore matches items by their deletion time. In this single test
-- transaction every removal shares one timestamp, so only the cascaded item
-- is asserted here.)
select ok((select deleted_at is null from public.maintenance_entry_tasks
           where entry_id = (select v::uuid from t where k = 'e2') and task_name = 'Replace belt'
             and created_by = '92222222-2222-2222-2222-222222222222'),
  'its items come back with it');

-- A deleted sled is read-only.
update public.sleds set deleted_at = now() where id = (select v::uuid from t where k = 'sled');
select throws_ok($$ select public.update_maintenance_entry((select v::uuid from t where k = 'e1'),
                      (select version from public.maintenance_entries where id = (select v::uuid from t where k = 'e1')), '2025-12-06', 'Deleted sled') $$,
  '42501', null, 'records of a sled in Recently Deleted cannot be edited');
select throws_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled'), current_date, 'Deleted sled') $$,
  '42501', null, 'or added');

-- ---------------------------------------------------------------------------
-- Anonymous users
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.update_maintenance_entry('9f000000-0000-0000-0000-000000000001', 1, current_date, 'x') $$,
  '42501', null, 'anonymous users cannot call update_maintenance_entry');
select throws_ok($$ select public.save_maintenance_entry(gen_random_uuid(), '9f000000-0000-0000-0000-000000000001', current_date, 'x') $$,
  '42501', null, 'or save_maintenance_entry');

reset role;
select is((select count(*)::int from public.maintenance_entries where category is not null), 1,
  'only the categorised record has a category');
select is((select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'maintenance_entries'
           and column_name in ('description')), 0, 'no separate description column (notes covers it)');
select is((select count(*)::int from pg_policies where tablename in ('maintenance_entry_tasks', 'maintenance_entry_parts')
           and cmd in ('UPDATE', 'SELECT') and qual like '%entry_created_by(entry_id)%'), 4,
  'item edit and view policies are based on the record''s creator');
select is((select count(*)::int from pg_policies where tablename in ('maintenance_entry_tasks', 'maintenance_entry_parts')), 6,
  'item tables still have exactly their view, add and edit policies');
select is((select count(*)::int from pg_policies where tablename = 'maintenance_entries'), 3,
  'service record policies are unchanged');

select * from finish();
rollback;
