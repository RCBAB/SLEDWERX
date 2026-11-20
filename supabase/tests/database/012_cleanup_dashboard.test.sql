-- Tests for Migration 8, part 3: SledWerx application administrators and the
-- read-only cleanup dashboard function. Runs in one transaction, rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(40);

insert into auth.users (id, email, email_confirmed_at) values
  ('d1111111-1111-1111-1111-111111111111', 'dash-admin@example.com',  now()),
  ('d2222222-2222-2222-2222-222222222222', 'dash-owner@example.com',  now()),
  ('d3333333-3333-3333-3333-333333333333', 'dash-editor@example.com', now()),
  ('d4444444-4444-4444-4444-444444444444', 'dash-mech@example.com',   now()),
  ('d5555555-5555-5555-5555-555555555555', 'dash-view@example.com',   now());
insert into auth.users (id, email) values ('d6666666-6666-6666-6666-666666666666', 'dash-unconfirmed@example.com');

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text, p_extra jsonb default '{}') returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', p_id, 'role', 'authenticated') || p_extra)::text, true);
$$;
grant execute on function pg_temp.as_user(text, jsonb) to authenticated, anon;

-- An owner shares a snowmobile with an editor, a mechanic and a viewer.
set local role authenticated;
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000)::text;
insert into t select 'tok_' || r, token from unnest(array['editor', 'mechanic', 'viewer']) r,
  lateral public.create_sled_invitation(pg_temp.v('sled')::uuid, 'dash-' || left(replace(r, 'mechanic', 'mech'), 4) ||
    case r when 'editor' then 'or' when 'viewer' then '' else '' end || '@example.com', r::public.sled_share_role);
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_editor'));
select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select public.accept_sled_invitation(pg_temp.v('tok_mechanic'));
select pg_temp.as_user('d5555555-5555-5555-5555-555555555555');
select public.accept_sled_invitation(pg_temp.v('tok_viewer'));
reset role;
set local request.jwt.claims = '';

-- ---------------------------------------------------------------------------
-- Structure and access
-- ---------------------------------------------------------------------------
select has_table('private', 'app_administrators', 'the administrators table exists');
select ok((select relrowsecurity from pg_class where oid = 'private.app_administrators'::regclass), 'with RLS on');
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r(role)
           where has_table_privilege(r.role, 'private.app_administrators', 'select, insert, update, delete')), 0,
  'no signed-in user or visitor can read or change the administrators list');
select is((select string_agg(r.role, ',' order by r.role) from unnest(array['anon', 'authenticated', 'service_role']) r(role)
           where has_function_privilege(r.role, 'public.cleanup_dashboard()', 'execute')), 'authenticated',
  'only signed-in users can call the dashboard function (it then checks the administrators list)');
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r(role),
           unnest(array['private.is_app_administrator(uuid)', 'private.grant_app_administrator(uuid, text)',
                        'private.revoke_app_administrator(uuid)']) f(fn)
           where has_function_privilege(r.role, f.fn, 'execute')), 0,
  'nobody but the database owner can check, grant or revoke administrator access');
select is((select provolatile::text from pg_proc where oid = 'public.cleanup_dashboard()'::regprocedure), 's',
  'the dashboard function is STABLE: it cannot change anything');

-- ---------------------------------------------------------------------------
-- Nobody is an administrator by default
-- ---------------------------------------------------------------------------
select is((select count(*)::int from private.app_administrators), 0, 'no administrator exists by default');
set local role authenticated;
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'a garage owner is refused');
select pg_temp.as_user('d3333333-3333-3333-3333-333333333333');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'an editor is refused');
select pg_temp.as_user('d4444444-4444-4444-4444-444444444444');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'a mechanic is refused');
select pg_temp.as_user('d5555555-5555-5555-5555-555555555555');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'a viewer is refused');
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'the future administrator is refused before being granted');
-- Client-controlled claims and profile fields grant nothing.
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222',
  '{"app_metadata": {"role": "admin"}, "user_metadata": {"is_admin": true}, "is_admin": true}');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.',
  'claims or metadata saying "admin" grant nothing');
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
update public.profiles set display_name = 'admin' where id = 'd2222222-2222-2222-2222-222222222222';
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'neither does a profile field');
-- Users cannot make themselves administrators.
select throws_ok($$ insert into private.app_administrators (user_id) values ('d2222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'a user cannot add themselves to the administrators list');
select throws_ok($$ select private.grant_app_administrator('d2222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'or call the grant function');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', null, 'a signed-out visitor is refused');
reset role;
set local request.jwt.claims = '';

-- ---------------------------------------------------------------------------
-- Granting (database owner only)
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.grant_app_administrator('d6666666-6666-6666-6666-666666666666') $$, 'P0002',
  'No confirmed user with this id.', 'an unconfirmed account cannot be made an administrator');
select lives_ok($$ select private.grant_app_administrator('d1111111-1111-1111-1111-111111111111', 'Test administrator') $$,
  'the database owner grants administrator access by user id');

set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'empty', public.cleanup_dashboard()::text;
reset role;
set local request.jwt.claims = '';
select is((select format('%s|%s|%s|%s|%s', v::jsonb -> 'latest', v::jsonb -> 'last_run', v::jsonb -> 'history', v::jsonb -> 'report_days',
                         v::jsonb -> 'warnings') from t where k = 'empty'),
  'null|null|[]|0|[]', 'with no cleanup history, the dashboard is empty (no runs, no warnings)');
select is((select v::jsonb -> 'settings' ->> 'deletion_enabled' || '|' || (v::jsonb -> 'settings' ->> 'backup_recorded') from t where k = 'empty'),
  'false|false', 'and shows deletion off and no backup recorded');
select is((select (v::jsonb -> 'retention' ->> 'enabled') || '|' || (v::jsonb -> 'retention' -> 'periods' ->> 'run_days') || '|'
                  || (v::jsonb -> 'retention' -> 'qualifying' ->> 'runs') || '|' || coalesce(v::jsonb -> 'retention' ->> 'last', 'never')
           from t where k = 'empty'), 'false|400|0|never',
  'and operational-history retention: off, its periods, nothing qualifying, never run');

-- ---------------------------------------------------------------------------
-- With history
-- ---------------------------------------------------------------------------
insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at, summary)
select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day' + interval '5 seconds',
       now() - d * interval '1 day', now() - d * interval '1 day',
       jsonb_build_object(
         'records', jsonb_build_object('candidates', 12, 'backlog', 9, 'newly_expired', 3, 'rows', 40, 'limit', 200,
                                       'outcomes', jsonb_build_object('would_delete', 10, 'too_large', 2), 'needs_review', true,
                                       'too_large', '[]'::jsonb, 'deleted_groups', '{}'::jsonb),
         'files', jsonb_build_object('needs_review', false, 'storage_unreadable', false, 'registry_problems', '[]'::jsonb,
                                     'buckets', jsonb_build_object('suspension-photos', jsonb_build_object('objects', 20, 'orphans', 2, 'blocked', false))))
from generate_series(1, 7) d;
insert into t select 'latest', id::text from private.cleanup_runs order by id desc limit 1;
insert into private.cleanup_candidates (run_id, kind, table_name, record_id, sled_id, group_rows, outcome, detail)
values (pg_temp.v('latest')::bigint, 'record', 'sleds', gen_random_uuid(), pg_temp.v('sled')::uuid, 640, 'too_large', 'Needs administrator review'),
       (pg_temp.v('latest')::bigint, 'record', 'sled_issues', gen_random_uuid(), pg_temp.v('sled')::uuid, 250, 'too_large', 'Needs administrator review');
insert into private.cleanup_candidates (run_id, kind, bucket_id, object_path, outcome, detail)
values (pg_temp.v('latest')::bigint, 'file', 'issue-photos', 'notes/readme.txt', 'unrecognized', 'Not a SledWerx photo path'),
       (pg_temp.v('latest')::bigint, 'file', 'issue-photos', pg_temp.v('sled') || '/x/y.jpg', 'blocked', 'More than 10% would be removed');
insert into private.storage_cleanup_claims (bucket_id, object_path, status, last_error, finished_at)
values ('suspension-photos', 'a/b/c.jpg', 'replaced', 'Storage removed a different file', now()),
       ('suspension-photos', 'a/b/d.jpg', 'failed', 'Storage error 500', now());
insert into private.cleanup_runs (mode, source, status, started_at, finished_at, error)
values ('report', 'scheduled', 'failed', now() - interval '1 hour', now() - interval '1 hour', 'Processing records failed: boom');
select private.authorize_cleanup_deletion('Backup SECRET-REFERENCE-123 (s3://bucket/key?token=abc)');

set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
insert into t select 'full', public.cleanup_dashboard()::text;
reset role;
set local request.jwt.claims = '';
create function pg_temp.d() returns jsonb language sql stable as $$ select v::jsonb from t where k = 'full' $$;

select is((pg_temp.d() ->> 'report_days')::int, 7, 'counts the successful daily report runs toward the required seven');
select is((pg_temp.d() -> 'last_run' ->> 'status'), 'failed', 'shows the last run (here a failed one)');
select is((pg_temp.d() -> 'last_run' ->> 'error'), 'Processing records failed: boom', 'with its error');
select is((pg_temp.d() -> 'latest' -> 'records' ->> 'backlog')::int || '|' || (pg_temp.d() -> 'latest' -> 'records' ->> 'newly_expired'),
  '9|3', 'shows backlog and newly expired records of the latest finished run');
select is((pg_temp.d() -> 'latest' -> 'files' -> 'buckets' -> 'suspension-photos' ->> 'orphans')::int, 2, 'and orphaned photos by bucket');
select is((select string_agg((x ->> 'table') || ':' || (x ->> 'rows'), ',') from jsonb_array_elements(pg_temp.d() -> 'too_large') x),
  'sleds:640,sled_issues:250', 'lists the oversized groups awaiting review, largest first, with their size');
select is((pg_temp.d() -> 'review_counts' ->> 'unrecognized')::int + (pg_temp.d() -> 'review_counts' ->> 'blocked')::int, 2,
  'counts unrecognised and blocked files');
select is((pg_temp.d() -> 'claims' ->> 'replaced')::int || '|' || (pg_temp.d() -> 'claims' ->> 'failed'), '1|1',
  'and replaced and failed file removals');
select ok((select bool_or(w like '%replaced at the same path%') and bool_or(w like '%of the last 14 runs failed%')
           from jsonb_array_elements_text(pg_temp.d() -> 'warnings') w), 'raises security warnings for replaced files and failed runs');
select is(jsonb_array_length(pg_temp.d() -> 'history'), 8, 'lists recent runs (at most 14)');
select is((pg_temp.d() -> 'settings' ->> 'backup_recorded'), 'true', 'shows that a backup was recorded');
select ok(pg_temp.d()::text not like '%SECRET-REFERENCE%' and pg_temp.d()::text not like '%token=abc%',
  'but never the backup reference itself');
select ok(pg_temp.d()::text not like '%@example.com%' and pg_temp.d()::text not like '%Polaris%',
  'and no names, emails or other user content');
select is((pg_temp.d() -> 'retention' ->> 'failed_claims_unreviewed')::int, 1, 'counts failed removals awaiting review (retention keeps them)');
select is((pg_temp.d() -> 'retention' ->> 'tombstones')::int, 1, 'and removed-path tombstones (kept forever)');

-- ---------------------------------------------------------------------------
-- Revoking
-- ---------------------------------------------------------------------------
select ok(private.revoke_app_administrator('d1111111-1111-1111-1111-111111111111'), 'the database owner revokes administrator access');
set local role authenticated;
select pg_temp.as_user('d1111111-1111-1111-1111-111111111111');
select throws_ok($$ select public.cleanup_dashboard() $$, '42501', 'Not authorized.', 'access ends immediately');
reset role;
set local request.jwt.claims = '';
select private.grant_app_administrator('d1111111-1111-1111-1111-111111111111');
delete from auth.users where id = 'd1111111-1111-1111-1111-111111111111';
select is((select count(*)::int from private.app_administrators), 0, 'deleting the account removes its administrator access');

select * from finish();
rollback;
