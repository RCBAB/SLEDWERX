-- Tests for migration 20261121090000_suspension_tuning (Phase 6.2): suspension
-- settings, setups, revisions, feedback, photos, their bucket and functions.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(101);

insert into auth.users (id, email, email_confirmed_at) values
  ('f1111111-1111-1111-1111-111111111111', 'sus-owner@example.com',  now()),
  ('f2222222-2222-2222-2222-222222222222', 'sus-editor@example.com', now()),
  ('f3333333-3333-3333-3333-333333333333', 'sus-mech@example.com',   now()),
  ('f4444444-4444-4444-4444-444444444444', 'sus-view@example.com',   now()),
  ('f5555555-5555-5555-5555-555555555555', 'sus-other@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
create function pg_temp.latest(p_setup text) returns uuid language sql stable as $$
  select id from public.suspension_revisions where setup_id = pg_temp.v(p_setup)::uuid order by revision_number desc limit 1;
$$;
grant execute on function pg_temp.latest(text) to authenticated, anon;
create function pg_temp.path(p_parent text) returns text language sql volatile as $$
  select pg_temp.v('sled') || '/' || p_parent || '/' || gen_random_uuid() || '.jpg';
$$;
grant execute on function pg_temp.path(text) to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150)::text;
insert into t select 'other_sled', public.create_sled('Lynx', 'Rave', 2020, 100)::text;
insert into t select 'tok_ed', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'sus-editor@example.com', 'editor');
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'sus-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'sus-view@example.com', 'viewer');
select pg_temp.as_user('f2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_ed'));
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select has_table('public', 'suspension_settings', 'suspension_settings exists');
select has_table('public', 'suspension_setups', 'suspension_setups exists');
select has_table('public', 'suspension_revisions', 'suspension_revisions exists');
select has_table('public', 'suspension_feedback', 'suspension_feedback exists');
select has_table('public', 'suspension_photos', 'suspension_photos exists');
select is((select count(*)::int from pg_class where relname like 'suspension\_%' and relkind = 'r' and relrowsecurity), 5,
  'RLS is on for all five tables');
select ok(not exists (select 1 from information_schema.role_table_grants
                      where table_name like 'suspension\_%' and grantee in ('authenticated', 'anon') and privilege_type = 'DELETE'),
  'nobody can hard-delete suspension records (Recently Deleted instead)');
select ok(not has_table_privilege('anon', 'public.suspension_setups', 'select'), 'anonymous users have no access');
select is((select format('%s|%s|%s', public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'suspension-photos'),
  'f|5242880|{image/jpeg,image/webp}', 'the suspension-photos bucket is private, 5 MB, JPEG/WebP only');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'SledWerx suspension photos:%' and roles = '{authenticated}'), 3,
  'three suspension-photo storage policies, for signed-in users only');
select is((select format('%s|%s', count(*) filter (where policyname like 'SledWerx:%'),
                                  count(*) filter (where policyname like 'SledWerx issue photos:%'))
           from pg_policies where schemaname = 'storage'), '4|3', 'sled-photo and issue-photo policies are unchanged');

-- ---------------------------------------------------------------------------
-- Settings: an empty master list per sled; owners and editors customize it
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select is((select count(*)::int from public.suspension_settings where sled_id = pg_temp.v('sled')::uuid), 0,
  'a sled starts with no suspension settings (nothing pre-filled)');
select lives_ok($$ with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
    values (pg_temp.v('sled')::uuid, 'Compression', 'front_left_shock', 'clicks') returning id)
  insert into t select 'set_lc', id::text from x $$, 'the owner adds a setting');
select pg_temp.as_user('f2222222-2222-2222-2222-222222222222');
select lives_ok($$ with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
    values (pg_temp.v('sled')::uuid, 'Rebound', 'front_left_shock', 'clicks') returning id)
  insert into t select 'set_lr', id::text from x $$, 'an editor adds a setting');
select lives_ok($$ with x as (insert into public.suspension_settings (sled_id, name, zone, value_type)
    values (pg_temp.v('sled')::uuid, 'Spring', 'rear_springs_limiter', 'text') returning id)
  insert into t select 'set_spring', id::text from x $$, 'a free-text setting');
select lives_ok($$ with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
    values (pg_temp.v('sled')::uuid, 'Compression', 'front_right_shock', 'clicks') returning id)
  insert into t select 'set_rc', id::text from x $$, 'the same name is fine in another zone');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'COMPRESSION ', 'front_left_shock') $$,
  '23505', null, 'a duplicate name in the same zone is refused');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'Thing', 'middle') $$,
  '23514', null, 'an unknown zone is refused');
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'Mech', 'rear_general') $$,
  '42501', null, 'a mechanic cannot add settings');
select is_empty($$ update public.suspension_settings set name = 'Renamed' where id = pg_temp.v('set_lc')::uuid returning 1 $$,
  'a mechanic cannot edit settings');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'View', 'rear_general') $$,
  '42501', null, 'a viewer cannot add settings');
select is((select count(*)::int from public.suspension_settings), 4, 'a viewer sees the settings');
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
with x as (insert into public.suspension_settings (sled_id, name, zone)
  values (pg_temp.v('other_sled')::uuid, 'Other', 'rear_general') returning id)
insert into t select 'set_other', id::text from x;

-- ---------------------------------------------------------------------------
-- Setups and the active setup
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into t select 'setup_a', public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Trail') ->> 'setup_id' $$,
  'the owner creates a setup');
select is((select format('%s|%s|%s', revision_number, setting_values, note) from public.suspension_revisions
           where setup_id = pg_temp.v('setup_a')::uuid), '1|{}|Created', 'it starts with a blank revision 1');
select is((select is_active from public.suspension_setups where id = pg_temp.v('setup_a')::uuid), false,
  'a new setup is not made active automatically');
select pg_temp.as_user('f2222222-2222-2222-2222-222222222222');
select lives_ok($$ insert into t select 'setup_b', public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Deep powder') ->> 'setup_id' $$,
  'an editor creates a setup');
select throws_ok($$ select public.create_suspension_setup(pg_temp.v('sled')::uuid, 'trail ') $$,
  '23505', null, 'setup names are unique per sled');
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select throws_ok($$ select public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Mechanic setup') $$,
  '42501', null, 'a mechanic cannot create setups');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select throws_ok($$ select public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Viewer setup') $$,
  '42501', null, 'a viewer cannot create setups');

select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select lives_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_a')::uuid) $$, 'the owner activates Trail');
select pg_temp.as_user('f2222222-2222-2222-2222-222222222222');
select lives_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_b')::uuid) $$, 'an editor activates Deep powder');
select is((select string_agg(name, ',') from public.suspension_setups where sled_id = pg_temp.v('sled')::uuid and is_active),
  'Deep powder', 'only one setup is active; the previous one was switched off');
select throws_ok($$ update public.suspension_setups set is_active = true where id = pg_temp.v('setup_a')::uuid $$,
  '23505', null, 'a second active setup is refused by the database');
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select throws_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_a')::uuid) $$,
  '42501', null, 'a mechanic cannot change the active setup');
select is_empty($$ update public.suspension_setups set name = 'Mine' where id = pg_temp.v('setup_a')::uuid returning 1 $$,
  'a mechanic cannot rename setups');
select is_empty($$ update public.suspension_setups set deleted_at = now() where id = pg_temp.v('setup_a')::uuid returning 1 $$,
  'a mechanic cannot delete setups');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select throws_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_a')::uuid) $$,
  '42501', null, 'a viewer cannot change the active setup');
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select throws_ok($$ update public.suspension_setups set deleted_at = now() where id = pg_temp.v('setup_b')::uuid $$,
  '23514', 'Make another setup active before deleting this one.', 'the active setup cannot be deleted');
select is((select is_active from public.suspension_setups where id = pg_temp.v('setup_b')::uuid), true,
  'and no replacement was chosen automatically');

-- ---------------------------------------------------------------------------
-- Revisions: adjustments carry unchanged values forward
-- ---------------------------------------------------------------------------
insert into t values ('rev_b1', pg_temp.latest('setup_b')::text);
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select lives_ok($$ insert into t select 'save1', public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b1')::uuid,
    jsonb_build_object(pg_temp.v('set_lc'), '12', pg_temp.v('set_lr'), 8, pg_temp.v('set_spring'), 'Stiff spring'),
    'Baseline', 2010, 151.5, 'aaaaaaaa-0000-4000-8000-000000000001')::text $$,
  'a mechanic records an adjustment');
insert into t values ('rev_b2', pg_temp.latest('setup_b')::text);
select is((select format('%s|%s|%s|%s|%s', revision_number, setting_values -> pg_temp.v('set_lc') ->> 'value',
                         setting_values -> pg_temp.v('set_lc') ->> 'unit', setting_values -> pg_temp.v('set_lr') ->> 'value', odometer_mi)
           from public.suspension_revisions where id = pg_temp.v('rev_b2')::uuid),
  '2|12|clicks|8|2010.0', 'revision 2 holds the values (with name and unit snapshot) and the mileage');
select is((select count(*)::int from public.sled_readings where sled_id = pg_temp.v('sled')::uuid), 1,
  'the mileage/hours on a revision never create a reading');
select is((select format('%s|%s', count(*), max(revision_number)) from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid),
  '2|2', 'one revision was saved');
select is((public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b1')::uuid,
    jsonb_build_object(pg_temp.v('set_lc'), '12'), null, null, null, 'aaaaaaaa-0000-4000-8000-000000000001') ->> 'duplicate'),
  'true', 'repeating the same save returns the saved revision (idempotency key)');
select is((select count(*)::int from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid), 2, 'and saves nothing new');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b1')::uuid,
    jsonb_build_object(pg_temp.v('set_lc'), '14'), null, null, null, gen_random_uuid()) $$,
  'PT409', null, 'a save based on an old revision is refused (someone else changed it)');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b2')::uuid,
    jsonb_build_object(pg_temp.v('set_lc'), ' 12 '), null, null, null, gen_random_uuid()) $$,
  '22023', 'Nothing changed.', 'saving the same values is refused');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b2')::uuid,
    jsonb_build_object(pg_temp.v('set_lc'), 'soft'), null, null, null, gen_random_uuid()) $$,
  '22023', 'Enter a number for Compression.', 'a number setting only takes numbers');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b2')::uuid,
    jsonb_build_object(pg_temp.v('set_other'), '1'), null, null, null, gen_random_uuid()) $$,
  '23514', 'That setting is not on this snowmobile.', 'a setting of another sled is refused');
select lives_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b2')::uuid,
    jsonb_build_object(pg_temp.v('set_lr'), '10'), 'More rebound', null, null, 'aaaaaaaa-0000-4000-8000-000000000002') $$,
  'only rebound changes');
insert into t values ('rev_b3', pg_temp.latest('setup_b')::text);
select is((select format('%s|%s|%s', setting_values -> pg_temp.v('set_lc') ->> 'value', setting_values -> pg_temp.v('set_lr') ->> 'value',
                         setting_values -> pg_temp.v('set_spring') ->> 'value')
           from public.suspension_revisions where id = pg_temp.v('rev_b3')::uuid),
  '12|10|Stiff spring', 'unchanged settings are carried forward');
select is((select setting_values -> pg_temp.v('set_lr') ->> 'value' from public.suspension_revisions where id = pg_temp.v('rev_b2')::uuid),
  '8', 'the earlier revision is unchanged');
select lives_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.v('rev_b3')::uuid,
    jsonb_build_object(pg_temp.v('set_spring'), null), 'Spring removed', null, null, gen_random_uuid()) $$,
  'a value can be cleared (left blank)');
select ok(not (select setting_values ? pg_temp.v('set_spring') from public.suspension_revisions where id = pg_temp.latest('setup_b')),
  'a cleared setting is left out of the snapshot');
select throws_ok($$ insert into public.suspension_revisions (setup_id, sled_id, revision_number, setting_values)
    values (pg_temp.v('setup_b')::uuid, pg_temp.v('sled')::uuid, 99, jsonb_build_object(pg_temp.v('set_lc'), 'x')) $$,
  '22023', null, 'direct inserts are validated the same way');
select throws_ok($$ insert into public.suspension_revisions (setup_id, sled_id, revision_number, setting_values)
    values (pg_temp.v('setup_b')::uuid, pg_temp.v('other_sled')::uuid, 99, '{}') $$,
  '42501', null, 'a revision cannot be filed under a sled the user has no access to');
select lives_ok($$ insert into public.suspension_revisions (setup_id, sled_id, revision_number, setting_values)
    values (pg_temp.v('setup_b')::uuid, pg_temp.v('sled')::uuid, 99, '{}') $$, 'a direct insert with a made-up number ...');
select is((select format('%s|%s', revision_number, sled_id = pg_temp.v('sled')::uuid) from public.suspension_revisions where id = pg_temp.latest('setup_b')),
  '5|t', '... is numbered by the database');

select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select throws_ok($$ update public.suspension_revisions set note = 'Edited' where id = pg_temp.v('rev_b2')::uuid $$,
  '42501', 'Suspension revisions cannot be changed. Save a new revision instead.', 'revisions cannot be edited, even by the owner');
select throws_ok($$ update public.suspension_revisions set deleted_at = now() where id = pg_temp.v('rev_b2')::uuid $$,
  '42501', 'Revisions are deleted and restored together with their setup.', 'a single revision cannot be deleted');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.latest('setup_b'),
    jsonb_build_object(pg_temp.v('set_lc'), '1'), null, null, null, gen_random_uuid()) $$,
  '42501', null, 'a viewer cannot record adjustments');

-- ---------------------------------------------------------------------------
-- Restoring an earlier revision creates a new one; nothing is erased
-- ---------------------------------------------------------------------------
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
insert into t select 'count_before', count(*)::text from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid;
select lives_ok($$ select public.restore_suspension_revision(pg_temp.v('rev_b2')::uuid, null, 2100, null, gen_random_uuid()) $$,
  'a mechanic restores revision 2');
select is((select format('%s|%s|%s|%s', restored_from_revision_id = pg_temp.v('rev_b2')::uuid, note,
                         setting_values -> pg_temp.v('set_lr') ->> 'value', setting_values -> pg_temp.v('set_spring') ->> 'value')
           from public.suspension_revisions where id = pg_temp.latest('setup_b')),
  't|Restored revision 2|8|Stiff spring', 'the new revision has revision 2''s values and points to it');
select is((select count(*)::int - pg_temp.v('count_before')::int from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid),
  1, 'history is kept: one revision was added, none changed');
select throws_ok($$ select public.restore_suspension_revision(pg_temp.v('rev_b2')::uuid, null, null, null, gen_random_uuid()) $$,
  '22023', 'The latest revision already has these values.', 'restoring values the setup already has is refused');
select throws_ok($$ insert into public.suspension_revisions (setup_id, sled_id, revision_number, restored_from_revision_id)
    values (pg_temp.v('setup_a')::uuid, pg_temp.v('sled')::uuid, 1, pg_temp.v('rev_b2')::uuid) $$,
  '23514', 'Only a revision of the same setup can be restored.', 'a revision of another setup cannot be restored into this one');

-- ---------------------------------------------------------------------------
-- Feedback: several entries per revision
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, note, ridden_on)
    values (pg_temp.v('rev_b3')::uuid, pg_temp.v('sled')::uuid, 'improved', 'Less kick', current_date - 1) $$, 'a mechanic adds feedback');
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select lives_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating) values (pg_temp.v('rev_b3')::uuid, pg_temp.v('sled')::uuid, 'worse') $$,
  'the owner adds more feedback on the same revision');
select is((select string_agg(rating, ',' order by ridden_on) from public.suspension_feedback where revision_id = pg_temp.v('rev_b3')::uuid),
  'improved,worse', 'both entries stay attached to the revision');
select throws_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating) values (pg_temp.v('rev_b3')::uuid, pg_temp.v('sled')::uuid, 'great') $$,
  '23514', null, 'feedback is Improved, Worse or No change');
select throws_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, ridden_on) values (pg_temp.v('rev_b3')::uuid, pg_temp.v('sled')::uuid, 'no_change', current_date + 2) $$,
  '22023', 'The ride date cannot be in the future.', 'the ride date cannot be in the future');
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select is_empty($$ update public.suspension_feedback set note = 'x' where rating = 'worse' returning 1 $$,
  'a mechanic cannot edit someone else''s feedback');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select throws_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating) values (pg_temp.v('rev_b3')::uuid, pg_temp.v('sled')::uuid, 'improved') $$,
  '42501', null, 'a viewer cannot add feedback');

-- ---------------------------------------------------------------------------
-- Photos and the storage bucket
-- ---------------------------------------------------------------------------
select pg_temp.as_user('f3333333-3333-3333-3333-333333333333');
select lives_ok($$ insert into public.suspension_photos (sled_id, revision_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('rev_b3')::uuid, pg_temp.path(pg_temp.v('rev_b3'))) $$,
  'a mechanic adds an adjustment photo');
select throws_ok($$ insert into public.suspension_photos (sled_id, setting_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('set_lc')::uuid, pg_temp.path(pg_temp.v('set_lc'))) $$,
  '42501', 'Only the owner or an editor can add reference photos.', 'but not a reference photo');
select throws_ok($$ insert into public.suspension_photos (sled_id, revision_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('rev_b3')::uuid, pg_temp.path(pg_temp.v('rev_b2'))) $$,
  '23514', null, 'a photo must be in its own folder');
select lives_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('suspension-photos', %L, auth.uid()::text) $$,
  pg_temp.path(pg_temp.v('rev_b3'))), 'a mechanic uploads an adjustment photo file');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('suspension-photos', %L, auth.uid()::text) $$,
  pg_temp.path(pg_temp.v('set_lc'))), '42501', null, 'but not a reference photo file');
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select lives_ok($$ insert into public.suspension_photos (sled_id, setting_id, path)
    select pg_temp.v('sled')::uuid, pg_temp.v('set_lc')::uuid, pg_temp.path(pg_temp.v('set_lc')) from generate_series(1, 6) $$,
  'the owner adds 6 reference photos to a setting');
select throws_ok($$ insert into public.suspension_photos (sled_id, setting_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('set_lc')::uuid, pg_temp.path(pg_temp.v('set_lc'))) $$,
  '23514', 'At most 6 photos can be added here.', 'a 7th is refused');
select lives_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('suspension-photos', %L, auth.uid()::text) $$,
  pg_temp.path(pg_temp.v('set_lc'))), 'the owner uploads a reference photo file');
select pg_temp.as_user('f4444444-4444-4444-4444-444444444444');
select is((select count(*)::int from storage.objects where bucket_id = 'suspension-photos'), 2, 'a viewer can see the photo files');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('suspension-photos', %L, auth.uid()::text) $$,
  pg_temp.path(pg_temp.v('rev_b3'))), '42501', null, 'a viewer cannot upload');

-- ---------------------------------------------------------------------------
-- Other users see nothing
-- ---------------------------------------------------------------------------
select pg_temp.as_user('f5555555-5555-5555-5555-555555555555');
select is((select (select count(*) from public.suspension_settings) + (select count(*) from public.suspension_setups)
                + (select count(*) from public.suspension_revisions) + (select count(*) from public.suspension_feedback)
                + (select count(*) from public.suspension_photos) + (select count(*) from storage.objects where bucket_id = 'suspension-photos'))::int,
  0, 'someone the sled is not shared with sees no suspension data or photos');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.latest('setup_b'),
    jsonb_build_object(pg_temp.v('set_lc'), '1'), null, null, null, gen_random_uuid()) $$,
  'P0002', null, 'and cannot record an adjustment on it');
select throws_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_a')::uuid) $$, 'P0002', null, 'or activate a setup');

-- ---------------------------------------------------------------------------
-- Recently Deleted: setups and settings take their history and photos along
-- ---------------------------------------------------------------------------
select pg_temp.as_user('f1111111-1111-1111-1111-111111111111');
select lives_ok($$ select public.activate_suspension_setup(pg_temp.v('setup_a')::uuid) $$, 'Trail is made active again');
select lives_ok($$ update public.suspension_setups set deleted_at = now() where id = pg_temp.v('setup_b')::uuid $$,
  'now Deep powder (inactive) can be deleted');
select is((select format('%s|%s|%s', (select count(*) from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid and deleted_at is null),
                                     (select count(*) from public.suspension_feedback where revision_id = pg_temp.v('rev_b3')::uuid and deleted_at is null),
                                     (select count(*) from public.suspension_photos where revision_id = pg_temp.v('rev_b3')::uuid and deleted_at is null))),
  '0|0|0', 'its revisions, feedback and adjustment photos went to Recently Deleted with it');
select throws_ok($$ select public.save_suspension_revision(pg_temp.v('setup_b')::uuid, pg_temp.latest('setup_b'),
    jsonb_build_object(pg_temp.v('set_lc'), '1'), null, null, null, gen_random_uuid()) $$,
  'P0002', null, 'a deleted setup cannot be adjusted');
select lives_ok($$ update public.suspension_setups set deleted_at = null where id = pg_temp.v('setup_b')::uuid $$, 'and it is restored');
select is((select format('%s|%s|%s|%s', (select is_active from public.suspension_setups where id = pg_temp.v('setup_b')::uuid),
                                        (select count(*) from public.suspension_revisions where setup_id = pg_temp.v('setup_b')::uuid and deleted_at is null),
                                        (select count(*) from public.suspension_feedback where revision_id = pg_temp.v('rev_b3')::uuid and deleted_at is null),
                                        (select count(*) from public.suspension_photos where revision_id = pg_temp.v('rev_b3')::uuid and deleted_at is null))),
  'f|6|2|1', 'with its whole history, still inactive');

select lives_ok($$ update public.suspension_settings set deleted_at = now() where id = pg_temp.v('set_lc')::uuid $$, 'a setting is deleted');
select is((select count(*)::int from public.suspension_photos where setting_id = pg_temp.v('set_lc')::uuid and deleted_at is null), 0,
  'its reference photos go with it');
select is((select setting_values -> pg_temp.v('set_lc') ->> 'name' from public.suspension_revisions where id = pg_temp.v('rev_b2')::uuid),
  'Compression', 'history still shows the deleted setting''s name and value');
select is((public.restore_suspension_revision(pg_temp.v('rev_b3')::uuid, null, null, null, gen_random_uuid()) ->> 'duplicate'), 'false',
  'restoring after a setting was deleted ...');
select ok(not (select setting_values ? pg_temp.v('set_lc') from public.suspension_revisions where id = pg_temp.latest('setup_b')),
  '... carries forward only settings that still exist');

select ok((select count(*) from public.audit_log where table_name like 'suspension\_%') >= 10, 'suspension changes are in the audit log');

-- Permanently deleting the sled removes everything (no errors from history links).
reset role;
select lives_ok($$ delete from public.sleds where id = pg_temp.v('sled')::uuid $$,
  'a sled with suspension history can be permanently deleted');
select is((select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid), 0, 'and its suspension data goes with it');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select 1 from public.suspension_setups $$, '42501', null, 'anonymous users cannot read setups');

select * from finish();
rollback;
