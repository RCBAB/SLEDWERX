-- Tests for migration 20261112180000_foundation_garages_sleds_sharing.
-- Run with: npx supabase test db   (requires the local Supabase stack)
--
-- Everything runs in one transaction that is rolled back.
-- Identity is simulated the way PostgREST does it: role + JWT claims.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(150);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Users: Alex (owner), Blake, Casey, Drew (email not yet confirmed)
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@example.com',  now(), '{"display_name":"Alex"}'),
  ('22222222-2222-2222-2222-222222222222', 'blake@example.com', now(), '{"display_name":"Blake"}'),
  ('33333333-3333-3333-3333-333333333333', 'casey@example.com', now(), '{"display_name":"Casey"}'),
  ('44444444-4444-4444-4444-444444444444', 'drew@example.com',  null,  '{}');

-- Scratch table for values passed between identities (tokens, ids).
create temporary table t (k text primary key, v text) on commit drop;
grant select, insert, update on t to authenticated, anon;

insert into t
select 'garage_' || u.email, g.id::text
from public.garages g join auth.users u on u.id = g.owner_id
where g.is_default;

-- ---------------------------------------------------------------------------
-- Blanket checks
-- ---------------------------------------------------------------------------
select is_empty($$ select tablename from pg_tables where schemaname = 'public' and not rowsecurity $$,
  'every public table has Row Level Security enabled');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') $$,
  'anonymous users cannot execute any SledWerx function');
select is_empty($$ select table_name from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public' $$,
  'anonymous users have no privileges on any public table');
select is_empty($$ select table_name || ':' || privilege_type from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema = 'public'
    and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') $$,
  'signed-in users cannot hard-delete or truncate any table');

-- ---------------------------------------------------------------------------
-- Sign-up
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles), 4, 'sign-up creates a profile');
select is((select count(*)::int from public.user_preferences where theme = 'dark'), 4,
  'sign-up creates preferences with the dark theme');
select is((select count(*)::int from public.garages where is_default), 4,
  'sign-up creates one default garage per user');
select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alex', 'display name comes from sign-up metadata');

-- ---------------------------------------------------------------------------
-- Owner: create sleds
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$
  insert into public.sleds (id, garage_id, model_year, make, model, nickname)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select v::uuid from t where k = 'garage_alex@example.com'),
          2024, 'Polaris', 'RMK Khaos 850', 'Blue')
$$, 'owner can add a sled to their garage');

select lives_ok($$
  insert into public.sleds (id, garage_id, model_year, make, model, created_by)
  values ('aaaaaaaa-0000-0000-0000-000000000002',
          (select v::uuid from t where k = 'garage_alex@example.com'),
          2022, 'Ski-Doo', 'Summit X 850', '22222222-2222-2222-2222-222222222222')
$$, 'owner can add a second sled');

select is((select owner_id from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'sled owner is the garage owner');
select is((select created_by from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'created_by cannot be forged by the client');
select is((select version from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1, 'new records start at version 1');

select throws_ok($$
  insert into public.sleds (garage_id, model_year, make, model)
  values ((select v::uuid from t where k = 'garage_blake@example.com'), 2020, 'Arctic Cat', 'M 8000')
$$, '23503', 'Garage not found.', 'owner cannot add a sled to someone else''s garage');

update public.sleds set owner_id = '22222222-2222-2222-2222-222222222222', nickname = 'Blue 2'
where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select owner_id from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'owner_id cannot be changed by update');
select is((select version from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  2, 'version increments on update');

-- Offline conflict detection: an update based on a stale version changes nothing.
update public.sleds set nickname = 'Stale edit'
where id = 'aaaaaaaa-0000-0000-0000-000000000001' and version = 1;
select is((select nickname from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Blue 2', 'a stale-version update does not overwrite newer data');

select throws_ok($$ select private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'fly') $$,
  '22023', null, 'unknown permission names are rejected');
select is(private.sled_role('aaaaaaaa-0000-0000-0000-000000000001'), 'owner', 'owner role is derived');

-- ---------------------------------------------------------------------------
-- Isolation: another user sees nothing
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is_empty($$ select 1 from public.sleds $$, 'other users cannot see a private garage''s sleds');
select is_empty($$ select 1 from public.garages where owner_id = '11111111-1111-1111-1111-111111111111' $$,
  'other users cannot see a private garage');
select is_empty($$ select 1 from public.profiles where id = '11111111-1111-1111-1111-111111111111' $$,
  'unconnected users cannot see each other''s profiles');
select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'blake@example.com', 'editor') $$,
  '42501', null, 'non-owners cannot share a sled');
select is(private.sled_role('aaaaaaaa-0000-0000-0000-000000000001'), null, 'no role without a share');

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into t select 'tok_blake', token
from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', ' Blake@Example.com ', 'viewer');
insert into t select 'tok_casey', token
from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'casey@example.com', 'editor');
insert into t select 'tok_drew', token
from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'drew@example.com', 'mechanic');

select is((select count(*)::int from public.sled_invitations where accepted_at is null and revoked_at is null),
  3, 'owner can create invitations');
select is((select email from public.sled_invitations where role = 'viewer'),
  'blake@example.com', 'invitation emails are normalized');

-- Re-inviting the same person replaces the pending invitation.
insert into t select 'tok_casey_old', v from t where k = 'tok_casey';
update t set v = (select token from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'casey@example.com', 'editor'))
where k = 'tok_casey';
select is((select count(*)::int from public.sled_invitations where email = 'casey@example.com' and revoked_at is null),
  1, 're-inviting replaces the earlier pending invitation');

select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'alex@example.com', 'editor') $$,
  '22023', null, 'owner cannot invite themselves');
select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'x@example.com', 'editor', 60) $$,
  '22023', null, 'invitation lifetime is limited to 30 days');
select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'not-an-email', 'editor') $$,
  '23514', null, 'invalid email addresses are rejected');

-- Wrong person cannot use someone else's invitation.
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_blake')) $$,
  '42501', 'This invitation is invalid or has expired.', 'an invitation only works for the invited email');
select throws_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_casey_old')) $$,
  '42501', 'This invitation is invalid or has expired.', 'a replaced invitation no longer works');
select throws_ok($$ select public.accept_sled_invitation('guess') $$,
  '42501', 'This invitation is invalid or has expired.', 'a made-up token does not work');

-- ---------------------------------------------------------------------------
-- Viewer
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(public.accept_sled_invitation((select v from t where k = 'tok_blake')),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'invited user can accept');
select throws_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_blake')) $$,
  '42501', null, 'an invitation cannot be used twice');
select results_eq($$ select id from public.sleds $$,
  $$ values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid) $$,
  'viewer sees only the shared sled, not the rest of the garage');
select is_empty($$ select 1 from public.garages where owner_id = '11111111-1111-1111-1111-111111111111' $$,
  'shared users cannot see the owner''s garage');
select is(private.sled_role('aaaaaaaa-0000-0000-0000-000000000001'), 'viewer', 'viewer role is recognized');
select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alex', 'shared users can see the owner''s display name');

update public.sleds set nickname = 'Viewer edit' where id = 'aaaaaaaa-0000-0000-0000-000000000001';

select throws_ok($$ insert into public.sled_shares (sled_id, user_id, role)
  values ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'editor') $$,
  '42501', null, 'users cannot grant themselves access directly');
select throws_ok($$ update public.sled_shares set role = 'editor' $$,
  '42501', null, 'users cannot change their own role directly');
select throws_ok($$ select public.update_sled_share_role((select id from public.sled_shares limit 1), 'editor') $$,
  'P0002', null, 'shared users cannot change roles through the API');
select is_empty($$ select 1 from public.audit_log
  where sled_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     or garage_id = (select v::uuid from t where k = 'garage_alex@example.com') $$,
  'shared users cannot read the owner''s audit history');
select ok(exists (select 1 from public.audit_log
  where garage_id = (select v::uuid from t where k = 'garage_blake@example.com')),
  'users can read the history of their own garage');
select is_empty($$ select 1 from public.sled_invitations $$, 'shared users cannot see invitations');

reset role;
select is((select nickname from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Blue 2', 'viewer updates have no effect');

-- ---------------------------------------------------------------------------
-- Editor
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_casey')) $$,
  'editor can accept');
update public.sleds set nickname = 'Editor edit', status = 'needs_attention'
where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select throws_ok($$ update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501', 'Only the owner can delete or restore a snowmobile.', 'editors cannot delete a sled');
select throws_ok($$ update public.sleds set garage_id = (select v::uuid from t where k = 'garage_casey@example.com')
  where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501', 'Only the owner can move a snowmobile.', 'editors cannot move a sled');
select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000001', 'x@example.com', 'viewer') $$,
  '42501', null, 'editors cannot manage sharing');
select throws_ok($$ select public.permanently_delete_sled('aaaaaaaa-0000-0000-0000-000000000001') $$,
  'P0002', null, 'editors cannot permanently delete');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'edit_records'), true,
  'editors can edit records');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'manage_sled'), false,
  'editors cannot manage the sled');

reset role;
select is((select nickname || '/' || status from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Editor edit/needs_attention', 'editor updates are saved');

-- ---------------------------------------------------------------------------
-- Mechanic (and email confirmation)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select throws_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_drew')) $$,
  '42501', null, 'an unconfirmed email cannot accept an invitation');

reset role;
update auth.users set email_confirmed_at = now() where id = '44444444-4444-4444-4444-444444444444';
set local role authenticated;

select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok_drew')) $$,
  'mechanic can accept after confirming their email');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'add_records'), true,
  'mechanics can add records');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'edit_sled'), false,
  'mechanics cannot edit sled details');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000001', 'soft_delete_records'), false,
  'mechanics cannot delete records');
update public.sleds set nickname = 'Mechanic edit' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select is((select nickname from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Editor edit', 'mechanic updates to sled details have no effect');

-- ---------------------------------------------------------------------------
-- Revocation and leaving
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.revoke_sled_share(
  (select id from public.sled_shares where user_id = '22222222-2222-2222-2222-222222222222' and revoked_at is null)) $$,
  'owner can revoke access');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds $$, 'revoked users lose access immediately');
select is((select count(*)::int from public.sled_shares where revoked_at is not null), 1,
  'revoked users can see their revoked share so devices can clear cached data');

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.revoke_sled_share((select id from public.sled_shares where revoked_at is null)) $$,
  'shared users can leave a shared sled');
select is_empty($$ select 1 from public.sleds $$, 'after leaving, the sled is no longer visible');

-- ---------------------------------------------------------------------------
-- Recently Deleted
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'owner can move a sled to Recently Deleted');
select is((select deleted_by from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'deleted_by is recorded');
select throws_ok($$ update public.sleds set nickname = 'x' where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501', null, 'deleted sleds cannot be edited until restored');

set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds $$, 'deleted sleds are hidden from shared users');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update public.sleds set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'owner can restore within 30 days');

set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds $$, 'restoring a sled does not reactivate shared access');
select ok(exists (select 1 from public.sled_shares where suspended_at is not null),
  'shared users can see that their access is suspended, so devices clear cached data');
select throws_ok($$ select public.reactivate_sled_share((select id from public.sled_shares where suspended_at is not null)) $$,
  'P0002', null, 'shared users cannot reactivate their own access');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.reactivate_sled_share(
  (select id from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000001' and suspended_at is not null)) $$,
  'the owner chooses whose access to reactivate');

set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is((select count(*)::int from public.sleds), 1, 'reactivated users regain access');

-- Sled 2 deleted 31 days ago (simulated as a trusted server context).
reset role;
set local request.jwt.claims = '';
alter table public.sleds disable trigger guard;
update public.sleds set deleted_at = now() - interval '31 days' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
alter table public.sleds enable trigger guard;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ update public.sleds set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000002' $$,
  '42501', 'This snowmobile is past the 30-day recovery period.', 'restore is refused after 30 days');
select throws_ok($$ select public.permanently_delete_sled('aaaaaaaa-0000-0000-0000-000000000001') $$,
  '42501', 'Move the snowmobile to Recently Deleted first.', 'permanent delete requires Recently Deleted first');

-- ---------------------------------------------------------------------------
-- Garages
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.garages set deleted_at = now() where is_default $$,
  '42501', 'The default garage cannot be deleted.', 'the default garage cannot be deleted');
select lives_ok($$ insert into public.garages (id, name, is_default)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'Shop', true) $$, 'owner can create another garage');
select is((select is_default from public.garages where id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  false, 'only the sign-up garage is the default');
insert into public.sleds (id, garage_id, model_year, make, model)
values ('aaaaaaaa-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 2019, 'Lynx', 'Boondocker');
select throws_ok($$ update public.garages set deleted_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001' $$,
  '23503', null, 'a garage with active sleds cannot be deleted');

update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select lives_ok($$ select public.permanently_delete_sled('aaaaaaaa-0000-0000-0000-000000000003') $$,
  'owner can permanently delete from Recently Deleted');
select is_empty($$ select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000003' $$,
  'permanent deletion removes the sled''s history');

-- ---------------------------------------------------------------------------
-- Offline version conflicts
-- ---------------------------------------------------------------------------
insert into t select 'v_s1', version::text from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.sleds set nickname = nickname where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select version::text from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  (select v from t where k = 'v_s1'), 'updates that change nothing do not bump the version');
select throws_ok($$ update public.sleds set nickname = 'From an old copy', version = version - 1
  where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'PT409', null, 'an update from an out-of-date copy is rejected as a conflict');
select lives_ok($$ update public.sleds set nickname = 'Current copy',
  version = (select v::int from t where k = 'v_s1')
  where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'an update from the current copy succeeds');
select is((select version from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  (select v::int + 1 from t where k = 'v_s1'), 'a successful change bumps the version');

-- ---------------------------------------------------------------------------
-- Recently Deleted integrity
-- ---------------------------------------------------------------------------
insert into public.sleds (id, garage_id, model_year, make, model)
values ('aaaaaaaa-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', 2021, 'Arctic Cat', 'Riot');
update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000004';
select lives_ok($$ update public.garages set deleted_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001' $$,
  'a garage whose sleds are all in Recently Deleted can be deleted');
select throws_ok($$ update public.sleds set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000004' $$,
  '42501', 'Restore the garage first, or move the snowmobile to another garage.',
  'a sled cannot be restored into a deleted garage');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000004', 'add_records'), false,
  'no records can be added to a sled in Recently Deleted');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000004', 'edit_records'), false,
  'records of a sled in Recently Deleted cannot be edited');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000004', 'view'), true,
  'the owner can still view a sled in Recently Deleted');
select lives_ok($$ update public.sleds set deleted_at = null,
  garage_id = (select v::uuid from t where k = 'garage_alex@example.com')
  where id = 'aaaaaaaa-0000-0000-0000-000000000004' $$,
  'a sled can be restored into another garage');

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
select ok((select count(*) from public.audit_log where table_name = 'sled_shares'
           and 'revoked_at' = any (changed_fields)) = 2,
  'share revocations are audited');
select ok(exists (select 1 from public.audit_log where table_name = 'sleds' and 'deleted_at' = any (changed_fields)),
  'deletes and restores are audited');
select throws_ok($$ insert into public.audit_log (action, table_name, record_id, sled_id)
  values ('update', 'sleds', gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001') $$,
  '42501', null, 'audit history cannot be written through the API');
select throws_ok($$ delete from public.audit_log $$, '42501', null, 'audit history cannot be deleted through the API');

reset role;
select is((select count(*)::int from public.audit_log where new_data ? 'token_hash' or old_data ? 'token_hash'),
  0, 'invitation token hashes are never written to the audit log');

-- ---------------------------------------------------------------------------
-- Role-based record permissions and audit history (Decisions 2, 3, 5, 6)
--
-- test_service_records is a stand-in built exactly as later maintenance
-- tables must be built: record guard, stamp, audit('maintenance') and the
-- documented RLS policies.
-- ---------------------------------------------------------------------------
create table public.test_service_records (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  note text,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create trigger guard before insert or update on public.test_service_records
  for each row execute function private.tg_sled_record_guard();
create trigger stamp before insert or update on public.test_service_records
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.test_service_records
  for each row execute function private.tg_audit('maintenance');
alter table public.test_service_records enable row level security;
revoke all on public.test_service_records from anon, authenticated;
grant select, insert, update on public.test_service_records to authenticated;
create policy records_select on public.test_service_records for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy records_insert on public.test_service_records for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy records_update on public.test_service_records for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.sleds (id, garage_id, model_year, make, model)
values ('aaaaaaaa-0000-0000-0000-000000000005', (select v::uuid from t where k = 'garage_alex@example.com'), 2023, 'Ski-Doo', 'Freeride');
insert into t select 'tok5_blake', token from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000005', 'blake@example.com', 'editor');
insert into t select 'tok5_casey', token from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000005', 'casey@example.com', 'viewer');
insert into t select 'tok5_drew', token from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000005', 'drew@example.com', 'mechanic');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok5_blake')) $$, 'editor joins sled 5');
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok5_casey')) $$, 'viewer joins sled 5');
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ select public.accept_sled_invitation((select v from t where k = 'tok5_drew')) $$, 'mechanic joins sled 5');

-- Mechanic
select lives_ok($$ insert into public.test_service_records (id, sled_id, note)
  values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000005', 'Chaincase oil changed') $$, 'mechanics can create maintenance records');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select lives_ok($$ insert into public.test_service_records (id, sled_id, note)
  values ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000005', 'Editor note') $$, 'editors can create maintenance records');

set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok($$ update public.test_service_records set note = 'Chaincase oil changed (corrected)' where id = 'cccccccc-0000-0000-0000-000000000001' $$,
  'mechanics can correct their own records');
update public.test_service_records set note = 'Mechanic edit' where id = 'cccccccc-0000-0000-0000-000000000002';
select is((select note from public.test_service_records where id = 'cccccccc-0000-0000-0000-000000000002'), 'Editor note',
  'mechanics cannot edit records created by others');
select throws_ok($$ update public.test_service_records set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000001' $$,
  '42501', 'Only the owner can delete records.', 'mechanics cannot delete records');
select throws_ok($$ update public.test_service_records set sled_id = 'aaaaaaaa-0000-0000-0000-000000000001' where id = 'cccccccc-0000-0000-0000-000000000001' $$,
  '42501', 'Records cannot be moved to another snowmobile.', 'records cannot be moved to another sled');
select ok(exists (select 1 from public.audit_log where record_id = 'cccccccc-0000-0000-0000-000000000001'),
  'mechanics can view the history of records they created');
select is_empty($$ select 1 from public.audit_log where record_id = 'cccccccc-0000-0000-0000-000000000002' $$,
  'mechanics cannot view the history of records created by others');
select is_empty($$ select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and category <> 'maintenance' $$,
  'mechanics cannot view sled or sharing history');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000005', 'manage_sled'), false, 'mechanics cannot manage sharing or ownership');

-- Viewer
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ insert into public.test_service_records (sled_id, note) values ('aaaaaaaa-0000-0000-0000-000000000005', 'Viewer note') $$,
  '42501', null, 'viewers cannot create records');
select is((select count(*)::int from public.test_service_records), 2, 'viewers can read maintenance records');
select is_empty($$ select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'viewers cannot view any audit history');

-- Editor
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select ok(exists (select 1 from public.audit_log where record_id = 'cccccccc-0000-0000-0000-000000000001')
          and exists (select 1 from public.audit_log where record_id = 'cccccccc-0000-0000-0000-000000000002'),
  'editors can view the history of all maintenance records');
select ok(exists (select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and category = 'sled'),
  'editors can view the sled''s change history');
select is_empty($$ select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and category = 'sharing' $$,
  'editors cannot view sharing history (emails, invitations, user ids)');
select is_empty($$ select 1 from public.audit_log where garage_id = (select v::uuid from t where k = 'garage_alex@example.com') $$,
  'editors cannot view the owner''s garage history');
select is_empty($$ select 1 from public.audit_log where new_data ? 'email' or old_data ? 'email' $$,
  'no invitation email addresses are visible to editors');
select lives_ok($$ update public.test_service_records set note = 'Editor correction' where id = 'cccccccc-0000-0000-0000-000000000001' $$,
  'editors can edit any record');
select throws_ok($$ update public.test_service_records set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000002' $$,
  '42501', 'Only the owner can delete records.', 'editors cannot delete records');
select is(private.has_sled_permission('aaaaaaaa-0000-0000-0000-000000000005', 'restore_records'), false, 'editors cannot restore records');
select throws_ok($$ update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$,
  '42501', 'Only the owner can delete or restore a snowmobile.', 'editors cannot move a snowmobile to Recently Deleted');
select throws_ok($$ select public.permanently_delete_sled('aaaaaaaa-0000-0000-0000-000000000005') $$,
  'P0002', null, 'editors cannot permanently delete a snowmobile');
select throws_ok($$ select public.reactivate_sled_share((select id from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and user_id = '22222222-2222-2222-2222-222222222222')) $$,
  'P0002', null, 'editors cannot manage shares');

-- Owner
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update public.test_service_records set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000002' $$,
  'owners can delete records');
select lives_ok($$ update public.test_service_records set deleted_at = null where id = 'cccccccc-0000-0000-0000-000000000002' $$,
  'owners can restore records');
select ok(exists (select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and category = 'sharing'),
  'owners can view sharing history');
select ok((select count(*) from public.audit_log where record_id = 'cccccccc-0000-0000-0000-000000000001') >= 3,
  'every change to a maintenance record is audited');

-- Moving the sled to Recently Deleted suspends sharing
insert into t select 'tok5_erin', token from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000005', 'erin@example.com', 'viewer');
select lives_ok($$ update public.sleds set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'owner moves sled 5 to Recently Deleted');
select is((select count(*)::int from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and suspended_at is not null and revoked_at is null),
  3, 'all shares are suspended, and kept for the recovery period');
select is((select count(*)::int from public.sled_invitations where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and accepted_at is null and revoked_at is null),
  0, 'pending invitations are revoked');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'editors lose access immediately');
select is_empty($$ select 1 from public.test_service_records $$, 'shared users cannot read records of a deleted sled');
select is_empty($$ select 1 from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'shared users cannot read history of a deleted sled');
select is(private.sled_role('aaaaaaaa-0000-0000-0000-000000000005'), null, 'suspended users have no role on the sled');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ select public.reactivate_sled_share((select id from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and user_id = '22222222-2222-2222-2222-222222222222')) $$,
  '42501', null, 'access cannot be reactivated while the sled is deleted');
select lives_ok($$ update public.sleds set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'owner restores sled 5');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'restoring the sled does not reactivate the editor');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.reactivate_sled_share((select id from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000005' and user_id = '22222222-2222-2222-2222-222222222222')) $$,
  'owner reactivates only the editor');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000005'), 1, 'the reactivated editor regains access');
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is_empty($$ select 1 from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000005' $$, 'users who were not reactivated stay suspended');
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$ select * from public.create_sled_invitation('aaaaaaaa-0000-0000-0000-000000000005', 'x@example.com', 'editor') $$,
  '42501', null, 'suspended users cannot share the sled');

reset role;

-- ---------------------------------------------------------------------------
-- Anonymous access
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select 1 from public.sleds $$, '42501', null, 'anonymous users cannot read sleds');
select throws_ok($$ select public.accept_sled_invitation('x') $$, '42501', null,
  'anonymous users cannot call sharing functions');

-- ---------------------------------------------------------------------------
-- Cleanup and account deletion (trusted server context)
-- ---------------------------------------------------------------------------
reset role;
set local request.jwt.claims = '';
select throws_ok($$ delete from public.garages where id = (select v::uuid from t where k = 'garage_alex@example.com') $$,
  '23503', null, 'deleting a garage row directly cannot cascade-delete its sleds');
select is((private.purge_expired_records() ->> 'sleds')::int, 1, 'cleanup removes sleds past 30 days');
select is_empty($$ select 1 from public.sleds where id = 'aaaaaaaa-0000-0000-0000-000000000002' $$,
  'the expired sled is gone');

delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from public.garages where owner_id = '11111111-1111-1111-1111-111111111111')
        + (select count(*)::int from public.sleds where owner_id = '11111111-1111-1111-1111-111111111111')
        + (select count(*)::int from public.sled_shares where sled_id = 'aaaaaaaa-0000-0000-0000-000000000001')
        + (select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  0, 'deleting an account removes their garages, sleds, shares and profile');
select is((select count(*)::int from public.audit_log where sled_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'deleting an account removes the audit history of their sleds');

select * from finish();
rollback;
