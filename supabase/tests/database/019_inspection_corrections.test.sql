-- Tests for correcting a check's outcome (PR 2, Decision G), with no new
-- migration: the app updates maintenance_entry_tasks.outcome of an existing
-- check after update_maintenance_entry, under the record's permissions.
-- A correction changes that check itself, so Needs Replacement and the board
-- are recalculated; a later Good check does not clear Needs Replacement.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

insert into auth.users (id, email, email_confirmed_at) values
  ('c1111111-1111-1111-1111-111111111111', 'ic-owner@example.com', now()),
  ('c2222222-2222-2222-2222-222222222222', 'ic-mech@example.com',  now()),
  ('c3333333-3333-3333-3333-333333333333', 'ic-view@example.com',  now()),
  ('c4444444-4444-4444-4444-444444444444', 'ic-mech2@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
create function pg_temp.row_of(p_task text) returns public.maintenance_board language sql stable as $$
  select b.* from public.maintenance_board b where b.sled_id = pg_temp.v('sled')::uuid and b.task_name = p_task;
$$;
grant execute on function pg_temp.row_of(text) to authenticated, anon;
-- A check of one item, as the current user; returns the record id.
create function pg_temp.check_(p_task text, p_outcome text, p_days_ago int) returns text language sql volatile as $$
  select public.save_maintenance_inspection(
    gen_random_uuid(), pg_temp.v('sled')::uuid, current_date - p_days_ago,
    jsonb_build_array(jsonb_build_object('task_id', pg_temp.v('task_' || p_task), 'outcome', p_outcome))) ->> 'entry_id';
$$;
grant execute on function pg_temp.check_(text, text, int) to authenticated;
-- The correction, exactly as the app makes it (updateService).
create function pg_temp.correct(p_entry text, p_outcome text) returns int language plpgsql volatile as $$
declare v_rows int;
begin
  update public.maintenance_entry_tasks set outcome = p_outcome
  where entry_id = p_entry::uuid and deleted_at is null and outcome is not null and outcome <> p_outcome;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
grant execute on function pg_temp.correct(text, text) to authenticated;

set local role authenticated;
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Ski-Doo', 'Summit', 2024, 1000, 100)::text;
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'ic-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'ic-view@example.com', 'viewer');
insert into t select 'tok_m2', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'ic-mech2@example.com', 'mechanic');
select pg_temp.as_user('c2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));
select pg_temp.as_user('c4444444-4444-4444-4444-444444444444');
select public.accept_sled_invitation(pg_temp.v('tok_m2'));
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');

with created as (
  insert into public.maintenance_tasks (name) select n from unnest(array['Belt', 'Track', 'Skis']) n returning id, name
)
insert into t select 'task_' || name, id::text from created;
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Belt')::uuid, 'inspection', 30);
insert into public.maintenance_plans (sled_id, task_id, tracks, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Track')::uuid, 'inspection', 30);
insert into public.maintenance_plans (sled_id, task_id, tracks, interval_mi, inspect_interval_days)
  values (pg_temp.v('sled')::uuid, pg_temp.v('task_Skis')::uuid, 'both', 2000, 30);

-- ---------------------------------------------------------------------------
-- A mistaken Needs Replacement, corrected to Good: the flag is recalculated
-- ---------------------------------------------------------------------------
select pg_temp.as_user('c2222222-2222-2222-2222-222222222222');
insert into t select 'belt_check', pg_temp.check_('Belt', 'needs_replacement', 6);
select is((pg_temp.row_of('Belt')).needs_replacement, true, 'a mechanic records Needs Replacement by mistake: flagged');
select is((pg_temp.row_of('Belt')).item_rank, -1, 'and first on the board');

-- The record is edited as the app does: update_maintenance_entry, then the outcome.
select lives_ok($$
  select public.update_maintenance_entry(
    pg_temp.v('belt_check')::uuid,
    (select version from public.maintenance_entries where id = pg_temp.v('belt_check')::uuid),
    current_date - 6, 'Inspection', 'inspection', null, 'Corrected: belt is fine', null, null, null,
    (select jsonb_agg(jsonb_build_object('id', id, 'task_id', task_id)) from public.maintenance_entry_tasks
     where entry_id = pg_temp.v('belt_check')::uuid), '[]'::jsonb)
$$, 'editing the Inspection record works as for any service record');
select is((select outcome from public.maintenance_entry_tasks where entry_id = pg_temp.v('belt_check')::uuid),
  'needs_replacement', 'editing the record alone keeps the outcome');
select is(pg_temp.correct(pg_temp.v('belt_check'), 'good'), 1, 'the mechanic who recorded it corrects it to Good');
select is((pg_temp.row_of('Belt')).needs_replacement, false, 'Needs Replacement is cleared: the check itself was corrected');
select is((pg_temp.row_of('Belt')).last_check_outcome, 'good', 'the board shows the corrected outcome');
select is((pg_temp.row_of('Belt')).inspect_status, 'good', 'and the check schedule still counts from that check');
select is((pg_temp.row_of('Belt')).last_checked_on, current_date - 6, 'from its date');
select ok((pg_temp.row_of('Belt')).item_rank <> -1, 'no longer first on the board');
select is((select edited_at is not null from public.maintenance_entries where id = pg_temp.v('belt_check')::uuid), true,
  'the record shows it was edited');

reset role;
select ok(exists (
  select 1 from public.audit_log
  where table_name = 'maintenance_entry_tasks' and action = 'update' and 'outcome' = any (changed_fields)
    and old_data ->> 'outcome' = 'needs_replacement' and new_data ->> 'outcome' = 'good'
    and actor_id = 'c2222222-2222-2222-2222-222222222222'
), 'the correction is kept in the audit log: who, and the old and new outcome');
select ok(exists (
  select 1 from public.audit_log
  where table_name = 'maintenance_entry_tasks' and action = 'insert' and new_data ->> 'entry_id' = pg_temp.v('belt_check')
), 'the original check stays in the audit log');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- A later Good check is different: it does not clear Needs Replacement
-- ---------------------------------------------------------------------------
select pg_temp.as_user('c2222222-2222-2222-2222-222222222222');
insert into t select 'track_flag', pg_temp.check_('Track', 'needs_replacement', 10);
insert into t select 'track_good', pg_temp.check_('Track', 'good', 3);
select is((pg_temp.row_of('Track')).needs_replacement, true, 'a later Good check: still Needs Replacement');
select is((pg_temp.row_of('Track')).last_check_outcome, 'good', 'while the latest check is Good');
select is(pg_temp.correct(pg_temp.v('track_flag'), 'good'), 1, 'correcting the mistaken check itself');
select is((pg_temp.row_of('Track')).needs_replacement, false, 'clears it');

-- Correcting Good to Needs Replacement flags the item.
select is(pg_temp.correct(pg_temp.v('track_good'), 'needs_replacement'), 1, 'a Good check corrected to Needs Replacement');
select is((pg_temp.row_of('Track')).needs_replacement, true, 'flags the item');

-- ---------------------------------------------------------------------------
-- Permissions: the record's own (owner, editor, the mechanic who created it)
-- ---------------------------------------------------------------------------
insert into t select 'skis_check', pg_temp.check_('Skis', 'needs_replacement', 2);
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select is(pg_temp.correct(pg_temp.v('skis_check'), 'good'), 0, 'a viewer cannot correct a check');
select pg_temp.as_user('c4444444-4444-4444-4444-444444444444');
select is(pg_temp.correct(pg_temp.v('skis_check'), 'good'), 0, 'another mechanic cannot correct someone else''s check');
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select is((pg_temp.row_of('Skis')).needs_replacement, true, 'still flagged');
select is(pg_temp.correct(pg_temp.v('skis_check'), 'good'), 1, 'the owner can correct it');

-- A removed record cannot be corrected (restore it first).
update public.maintenance_entries set deleted_at = now(), version = version where id = pg_temp.v('skis_check')::uuid;
select is(pg_temp.correct(pg_temp.v('skis_check'), 'needs_replacement'), 0, 'a removed record''s check is not corrected');

select * from finish();
rollback;
