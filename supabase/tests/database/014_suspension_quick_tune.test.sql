-- Tests for migration 20261123090000_suspension_quick_tune (Phase 6.2 redesign):
-- numbered configurations, equipment snapshots, the active configuration,
-- activation with equipment confirmation, and ride evaluations.
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(64);

insert into auth.users (id, email, email_confirmed_at) values
  ('e1111111-1111-1111-1111-111111111111', 'qt-owner@example.com', now()),
  ('e2222222-2222-2222-2222-222222222222', 'qt-mech@example.com',  now()),
  ('e3333333-3333-3333-3333-333333333333', 'qt-view@example.com',  now()),
  ('e4444444-4444-4444-4444-444444444444', 'qt-other@example.com', now());

create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;
create function pg_temp.v(p_k text) returns text language sql stable as $$ select v from t where k = p_k $$;
grant execute on function pg_temp.v(text) to authenticated, anon;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;
-- Save a configuration as the current user; returns the result object.
create function pg_temp.save(p_base text, p_changes jsonb, p_ski text default null, p_carbide text default null,
                             p_key uuid default gen_random_uuid())
returns jsonb language sql volatile as $$
  select public.save_suspension_configuration(pg_temp.v('sled')::uuid, nullif(p_base, '')::uuid, p_changes, p_ski, p_carbide,
                                              null, null, null, p_key);
$$;
grant execute on function pg_temp.save(text, jsonb, text, text, uuid) to authenticated, anon;
create function pg_temp.active() returns uuid language sql stable as $$
  select active_revision_id from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid;
$$;
grant execute on function pg_temp.active() to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
insert into t select 'sled', public.create_sled('Ski-Doo', 'Summit', 2024, 100)::text;
insert into t select 'tok_me', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'qt-mech@example.com', 'mechanic');
insert into t select 'tok_vi', token from public.create_sled_invitation(pg_temp.v('sled')::uuid, 'qt-view@example.com', 'viewer');
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
select public.accept_sled_invitation(pg_temp.v('tok_me'));
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select public.accept_sled_invitation(pg_temp.v('tok_vi'));

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
reset role;
select has_table('public', 'sled_suspension_state', 'sled_suspension_state exists');
select is((select relrowsecurity from pg_class where oid = 'public.sled_suspension_state'::regclass), true, 'RLS is on for the state');
select has_column('public', 'suspension_revisions', 'config_number', 'revisions have a configuration number');
select has_column('public', 'suspension_revisions', 'ski_model', 'revisions record the ski model');
select has_column('public', 'suspension_revisions', 'carbide_length', 'revisions record the carbide length');
select has_column('public', 'suspension_feedback', 'conditions', 'feedback records trail conditions');
select has_column('public', 'suspension_feedback', 'high_temp_f', 'feedback records the high temperature');
select is(has_table_privilege('authenticated', 'public.sled_suspension_state', 'insert')
          or has_table_privilege('authenticated', 'public.sled_suspension_state', 'update'), false,
  'signed-in users cannot write the state directly');
select is(has_function_privilege('anon', 'public.save_suspension_configuration(uuid,uuid,jsonb,text,text,text,numeric,numeric,uuid)', 'execute')
          or has_function_privilege('anon', 'public.activate_suspension_configuration(uuid,boolean)', 'execute'), false,
  'anonymous users cannot call the new functions');
select is((select cardinality(private.cleanup_registry_problems())), 0, 'the Migration 8 cleanup registry is still complete');

-- Settings (owner).
set local role authenticated;
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Compression', 'front_left_shock', 'clicks') returning id)
insert into t select 'comp_l', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Compression', 'front_right_shock', 'clicks') returning id)
insert into t select 'comp_r', id::text from x;
with x as (insert into public.suspension_settings (sled_id, name, zone, unit)
  values (pg_temp.v('sled')::uuid, 'Limiter strap', 'rear_springs_limiter', 'hole') returning id)
insert into t select 'strap', id::text from x;

-- ---------------------------------------------------------------------------
-- Trail 1, Trail 2, ...
-- ---------------------------------------------------------------------------
select is(pg_temp.active(), null, 'no active configuration before the first save');
insert into t select 'r1', (pg_temp.save('', jsonb_build_object(pg_temp.v('comp_l'), '10', pg_temp.v('comp_r'), '10'),
  'ca_pro_xpt', '6') ->> 'revision_id');
select is((select config_number from public.suspension_revisions where id = pg_temp.v('r1')::uuid), 1, 'the first save is Trail 1');
select is((select name from public.suspension_setups s join public.suspension_revisions r on r.setup_id = s.id
           where r.id = pg_temp.v('r1')::uuid), 'Trail', 'it goes into a setup made for it');
select is(pg_temp.active(), pg_temp.v('r1')::uuid, 'Trail 1 is active');
select is((select ski_model || ' ' || carbide_length from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid),
  'ca_pro_xpt 6', 'the installed equipment is recorded');

-- Several changes at once.
insert into t select 'r2', (pg_temp.save(pg_temp.v('r1'), jsonb_build_object(pg_temp.v('comp_l'), '12', pg_temp.v('comp_r'), '12',
  pg_temp.v('strap'), '3')) ->> 'revision_id');
select is((select config_number from public.suspension_revisions where id = pg_temp.v('r2')::uuid), 2, 'the next save is Trail 2');
select is((select setting_values -> pg_temp.v('comp_l') ->> 'value' || '/' || (setting_values -> pg_temp.v('strap') ->> 'value')
           from public.suspension_revisions where id = pg_temp.v('r2')::uuid), '12/3', 'all changes are saved together');
select is((select ski_model || ' ' || carbide_length from public.suspension_revisions where id = pg_temp.v('r2')::uuid),
  'ca_pro_xpt 6', 'it records the installed equipment');
select is((select based_on_revision_id from public.suspension_revisions where id = pg_temp.v('r2')::uuid), pg_temp.v('r1')::uuid,
  'it records what it was made from');
select is((select setting_values -> pg_temp.v('comp_l') ->> 'value' from public.suspension_revisions where id = pg_temp.v('r1')::uuid),
  '10', 'Trail 1 is unchanged');
select is(pg_temp.active(), pg_temp.v('r2')::uuid, 'Trail 2 is active');

-- No duplicates.
select throws_ok($$ select pg_temp.save(pg_temp.v('r2'), jsonb_build_object(pg_temp.v('comp_l'), '12')) $$,
  '22023', 'Nothing changed.', 'saving without a change is refused');
select throws_ok($$ select pg_temp.save(pg_temp.v('r2'), '{}'::jsonb, 'ca_pro_xpt', '6') $$,
  '22023', 'Nothing changed.', 'choosing the installed equipment again is refused');
insert into t values ('key', gen_random_uuid()::text);
insert into t select 'r3', (pg_temp.save(pg_temp.v('r2'), jsonb_build_object(pg_temp.v('strap'), '4'), null, null, pg_temp.v('key')::uuid) ->> 'revision_id');
select is((pg_temp.save(pg_temp.v('r2'), jsonb_build_object(pg_temp.v('strap'), '4'), null, null, pg_temp.v('key')::uuid) ->> 'duplicate')::boolean,
  true, 'a retry with the same key returns the saved configuration');
select is((select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid), 3, 'and saves nothing new');
select throws_ok($$ select pg_temp.save(pg_temp.v('r2'), jsonb_build_object(pg_temp.v('strap'), '5')) $$,
  'PT409', null, 'a save from a configuration that is no longer active is refused');

-- Equipment change: a new configuration with the same values.
insert into t select 'r4', (pg_temp.save(pg_temp.v('r3'), '{}'::jsonb, 'ca_pro_xcs', '7.5') ->> 'revision_id');
select is((select config_number || ' ' || ski_model || ' ' || carbide_length from public.suspension_revisions where id = pg_temp.v('r4')::uuid),
  '4 ca_pro_xcs 7.5', 'changing skis and carbides saves Trail 4 with them');
select is((select r4.setting_values = r3.setting_values from public.suspension_revisions r4, public.suspension_revisions r3
           where r4.id = pg_temp.v('r4')::uuid and r3.id = pg_temp.v('r3')::uuid), true, 'with every suspension value copied');
select is((select ski_model || ' ' || carbide_length from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid),
  'ca_pro_xcs 7.5', 'the installed equipment follows');
select is((select ski_model || ' ' || carbide_length from public.suspension_revisions where id = pg_temp.v('r3')::uuid),
  'ca_pro_xpt 6', 'earlier configurations keep their equipment');
select is(pg_temp.active(), pg_temp.v('r4')::uuid, 'Trail 4 is active');
select throws_ok($$ select pg_temp.save(pg_temp.v('r4'), '{}'::jsonb, 'skinny', null) $$, '22023', 'Choose a ski model.',
  'unknown ski models are refused');
select throws_ok($$ select pg_temp.save(pg_temp.v('r4'), '{}'::jsonb, null, '8') $$, '22023', 'Choose a carbide length.',
  'unknown carbide lengths are refused');

-- Configurations can't be edited.
select throws_ok($$ update public.suspension_revisions set ski_model = 'ca_pro_xpt' where id = pg_temp.v('r4')::uuid $$,
  '42501', null, 'a saved configuration cannot be changed');

-- ---------------------------------------------------------------------------
-- Activating older configurations
-- ---------------------------------------------------------------------------
select is((public.activate_suspension_configuration(pg_temp.v('r4')::uuid) ->> 'already_active')::boolean, true,
  'activating the active configuration changes nothing');
select throws_ok($$ select public.activate_suspension_configuration(pg_temp.v('r2')::uuid) $$,
  'P0001', 'Trail 2 uses different skis or carbides than the ones installed. Confirm the equipment is installed first.',
  'other equipment must be confirmed');
select is(pg_temp.active(), pg_temp.v('r4')::uuid, 'nothing changed after the refusal');
select is((public.activate_suspension_configuration(pg_temp.v('r2')::uuid, true) ->> 'equipment_changed')::boolean, true,
  'with confirmation, Trail 2 is activated');
select is(pg_temp.active(), pg_temp.v('r2')::uuid, 'Trail 2 is active');
select is((select ski_model || ' ' || carbide_length from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid),
  'ca_pro_xpt 6', 'and the installed equipment is updated');
select is((select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid), 4,
  'activating never creates a configuration');
select is((public.activate_suspension_configuration(pg_temp.v('r3')::uuid) ->> 'equipment_changed')::boolean, false,
  'same equipment: activated without confirmation');
-- Back to the newest, then the next save is Trail 5 based on it.
select lives_ok($$ select public.activate_suspension_configuration(pg_temp.v('r1')::uuid) $$, 'Trail 1 can be activated again');
insert into t select 'r5', (pg_temp.save(pg_temp.v('r1'), jsonb_build_object(pg_temp.v('strap'), '2')) ->> 'revision_id');
select is((select config_number from public.suspension_revisions where id = pg_temp.v('r5')::uuid), 5,
  'a save from an older configuration gets the next number');
select is((select (setting_values -> pg_temp.v('comp_l') ->> 'value') || '/' || (setting_values -> pg_temp.v('strap') ->> 'value')
           from public.suspension_revisions where id = pg_temp.v('r5')::uuid), '10/2', 'with that configuration''s values');

-- The setup holding the active configuration stays.
select throws_ok($$ update public.suspension_setups set deleted_at = now(), version = version
                   where id = (select setup_id from public.suspension_revisions where id = pg_temp.v('r5')::uuid) $$,
  '23514', 'This setup holds the active configuration. Make another configuration active first.',
  'the setup with the active configuration cannot be deleted');

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
insert into t select 'r6', (pg_temp.save(pg_temp.v('r5'), jsonb_build_object(pg_temp.v('strap'), '3')) ->> 'revision_id');
select is((select config_number from public.suspension_revisions where id = pg_temp.v('r6')::uuid), 6, 'mechanics save configurations');
select lives_ok($$ select public.activate_suspension_configuration(pg_temp.v('r5')::uuid) $$, 'mechanics activate configurations');
select lives_ok($$ select pg_temp.save(pg_temp.v('r5'), '{}'::jsonb, 'ca_pro_xcs', null) $$, 'mechanics change equipment');
select is((select count(*)::int from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid), 1,
  'mechanics see the state');
select throws_ok($$ update public.sled_suspension_state set ski_model = 'ca_pro_xpt' $$,
  '42501', null, 'but cannot write it directly');

select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select throws_ok($$ select pg_temp.save(pg_temp.active()::text, jsonb_build_object(pg_temp.v('strap'), '9')) $$,
  '42501', null, 'viewers cannot save configurations');
select throws_ok($$ select public.activate_suspension_configuration(pg_temp.v('r1')::uuid) $$,
  '42501', null, 'viewers cannot activate configurations');

select pg_temp.as_user('e4444444-4444-4444-4444-444444444444');
select is_empty($$ select 1 from public.sled_suspension_state where sled_id = pg_temp.v('sled')::uuid $$,
  'others do not see the state');
select throws_ok($$ select public.activate_suspension_configuration(pg_temp.v('r1')::uuid) $$,
  'P0002', null, 'others cannot activate (not found)');
select throws_ok($$ select pg_temp.save(null, jsonb_build_object(pg_temp.v('strap'), '9')) $$,
  '42501', null, 'others cannot save');

-- ---------------------------------------------------------------------------
-- Ride evaluations
-- ---------------------------------------------------------------------------
select pg_temp.as_user('e2222222-2222-2222-2222-222222222222');
select lives_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, conditions, high_temp_f, note)
                   values (pg_temp.v('r2')::uuid, pg_temp.v('sled')::uuid, 'disliked', '{loose_snow,sloppy}', 28, 'Pushy') $$,
  'an evaluation records rating, conditions, temperature and notes');
select lives_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, conditions)
                   values (pg_temp.v('r2')::uuid, pg_temp.v('sled')::uuid, 'liked', '{hard_pack}') $$,
  'several evaluations per configuration');
select lives_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating)
                   values (pg_temp.v('r2')::uuid, pg_temp.v('sled')::uuid, 'neutral') $$,
  'conditions and temperature are optional');
select is((select count(*)::int from public.suspension_feedback where revision_id = pg_temp.v('r2')::uuid), 3,
  'all three are kept with Trail 2');
select is((select count(*)::int from public.suspension_revisions where sled_id = pg_temp.v('sled')::uuid), 7,
  'evaluations never create a configuration');
select throws_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, conditions)
                   values (pg_temp.v('r2')::uuid, pg_temp.v('sled')::uuid, 'liked', '{powder_day}') $$,
  '23514', null, 'unknown conditions are refused');
select throws_ok($$ insert into public.suspension_feedback (revision_id, sled_id, rating, high_temp_f)
                   values (pg_temp.v('r2')::uuid, pg_temp.v('sled')::uuid, 'liked', 200) $$,
  '23514', null, 'impossible temperatures are refused');

-- ---------------------------------------------------------------------------
-- Migration 7's functions keep working and get numbers too
-- ---------------------------------------------------------------------------
select pg_temp.as_user('e1111111-1111-1111-1111-111111111111');
insert into t select 'legacy', (public.create_suspension_setup(pg_temp.v('sled')::uuid, 'Powder') ->> 'revision_id');
select is((select config_number from public.suspension_revisions where id = pg_temp.v('legacy')::uuid), 8,
  'revisions from Migration 7''s functions are numbered too');

select * from finish();
rollback;
