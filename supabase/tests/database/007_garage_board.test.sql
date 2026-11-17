-- Garage Board (Phase 5). No migration: the Garage Board reads the
-- maintenance_board view (Migration 5) for several sleds at once and keeps its
-- layout in user_preferences.garage_mode (Migration 1). These tests check that
-- a multi-sled read returns exactly the sleds each user may see, that a
-- completion by a mechanic on a shared sled updates that sled's board, and that
-- the layout preference stays private.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email, email_confirmed_at) values
  ('b1111111-1111-1111-1111-111111111111', 'gb-owner@example.com',  now()),
  ('b2222222-2222-2222-2222-222222222222', 'gb-friend@example.com', now()),
  ('b3333333-3333-3333-3333-333333333333', 'gb-mech@example.com',   now()),
  ('b4444444-4444-4444-4444-444444444444', 'gb-view@example.com',   now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

-- The owner: two sleds, each with one task on its board.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'sled_a', public.create_sled('Polaris', 'RMK', 2022, 2000)::text;
insert into t select 'sled_b', public.create_sled('Ski-Doo', 'Summit', 2023, 500)::text;
with x as (insert into public.maintenance_tasks (name) values ('Oil') returning id) insert into t select 'task_oil', id::text from x;
insert into public.maintenance_plans (sled_id, task_id, interval_mi, last_done_mi)
values ((select v::uuid from t where k = 'sled_a'), (select v::uuid from t where k = 'task_oil'), 1000, 900),
       ((select v::uuid from t where k = 'sled_b'), (select v::uuid from t where k = 'task_oil'), 1000, 400);

-- A friend's own sled, shared with nobody.
set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';
insert into t select 'sled_f', public.create_sled('Lynx', 'Rave', 2020, 100)::text;
with x as (insert into public.maintenance_tasks (name) values ('Friend task') returning id) insert into t select 'task_f', id::text from x;
insert into public.maintenance_plans (sled_id, task_id, interval_days)
values ((select v::uuid from t where k = 'sled_f'), (select v::uuid from t where k = 'task_f'), 30);

-- Sled A is shared with a mechanic and a viewer; sled B with nobody.
set local request.jwt.claims = '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'tok_mech', token from public.create_sled_invitation((select v::uuid from t where k = 'sled_a'), 'gb-mech@example.com', 'mechanic');
insert into t select 'tok_view', token from public.create_sled_invitation((select v::uuid from t where k = 'sled_a'), 'gb-view@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"b3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select public.accept_sled_invitation((select v from t where k = 'tok_mech'));
set local request.jwt.claims = '{"sub":"b4444444-4444-4444-4444-444444444444","role":"authenticated"}';
select public.accept_sled_invitation((select v from t where k = 'tok_view'));

-- One query for all sleds (as the Garage Board asks: sled_id in (...)),
-- including ids the user can't see: RLS returns only the visible ones.
create function pg_temp.board_sleds() returns text
language sql stable as $$
  select coalesce(string_agg(k, ',' order by k), '')
  from public.maintenance_board b join t on t.v = b.sled_id::text
  where b.sled_id in (select v::uuid from t where k like 'sled_%');
$$;
grant execute on function pg_temp.board_sleds() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Multi-sled board reads follow sharing
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(pg_temp.board_sleds(), 'sled_a,sled_b', 'the owner sees both of their sleds, and not the friend''s');
select is((select string_agg(status, ',' order by sled_id = (select v::uuid from t where k = 'sled_a') desc)
           from public.maintenance_board where sled_id in (select v::uuid from t where k in ('sled_a', 'sled_b'))),
  'overdue,good', 'each sled has its own status from the same calculation');

set local request.jwt.claims = '{"sub":"b3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is(pg_temp.board_sleds(), 'sled_a', 'a mechanic sees only the sled shared with them');
set local request.jwt.claims = '{"sub":"b4444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is(pg_temp.board_sleds(), 'sled_a', 'a viewer sees only the sled shared with them');
set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is(pg_temp.board_sleds(), 'sled_f', 'someone else sees only their own sled');

-- ---------------------------------------------------------------------------
-- Completing from the Garage Board is an ordinary service record
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"b4444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled_a'),
    current_date, 'Oil', p_tasks => jsonb_build_array(jsonb_build_object('task_id', (select v from t where k = 'task_oil'), 'task_name', 'Oil'))) $$,
  '42501', null, 'a viewer cannot mark a task done');

set local request.jwt.claims = '{"sub":"b3333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.save_maintenance_entry(gen_random_uuid(), (select v::uuid from t where k = 'sled_a'),
    current_date, 'Oil', p_reading => '{"odometer_mi": 2000}'::jsonb,
    p_tasks => jsonb_build_array(jsonb_build_object('task_id', (select v from t where k = 'task_oil'), 'task_name', 'Oil'))) $$,
  'a mechanic marks Oil done on the shared sled');
select is((select status from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled_a')),
  'good', 'the shared sled''s board updates for the mechanic');

set local request.jwt.claims = '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select format('%s|%s', status, last_done_source) from public.maintenance_board
           where sled_id = (select v::uuid from t where k = 'sled_a')),
  'good|service', 'and for the owner: one record, one board, no copy');
select is((select status from public.maintenance_board where sled_id = (select v::uuid from t where k = 'sled_b')),
  'good', 'the other sled with the same library task is not affected');
select is((select count(*)::int from public.maintenance_entries where sled_id = (select v::uuid from t where k = 'sled_a')),
  1, 'exactly one service record was created');

-- ---------------------------------------------------------------------------
-- Layout preference (user_preferences.garage_mode)
-- ---------------------------------------------------------------------------
select lives_ok($$ update public.user_preferences set garage_mode = garage_mode || '{"layout": "compact"}'::jsonb
                   where id = 'b1111111-1111-1111-1111-111111111111' $$, 'a user saves their Garage Board layout');
select is((select garage_mode ->> 'layout' from public.user_preferences), 'compact', 'and reads it back');

set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.user_preferences where id = 'b1111111-1111-1111-1111-111111111111'), 0,
  'another user cannot see it');
update public.user_preferences set garage_mode = '{"layout": "cards"}'::jsonb where id = 'b1111111-1111-1111-1111-111111111111';
reset role;
select is((select garage_mode ->> 'layout' from public.user_preferences where id = 'b1111111-1111-1111-1111-111111111111'),
  'compact', 'or change it');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select 1 from public.user_preferences $$, '42501', null, 'anonymous users cannot read preferences');

select * from finish();
rollback;
