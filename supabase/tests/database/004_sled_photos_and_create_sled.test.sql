-- Tests for migration 20261117150000_sled_photos_and_create_sled:
-- create_sled(), sleds.photo_path, the private sled-photos bucket and its
-- storage policies, plus the reading corrections Phase 2 relies on.
-- Run with: npx supabase test db   (requires the local Supabase stack)
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(64);

-- ---------------------------------------------------------------------------
-- Fixtures: Olive (owner), Eli (editor), Max (mechanic), Val (viewer),
-- Xena (unrelated). Sled 1 is created with create_sled and shared with Eli,
-- Max and Val.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('61111111-1111-1111-1111-111111111111', 'olive3@example.com', now()),
  ('62222222-2222-2222-2222-222222222222', 'eli3@example.com',   now()),
  ('63333333-3333-3333-3333-333333333333', 'max3@example.com',   now()),
  ('64444444-4444-4444-4444-444444444444', 'val3@example.com',   now()),
  ('65555555-5555-5555-5555-555555555555', 'xena3@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
insert into t select 'garage_olive', id::text from public.garages
  where owner_id = '61111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_column('public', 'sleds', 'photo_path', 'sleds has photo_path');
select has_function('public', 'create_sled',
  array['text', 'text', 'integer', 'numeric', 'numeric', 'text', 'text', 'date', 'uuid'], 'create_sled exists');
select is((select prosecdef from pg_proc where oid = 'public.create_sled(text,text,integer,numeric,numeric,text,text,date,uuid)'::regprocedure),
  false, 'create_sled runs as the caller (SECURITY INVOKER), so RLS applies');
select ok(not has_function_privilege('anon', 'public.create_sled(text,text,integer,numeric,numeric,text,text,date,uuid)', 'execute'),
  'anonymous users cannot call create_sled');
select ok(has_function_privilege('authenticated', 'public.create_sled(text,text,integer,numeric,numeric,text,text,date,uuid)', 'execute'),
  'signed-in users can call create_sled');
select ok(not has_function_privilege('anon', 'private.photo_sled_id(text)', 'execute'),
  'anonymous users cannot call photo_sled_id');
select is((select public from storage.buckets where id = 'sled-photos'), false, 'the sled-photos bucket is private');
select is((select file_size_limit from storage.buckets where id = 'sled-photos'), 5242880::bigint, 'photos are limited to 5 MB');
select is((select allowed_mime_types from storage.buckets where id = 'sled-photos'), array['image/jpeg', 'image/webp'],
  'only JPEG and WebP photos are accepted');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
             and policyname like 'SledWerx:%' and roles = '{authenticated}'), 4,
  'four sled-photo policies, for signed-in users only');
select is_empty($$ select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'SledWerx:%'
  and coalesce(qual, '') || coalesce(with_check, '') not like '%has_sled_permission(private.photo_sled_id(name)%' $$,
  'every sled-photo policy checks the existing sled permissions');
select is(private.photo_sled_id('6aaaaaaa-0000-0000-0000-000000000001/0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00.jpg'),
  '6aaaaaaa-0000-0000-0000-000000000001'::uuid, 'photo_sled_id reads the sled id from a photo path');
select ok(private.photo_sled_id('6aaaaaaa-0000-0000-0000-000000000001/../x.jpg') is null
          and private.photo_sled_id('notes.txt') is null
          and private.photo_sled_id('6aaaaaaa-0000-0000-0000-000000000001/0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00.png') is null,
  'photo_sled_id rejects other names, so they match no policy');

-- ---------------------------------------------------------------------------
-- create_sled
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into t select 'sled1', public.create_sled(' Polaris ', ' RMK Khaos ', 2024, 1234.5, 51.2, ' Blue ', ' 4XASKR123 ', current_date - 1)::text;
select is((select format('%s|%s|%s|%s|%s|%s', make, model, model_year, nickname, vin, garage_id = (select v::uuid from t where k = 'garage_olive'))
           from public.sleds where id = (select v::uuid from t where k = 'sled1')),
  'Polaris|RMK Khaos|2024|Blue|4XASKR123|t', 'create_sled adds the sled to the caller''s garage, trimmed');
select is((select format('%s|%s|%s', odometer_mi, engine_hours, read_on = current_date - 1)
           from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled1')),
  '1234.5|51.2|t', 'create_sled records the first reading');
select is((select owner_id from public.sleds where id = (select v::uuid from t where k = 'sled1')),
  '61111111-1111-1111-1111-111111111111'::uuid, 'the caller owns the new sled');

insert into t select 'sled2', public.create_sled('Ski-Doo', 'Summit', 2019, 0)::text;
select is((select format('%s|%s|%s|%s', odometer_mi, engine_hours is null, read_on = current_date,
                         (select nickname is null and vin is null from public.sleds where id = r.sled_id))
           from public.sled_readings r where sled_id = (select v::uuid from t where k = 'sled2')),
  '0.0|t|t|t', 'zero miles is allowed; hours, nickname and VIN are optional; the date defaults to today');

reset role;
select is((select count(*)::int from public.audit_log
           where sled_id = (select v::uuid from t where k = 'sled1') and action = 'insert'
             and table_name in ('sleds', 'sled_readings')), 2,
  'creating a sled is audited (sled and reading)');
insert into t select 'sled_count', count(*)::text from public.sleds;
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$ select public.create_sled('Polaris', 'RMK', 2024, -5) $$, '23514', null,
  'an invalid reading is rejected');
select throws_ok($$ select public.create_sled('Polaris', 'RMK', 1800, 10) $$, '23514', null,
  'an invalid sled is rejected');
select throws_ok($$ select public.create_sled('Polaris', 'RMK', 2024, null) $$, '23502',
  'Enter the current odometer reading.', 'the odometer reading is required');
select throws_ok($$ select public.create_sled('Polaris', 'RMK', 2024, 10, null, null, null, current_date + 5) $$, '22023',
  'The reading date cannot be in the future.', 'future reading dates are rejected');
select throws_ok($$ select public.create_sled('', 'RMK', 2024, 10) $$, '23514', null, 'a blank make is rejected');

reset role;
select is((select count(*)::text from public.sleds), (select v from t where k = 'sled_count'),
  'failed calls leave no partial sled behind (atomic)');
select is((select count(*)::int from public.sled_readings r
           where not exists (select 1 from public.sleds s where s.id = r.sled_id)), 0, 'and no orphan readings');

set local role authenticated;
set local request.jwt.claims = '{"sub":"65555555-5555-5555-5555-555555555555","role":"authenticated"}';
select throws_ok(format($$ select public.create_sled('Polaris', 'RMK', 2024, 10, null, null, null, null, %L) $$,
                        (select v from t where k = 'garage_olive')),
  '23503', 'Garage not found.', 'nobody can add a sled to someone else''s garage');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.create_sled('Polaris', 'RMK', 2024, 10) $$, '42501', null,
  'anonymous users cannot create sleds');

-- Sharing for the permission checks below.
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'tok_eli', token from public.create_sled_invitation((select v::uuid from t where k = 'sled1'), 'eli3@example.com', 'editor');
insert into t select 'tok_max', token from public.create_sled_invitation((select v::uuid from t where k = 'sled1'), 'max3@example.com', 'mechanic');
insert into t select 'tok_val', token from public.create_sled_invitation((select v::uuid from t where k = 'sled1'), 'val3@example.com', 'viewer');
set local request.jwt.claims = '{"sub":"62222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_eli')) $$, 'eli joins sled 1');
set local request.jwt.claims = '{"sub":"63333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_max')) $$, 'max joins sled 1');
set local request.jwt.claims = '{"sub":"64444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_val')) $$, 'val joins sled 1');

-- ---------------------------------------------------------------------------
-- photo_path
-- ---------------------------------------------------------------------------
reset role;
insert into t values
  ('photo1', (select v from t where k = 'sled1') || '/0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00.jpg'),
  ('photo1b', (select v from t where k = 'sled1') || '/1c7d4d2f-2a8f-4a73-8b66-4d8c3a0e2f11.webp'),
  ('photo_wrong_sled', (select v from t where k = 'sled2') || '/0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00.jpg');
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok(format($$ update public.sleds set photo_path = %L where id = %L $$,
                       (select v from t where k = 'photo1'), (select v from t where k = 'sled1')),
  'the owner can set a photo path');
select throws_ok(format($$ update public.sleds set photo_path = %L where id = %L $$,
                        (select v from t where k = 'photo_wrong_sled'), (select v from t where k = 'sled1')),
  '23514', null, 'a sled cannot point at another sled''s photo');
select throws_ok(format($$ update public.sleds set photo_path = 'https://evil.example/x.jpg' where id = %L $$,
                        (select v from t where k = 'sled1')),
  '23514', null, 'photo paths must be bucket paths, not URLs');

set local request.jwt.claims = '{"sub":"62222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok(format($$ update public.sleds set photo_path = %L where id = %L $$,
                       (select v from t where k = 'photo1b'), (select v from t where k = 'sled1')),
  'an editor can change the photo');

set local request.jwt.claims = '{"sub":"64444444-4444-4444-4444-444444444444","role":"authenticated"}';
update public.sleds set photo_path = null where id = (select v::uuid from t where k = 'sled1');
set local request.jwt.claims = '{"sub":"63333333-3333-3333-3333-333333333333","role":"authenticated"}';
update public.sleds set photo_path = null where id = (select v::uuid from t where k = 'sled1');
reset role;
select is((select photo_path from public.sleds where id = (select v::uuid from t where k = 'sled1')),
  (select v from t where k = 'photo1b'), 'viewers and mechanics cannot change the photo');
select ok(exists (select 1 from public.audit_log where table_name = 'sleds'
                  and record_id = (select v::uuid from t where k = 'sled1')
                  and 'photo_path' = any (changed_fields)), 'photo changes are audited');

-- ---------------------------------------------------------------------------
-- Storage policies (rows in storage.objects, as each user)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                       (select v from t where k = 'photo1')),
  'the owner can upload a photo for their sled');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                        (select v from t where k = 'sled1') || '/notes.txt'),
  '42501', null, 'uploads must use the photo path format');

set local request.jwt.claims = '{"sub":"62222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                       (select v from t where k = 'photo1b')),
  'an editor can upload a photo for a shared sled');

set local request.jwt.claims = '{"sub":"63333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                        (select v from t where k = 'sled1') || '/2d8e5e30-3b90-4b84-9c77-5e9d4b1f3022.jpg'),
  '42501', null, 'a mechanic cannot upload photos');
select is((select count(*)::int from storage.objects where bucket_id = 'sled-photos'
           and name like (select v from t where k = 'sled1') || '/%'), 2, 'a mechanic can view the sled''s photos');

set local request.jwt.claims = '{"sub":"64444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                        (select v from t where k = 'sled1') || '/2d8e5e30-3b90-4b84-9c77-5e9d4b1f3022.jpg'),
  '42501', null, 'a viewer cannot upload photos');
select is((select count(*)::int from storage.objects where bucket_id = 'sled-photos'
           and name like (select v from t where k = 'sled1') || '/%'), 2, 'a viewer can view the sled''s photos');
select is_empty(format($$ update storage.objects set metadata = '{}' where name = %L returning 1 $$, (select v from t where k = 'photo1')),
  'a viewer cannot replace a photo');
select is_empty(format($$ delete from storage.objects where name = %L returning 1 $$, (select v from t where k = 'photo1')),
  'a viewer cannot delete a photo');

set local request.jwt.claims = '{"sub":"65555555-5555-5555-5555-555555555555","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'sled-photos'), 0,
  'someone the sled is not shared with cannot see its photos');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                        (select v from t where k = 'sled1') || '/2d8e5e30-3b90-4b84-9c77-5e9d4b1f3022.jpg'),
  '42501', null, 'or upload to it');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select is((select count(*)::int from storage.objects where bucket_id = 'sled-photos'), 0,
  'anonymous users cannot see any photo');

-- Revoking a share removes photo access.
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.revoke_sled_share((select id from public.sled_shares
  where sled_id = (select v::uuid from t where k = 'sled1') and user_id = '64444444-4444-4444-4444-444444444444')) $$,
  'the owner revokes the viewer''s access');
set local request.jwt.claims = '{"sub":"64444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'sled-photos'), 0,
  'a revoked viewer can no longer see the photos');

-- ---------------------------------------------------------------------------
-- Reading corrections ("Update mileage" and "Fix last reading")
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'reading1', id::text from public.sled_readings where sled_id = (select v::uuid from t where k = 'sled1');
select lives_ok(format($$ update public.sled_readings set odometer_mi = 1243.5, version = 1 where id = %L $$,
                       (select v from t where k = 'reading1')),
  'the owner can correct the last reading');
reset role;
select is((select old_data ->> 'odometer_mi' from public.audit_log
           where table_name = 'sled_readings' and record_id = (select v::uuid from t where k = 'reading1') and action = 'update'
           order by id desc limit 1),
  '1234.5', 'the correction keeps the previous value in the audit history');
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok(format($$ update public.sled_readings set odometer_mi = 1300, version = 1 where id = %L $$,
                        (select v from t where k = 'reading1')),
  'PT409', null, 'a stale correction is refused (changed elsewhere)');

select throws_ok(format($$ insert into public.sled_readings (sled_id, read_on, odometer_mi) values (%L, current_date, 100) $$,
                        (select v from t where k = 'sled1')),
  '23514', null, 'mileage cannot go down');
select lives_ok(format($$ insert into public.sled_readings (sled_id, read_on, odometer_mi, odometer_reset) values (%L, current_date, 100, true) $$,
                       (select v from t where k = 'sled1')),
  'unless the odometer was replaced or reset');
select is((select total_mi from public.sled_reading_history
           where sled_id = (select v::uuid from t where k = 'sled1') order by read_on desc, created_at desc limit 1),
  1243.5::numeric, 'the replacement meter''s first reading continues from the previous total');

set local request.jwt.claims = '{"sub":"63333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is_empty(format($$ update public.sled_readings set engine_hours = 99 where id = %L returning 1 $$,
                       (select v from t where k = 'reading1')),
  'a mechanic cannot correct someone else''s reading');
select lives_ok(format($$ with x as (
                            insert into public.sled_readings (sled_id, read_on, odometer_mi) values (%L, current_date, 1500) returning id)
                          insert into t select 'reading_max', id::text from x $$,
                       (select v from t where k = 'sled1')),
  'a mechanic can add a reading');
select lives_ok(format($$ update public.sled_readings set odometer_mi = 1600, version = 1 where id = %L $$,
                       (select v from t where k = 'reading_max')),
  'and correct their own reading');
select throws_ok(format($$ update public.sled_readings set deleted_at = now(), version = 2 where id = %L $$,
                        (select v from t where k = 'reading_max')),
  '42501', null, 'but not remove it (owners and editors only)');

set local request.jwt.claims = '{"sub":"65555555-5555-5555-5555-555555555555","role":"authenticated"}';
select throws_ok(format($$ insert into public.sled_readings (sled_id, read_on, odometer_mi) values (%L, current_date, 2000) $$,
                        (select v from t where k = 'sled1')),
  '42501', null, 'someone the sled is not shared with cannot add readings');

set local request.jwt.claims = '{"sub":"62222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok(format($$ update public.sled_readings set deleted_at = now(), version = 2 where id = %L $$,
                       (select v from t where k = 'reading_max')),
  'an editor can remove the last reading');
reset role;
select ok((select deleted_at is not null from public.sled_readings where id = (select v::uuid from t where k = 'reading_max'))
          and exists (select 1 from public.audit_log where record_id = (select v::uuid from t where k = 'reading_max') and action = 'update'),
  'a removed reading is kept (soft delete) and the removal is audited');

-- A sled in Recently Deleted is read-only, photos included.
set local role authenticated;
set local request.jwt.claims = '{"sub":"61111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.sleds set deleted_at = now() where id = (select v::uuid from t where k = 'sled2');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('sled-photos', %L, auth.uid()::text) $$,
                        (select v from t where k = 'photo_wrong_sled')),
  '42501', null, 'photos cannot be uploaded to a deleted sled');

select * from finish();
rollback;
