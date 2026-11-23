-- Migration 8 cleanup x Migration 10 measurement photos (and Migration 11
-- access): a file shared by several configurations is never an orphan while
-- any row (active or in Recently Deleted) refers to it; it becomes one only
-- after the last row is purged; a claimed or removed file can't be attached
-- again; purging an old configuration keeps (and keeps viewable) files that
-- other configurations use. Everything runs in one transaction rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

insert into auth.users (id, email, email_confirmed_at) values
  ('b1111111-1111-1111-1111-111111111111', 'mpc-owner@example.com', now()),
  ('b2222222-2222-2222-2222-222222222222', 'mpc-view@example.com',  now()),
  ('b3333333-3333-3333-3333-333333333333', 'mpc-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
-- A path in the sled's folder under a configuration, saved under key p_k.
create function pg_temp.p(p_k text, p_rev text) returns text language sql volatile as $$
  insert into t values (p_k, pg_temp.v('sled') || '/' || pg_temp.v(p_rev) || '/' || gen_random_uuid() || '.jpg') returning v;
$$;
grant execute on function pg_temp.p(text, text) to authenticated;
-- A file in Storage, as the database owner, with an age.
create function pg_temp.object(p_path text, p_age interval) returns void language sql volatile as $$
  insert into storage.objects (bucket_id, name, created_at, updated_at, metadata)
  values ('suspension-photos', p_path, now() - p_age, now() - p_age,
          jsonb_build_object('eTag', '"' || md5(p_path) || '"', 'size', 1234, 'mimetype', 'image/jpeg'));
$$;
create function pg_temp.status(p_k text) returns text language sql stable as $$
  select f.status from private.storage_file_candidates() f where f.bucket_id = 'suspension-photos' and f.object_path = pg_temp.v(p_k);
$$;
create function pg_temp.file_outcome(p_run bigint, p_k text) returns text language sql stable as $$
  select outcome from private.cleanup_candidates where run_id = p_run and kind = 'file' and object_path = pg_temp.v(p_k);
$$;
create function pg_temp.rows_with(p_k text) returns int language sql stable as $$
  select count(*)::int from public.sled_measurement_photos where path = pg_temp.v(p_k);
$$;
create function pg_temp.viewable(p_k text) returns boolean language sql stable as $$
  select coalesce(private.has_sled_permission(private.suspension_photo_sled_id(pg_temp.v(p_k)), 'view'), false);
$$;
grant execute on function pg_temp.viewable(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Trail 1 with photo A; Trail 2 carries A forward, then replaces it
-- with B; an old setup's configuration with photo C, which Trail 2 also uses;
-- a mechanic-style upload with no record (M) and a fresh one (F).
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Lynx', 'Rave', 2024, 100)::text;
insert into t select 'tok', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'mpc-view@example.com', 'viewer');
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Sag', 'rear_general', 'mm') returning id)
insert into t select 'sag', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Ride height', 'rear_general', 'in') returning id)
insert into t select 'height', id::text from x;
insert into t select 'r1', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, null,
  jsonb_build_object(pg_temp.v('sag'), '30'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
select pg_temp.p('a', 'r1');
reset role;
select pg_temp.object(pg_temp.v('a'), interval '3 days');
set local role authenticated;
select public.add_suspension_measurement_photo(pg_temp.v('r1')::uuid, pg_temp.v('sag')::uuid, pg_temp.v('a'));
insert into t select 'r2', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r1')::uuid,
  jsonb_build_object(pg_temp.v('sag'), '31'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
select pg_temp.p('b', 'r2');
-- The legacy setup's configuration (not active).
insert into t select 'old_setup', (public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Old') ->> 'setup_id');
insert into t select 'r_old', (select id::text from public.suspension_revisions where setup_id = pg_temp.v('old_setup')::uuid);
select pg_temp.p('c', 'r_old');
select pg_temp.p('m', 'r2');
select pg_temp.p('f', 'r2');
reset role;
select pg_temp.object(pg_temp.v('b'), interval '3 days');
select pg_temp.object(pg_temp.v('c'), interval '3 days');
select pg_temp.object(pg_temp.v('m'), interval '25 hours');
select pg_temp.object(pg_temp.v('f'), interval '1 hour');
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
insert into t select 'r2_a', (select id::text from public.sled_measurement_photos
  where revision_id = pg_temp.v('r2')::uuid and path = pg_temp.v('a') and deleted_at is null);
select public.replace_suspension_measurement_photo(pg_temp.v('r2_a')::uuid, 1, pg_temp.v('b'));
select public.add_suspension_measurement_photo(pg_temp.v('r_old')::uuid, pg_temp.v('sag')::uuid, pg_temp.v('c'));
select public.add_suspension_measurement_photo(pg_temp.v('r2')::uuid, pg_temp.v('sag')::uuid, pg_temp.v('c'));
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok'));
reset role;
set local request.jwt.claims = '';

-- ---------------------------------------------------------------------------
-- Shared files are references while any row refers to them
-- ---------------------------------------------------------------------------
select is(pg_temp.rows_with('a'), 2, 'file A: Trail 1''s row and Trail 2''s replaced row');
select is(pg_temp.status('a'), 'referenced', 'A is referenced (Trail 1 active, Trail 2 in Recently Deleted)');
select is(pg_temp.status('b'), 'referenced', 'B (Trail 2) is referenced');
select is(pg_temp.status('c'), 'referenced', 'C (old configuration and Trail 2) is referenced');
select is(pg_temp.status('m'), 'orphan', 'an upload with no record is an orphan after 24 hours');
select is(pg_temp.status('f'), 'too_new', 'a fresh upload is never touched');

-- Remove A from Trail 1 too: both rows are now in Recently Deleted.
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
update public.sled_measurement_photos set deleted_at = now(), version = version
  where revision_id = pg_temp.v('r1')::uuid and path = pg_temp.v('a') and deleted_at is null;
reset role;
set local request.jwt.claims = '';
select is(pg_temp.status('a'), 'referenced', 'a file whose rows are all in Recently Deleted is still referenced (30 days)');

-- The old setup goes to Recently Deleted; its configuration and photo row follow.
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
update public.suspension_setups set deleted_at = now(), version = version where id = pg_temp.v('old_setup')::uuid;
reset role;
set local request.jwt.claims = '';
select is((select count(*)::int from public.sled_measurement_photos where revision_id = pg_temp.v('r_old')::uuid and deleted_at is not null), 1,
  'the old configuration''s photo row went to Recently Deleted with it');

-- A report run: nothing referenced is listed.
insert into t select 'run_report', private.cleanup_begin_run('report', 'scheduled')::text;
select private.cleanup_process_records(pg_temp.v('run_report')::bigint);
select private.cleanup_report_files(pg_temp.v('run_report')::bigint);
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'm'), 'would_delete', 'the report lists the orphan');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'a'), null, 'not A');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'b'), null, 'not B');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'c'), null, 'not C');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'f'), null, 'not the fresh upload');
select is((select count(*)::int from private.cleanup_candidates
           where run_id = pg_temp.v('run_report')::bigint and table_name = 'sled_measurement_photos'), 0,
  'photo rows still within 30 days are not listed for purging');
select private.cleanup_finish_run(pg_temp.v('run_report')::bigint);

-- ---------------------------------------------------------------------------
-- 30 days later: a delete run purges the rows, then only true orphans go
-- ---------------------------------------------------------------------------
alter table public.sled_measurement_photos disable trigger guard;
update public.sled_measurement_photos set deleted_at = now() - interval '31 days' where deleted_at is not null and revision_id <> pg_temp.v('r_old')::uuid;
alter table public.sled_measurement_photos enable trigger guard;
alter table public.suspension_setups disable trigger guard;
alter table public.suspension_setups disable trigger quick_tune;
update public.suspension_setups set deleted_at = now() - interval '31 days' where id = pg_temp.v('old_setup')::uuid;
alter table public.suspension_setups enable trigger guard;
alter table public.suspension_setups enable trigger quick_tune;
alter table public.suspension_revisions disable trigger guard;
update public.suspension_revisions set deleted_at = now() - interval '31 days' where setup_id = pg_temp.v('old_setup')::uuid;
alter table public.suspension_revisions enable trigger guard;
alter table public.sled_measurement_photos disable trigger guard;
update public.sled_measurement_photos set deleted_at = now() - interval '31 days' where revision_id = pg_temp.v('r_old')::uuid;
alter table public.sled_measurement_photos enable trigger guard;

insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now() - d * interval '1 day', now() - d * interval '1 day'
from generate_series(1, 7) d;
select lives_ok($$ select private.authorize_cleanup_deletion('test backup reference') $$, 'deletion authorized (test)');

insert into t select 'run_delete', private.cleanup_begin_run('delete', 'scheduled')::text;
select private.cleanup_process_records(pg_temp.v('run_delete')::bigint);
select is(pg_temp.rows_with('a'), 0, 'both expired rows of A were purged');
select is((select count(*)::int from public.suspension_revisions where id = pg_temp.v('r_old')::uuid), 0,
  'the old setup''s configuration was purged');
select is(pg_temp.rows_with('c'), 1, 'its photo row went with it; Trail 2''s row for C stays');
select is((select count(*)::int from public.sled_measurement_photos where revision_id = pg_temp.v('r2')::uuid and deleted_at is null), 2,
  'Trail 2 still has B and C');
select private.cleanup_report_files(pg_temp.v('run_delete')::bigint);
select is(pg_temp.file_outcome(pg_temp.v('run_delete')::bigint, 'a'), 'eligible', 'A is now an orphan, removable');
select is(pg_temp.file_outcome(pg_temp.v('run_delete')::bigint, 'm'), 'eligible', 'so is the upload with no record');
select is(pg_temp.file_outcome(pg_temp.v('run_delete')::bigint, 'b'), null, 'B is still referenced');
select is(pg_temp.file_outcome(pg_temp.v('run_delete')::bigint, 'c'), null, 'C is still referenced (Trail 2), though its folder''s configuration is gone');

-- Migration 11: C stays viewable for people on the snowmobile, and only for them.
set local role authenticated;
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select is(pg_temp.viewable('c'), true, 'a viewer can still open C after its original configuration was purged');
select is(pg_temp.viewable('b'), true, 'and B');
select pg_temp.as_user('b3333333-3333-3333-3333-333333333333');
select is(pg_temp.viewable('c'), false, 'someone without access cannot');
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select pg_temp.as_user('b3333333-3333-3333-3333-333333333333');
select is(pg_temp.viewable('a'), false, 'a file no row refers to stays limited to its folder''s snowmobile...');
reset role;
set local request.jwt.claims = '';
select is(private.suspension_photo_sled_id(pg_temp.v('a')), pg_temp.v('sled')::uuid, '...which is still this one (Trail 1''s folder)');
select is(private.suspension_photo_sled_id('00000000-0000-4000-8000-000000000000/' || pg_temp.v('r2') || '/' || gen_random_uuid() || '.jpg'), null,
  'a path naming another snowmobile resolves to nothing');

-- Claimed and removed files can't be attached again, including by carry-forward.
select is((private.cleanup_claim_file(pg_temp.v('run_delete')::bigint, 'suspension-photos', pg_temp.v('a')) ->> 'claimed')::boolean, true, 'A is claimed');
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
select throws_ok($$ select public.add_suspension_measurement_photo(pg_temp.v('r2')::uuid, pg_temp.v('height')::uuid, pg_temp.v('a')) $$,
  '55006', 'This photo is being removed. Add it again.', 'a claimed file cannot be added to a configuration');
reset role;
set local request.jwt.claims = '';
select is((private.cleanup_claim_file(pg_temp.v('run_delete')::bigint, 'suspension-photos', pg_temp.v('b')) ->> 'reason'), 'not_listed',
  'a referenced file cannot be claimed');

-- Saving a new configuration carries Trail 2's photos forward and never revives A.
set local role authenticated;
select pg_temp.as_user('b1111111-1111-1111-1111-111111111111');
insert into t select 'r3', (public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r2')::uuid,
  jsonb_build_object(pg_temp.v('sag'), '32'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id');
select is((select string_agg(path, ',' order by slot) from public.sled_measurement_photos where revision_id = pg_temp.v('r3')::uuid),
  pg_temp.v('b') || ',' || pg_temp.v('c'), 'Trail 3 carries B and C forward, not A');
reset role;
set local request.jwt.claims = '';
select is(pg_temp.status('c'), 'referenced', 'C is referenced by Trail 2 and Trail 3');

select * from finish();
rollback;
