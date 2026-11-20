-- Tests for Migration 8, part 4: operational-history retention (the cleanup's
-- own runs, candidates and claims) and the failed-claim lifecycle.
-- Runs in one transaction, rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(61);

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert on t to authenticated;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated;
-- A finished run started p_days ago (with one candidate row).
create function pg_temp.run(p_key text, p_mode text, p_status text, p_days numeric, p_candidates int default 1) returns bigint
language plpgsql volatile as $$
declare v_id bigint; i int;
begin
  insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
  values (p_mode, 'scheduled', p_status, now() - p_days * interval '1 day', now() - p_days * interval '1 day',
          case when p_status = 'completed' then now() - p_days * interval '1 day' end,
          case when p_status = 'completed' then now() - p_days * interval '1 day' end)
  returning id into v_id;
  for i in 1..p_candidates loop
    insert into private.cleanup_candidates (run_id, kind, table_name, record_id, outcome) values (v_id, 'record', 'sleds', gen_random_uuid(), 'would_delete');
  end loop;
  insert into t values (p_key, v_id::text);
  return v_id;
end;
$$;
create function pg_temp.claim(p_path text, p_status text, p_days numeric, p_run bigint default null) returns void language sql volatile as $$
  insert into private.storage_cleanup_claims (bucket_id, object_path, status, run_id, claimed_at, finished_at)
  values ('sled-photos', p_path, p_status, p_run, now() - p_days * interval '1 day', now() - p_days * interval '1 day');
$$;
create function pg_temp.kinds(p_kind text) returns text language sql stable as $$
  select coalesce(string_agg(distinct x.run_id::text, ',' order by x.run_id::text), '') from private.retention_candidates() x where x.kind = p_kind
$$;
create function pg_temp.has_run(p_key text) returns boolean language sql stable as $$
  select exists (select 1 from private.cleanup_runs where id = pg_temp.v(p_key)::bigint)
$$;
create function pg_temp.details(p_key text) returns int language sql stable as $$
  select count(*)::int from private.cleanup_candidates where run_id = pg_temp.v(p_key)::bigint
$$;
-- One retention step in its own run (as the daily job does).
create function pg_temp.retention() returns jsonb language plpgsql volatile as $$
declare v_run bigint; v_result jsonb;
begin
  v_run := private.cleanup_begin_run('report', 'manual');
  v_result := private.cleanup_retention(v_run);
  perform private.cleanup_finish_run(v_run);
  -- The helper's own run is not part of what the tests count.
  delete from private.cleanup_runs where id = v_run;
  return v_result;
end;
$$;

-- An owner and a snowmobile, for tombstone checks.
insert into auth.users (id, email, email_confirmed_at) values ('e1111111-1111-1111-1111-111111111111', 'ret-owner@example.com', now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into t select 'sled', public.create_sled('Polaris', 'RMK', 2022, 2000)::text;
reset role;
set local request.jwt.claims = '';

-- History. The oldest completed report run is the 8th newest: not protected.
select pg_temp.run('report_old', 'report', 'completed', 600, 2);
select pg_temp.run('p' || i, 'report', 'completed', 500 + i, 1) from generate_series(1, 7) i;   -- the latest 7 completed report runs
select pg_temp.run('del_401', 'delete', 'completed', 401, 2);
select pg_temp.run('del_399', 'delete', 'completed', 399, 1);
select pg_temp.run('del_181', 'delete', 'completed', 181, 1);
select pg_temp.run('del_179', 'delete', 'completed', 179, 1);
select pg_temp.run('fail_31', 'report', 'failed', 31, 1);
select pg_temp.run('fail_29', 'report', 'failed', 29, 1);
insert into private.cleanup_runs (mode, source, status, started_at) values ('report', 'manual', 'running', now() - interval '900 days');
insert into t select 'running', id::text from private.cleanup_runs where status = 'running';
-- Claims of every kind, all old.
insert into t values ('tomb', pg_temp.v('sled') || '/' || gen_random_uuid() || '.jpg');
select pg_temp.claim(pg_temp.v('tomb'), 'deleted', 3000, pg_temp.v('del_401')::bigint);
select pg_temp.claim('x/replaced.jpg', 'replaced', 3000);
select pg_temp.claim('x/missing.jpg', 'missing', 3000);
select pg_temp.claim('x/claimed.jpg', 'claimed', 3000);
select pg_temp.claim('x/failed.jpg', 'failed', 3000);
select pg_temp.claim('x/closed.jpg', 'closed', 3000);
select pg_temp.claim('x/released_181.jpg', 'released', 181);
select pg_temp.claim('x/released_179.jpg', 'released', 179);

-- ---------------------------------------------------------------------------
-- Access and settings
-- ---------------------------------------------------------------------------
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r(role),
           unnest(array['private.retention_candidates(timestamptz)', 'private.cleanup_retention(bigint)',
                        'private.authorize_retention_maintenance(text)', 'private.review_failed_claim(text, text, text)',
                        'private.resolve_failed_claim(text, text, text, text)', 'public.cleanup_retention(bigint)']) f(fn)
           where has_function_privilege(r.role, f.fn, 'execute')), 0,
  'no signed-in user or visitor can preview, run or authorize retention, or resolve claims');
select ok(has_function_privilege('service_role', 'public.cleanup_retention(bigint)', 'execute'), 'the job (service role) can run the retention step');
select is((select format('%s|%s|%s|%s|%s|%s|%s', retention_enabled::text, retention_run_days, retention_report_candidate_days,
                         retention_delete_candidate_days, retention_released_claim_days, retention_keep_report_runs, retention_batch_size)
           from private.cleanup_settings), 'false|400|30|180|180|7|1000',
  'retention is off by default; periods 400/30/180/180 days, latest 7 report runs kept, batches of 1,000');
select throws_ok($$ update private.cleanup_settings set retention_run_days = 399 $$, '23514', null, 'the 400-day period cannot be shortened');
select throws_ok($$ update private.cleanup_settings set retention_report_candidate_days = 29 $$, '23514', null, 'nor the 30-day period');
select throws_ok($$ update private.cleanup_settings set retention_delete_candidate_days = 179 $$, '23514', null, 'nor the 180-day period');
select throws_ok($$ update private.cleanup_settings set retention_released_claim_days = 179 $$, '23514', null, 'nor the released-claim period');
select throws_ok($$ update private.cleanup_settings set retention_keep_report_runs = 6 $$, '23514', null, 'nor the 7 kept report runs');
select throws_ok($$ update private.cleanup_settings set retention_batch_size = 5001 $$, '23514', null, 'batches are at most 5,000 rows');
select throws_ok($$ select private.authorize_retention_maintenance(' ') $$, '42501',
  'Record who approved operational-history retention before enabling it.', 'switching retention on needs an approval note');
select is((select deletion_enabled::text from private.cleanup_settings), 'false', 'retention is separate from deleting user data (still off)');

-- ---------------------------------------------------------------------------
-- Preview: exactly which rows qualify
-- ---------------------------------------------------------------------------
select is(pg_temp.kinds('run'), (select string_agg(x, ',' order by x) from unnest(array[pg_temp.v('report_old'), pg_temp.v('del_401')]) x),
  'run summaries older than 400 days qualify (not 399 days; not a running run)');
select is((select count(*)::int from private.retention_candidates() where kind = 'run' and run_id in
           (select v::bigint from t where k like 'p%' and k <> 'running')), 0,
  'the latest 7 completed report runs never qualify, even 500+ days old');
select is(pg_temp.kinds('report_candidate'), (select string_agg(x, ',' order by x) from unnest(array[pg_temp.v('report_old'), pg_temp.v('fail_31')]) x),
  'report-run details older than 30 days qualify (not 29 days; not the latest 7 completed report runs)');
select is(pg_temp.kinds('delete_candidate'),
  (select string_agg(x, ',' order by x) from unnest(array[pg_temp.v('del_401'), pg_temp.v('del_399'), pg_temp.v('del_181')]) x),
  'delete-run details older than 180 days qualify (not 179 days)');
select is((select string_agg(object_path, ',') from private.retention_candidates() where kind = 'released_claim'), 'x/released_181.jpg',
  'released claims older than 180 days qualify (not 179 days)');
select is((select count(*)::int from private.retention_candidates() where kind = 'released_claim' and object_path not like '%released%'), 0,
  'removed-path tombstones, active, failed and closed claims never qualify, however old');
select is(private.retention_counts(), '{"runs": 2, "released_claims": 1, "delete_candidates": 4, "report_candidates": 3}'::jsonb,
  'the counts match the rows');
select is((select count(*)::int from private.retention_candidates() where run_id = pg_temp.v('running')::bigint), 0, 'a running run never qualifies');
-- (Starting a new run would mark it abandoned, after which it may qualify; remove it.)
delete from private.cleanup_runs where id = pg_temp.v('running')::bigint;

-- ---------------------------------------------------------------------------
-- Switched off: preview only
-- ---------------------------------------------------------------------------
insert into t select 'rows_before', ((select count(*) from private.cleanup_runs) + (select count(*) from private.cleanup_candidates)
                                     + (select count(*) from private.storage_cleanup_claims))::text;
insert into t select 'off', pg_temp.retention()::text;
select is((pg_temp.v('off')::jsonb ->> 'enabled'), 'false', 'with retention off, the step only reports');
select is((pg_temp.v('off')::jsonb -> 'qualifying' ->> 'delete_candidates')::int, 4, 'what would qualify');
select is(((select count(*) from private.cleanup_runs) + (select count(*) from private.cleanup_candidates)
           + (select count(*) from private.storage_cleanup_claims))::text, pg_temp.v('rows_before'), 'and removes nothing');

-- ---------------------------------------------------------------------------
-- Interrupted: nothing is half-done
-- ---------------------------------------------------------------------------
select private.authorize_retention_maintenance('Approved: operational-history retention (test)');
select ok((select retention_enabled and retention_authorized_at is not null from private.cleanup_settings), 'retention is switched on with a note');
create function pg_temp.interrupt() returns trigger language plpgsql as $$ begin raise exception 'simulated interruption'; end $$;
create trigger interrupt before delete on private.storage_cleanup_claims for each statement execute function pg_temp.interrupt();
select throws_ok($$ select pg_temp.retention() $$, 'P0001', 'simulated interruption', 'a step interrupted part-way fails');
drop trigger interrupt on private.storage_cleanup_claims;
select is(((select count(*) from private.cleanup_runs) + (select count(*) from private.cleanup_candidates)
           + (select count(*) from private.storage_cleanup_claims))::text, pg_temp.v('rows_before'),
  'and every row it had already removed is back (one transaction)');

-- ---------------------------------------------------------------------------
-- Switched on: bounded batches, details before summaries, idempotent
-- ---------------------------------------------------------------------------
update private.cleanup_settings set retention_batch_size = 3;
insert into t select 'b1', pg_temp.retention()::text;
select is((pg_temp.v('b1')::jsonb -> 'removed' ->> 'details')::int, 3, 'a batch removes at most the batch size');
select is((pg_temp.v('b1')::jsonb -> 'removed' ->> 'released_claims')::int + (pg_temp.v('b1')::jsonb -> 'removed' ->> 'runs')::int, 0,
  'and nothing more in that run');
insert into t select 'b2', pg_temp.retention()::text;
select is((pg_temp.v('b2')::jsonb -> 'removed')::text, '{"runs": 0, "details": 3, "released_claims": 0}', 'the next run continues');
insert into t select 'b3', pg_temp.retention()::text;
select is((pg_temp.v('b3')::jsonb -> 'removed')::text, '{"runs": 1, "details": 1, "released_claims": 1}',
  'then the released claim and a run summary whose details are gone (within the batch of 3)');
insert into t select 'b4', pg_temp.retention()::text;
select is((pg_temp.v('b4')::jsonb -> 'removed')::text, '{"runs": 1, "details": 0, "released_claims": 0}', 'then the last one');
insert into t select 'b5', pg_temp.retention()::text;
select is((pg_temp.v('b5')::jsonb -> 'removed')::text, '{"runs": 0, "details": 0, "released_claims": 0}', 'repeating removes nothing more');
select is(private.retention_counts(), '{"runs": 0, "released_claims": 0, "delete_candidates": 0, "report_candidates": 0}'::jsonb,
  'nothing qualifies any more');

select ok(not pg_temp.has_run('report_old') and not pg_temp.has_run('del_401'), 'run summaries past 400 days are gone');
select ok(pg_temp.has_run('del_399') and pg_temp.details('del_399') = 0, 'a 399-day summary stays, its 180+ day details are gone');
select ok(pg_temp.has_run('del_179') and pg_temp.details('del_179') = 1, 'a 179-day delete run keeps its details');
select is(pg_temp.details('del_181'), 0, 'a 181-day delete run lost its details');
select ok(pg_temp.details('fail_29') = 1 and pg_temp.details('fail_31') = 0, '30-day boundary for report details');
select is((select count(*)::int from private.cleanup_runs where id in (select v::bigint from t where k ~ '^p[0-9]$')), 7,
  'the latest 7 completed report runs are kept');
select is((select sum(pg_temp.details(k))::int from t where k ~ '^p[0-9]$'), 7, 'with their details');
select is((select string_agg(status, ',' order by status) from private.storage_cleanup_claims),
  'claimed,closed,deleted,failed,missing,released,replaced', 'every claim except the old released one is kept');

-- ---------------------------------------------------------------------------
-- Tombstones stay effective after their run is gone
-- ---------------------------------------------------------------------------
select is((select coalesce(run_id::text, 'none') || '|' || status from private.storage_cleanup_claims where object_path = pg_temp.v('tomb')),
  'none|deleted', 'the tombstone outlived its run summary');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ insert into storage.objects (bucket_id, name, metadata) values ('sled-photos', pg_temp.v('tomb'), '{"eTag": "x", "size": 1}') $$,
  '42501', null, 'the removed path still refuses uploads');
select throws_ok($$ update public.sleds set photo_path = pg_temp.v('tomb') where id = pg_temp.v('sled')::uuid $$,
  '55006', 'This photo was removed. Add it again.', 'and still cannot be attached to a record');
reset role;
set local request.jwt.claims = '';
select is((select count(*)::int from pg_policies where schemaname = 'storage' and policyname like 'SledWerx cleanup:%' and permissive = 'RESTRICTIVE'), 2,
  'the restrictive storage policies are in place');

-- ---------------------------------------------------------------------------
-- Failed claims: review, then resolve
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.resolve_failed_claim('sled-photos', 'x/failed.jpg', 'keep', 'kept') $$, '55000', null,
  'a failed claim cannot be resolved before it is reviewed');
select throws_ok($$ select private.review_failed_claim('sled-photos', 'x/failed.jpg', '') $$, '22023', null, 'a review needs a note');
select lives_ok($$ select private.review_failed_claim('sled-photos', 'x/failed.jpg', 'Storage returned 500 three times; bucket was read-only') $$,
  'an administrator records a review');
select is((select status from private.storage_cleanup_claims where object_path = 'x/failed.jpg'), 'failed',
  'reviewing changes nothing else: still failed, still not removable, not released');
select is((select count(*)::int from private.retention_candidates() where object_path = 'x/failed.jpg'), 0,
  'and retention still keeps it');
select throws_ok($$ select private.resolve_failed_claim('sled-photos', 'x/failed.jpg', 'retry', 'fixed') $$, '55000',
  'The file is no longer in Storage; resolve it as removed.', 'a retry needs the file to still exist');
select is(private.resolve_failed_claim('sled-photos', 'x/failed.jpg', 'removed', 'Removed by hand after the bucket was fixed'), 'deleted',
  'resolved as removed (the file is gone): it becomes a tombstone');
select is((select format('%s|%s|%s', resolution, (review_note is not null)::text, resolution_note) from private.storage_cleanup_claims
           where object_path = 'x/failed.jpg'), 'removed|true|Removed by hand after the bucket was fixed', 'the review and resolution stay on record');

insert into storage.objects (bucket_id, name, metadata) values ('sled-photos', 'x/keep.jpg', '{"eTag": "k", "size": 1}'),
                                                              ('sled-photos', 'x/retry.jpg', '{"eTag": "r", "size": 1}');
select pg_temp.claim('x/keep.jpg', 'failed', 10);
select pg_temp.claim('x/retry.jpg', 'failed', 10);
select private.review_failed_claim('sled-photos', 'x/keep.jpg', 'Owner asked to keep this file');
select private.review_failed_claim('sled-photos', 'x/retry.jpg', 'Storage outage');
select throws_ok($$ select private.resolve_failed_claim('sled-photos', 'x/keep.jpg', 'removed', 'gone?') $$, '55000',
  'The file is still in Storage; it was not removed.', 'a file still in Storage cannot be resolved as removed');
select is(private.resolve_failed_claim('sled-photos', 'x/keep.jpg', 'keep', 'Kept on request'), 'closed', 'kept: the claim is closed');
select ok(private.storage_path_writable('sled-photos', 'x/keep.jpg'), 'a closed claim does not block the path');
select is((select count(*)::int from private.retention_candidates() where object_path = 'x/keep.jpg'), 0, 'and is never removed by retention');
select is(private.resolve_failed_claim('sled-photos', 'x/retry.jpg', 'retry', 'Outage over'), 'released', 'retry: the claim is released');
select is((select attempts from private.storage_cleanup_claims where object_path = 'x/retry.jpg'), 0, 'with its attempts reset');
select throws_ok($$ select private.resolve_failed_claim('sled-photos', 'x/retry.jpg', 'keep', 'again') $$, 'P0002', null,
  'only failed claims can be resolved');

-- ---------------------------------------------------------------------------
-- One retention step per run; deletion of user data is untouched
-- ---------------------------------------------------------------------------
insert into t select 'r1', private.cleanup_begin_run('report', 'manual')::text;
select private.cleanup_retention(pg_temp.v('r1')::bigint);
select throws_ok($$ select private.cleanup_retention(pg_temp.v('r1')::bigint) $$, '55000', null, 'retention runs once per run');
select private.cleanup_finish_run(pg_temp.v('r1')::bigint);
select throws_ok($$ select private.cleanup_begin_run('delete') $$, '42501', 'Cleanup deletion is not authorized.',
  'switching retention on does not authorize deleting user data');

select * from finish();
rollback;
