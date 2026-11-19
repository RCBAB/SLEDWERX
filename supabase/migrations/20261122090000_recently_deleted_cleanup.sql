-- =============================================================================
-- SledWerx — Migration 8: Recently Deleted & storage cleanup (database part)
--
-- Permanently removes records whose 30-day recovery period has passed, and
-- finds photo files that no record points at, so a server-side job can remove
-- them through the Storage API. Nothing here runs on its own: a scheduled job
-- (built separately) calls the functions below with the service-role key.
--
-- Safety model
-- * Deletion is OFF by default (private.cleanup_settings.deletion_enabled).
--   It can only be switched on after at least 7 successful daily report-only
--   runs and with a recorded, verified backup reference.
-- * Report-only runs never delete: the candidate lists are produced by STABLE
--   functions, which PostgreSQL does not allow to change data.
-- * At most 200 rows per run (cascaded rows included, counted as they are
--   actually deleted) and 100 files per run; a group that does not fit is not
--   started, or is undone.
-- * Every eligibility rule is checked again inside the deleting statement, so
--   a record restored in the meantime is never removed.
-- * A file is only ever offered for removal when it is in a SledWerx photo
--   bucket, has a recognised SledWerx path, is at least 24 hours old (storage
--   timestamps) and no record of any state (active or Recently Deleted)
--   points at it. That is checked again, under a lock, when the file is
--   claimed, and a claimed path cannot be attached to a record.
-- * Existing storage policies are unchanged; mechanics still cannot delete
--   files. Audit history is unchanged (kept until the snowmobile is purged).
--
-- Everything is private to the database owner and the service role. Signed-in
-- users and visitors can neither read the cleanup tables nor call the
-- functions. Rollback: supabase/rollback/20261122090000_rollback.sql (it
-- cannot bring back anything this cleanup has already deleted).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Settings (one row). Deletion starts switched off.
-- -----------------------------------------------------------------------------
create table private.cleanup_settings (
  id boolean primary key default true check (id),
  deletion_enabled boolean not null default false,
  max_records_per_run integer not null default 200 check (max_records_per_run between 1 and 10000),
  max_files_per_run integer not null default 100 check (max_files_per_run between 1 and 10000),
  bucket_threshold_percent numeric(5, 2) not null default 10
    check (bucket_threshold_percent > 0 and bucket_threshold_percent <= 100),
  min_file_age interval not null default interval '24 hours' check (min_file_age >= interval '24 hours'),
  required_report_runs integer not null default 7 check (required_report_runs >= 7),
  installed_at timestamptz not null default now(),
  deletion_authorized_at timestamptz,
  deletion_backup_reference text check (char_length(deletion_backup_reference) <= 500),
  updated_at timestamptz not null default now()
);

comment on table private.cleanup_settings is
  'Migration 8: cleanup switches and limits (one row). deletion_enabled starts false; see private.tg_cleanup_settings_guard.';

insert into private.cleanup_settings default values;

-- -----------------------------------------------------------------------------
-- 2. Runs and what each run found or did.
-- -----------------------------------------------------------------------------
create table private.cleanup_runs (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('report', 'delete')),
  source text not null default 'scheduled' check (source in ('scheduled', 'manual')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'abandoned')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_step_at timestamptz,
  files_step_at timestamptz,
  records_deleted integer not null default 0 check (records_deleted >= 0),
  files_deleted integer not null default 0 check (files_deleted >= 0),
  summary jsonb not null default '{}'::jsonb,
  error text check (char_length(error) <= 2000)
);

create index cleanup_runs_started_at_idx on private.cleanup_runs (started_at desc);
-- Only one run at a time.
create unique index cleanup_runs_one_running_idx on private.cleanup_runs ((true)) where status = 'running';

comment on table private.cleanup_runs is
  'Migration 8: one row per cleanup run (report or delete): when, outcome, counts and a summary. No user content.';

create table private.cleanup_candidates (
  id bigint generated always as identity primary key,
  run_id bigint not null references private.cleanup_runs (id) on delete cascade,
  kind text not null check (kind in ('record', 'file')),
  -- Records: which row, when it was deleted (or resolved), when it became eligible.
  table_name text,
  record_id uuid,
  sled_id uuid,
  expired_at timestamptz,
  eligible_since timestamptz,
  backlog boolean,
  group_parent text,
  group_rows integer,
  group_detail jsonb,
  -- Files: which object and its storage timestamps.
  bucket_id text,
  object_path text,
  object_created_at timestamptz,
  object_updated_at timestamptz,
  outcome text not null check (outcome in (
    -- records
    'would_delete', 'would_defer', 'deleted', 'deferred', 'in_group', 'too_large', 'not_eligible', 'failed',
    -- files (also would_delete, would_defer, deleted, deferred, failed)
    'eligible', 'blocked_threshold', 'unrecognized', 'claimed', 'not_claimed'
  )),
  detail text check (char_length(detail) <= 1000),
  logged_at timestamptz not null default now(),
  constraint cleanup_candidates_shape check (
    (kind = 'record' and table_name is not null and record_id is not null and bucket_id is null and object_path is null)
    or (kind = 'file' and bucket_id is not null and object_path is not null and table_name is null and record_id is null)
  )
);

create index cleanup_candidates_run_idx on private.cleanup_candidates (run_id, kind, outcome);
create index cleanup_candidates_file_idx on private.cleanup_candidates (run_id, bucket_id, object_path) where kind = 'file';

comment on table private.cleanup_candidates is
  'Migration 8: what a run found (records and files) and what happened to each. Ids, timestamps and storage paths only.';

-- -----------------------------------------------------------------------------
-- 3. Registries: which tables are purged, which buckets are swept, and which
--    columns refer to files. Tests check these against the catalog so a new
--    table or photo column cannot be left out silently.
-- -----------------------------------------------------------------------------
create table private.cleanup_record_tables (
  table_name text primary key,
  sort_order integer not null unique,
  -- deleted_at: Recently Deleted for 30 days. garage: the same, once it has
  -- no snowmobiles. invitation: accepted, revoked or expired 30 days ago.
  -- share: revoked 30 days ago.
  expiry text not null check (expiry in ('deleted_at', 'garage', 'invitation', 'share')),
  result_key text not null unique
);

comment on table private.cleanup_record_tables is
  'Migration 8: tables the cleanup purges, child tables first (sort_order).';

insert into private.cleanup_record_tables (table_name, sort_order, expiry, result_key) values
  ('suspension_photos',          10, 'deleted_at', 'suspension_photos'),
  ('suspension_feedback',        11, 'deleted_at', 'suspension_feedback'),
  ('suspension_revisions',       12, 'deleted_at', 'suspension_revisions'),
  ('sled_issue_photos',          13, 'deleted_at', 'issue_photos'),
  ('maintenance_entry_parts',    14, 'deleted_at', 'entry_parts'),
  ('maintenance_entry_tasks',    15, 'deleted_at', 'entry_tasks'),
  ('maintenance_package_tasks',  16, 'deleted_at', 'package_tasks'),
  ('maintenance_plans',          20, 'deleted_at', 'plans'),
  ('suspension_settings',        21, 'deleted_at', 'suspension_settings'),
  ('suspension_setups',          22, 'deleted_at', 'suspension_setups'),
  ('sled_issues',                23, 'deleted_at', 'issues'),
  ('maintenance_entries',        24, 'deleted_at', 'entries'),
  ('sled_readings',              25, 'deleted_at', 'readings'),
  ('maintenance_packages',       26, 'deleted_at', 'packages'),
  ('maintenance_tasks',          27, 'deleted_at', 'tasks'),
  ('sled_invitations',           30, 'invitation', 'invitations'),
  ('sled_shares',                31, 'share',      'revoked_shares'),
  ('sleds',                      40, 'deleted_at', 'sleds'),
  ('garages',                    50, 'garage',     'garages');

create table private.storage_cleanup_buckets (
  bucket_id text primary key,
  -- Only object names matching this are ever considered for removal.
  path_pattern text not null
);

comment on table private.storage_cleanup_buckets is
  'Migration 8: SledWerx photo buckets the cleanup may sweep, and the only object names it recognises in each.';

insert into private.storage_cleanup_buckets (bucket_id, path_pattern) values
  ('sled-photos',
   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'),
  ('issue-photos',
   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'),
  ('suspension-photos',
   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$');

create table private.storage_reference_columns (
  bucket_id text not null references private.storage_cleanup_buckets (bucket_id) on delete cascade,
  table_name text not null,
  column_name text not null,
  primary key (bucket_id, table_name, column_name)
);

comment on table private.storage_reference_columns is
  'Migration 8: every column that stores a path in a swept bucket. A file is referenced if ANY row (active or deleted) holds its exact path.';

insert into private.storage_reference_columns (bucket_id, table_name, column_name) values
  ('sled-photos',       'sleds',             'photo_path'),
  ('issue-photos',      'sled_issue_photos', 'path'),
  ('suspension-photos', 'suspension_photos', 'path');

-- Exact-match lookups on sleds.photo_path (the photo tables already have a
-- unique index on path).
create index sleds_photo_path_idx on public.sleds (photo_path) where photo_path is not null;

-- -----------------------------------------------------------------------------
-- 4. File claims: a file the job is about to remove. While claimed, no record
--    can be given that path (see tg_storage_claim_guard).
-- -----------------------------------------------------------------------------
create table private.storage_cleanup_claims (
  bucket_id text not null,
  object_path text not null,
  -- claimed: being removed (attaching it is refused). deleted: removed.
  -- released: not removed, may be tried again. failed: 3 attempts, left alone.
  status text not null check (status in ('claimed', 'deleted', 'released', 'failed')),
  run_id bigint references private.cleanup_runs (id) on delete set null,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  attempts integer not null default 1 check (attempts >= 1),
  last_error text check (char_length(last_error) <= 1000),
  primary key (bucket_id, object_path)
);

comment on table private.storage_cleanup_claims is
  'Migration 8: files claimed for removal and what happened. A claimed path cannot be attached to a record.';

-- -----------------------------------------------------------------------------
-- 5. Access: owner and service role only. RLS on, no policies.
-- -----------------------------------------------------------------------------
alter table private.cleanup_settings enable row level security;
alter table private.cleanup_runs enable row level security;
alter table private.cleanup_candidates enable row level security;
alter table private.cleanup_record_tables enable row level security;
alter table private.storage_cleanup_buckets enable row level security;
alter table private.storage_reference_columns enable row level security;
alter table private.storage_cleanup_claims enable row level security;

revoke all on
  private.cleanup_settings, private.cleanup_runs, private.cleanup_candidates, private.cleanup_record_tables,
  private.storage_cleanup_buckets, private.storage_reference_columns, private.storage_cleanup_claims
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Settings guard: deletion needs 7 successful daily report runs and a
--    recorded backup; installed_at never changes; the row cannot be removed.
-- -----------------------------------------------------------------------------
create function private.tg_cleanup_settings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_days integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'The cleanup settings row cannot be removed.' using errcode = '42501';
  end if;

  new.id := true;
  new.installed_at := old.installed_at;
  new.updated_at := now();

  if new.deletion_enabled and not old.deletion_enabled then
    if nullif(btrim(coalesce(new.deletion_backup_reference, '')), '') is null then
      raise exception 'Record the verified database and Storage-photo backup before enabling deletion.'
        using errcode = '42501';
    end if;
    select count(distinct (r.started_at at time zone 'UTC')::date) into v_days
    from private.cleanup_runs r
    where r.mode = 'report' and r.source = 'scheduled' and r.status = 'completed'
      and r.records_step_at is not null and r.files_step_at is not null;
    if v_days < new.required_report_runs then
      raise exception 'Deletion needs % successful daily report-only runs first (% so far).', new.required_report_runs, v_days
        using errcode = '42501';
    end if;
    new.deletion_authorized_at := now();
  elsif not new.deletion_enabled then
    new.deletion_authorized_at := null;
  end if;
  return new;
end;
$$;

create trigger guard before update or delete on private.cleanup_settings
  for each row execute function private.tg_cleanup_settings_guard();

-- For the SQL editor (database owner only).
create function private.authorize_cleanup_deletion(p_backup_reference text)
returns void
language sql
volatile
set search_path = ''
as $$
  update private.cleanup_settings
  set deletion_enabled = true, deletion_backup_reference = p_backup_reference;
$$;

create function private.revoke_cleanup_deletion()
returns void
language sql
volatile
set search_path = ''
as $$
  update private.cleanup_settings set deletion_enabled = false;
$$;

-- -----------------------------------------------------------------------------
-- 7. Counting deleted rows, cascades included. A statement-level trigger on
--    every table a purge can reach adds the number of deleted rows to a
--    transaction-local counter, only while a cleanup group is being deleted.
-- -----------------------------------------------------------------------------
create function private.tg_cleanup_count_deletes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rows bigint;
  v_detail jsonb;
begin
  if current_setting('sledwerx.cleanup_counting', true) is distinct from 'on' then
    return null;
  end if;
  select count(*) into v_rows from old_rows;
  if v_rows = 0 then
    return null;
  end if;
  perform set_config('sledwerx.cleanup_deleted',
    (coalesce(nullif(current_setting('sledwerx.cleanup_deleted', true), ''), '0')::bigint + v_rows)::text, true);
  v_detail := coalesce(nullif(current_setting('sledwerx.cleanup_detail', true), '')::jsonb, '{}'::jsonb);
  v_detail := jsonb_set(v_detail, array[tg_table_name], to_jsonb(coalesce((v_detail ->> tg_table_name)::bigint, 0) + v_rows));
  perform set_config('sledwerx.cleanup_detail', v_detail::text, true);
  return null;
end;
$$;

-- Every purged table, and every table a cascade from them can reach.
do $$
declare
  v_rel oid;
begin
  for v_rel in
    with recursive reach(rel) as (
      select ('public.' || t.table_name)::regclass::oid from private.cleanup_record_tables t
      union
      select c.conrelid
      from pg_constraint c join reach r on c.confrelid = r.rel
      where c.contype = 'f' and c.confdeltype = 'c'
    )
    select distinct rel from reach
  loop
    execute format(
      'create trigger cleanup_count_deletes after delete on %s referencing old table as old_rows '
      'for each statement execute function private.tg_cleanup_count_deletes()', v_rel::regclass);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Record eligibility, candidates and group sizes (read-only).
-- -----------------------------------------------------------------------------

-- When a row's 30 days start: the delete, or the invitation/share resolution.
create function private.cleanup_expiry_expr(p_expiry text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_expiry
    when 'invitation' then 'coalesce(x.accepted_at, x.revoked_at, x.expires_at)'
    when 'share' then 'x.revoked_at'
    else 'x.deleted_at'
  end
$$;

-- The eligibility condition ($1 = cutoff). Garages: in a report, eligible once
-- every snowmobile in them is eligible too; when deleting, only once no
-- snowmobile is left.
create function private.cleanup_eligibility(p_expiry text, p_for_delete boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select private.cleanup_expiry_expr(p_expiry) || ' < $1'
    || case when p_expiry <> 'garage' then ''
            when p_for_delete then ' and not exists (select 1 from public.sleds s where s.garage_id = x.id)'
            else ' and not exists (select 1 from public.sleds s where s.garage_id = x.id'
                 || ' and (s.deleted_at is null or s.deleted_at >= $1))'
       end
$$;

-- Every row past its recovery period. group_parent: an eligible row that this
-- one is cascade-deleted with (null = it starts its own deletion group).
create function private.expired_record_candidates(p_cutoff timestamptz)
returns table (
  table_name text,
  record_id uuid,
  sled_id uuid,
  expired_at timestamptz,
  group_parent text,
  sort_order integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_parents text;
  v_sled text;
  v_parts text[] := '{}';
begin
  for v_t in select r.table_name, r.expiry from private.cleanup_record_tables r order by r.sort_order loop
    -- Parents: purged tables this one is cascade-deleted with.
    select coalesce('array[' || string_agg(format('%L || x.%I::text', pc.relname || ':', ca.attname), ', ') || ']::text[]',
                    'array[]::text[]')
      into v_parents
      from pg_constraint c
      join pg_class pc on pc.oid = c.confrelid and pc.relnamespace = 'public'::regnamespace
      join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join private.cleanup_record_tables pr on pr.table_name = pc.relname
      where c.contype = 'f' and c.confdeltype = 'c' and c.conrelid = ('public.' || v_t.table_name)::regclass;

    v_sled := case
      when v_t.table_name = 'sleds' then 'x.id'
      when exists (select 1 from pg_attribute a
                   where a.attrelid = ('public.' || v_t.table_name)::regclass and a.attname = 'sled_id' and not a.attisdropped)
        then 'x.sled_id'
      else 'null::uuid'
    end;

    v_parts := v_parts || format(
      'select %L::text as table_name, x.id as record_id, %s as sled_id, %s as expired_at, %s as parents from public.%I x where %s',
      v_t.table_name, v_sled, private.cleanup_expiry_expr(v_t.expiry), v_parents, v_t.table_name,
      private.cleanup_eligibility(v_t.expiry, false));
  end loop;

  return query execute
    'with c as (' || array_to_string(v_parts, ' union all ') || ') '
    || 'select c.table_name, c.record_id, c.sled_id, c.expired_at, '
    || '(select p.table_name || '':'' || p.record_id::text from c p '
    || '  where p.table_name || '':'' || p.record_id::text = any(c.parents) order by 1 limit 1), '
    || 'r.sort_order '
    || 'from c join private.cleanup_record_tables r on r.table_name = c.table_name'
    using p_cutoff;
end;
$$;

-- How many rows deleting one row removes, by table, following ON DELETE
-- CASCADE foreign keys (each row counted once). Read-only.
create function private.cleanup_cascade_rows(p_table text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_queue jsonb := jsonb_build_array(jsonb_build_object('rel', p_table, 'col', 'id', 'vals', jsonb_build_array(p_id::text)));
  v_seen jsonb := '{}'::jsonb;
  v_item jsonb;
  v_rel text;
  v_type text;
  v_found text[];
  v_new text[];
  v_vals text[];
  v_fk record;
  v_result jsonb;
begin
  while jsonb_array_length(v_queue) > 0 loop
    v_item := v_queue -> 0;
    v_queue := v_queue - 0;
    v_rel := v_item ->> 'rel';

    select format_type(a.atttypid, a.atttypmod) into strict v_type
    from pg_attribute a
    where a.attrelid = ('public.' || v_rel)::regclass and a.attname = v_item ->> 'col';

    execute format('select coalesce(array_agg(ctid::text), ''{}'') from public.%I where %I = any($1::%s[])',
                   v_rel, v_item ->> 'col', v_type)
      using array(select jsonb_array_elements_text(v_item -> 'vals'))
      into v_found;

    v_new := array(
      select f from unnest(v_found) f
      except
      select s from jsonb_array_elements_text(coalesce(v_seen -> v_rel, '[]'::jsonb)) s
    );
    continue when cardinality(v_new) = 0;
    v_seen := jsonb_set(v_seen, array[v_rel], coalesce(v_seen -> v_rel, '[]'::jsonb) || to_jsonb(v_new));

    for v_fk in
      select cc.relname as child, ca.attname as child_col, pa.attname as parent_col
      from pg_constraint c
      join pg_class cc on cc.oid = c.conrelid and cc.relnamespace = 'public'::regnamespace
      join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
      where c.contype = 'f' and c.confdeltype = 'c' and c.confrelid = ('public.' || v_rel)::regclass
    loop
      execute format('select coalesce(array_agg(distinct %I::text), ''{}'') from public.%I where ctid = any($1::tid[])',
                     v_fk.parent_col, v_rel)
        using v_new
        into v_vals;
      if cardinality(v_vals) > 0 then
        v_queue := v_queue || jsonb_build_array(
          jsonb_build_object('rel', v_fk.child, 'col', v_fk.child_col, 'vals', to_jsonb(v_vals)));
      end if;
    end loop;
  end loop;

  select coalesce(jsonb_object_agg(e.key, jsonb_array_length(e.value)), '{}'::jsonb) into v_result
  from jsonb_each(v_seen) e;
  return v_result;
end;
$$;

-- The report: every eligible row, when it became eligible, whether it was
-- already overdue when Migration 8 was installed (backlog), and for each group
-- the rows deleting it would remove. Read-only; ids and timestamps only.
create function private.expired_records_report(p_now timestamptz default now())
returns table (
  table_name text,
  record_id uuid,
  sled_id uuid,
  expired_at timestamptz,
  eligible_since timestamptz,
  backlog boolean,
  group_parent text,
  group_rows integer,
  group_detail jsonb,
  sort_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.table_name,
    c.record_id,
    c.sled_id,
    c.expired_at,
    c.expired_at + private.recovery_window(),
    c.expired_at + private.recovery_window() < s.installed_at,
    c.group_parent,
    (select coalesce(sum(v.value::integer), 0)::integer from jsonb_each_text(d.detail) v),
    d.detail,
    c.sort_order
  from private.expired_record_candidates(p_now - private.recovery_window()) c
  cross join private.cleanup_settings s
  left join lateral (
    select private.cleanup_cascade_rows(c.table_name, c.record_id) as detail where c.group_parent is null
  ) d on true
$$;

-- -----------------------------------------------------------------------------
-- 9. Deleting records.
-- -----------------------------------------------------------------------------

-- Deletes one group (its first row; cascades do the rest) only if it is still
-- eligible at this moment. Returns 1 if deleted, 0 if not (restored, gone, or
-- a garage that still has snowmobiles).
create function private.cleanup_delete_root(p_table text, p_id uuid, p_cutoff timestamptz)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expiry text;
  v_rows integer;
begin
  select t.expiry into v_expiry from private.cleanup_record_tables t where t.table_name = p_table;
  if not found then
    raise exception 'Not a cleanup table: %', p_table using errcode = '22023';
  end if;
  execute format('delete from public.%I x where x.id = $2 and %s', p_table, private.cleanup_eligibility(v_expiry, true))
    using p_cutoff, p_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- The record step of a run. Report runs list and size every group and delete
-- nothing. Delete runs (deletion authorized) delete group by group, child
-- tables first, each group in its own subtransaction, counting the rows each
-- deletion actually removed; a group that would go over the limit is undone
-- and the run stops there (the rest is deferred to the next run). Groups
-- larger than the whole limit are skipped and reported as too_large.
create function private.cleanup_process_records(p_run_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run private.cleanup_runs;
  v_settings private.cleanup_settings;
  v_apply boolean;
  v_now timestamptz := now();
  v_cutoff timestamptz := now() - private.recovery_window();
  v_budget integer;
  v_used integer := 0;
  v_stop boolean := false;
  v_c record;
  v_outcome text;
  v_detail text;
  v_rows integer;
  v_actual integer;
  v_actual_detail jsonb;
  v_outcomes jsonb := '{}'::jsonb;
  v_deleted jsonb := '{}'::jsonb;
  v_key text;
  v_total integer := 0;
  v_backlog integer := 0;
  v_summary jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('sledwerx.cleanup.records', 0)) then
    raise exception 'Another cleanup is processing records.' using errcode = '55P03';
  end if;

  select * into v_run from private.cleanup_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'Cleanup run not found.' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'This cleanup run has finished.' using errcode = '55000';
  end if;
  if v_run.records_step_at is not null then
    raise exception 'Records were already processed in this run.' using errcode = '55000';
  end if;

  select * into strict v_settings from private.cleanup_settings;
  v_apply := v_run.mode = 'delete';
  if v_apply and not v_settings.deletion_enabled then
    raise exception 'Cleanup deletion is not authorized.' using errcode = '42501';
  end if;
  v_budget := v_settings.max_records_per_run;

  for v_c in
    select * from private.expired_records_report(v_now) r order by r.sort_order, r.eligible_since, r.record_id
  loop
    v_total := v_total + 1;
    if v_c.backlog then
      v_backlog := v_backlog + 1;
    end if;
    v_detail := null;
    v_actual := null;
    v_actual_detail := null;

    if v_c.group_parent is not null then
      v_outcome := 'in_group';
      v_detail := 'Deleted together with ' || v_c.group_parent;
    elsif v_c.group_rows > v_budget then
      v_outcome := 'too_large';
      v_detail := format('Deleting it removes %s rows; the limit is %s per run.', v_c.group_rows, v_budget);
    elsif v_stop or v_used + v_c.group_rows > v_budget then
      v_stop := true;
      v_outcome := case when v_apply then 'deferred' else 'would_defer' end;
      v_detail := 'Over this run''s limit; next run.';
    elsif not v_apply then
      v_outcome := 'would_delete';
      v_used := v_used + v_c.group_rows;
    else
      begin
        perform set_config('sledwerx.cleanup_deleted', '0', true);
        perform set_config('sledwerx.cleanup_detail', '{}', true);
        perform set_config('sledwerx.cleanup_counting', 'on', true);
        v_rows := private.cleanup_delete_root(v_c.table_name, v_c.record_id, v_cutoff);
        perform set_config('sledwerx.cleanup_counting', 'off', true);
        v_actual := current_setting('sledwerx.cleanup_deleted')::integer;
        v_actual_detail := current_setting('sledwerx.cleanup_detail')::jsonb;
        if v_rows = 0 then
          v_outcome := 'not_eligible';
          v_detail := 'No longer eligible (restored, already removed, or still in use).';
          v_actual := 0;
        elsif v_used + v_actual > v_budget then
          -- Undo this group (the whole subtransaction) and stop here.
          raise exception 'over the cleanup limit' using errcode = 'SWC01';
        else
          v_used := v_used + v_actual;
          v_outcome := 'deleted';
          select r.result_key into v_key from private.cleanup_record_tables r where r.table_name = v_c.table_name;
          v_deleted := jsonb_set(v_deleted, array[v_key], to_jsonb(coalesce((v_deleted ->> v_key)::integer, 0) + 1));
        end if;
      exception
        when sqlstate 'SWC01' then
          v_stop := true;
          v_outcome := 'deferred';
          v_detail := format('Deleting it removes %s rows; %s were left in this run. Undone; next run.', v_actual, v_budget - v_used);
          v_actual_detail := null;
        when others then
          v_outcome := 'failed';
          v_detail := left(sqlerrm, 500);
          v_actual := null;
          v_actual_detail := null;
      end;
      perform set_config('sledwerx.cleanup_counting', 'off', true);
    end if;

    insert into private.cleanup_candidates (
      run_id, kind, table_name, record_id, sled_id, expired_at, eligible_since, backlog,
      group_parent, group_rows, group_detail, outcome, detail
    ) values (
      p_run_id, 'record', v_c.table_name, v_c.record_id, v_c.sled_id, v_c.expired_at, v_c.eligible_since, v_c.backlog,
      v_c.group_parent,
      case when v_outcome = 'deleted' then v_actual else v_c.group_rows end,
      case when v_outcome = 'deleted' then v_actual_detail else v_c.group_detail end,
      v_outcome, v_detail
    );
    v_outcomes := jsonb_set(v_outcomes, array[v_outcome], to_jsonb(coalesce((v_outcomes ->> v_outcome)::integer, 0) + 1));
  end loop;

  v_summary := jsonb_build_object(
    'mode', v_run.mode,
    'cutoff', v_cutoff,
    'candidates', v_total,
    'backlog', v_backlog,
    'newly_expired', v_total - v_backlog,
    'limit', v_budget,
    'rows', v_used,
    'outcomes', v_outcomes,
    'deleted_groups', v_deleted
  );

  update private.cleanup_runs
  set records_step_at = now(),
      records_deleted = case when v_apply then v_used else 0 end,
      summary = summary || jsonb_build_object('records', v_summary)
  where id = p_run_id;

  return v_summary;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Files: recognised paths, references, age, report, claims.
-- -----------------------------------------------------------------------------
create function private.storage_lock_key(p_bucket text, p_path text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select hashtextextended('sledwerx.storage:' || p_bucket || '/' || p_path, 0)
$$;

create function private.storage_path_recognized(p_bucket text, p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p_path ~ b.path_pattern from private.storage_cleanup_buckets b where b.bucket_id = p_bucket), false)
$$;

-- True if any row, active or in Recently Deleted, holds exactly this path.
-- A bucket without registered columns counts as referenced (never swept).
create function private.storage_path_referenced(p_bucket text, p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_col record;
  v_found boolean;
  v_any boolean := false;
begin
  for v_col in
    select r.table_name, r.column_name from private.storage_reference_columns r where r.bucket_id = p_bucket
  loop
    v_any := true;
    execute format('select exists (select 1 from public.%I where %I = $1)', v_col.table_name, v_col.column_name)
      using p_path into v_found;
    if v_found then
      return true;
    end if;
  end loop;
  return not v_any;
end;
$$;

-- unrecognized | referenced | too_new | orphan (only orphan may be removed).
create function private.storage_file_status(
  p_bucket text, p_path text, p_created_at timestamptz, p_updated_at timestamptz, p_now timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.storage_path_recognized(p_bucket, p_path) then 'unrecognized'
    when private.storage_path_referenced(p_bucket, p_path) then 'referenced'
    when p_created_at is null
      or greatest(p_created_at, coalesce(p_updated_at, p_created_at))
         > p_now - (select s.min_file_age from private.cleanup_settings s) then 'too_new'
    else 'orphan'
  end
$$;

-- Every object in the swept buckets with its status. Read-only.
create function private.storage_file_candidates(p_now timestamptz default now())
returns table (bucket_id text, object_path text, created_at timestamptz, updated_at timestamptz, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id, o.name, o.created_at, o.updated_at,
         private.storage_file_status(o.bucket_id, o.name, o.created_at, o.updated_at, p_now)
  from storage.objects o
  join private.storage_cleanup_buckets b on b.bucket_id = o.bucket_id
$$;

-- The file step of a run: counts per bucket, the 10% safety threshold, and a
-- candidate row for every orphan (oldest first) and unrecognised file. In a
-- delete run, orphans within the limits become 'eligible' (claimable).
create function private.cleanup_report_files(p_run_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run private.cleanup_runs;
  v_settings private.cleanup_settings;
  v_apply boolean;
  v_now timestamptz := now();
  v_bucket record;
  v_buckets jsonb := '{}'::jsonb;
  v_total integer;
  v_referenced integer;
  v_orphans integer;
  v_too_new integer;
  v_unrecognized integer;
  v_exceeded boolean;
  v_all_objects integer := 0;
  v_unreadable boolean := false;
  v_has_refs boolean;
  v_listed integer := 0;
  v_f record;
  v_summary jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('sledwerx.cleanup.files', 0)) then
    raise exception 'Another cleanup is processing files.' using errcode = '55P03';
  end if;

  select * into v_run from private.cleanup_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'Cleanup run not found.' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'This cleanup run has finished.' using errcode = '55000';
  end if;
  if v_run.files_step_at is not null then
    raise exception 'Files were already processed in this run.' using errcode = '55000';
  end if;
  select * into strict v_settings from private.cleanup_settings;
  v_apply := v_run.mode = 'delete';
  if v_apply and not v_settings.deletion_enabled then
    raise exception 'Cleanup deletion is not authorized.' using errcode = '42501';
  end if;

  create temporary table cleanup_files_tmp on commit drop as
    select * from private.storage_file_candidates(v_now);

  select count(*) into v_all_objects from cleanup_files_tmp;
  -- Storage looks empty while records point at files: something is wrong
  -- (permissions, wrong project). Remove nothing.
  if v_all_objects = 0 then
    select exists (select 1 from public.sleds where photo_path is not null)
        or exists (select 1 from public.sled_issue_photos)
        or exists (select 1 from public.suspension_photos)
      into v_has_refs;
    v_unreadable := v_has_refs;
  end if;

  for v_bucket in select b.bucket_id from private.storage_cleanup_buckets b order by b.bucket_id loop
    select count(*),
           count(*) filter (where f.status = 'referenced'),
           count(*) filter (where f.status = 'orphan'),
           count(*) filter (where f.status = 'too_new'),
           count(*) filter (where f.status = 'unrecognized')
      into v_total, v_referenced, v_orphans, v_too_new, v_unrecognized
      from cleanup_files_tmp f where f.bucket_id = v_bucket.bucket_id;

    v_exceeded := v_unreadable or v_orphans * 100 > v_total * v_settings.bucket_threshold_percent;

    v_buckets := v_buckets || jsonb_build_object(v_bucket.bucket_id, jsonb_build_object(
      'objects', v_total, 'referenced', v_referenced, 'orphans', v_orphans, 'too_new', v_too_new,
      'unrecognized', v_unrecognized, 'threshold_exceeded', v_exceeded));

    for v_f in
      select f.* from cleanup_files_tmp f
      where f.bucket_id = v_bucket.bucket_id and f.status in ('orphan', 'unrecognized')
      order by greatest(f.created_at, coalesce(f.updated_at, f.created_at)) nulls last, f.object_path
    loop
      insert into private.cleanup_candidates (
        run_id, kind, bucket_id, object_path, object_created_at, object_updated_at, outcome, detail
      ) values (
        p_run_id, 'file', v_f.bucket_id, v_f.object_path, v_f.created_at, v_f.updated_at,
        case
          when v_f.status = 'unrecognized' then 'unrecognized'
          when v_exceeded then 'blocked_threshold'
          when v_listed >= v_settings.max_files_per_run then case when v_apply then 'deferred' else 'would_defer' end
          when v_apply then 'eligible'
          else 'would_delete'
        end,
        case
          when v_f.status = 'unrecognized' then 'Not a SledWerx photo path; never removed automatically.'
          when v_unreadable then 'Storage looks empty while records point at files; nothing is removed.'
          when v_exceeded then format('More than %s%% of this bucket would be removed; nothing is removed.', v_settings.bucket_threshold_percent)
        end
      );
      if v_f.status = 'orphan' and not v_exceeded then
        v_listed := v_listed + 1;
      end if;
    end loop;
  end loop;

  v_summary := jsonb_build_object(
    'mode', v_run.mode,
    'min_age', v_settings.min_file_age,
    'limit', v_settings.max_files_per_run,
    'threshold_percent', v_settings.bucket_threshold_percent,
    'storage_unreadable', v_unreadable,
    'buckets', v_buckets
  );

  update private.cleanup_runs
  set files_step_at = now(), summary = summary || jsonb_build_object('files', v_summary)
  where id = p_run_id;

  drop table cleanup_files_tmp;
  return v_summary;
end;
$$;

-- Claims one file for removal, re-checking everything under the file's lock.
-- Only files this delete run listed as eligible can be claimed.
create function private.cleanup_claim_file(p_run_id bigint, p_bucket_id text, p_object_path text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run private.cleanup_runs;
  v_settings private.cleanup_settings;
  v_candidate bigint;
  v_claimed integer;
  v_obj record;
  v_exists boolean;
  v_status text;
  v_claim private.storage_cleanup_claims;
  v_reason text;
begin
  select * into v_run from private.cleanup_runs r where r.id = p_run_id;
  if not found or v_run.status <> 'running' or v_run.mode <> 'delete' then
    raise exception 'This cleanup run cannot remove files.' using errcode = '55000';
  end if;
  select * into strict v_settings from private.cleanup_settings;
  if not v_settings.deletion_enabled then
    raise exception 'Cleanup deletion is not authorized.' using errcode = '42501';
  end if;

  select c.id into v_candidate
  from private.cleanup_candidates c
  where c.run_id = p_run_id and c.kind = 'file' and c.bucket_id = p_bucket_id and c.object_path = p_object_path
    and c.outcome = 'eligible';
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_listed');
  end if;

  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket_id, p_object_path));

  select count(*) into v_claimed
  from private.cleanup_candidates c
  where c.run_id = p_run_id and c.kind = 'file' and c.outcome in ('claimed', 'deleted', 'failed');

  select o.created_at, o.updated_at into v_obj
  from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path;
  v_exists := found;

  if v_claimed >= v_settings.max_files_per_run then
    v_reason := 'run_limit';
  elsif not v_exists then
    v_reason := 'missing';
  else
    v_status := private.storage_file_status(p_bucket_id, p_object_path, v_obj.created_at, v_obj.updated_at, now());
    if v_status <> 'orphan' then
      v_reason := v_status;
    end if;
  end if;

  if v_reason is null then
    select * into v_claim from private.storage_cleanup_claims k
    where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
    if found and v_claim.status = 'failed' then
      v_reason := 'failed_before';
    end if;
  end if;

  if v_reason is not null then
    update private.cleanup_candidates set outcome = 'not_claimed', detail = v_reason where id = v_candidate;
    return jsonb_build_object('claimed', false, 'reason', v_reason);
  end if;

  insert into private.storage_cleanup_claims as k (bucket_id, object_path, status, run_id, claimed_at, attempts)
  values (p_bucket_id, p_object_path, 'claimed', p_run_id, now(), 1)
  on conflict (bucket_id, object_path) do update
    set status = 'claimed', run_id = excluded.run_id, claimed_at = now(), finished_at = null,
        last_error = null, attempts = k.attempts + 1;

  update private.cleanup_candidates set outcome = 'claimed', detail = null where id = v_candidate;
  return jsonb_build_object('claimed', true);
end;
$$;

-- After the Storage API call: records whether the file is really gone.
create function private.cleanup_record_file_result(
  p_run_id bigint, p_bucket_id text, p_object_path text, p_removed boolean, p_error text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim private.storage_cleanup_claims;
  v_still_there boolean;
  v_status text;
  v_error text;
begin
  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket_id, p_object_path));
  select * into v_claim from private.storage_cleanup_claims k
  where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
  if not found or v_claim.status <> 'claimed' or v_claim.run_id is distinct from p_run_id then
    raise exception 'This file was not claimed in this run.' using errcode = '55000';
  end if;

  select exists (select 1 from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path)
    into v_still_there;

  if p_removed and not v_still_there then
    v_status := 'deleted';
  elsif v_claim.attempts >= 3 then
    v_status := 'failed';
  else
    v_status := 'released';
  end if;
  v_error := case
    when v_status = 'deleted' then null
    when p_removed then 'Still in storage after removal.'
    else left(coalesce(p_error, 'Not removed.'), 500)
  end;

  update private.storage_cleanup_claims
  set status = v_status, finished_at = now(), last_error = v_error
  where bucket_id = p_bucket_id and object_path = p_object_path;

  update private.cleanup_candidates
  set outcome = case when v_status = 'deleted' then 'deleted' else 'failed' end, detail = v_error
  where run_id = p_run_id and kind = 'file' and bucket_id = p_bucket_id and object_path = p_object_path;

  if v_status = 'deleted' then
    update private.cleanup_runs set files_deleted = files_deleted + 1 where id = p_run_id;
  end if;
  return jsonb_build_object('status', v_status);
end;
$$;

-- A claimed path cannot be attached to a record (insert or path change). The
-- claim and this check take the same per-path lock, so one always sees the
-- other: either the record exists first (the claim is refused) or the claim
-- exists first (attaching is refused).
create function private.tg_storage_claim_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := to_jsonb(new) ->> tg_argv[1];
begin
  if v_path is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and v_path is not distinct from (to_jsonb(old) ->> tg_argv[1]) then
    return new;
  end if;
  perform pg_advisory_xact_lock(private.storage_lock_key(tg_argv[0], v_path));
  if exists (
    select 1 from private.storage_cleanup_claims k
    where k.bucket_id = tg_argv[0] and k.object_path = v_path and k.status = 'claimed'
  ) then
    raise exception 'This photo is being removed. Add it again.' using errcode = '55006';
  end if;
  return new;
end;
$$;

do $$
declare
  v_col record;
begin
  for v_col in select r.bucket_id, r.table_name, r.column_name from private.storage_reference_columns r loop
    execute format(
      'create trigger storage_claim_guard before insert or update of %I on public.%I '
      'for each row execute function private.tg_storage_claim_guard(%L, %L)',
      v_col.column_name, v_col.table_name, v_col.bucket_id, v_col.column_name);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Runs: start and finish.
-- -----------------------------------------------------------------------------
create function private.cleanup_begin_run(p_mode text, p_source text default 'scheduled')
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_mode is null or p_mode not in ('report', 'delete') then
    raise exception 'Mode must be report or delete.' using errcode = '22023';
  end if;

  -- A run that never finished (job crashed or timed out) is closed after 2 hours.
  update private.cleanup_runs
  set status = 'abandoned', finished_at = now(), error = 'Did not finish within 2 hours.'
  where status = 'running' and started_at < now() - interval '2 hours';

  if p_mode = 'delete' and not (select s.deletion_enabled from private.cleanup_settings s) then
    raise exception 'Cleanup deletion is not authorized.' using errcode = '42501';
  end if;

  begin
    insert into private.cleanup_runs (mode, source) values (p_mode, p_source) returning id into v_id;
  exception when unique_violation then
    raise exception 'Another cleanup run is in progress.' using errcode = '55P03';
  end;
  return v_id;
end;
$$;

create function private.cleanup_finish_run(p_run_id bigint, p_error text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run private.cleanup_runs;
begin
  -- Claims this run never reported on are released (attaching works again).
  update private.storage_cleanup_claims
  set status = 'released', finished_at = now(), last_error = 'The run finished without a result for this file.'
  where run_id = p_run_id and status = 'claimed';

  update private.cleanup_runs
  set status = case when p_error is null then 'completed' else 'failed' end,
      finished_at = now(),
      error = left(p_error, 2000)
  where id = p_run_id and status = 'running'
  returning * into v_run;
  if not found then
    raise exception 'Cleanup run not found or already finished.' using errcode = '55000';
  end if;
  return jsonb_build_object(
    'run_id', v_run.id, 'mode', v_run.mode, 'status', v_run.status,
    'records_deleted', v_run.records_deleted, 'files_deleted', v_run.files_deleted, 'summary', v_run.summary);
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. purge_expired_records(): the manual purge from Migrations 1-2, now the
--     same limited, logged, authorized engine (it used to delete without
--     limits and missed issues and suspension records). Returns the number of
--     deletion groups per table under the old keys, plus the run id.
-- -----------------------------------------------------------------------------
create or replace function private.purge_expired_records()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run bigint;
  v_result jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_key text;
begin
  v_run := private.cleanup_begin_run('delete', 'manual');
  v_result := private.cleanup_process_records(v_run);
  perform private.cleanup_finish_run(v_run, null);
  for v_key in select r.result_key from private.cleanup_record_tables r loop
    v_counts := v_counts || jsonb_build_object(v_key, coalesce((v_result -> 'deleted_groups' ->> v_key)::integer, 0));
  end loop;
  return v_counts || jsonb_build_object('run_id', v_run, 'rows', v_result -> 'rows', 'outcomes', v_result -> 'outcomes');
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. API for the server-side job: service role only.
-- -----------------------------------------------------------------------------
create function public.cleanup_begin_run(p_mode text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_begin_run(p_mode, 'scheduled') $$;

create function public.cleanup_process_records(p_run_id bigint)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_process_records(p_run_id) $$;

create function public.cleanup_report_files(p_run_id bigint)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_report_files(p_run_id) $$;

create function public.cleanup_claim_file(p_run_id bigint, p_bucket_id text, p_object_path text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_claim_file(p_run_id, p_bucket_id, p_object_path) $$;

create function public.cleanup_record_file_result(
  p_run_id bigint, p_bucket_id text, p_object_path text, p_removed boolean, p_error text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_record_file_result(p_run_id, p_bucket_id, p_object_path, p_removed, p_error) $$;

create function public.cleanup_finish_run(p_run_id bigint, p_error text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_finish_run(p_run_id, p_error) $$;

revoke all on function
  private.tg_cleanup_settings_guard(),
  private.authorize_cleanup_deletion(text),
  private.revoke_cleanup_deletion(),
  private.tg_cleanup_count_deletes(),
  private.cleanup_expiry_expr(text),
  private.cleanup_eligibility(text, boolean),
  private.expired_record_candidates(timestamptz),
  private.cleanup_cascade_rows(text, uuid),
  private.expired_records_report(timestamptz),
  private.cleanup_delete_root(text, uuid, timestamptz),
  private.cleanup_process_records(bigint),
  private.storage_lock_key(text, text),
  private.storage_path_recognized(text, text),
  private.storage_path_referenced(text, text),
  private.storage_file_status(text, text, timestamptz, timestamptz, timestamptz),
  private.storage_file_candidates(timestamptz),
  private.cleanup_report_files(bigint),
  private.cleanup_claim_file(bigint, text, text),
  private.cleanup_record_file_result(bigint, text, text, boolean, text),
  private.tg_storage_claim_guard(),
  private.cleanup_begin_run(text, text),
  private.cleanup_finish_run(bigint, text),
  private.purge_expired_records()
from public, anon, authenticated;

revoke all on function
  public.cleanup_begin_run(text),
  public.cleanup_process_records(bigint),
  public.cleanup_report_files(bigint),
  public.cleanup_claim_file(bigint, text, text),
  public.cleanup_record_file_result(bigint, text, text, boolean, text),
  public.cleanup_finish_run(bigint, text)
from public, anon, authenticated;

grant execute on function
  public.cleanup_begin_run(text),
  public.cleanup_process_records(bigint),
  public.cleanup_report_files(bigint),
  public.cleanup_claim_file(bigint, text, text),
  public.cleanup_record_file_result(bigint, text, text, boolean, text),
  public.cleanup_finish_run(bigint, text)
to service_role;
