-- Tests for migration 20261122090000_recently_deleted_cleanup (Migration 8):
-- report-only and deleting record cleanup, cascade-aware limits, the photo
-- reference registry, orphaned files, claims and access control.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(188);

insert into auth.users (id, email, email_confirmed_at) values
  ('c1111111-1111-1111-1111-111111111111', 'cl-owner@example.com',  now()),
  ('c2222222-2222-2222-2222-222222222222', 'cl-editor@example.com', now()),
  ('c3333333-3333-3333-3333-333333333333', 'cl-mech@example.com',   now()),
  ('c4444444-4444-4444-4444-444444444444', 'cl-view@example.com',   now()),
  ('c5555555-5555-5555-5555-555555555555', 'cl-other@example.com',  now()),
  ('c6666666-6666-6666-6666-666666666666', 'cl-gone@example.com',   now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon, service_role;

create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon, service_role;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
-- Deleted just past / just inside the 30-day recovery period.
create function pg_temp.expired() returns timestamptz language sql stable as $$ select now() - interval '30 days' - interval '1 minute' $$;
create function pg_temp.recoverable() returns timestamptz language sql stable as $$ select now() - interval '30 days' + interval '1 minute' $$;
grant execute on function pg_temp.expired(), pg_temp.recoverable() to authenticated;
-- A photo path <sled>/<parent>/<uuid>.jpg, saved under key p_k.
create function pg_temp.p3(p_k text, p_sled text, p_parent text) returns text language sql volatile as $$
  insert into t values (p_k, pg_temp.v(p_sled) || '/' || pg_temp.v(p_parent) || '/' || gen_random_uuid() || '.jpg') returning v;
$$;
grant execute on function pg_temp.p3(text, text, text) to authenticated;
-- Puts a file in Storage (as the database owner) with the given age.
create function pg_temp.object(p_bucket text, p_path text, p_age interval, p_updated_age interval default null) returns void
language sql volatile as $$
  insert into storage.objects (bucket_id, name, created_at, updated_at, metadata)
  values (p_bucket, p_path, now() - p_age, now() - coalesce(p_updated_age, p_age),
          jsonb_build_object('eTag', '"' || md5(p_path) || '"', 'size', 1234, 'mimetype', 'image/jpeg'));
$$;
create function pg_temp.remove_object(p_bucket text, p_path text) returns void language plpgsql volatile as $$
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = p_bucket and name = p_path;
  perform set_config('storage.allow_delete_query', 'false', true);
end;
$$;
-- Total rows in every purged table and the audit log.
create function pg_temp.all_rows() returns bigint language plpgsql volatile as $$
declare v_t text; v_n bigint; v_total bigint := 0;
begin
  for v_t in select table_name from private.cleanup_record_tables union select 'audit_log' loop
    execute format('select count(*) from public.%I', v_t) into v_n;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;
-- A complete report or delete run; returns its id.
create function pg_temp.run(p_mode text) returns bigint language plpgsql volatile as $$
declare v_id bigint;
begin
  v_id := private.cleanup_begin_run(p_mode, 'scheduled');
  perform private.cleanup_process_records(v_id);
  perform private.cleanup_report_files(v_id);
  return v_id;
end;
$$;
create function pg_temp.outcome(p_run bigint, p_table text, p_key text) returns text language sql stable as $$
  select outcome from private.cleanup_candidates where run_id = p_run and table_name = p_table and record_id = pg_temp.v(p_key)::uuid
$$;
create function pg_temp.file_outcome(p_run bigint, p_key text) returns text language sql stable as $$
  select outcome from private.cleanup_candidates where run_id = p_run and kind = 'file' and object_path = pg_temp.v(p_key)
$$;
create function pg_temp.exists_in(p_table text, p_key text) returns boolean language plpgsql stable as $$
declare v boolean;
begin
  execute format('select exists (select 1 from public.%I where id = $1)', p_table) using pg_temp.v(p_key)::uuid into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (created through the app's own functions where it matters)
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000, 150)::text;
insert into t select 'sled_rec', public.create_sled('Arctic Cat', 'M8000', 2019, 4000)::text;
with x as (insert into public.garages (name) values ('Old shop') returning id) insert into t select 'garage2', id::text from x;
insert into t select 'sled_old', public.create_sled('Ski-Doo', 'Summit', 2015, 9000, p_garage_id => pg_temp.v('garage2')::uuid)::text;
insert into t select 'tok_ed', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'cl-editor@example.com', 'editor');
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'cl-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'cl-view@example.com', 'viewer');
insert into t select 'tok_go', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'cl-gone@example.com', 'viewer');
select public.create_sled_invitation(pg_temp.v('sled')::uuid, 'someone-else@example.com', 'viewer');
insert into t select 'inv_old', i.id::text from public.sled_invitations i where i.email = 'someone-else@example.com';
select public.revoke_sled_invitation(pg_temp.v('inv_old')::uuid);
select public.create_sled_invitation(pg_temp.v('sled_old')::uuid, 'pending@example.com', 'viewer');
select pg_temp.as_user('c2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_ed'));
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('c4444444-4444-4444-4444-444444444444');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));
select pg_temp.as_user('c6666666-6666-6666-6666-666666666666');
select public.accept_sled_invitation(pg_temp.v('tok_go'));
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
insert into t select 'share_old', id::text from public.sled_shares where user_id = 'c6666666-6666-6666-6666-666666666666';
select public.revoke_sled_share(pg_temp.v('share_old')::uuid);

-- Issues and issue photos.
with x as (insert into public.sled_issues (sled_id, title, description) values
  (pg_temp.v('sled')::uuid, 'Cracked ski SECRET-TITLE', 'SECRET-NOTE') returning id) insert into t select 'iss_exp', id::text from x;
with x as (insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Recoverable') returning id) insert into t select 'iss_rec', id::text from x;
with x as (insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Exactly 30 days') returning id) insert into t select 'iss_edge', id::text from x;
with x as (insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Active') returning id) insert into t select 'iss_act', id::text from x;
with x as (insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Restored in time') returning id) insert into t select 'iss_race', id::text from x;
with x as (insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Backlog') returning id) insert into t select 'iss_backlog', id::text from x;
insert into public.sled_issue_photos (issue_id, sled_id, path) values
  (pg_temp.v('iss_exp')::uuid, pg_temp.v('sled')::uuid, pg_temp.p3('iss_exp_p1', 'sled', 'iss_exp')),
  (pg_temp.v('iss_exp')::uuid, pg_temp.v('sled')::uuid, pg_temp.p3('iss_exp_p2', 'sled', 'iss_exp')),
  (pg_temp.v('iss_act')::uuid, pg_temp.v('sled')::uuid, pg_temp.p3('iss_act_p', 'sled', 'iss_act')),
  (pg_temp.v('iss_act')::uuid, pg_temp.v('sled')::uuid, pg_temp.p3('iss_act_keep', 'sled', 'iss_act'));
insert into t select 'iss_act_p_id', id::text from public.sled_issue_photos where path = pg_temp.v('iss_act_p');

-- Suspension: settings, an old setup with a restore chain, feedback, photos.
with x as (insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'Compression', 'front_left_shock') returning id)
  insert into t select 'set_a', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled')::uuid, 'Old clicker', 'rear_general') returning id)
  insert into t select 'set_b', id::text from x;
insert into public.suspension_photos (sled_id, setting_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('set_b')::uuid, pg_temp.p3('set_b_p', 'sled', 'set_b'));
insert into t select 'su_keep', (public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Trail') ->> 'setup_id');
insert into t select 'su_old', (public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Old') ->> 'setup_id');
insert into t select 'rev_keep', id::text from public.suspension_revisions where setup_id = pg_temp.v('su_keep')::uuid;
insert into t select 'rev_old1', id::text from public.suspension_revisions where setup_id = pg_temp.v('su_old')::uuid;
select public.save_suspension_revision(pg_temp.v('su_old')::uuid, pg_temp.v('rev_old1')::uuid, jsonb_build_object(pg_temp.v('set_a'), '12'), p_idempotency_key => gen_random_uuid());
-- Revision 3 is a restore of revision 1 (restored_from_revision_id points inside the setup).
select public.restore_suspension_revision(pg_temp.v('rev_old1')::uuid, p_idempotency_key => gen_random_uuid());
insert into t select 'rev_old3', id::text from public.suspension_revisions where setup_id = pg_temp.v('su_old')::uuid and revision_number = 3;
with x as (insert into public.suspension_feedback (revision_id, sled_id, rating) values (pg_temp.v('rev_old3')::uuid, pg_temp.v('sled')::uuid, 'worse') returning id)
  insert into t select 'fb_old', id::text from x;
insert into public.suspension_photos (sled_id, revision_id, path) values (pg_temp.v('sled')::uuid, pg_temp.v('rev_old3')::uuid, pg_temp.p3('rev_old_p', 'sled', 'rev_old3'));
with x as (insert into public.suspension_feedback (revision_id, sled_id, rating) values (pg_temp.v('rev_keep')::uuid, pg_temp.v('sled')::uuid, 'improved') returning id)
  insert into t select 'fb_solo', id::text from x;
insert into public.suspension_photos (sled_id, revision_id, path) values
  (pg_temp.v('sled')::uuid, pg_temp.v('rev_keep')::uuid, pg_temp.p3('sus_ref_active', 'sled', 'rev_keep')),
  (pg_temp.v('sled')::uuid, pg_temp.v('rev_keep')::uuid, pg_temp.p3('sus_ref_deleted', 'sled', 'rev_keep'));

-- Maintenance: an old entry with a part; an old reading.
with x as (insert into public.maintenance_entries (sled_id, performed_on, title) values (pg_temp.v('sled')::uuid, current_date - 60, 'Old service') returning id)
  insert into t select 'ent_exp', id::text from x;
insert into public.maintenance_entry_parts (entry_id, sled_id, name) values (pg_temp.v('ent_exp')::uuid, pg_temp.v('sled')::uuid, 'Belt');
with x as (insert into public.sled_readings (sled_id, read_on, odometer_mi) values (pg_temp.v('sled')::uuid, current_date - 50, 1500) returning id)
  insert into t select 'rd_exp', id::text from x;
-- A resolved issue that links to the old service record.
with x as (insert into public.sled_issues (sled_id, title, status, reported_on, resolved_on, resolved_entry_id)
           values (pg_temp.v('sled')::uuid, 'Fixed by old service', 'resolved', current_date - 70, current_date - 60, pg_temp.v('ent_exp')::uuid) returning id)
  insert into t select 'iss_fixed', id::text from x;

-- The old sled has its own records (all removed with it).
insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled_old')::uuid, 'Old sled issue');
insert into public.suspension_settings (sled_id, name, zone) values (pg_temp.v('sled_old')::uuid, 'Preload', 'rear_springs_limiter');

-- Deletion times (as the database owner, so the dates can be set exactly).
reset role;
set local request.jwt.claims = '';
update public.sled_issues set deleted_at = pg_temp.expired() where id = pg_temp.v('iss_exp')::uuid;
update public.sled_issues set deleted_at = pg_temp.recoverable() where id = pg_temp.v('iss_rec')::uuid;
update public.sled_issues set deleted_at = now() - interval '30 days' where id = pg_temp.v('iss_edge')::uuid;
update public.sled_issues set deleted_at = pg_temp.expired() where id = pg_temp.v('iss_race')::uuid;
update public.sled_issues set deleted_at = now() - interval '40 days' where id = pg_temp.v('iss_backlog')::uuid;
update public.sled_issue_photos set deleted_at = pg_temp.expired() where id = pg_temp.v('iss_act_p_id')::uuid;
update public.suspension_settings set deleted_at = pg_temp.expired() where id = pg_temp.v('set_b')::uuid;
update public.suspension_setups set deleted_at = pg_temp.expired() where id = pg_temp.v('su_old')::uuid;
update public.suspension_feedback set deleted_at = pg_temp.expired() where id = pg_temp.v('fb_solo')::uuid;
update public.suspension_photos set deleted_at = pg_temp.recoverable() where path = pg_temp.v('sus_ref_deleted');
update public.maintenance_entries set deleted_at = pg_temp.expired() where id = pg_temp.v('ent_exp')::uuid;
update public.sled_readings set deleted_at = pg_temp.expired() where id = pg_temp.v('rd_exp')::uuid;
update public.sled_invitations set revoked_at = pg_temp.expired() where id = pg_temp.v('inv_old')::uuid;
update public.sled_shares set revoked_at = pg_temp.expired() where id = pg_temp.v('share_old')::uuid;
-- Snowmobiles and garages stamp their own deletion time; switched off briefly to backdate.
alter table public.sleds disable trigger guard;
alter table public.garages disable trigger guard;
update public.sleds set deleted_at = pg_temp.expired() where id = pg_temp.v('sled_old')::uuid;
update public.garages set deleted_at = pg_temp.expired() where id = pg_temp.v('garage2')::uuid;
update public.sleds set deleted_at = pg_temp.recoverable() where id = pg_temp.v('sled_rec')::uuid;
alter table public.sleds enable trigger guard;
alter table public.garages enable trigger guard;
-- Migration 8 was "installed" 5 days ago: rows eligible before then are backlog.
alter table private.cleanup_settings disable trigger guard;
update private.cleanup_settings set installed_at = now() - interval '5 days';
alter table private.cleanup_settings enable trigger guard;

-- ---------------------------------------------------------------------------
-- Structure and registries
-- ---------------------------------------------------------------------------
select has_table('private', 'cleanup_settings', 'cleanup_settings exists');
select has_table('private', 'cleanup_runs', 'cleanup_runs exists');
select has_table('private', 'cleanup_candidates', 'cleanup_candidates exists');
select has_table('private', 'storage_cleanup_claims', 'storage_cleanup_claims exists');
select is((select count(*)::int from pg_class where relnamespace = 'private'::regnamespace and relkind = 'r' and relrowsecurity
           and relname in ('cleanup_settings', 'cleanup_runs', 'cleanup_candidates', 'cleanup_record_tables',
                           'storage_cleanup_buckets', 'storage_reference_columns', 'storage_cleanup_claims')), 7,
  'RLS is on for all seven cleanup tables');
select is_empty($$
  select c.table_name from information_schema.columns c
  join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name and b.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'deleted_at'
  except select table_name from private.cleanup_record_tables $$,
  'every table with Recently Deleted is in the cleanup registry');
select is_empty($$ select table_name from private.cleanup_record_tables where to_regclass('public.' || table_name) is null $$,
  'every registered table exists');
select is_empty($$
  with recursive reach(rel) as (
    select ('public.' || table_name)::regclass::oid from private.cleanup_record_tables
    union select c.conrelid from pg_constraint c join reach r on c.confrelid = r.rel where c.contype = 'f' and c.confdeltype = 'c')
  select rel::regclass::text from reach
  except select tgrelid::regclass::text from pg_trigger where tgname = 'cleanup_count_deletes' $$,
  'every table a purge can reach counts its deleted rows');
select is_empty($$
  select conrelid::regclass::text from pg_constraint
  where contype = 'f' and confdeltype = 'c' and connamespace = 'public'::regnamespace and cardinality(conkey) > 1 $$,
  'every cascading foreign key is a single column (the group counter relies on it)');
-- The photo-reference registry cannot silently miss a column.
select is_empty($$
  select c.table_name || '.' || c.column_name from information_schema.columns c
  join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name and b.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and (c.column_name = 'path' or c.column_name like '%\_path')
  union
  select conrelid::regclass::text || '.' || a.attname from pg_constraint k
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
  where k.contype = 'c' and k.connamespace = 'public'::regnamespace and pg_get_constraintdef(k.oid) like '%(jpg|webp)%'
    and a.atttypid = 'text'::regtype
  except select table_name || '.' || column_name from private.storage_reference_columns
  except select 'public.' || table_name || '.' || column_name from private.storage_reference_columns $$,
  'every photo-path column is in the storage reference registry');
select is_empty($$
  select r.table_name || '.' || r.column_name from private.storage_reference_columns r
  where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || r.table_name) and a.attname = r.column_name)
     or not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || r.table_name) and g.tgname = 'storage_claim_guard') $$,
  'every registered photo column exists and is protected by the claim guard');
select is_empty($$ select id from storage.buckets where id like '%-photos' except select bucket_id from private.storage_cleanup_buckets $$,
  'every SledWerx photo bucket is registered');
select is((select string_agg(bucket_id, ',' order by bucket_id) from private.storage_reference_columns),
  'issue-photos,sled-photos,suspension-photos', 'each bucket has its reference column');

-- ---------------------------------------------------------------------------
-- Access control: service role and database owner only
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c, unnest(array['anon', 'authenticated']) r(role)
           where c.relnamespace = 'private'::regnamespace and c.relname in ('cleanup_settings', 'cleanup_runs', 'cleanup_candidates',
                 'cleanup_record_tables', 'storage_cleanup_buckets', 'storage_reference_columns', 'storage_cleanup_claims')
             and has_table_privilege(r.role, c.oid, 'select, insert, update, delete')), 0,
  'visitors and signed-in users have no access to the cleanup tables');
select is((select count(*)::int from pg_proc p, unnest(array['anon', 'authenticated']) r(role)
           where (p.proname like 'cleanup\_%' or p.proname like 'storage\_%' or p.proname like '%cleanup%' or p.proname = 'purge_expired_records'
                  or p.proname like 'expired\_record%')
             and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
             and p.proname not in ('storage_path_writable', 'cleanup_dashboard')
             and has_function_privilege(r.role, p.oid, 'execute')), 0,
  'visitors and signed-in users cannot run any cleanup function');
select is((select string_agg(r.role, ',' order by r.role) from unnest(array['anon', 'authenticated', 'service_role']) r(role)
           where has_function_privilege(r.role, 'private.storage_path_writable(text, text)', 'execute')), 'authenticated',
  'only the storage policies'' path check is callable by signed-in users (it returns a yes/no for one path)');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'cleanup\_%'
           and has_function_privilege('service_role', p.oid, 'execute')), 9,
  'the service role can run the nine cleanup API functions');
select is_empty($$
  select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    and (p.proname like '%cleanup%' or p.proname like 'storage\_%' or p.proname like 'expired\_record%')
    and p.proname not like 'tg\_%'
    and not (p.proconfig @> array['search_path=""'])
  $$, 'every cleanup function pins an empty search_path');
select is((select string_agg(distinct provolatile::text, '') from pg_proc
           where pronamespace = 'private'::regnamespace
             and proname in ('expired_record_candidates', 'expired_records_report', 'cleanup_cascade_rows',
                             'storage_file_candidates', 'storage_file_status', 'storage_path_referenced', 'storage_path_recognized')),
  's', 'every report function is STABLE, so PostgreSQL refuses any data change inside it');

set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select throws_ok($$ select public.cleanup_begin_run('report') $$, '42501', null, 'a garage owner cannot start a cleanup run');
select throws_ok($$ select * from private.cleanup_runs $$, '42501', null, 'a garage owner cannot read cleanup runs');
select throws_ok($$ select * from private.cleanup_candidates $$, '42501', null, 'a garage owner cannot read cleanup candidates');
select throws_ok($$ select private.purge_expired_records() $$, '42501', null, 'a garage owner cannot purge');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.cleanup_process_records(1) $$, '42501', null, 'a visitor cannot run cleanup');
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok($$ insert into t select 'svc_run', public.cleanup_begin_run('report')::text $$, 'the service role can start a report run');
select lives_ok($$ select public.cleanup_finish_run(pg_temp.v('svc_run')::bigint) $$, 'and finish it');
reset role;
set local request.jwt.claims = '';

-- ---------------------------------------------------------------------------
-- Settings: deletion off by default, guarded
-- ---------------------------------------------------------------------------
select is((select format('%s|%s|%s|%s|%s|%s', deletion_enabled::text, max_records_per_run, max_files_per_run,
                         bucket_threshold_percent, min_file_age, required_report_runs) from private.cleanup_settings),
  'false|200|100|10.00|24:00:00|7', 'deletion is off; limits 200 records, 100 files, 10% of a bucket, 24 hours, 7 report runs');
select throws_ok($$ select private.cleanup_begin_run('delete') $$, '42501', 'Cleanup deletion is not authorized.',
  'a delete run cannot start while deletion is off');
select throws_ok($$ update private.cleanup_settings set min_file_age = interval '23 hours' $$, '23514', null,
  'the 24-hour minimum age cannot be lowered');
select throws_ok($$ update private.cleanup_settings set required_report_runs = 3 $$, '23514', null,
  'the 7 report runs cannot be lowered');
select throws_ok($$ select private.authorize_cleanup_deletion('  ') $$, '42501',
  'Record the verified database and Storage-photo backup before enabling deletion.', 'deletion needs a backup reference');
select throws_ok($$ select private.authorize_cleanup_deletion('Backup 2026-11-20') $$, '42501',
  'Deletion needs 7 successful daily report-only runs first (0 so far).', 'deletion needs 7 successful daily report runs');
select throws_ok($$ delete from private.cleanup_settings $$, '42501', 'The cleanup settings row cannot be removed.',
  'the settings row cannot be removed');
update private.cleanup_settings set installed_at = now();
select ok((select installed_at < now() - interval '4 days' from private.cleanup_settings), 'installed_at cannot be changed');

-- ---------------------------------------------------------------------------
-- Recovery boundaries
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select throws_ok($$ update public.sled_issues set deleted_at = null where id = pg_temp.v('iss_exp')::uuid $$, '42501',
  'This record is past the 30-day recovery period.', '30 days and 1 minute after deletion, a record can no longer be restored');
select lives_ok($$ update public.sled_issues set deleted_at = null where id = pg_temp.v('iss_edge')::uuid $$,
  'exactly 30 days after deletion, a record can still be restored');
reset role;
set local request.jwt.claims = '';
update public.sled_issues set deleted_at = now() - interval '30 days' where id = pg_temp.v('iss_edge')::uuid;

-- Storage is read before any file exists: records point at files but Storage
-- looks empty, so nothing would be removed.
select is((private.cleanup_report_files(private.cleanup_begin_run('report', 'manual')) ->> 'storage_unreadable')::boolean, true,
  'empty Storage while records point at files is flagged as unreadable');
select is((select count(*)::int from private.cleanup_runs r, jsonb_each(r.summary -> 'files' -> 'buckets') b
           where r.status = 'running' and (b.value ->> 'blocked')::boolean), 3,
  'and every bucket is blocked');
select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';

-- Files in Storage.
select pg_temp.object('suspension-photos', pg_temp.v('sus_ref_active'), interval '2 days');
select pg_temp.object('suspension-photos', pg_temp.v('sus_ref_deleted'), interval '2 days');
select pg_temp.object('suspension-photos', pg_temp.v('set_b_p'), interval '40 days');
select pg_temp.object('suspension-photos', pg_temp.v('rev_old_p'), interval '40 days');
select pg_temp.object('suspension-photos', pg_temp.p3('sus_new', 'sled', 'rev_keep'), interval '23 hours 59 minutes');
select pg_temp.object('suspension-photos', pg_temp.p3('sus_24h', 'sled', 'rev_keep'), interval '24 hours');
select pg_temp.object('suspension-photos', pg_temp.p3('sus_touched', 'sled', 'rev_keep'), interval '3 days', interval '1 hour');
select pg_temp.object('suspension-photos', 'notes/readme.txt', interval '90 days');
insert into t values ('sus_upper', upper(pg_temp.v('sled')) || '/' || pg_temp.v('rev_keep') || '/' || gen_random_uuid() || '.jpg');
select pg_temp.object('suspension-photos', pg_temp.v('sus_upper'), interval '90 days');
select pg_temp.object('issue-photos', pg_temp.v('iss_exp_p1'), interval '40 days');
select pg_temp.object('issue-photos', pg_temp.v('iss_exp_p2'), interval '40 days');
select pg_temp.object('issue-photos', pg_temp.v('iss_act_keep'), interval '40 days');
select pg_temp.object('issue-photos', pg_temp.p3('iss_orphan', 'sled', 'iss_act'), interval '3 days');
select pg_temp.object('issue-photos', pg_temp.p3('iss_extra1', 'sled', 'iss_act'), interval '3 days');
select pg_temp.object('issue-photos', pg_temp.p3('iss_extra2', 'sled', 'iss_act'), interval '3 days');
insert into t values ('sled_photo', pg_temp.v('sled') || '/' || gen_random_uuid() || '.jpg');
update public.sleds set photo_path = pg_temp.v('sled_photo') where id = pg_temp.v('sled')::uuid;
select pg_temp.object('sled-photos', pg_temp.v('sled_photo'), interval '10 days');
insert into t values ('sled_orphan', pg_temp.v('sled') || '/' || gen_random_uuid() || '.jpg');
select pg_temp.object('sled-photos', pg_temp.v('sled_orphan'), interval '10 days');

-- A mechanic's adjustment-photo upload whose record was never saved.
set local role authenticated;
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
-- (Uploaded 25 hours ago: the timestamps are set on insert, because Storage
-- resets updated_at on every update.)
select lives_ok($$ insert into storage.objects (bucket_id, name, created_at, updated_at, metadata)
                    values ('suspension-photos', pg_temp.p3('sus_mech', 'sled', 'rev_keep'), now() - interval '25 hours', now() - interval '25 hours',
                            '{"eTag": "\"mech\"", "size": 2048}') $$,
  'a mechanic uploads an adjustment photo (its record is never saved)');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'suspension-photos' and name = pg_temp.v('sus_mech');
select set_config('storage.allow_delete_query', 'false', true);
reset role;
set local request.jwt.claims = '';
select ok(exists (select 1 from storage.objects where name = pg_temp.v('sus_mech')),
  'mechanics still cannot delete photo files (storage policy unchanged)');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and policyname like 'SledWerx%' and permissive = 'PERMISSIVE'), 10,
  'the ten existing SledWerx storage policies are unchanged');
select is((select string_agg(cmd || ':' || permissive, ',' order by cmd) from pg_policies
           where schemaname = 'storage' and policyname like 'SledWerx cleanup:%'), 'INSERT:RESTRICTIVE,UPDATE:RESTRICTIVE',
  'the cleanup adds only two restrictive storage policies (uploads and overwrites)');

-- ---------------------------------------------------------------------------
-- Report-only run
-- ---------------------------------------------------------------------------
insert into t select 'rows_before', pg_temp.all_rows()::text;
insert into t select 'objects_before', count(*)::text from storage.objects;
insert into t select 'run_report', pg_temp.run('report')::text;
select private.cleanup_finish_run(pg_temp.v('run_report')::bigint);

select is(pg_temp.all_rows()::text, pg_temp.v('rows_before'), 'a report run deletes no row');
select is((select count(*)::text from storage.objects), pg_temp.v('objects_before'), 'and no file');
select is((select records_deleted + files_deleted from private.cleanup_runs where id = pg_temp.v('run_report')::bigint), 0,
  'and records nothing as deleted');
select is((select count(*)::int from private.storage_cleanup_claims), 0, 'and claims no file');
select is((select string_agg(outcome || '=' || n, ',' order by outcome) from (
             select outcome, count(*) n from private.cleanup_candidates
             where run_id = pg_temp.v('run_report')::bigint and kind = 'record' group by outcome) x),
  'in_group=9,would_delete=13', 'it lists 13 deletion groups and 9 rows deleted with them');

-- Which rows.
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issues', 'iss_exp'), 'would_delete', 'an issue past 30 days is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issues', 'iss_backlog'), 'would_delete', 'so is an older backlog issue');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issues', 'iss_rec'), null, 'a recoverable issue is not listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issues', 'iss_edge'), null, 'an issue deleted exactly 30 days ago is not listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issues', 'iss_act'), null, 'an active issue is not listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_issue_photos', 'iss_act_p_id'), 'would_delete',
  'a photo removed on its own from an active issue is its own group');
select is((select string_agg(outcome || ' ' || group_parent, ',') from private.cleanup_candidates
           where run_id = pg_temp.v('run_report')::bigint and table_name = 'sled_issue_photos' and group_parent is not null),
  format('in_group sled_issues:%s,in_group sled_issues:%s', pg_temp.v('iss_exp'), pg_temp.v('iss_exp')),
  'the photos of a deleted issue go with the issue');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'suspension_setups', 'su_old'), 'would_delete', 'a deleted setup is listed');
select is((select count(*)::int from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint
           and table_name = 'suspension_revisions' and outcome = 'in_group'
           and group_parent = 'suspension_setups:' || pg_temp.v('su_old')), 3,
  'its three revisions (one restored from another) go with it');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'suspension_feedback', 'fb_old'), 'in_group', 'so does its feedback');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'suspension_feedback', 'fb_solo'), 'would_delete',
  'feedback removed on its own from an active revision is its own group');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'suspension_settings', 'set_b'), 'would_delete', 'a deleted setting is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'suspension_settings', 'set_a'), null, 'an active setting is not');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'maintenance_entries', 'ent_exp'), 'would_delete', 'an old service record is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_readings', 'rd_exp'), 'would_delete', 'an old reading is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_invitations', 'inv_old'), 'would_delete', 'an invitation revoked 30 days ago is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sled_shares', 'share_old'), 'would_delete', 'a share revoked 30 days ago is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sleds', 'sled_old'), 'would_delete', 'a snowmobile past 30 days is listed');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'sleds', 'sled_rec'), null, 'a recoverable snowmobile is not');
select is(pg_temp.outcome(pg_temp.v('run_report')::bigint, 'garages', 'garage2'), 'would_delete',
  'a deleted garage is listed once its only snowmobile is listed too');
select is((select group_rows from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('iss_exp')::uuid),
  3, 'the issue''s group is 3 rows (the issue and two photos)');
select is((select group_rows from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('su_old')::uuid),
  6, 'the setup''s group is 6 rows (setup, 3 revisions, feedback, photo)');
select ok((select (group_detail ->> 'audit_log')::int > 0 and (group_detail ->> 'sled_issues')::int = 1
                  and (group_detail ->> 'sled_invitations')::int = 1 and (group_detail ->> 'sled_readings')::int = 1
           from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('sled_old')::uuid),
  'the snowmobile''s group counts everything removed with it, its audit history included');
select is((select string_agg(backlog::text, ',' order by expired_at) from private.cleanup_candidates
           where run_id = pg_temp.v('run_report')::bigint and record_id in (pg_temp.v('iss_backlog')::uuid, pg_temp.v('iss_exp')::uuid)),
  'true,false', 'records already overdue when Migration 8 was installed are marked as backlog');
select is((select (summary -> 'records' ->> 'backlog')::int from private.cleanup_runs where id = pg_temp.v('run_report')::bigint), 1,
  'the run summary counts backlog separately');
select is((select sled_id::text from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('iss_exp')::uuid),
  pg_temp.v('sled'), 'each candidate names its snowmobile');
select is_empty($$ select 1 from private.cleanup_candidates c
  where c::text like '%SECRET%' or c::text like '%someone-else@%' or c::text like '%Cracked ski%' $$,
  'no titles, notes or email addresses are recorded');
select throws_ok($$ select private.cleanup_process_records(pg_temp.v('run_report')::bigint) $$, '55000', null,
  'a finished run cannot be processed again');

-- Files in the report.
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'sus_mech'), 'would_delete',
  'the mechanic''s orphaned upload is found (a bucket under 100 files has no percentage threshold)');
select is((select summary -> 'files' -> 'buckets' -> 'suspension-photos' from private.cleanup_runs where id = pg_temp.v('run_report')::bigint),
  '{"objects": 10, "orphans": 2, "too_new": 2, "referenced": 4, "unrecognized": 2, "metadata_missing": 0, "reference_rows": 4,
    "threshold_applies": false, "blocked": false, "blocked_reason": null}'::jsonb,
  'suspension photos: 4 referenced (active and deleted records), 2 orphans, 2 too new, 2 unrecognised');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'sus_ref_deleted'), null,
  'a file of a record in Recently Deleted is referenced, never a candidate');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'sus_new'), null, 'a file 23 h 59 min old is too new');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'sus_touched'), null, 'an old file updated an hour ago is too new');
select is((select count(*)::int from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint
           and object_path in ('notes/readme.txt', pg_temp.v('sus_upper')) and outcome = 'unrecognized'), 2,
  'unknown paths (other names, upper-case ids) are listed as unrecognised, never as removable');
select is(pg_temp.file_outcome(pg_temp.v('run_report')::bigint, 'iss_exp_p1'), null,
  'files of records awaiting purge are still referenced');
select is((select string_agg(object_path, ',') from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint
           and bucket_id = 'sled-photos'), pg_temp.v('sled_orphan'), 'an unused snowmobile photo is an orphan; the current one is not');
select is(private.storage_file_status('suspension-photos', pg_temp.v('sus_24h'), now() - interval '24 hours', now() - interval '24 hours', '{"eTag": "x", "size": 1}'::jsonb, now()), 'orphan',
  'exactly 24 hours old counts as old enough');
select is(private.storage_file_status('suspension-photos', pg_temp.v('sus_24h'), now() - interval '24 hours' + interval '1 second', now() - interval '2 days', '{"eTag": "x", "size": 1}'::jsonb, now()), 'too_new',
  'one second less does not');
select is(private.storage_file_status('suspension-photos', pg_temp.v('sus_24h'), null, null, '{"eTag": "x", "size": 1}'::jsonb, now()), 'metadata_missing',
  'a file without Storage timestamps is never removable');
select is(private.storage_file_status('suspension-photos', pg_temp.v('sus_24h'), now() - interval '9 days', now() - interval '9 days', '{"size": 1}', now()), 'metadata_missing',
  'neither is a file without an eTag (its identity could not be checked)');
select is(private.storage_file_status('suspension-photos', '../' || pg_temp.v('sus_24h'), now() - interval '9 days', now() - interval '9 days', '{"eTag": "x", "size": 1}'::jsonb, now()), 'unrecognized',
  'a path outside the expected format is unrecognised');

-- ---------------------------------------------------------------------------
-- Restoring just before deletion
-- ---------------------------------------------------------------------------
update public.sled_issues set deleted_at = null where id = pg_temp.v('iss_race')::uuid;
select is(private.cleanup_delete_root('sled_issues', pg_temp.v('iss_race')::uuid, now() - interval '30 days'), 0,
  'a record restored after the report is not deleted (eligibility is checked again in the delete)');
select ok(pg_temp.exists_in('sled_issues', 'iss_race'), 'it is still there');
select is(private.cleanup_delete_root('garages', pg_temp.v('garage2')::uuid, now() - interval '30 days'), 0,
  'a garage that still has a snowmobile is never deleted');

-- ---------------------------------------------------------------------------
-- Delete run
-- ---------------------------------------------------------------------------
insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now() - d * interval '1 day', now() - d * interval '1 day'
from generate_series(1, 6) d;
select lives_ok($$ select private.authorize_cleanup_deletion('Supabase backup 2026-11-20 + photo export') $$,
  'with 7 successful daily report runs and a backup reference, deletion can be authorized');
select ok((select deletion_enabled and deletion_authorized_at is not null from private.cleanup_settings), 'deletion is now authorized');

insert into t select 'run_delete', private.cleanup_begin_run('delete')::text;
insert into t select 'delete_result', private.cleanup_process_records(pg_temp.v('run_delete')::bigint)::text;

select is((select string_agg(outcome || '=' || n, ',' order by outcome) from (
             select outcome, count(*) n from private.cleanup_candidates
             where run_id = pg_temp.v('run_delete')::bigint and kind = 'record' group by outcome) x),
  'deleted=12,in_group=9', 'the delete run removes the 12 groups still eligible');
select ok(not pg_temp.exists_in('sled_issues', 'iss_exp'), 'the expired issue is gone');
select is((select count(*)::int from public.sled_issue_photos where issue_id = pg_temp.v('iss_exp')::uuid), 0, 'with its photos');
select ok(pg_temp.exists_in('sled_issues', 'iss_rec') and pg_temp.exists_in('sled_issues', 'iss_edge') and pg_temp.exists_in('sled_issues', 'iss_act'),
  'recoverable, exactly-30-day and active issues stay');
select is((select count(*)::int from public.sled_issue_photos where issue_id = pg_temp.v('iss_act')::uuid), 1,
  'the active issue keeps its other photo');
select ok(not pg_temp.exists_in('suspension_setups', 'su_old') and not exists (select 1 from public.suspension_revisions where setup_id = pg_temp.v('su_old')::uuid),
  'the deleted setup and its restore chain of revisions are gone');
select ok(pg_temp.exists_in('suspension_setups', 'su_keep') and pg_temp.exists_in('suspension_settings', 'set_a'),
  'the active setup and setting stay');
select ok(not pg_temp.exists_in('suspension_feedback', 'fb_solo') and not pg_temp.exists_in('suspension_settings', 'set_b'),
  'the deleted feedback and setting are gone');
select ok(not pg_temp.exists_in('maintenance_entries', 'ent_exp') and not exists (select 1 from public.maintenance_entry_parts where entry_id = pg_temp.v('ent_exp')::uuid),
  'the old service record and its part are gone');
select is((select status || '|' || coalesce(resolved_entry_id::text, 'none') from public.sled_issues where id = pg_temp.v('iss_fixed')::uuid),
  'resolved|none', 'an active issue resolved by a purged service record stays, without the link');
select ok(not pg_temp.exists_in('sled_readings', 'rd_exp'), 'the old reading is gone');
select ok(not pg_temp.exists_in('sleds', 'sled_old') and not pg_temp.exists_in('garages', 'garage2'),
  'the old snowmobile and then its garage are gone');
select is((select count(*)::int from public.audit_log where sled_id = pg_temp.v('sled_old')::uuid), 0,
  'the purged snowmobile''s audit history went with it');
select ok((select count(*) from public.audit_log where record_id = pg_temp.v('iss_exp')::uuid) > 0,
  'audit history of a purged issue stays until its snowmobile is purged');
select ok(not pg_temp.exists_in('sled_invitations', 'inv_old') and not pg_temp.exists_in('sled_shares', 'share_old'),
  'the old invitation and revoked share are gone');
select ok(pg_temp.exists_in('sleds', 'sled_rec') and pg_temp.exists_in('sleds', 'sled'), 'other snowmobiles stay');
select is((select records_deleted from private.cleanup_runs where id = pg_temp.v('run_delete')::bigint),
  (select sum(group_rows)::int from private.cleanup_candidates where run_id = pg_temp.v('run_delete')::bigint and outcome = 'deleted'),
  'the run counts every row actually deleted, cascades included');
select is((select group_rows from private.cleanup_candidates where run_id = pg_temp.v('run_delete')::bigint and record_id = pg_temp.v('sled_old')::uuid),
  (select group_rows from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('sled_old')::uuid),
  'the rows actually deleted with the snowmobile match the report''s estimate');
select is((select sum(group_rows)::int from private.cleanup_candidates where run_id = pg_temp.v('run_delete')::bigint and outcome = 'deleted'),
  (select sum(group_rows)::int from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and outcome = 'would_delete')
  - (select group_rows from private.cleanup_candidates where run_id = pg_temp.v('run_report')::bigint and record_id = pg_temp.v('iss_race')::uuid),
  'every group deleted exactly the rows the report predicted');
select is((pg_temp.v('delete_result')::jsonb -> 'deleted_groups' ->> 'sleds')::int, 1, 'the result counts groups per table');

-- Files after the purge: the purged records' photos are now orphans.
select is((private.cleanup_report_files(pg_temp.v('run_delete')::bigint) -> 'buckets' -> 'issue-photos' ->> 'orphans')::int, 5,
  'after the purge, the purged issue''s two photos join the three unused issue photos as orphans');
select private.cleanup_finish_run(pg_temp.v('run_delete')::bigint);

-- Repeating is harmless.
insert into t select 'run_again', private.cleanup_begin_run('delete')::text;
select is((private.cleanup_process_records(pg_temp.v('run_again')::bigint) ->> 'candidates')::int, 0,
  'a second run finds nothing left to delete');
select private.cleanup_finish_run(pg_temp.v('run_again')::bigint);
select is((select records_deleted from private.cleanup_runs where id = pg_temp.v('run_again')::bigint), 0, 'and deletes nothing');

-- ---------------------------------------------------------------------------
-- Limits (cascades count)
-- ---------------------------------------------------------------------------
do $$
declare i int; v_issue uuid;
begin
  for i in 1..3 loop
    insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Limit ' || i) returning id into v_issue;
    insert into t values ('lim' || i, v_issue::text);
    insert into public.sled_issue_photos (issue_id, sled_id, path) values
      (v_issue, pg_temp.v('sled')::uuid, pg_temp.v('sled') || '/' || v_issue || '/' || gen_random_uuid() || '.jpg'),
      (v_issue, pg_temp.v('sled')::uuid, pg_temp.v('sled') || '/' || v_issue || '/' || gen_random_uuid() || '.jpg');
    update public.sled_issues set deleted_at = pg_temp.expired() - i * interval '1 hour' where id = v_issue;
  end loop;
end;
$$;
update private.cleanup_settings set max_records_per_run = 5;
insert into t select 'run_lim', private.cleanup_begin_run('delete')::text;
select private.cleanup_process_records(pg_temp.v('run_lim')::bigint);
select private.cleanup_finish_run(pg_temp.v('run_lim')::bigint);
select is((select string_agg(outcome, ',' order by eligible_since) from private.cleanup_candidates
           where run_id = pg_temp.v('run_lim')::bigint and table_name = 'sled_issues'),
  'deleted,deferred,deferred', 'with a limit of 5 rows, one 3-row group fits; the run stops before the next');
select is((select records_deleted from private.cleanup_runs where id = pg_temp.v('run_lim')::bigint), 3,
  'the 3 rows (issue and two photos) count against the limit');
select ok(pg_temp.exists_in('sled_issues', 'lim2') and pg_temp.exists_in('sled_issues', 'lim1'), 'the deferred issues are untouched');
select is((select count(*)::int from public.sled_issue_photos where issue_id in (pg_temp.v('lim1')::uuid, pg_temp.v('lim2')::uuid)), 4,
  'with all their photos');

-- A group larger than the whole limit is skipped; smaller ones still go.
update private.cleanup_settings set max_records_per_run = 2;
update public.sled_issue_photos set deleted_at = pg_temp.expired() where path = pg_temp.v('iss_act_keep');
insert into t select 'run_big', private.cleanup_begin_run('delete')::text;
select private.cleanup_process_records(pg_temp.v('run_big')::bigint);
select private.cleanup_finish_run(pg_temp.v('run_big')::bigint);
select is((select string_agg(table_name || ':' || outcome, ',' order by sort_key) from (
             select table_name, outcome, coalesce(eligible_since::text, '') || table_name as sort_key from private.cleanup_candidates
             where run_id = pg_temp.v('run_big')::bigint and group_parent is null) x),
  'sled_issues:too_large,sled_issues:too_large,sled_issue_photos:deleted',
  'groups over the whole limit are reported as too large; a 1-row group is still deleted');
select is((select jsonb_array_length(summary -> 'records' -> 'too_large') || '|' || (summary -> 'records' ->> 'needs_review')
           from private.cleanup_runs where id = pg_temp.v('run_big')::bigint), '2|true',
  'each oversized group is listed (id and size) and the run is flagged for review');
select is((select count(*)::int from private.cleanup_review where outcome = 'too_large' and group_rows = 3 and detail like 'Needs administrator review%'), 2,
  'the review list shows them with their size and reason');

-- Safety net: if a group turns out larger than its estimate, the deletion is
-- undone and the run stops (simulated with a wrong estimate).
alter function private.cleanup_cascade_rows(text, uuid) rename to cleanup_cascade_rows_real;
create function private.cleanup_cascade_rows(p_table text, p_id uuid) returns jsonb language sql stable as $$ select '{"x": 1}'::jsonb $$;
update private.cleanup_settings set max_records_per_run = 5;
insert into t select 'run_net', private.cleanup_begin_run('delete')::text;
select private.cleanup_process_records(pg_temp.v('run_net')::bigint);
select private.cleanup_finish_run(pg_temp.v('run_net')::bigint);
drop function private.cleanup_cascade_rows(text, uuid);
alter function private.cleanup_cascade_rows_real(text, uuid) rename to cleanup_cascade_rows;
select is((select string_agg(outcome, ',' order by eligible_since) from private.cleanup_candidates
           where run_id = pg_temp.v('run_net')::bigint and table_name = 'sled_issues'),
  'deleted,deferred', 'the group that went over the limit was stopped');
select ok(pg_temp.exists_in('sled_issues', 'lim1'), 'and its deletion was undone');
select is((select count(*)::int from public.sled_issue_photos where issue_id = pg_temp.v('lim1')::uuid), 2, 'photos included');
select is((select records_deleted from private.cleanup_runs where id = pg_temp.v('run_net')::bigint), 3,
  'only the rows actually kept deleted are counted');
update private.cleanup_settings set max_records_per_run = 200;

-- ---------------------------------------------------------------------------
-- Claiming files (delete runs)
-- ---------------------------------------------------------------------------
insert into t values ('sled_claim', pg_temp.v('sled') || '/' || gen_random_uuid() || '.jpg');
select pg_temp.object('sled-photos', pg_temp.v('sled_claim'), interval '10 days');
select throws_ok($$ select private.cleanup_claim_file(pg_temp.v('run_report')::bigint, 'suspension-photos', pg_temp.v('sus_mech')) $$,
  '55000', null, 'a report run cannot claim files');
insert into t select 'run_files', pg_temp.run('delete')::text;
select is(pg_temp.file_outcome(pg_temp.v('run_files')::bigint, 'sus_mech'), 'eligible',
  'in a delete run, the mechanic''s orphaned upload becomes removable');
select is((select string_agg(object_path, ',' order by object_path) from private.cleanup_candidates
           where run_id = pg_temp.v('run_files')::bigint and outcome = 'eligible' and bucket_id = 'suspension-photos'),
  (select string_agg(p, ',' order by p) from unnest(array[pg_temp.v('sus_mech'), pg_temp.v('sus_24h'), pg_temp.v('set_b_p'), pg_temp.v('rev_old_p')]) p),
  'only orphans at least 24 hours old are removable (here: the mechanic''s upload, a 24-hour file, two purged records'' photos)');
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_ref_active')) ->> 'reason'), 'not_listed',
  'a referenced file cannot be claimed');
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_mech')) ->> 'claimed')::boolean, true,
  'an orphan is claimed after the checks are repeated under its lock');
set local role authenticated;
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into public.suspension_photos (sled_id, revision_id, path)
                    values (pg_temp.v('sled')::uuid, pg_temp.v('rev_keep')::uuid, pg_temp.v('sus_mech')) $$,
  '55006', 'This photo is being removed. Add it again.', 'a claimed file cannot be attached to a record');
reset role;
set local request.jwt.claims = '';
select is((private.cleanup_record_file_result(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_mech'), true) ->> 'status'), 'released',
  'a file reported removed but still in Storage is not marked deleted');
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_mech')) ->> 'reason'), 'not_listed',
  'and it is not tried again in the same run');

select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_24h')) ->> 'claimed')::boolean, true,
  'another orphan is claimed');
insert into t select 'sus_24h_obj', jsonb_build_object('id', id, 'name', name, 'metadata', metadata)::text from storage.objects where name = pg_temp.v('sus_24h');
select is((private.cleanup_verify_claim(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_24h')) ->> 'ok')::boolean, true,
  'right before removal, the file is still exactly the claimed one');
select pg_temp.remove_object('suspension-photos', pg_temp.v('sus_24h'));
select is((private.cleanup_record_file_result(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_24h'), true, null,
                                              pg_temp.v('sus_24h_obj')::jsonb) ->> 'status'), 'deleted',
  'Storage removed exactly the claimed object: recorded as deleted');
select is((select files_deleted from private.cleanup_runs where id = pg_temp.v('run_files')::bigint), 1, 'and counted');
select throws_ok($$ select private.cleanup_record_file_result(pg_temp.v('run_files')::bigint, 'suspension-photos', pg_temp.v('sus_24h'), true) $$,
  '55000', null, 'a result cannot be recorded twice');
select throws_ok($$ insert into public.suspension_photos (sled_id, revision_id, path)
                    values (pg_temp.v('sled')::uuid, pg_temp.v('rev_keep')::uuid, pg_temp.v('sus_24h')) $$,
  '55006', 'This photo was removed. Add it again.', 'a removed path can never be attached to a record again');

-- Claimed files cannot be overwritten or uploaded again (restrictive storage policies).
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'sled-photos', pg_temp.v('sled_claim')) ->> 'claimed')::boolean, true,
  'an unused snowmobile photo is claimed');
set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
update storage.objects set metadata = metadata || '{"eTag": "\"overwritten\""}' where bucket_id = 'sled-photos' and name = pg_temp.v('sled_claim');
update storage.objects set metadata = metadata || '{"eTag": "\"replaced\""}' where bucket_id = 'sled-photos' and name = pg_temp.v('sled_photo');
reset role;
set local request.jwt.claims = '';
select is((select metadata ->> 'eTag' from storage.objects where name = pg_temp.v('sled_claim')), '"' || md5(pg_temp.v('sled_claim')) || '"',
  'an owner cannot overwrite a claimed photo');
select is((select metadata ->> 'eTag' from storage.objects where name = pg_temp.v('sled_photo')), '"replaced"',
  'an owner can still replace an unclaimed snowmobile photo (existing permission)');
set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'sled-photos' and name = pg_temp.v('sled_claim');
select set_config('storage.allow_delete_query', 'false', true);
select throws_ok($$ insert into storage.objects (bucket_id, name, metadata) values ('sled-photos', pg_temp.v('sled_claim'), '{"eTag": "x", "size": 1}') $$,
  '42501', null, 'after removing a claimed photo, an owner cannot upload a new one at the same path');
select lives_ok($$ insert into storage.objects (bucket_id, name, metadata)
                    values ('sled-photos', pg_temp.v('sled') || '/' || gen_random_uuid() || '.jpg', '{"eTag": "x", "size": 1}') $$,
  'uploads to new paths work as before');
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into storage.objects (bucket_id, name, metadata) values ('suspension-photos', pg_temp.v('sus_24h'), '{"eTag": "x", "size": 1}') $$,
  '42501', null, 'nobody can upload at a path the cleanup removed');
select lives_ok($$ insert into storage.objects (bucket_id, name, metadata)
                    values ('suspension-photos', pg_temp.v('sled') || '/' || pg_temp.v('rev_keep') || '/' || gen_random_uuid() || '.jpg', '{"eTag": "x", "size": 1}') $$,
  'a mechanic''s adjustment-photo uploads to new paths work as before');
reset role;
set local request.jwt.claims = '';
select ok(not exists (select 1 from storage.objects where name = pg_temp.v('sled_claim')), 'owners can still remove a claimed photo (existing permission)');

-- Attached between the report and the claim: the record wins.
insert into public.sled_issue_photos (issue_id, sled_id, path) values (pg_temp.v('iss_act')::uuid, pg_temp.v('sled')::uuid, pg_temp.v('iss_orphan'));
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'issue-photos', pg_temp.v('iss_orphan')) ->> 'reason'), 'referenced',
  'a file attached to a record after the report is not claimed');
-- Re-uploaded meanwhile: too new again.
update storage.objects set updated_at = now() where name = pg_temp.v('sled_orphan');
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'sled-photos', pg_temp.v('sled_orphan')) ->> 'reason'), 'too_new',
  'a file changed after the report is not claimed');
-- Gone meanwhile.
select pg_temp.remove_object('issue-photos', pg_temp.v('iss_exp_p1'));
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'issue-photos', pg_temp.v('iss_exp_p1')) ->> 'reason'), 'missing',
  'a file already gone is not claimed');
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'issue-photos', pg_temp.v('iss_exp_p2')) ->> 'claimed')::boolean, true,
  'a purged record''s photo is claimed');
update private.cleanup_settings set max_files_per_run = 3;
select is((private.cleanup_claim_file(pg_temp.v('run_files')::bigint, 'issue-photos', pg_temp.v('iss_extra1')) ->> 'reason'), 'run_limit',
  'no more files than the per-run limit are claimed');
update private.cleanup_settings set max_files_per_run = 100;
select is((select status from private.storage_cleanup_claims where object_path = pg_temp.v('iss_exp_p2')), 'claimed', 'one claim is still open');
select private.cleanup_finish_run(pg_temp.v('run_files')::bigint);
select is((select status from private.storage_cleanup_claims where object_path = pg_temp.v('iss_exp_p2')), 'released',
  'finishing a run releases the claims it never reported on');

-- Same-path replacement: the object is identified by its Storage id, eTag and size.
select pg_temp.object('suspension-photos', pg_temp.p3('sus_v1', 'sled', 'rev_keep'), interval '3 days');
select pg_temp.object('suspension-photos', pg_temp.p3('sus_v2', 'sled', 'rev_keep'), interval '3 days');
insert into t select 'run_verify', pg_temp.run('delete')::text;
select ok((select count(*) from public.cleanup_eligible_files(pg_temp.v('run_verify')::bigint) e
           where e.object_path in (pg_temp.v('sus_v1'), pg_temp.v('sus_v2'), pg_temp.v('sus_mech'))) = 3,
  'the job gets the run''s removable files from the database');
select throws_ok($$ select private.cleanup_verify_claim(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_v1')) $$,
  '55000', null, 'a file that was not claimed cannot be verified');
select is((private.cleanup_claim_file(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_v1')) ->> 'claimed')::boolean, true,
  'a file is claimed');
select is((select object_etag || '|' || object_size from private.storage_cleanup_claims where object_path = pg_temp.v('sus_v1')),
  '"' || md5(pg_temp.v('sus_v1')) || '"|1234', 'the claim records exactly which object it is');
-- Replaced at the same path after the claim (new content, same row).
update storage.objects set metadata = metadata || '{"eTag": "\"replacement\""}' where name = pg_temp.v('sus_v1');
select is((private.cleanup_verify_claim(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_v1')) ->> 'reason'), 'changed',
  'a file replaced after the claim fails the check right before removal');
select is((select status from private.storage_cleanup_claims where object_path = pg_temp.v('sus_v1')), 'released',
  'its claim is released, so it is not removed');
-- Replaced by a new upload (new row) after the claim.
select is((private.cleanup_claim_file(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_v2')) ->> 'claimed')::boolean, true,
  'another file is claimed');
insert into t select 'sus_v2_obj', jsonb_build_object('id', id, 'metadata', metadata)::text from storage.objects where name = pg_temp.v('sus_v2');
select pg_temp.remove_object('suspension-photos', pg_temp.v('sus_v2'));
select pg_temp.object('suspension-photos', pg_temp.v('sus_v2'), interval '3 days');
select is((private.cleanup_verify_claim(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_v2')) ->> 'reason'), 'changed',
  'a file deleted and uploaded again at the same path also fails the check');
-- Replaced in the moment between the check and the removal: detected afterwards.
select is((private.cleanup_claim_file(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_mech')) ->> 'claimed')::boolean, true,
  'the mechanic''s orphaned upload is claimed');
select is((private.cleanup_verify_claim(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_mech')) ->> 'ok')::boolean, true,
  'and passes the check');
select is((private.cleanup_record_file_result(pg_temp.v('run_verify')::bigint, 'suspension-photos', pg_temp.v('sus_mech'), true, null,
             (select jsonb_build_object('id', gen_random_uuid(), 'metadata', '{"eTag": "\"other\"", "size": 9}'::jsonb))) ->> 'status'),
  'replaced', 'if Storage reports removing a different object, it is recorded as replaced');
select is((select outcome from private.cleanup_review where object_path = pg_temp.v('sus_mech') and source = 'claim'), 'replaced',
  'and flagged for administrator review');
set local role authenticated;
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into public.suspension_photos (sled_id, revision_id, path)
                    values (pg_temp.v('sled')::uuid, pg_temp.v('rev_keep')::uuid, pg_temp.v('sus_mech')) $$,
  '55006', 'This photo was removed. Add it again.', 'no record can ever point at that path, so nothing referenced is lost');
reset role;
set local request.jwt.claims = '';
select private.cleanup_finish_run(pg_temp.v('run_verify')::bigint);

-- An incomplete registry stops deletion.
delete from private.storage_reference_columns where bucket_id = 'issue-photos';
select is(private.cleanup_registry_problems(),
  array['Photo column not registered: sled_issue_photos.path', 'Registered bucket without reference column: issue-photos'],
  'the registry self-check names what is missing');
insert into t select 'run_reg', private.cleanup_begin_run('delete')::text;
select throws_ok($$ select private.cleanup_process_records(pg_temp.v('run_reg')::bigint) $$, 'SWC02', null,
  'a delete run stops when the registry is incomplete');
select private.cleanup_finish_run(pg_temp.v('run_reg')::bigint);
insert into t select 'run_reg2', private.cleanup_begin_run('report')::text;
select lives_ok($$ select private.cleanup_process_records(pg_temp.v('run_reg2')::bigint) $$, 'a report run still runs');
select is((select count(*)::int from jsonb_each(private.cleanup_report_files(pg_temp.v('run_reg2')::bigint) -> 'buckets') b
           where (b.value ->> 'blocked')::boolean), 3, 'with every bucket blocked');
select private.cleanup_finish_run(pg_temp.v('run_reg2')::bigint);
insert into private.storage_reference_columns values ('issue-photos', 'sled_issue_photos', 'path');
select is(private.cleanup_registry_problems(), '{}'::text[], 'the registry is complete again');

-- A file that cannot be removed is tried three times, then left for review.
do $$
declare i int; v_run bigint;
begin
  for i in 1..3 loop
    v_run := pg_temp.run('delete');
    perform private.cleanup_claim_file(v_run, 'issue-photos', pg_temp.v('iss_extra2'));
    perform private.cleanup_record_file_result(v_run, 'issue-photos', pg_temp.v('iss_extra2'), false, 'Storage error 500');
    perform private.cleanup_finish_run(v_run);
  end loop;
end;
$$;
select is((select status || '|' || attempts || '|' || last_error from private.storage_cleanup_claims where object_path = pg_temp.v('iss_extra2')),
  'failed|3|Storage error 500', 'after three failed attempts the file is marked failed');
insert into t select 'run_after', pg_temp.run('delete')::text;
select is((private.cleanup_claim_file(pg_temp.v('run_after')::bigint, 'issue-photos', pg_temp.v('iss_extra2')) ->> 'reason'), 'claimed_before',
  'and it is not tried again automatically');
select private.revoke_cleanup_deletion();
select throws_ok($$ select private.cleanup_claim_file(pg_temp.v('run_after')::bigint, 'issue-photos', pg_temp.v('iss_extra1')) $$, '42501', null,
  'once deletion is switched off, nothing can be claimed');
select throws_ok($$ select private.cleanup_process_records(private.cleanup_begin_run('delete')) $$, '42501', null,
  'and no delete run can start');
select private.cleanup_finish_run(pg_temp.v('run_after')::bigint);

-- One run at a time.
select private.cleanup_begin_run('report');
select throws_ok($$ select private.cleanup_begin_run('report') $$, '55P03', 'Another cleanup run is in progress.', 'only one run at a time');
update private.cleanup_runs set started_at = now() - interval '3 hours' where status = 'running';
select lives_ok($$ select private.cleanup_finish_run(private.cleanup_begin_run('report')) $$,
  'a run that never finished is abandoned after 30 minutes');
select is((select count(*)::int from private.cleanup_runs where status = 'abandoned'), 1, 'and marked as abandoned');

-- ---------------------------------------------------------------------------
-- The 10% threshold applies only to buckets of 100 files or more
-- ---------------------------------------------------------------------------
create temporary table pool (n serial, path text) on commit drop;
do $$
declare i int; j int; v_issue uuid; v_path text;
begin
  for i in 1..20 loop
    insert into public.sled_issues (sled_id, title) values (pg_temp.v('sled')::uuid, 'Pool ' || i) returning id into v_issue;
    for j in 1..6 loop
      v_path := pg_temp.v('sled') || '/' || v_issue || '/' || gen_random_uuid() || '.jpg';
      insert into public.sled_issue_photos (issue_id, sled_id, path) values (v_issue, pg_temp.v('sled')::uuid, v_path);
      insert into pool (path) values (v_path);
    end loop;
  end loop;
end;
$$;
-- Fills issue-photos with p_ref referenced files and p_orphans orphans (and
-- p_no_meta orphans without metadata), runs a report, and returns the result.
create function pg_temp.issue_bucket(p_ref int, p_orphans int, p_no_meta int default 0) returns text language plpgsql volatile as $$
declare v_run bigint; v_b jsonb; i int;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'issue-photos';
  perform set_config('storage.allow_delete_query', 'false', true);
  perform pg_temp.object('issue-photos', p.path, interval '3 days') from pool p where p.n <= p_ref;
  for i in 1..p_orphans loop
    perform pg_temp.object('issue-photos', pg_temp.v('sled') || '/' || pg_temp.v('iss_act') || '/' || gen_random_uuid() || '.jpg', interval '3 days');
  end loop;
  for i in 1..p_no_meta loop
    insert into storage.objects (bucket_id, name, created_at, updated_at)
    values ('issue-photos', pg_temp.v('sled') || '/' || pg_temp.v('iss_act') || '/' || gen_random_uuid() || '.jpg', now() - interval '3 days', now() - interval '3 days');
  end loop;
  v_run := private.cleanup_begin_run('report', 'manual');
  v_b := private.cleanup_report_files(v_run) -> 'buckets' -> 'issue-photos';
  perform private.cleanup_finish_run(v_run);
  return case when (v_b ->> 'blocked')::boolean then 'blocked: ' || (v_b ->> 'blocked_reason') else 'open' end
         || ' (' || (v_b ->> 'objects') || ' files, ' || (v_b ->> 'orphans') || ' orphans)';
end;
$$;
select is(pg_temp.issue_bucket(49, 50), 'open (99 files, 50 orphans)', '99 files: no percentage threshold, even with half orphans');
select is(pg_temp.issue_bucket(90, 10), 'open (100 files, 10 orphans)', '100 files: exactly 10% is allowed');
select is(pg_temp.issue_bucket(89, 11), 'blocked: More than 10.00% of this bucket''s 100 files would be removed. (100 files, 11 orphans)',
  '100 files: more than 10% blocks the bucket');
select is(pg_temp.issue_bucket(110, 12), 'open (122 files, 12 orphans)', '122 files: 9.8% is allowed');
select is(pg_temp.issue_bucket(0, 5),
  format('blocked: No file matches any of the %s record(s) that point at this bucket; the reference lookup is not trusted. (5 files, 5 orphans)',
         private.storage_reference_count('issue-photos')),
  'files present, records pointing at the bucket, but no file matches: the bucket is blocked');
select is(pg_temp.issue_bucket(10, 1, 1), 'blocked: 1 file(s) have incomplete Storage metadata. (12 files, 1 orphans)',
  'a file with incomplete Storage metadata blocks its bucket');

-- purge_expired_records() uses the same guarded engine.
select throws_ok($$ select private.purge_expired_records() $$, '42501', 'Cleanup deletion is not authorized.',
  'the manual purge also needs deletion authorized');

select * from finish();
rollback;
