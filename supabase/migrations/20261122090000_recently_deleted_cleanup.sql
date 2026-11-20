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
--   files. Two new RESTRICTIVE storage policies refuse uploads and overwrites
--   at paths claimed or removed by the cleanup (they only narrow access).
--   Audit history is unchanged (kept until the snowmobile is purged).
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
  -- Operational-history retention (the cleanup's own logs, not user data):
  -- its own switch, off by default; the approved periods can only be raised.
  retention_enabled boolean not null default false,
  retention_authorized_at timestamptz,
  retention_authorization_note text check (char_length(retention_authorization_note) <= 500),
  retention_run_days integer not null default 400 check (retention_run_days >= 400),
  retention_report_candidate_days integer not null default 30 check (retention_report_candidate_days >= 30),
  retention_delete_candidate_days integer not null default 180 check (retention_delete_candidate_days >= 180),
  retention_released_claim_days integer not null default 180 check (retention_released_claim_days >= 180),
  retention_keep_report_runs integer not null default 7 check (retention_keep_report_runs >= 7),
  retention_batch_size integer not null default 1000 check (retention_batch_size between 1 and 5000),
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
  retention_step_at timestamptz,
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
    'eligible', 'blocked', 'unrecognized', 'metadata_missing', 'claimed', 'not_claimed', 'replaced', 'missing'
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
  -- claimed: being removed (attaching it is refused). deleted: removed (the
  -- path stays blocked). replaced: Storage removed a different file at this
  -- path than the one claimed (review; the path stays blocked). missing: it
  -- was gone (path blocked too). released: not removed, may be tried again.
  -- failed: 3 attempts, left alone for review.
  -- closed: a failed removal an administrator reviewed and decided to keep
  -- (never removed automatically; the path is not blocked).
  status text not null check (status in ('claimed', 'deleted', 'replaced', 'missing', 'released', 'failed', 'closed')),
  run_id bigint references private.cleanup_runs (id) on delete set null,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  attempts integer not null default 1 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 1000),
  -- Exactly which object was claimed (Storage row id, eTag and size).
  object_id uuid,
  object_etag text,
  object_size bigint,
  -- Failed-claim review and resolution (database owner; see docs/cleanup.md).
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  resolved_at timestamptz,
  resolution text check (resolution in ('removed', 'retry', 'keep')),
  resolution_note text check (char_length(resolution_note) <= 1000),
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

  -- Operational-history retention has its own switch and its own approval note.
  if new.retention_enabled and not old.retention_enabled then
    if nullif(btrim(coalesce(new.retention_authorization_note, '')), '') is null then
      raise exception 'Record who approved operational-history retention before enabling it.' using errcode = '42501';
    end if;
    new.retention_authorized_at := now();
  elsif not new.retention_enabled then
    new.retention_authorized_at := null;
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

-- Operational-history retention (the cleanup's own logs): a separate switch.
create function private.authorize_retention_maintenance(p_approval_note text)
returns void
language sql
volatile
set search_path = ''
as $$
  update private.cleanup_settings
  set retention_enabled = true, retention_authorization_note = p_approval_note;
$$;

create function private.revoke_retention_maintenance()
returns void
language sql
volatile
set search_path = ''
as $$
  update private.cleanup_settings set retention_enabled = false;
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
  v_too_large jsonb := '[]'::jsonb;
  v_problems text[];
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
  -- Anything missing from the registries stops deletion (a report still runs
  -- and records the problem).
  v_problems := private.cleanup_registry_problems();
  if v_apply and cardinality(v_problems) > 0 then
    raise exception 'The cleanup registry is incomplete: %', array_to_string(v_problems, '; ') using errcode = 'SWC02';
  end if;

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
      -- Decision 11: never partly deleted, never an automatic higher limit.
      v_outcome := 'too_large';
      v_detail := format('Needs administrator review: deleting it removes %s rows; the limit is %s per run. '
                         'Skipped whole; a higher limit needs separate approval.', v_c.group_rows, v_budget);
      v_too_large := v_too_large || jsonb_build_array(jsonb_build_object(
        'table', v_c.table_name, 'id', v_c.record_id, 'sled_id', v_c.sled_id, 'rows', v_c.group_rows));
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
    'deleted_groups', v_deleted,
    'too_large', v_too_large,
    'registry_problems', to_jsonb(v_problems),
    'large_backlog', v_total > 1000,
    'needs_review', jsonb_array_length(v_too_large) > 0 or cardinality(v_problems) > 0
                    or coalesce((v_outcomes ->> 'failed')::integer, 0) > 0
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
-- 10. Files: recognised paths, references, metadata, age, report, claims.
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
-- A failing lookup raises an error; it is never read as "not referenced".
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
      using p_path into strict v_found;
    if v_found then
      return true;
    end if;
  end loop;
  return not v_any;
end;
$$;

-- How many rows (any state) hold a path in this bucket. Used as a sanity
-- check of the reference lookup.
create function private.storage_reference_count(p_bucket text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_col record;
  v_n bigint;
  v_total bigint := 0;
begin
  for v_col in
    select r.table_name, r.column_name from private.storage_reference_columns r where r.bucket_id = p_bucket
  loop
    execute format('select count(%I) from public.%I', v_col.column_name, v_col.table_name) into strict v_n;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;

-- Anything missing from the registries (empty array = complete). Checked at
-- the start of every step: a gap blocks all deletion.
create function private.cleanup_registry_problems()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p order by p), '{}') from (
    -- Every table with Recently Deleted is purged.
    select 'Recently Deleted table not registered: ' || c.relname as p
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname not in (select t.table_name from private.cleanup_record_tables t)
    union all
    select 'Registered table missing: ' || t.table_name
    from private.cleanup_record_tables t where to_regclass('public.' || t.table_name) is null
    union all
    -- Every table a purge can reach counts its deleted rows.
    select 'Delete counter missing on: ' || x.rel::regclass::text
    from (
      with recursive reach(rel) as (
        select to_regclass('public.' || t.table_name)::oid from private.cleanup_record_tables t
        where to_regclass('public.' || t.table_name) is not null
        union
        select k.conrelid from pg_constraint k join reach r on k.confrelid = r.rel where k.contype = 'f' and k.confdeltype = 'c'
      ) select rel from reach
    ) x
    where not exists (select 1 from pg_trigger g where g.tgrelid = x.rel and g.tgname = 'cleanup_count_deletes')
    union all
    -- Every photo-path column is registered.
    select 'Photo column not registered: ' || c.relname || '.' || a.attname
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.atttypid = 'text'::regtype
      and (a.attname = 'path' or a.attname like '%\_path'
           or exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'c' and a.attnum = any(k.conkey)
                      and pg_get_constraintdef(k.oid) like '%(jpg|webp)%'))
      and not exists (select 1 from private.storage_reference_columns r where r.table_name = c.relname and r.column_name = a.attname)
    union all
    select 'Registered photo column missing or unguarded: ' || r.table_name || '.' || r.column_name
    from private.storage_reference_columns r
    where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || r.table_name) and a.attname = r.column_name
                      and not a.attisdropped)
       or not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || r.table_name) and g.tgname = 'storage_claim_guard')
    union all
    -- Every SledWerx photo bucket is registered, and every registered one exists.
    select 'Photo bucket not registered: ' || b.id from storage.buckets b
    where b.id like '%-photos' and b.id not in (select x.bucket_id from private.storage_cleanup_buckets x)
    union all
    select 'Registered bucket missing: ' || x.bucket_id from private.storage_cleanup_buckets x
    where not exists (select 1 from storage.buckets b where b.id = x.bucket_id)
    union all
    select 'Registered bucket without reference column: ' || x.bucket_id from private.storage_cleanup_buckets x
    where not exists (select 1 from private.storage_reference_columns r where r.bucket_id = x.bucket_id)
  ) problems
$$;

-- unrecognized | referenced | metadata_missing | too_new | orphan
-- (only orphan may ever be removed).
create function private.storage_file_status(
  p_bucket text, p_path text, p_created_at timestamptz, p_updated_at timestamptz, p_metadata jsonb, p_now timestamptz
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
    when p_created_at is null or p_updated_at is null
      or p_metadata ->> 'eTag' is null or p_metadata ->> 'size' is null then 'metadata_missing'
    when greatest(p_created_at, p_updated_at) > p_now - (select s.min_file_age from private.cleanup_settings s) then 'too_new'
    else 'orphan'
  end
$$;

-- Every object in the swept buckets with its status. Read-only.
create function private.storage_file_candidates(p_now timestamptz default now())
returns table (
  bucket_id text, object_path text, object_id uuid, created_at timestamptz, updated_at timestamptz, metadata jsonb, status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id, o.name, o.id, o.created_at, o.updated_at, o.metadata,
         private.storage_file_status(o.bucket_id, o.name, o.created_at, o.updated_at, o.metadata, p_now)
  from storage.objects o
  join private.storage_cleanup_buckets b on b.bucket_id = o.bucket_id
$$;

-- The file step of a run. For each bucket: counts, safety checks, and a
-- candidate row for every orphan (oldest first), unrecognised file and file
-- with incomplete metadata. A bucket is blocked (nothing in it removable) if
-- the registry is incomplete, Storage looks unreadable, any file's metadata
-- is incomplete, no file matches the records that point at the bucket, or -
-- for buckets of 100 files or more - more than 10% would be removed. In a
-- delete run, orphans within the limit become 'eligible' (claimable).
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
  v_problems text[];
  v_bucket record;
  v_buckets jsonb := '{}'::jsonb;
  v_total integer;
  v_referenced integer;
  v_orphans integer;
  v_too_new integer;
  v_unrecognized integer;
  v_metadata_missing integer;
  v_refs bigint;
  v_blocked text;
  v_all_objects integer := 0;
  v_unreadable boolean := false;
  v_review boolean := false;
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

  v_problems := private.cleanup_registry_problems();

  create temporary table cleanup_files_tmp on commit drop as
    select * from private.storage_file_candidates(v_now);

  select count(*) into v_all_objects from cleanup_files_tmp;
  -- Storage looks empty while records point at files: something is wrong
  -- (permissions, wrong project). Remove nothing.
  if v_all_objects = 0 then
    select coalesce(sum(private.storage_reference_count(b.bucket_id)), 0) > 0 into v_unreadable
    from private.storage_cleanup_buckets b;
  end if;

  for v_bucket in select b.bucket_id from private.storage_cleanup_buckets b order by b.bucket_id loop
    select count(*),
           count(*) filter (where f.status = 'referenced'),
           count(*) filter (where f.status = 'orphan'),
           count(*) filter (where f.status = 'too_new'),
           count(*) filter (where f.status = 'unrecognized'),
           count(*) filter (where f.status = 'metadata_missing')
      into v_total, v_referenced, v_orphans, v_too_new, v_unrecognized, v_metadata_missing
      from cleanup_files_tmp f where f.bucket_id = v_bucket.bucket_id;
    v_refs := private.storage_reference_count(v_bucket.bucket_id);

    v_blocked := case
      when cardinality(v_problems) > 0 then 'The cleanup registry is incomplete.'
      when v_unreadable then 'Storage looks empty while records point at files.'
      when v_metadata_missing > 0 then format('%s file(s) have incomplete Storage metadata.', v_metadata_missing)
      when v_total > 0 and v_referenced = 0 and v_refs > 0 then
        format('No file matches any of the %s record(s) that point at this bucket; the reference lookup is not trusted.', v_refs)
      when v_total >= 100 and v_orphans * 100 > v_total * v_settings.bucket_threshold_percent then
        format('More than %s%% of this bucket''s %s files would be removed.', v_settings.bucket_threshold_percent, v_total)
    end;
    if v_blocked is not null or v_unrecognized > 0 or v_metadata_missing > 0 then
      v_review := true;
    end if;

    v_buckets := v_buckets || jsonb_build_object(v_bucket.bucket_id, jsonb_build_object(
      'objects', v_total, 'referenced', v_referenced, 'orphans', v_orphans, 'too_new', v_too_new,
      'unrecognized', v_unrecognized, 'metadata_missing', v_metadata_missing, 'reference_rows', v_refs,
      'threshold_applies', v_total >= 100, 'blocked', v_blocked is not null, 'blocked_reason', v_blocked));

    for v_f in
      select f.* from cleanup_files_tmp f
      where f.bucket_id = v_bucket.bucket_id and f.status in ('orphan', 'unrecognized', 'metadata_missing')
      order by greatest(f.created_at, f.updated_at) nulls last, f.object_path
    loop
      insert into private.cleanup_candidates (
        run_id, kind, bucket_id, object_path, object_created_at, object_updated_at, outcome, detail
      ) values (
        p_run_id, 'file', v_f.bucket_id, v_f.object_path, v_f.created_at, v_f.updated_at,
        case
          when v_f.status = 'unrecognized' then 'unrecognized'
          when v_f.status = 'metadata_missing' then 'metadata_missing'
          when v_blocked is not null then 'blocked'
          when v_listed >= v_settings.max_files_per_run then case when v_apply then 'deferred' else 'would_defer' end
          when v_apply then 'eligible'
          else 'would_delete'
        end,
        case
          when v_f.status = 'unrecognized' then 'Not a SledWerx photo path; never removed automatically.'
          when v_f.status = 'metadata_missing' then 'Storage metadata is incomplete; never removed automatically.'
          when v_blocked is not null then v_blocked
        end
      );
      if v_f.status = 'orphan' and v_blocked is null then
        v_listed := v_listed + 1;
      end if;
    end loop;
  end loop;

  v_summary := jsonb_build_object(
    'mode', v_run.mode,
    'min_age', v_settings.min_file_age,
    'limit', v_settings.max_files_per_run,
    'threshold_percent', v_settings.bucket_threshold_percent,
    'threshold_min_files', 100,
    'registry_problems', to_jsonb(v_problems),
    'storage_unreadable', v_unreadable,
    'needs_review', v_review or cardinality(v_problems) > 0,
    'buckets', v_buckets
  );

  update private.cleanup_runs
  set files_step_at = now(), summary = summary || jsonb_build_object('files', v_summary)
  where id = p_run_id;

  drop table cleanup_files_tmp;
  return v_summary;
end;
$$;

-- The files a delete run may try to remove, oldest first, within the limit.
create function private.cleanup_eligible_files(p_run_id bigint)
returns table (bucket_id text, object_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.bucket_id, c.object_path
  from private.cleanup_candidates c
  join private.cleanup_runs r on r.id = c.run_id and r.status = 'running' and r.mode = 'delete'
  where c.run_id = p_run_id and c.kind = 'file' and c.outcome = 'eligible'
  order by c.id
  limit (select s.max_files_per_run from private.cleanup_settings s)
$$;

-- Claims one file for removal, re-checking everything under the file's lock,
-- and records exactly which object was claimed (id, eTag, size). Only files
-- this delete run listed as eligible can be claimed.
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
  if cardinality(private.cleanup_registry_problems()) > 0 then
    raise exception 'The cleanup registry is incomplete.' using errcode = 'SWC02';
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
  where c.run_id = p_run_id and c.kind = 'file'
    and c.outcome in ('claimed', 'deleted', 'replaced', 'missing', 'failed');

  select o.id, o.created_at, o.updated_at, o.metadata into v_obj
  from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path;
  v_exists := found;

  if v_claimed >= v_settings.max_files_per_run then
    v_reason := 'run_limit';
  elsif not v_exists then
    v_reason := 'missing';
  else
    v_status := private.storage_file_status(p_bucket_id, p_object_path, v_obj.created_at, v_obj.updated_at, v_obj.metadata, now());
    if v_status <> 'orphan' then
      v_reason := v_status;
    end if;
  end if;

  if v_reason is null then
    select * into v_claim from private.storage_cleanup_claims k
    where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
    if found and v_claim.status in ('failed', 'deleted', 'replaced', 'missing', 'closed') then
      v_reason := 'claimed_before';
    end if;
  end if;

  if v_reason is not null then
    update private.cleanup_candidates set outcome = 'not_claimed', detail = v_reason where id = v_candidate;
    return jsonb_build_object('claimed', false, 'reason', v_reason);
  end if;

  insert into private.storage_cleanup_claims as k (
    bucket_id, object_path, status, run_id, claimed_at, attempts, object_id, object_etag, object_size
  ) values (
    p_bucket_id, p_object_path, 'claimed', p_run_id, now(), 1,
    v_obj.id, v_obj.metadata ->> 'eTag', (v_obj.metadata ->> 'size')::bigint
  )
  on conflict (bucket_id, object_path) do update
    set status = 'claimed', run_id = excluded.run_id, claimed_at = now(), finished_at = null, last_error = null,
        attempts = k.attempts + 1, object_id = excluded.object_id, object_etag = excluded.object_etag,
        object_size = excluded.object_size;

  update private.cleanup_candidates set outcome = 'claimed', detail = null where id = v_candidate;
  return jsonb_build_object('claimed', true, 'object_id', v_obj.id);
end;
$$;

-- Immediately before the Storage call: the object at the path must still be
-- exactly the one claimed (same id, eTag and size) and still an orphan. If
-- anything changed, the claim is released and the file is not removed.
create function private.cleanup_verify_claim(p_run_id bigint, p_bucket_id text, p_object_path text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim private.storage_cleanup_claims;
  v_obj record;
  v_reason text;
begin
  if not (select s.deletion_enabled from private.cleanup_settings s) then
    raise exception 'Cleanup deletion is not authorized.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket_id, p_object_path));
  select * into v_claim from private.storage_cleanup_claims k
  where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
  if not found or v_claim.status <> 'claimed' or v_claim.run_id is distinct from p_run_id then
    raise exception 'This file was not claimed in this run.' using errcode = '55000';
  end if;

  -- Lock the object's row: an upload or overwrite still in progress (it
  -- holds the row) finishes first, and is then seen as a change. Waits at
  -- most 5 seconds, then fails (nothing removed).
  perform set_config('lock_timeout', '5s', true);
  select o.id, o.created_at, o.updated_at, o.metadata into v_obj
  from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path
  for update;
  perform set_config('lock_timeout', '0', true);
  if not found then
    v_reason := 'missing';
  elsif v_obj.id is distinct from v_claim.object_id
     or v_obj.metadata ->> 'eTag' is distinct from v_claim.object_etag
     or (v_obj.metadata ->> 'size')::bigint is distinct from v_claim.object_size then
    v_reason := 'changed';
  else
    v_reason := nullif(private.storage_file_status(p_bucket_id, p_object_path, v_obj.created_at, v_obj.updated_at, v_obj.metadata, now()), 'orphan');
  end if;

  if v_reason is not null then
    update private.storage_cleanup_claims
    set status = 'released', finished_at = now(), last_error = 'Not removed: ' || v_reason
    where bucket_id = p_bucket_id and object_path = p_object_path;
    update private.cleanup_candidates set outcome = 'not_claimed', detail = v_reason
    where run_id = p_run_id and kind = 'file' and bucket_id = p_bucket_id and object_path = p_object_path;
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- After the Storage API call. p_deleted_object is the object Storage reports
-- it removed. If it is not the claimed object (a replacement uploaded in the
-- moment between the check and the removal), the result is 'replaced' and
-- flagged for review; the path stays blocked, so no record can point at it.
create function private.cleanup_record_file_result(
  p_run_id bigint, p_bucket_id text, p_object_path text, p_removed boolean,
  p_error text default null, p_deleted_object jsonb default null
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
  v_outcome text;
  v_error text;
  v_has_object boolean := jsonb_typeof(p_deleted_object) = 'object' and p_deleted_object ? 'id';
begin
  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket_id, p_object_path));
  select * into v_claim from private.storage_cleanup_claims k
  where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
  if not found or v_claim.status <> 'claimed' or v_claim.run_id is distinct from p_run_id then
    raise exception 'This file was not claimed in this run.' using errcode = '55000';
  end if;

  select exists (select 1 from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path)
    into v_still_there;

  if p_removed and v_has_object then
    if (p_deleted_object ->> 'id')::uuid = v_claim.object_id
       and p_deleted_object -> 'metadata' ->> 'eTag' is not distinct from v_claim.object_etag
       and (p_deleted_object -> 'metadata' ->> 'size')::bigint is not distinct from v_claim.object_size then
      v_status := 'deleted';
      v_outcome := 'deleted';
    else
      v_status := 'replaced';
      v_outcome := 'replaced';
      v_error := 'Storage removed a different file than the one claimed (replaced at the same path). Review needed.';
    end if;
  elsif p_removed and not v_still_there then
    v_status := 'missing';
    v_outcome := 'missing';
    v_error := 'Storage removed nothing; the file was already gone.';
  else
    v_status := case when v_claim.attempts >= 3 then 'failed' else 'released' end;
    v_outcome := 'failed';
    v_error := case when p_removed then 'Storage reported success but the file is still there.'
                    else left(coalesce(p_error, 'Not removed.'), 500) end;
  end if;

  update private.storage_cleanup_claims
  set status = v_status, finished_at = now(), last_error = v_error
  where bucket_id = p_bucket_id and object_path = p_object_path;

  update private.cleanup_candidates
  set outcome = v_outcome, detail = v_error
  where run_id = p_run_id and kind = 'file' and bucket_id = p_bucket_id and object_path = p_object_path;

  if v_status in ('deleted', 'replaced') then
    update private.cleanup_runs set files_deleted = files_deleted + 1 where id = p_run_id;
  end if;
  return jsonb_build_object('status', v_status);
end;
$$;

-- A claimed path cannot be attached to a record (insert or path change), and
-- neither can a path the cleanup has removed. The claim and this check take
-- the same per-path lock, so one always sees the other: either the record
-- exists first (the claim is refused) or the claim exists first (attaching is
-- refused).
create function private.tg_storage_claim_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := to_jsonb(new) ->> tg_argv[1];
  v_status text;
begin
  if v_path is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and v_path is not distinct from (to_jsonb(old) ->> tg_argv[1]) then
    return new;
  end if;
  perform pg_advisory_xact_lock(private.storage_lock_key(tg_argv[0], v_path));
  select k.status into v_status from private.storage_cleanup_claims k
  where k.bucket_id = tg_argv[0] and k.object_path = v_path;
  if v_status = 'claimed' then
    raise exception 'This photo is being removed. Add it again.' using errcode = '55006';
  elsif v_status in ('deleted', 'replaced', 'missing') then
    raise exception 'This photo was removed. Add it again.' using errcode = '55006';
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
-- 10b. Storage: no upload, overwrite or move into a path that is claimed for
--      removal or was removed by the cleanup. Supabase Storage removes by path
--      and has no conditional delete, so the write itself is refused instead:
--      two RESTRICTIVE policies, which can only narrow what the existing
--      policies allow (they change none of them; reading and deleting are not
--      affected). The check takes the same per-path lock as a claim, and reads
--      the claims at that moment (volatile), so a write and a claim of the
--      same path are always serialised.
-- -----------------------------------------------------------------------------
create function private.storage_path_writable(p_bucket text, p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_bucket is null or p_name is null
     or not exists (select 1 from private.storage_cleanup_buckets b where b.bucket_id = p_bucket) then
    return true;
  end if;
  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket, p_name));
  return not exists (
    select 1 from private.storage_cleanup_claims k
    where k.bucket_id = p_bucket and k.object_path = p_name and k.status in ('claimed', 'deleted', 'replaced', 'missing')
  );
end;
$$;

revoke all on function private.storage_path_writable(text, text) from public, anon, authenticated;
grant execute on function private.storage_path_writable(text, text) to authenticated;

create policy "SledWerx cleanup: no uploads to claimed or removed paths"
  on storage.objects as restrictive for insert to authenticated
  with check (private.storage_path_writable(bucket_id, name));

create policy "SledWerx cleanup: no overwrites of claimed or removed paths"
  on storage.objects as restrictive for update to authenticated
  using (private.storage_path_writable(bucket_id, name))
  with check (private.storage_path_writable(bucket_id, name));

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

  -- A run that never finished (job crashed or timed out) is closed after 30
  -- minutes (the job itself stops after 60 seconds).
  update private.cleanup_runs
  set status = 'abandoned', finished_at = now(), error = 'Did not finish within 30 minutes.'
  where status = 'running' and started_at < now() - interval '30 minutes';

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
  -- Claims this run never reported on (the job stopped mid-file): a file
  -- still in Storage is released; a file that is gone may have been removed
  -- by this run, so its path stays blocked ('missing').
  update private.storage_cleanup_claims k
  set status = case when exists (select 1 from storage.objects o where o.bucket_id = k.bucket_id and o.name = k.object_path)
                    then 'released' else 'missing' end,
      finished_at = now(),
      last_error = 'The run finished without a result for this file.'
  where k.run_id = p_run_id and k.status = 'claimed';

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

create function public.cleanup_eligible_files(p_run_id bigint)
returns table (bucket_id text, object_path text)
language sql
stable
security definer
set search_path = ''
as $$ select * from private.cleanup_eligible_files(p_run_id) $$;

create function public.cleanup_claim_file(p_run_id bigint, p_bucket_id text, p_object_path text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_claim_file(p_run_id, p_bucket_id, p_object_path) $$;

create function public.cleanup_verify_claim(p_run_id bigint, p_bucket_id text, p_object_path text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_verify_claim(p_run_id, p_bucket_id, p_object_path) $$;

create function public.cleanup_record_file_result(
  p_run_id bigint, p_bucket_id text, p_object_path text, p_removed boolean,
  p_error text default null, p_deleted_object jsonb default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_record_file_result(p_run_id, p_bucket_id, p_object_path, p_removed, p_error, p_deleted_object) $$;

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
  private.storage_reference_count(text),
  private.cleanup_registry_problems(),
  private.storage_file_status(text, text, timestamptz, timestamptz, jsonb, timestamptz),
  private.storage_file_candidates(timestamptz),
  private.cleanup_report_files(bigint),
  private.cleanup_eligible_files(bigint),
  private.cleanup_claim_file(bigint, text, text),
  private.cleanup_verify_claim(bigint, text, text),
  private.cleanup_record_file_result(bigint, text, text, boolean, text, jsonb),
  private.tg_storage_claim_guard(),
  private.cleanup_begin_run(text, text),
  private.cleanup_finish_run(bigint, text),
  private.purge_expired_records()
from public, anon, authenticated;

revoke all on function
  public.cleanup_begin_run(text),
  public.cleanup_process_records(bigint),
  public.cleanup_report_files(bigint),
  public.cleanup_eligible_files(bigint),
  public.cleanup_claim_file(bigint, text, text),
  public.cleanup_verify_claim(bigint, text, text),
  public.cleanup_record_file_result(bigint, text, text, boolean, text, jsonb),
  public.cleanup_finish_run(bigint, text)
from public, anon, authenticated;

grant execute on function
  public.cleanup_begin_run(text),
  public.cleanup_process_records(bigint),
  public.cleanup_report_files(bigint),
  public.cleanup_eligible_files(bigint),
  public.cleanup_claim_file(bigint, text, text),
  public.cleanup_verify_claim(bigint, text, text),
  public.cleanup_record_file_result(bigint, text, text, boolean, text, jsonb),
  public.cleanup_finish_run(bigint, text)
to service_role;

-- -----------------------------------------------------------------------------
-- 14. What needs an administrator's attention: from the latest finished run,
--     groups too large to delete, failures, unrecognised files, files with
--     incomplete metadata and blocked files; and every file claim that failed
--     or removed a replaced file. Read-only; for the SQL editor and the future
--     administrator dashboard. ("Latest" = the latest run that produced a
--     report.)
-- -----------------------------------------------------------------------------
create view private.cleanup_review with (security_invoker = true) as
  select 'run'::text as source, c.run_id, c.kind, c.outcome, c.table_name, c.record_id, c.sled_id,
         c.group_rows, c.bucket_id, c.object_path, c.detail, c.logged_at as at
  from private.cleanup_candidates c
  where c.run_id = (select max(r.id) from private.cleanup_runs r
                    where r.status in ('completed', 'failed') and r.records_step_at is not null)
    and c.outcome in ('too_large', 'failed', 'replaced', 'unrecognized', 'metadata_missing', 'blocked')
  union all
  select 'claim', k.run_id, 'file', k.status, null, null, null, null, k.bucket_id, k.object_path, k.last_error, k.finished_at
  from private.storage_cleanup_claims k
  where k.status in ('failed', 'replaced');

revoke all on private.cleanup_review from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 15. SledWerx application administrators and the read-only cleanup
--     dashboard. Administrators are listed in a private table that no user
--     (not even an administrator) can read or change through the API; they
--     are added and removed only by the database owner (SQL editor). The
--     dashboard function checks the caller's verified user id against that
--     table and refuses everyone else. It returns ids, counts, timestamps and
--     storage paths only - never names, emails, titles, notes or the backup
--     reference text - and changes nothing (STABLE).
-- -----------------------------------------------------------------------------
create table private.app_administrators (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now(),
  note text check (char_length(note) <= 200)
);

comment on table private.app_administrators is
  'Migration 8: SledWerx application administrators (system-wide cleanup monitoring). Managed only by the database owner.';

alter table private.app_administrators enable row level security;
revoke all on private.app_administrators from public, anon, authenticated;

create function private.is_app_administrator(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (select 1 from private.app_administrators a where a.user_id = p_user_id)
$$;

-- For the SQL editor (database owner only). Takes the user's id (from
-- Authentication > Users), never an email address alone.
create function private.grant_app_administrator(p_user_id uuid, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null) then
    raise exception 'No confirmed user with this id.' using errcode = 'P0002';
  end if;
  insert into private.app_administrators (user_id, note) values (p_user_id, p_note)
  on conflict (user_id) do update set note = excluded.note;
end;
$$;

create function private.revoke_app_administrator(p_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with removed as (delete from private.app_administrators a where a.user_id = p_user_id returning 1)
  select exists (select 1 from removed)
$$;

create function public.cleanup_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings private.cleanup_settings;
  v_last private.cleanup_runs;
  v_finished private.cleanup_runs;
  v_report_days integer;
  v_history jsonb;
  v_too_large jsonb;
  v_review jsonb;
  v_review_counts jsonb;
  v_claims jsonb;
  v_registry text[];
  v_warnings text[] := '{}';
  v_failed_runs integer;
  v_retention_error text;
  v_retention jsonb;
begin
  if not private.is_app_administrator(auth.uid()) then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;

  select * into strict v_settings from private.cleanup_settings;
  select * into v_last from private.cleanup_runs r order by r.id desc limit 1;
  -- The latest run that produced a report (a run that failed before its
  -- record step has nothing to show).
  select * into v_finished from private.cleanup_runs r
  where r.status in ('completed', 'failed') and r.records_step_at is not null order by r.id desc limit 1;

  -- The same rule as the deletion gate (private.tg_cleanup_settings_guard).
  select count(distinct (r.started_at at time zone 'UTC')::date) into v_report_days
  from private.cleanup_runs r
  where r.mode = 'report' and r.source = 'scheduled' and r.status = 'completed'
    and r.records_step_at is not null and r.files_step_at is not null;

  select coalesce(jsonb_agg(h order by h.id desc), '[]'::jsonb) into v_history from (
    select r.id, r.mode, r.source, r.status, r.started_at, r.finished_at, r.records_deleted, r.files_deleted,
           (r.summary -> 'records' ->> 'candidates')::integer as record_candidates,
           (select sum((b.value ->> 'orphans')::integer) from jsonb_each(coalesce(r.summary -> 'files' -> 'buckets', '{}')) b)::integer as orphans,
           coalesce((r.summary -> 'records' ->> 'needs_review')::boolean, false)
             or coalesce((r.summary -> 'files' ->> 'needs_review')::boolean, false) as needs_review,
           r.error is not null as has_error
    from private.cleanup_runs r order by r.id desc limit 14
  ) h;

  select coalesce(jsonb_agg(jsonb_build_object('table', c.table_name, 'record_id', c.record_id, 'sled_id', c.sled_id,
                                                'rows', c.group_rows, 'expired_at', c.expired_at) order by c.group_rows desc), '[]'::jsonb)
    into v_too_large
  from (select * from private.cleanup_candidates c
        where c.run_id = v_finished.id and c.outcome = 'too_large' order by c.group_rows desc limit 50) c;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc nulls last), '[]'::jsonb) into v_review from (
    select v.source, v.kind, v.outcome, v.table_name, v.bucket_id, v.object_path, v.detail, v.at
    from private.cleanup_review v where v.outcome <> 'too_large' order by v.at desc nulls last limit 50
  ) x;
  select coalesce(jsonb_object_agg(x.outcome, x.n), '{}'::jsonb) into v_review_counts from (
    select v.outcome, count(*) as n from private.cleanup_review v group by v.outcome
  ) x;
  select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) into v_claims from (
    select k.status, count(*) as n from private.storage_cleanup_claims k group by k.status
  ) x;

  v_registry := private.cleanup_registry_problems();
  if cardinality(v_registry) > 0 then
    v_warnings := v_warnings || ('The cleanup registry is incomplete (' || cardinality(v_registry) || ' problem(s)); deletion is blocked.');
  end if;
  if coalesce((v_finished.summary -> 'files' ->> 'storage_unreadable')::boolean, false) then
    v_warnings := v_warnings || 'Storage looked empty while records point at files; every bucket was blocked.'::text;
  end if;
  if coalesce((v_claims ->> 'replaced')::integer, 0) > 0 then
    v_warnings := v_warnings || (coalesce((v_claims ->> 'replaced')::integer, 0) || ' removal(s) took a file replaced at the same path (service role). Review needed.');
  end if;
  select count(*) into v_failed_runs from (select r.status from private.cleanup_runs r order by r.id desc limit 14) x
  where x.status in ('failed', 'abandoned');
  if v_failed_runs > 0 then
    v_warnings := v_warnings || (v_failed_runs || ' of the last 14 runs failed or did not finish.');
  end if;
  -- Operational-history retention (the cleanup's own logs; not user data).
  select left(r.error, 300) into v_retention_error from private.cleanup_runs r
  where r.error like 'Applying retention%' order by r.id desc limit 1;
  v_retention := jsonb_build_object(
    'enabled', v_settings.retention_enabled,
    'authorized_at', v_settings.retention_authorized_at,
    'periods', jsonb_build_object(
      'run_days', v_settings.retention_run_days,
      'report_candidate_days', v_settings.retention_report_candidate_days,
      'delete_candidate_days', v_settings.retention_delete_candidate_days,
      'released_claim_days', v_settings.retention_released_claim_days,
      'keep_report_runs', v_settings.retention_keep_report_runs,
      'batch_size', v_settings.retention_batch_size),
    'qualifying', private.retention_counts(),
    'last', (select jsonb_build_object('run_id', r.id, 'at', r.retention_step_at, 'summary', r.summary -> 'retention')
             from private.cleanup_runs r where r.retention_step_at is not null order by r.id desc limit 1),
    'last_error', v_retention_error,
    'failed_claims_unreviewed', (select count(*) from private.storage_cleanup_claims k where k.status = 'failed' and k.reviewed_at is null),
    'failed_claims_reviewed', (select count(*) from private.storage_cleanup_claims k where k.status = 'failed' and k.reviewed_at is not null),
    'tombstones', (select count(*) from private.storage_cleanup_claims k where k.status in ('deleted', 'replaced', 'missing')));
  if v_retention_error is not null then
    v_warnings := v_warnings || 'A retention step failed; operational history was not trimmed in that run.'::text;
  end if;
  if v_settings.deletion_enabled and v_report_days < v_settings.required_report_runs then
    v_warnings := v_warnings || 'Deletion is on although fewer daily report runs than required are recorded.'::text;
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'settings', jsonb_build_object(
      'deletion_enabled', v_settings.deletion_enabled,
      'deletion_authorized_at', v_settings.deletion_authorized_at,
      'backup_recorded', nullif(btrim(coalesce(v_settings.deletion_backup_reference, '')), '') is not null,
      'required_report_runs', v_settings.required_report_runs,
      'max_records_per_run', v_settings.max_records_per_run,
      'max_files_per_run', v_settings.max_files_per_run,
      'bucket_threshold_percent', v_settings.bucket_threshold_percent,
      'bucket_threshold_min_files', 100,
      'min_file_age_hours', (extract(epoch from v_settings.min_file_age) / 3600)::integer,
      'installed_at', v_settings.installed_at),
    'report_days', v_report_days,
    'last_run', case when v_last.id is null then null else jsonb_build_object(
      'id', v_last.id, 'mode', v_last.mode, 'source', v_last.source, 'status', v_last.status,
      'started_at', v_last.started_at, 'finished_at', v_last.finished_at, 'error', left(v_last.error, 300)) end,
    'latest', case when v_finished.id is null then null else jsonb_build_object(
      'id', v_finished.id, 'mode', v_finished.mode, 'status', v_finished.status,
      'started_at', v_finished.started_at, 'finished_at', v_finished.finished_at,
      'records_deleted', v_finished.records_deleted, 'files_deleted', v_finished.files_deleted,
      'records', (v_finished.summary -> 'records') - 'deleted_groups' - 'too_large' - 'cutoff',
      'files', v_finished.summary -> 'files') end,
    'too_large', v_too_large,
    'review', v_review,
    'review_counts', v_review_counts,
    'claims', v_claims,
    'registry_problems', to_jsonb(v_registry),
    'warnings', to_jsonb(v_warnings),
    'retention', v_retention,
    'history', v_history
  );
end;
$$;

revoke all on function
  private.is_app_administrator(uuid),
  private.grant_app_administrator(uuid, text),
  private.revoke_app_administrator(uuid),
  public.cleanup_dashboard()
from public, anon, authenticated, service_role;
-- Signed-in users may call it; it refuses everyone who is not an administrator.
grant execute on function public.cleanup_dashboard() to authenticated;

-- -----------------------------------------------------------------------------
-- 16. Operational-history retention: the cleanup system's OWN logs (runs,
--     candidates, file claims), never user data and unrelated to the 30-day
--     recovery period. Approved periods: run summaries 400 days; report-run
--     details 30 days (the latest 7 completed report runs always kept);
--     delete-run details 180 days; released claims 180 days. Removed-path
--     tombstones (deleted, replaced, missing), active claims, failed claims and
--     closed claims are NEVER removed. Runs as a step of the daily job; deletes
--     only when retention maintenance is switched on (its own switch, off by
--     default), in bounded batches, in one transaction.
-- -----------------------------------------------------------------------------

-- Every operational-history row that qualifies for removal now (read-only).
create function private.retention_candidates(p_now timestamptz default now())
returns table (kind text, run_id bigint, candidate_id bigint, bucket_id text, object_path text, at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from private.cleanup_settings),
  protected as (
    select r.id from private.cleanup_runs r
    where r.mode = 'report' and r.status = 'completed' and r.records_step_at is not null and r.files_step_at is not null
    order by r.id desc
    limit (select s.retention_keep_report_runs from s)
  )
  select 'run', r.id, null::bigint, null::text, null::text, r.started_at
  from private.cleanup_runs r, s
  where r.status <> 'running' and r.started_at < p_now - make_interval(days => s.retention_run_days)
    and r.id not in (select id from protected)
  union all
  select case r.mode when 'report' then 'report_candidate' else 'delete_candidate' end, r.id, c.id, null, null, r.started_at
  from private.cleanup_candidates c join private.cleanup_runs r on r.id = c.run_id, s
  where r.status <> 'running' and r.id not in (select id from protected)
    and r.started_at < p_now - make_interval(days => case r.mode when 'report' then s.retention_report_candidate_days
                                                                 else s.retention_delete_candidate_days end)
  union all
  select 'released_claim', k.run_id, null, k.bucket_id, k.object_path, coalesce(k.finished_at, k.claimed_at)
  from private.storage_cleanup_claims k, s
  where k.status = 'released'
    and coalesce(k.finished_at, k.claimed_at) < p_now - make_interval(days => s.retention_released_claim_days)
$$;

create function private.retention_counts(p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'runs', count(*) filter (where kind = 'run'),
    'report_candidates', count(*) filter (where kind = 'report_candidate'),
    'delete_candidates', count(*) filter (where kind = 'delete_candidate'),
    'released_claims', count(*) filter (where kind = 'released_claim'))
  from private.retention_candidates(p_now)
$$;

-- The retention step of a run: previews (always) and, only when retention
-- maintenance is on, removes at most retention_batch_size rows: details
-- first, then released claims, then run summaries that no longer have any
-- details. Every DELETE repeats its rule; tombstones and other claims can
-- never match. Any failure undoes the whole step.
create function private.cleanup_retention(p_run_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run private.cleanup_runs;
  v_settings private.cleanup_settings;
  v_now timestamptz := now();
  v_counts jsonb;
  v_budget integer;
  v_n integer;
  v_deleted jsonb := jsonb_build_object('details', 0, 'released_claims', 0, 'runs', 0);
  v_protected integer;
  v_completed integer;
  v_tombstones_before bigint;
  v_tombstones_after bigint;
  v_summary jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('sledwerx.cleanup.retention', 0)) then
    raise exception 'Another cleanup is applying retention.' using errcode = '55P03';
  end if;
  select * into v_run from private.cleanup_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'Cleanup run not found.' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'This cleanup run has finished.' using errcode = '55000';
  end if;
  if v_run.retention_step_at is not null then
    raise exception 'Retention was already applied in this run.' using errcode = '55000';
  end if;
  select * into strict v_settings from private.cleanup_settings;

  -- Safety checks (fail closed): the protected report runs are intact.
  select count(*) into v_completed from private.cleanup_runs r
  where r.mode = 'report' and r.status = 'completed' and r.records_step_at is not null and r.files_step_at is not null;
  select count(*) into v_protected from private.cleanup_runs r
  where r.mode = 'report' and r.status = 'completed' and r.records_step_at is not null and r.files_step_at is not null
    and not exists (select 1 from private.retention_candidates(v_now) x where x.kind = 'run' and x.run_id = r.id);
  if v_protected < least(v_completed, v_settings.retention_keep_report_runs) then
    raise exception 'Retention safety check failed: the latest report runs are not protected.' using errcode = 'SWC03';
  end if;

  v_counts := private.retention_counts(v_now);
  select count(*) into v_tombstones_before from private.storage_cleanup_claims k
  where k.status in ('claimed', 'deleted', 'replaced', 'missing', 'failed', 'closed');

  if v_settings.retention_enabled then
    v_budget := v_settings.retention_batch_size;

    delete from private.cleanup_candidates c
    where c.id in (
      select x.candidate_id from private.retention_candidates(v_now) x
      where x.kind in ('report_candidate', 'delete_candidate') order by x.candidate_id limit v_budget);
    get diagnostics v_n = row_count;
    v_deleted := jsonb_set(v_deleted, '{details}', to_jsonb(v_n));
    v_budget := v_budget - v_n;

    if v_budget > 0 then
      delete from private.storage_cleanup_claims k
      where k.status = 'released'
        and coalesce(k.finished_at, k.claimed_at) < v_now - make_interval(days => v_settings.retention_released_claim_days)
        and (k.bucket_id, k.object_path) in (
          select x.bucket_id, x.object_path from private.retention_candidates(v_now) x
          where x.kind = 'released_claim' order by x.at limit v_budget);
      get diagnostics v_n = row_count;
      v_deleted := jsonb_set(v_deleted, '{released_claims}', to_jsonb(v_n));
      v_budget := v_budget - v_n;
    end if;

    if v_budget > 0 then
      -- Only summaries whose details are already gone (no cascades).
      delete from private.cleanup_runs r
      where r.status <> 'running'
        and not exists (select 1 from private.cleanup_candidates c where c.run_id = r.id)
        and r.id in (select x.run_id from private.retention_candidates(v_now) x where x.kind = 'run' order by x.run_id limit v_budget);
      get diagnostics v_n = row_count;
      v_deleted := jsonb_set(v_deleted, '{runs}', to_jsonb(v_n));
    end if;

    -- Tombstones and every other non-released claim are untouched.
    select count(*) into v_tombstones_after from private.storage_cleanup_claims k
    where k.status in ('claimed', 'deleted', 'replaced', 'missing', 'failed', 'closed');
    if v_tombstones_after <> v_tombstones_before then
      raise exception 'Retention safety check failed: protected claims changed.' using errcode = 'SWC03';
    end if;
  end if;

  v_summary := jsonb_build_object(
    'enabled', v_settings.retention_enabled,
    'qualifying', v_counts,
    'removed', jsonb_build_object(
      'details', (v_deleted ->> 'details')::integer,
      'released_claims', (v_deleted ->> 'released_claims')::integer,
      'runs', (v_deleted ->> 'runs')::integer),
    'batch_size', v_settings.retention_batch_size,
    'remaining', private.retention_counts(v_now)
  );

  update private.cleanup_runs
  set retention_step_at = now(), summary = summary || jsonb_build_object('retention', v_summary)
  where id = p_run_id;
  return v_summary;
end;
$$;

create function public.cleanup_retention(p_run_id bigint)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select private.cleanup_retention(p_run_id) $$;

-- Failed removals (3 failed attempts). Database owner only (SQL editor).
-- Reviewing records who looked and why; it changes nothing else. Resolving
-- requires a review first and is one of:
--   removed: the file is confirmed gone (checked) -> a 'deleted' tombstone;
--   retry:   the cause is fixed and the file is still there -> 'released',
--            attempts reset, retried by the next delete run;
--   keep:    the file stays -> 'closed', never removed automatically.
-- Review and resolution notes stay on the claim.
create function private.review_failed_claim(p_bucket_id text, p_object_path text, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Describe what was reviewed.' using errcode = '22023';
  end if;
  update private.storage_cleanup_claims
  set reviewed_at = now(), review_note = p_note
  where bucket_id = p_bucket_id and object_path = p_object_path and status = 'failed';
  if not found then
    raise exception 'No failed claim for this file.' using errcode = 'P0002';
  end if;
end;
$$;

create function private.resolve_failed_claim(p_bucket_id text, p_object_path text, p_resolution text, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim private.storage_cleanup_claims;
  v_exists boolean;
  v_status text;
begin
  if p_resolution is null or p_resolution not in ('removed', 'retry', 'keep') then
    raise exception 'Resolution must be removed, retry or keep.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Describe how it was resolved.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(private.storage_lock_key(p_bucket_id, p_object_path));
  select * into v_claim from private.storage_cleanup_claims k
  where k.bucket_id = p_bucket_id and k.object_path = p_object_path for update;
  if not found or v_claim.status <> 'failed' then
    raise exception 'No failed claim for this file.' using errcode = 'P0002';
  end if;
  if v_claim.reviewed_at is null then
    raise exception 'Review the failed claim first (private.review_failed_claim).' using errcode = '55000';
  end if;
  select exists (select 1 from storage.objects o where o.bucket_id = p_bucket_id and o.name = p_object_path) into v_exists;
  if p_resolution = 'removed' and v_exists then
    raise exception 'The file is still in Storage; it was not removed.' using errcode = '55000';
  end if;
  if p_resolution in ('retry', 'keep') and not v_exists then
    raise exception 'The file is no longer in Storage; resolve it as removed.' using errcode = '55000';
  end if;
  v_status := case p_resolution when 'removed' then 'deleted' when 'retry' then 'released' else 'closed' end;
  update private.storage_cleanup_claims
  set status = v_status, resolution = p_resolution, resolution_note = p_note, resolved_at = now(),
      finished_at = now(), attempts = case when p_resolution = 'retry' then 0 else attempts end
  where bucket_id = p_bucket_id and object_path = p_object_path;
  return v_status;
end;
$$;

revoke all on function
  private.authorize_retention_maintenance(text),
  private.revoke_retention_maintenance(),
  private.retention_candidates(timestamptz),
  private.retention_counts(timestamptz),
  private.cleanup_retention(bigint),
  private.review_failed_claim(text, text, text),
  private.resolve_failed_claim(text, text, text, text),
  public.cleanup_retention(bigint)
from public, anon, authenticated, service_role;
grant execute on function public.cleanup_retention(bigint) to service_role;
