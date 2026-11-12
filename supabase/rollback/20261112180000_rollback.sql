-- =============================================================================
-- SledWerx — ROLLBACK for Migration 1
--   20261112180000_foundation_garages_sleds_sharing.sql
--
-- MANUAL USE ONLY. Read supabase/rollback/README.md first.
--
-- * Removes every object Migration 1 created and its migration-history row,
--   in ONE transaction: either everything is removed or nothing is.
-- * REFUSES to run unless the operator has confirmed it in the same session:
--       set sledwerx.confirm_rollback = '20261112180000';
-- * REFUSES to run if any of the seven SledWerx tables contains a row, so it
--   can never delete user data. Only for use before real users exist.
-- * This file lives outside supabase/migrations/ and is not listed in
--   supabase/config.toml, so the Supabase CLI never runs it.
-- =============================================================================
begin;

-- 1. Safety checks: explicit confirmation, then abort if any data exists.
do $$
declare
  v_rows bigint := 0;
  v_table text;
begin
  if current_setting('sledwerx.confirm_rollback', true) is distinct from '20261112180000' then
    raise exception 'Rollback not confirmed. Run  set sledwerx.confirm_rollback = ''20261112180000'';  first, in the same session. See supabase/rollback/README.md.';
  end if;

  foreach v_table in array array[
    'profiles', 'user_preferences', 'garages', 'sleds',
    'sled_invitations', 'sled_shares', 'audit_log'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('select count(*) from public.%I', v_table) into strict v_rows;
      if v_rows > 0 then
        raise exception 'Rollback aborted: public.% contains % row(s). Do not roll back once data exists; fix forward instead.', v_table, v_rows;
      end if;
    end if;
  end loop;
end $$;

-- 2. Sign-up trigger on auth.users first, so sign-ups never call a missing function.
drop trigger if exists on_auth_user_created on auth.users;

-- 3. API functions.
drop function if exists public.create_sled_invitation(uuid, text, public.sled_share_role, integer);
drop function if exists public.revoke_sled_invitation(uuid);
drop function if exists public.accept_sled_invitation(text);
drop function if exists public.update_sled_share_role(uuid, public.sled_share_role);
drop function if exists public.reactivate_sled_share(uuid);
drop function if exists public.revoke_sled_share(uuid);
drop function if exists public.permanently_delete_sled(uuid);

-- 4. Tables (their triggers, RLS policies, indexes and constraints go with them).
--    Children first; no CASCADE, so anything unexpected that depends on them
--    makes the rollback fail safely instead of silently dropping it.
drop table if exists public.audit_log;
drop table if exists public.sled_shares;
drop table if exists public.sled_invitations;
drop table if exists public.sleds;
drop table if exists public.garages;
drop table if exists public.user_preferences;
drop table if exists public.profiles;

-- 5. Helper and trigger functions, then the private schema (no CASCADE: fails
--    if anything not created by Migration 1 is in it).
drop function if exists
  private.recovery_window(),
  private.tg_stamp(),
  private.owned_sled_ids(),
  private.owned_garage_ids(),
  private.shared_sled_ids(public.sled_share_role[]),
  private.sled_role(uuid),
  private.has_sled_permission(uuid, text),
  private.can_modify_sled_record(uuid, uuid),
  private.connected_user_ids(),
  private.tg_garages_guard(),
  private.tg_sleds_guard(),
  private.tg_sharing_guard(),
  private.tg_sleds_suspend_sharing(),
  private.tg_sled_record_guard(),
  private.tg_audit(),
  private.purge_expired_records(),
  private.handle_new_user();
drop schema if exists private;

-- 6. Types.
drop type if exists public.sled_share_role;
drop type if exists public.sled_status;
drop type if exists public.theme_preference;

-- 7. Migration history, so the CLI sees Migration 1 as not applied.
delete from supabase_migrations.schema_migrations where version = '20261112180000';

-- 8. Verify nothing is left; abort (and undo the rollback) if anything is.
do $$
begin
  if to_regnamespace('private') is not null
     or exists (select 1 from pg_tables where schemaname = 'public'
                and tablename in ('profiles','user_preferences','garages','sleds','sled_invitations','sled_shares','audit_log'))
     or exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')
     or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where n.nspname = 'public' and t.typname in ('sled_share_role','sled_status','theme_preference'))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname in ('create_sled_invitation','revoke_sled_invitation',
                  'accept_sled_invitation','update_sled_share_role','reactivate_sled_share','revoke_sled_share',
                  'permanently_delete_sled'))
  then
    raise exception 'Rollback verification failed: Migration 1 objects remain. Nothing was changed.';
  end if;
  raise notice 'Rollback complete: all Migration 1 objects removed.';
end $$;

commit;
