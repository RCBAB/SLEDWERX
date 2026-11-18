-- Update Mileage / Hours (Phase 5.1). No migration: these tests pin down the
-- existing reading rules (Migrations 1-3) that the new dialog relies on, so a
-- normal update can never lower a meter, each meter is checked on its own, a
-- reset is the only way to start lower, history is kept, and permissions hold.
-- Everything runs in one transaction that is rolled back. Readings in one
-- transaction share a timestamp, so each reading here gets its own date.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(20);

insert into auth.users (id, email, email_confirmed_at) values
  ('c1111111-1111-1111-1111-111111111111', 'mu-owner@example.com', now()),
  ('c2222222-2222-2222-2222-222222222222', 'mu-mech@example.com',  now()),
  ('c3333333-3333-3333-3333-333333333333', 'mu-view@example.com',  now()),
  ('c4444444-4444-4444-4444-444444444444', 'mu-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

-- The newest odometer and the newest hours, each from the newest reading that has one.
create function pg_temp.current_meters() returns text
language sql stable as $$
  select format('%s|%s',
    (select odometer_mi from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled')
       and deleted_at is null and odometer_mi is not null order by read_on desc, created_at desc, id desc limit 1),
    (select engine_hours from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled')
       and deleted_at is null and engine_hours is not null order by read_on desc, created_at desc, id desc limit 1));
$$;
grant execute on function pg_temp.current_meters() to authenticated, anon;

create function pg_temp.add(p_on date, p_mi numeric, p_hrs numeric, p_mi_reset boolean default false, p_hrs_reset boolean default false)
returns void language sql as $$
  insert into public.sled_readings (sled_id, read_on, odometer_mi, engine_hours, odometer_reset, hour_meter_reset)
  values ((select v::uuid from t where k = 'sled'), p_on, p_mi, p_hrs, p_mi_reset, p_hrs_reset);
$$;
grant execute on function pg_temp.add(date, numeric, numeric, boolean, boolean) to authenticated, anon;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150, p_read_on => current_date - 10)::text;
insert into t select 'tok_mech', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'mu-mech@example.com', 'mechanic');
insert into t select 'tok_view', token from public.create_sled_invitation((select v::uuid from t where k = 'sled'), 'mu-view@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"c2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select public.accept_sled_invitation((select v from t where k = 'tok_mech'));
set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select public.accept_sled_invitation((select v from t where k = 'tok_view'));

-- Maintenance history that must not change: a service with its own reading.
set local request.jwt.claims = '{"sub":"c1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'entry', (public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled'),
  current_date - 5, 'Oil change', p_reading => '{"odometer_mi": 2050, "engine_hours": 155}'::jsonb) ->> 'id');
insert into t select 'entry_fp', (select format('%s|%s|%s', e.version, r.odometer_mi, r.engine_hours)
  from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
  where e.id = (select v::uuid from t where k = 'entry'));

-- ---------------------------------------------------------------------------
-- Normal updates
-- ---------------------------------------------------------------------------
select is(pg_temp.current_meters(), '2050.0|155.0', 'starting point: the service reading is the newest');
select lives_ok($$ select pg_temp.add(current_date - 4, 2050, null) $$, 'the same mileage again is allowed (unchanged)');
select lives_ok($$ select pg_temp.add(current_date - 3, null, 160) $$, 'hours alone can be updated');
select is(pg_temp.current_meters(), '2050.0|160.0', 'an hours-only reading leaves the mileage as it was');
select lives_ok($$ select pg_temp.add(current_date - 2, 2100, null) $$, 'mileage alone can be updated');
select is(pg_temp.current_meters(), '2100.0|160.0', 'a mileage-only reading leaves the hours as they were');

-- ---------------------------------------------------------------------------
-- Lower readings are refused, each meter on its own
-- ---------------------------------------------------------------------------
select throws_ok($$ select pg_temp.add(current_date - 1, 2099, null) $$, '23514',
  'Odometer readings cannot go down. If the odometer was replaced or reset, mark the reading as an odometer reset.',
  'lower mileage is refused');
select throws_ok($$ select pg_temp.add(current_date - 1, null, 159.9) $$, '23514',
  'Engine-hour readings cannot go down. If the hour meter was replaced or reset, mark the reading as an hour-meter reset.',
  'lower hours are refused');
select throws_ok($$ select pg_temp.add(current_date - 1, 2200, 100) $$, '23514', null,
  'higher mileage does not excuse lower hours in the same reading');
select throws_ok($$ select pg_temp.add(current_date - 6, 2500, null) $$, '23514', null,
  'a backdated reading higher than a later one is refused (history order)');
select lives_ok($$ select pg_temp.add(current_date - 7, 2010, null) $$, 'a backdated reading that fits the history is kept');
select is(pg_temp.current_meters(), '2100.0|160.0', 'and does not change the current readings');

set local request.jwt.claims = '{"sub":"c2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok($$ select pg_temp.add(current_date, 1000, null) $$, '23514', null, 'a mechanic is refused a lower reading too');
select lives_ok($$ select pg_temp.add(current_date, 2150, 165) $$, 'a mechanic can update mileage and hours');

-- ---------------------------------------------------------------------------
-- Resets: the only way to start lower; history is kept
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c1111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ select pg_temp.add(current_date + 1, 5, null, true) $$, 'a reading marked as an odometer reset may be lower');
select is((select format('%s|%s', odometer_mi, total_mi) from public.sled_reading_history
           where sled_id = (select v::uuid from t where k = 'sled') order by read_on desc, created_at desc limit 1),
  '5.0|2150.0', 'lifetime miles carry on from the old odometer (the new meter starts from there)');
select is((select count(*)::int from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled') and deleted_at is null),
  8, 'every earlier reading is kept');
select is((select format('%s|%s|%s', e.version, r.odometer_mi, r.engine_hours)
           from public.maintenance_entries e join public.sled_readings r on r.id = e.reading_id
           where e.id = (select v::uuid from t where k = 'entry')),
  (select v from t where k = 'entry_fp'), 'service records and their readings are unchanged');

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ select pg_temp.add(current_date, 3000, null) $$, '42501', null, 'a viewer cannot add a reading');
set local request.jwt.claims = '{"sub":"c4444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ select pg_temp.add(current_date, 3000, null) $$, '42501', null, 'someone it is not shared with cannot add a reading');

select * from finish();
rollback;
