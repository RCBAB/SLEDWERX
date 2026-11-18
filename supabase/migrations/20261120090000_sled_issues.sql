-- =============================================================================
-- SledWerx migration 6 (Phase 6.1): simple issue log
--
-- * sled_issues: problems noticed on a sled (title, description, priority,
--   open/resolved, the mileage at the time, optional link to the completed
--   service record that fixed it). A record table following the pattern in
--   docs/database.md ("Building a record table for a later module"): RLS from
--   the sled's sharing permissions, Migration 1's record guard (mechanics edit
--   only what they created; owners and editors delete and restore), metadata
--   and version checks, and the audit log.
-- * sled_issue_photos: up to 6 photos per issue (same pattern).
-- * Storage bucket `issue-photos` (private): <sled id>/<issue id>/<uuid>.jpg
--   or .webp. Anyone who can view the sled can view; whoever may edit the
--   issue can upload; owners and editors can remove files.
-- * restore_record_version also accepts the two new tables.
--
-- Additive only: no existing table, view or policy changes. Service records,
-- readings and the maintenance board are untouched. An issue's mileage is a
-- copy of the reading at the time; it never creates a reading.
-- Rollback: supabase/rollback/20261120090000_rollback.sql (manual only).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sled_issues
-- -----------------------------------------------------------------------------
create table public.sled_issues (
  id uuid primary key default gen_random_uuid(),
  sled_id uuid not null references public.sleds (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (char_length(description) <= 10000),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  reported_on date not null default current_date,
  -- The odometer when the issue was noticed (copied, editable; not a reading).
  odometer_mi numeric(9, 1) check (odometer_mi >= 0 and odometer_mi < 1000000),
  resolved_on date,
  resolved_by uuid,
  resolution_notes text check (char_length(resolution_notes) <= 10000),
  -- The completed service record that fixed it (same sled). Only a link:
  -- nothing about the service is copied.
  resolved_entry_id uuid references public.maintenance_entries (id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  constraint sled_issues_resolution_check check (
    (status = 'open' and resolved_on is null and resolution_notes is null and resolved_entry_id is null)
    or (status = 'resolved' and resolved_on is not null)
  ),
  constraint sled_issues_resolved_after_reported check (resolved_on is null or resolved_on >= reported_on)
);

create index sled_issues_open_idx on public.sled_issues (sled_id, status, priority);
create index sled_issues_entry_idx on public.sled_issues (resolved_entry_id) where resolved_entry_id is not null;

comment on table public.sled_issues is
  'Issue log: problems noticed on a sled, open or resolved (Phase 6.1). Record table: sharing RLS, record guard, versioning, audit, Recently Deleted.';
comment on column public.sled_issues.odometer_mi is
  'Odometer when the issue was noticed, copied from the current reading and editable. Never creates a reading.';
comment on column public.sled_issues.resolved_entry_id is
  'The completed, non-deleted service record on the same sled that resolved the issue (checked when set). A link only.';

-- Dates, resolution bookkeeping, and the service-record link.
create function private.tg_sled_issues_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry record;
begin
  -- No future dates (one day of slack for time zones ahead of UTC); only new dates are checked.
  if new.reported_on > current_date + 1
     and (tg_op = 'INSERT' or new.reported_on is distinct from old.reported_on) then
    raise exception 'The issue date cannot be in the future.' using errcode = '22023';
  end if;
  if new.resolved_on > current_date + 1
     and (tg_op = 'INSERT' or new.resolved_on is distinct from old.resolved_on) then
    raise exception 'The resolved date cannot be in the future.' using errcode = '22023';
  end if;

  -- Who resolved it is recorded by the database, never sent by the client.
  if new.status = 'resolved' and (tg_op = 'INSERT' or old.status <> 'resolved') then
    new.resolved_by := auth.uid();
  elsif new.status = 'open' then
    new.resolved_by := null;
  elsif tg_op = 'UPDATE' then
    new.resolved_by := old.resolved_by;
  end if;

  -- A linked service record must be on the same sled, completed and not
  -- deleted when the link is made. (If it is deleted later, the issue stays
  -- resolved and the link comes back if the record is restored.)
  if new.resolved_entry_id is not null
     and (tg_op = 'INSERT' or new.resolved_entry_id is distinct from old.resolved_entry_id) then
    select e.sled_id, e.completed, e.deleted_at into v_entry
    from public.maintenance_entries e
    where e.id = new.resolved_entry_id;
    if not found or v_entry.sled_id <> new.sled_id then
      raise exception 'That service record is not on this snowmobile.' using errcode = '23514';
    end if;
    if not v_entry.completed or v_entry.deleted_at is not null then
      raise exception 'Only a completed service record can resolve an issue.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- sled_issue_photos
-- -----------------------------------------------------------------------------
create table public.sled_issue_photos (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.sled_issues (id) on delete cascade,
  sled_id uuid not null references public.sleds (id) on delete cascade,
  path text not null check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
  ),
  position smallint not null default 0 check (position between 0 and 99),
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  unique (path)
);

create index sled_issue_photos_issue_idx on public.sled_issue_photos (issue_id, position);

comment on table public.sled_issue_photos is
  'Photos of an issue (at most 6 active), files in the private issue-photos bucket at <sled id>/<issue id>/<uuid>.jpg|webp.';

-- A photo belongs to its issue's sled, lives in that issue's folder, can only
-- be added by someone who may edit the issue, and an issue has at most 6.
create function private.tg_sled_issue_photos_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_issue record;
begin
  if tg_op = 'UPDATE' and (new.issue_id is distinct from old.issue_id or new.path is distinct from old.path) then
    raise exception 'A photo cannot be moved to another issue.' using errcode = '42501';
  end if;

  select i.sled_id, i.created_by, i.deleted_at into v_issue from public.sled_issues i where i.id = new.issue_id;
  if not found then
    raise exception 'Issue not found.' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    new.sled_id := v_issue.sled_id;
    if auth.uid() is not null and not private.can_modify_sled_record(v_issue.sled_id, v_issue.created_by) then
      raise exception 'You do not have permission to add photos to this issue.' using errcode = '42501';
    end if;
    if v_issue.deleted_at is not null then
      raise exception 'Restore this issue before adding photos.' using errcode = '42501';
    end if;
  end if;
  if split_part(new.path, '/', 1) <> new.sled_id::text or split_part(new.path, '/', 2) <> new.issue_id::text then
    raise exception 'That photo is not in this issue''s folder.' using errcode = '23514';
  end if;

  -- At most 6 active photos (adding, or restoring one). Serialized per issue.
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('sledwerx.issue_photos:' || new.issue_id::text, 0));
    if (select count(*) from public.sled_issue_photos p
        where p.issue_id = new.issue_id and p.deleted_at is null and p.id <> new.id) >= 6 then
      raise exception 'An issue can have at most 6 photos.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Issue deleted/restored: its photos follow (same timestamp, so a restore
-- brings back exactly what was deleted together).
create function private.tg_sled_issues_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.sled_issue_photos set deleted_at = new.deleted_at
      where issue_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.sled_issue_photos set deleted_at = null
      where issue_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

revoke all on function
  private.tg_sled_issues_check(),
  private.tg_sled_issue_photos_check(),
  private.tg_sled_issues_cascade()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Triggers (the record-table pattern, plus the checks above)
-- -----------------------------------------------------------------------------
create trigger guard before insert or update on public.sled_issues
  for each row execute function private.tg_sled_record_guard();
create trigger links before insert or update on public.sled_issues
  for each row execute function private.tg_sled_issues_check();
create trigger stamp before insert or update on public.sled_issues
  for each row execute function private.tg_stamp();
create trigger cascade_photos after update on public.sled_issues
  for each row execute function private.tg_sled_issues_cascade();
create trigger audit after insert or update on public.sled_issues
  for each row execute function private.tg_audit('maintenance');

create trigger links before insert or update on public.sled_issue_photos
  for each row execute function private.tg_sled_issue_photos_check();
create trigger guard before insert or update on public.sled_issue_photos
  for each row execute function private.tg_sled_record_guard();
create trigger stamp before insert or update on public.sled_issue_photos
  for each row execute function private.tg_stamp();
create trigger audit after insert or update on public.sled_issue_photos
  for each row execute function private.tg_audit('maintenance');

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security (never delete: Recently Deleted instead)
-- -----------------------------------------------------------------------------
revoke all on public.sled_issues, public.sled_issue_photos from anon, authenticated;
grant select, insert, update on public.sled_issues, public.sled_issue_photos to authenticated;

alter table public.sled_issues enable row level security;
alter table public.sled_issue_photos enable row level security;

create policy "Sled users can view issues"
  on public.sled_issues for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can report issues"
  on public.sled_issues for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit issues"
  on public.sled_issues for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

create policy "Sled users can view issue photos"
  on public.sled_issue_photos for select to authenticated
  using (private.has_sled_permission(sled_id, 'view')
         and (deleted_at is null or private.has_sled_permission(sled_id, 'restore_records')));
create policy "Owners, editors and mechanics can add issue photos"
  on public.sled_issue_photos for insert to authenticated
  with check (private.has_sled_permission(sled_id, 'add_records'));
create policy "Permitted users can edit issue photos"
  on public.sled_issue_photos for update to authenticated
  using (private.can_modify_sled_record(sled_id, created_by))
  with check (private.can_modify_sled_record(sled_id, created_by));

-- -----------------------------------------------------------------------------
-- Private bucket for issue photos
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('issue-photos', 'issue-photos', false, 5242880, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The issue an object belongs to, or null if the name is not a valid issue
-- photo path (such objects match no policy, so nobody can use them).
create function private.issue_photo_issue_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
    then split_part(p_name, '/', 2)::uuid
  end;
$$;

-- Whether the caller may add files to this issue's folder: the issue exists
-- on the sled named in the path, isn't deleted, and the caller may edit it.
create function private.can_add_issue_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sled_issues i
    where i.id = private.issue_photo_issue_id(p_name)
      and i.sled_id::text = split_part(p_name, '/', 1)
      and i.deleted_at is null
      and private.has_sled_permission(i.sled_id, 'add_records')
      and private.can_modify_sled_record(i.sled_id, i.created_by)
  );
$$;

-- The sled an issue photo object belongs to (for view and remove checks).
create function private.issue_photo_sled_id(p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.sled_id from public.sled_issues i
  where i.id = private.issue_photo_issue_id(p_name)
    and i.sled_id::text = split_part(p_name, '/', 1);
$$;

revoke all on function
  private.issue_photo_issue_id(text),
  private.can_add_issue_photo(text),
  private.issue_photo_sled_id(text)
from public, anon;
grant execute on function
  private.issue_photo_issue_id(text),
  private.can_add_issue_photo(text),
  private.issue_photo_sled_id(text)
to authenticated;

create policy "SledWerx issue photos: sled users can view"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'issue-photos'
    and private.has_sled_permission(private.issue_photo_sled_id(name), 'view')
  );

create policy "SledWerx issue photos: issue editors can upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'issue-photos'
    and private.can_add_issue_photo(name)
  );

create policy "SledWerx issue photos: owners and editors can remove"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'issue-photos'
    and private.has_sled_permission(private.issue_photo_sled_id(name), 'soft_delete_records')
  );

-- -----------------------------------------------------------------------------
-- restore_record_version: also for issues and issue photos (otherwise the
-- Migration 2 definition, unchanged).
-- -----------------------------------------------------------------------------
create or replace function public.restore_record_version(p_audit_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_audit public.audit_log%rowtype;
  v_columns text;
  v_rows integer;
begin
  select * into v_audit from public.audit_log a where a.id = p_audit_id;

  if v_audit.id is null
     or v_audit.old_data is null
     or v_audit.sled_id is null
     or v_audit.table_name not in (
       'sled_readings', 'maintenance_plans', 'maintenance_entries',
       'maintenance_entry_tasks', 'maintenance_entry_parts',
       'sled_issues', 'sled_issue_photos'
     )
     or not private.can_modify_sled_record(v_audit.sled_id, v_audit.record_created_by)
  then
    raise exception 'Version not found.' using errcode = 'P0002';
  end if;

  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
  into v_columns
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = v_audit.table_name
    and c.column_name not in (
      'id', 'sled_id', 'entry_id', 'created_at', 'created_by',
      'updated_at', 'updated_by', 'version', 'deleted_at', 'deleted_by',
      'client_request_id', 'issue_id', 'path', 'resolved_by'
    );

  -- The row's own guard re-checks permission with the caller's identity,
  -- refuses deleted records, and the stamp/audit triggers record the change.
  execute format(
    'update public.%1$I t set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $1)) where t.id = $2',
    v_audit.table_name, v_columns
  ) using v_audit.old_data, v_audit.record_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Version not found.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.restore_record_version(bigint) from public, anon;
grant execute on function public.restore_record_version(bigint) to authenticated;
