-- Tests for migration 20261126090000_suspension_turns: input methods, turns
-- adjustments (each a new Trail), cumulative turns, documenting the actual
-- measurement on the same Trail, reminders per Trail, outdated photos, and
-- that older and newer Trails never change.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(113);

insert into auth.users (id, email, email_confirmed_at) values
  ('e1111111-1111-1111-1111-111111111111', 'tn-owner@example.com', now()),
  ('e2222222-2222-2222-2222-222222222222', 'tn-mech@example.com',  now()),
  ('e3333333-3333-3333-3333-333333333333', 'tn-view@example.com',  now()),
  ('e4444444-4444-4444-4444-444444444444', 'tn-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
-- Save the next Trail from the active one (by key), with value changes and turns.
create function pg_temp.save(p_base text, p_changes jsonb, p_turns jsonb) returns text language sql volatile as $$
  select public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v(p_base)::uuid, p_changes,
    null, null, null, null, null, gen_random_uuid(), p_turns) ->> 'revision_id';
$$;
grant execute on function pg_temp.save(text, jsonb, jsonb) to authenticated, anon;
create function pg_temp.j(p_setting text, p_value text) returns jsonb language sql stable as $$
  select jsonb_build_object(pg_temp.v(p_setting), p_value);
$$;
grant execute on function pg_temp.j(text, text) to authenticated, anon;
create function pg_temp.turns(p_setting text, p_amount numeric) returns jsonb language sql stable as $$
  select jsonb_build_object(pg_temp.v(p_setting), p_amount);
$$;
grant execute on function pg_temp.turns(text, numeric) to authenticated, anon;
-- "turns|measurement|measurement needed|photo needed" for one Trail and setting ("none" when untracked).
create function pg_temp.st(p_rev text, p_setting text) returns text language sql stable as $$
  select coalesce((select coalesce(s.cumulative_turns::text, '-') || '|' || coalesce(s.measurement, '-') || '|'
                          || s.measurement_needed::text || '|' || s.photo_needed::text
                   from public.suspension_trail_status(array[pg_temp.v(p_rev)::uuid]) s
                   where s.setting_id = pg_temp.v(p_setting)::uuid), 'none');
$$;
grant execute on function pg_temp.st(text, text) to authenticated, anon;
create function pg_temp.val(p_rev text, p_setting text) returns text language sql stable as $$
  select coalesce((select setting_values -> pg_temp.v(p_setting) ->> 'value' from public.suspension_revisions
                   where id = pg_temp.v(p_rev)::uuid), '-');
$$;
grant execute on function pg_temp.val(text, text) to authenticated, anon;
create function pg_temp.trails() returns int language sql stable as $$
  select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid;
$$;
grant execute on function pg_temp.trails() to authenticated, anon;
create function pg_temp.active() returns uuid language sql stable as $$
  select active_revision_id from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid;
$$;
grant execute on function pg_temp.active() to authenticated, anon;
create function pg_temp.record(p_rev text, p_setting text, p_value text) returns jsonb language sql volatile as $$
  select public.record_suspension_measurement(pg_temp.v(p_rev)::uuid, pg_temp.v(p_setting)::uuid, p_value);
$$;
grant execute on function pg_temp.record(text, text, text) to authenticated, anon;
create function pg_temp.path(p_rev text) returns text language sql volatile as $$
  select pg_temp.v('sled') || '/' || pg_temp.v(p_rev) || '/' || gen_random_uuid() || '.jpg';
$$;
grant execute on function pg_temp.path(text) to authenticated, anon;
create function pg_temp.add_photo(p_rev text, p_setting text) returns text language sql volatile as $$
  select public.add_suspension_measurement_photo(pg_temp.v(p_rev)::uuid, pg_temp.v(p_setting)::uuid, pg_temp.path(p_rev)) ->> 'id';
$$;
grant execute on function pg_temp.add_photo(text, text) to authenticated, anon;
-- "own,inherited-outdated" counts of active photos for one Trail and setting.
create function pg_temp.photos(p_rev text, p_setting text) returns text language sql stable as $$
  select count(*) filter (where carried_from_id is null) || ',' || count(*) filter (where carried_from_id is not null and outdated)
  from public.sled_measurement_photos
  where revision_id = pg_temp.v(p_rev)::uuid and setting_id = pg_temp.v(p_setting)::uuid and deleted_at is null;
$$;
grant execute on function pg_temp.photos(text, text) to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Ski-Doo', 'Summit', 2025, 100)::text;
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'tn-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'tn-view@example.com', 'viewer');
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));

-- ---------------------------------------------------------------------------
-- Structure and security
-- ---------------------------------------------------------------------------
reset role;
select has_column('public', 'suspension_settings', 'input_methods', 'settings have input methods');
select is((select column_default from information_schema.columns where table_name = 'suspension_settings' and column_name = 'input_methods'),
  '''measurement''::text', 'new and existing settings default to Measurement only');
select ok((select bool_and(relrowsecurity) from pg_class
           where oid in ('public.sled_turn_adjustments'::regclass, 'public.sled_trail_settings'::regclass, 'public.sled_measurement_records'::regclass)),
  'RLS is on for the three new tables');
select is((select count(*)::int from information_schema.role_table_grants
           where table_name in ('sled_turn_adjustments', 'sled_trail_settings', 'sled_measurement_records')
             and grantee in ('authenticated', 'anon') and privilege_type <> 'SELECT'), 0,
  'nobody can write the new tables directly (only through the functions)');
select ok(not has_table_privilege('anon', 'public.sled_trail_settings', 'select')
          and not has_table_privilege('anon', 'public.sled_turn_adjustments', 'select')
          and not has_table_privilege('anon', 'public.sled_measurement_records', 'select'), 'anonymous users have no access');
select is(has_function_privilege('anon', 'public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid,jsonb)', 'execute')
          or has_function_privilege('anon', 'public.record_suspension_measurement(uuid,uuid,text)', 'execute')
          or has_function_privilege('anon', 'public.suspension_trail_status(uuid[])', 'execute'), false,
  'anonymous users cannot call the new functions');
select ok(has_function_privilege('authenticated', 'public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)', 'execute'),
  'the Migration 9 / 10 save (without turns) is still callable');
select is((select cardinality(private.cleanup_registry_problems())), 0, 'the cleanup registry is complete');
select is((select count(*)::int from pg_trigger where tgname = 'cleanup_count_deletes'
           and tgrelid in ('public.sled_turn_adjustments'::regclass, 'public.sled_trail_settings'::regclass, 'public.sled_measurement_records'::regclass)), 3,
  'the cleanup counts their deletes');

-- Fixture: Preload (both, in), Compression (measurement only, clicks), Collar (turns only).
set local role authenticated;
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
with x as (insert into public.suspension_settings (sled_id, name, zone, unit, input_methods)
  values (pg_temp.v('sled')::uuid, 'Preload', 'front_left_shock', 'in', 'both') returning id)
insert into t select 'pre', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Compression', 'front_left_shock', 'clicks') returning id)
insert into t select 'comp', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, input_methods)
  values (pg_temp.v('sled')::uuid, 'Collar', 'rear_rear_shock', 'turns') returning id)
insert into t select 'col', id::text from x;
select is((select input_methods from public.suspension_settings where id = pg_temp.v('comp')::uuid), 'measurement',
  'a setting added without a choice is Measurement only');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone, value_type, input_methods)
  values (pg_temp.v('sled')::uuid, 'Notes', 'rear_general', 'text', 'both') $$, '23514', null, 'turns need a number setting');
select throws_ok($$ insert into public.suspension_settings (sled_id, name, zone, input_methods)
  values (pg_temp.v('sled')::uuid, 'Odd', 'rear_general', 'sometimes') $$, '23514', null, 'only the three input methods exist');

-- Trail 1: measurements only (the 9-argument save, as the app does today).
insert into t select 'r1', public.save_suspension_configuration(pg_temp.v('sled')::uuid, null,
  jsonb_build_object(pg_temp.v('pre'), '10', pg_temp.v('comp'), '12'), null, null, null, null, null, gen_random_uuid()) ->> 'revision_id';
select is(pg_temp.trails(), 1, 'Trail 1 saved without turns');
select is(pg_temp.st('r1', 'pre'), 'none', 'no turns, no status rows');

-- Photos on Trail 1 for Preload and Compression (to check outdated labels).
select ok(pg_temp.add_photo('r1', 'pre') is not null, 'Preload photo on Trail 1');
select ok(pg_temp.add_photo('r1', 'comp') is not null, 'Compression photo on Trail 1');

-- ---------------------------------------------------------------------------
-- Turns: +2, +1, -0.5 = +2.5, each its own Trail and adjustment
-- ---------------------------------------------------------------------------
insert into t select 'r2', pg_temp.save('r1', '{}', pg_temp.turns('pre', 2));
select is(pg_temp.trails(), 2, '+2 turns created Trail 2');
select is(pg_temp.val('r2', 'pre'), '-', 'Preload''s measurement is blank while turns are outstanding');
select is(pg_temp.val('r2', 'comp'), '12', 'unchanged settings carry forward');
select is(pg_temp.st('r2', 'pre'), '2.00|-|true|true', 'cumulative +2, Measurement Needed and Photo Needed');
select is(pg_temp.photos('r2', 'pre'), '0,1', 'Preload''s carried photo is outdated, not newly captured');
select is(pg_temp.photos('r2', 'comp'), '0,0', 'Compression''s carried photo stays current');

insert into t select 'r3', pg_temp.save('r2', '{}', pg_temp.turns('pre', 1));
insert into t select 'r4', pg_temp.save('r3', '{}', pg_temp.turns('pre', -0.5));
select is(pg_temp.st('r4', 'pre'), '2.50|-|true|true', '+2, +1, -0.5 = +2.5 cumulative');
select is((select string_agg(a.amount::text, ',' order by r.config_number) from public.sled_turn_adjustments a
           join public.suspension_revisions r on r.id = a.revision_id
           where a.setting_id = pg_temp.v('pre')::uuid), '2.00,1.00,-0.50', 'each adjustment is kept');
select is((select string_agg(r.config_number::text, ',' order by r.config_number) from public.suspension_revisions r
           where r.sled_id = pg_temp.v('sled')::uuid), '1,2,3,4', 'each adjustment is the next numbered Trail');
select is(pg_temp.st('r2', 'pre'), '2.00|-|true|true', 'Trail 2 keeps its own status');
select is(pg_temp.st('r3', 'pre'), '3.00|-|true|true', 'Trail 3 keeps its own status');

-- Fractions, zero and refusals.
select throws_ok($$ select pg_temp.save('r4', '{}', pg_temp.turns('pre', 0.125)) $$, '22023', null, 'more than two decimals is refused');
select throws_ok($$ select pg_temp.save('r4', '{}', jsonb_build_object(pg_temp.v('pre'), 'two')) $$, '22023', null, 'turns must be a number');
select throws_ok($$ select pg_temp.save('r4', '{}', pg_temp.turns('pre', 0)) $$, '22023', 'Nothing changed.', 'zero turns is no change');
select throws_ok($$ select pg_temp.save('r4', '{}', pg_temp.turns('comp', 1)) $$, '22023', 'Compression is not adjusted in turns.',
  'turns on a Measurement only setting are refused');
select throws_ok($$ select pg_temp.save('r4', pg_temp.j('pre', '11'), pg_temp.turns('pre', 1)) $$, '22023',
  'Enter either a measurement or turns for Preload, not both.', 'a measurement and turns for one setting are refused');
select throws_ok($$ select pg_temp.save('r4', pg_temp.j('pre', '11'), '{}') $$, '22023', 'Record the measurement for Preload first.',
  'a new measurement while turns are outstanding is refused');
select throws_ok($$ select pg_temp.save('r4', pg_temp.j('col', '3'), '{}') $$, '22023', 'Collar is adjusted in turns.',
  'a measurement for a Turns only setting is refused');
select is(pg_temp.trails(), 4, 'refused saves created nothing');

-- Another setting changes: Preload's turns and reminders carry forward; zero turns adds nothing.
insert into t select 'r5', pg_temp.save('r4', pg_temp.j('comp', '14'), pg_temp.turns('pre', 0));
select is(pg_temp.st('r5', 'pre'), '2.50|-|true|true', 'cumulative turns and reminders carry forward');
select is((select count(*)::int from public.sled_turn_adjustments where revision_id = pg_temp.v('r5')::uuid), 0, 'zero turns added no adjustment');
select is(pg_temp.val('r5', 'comp'), '14', 'the other setting changed');
select is(pg_temp.photos('r5', 'comp'), '0,1', 'an ordinary measurement change marks that setting''s photo outdated');
select is(pg_temp.photos('r5', 'pre'), '0,1', 'an outdated photo stays outdated when carried again');

-- ---------------------------------------------------------------------------
-- Document the actual measurement on the active Trail (no new Trail)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
select is((pg_temp.record('r5', 'pre', '11.25') ->> 'correction')::boolean, false, 'a mechanic records the measurement');
select is(pg_temp.trails(), 5, 'no new Trail');
select is(pg_temp.st('r5', 'pre'), '2.50|11.25|false|true', 'Measurement Needed cleared; Photo Needed stays');
select is(pg_temp.val('r5', 'pre'), '-', 'the saved Trail values are not edited');
select is((pg_temp.record('r5', 'pre', '11.5') ->> 'correction')::boolean, true, 'a correction is allowed');
select is((pg_temp.record('r5', 'pre', '11.5') ->> 'duplicate')::boolean, true, 'the same value again is a repeat');
select is((select string_agg(value || '@' || cumulative_turns, ',' order by created_at, value) from public.sled_measurement_records
           where revision_id = pg_temp.v('r5')::uuid), '11.25@2.50,11.5@2.50', 'every record is kept, with the turns it documents');
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|true', 'the latest record is the Trail''s measurement');
select is(pg_temp.st('r4', 'pre'), '2.50|-|true|true', 'the previous Trail is unchanged');
select is((select count(*)::int from public.sled_turn_adjustments where setting_id = pg_temp.v('pre')::uuid), 3,
  'the turns adjustments stay in History');

select throws_ok($$ select pg_temp.record('r4', 'pre', '11') $$, 'PT409', 'Make this Trail active before recording a measurement on it.',
  'an older Trail must be made active first');
select throws_ok($$ select pg_temp.record('r5', 'comp', '11') $$, '22023', null, 'not for a Measurement only setting');
select throws_ok($$ select pg_temp.record('r5', 'col', '11') $$, '22023',
  'Switch Collar to Measurement and Turns to record a measurement.', 'not for a Turns only setting');
select throws_ok($$ select pg_temp.record('r5', 'pre', 'eleven') $$, '22023', 'Enter a number for Preload.', 'a number is required');
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select throws_ok($$ select pg_temp.record('r5', 'pre', '12') $$, '42501', null, 'a viewer cannot record');
select pg_temp.as_user('e4444444-4444-4444-4444-444444444444');
select throws_ok($$ select pg_temp.record('r5', 'pre', '12') $$, '42501', null, 'someone without access cannot record');
select is((select count(*)::int from public.sled_trail_settings), 0, 'and cannot read any status');
select is((select count(*)::int from public.suspension_trail_status(array[pg_temp.v('r5')::uuid])), 0, 'not even through the status function');
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|true', 'a viewer can read the status');

-- ---------------------------------------------------------------------------
-- Photo Needed: one new photo clears it, for that Trail only
-- ---------------------------------------------------------------------------
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
insert into t select 'ph1', pg_temp.add_photo('r5', 'pre');
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|false', 'one new photo clears Photo Needed');
select is(pg_temp.st('r4', 'pre'), '2.50|-|true|true', 'Trail 4 still needs its photo');
select is(pg_temp.trails(), 5, 'photos create no Trail');
update public.sled_measurement_photos set deleted_at = now(), version = version where id = pg_temp.v('ph1')::uuid;
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|true', 'removing the only new photo brings Photo Needed back');
update public.sled_measurement_photos set deleted_at = null, version = version where id = pg_temp.v('ph1')::uuid;
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|false', 'restoring it clears it again');
insert into t select 'ph1_new', public.replace_suspension_measurement_photo(pg_temp.v('ph1')::uuid,
  (select version from public.sled_measurement_photos where id = pg_temp.v('ph1')::uuid), pg_temp.path('r5')) ->> 'id';
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|false', 'replacing it keeps it cleared');
-- Both slots full (an outdated inherited photo and a new one): a second new
-- photo takes the outdated inherited photo's place; Trail 4 keeps its own.
insert into t select 'ph2', pg_temp.add_photo('r5', 'pre');
select is(pg_temp.photos('r5', 'pre'), '2,0', 'the new photo replaced the outdated inherited copy');
select is(pg_temp.photos('r4', 'pre'), '0,1', 'the earlier Trail keeps its photo');
select throws_ok($$ select pg_temp.add_photo('r5', 'pre') $$, '23514', 'At most 2 photos per measurement.',
  'with two current photos a third is still refused');
update public.sled_measurement_photos set deleted_at = now(), version = version where id = pg_temp.v('ph1_new')::uuid;
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|false', 'with two new photos, removing one keeps it cleared');
update public.sled_measurement_photos set deleted_at = null, version = version where id = pg_temp.v('ph1_new')::uuid;

-- ---------------------------------------------------------------------------
-- After documenting: the measurement is the next Trail's value; turns restart
-- ---------------------------------------------------------------------------
insert into t select 'r6', pg_temp.save('r5', pg_temp.j('comp', '15'), '{}');
select is(pg_temp.val('r6', 'pre'), '11.5', 'the documented measurement is the new Trail''s value');
select is(pg_temp.st('r6', 'pre'), 'none', 'nothing outstanding to carry (the photo requirement was met)');
select is(pg_temp.photos('r6', 'pre'), '0,0', 'Trail 5''s own photos are current reference photos on Trail 6');
insert into t select 'r7', pg_temp.save('r6', '{}', pg_temp.turns('pre', 1));
select is(pg_temp.st('r7', 'pre'), '1.00|-|true|true', 'turns restart from the documented measurement');
select is(pg_temp.photos('r7', 'pre'), '0,2', 'and mark the carried photos outdated');

-- An unmet photo requirement carries forward even after the measurement.
select is((pg_temp.record('r7', 'pre', '12.5') ->> 'duplicate')::boolean, false, 'Trail 7 measured');
insert into t select 'r8', pg_temp.save('r7', pg_temp.j('comp', '16'), '{}');
select is(pg_temp.val('r8', 'pre'), '12.5', 'the measurement carries as the value');
select is(pg_temp.st('r8', 'pre'), '-|-|false|true', 'the unmet Photo Needed carries forward');
select is(pg_temp.photos('r8', 'pre'), '0,2', 'Trail 8 inherited two outdated photos (both slots)');
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
insert into t select 'ph8', pg_temp.add_photo('r8', 'pre');
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
select is(pg_temp.st('r8', 'pre'), '-|-|false|false', 'a mechanic''s new photo on Trail 8 clears it there');
select is(pg_temp.st('r7', 'pre'), '1.00|12.5|false|true', 'Trail 7 keeps its own Photo Needed');
select is(pg_temp.trails(), 8, 'eight Trails');

-- Back to zero: the measurement stays blank and Measurement Needed stays on.
insert into t select 'r9', pg_temp.save('r8', '{}', pg_temp.turns('pre', 1));
insert into t select 'r10', pg_temp.save('r9', '{}', pg_temp.turns('pre', -1));
select is(pg_temp.st('r10', 'pre'), '0.00|-|true|true', 'cumulative 0 keeps Measurement Needed on');
select is(pg_temp.val('r10', 'pre'), '-', 'and the measurement blank');

-- ---------------------------------------------------------------------------
-- Activating an older Trail restores its status; documenting it leaves newer Trails alone
-- ---------------------------------------------------------------------------
select is((public.activate_suspension_configuration(pg_temp.v('r4')::uuid) ->> 'already_active')::boolean, false, 'Trail 4 made active');
select is(pg_temp.st('r4', 'pre'), '2.50|-|true|true', 'its own reminders are back');
select lives_ok($$ select pg_temp.record('r4', 'pre', '11') $$, 'Trail 4 can be documented now that it is active');
select is(pg_temp.st('r4', 'pre'), '2.50|11|false|true', 'Trail 4 documented');
select is(pg_temp.st('r5', 'pre'), '2.50|11.5|false|false', 'Trail 5 is unchanged');
select is(pg_temp.st('r10', 'pre'), '0.00|-|true|true', 'Trail 10 is unchanged');
select is(pg_temp.trails(), 10, 'documenting created no Trail');
select ok(public.activate_suspension_configuration(pg_temp.v('r10')::uuid) is not null, 'Trail 10 active again');

-- Repeating a save (same key) does not add a second adjustment.
insert into t select 'key', gen_random_uuid()::text;
insert into t select 'r11', public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r10')::uuid, '{}',
  null, null, null, null, null, pg_temp.v('key')::uuid, pg_temp.turns('pre', 0.5)) ->> 'revision_id';
select is((public.save_suspension_configuration(pg_temp.v('sled')::uuid, pg_temp.v('r10')::uuid, '{}',
  null, null, null, null, null, pg_temp.v('key')::uuid, pg_temp.turns('pre', 0.5)) ->> 'duplicate')::boolean, true, 'a repeated save is recognised');
select is((select count(*)::int from public.sled_turn_adjustments where revision_id = pg_temp.v('r11')::uuid), 1, 'one adjustment');
select is(pg_temp.st('r11', 'pre'), '0.50|-|true|true', 'cumulative +0.5');

-- ---------------------------------------------------------------------------
-- Turns only: no reminders; switch to Both, document, then Measurement only
-- ---------------------------------------------------------------------------
insert into t select 'r12', pg_temp.save('r11', '{}', pg_temp.turns('col', 3));
select is(pg_temp.st('r12', 'col'), '3.00|-|false|false', 'Turns only: cumulative turns, no reminders');
select is(pg_temp.st('r12', 'pre'), '0.50|-|true|true', 'Preload carries forward');
select throws_ok($$ update public.suspension_settings set input_methods = 'measurement', version = version where id = pg_temp.v('col')::uuid $$,
  '23514', 'Record a measurement for Collar on the active Trail before switching it to Measurement only.',
  'a setting cannot drop Turns while turns are outstanding');
select lives_ok($$ update public.suspension_settings set input_methods = 'both', version = version where id = pg_temp.v('col')::uuid $$,
  'Turns only can switch to Both');
select lives_ok($$ select pg_temp.record('r12', 'col', '4.75') $$, 'then its measurement can be documented');
select lives_ok($$ update public.suspension_settings set input_methods = 'measurement', version = version where id = pg_temp.v('col')::uuid $$,
  'and it can switch to Measurement only');
select is((select count(*)::int from public.sled_turn_adjustments where setting_id = pg_temp.v('col')::uuid), 1,
  'its turns history is kept');
insert into t select 'r13', pg_temp.save('r12', pg_temp.j('col', '5'), '{}');
select is(pg_temp.val('r13', 'col'), '5', 'it is now changed like any measurement');
select is(pg_temp.st('r13', 'col'), 'none', 'with nothing outstanding');
select throws_ok($$ update public.suspension_settings set input_methods = 'measurement', version = version where id = pg_temp.v('pre')::uuid $$,
  '23514', null, 'Preload (turns outstanding on the active Trail) cannot drop Turns either');

-- Viewers can't save; status rows stay read-only even for owners.
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select throws_ok($$ select pg_temp.save('r13', '{}', pg_temp.turns('pre', 1)) $$, '42501', null, 'a viewer cannot adjust');
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
select throws_ok($$ update public.sled_trail_settings set measurement_needed = false $$, '42501', null, 'status rows cannot be edited directly');
select throws_ok($$ insert into public.sled_turn_adjustments (sled_id, revision_id, setting_id, amount)
  values (pg_temp.v('sled')::uuid, pg_temp.v('r13')::uuid, pg_temp.v('pre')::uuid, 1) $$, '42501', null, 'adjustments cannot be added directly');
select throws_ok($$ delete from public.sled_measurement_records $$, '42501', null, 'records cannot be deleted directly');

-- Nothing else changed: older values and Trail numbers are as saved.
select is(pg_temp.val('r1', 'pre'), '10', 'Trail 1 still has its original Preload value');
select is(pg_temp.val('r4', 'comp'), '12', 'Trail 4 still has its original Compression value');
select is((select config_number from public.suspension_revisions where id = pg_temp.active()), 13, 'Trail 13 is active');

-- A sled's Trails purged with it remove their turns data (cascade).
reset role;
select is((select count(*)::int from public.sled_trail_settings where sled_id = pg_temp.v('sled')::uuid) > 0, true, 'status rows exist');
delete from public.sleds where id = pg_temp.v('sled')::uuid;
select is((select count(*)::int from public.sled_trail_settings where sled_id = pg_temp.v('sled')::uuid)
          + (select count(*)::int from public.sled_turn_adjustments where sled_id = pg_temp.v('sled')::uuid)
          + (select count(*)::int from public.sled_measurement_records where sled_id = pg_temp.v('sled')::uuid), 0,
  'removing the snowmobile removes its turns data');

select * from finish();
rollback;
