-- Tests for migration 20261124090000_suspension_measurement_photos: up to 2
-- photos per measurement per configuration, shared files with independent
-- rows, carry-forward on save, never a new configuration.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(49);

insert into auth.users (id, email, email_confirmed_at) values
  ('d1111111-1111-1111-1111-111111111111', 'mp-owner@example.com', now()),
  ('d2222222-2222-2222-2222-222222222222', 'mp-mech@example.com',  now()),
  ('d3333333-3333-3333-3333-333333333333', 'mp-view@example.com',  now()),
  ('d4444444-4444-4444-4444-444444444444', 'mp-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
-- A file path in the sled's folder under a configuration.
create function pg_temp.path(p_rev text) returns text language sql volatile as $$
  select pg_temp.v('sled') || '/' || pg_temp.v(p_rev) || '/' || gen_random_uuid() || '.jpg';
$$;
grant execute on function pg_temp.path(text) to authenticated, anon;
create function pg_temp.add(p_rev text, p_setting text, p_path text) returns jsonb language sql volatile as $$
  select public.add_suspension_measurement_photo(pg_temp.v(p_rev)::uuid, pg_temp.v(p_setting)::uuid, p_path);
$$;
grant execute on function pg_temp.add(text, text, text) to authenticated, anon;
create function pg_temp.photos(p_rev text, p_setting text) returns text language sql stable as $$
  select coalesce(string_agg(slot || ':' || path, ',' order by slot), '')
  from public.sled_measurement_photos where revision_id = pg_temp.v(p_rev)::uuid and setting_id = pg_temp.v(p_setting)::uuid and deleted_at is null;
$$;
grant execute on function pg_temp.photos(text, text) to authenticated, anon;
create function pg_temp.configs() returns int language sql stable as $$
  select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid;
$$;
grant execute on function pg_temp.configs() to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Lynx', 'Rave', 2024, 100)::text;
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'mp-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'mp-view@example.com', 'viewer');
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select has_table('public', 'sled_measurement_photos', 'sled_measurement_photos exists');
select is((select relrowsecurity from pg_class where oid = 'public.sled_measurement_photos'::regclass), true, 'RLS is on');
select is(has_table_privilege('authenticated', 'public.sled_measurement_photos', 'delete'), false, 'rows are never hard-deleted');
select is(has_function_privilege('anon', 'public.add_suspension_measurement_photo(uuid,uuid,text)', 'execute')
          or has_function_privilege('anon', 'public.replace_suspension_measurement_photo(uuid,integer,text)', 'execute'), false,
  'anonymous users cannot call the photo functions');
select is((select cardinality(private.cleanup_registry_problems())), 0, 'the cleanup registry is complete');
select is((select count(*)::int from private.storage_reference_columns where table_name = 'sled_measurement_photos'), 1,
  'its paths count as references for the cleanup');

-- Fixture: two settings; Trail 1 and Trail 2 (owner).
set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Ride height', 'rear_general', 'in') returning id)
insert into t select 'height', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Sag', 'rear_general', 'mm') returning id)
insert into t select 'sag', id::text from x;
insert into t select 'r1', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, null,
  jsonb_build_object(pg_temp.v('height'), '12.5'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
insert into t select 'r2', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r1')::uuid,
  jsonb_build_object(pg_temp.v('height'), '12.75'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
select is(pg_temp.configs(), 2, 'two configurations to start');

-- ---------------------------------------------------------------------------
-- Upload one, a second, reject a third (Trail 2)
-- ---------------------------------------------------------------------------
insert into t select 'p_a', pg_temp.path('r2');
insert into t select 'p_b', pg_temp.path('r2');
select is((pg_temp.add('r2', 'height', pg_temp.v('p_a')) ->> 'slot')::int, 1, 'the first photo takes slot 1');
select is((pg_temp.add('r2', 'height', pg_temp.v('p_b')) ->> 'slot')::int, 2, 'the second takes slot 2');
select is((pg_temp.add('r2', 'height', pg_temp.v('p_b')) ->> 'duplicate')::boolean, true, 'a retry with the same file is recognised');
select throws_ok($$ select pg_temp.add('r2', 'height', pg_temp.path('r2')) $$, '23514', 'At most 2 photos per measurement.',
  'a third photo is refused');
select is(pg_temp.photos('r2', 'height'), '1:' || pg_temp.v('p_a') || ',2:' || pg_temp.v('p_b'), 'two photos on Trail 2');
select is(pg_temp.photos('r2', 'sag'), '', 'other measurements are separate');

-- Photo changes never create a configuration or touch values, numbers or the active one.
select is(pg_temp.configs(), 2, 'adding photos created no configuration');
select is((select active_revision_id from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid), pg_temp.v('r2')::uuid,
  'Trail 2 is still active');
select is((select setting_values -> pg_temp.v('height') ->> 'value' from public.suspension_revisions where id = pg_temp.v('r2')::uuid),
  '12.75', 'its values are unchanged');

-- Folder and parent checks.
select throws_ok($$ select pg_temp.add('r2', 'sag', '00000000-0000-4000-8000-000000000000/' || pg_temp.v('r2') || '/' || gen_random_uuid() || '.jpg') $$,
  '23514', 'That photo is not in the right folder.', 'a file outside the sled folder is refused');
select throws_ok($$ select pg_temp.add('r2', 'sag', pg_temp.v('sled') || '/' || pg_temp.v('r2') || '/notes.txt') $$,
  '23514', null, 'a non-photo path is refused');
select throws_ok($$ update public.sled_measurement_photos set slot = 2 where path = pg_temp.v('p_a') $$,
  '42501', null, 'a photo row cannot be edited');

-- ---------------------------------------------------------------------------
-- Older configuration: adding to Trail 1 later doesn't touch Trail 2
-- ---------------------------------------------------------------------------
insert into t select 'p_old', pg_temp.path('r1');
select lives_ok($$ select pg_temp.add('r1', 'height', pg_temp.v('p_old')) $$, 'a photo can be added to an older configuration');
select is(pg_temp.photos('r1', 'height'), '1:' || pg_temp.v('p_old'), 'Trail 1 has its own photo');
select is(pg_temp.photos('r2', 'height'), '1:' || pg_temp.v('p_a') || ',2:' || pg_temp.v('p_b'), 'Trail 2 is unchanged');
select is(pg_temp.configs(), 2, 'still no new configuration');

-- ---------------------------------------------------------------------------
-- Carry-forward: Trail 3 from Trail 2 shares the files, with its own rows
-- ---------------------------------------------------------------------------
insert into t select 'r3', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r2')::uuid,
  jsonb_build_object(pg_temp.v('sag'), '35'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
select is(pg_temp.photos('r3', 'height'), pg_temp.photos('r2', 'height'), 'Trail 3 starts with Trail 2''s photos (same files)');
select is((select count(*)::int from public.sled_measurement_photos where revision_id = pg_temp.v('r3')::uuid and carried_from_id is not null), 2,
  'as new rows of its own');
select is(pg_temp.photos('r3', 'sag'), '', 'measurements without photos stay empty');

-- Replace in Trail 3: Trail 2 keeps the old file.
insert into t select 'p_c', pg_temp.path('r3');
insert into t select 'r3_slot1', (select id::text from public.sled_measurement_photos
  where revision_id = pg_temp.v('r3')::uuid and setting_id = pg_temp.v('height')::uuid and slot = 1 and deleted_at is null);
select is((public.replace_suspension_measurement_photo(pg_temp.v('r3_slot1')::uuid, 1, pg_temp.v('p_c')) ->> 'slot')::int, 1,
  'a photo is replaced in the same slot');
select is(pg_temp.photos('r3', 'height'), '1:' || pg_temp.v('p_c') || ',2:' || pg_temp.v('p_b'), 'Trail 3 shows the new photo');
select is(pg_temp.photos('r2', 'height'), '1:' || pg_temp.v('p_a') || ',2:' || pg_temp.v('p_b'), 'Trail 2 keeps the old one');
select is((select count(*)::int from public.sled_measurement_photos where path = pg_temp.v('p_a')), 2,
  'the old file is still referenced (Trail 2 active, Trail 3 in Recently Deleted)');
select throws_ok($$ select public.replace_suspension_measurement_photo(pg_temp.v('r3_slot1')::uuid, 2, pg_temp.path('r3')) $$,
  'P0002', null, 'a photo already replaced cannot be replaced again');

-- Remove in Trail 3 (Recently Deleted): Trail 2 unchanged.
select lives_ok($$ update public.sled_measurement_photos set deleted_at = now(), version = version
                   where revision_id = pg_temp.v('r3')::uuid and slot = 2 and deleted_at is null $$, 'owners remove a photo');
select is(pg_temp.photos('r3', 'height'), '1:' || pg_temp.v('p_c'), 'Trail 3 has one photo left');
select is(pg_temp.photos('r2', 'height'), '1:' || pg_temp.v('p_a') || ',2:' || pg_temp.v('p_b'), 'Trail 2 still has both');
select is((select count(*)::int from public.sled_measurement_photos where path = pg_temp.v('p_b') and deleted_at is null), 1,
  'the removed file is still used by Trail 2');
select is(pg_temp.configs(), 3, 'replacing and removing created no configuration');
select is((select active_revision_id from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid), pg_temp.v('r3')::uuid,
  'and left the active configuration alone');

-- ---------------------------------------------------------------------------
-- Roles and isolation
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select lives_ok($$ select pg_temp.add('r3', 'sag', pg_temp.path('r3')) $$, 'mechanics add photos');
select is_empty($$ update public.sled_measurement_photos set deleted_at = now() where revision_id = pg_temp.v('r3')::uuid returning 1 $$,
  'mechanics cannot remove photos');
select throws_ok($$ select public.replace_suspension_measurement_photo(
                     (select id from public.sled_measurement_photos where revision_id = pg_temp.v('r3')::uuid and setting_id = pg_temp.v('sag')::uuid and deleted_at is null), 1, pg_temp.path('r3')) $$,
  '42501', null, 'or replace them');

select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select is((select count(*)::int from public.sled_measurement_photos where revision_id = pg_temp.v('r2')::uuid), 2, 'viewers see photos');
select throws_ok($$ select pg_temp.add('r3', 'sag', pg_temp.path('r3')) $$, '42501', null, 'viewers cannot add photos');

select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select is_empty($$ select 1 from public.sled_measurement_photos where sled_id = pg_temp.v('sled')::uuid $$, 'others see nothing');
select throws_ok($$ select pg_temp.add('r3', 'sag', pg_temp.path('r3')) $$, '42501', null, 'others cannot add photos');
select is(private.has_sled_permission(private.suspension_photo_sled_id(pg_temp.v('p_a')), 'view'), false,
  'and the storage policy gives them no access to the files');
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select is(private.has_sled_permission(private.suspension_photo_sled_id(pg_temp.v('p_a')), 'view'), true,
  'while everyone on the sled can view them');

-- ---------------------------------------------------------------------------
-- A configuration deleted with its setup takes its rows along, and back.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'legacy', (public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Old') ->> 'setup_id');
insert into t select 'legacy_rev', (select id::text from public.suspension_revisions where setup_id = pg_temp.v('legacy')::uuid);
select lives_ok($$ select pg_temp.add('legacy_rev', 'height', pg_temp.path('legacy_rev')) $$, 'photo on another setup''s configuration');
update public.suspension_setups set deleted_at = now(), version = 1 where id = pg_temp.v('legacy')::uuid;
select is(pg_temp.photos('legacy_rev', 'height'), '', 'its photos go to Recently Deleted with it');
update public.suspension_setups set deleted_at = null, version = 2 where id = pg_temp.v('legacy')::uuid;
select isnt(pg_temp.photos('legacy_rev', 'height'), '', 'and come back with it');

select * from finish();
rollback;
