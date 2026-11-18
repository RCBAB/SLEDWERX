-- Tests for migration 20261120090000_sled_issues (Phase 6.1): the issue log,
-- issue photos and their storage bucket.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(65);

insert into auth.users (id, email, email_confirmed_at) values
  ('d1111111-1111-1111-1111-111111111111', 'iss-owner@example.com',  now()),
  ('d2222222-2222-2222-2222-222222222222', 'iss-editor@example.com', now()),
  ('d3333333-3333-3333-3333-333333333333', 'iss-mech@example.com',   now()),
  ('d4444444-4444-4444-4444-444444444444', 'iss-view@example.com',   now()),
  ('d5555555-5555-5555-5555-555555555555', 'iss-other@example.com',  now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
create function pg_temp.photo_path(p_issue text) returns text language sql volatile as $$
  select pg_temp.v('sled') || '/' || pg_temp.v(p_issue) || '/' || gen_random_uuid() || '.jpg';
$$;
grant execute on function pg_temp.photo_path(text) to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150, p_read_on => current_date - 10)::text;
insert into t select 'other_sled', public.create_sled('Lynx', 'Rave', 2020, 100)::text;
insert into t select 'tok_ed', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'iss-editor@example.com', 'editor');
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'iss-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'iss-view@example.com', 'viewer');
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_ed'));
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));

-- Service records to link: completed, not completed, deleted, and on another sled.
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'entry', public.save_maintenance_entry(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - 2, 'Replaced idler wheel') ->> 'entry_id';
insert into t select 'entry_open', public.save_maintenance_entry(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - 2, 'Waiting on parts', p_completed => false) ->> 'entry_id';
insert into t select 'entry_del', public.save_maintenance_entry(gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - 3, 'Deleted one') ->> 'entry_id';
update public.maintenance_entries set deleted_at = now() where id = pg_temp.v('entry_del')::uuid;
insert into t select 'entry_other', public.save_maintenance_entry(gen_random_uuid(), pg_temp.v('other_sled')::uuid, current_date - 1, 'Other sled') ->> 'entry_id';

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select has_table('public', 'sled_issues', 'sled_issues exists');
select has_table('public', 'sled_issue_photos', 'sled_issue_photos exists');
select ok((select relrowsecurity from pg_class where oid = 'public.sled_issues'::regclass), 'RLS is on for issues');
select ok((select relrowsecurity from pg_class where oid = 'public.sled_issue_photos'::regclass), 'RLS is on for issue photos');
select ok(not has_table_privilege('authenticated', 'public.sled_issues', 'delete')
          and not has_table_privilege('authenticated', 'public.sled_issue_photos', 'delete'),
  'nobody can hard-delete issues or photos (Recently Deleted instead)');
select ok(not has_table_privilege('anon', 'public.sled_issues', 'select')
          and not has_table_privilege('anon', 'public.sled_issue_photos', 'select'), 'anonymous users have no access');
select is((select public from storage.buckets where id = 'issue-photos'), false, 'the issue-photos bucket is private');
select is((select file_size_limit from storage.buckets where id = 'issue-photos'), 5242880::bigint, 'issue photos are limited to 5 MB');
select is((select allowed_mime_types from storage.buckets where id = 'issue-photos'), array['image/jpeg', 'image/webp'],
  'only JPEG and WebP issue photos are accepted');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'SledWerx issue photos:%' and roles = '{authenticated}'), 3,
  'three issue-photo storage policies, for signed-in users only');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'SledWerx:%'), 4, 'the sled-photo policies are unchanged');

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
select lives_ok($$ with x as (insert into public.sled_issues (sled_id, title, priority, odometer_mi, description)
    values (pg_temp.v('sled')::uuid, 'Track squeak', 'high', 2000, 'Squeaks at low speed') returning id)
  insert into t select 'iss_owner', id::text from x $$,
  'the owner reports an issue');
select is((select format('%s|%s|%s|%s', status, priority, reported_on = current_date, odometer_mi) from public.sled_issues where id = pg_temp.v('iss_owner')::uuid),
  'open|high|t|2000.0', 'it is open, with its priority, today''s date and the mileage');
select is((select count(*)::int from public.sled_readings where sled_id = pg_temp.v('sled')::uuid and deleted_at is null), 1,
  'an issue''s mileage never creates a reading (still only the first reading)');
select throws_ok($$ insert into public.sled_issues (sled_id, title, priority) values (pg_temp.v('sled')::uuid, 'Bad', 'urgent') $$,
  '23514', null, 'priority must be low, medium, high or critical');
select throws_ok($$ insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, '   ') $$,
  '23514', null, 'a title is required');
select throws_ok($$ insert into public.sled_issues (sled_id, title, reported_on) values (pg_temp.v('sled')::uuid, 'Future', current_date + 2) $$,
  '22023', 'The issue date cannot be in the future.', 'the issue date cannot be in the future');
select throws_ok($$ insert into public.sled_issues (sled_id, title, odometer_mi) values (pg_temp.v('sled')::uuid, 'Neg', -1) $$,
  '23514', null, 'mileage cannot be negative');

select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select lives_ok($$ with x as (insert into public.sled_issues (sled_id, title, priority)
    values (pg_temp.v('sled')::uuid, 'Loose mirror', 'low') returning id)
  insert into t select 'iss_mech', id::text from x $$, 'a mechanic reports an issue');
select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select throws_ok($$ insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Viewer') $$,
  '42501', null, 'a viewer cannot report issues');
select is((select count(*)::int from public.sled_issues), 2, 'a viewer sees the sled''s issues');
select pg_temp.as_user('d5555555-5555-5555-5555-555555555555');
select is((select count(*)::int from public.sled_issues), 0, 'someone the sled is not shared with sees no issues');
select throws_ok($$ insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Stranger') $$,
  '42501', null, 'and cannot report one');

-- ---------------------------------------------------------------------------
-- Editing (existing rule: owners/editors any issue, mechanics their own)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select lives_ok($$ update public.sled_issues set description = 'Driver side' where id = pg_temp.v('iss_mech')::uuid $$,
  'a mechanic edits their own issue');
select is_empty($$ update public.sled_issues set title = 'Changed' where id = pg_temp.v('iss_owner')::uuid returning 1 $$,
  'a mechanic cannot edit someone else''s issue');
select is_empty($$ update public.sled_issues set status = 'resolved', resolved_on = current_date where id = pg_temp.v('iss_owner')::uuid returning 1 $$,
  'or resolve it');
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select lives_ok($$ update public.sled_issues set priority = 'critical' where id = pg_temp.v('iss_owner')::uuid $$,
  'an editor edits any issue');
select throws_ok($$ update public.sled_issues set sled_id = pg_temp.v('other_sled')::uuid where id = pg_temp.v('iss_owner')::uuid $$,
  '42501', null, 'issues cannot move to another sled');
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
select throws_ok($$ update public.sled_issues set version = version - 1, title = 'Stale' where id = pg_temp.v('iss_owner')::uuid $$,
  'PT409', null, 'a stale edit is refused (version check)');

-- ---------------------------------------------------------------------------
-- Resolving
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.sled_issues set status = 'resolved' where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', null, 'a resolved issue needs a resolved date');
select throws_ok($$ update public.sled_issues set resolution_notes = 'x' where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', null, 'an open issue has no resolution');
select throws_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date + 2 where id = pg_temp.v('iss_owner')::uuid $$,
  '22023', 'The resolved date cannot be in the future.', 'the resolved date cannot be in the future');
select throws_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date - 30 where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', null, 'an issue cannot be resolved before it was reported');
select throws_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date, resolved_entry_id = pg_temp.v('entry_other')::uuid
    where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', 'That service record is not on this snowmobile.', 'a service on another sled cannot resolve it');
select throws_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date, resolved_entry_id = pg_temp.v('entry_open')::uuid
    where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', 'Only a completed service record can resolve an issue.', 'an unfinished service cannot resolve it');
select throws_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date, resolved_entry_id = pg_temp.v('entry_del')::uuid
    where id = pg_temp.v('iss_owner')::uuid $$,
  '23514', 'Only a completed service record can resolve an issue.', 'a deleted service cannot resolve it');

insert into t select 'entry_fp', (select format('%s|%s|%s', version, title, performed_on) from public.maintenance_entries where id = pg_temp.v('entry')::uuid);
select lives_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date, resolved_entry_id = pg_temp.v('entry')::uuid,
    resolution_notes = 'Idler bearing was worn' where id = pg_temp.v('iss_owner')::uuid $$,
  'the owner resolves it by linking a completed service on the same sled');
select is((select format('%s|%s', status, resolved_by) from public.sled_issues where id = pg_temp.v('iss_owner')::uuid),
  'resolved|d1111111-1111-1111-1111-111111111111', 'who resolved it is recorded by the database');
select is((select format('%s|%s|%s', version, title, performed_on) from public.maintenance_entries where id = pg_temp.v('entry')::uuid),
  pg_temp.v('entry_fp'), 'the service record itself is unchanged (a link, no copy)');

select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select lives_ok($$ update public.sled_issues set status = 'resolved', resolved_on = current_date, resolution_notes = 'Tightened'
    where id = pg_temp.v('iss_mech')::uuid $$, 'a mechanic resolves their own issue manually, with notes');
select is((select resolved_by::text from public.sled_issues where id = pg_temp.v('iss_mech')::uuid),
  'd3333333-3333-3333-3333-333333333333', 'resolved by the mechanic');
select lives_ok($$ update public.sled_issues set status = 'open', resolved_on = null, resolution_notes = null where id = pg_temp.v('iss_mech')::uuid $$,
  'and can reopen it');
select is((select format('%s|%s', status, resolved_by is null) from public.sled_issues where id = pg_temp.v('iss_mech')::uuid), 'open|t',
  'reopening clears the resolution');

-- A linked service deleted later: the issue stays resolved, the link comes back on restore.
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
update public.maintenance_entries set deleted_at = now() where id = pg_temp.v('entry')::uuid;
select is((select format('%s|%s', status, resolved_entry_id = pg_temp.v('entry')::uuid) from public.sled_issues where id = pg_temp.v('iss_owner')::uuid),
  'resolved|t', 'deleting the linked service leaves the issue resolved');
update public.maintenance_entries set deleted_at = null where id = pg_temp.v('entry')::uuid;
select lives_ok($$ update public.sled_issues set resolution_notes = 'Idler bearing was worn out' where id = pg_temp.v('iss_owner')::uuid $$,
  'the resolution can still be edited (the existing link is not re-checked)');

-- ---------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select lives_ok($$ insert into public.sled_issue_photos (issue_id, sled_id, path) values (pg_temp.v('iss_mech')::uuid, pg_temp.v('sled')::uuid, pg_temp.photo_path('iss_mech')) $$,
  'a mechanic adds a photo to their own issue');
select throws_ok($$ insert into public.sled_issue_photos (issue_id, sled_id, path) values (pg_temp.v('iss_owner')::uuid, pg_temp.v('sled')::uuid, pg_temp.photo_path('iss_owner')) $$,
  '42501', null, 'but not to someone else''s');
select throws_ok($$ insert into public.sled_issue_photos (issue_id, sled_id, path) values (pg_temp.v('iss_mech')::uuid, pg_temp.v('sled')::uuid,
    pg_temp.v('sled') || '/' || pg_temp.v('iss_owner') || '/' || gen_random_uuid() || '.jpg') $$,
  '23514', null, 'a photo must be in its own issue''s folder');
select lives_ok($$ insert into public.sled_issue_photos (issue_id, sled_id, path)
    select pg_temp.v('iss_mech')::uuid, pg_temp.v('sled')::uuid, pg_temp.photo_path('iss_mech') from generate_series(1, 5) $$,
  'up to 6 photos per issue');
select throws_ok($$ insert into public.sled_issue_photos (issue_id, sled_id, path) values (pg_temp.v('iss_mech')::uuid, pg_temp.v('sled')::uuid, pg_temp.photo_path('iss_mech')) $$,
  '23514', 'An issue can have at most 6 photos.', 'a 7th photo is refused');
select throws_ok($$ update public.sled_issue_photos set deleted_at = now() where issue_id = pg_temp.v('iss_mech')::uuid $$,
  '42501', 'You do not have permission to delete this record.', 'a mechanic cannot remove photos (owners and editors can)');

-- Storage: the bucket follows the same rules.
select lives_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('issue-photos', %L, auth.uid()::text) $$,
  pg_temp.photo_path('iss_mech')), 'a mechanic uploads a file into their issue''s folder');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('issue-photos', %L, auth.uid()::text) $$,
  pg_temp.photo_path('iss_owner')), '42501', null, 'but not into someone else''s issue');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('issue-photos', %L, auth.uid()::text) $$,
  pg_temp.v('sled') || '/not-an-issue.jpg'), '42501', null, 'an object outside an issue folder is refused');
select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select ok((select count(*) from storage.objects where bucket_id = 'issue-photos') = 1, 'a viewer can see issue photo files');
select throws_ok(format($$ insert into storage.objects (bucket_id, name, owner_id) values ('issue-photos', %L, auth.uid()::text) $$,
  pg_temp.photo_path('iss_mech')), '42501', null, 'a viewer cannot upload');
select pg_temp.as_user('d5555555-5555-5555-5555-555555555555');
select is((select count(*)::int from storage.objects where bucket_id = 'issue-photos'), 0, 'a stranger sees no issue photo files');
select is((select count(*)::int from public.sled_issue_photos), 0, 'or photo records');

-- ---------------------------------------------------------------------------
-- Recently Deleted, audit and version restore
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select throws_ok($$ update public.sled_issues set deleted_at = now() where id = pg_temp.v('iss_mech')::uuid $$,
  '42501', 'You do not have permission to delete this record.', 'a mechanic cannot delete issues, even their own');
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select lives_ok($$ update public.sled_issues set deleted_at = now() where id = pg_temp.v('iss_mech')::uuid $$, 'an editor deletes an issue');
select is((select count(*)::int from public.sled_issue_photos where issue_id = pg_temp.v('iss_mech')::uuid and deleted_at is null), 0,
  'its photos go to Recently Deleted with it');
select lives_ok($$ update public.sled_issues set deleted_at = null where id = pg_temp.v('iss_mech')::uuid $$, 'and restores it');
select is((select count(*)::int from public.sled_issue_photos where issue_id = pg_temp.v('iss_mech')::uuid and deleted_at is null), 6,
  'with its photos');

select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
select ok((select count(*) from public.audit_log where table_name = 'sled_issues' and record_id = pg_temp.v('iss_owner')::uuid) >= 3,
  'issue changes are in the audit log');
select lives_ok($$ select public.restore_record_version((select max(id) from public.audit_log
    where table_name = 'sled_issues' and record_id = pg_temp.v('iss_owner')::uuid and old_data ->> 'priority' = 'high')) $$,
  'an earlier version of an issue can be restored');

select * from finish();
rollback;
