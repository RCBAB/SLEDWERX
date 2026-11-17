-- =============================================================================
-- SledWerx — Migration 3: snowmobile photos and atomic snowmobile creation
--
-- * sleds.photo_path: the sled's photo in the private `sled-photos` bucket,
--   at "<sled id>/<random uuid>.jpg" (or .webp).
-- * Storage bucket `sled-photos`: private, 5 MB, JPEG/WebP only (the app
--   resizes photos in the browser before upload). Files are read through
--   short-lived signed URLs.
-- * Storage policies reuse the existing sled permissions, so photos follow
--   per-sled sharing exactly:
--     view a photo           -> anyone who can view the sled (owner and every
--                               active share: editor, mechanic, viewer)
--     add/replace/remove     -> owner and editors (edit_sled), and not while the
--                               sled is in Recently Deleted
-- * public.create_sled(): creates a sled and its first odometer/engine-hour
--   reading in one transaction. SECURITY INVOKER: the caller's RLS and every
--   existing trigger (ownership, audit, reading checks) apply unchanged.
-- * Reading dates: a trigger on sled_readings refuses dates in the future
--   (more than one day past the database's UTC date) on every write path.
--
-- Additive only. Migrations 1 and 2 are not modified.
-- Rollback (manual only): supabase/rollback/20261117150000_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Photo path on sleds. The first path segment must be the sled's own id, so a
-- sled can never point at another sled's photo.
-- -----------------------------------------------------------------------------
alter table public.sleds
  add column photo_path text
  constraint sleds_photo_path_check check (
    photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
    and split_part(photo_path, '/', 1) = id::text
  );

comment on column public.sleds.photo_path is
  'Object name in the private sled-photos storage bucket: <sled id>/<uuid>.jpg|webp. Read through signed URLs.';

-- -----------------------------------------------------------------------------
-- Private bucket
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sled-photos', 'sled-photos', false, 5242880, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The sled a photo object belongs to, or null if the name is not a valid
-- photo path (such objects match no policy, so nobody can use them).
create function private.photo_sled_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|webp)$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

revoke all on function private.photo_sled_id(text) from public, anon;
grant execute on function private.photo_sled_id(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Storage policies (signed-in users only; anonymous users match none)
-- -----------------------------------------------------------------------------
create policy "SledWerx: sled users can view sled photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'sled-photos'
    and private.has_sled_permission(private.photo_sled_id(name), 'view')
  );

create policy "SledWerx: owners and editors can upload sled photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sled-photos'
    and private.has_sled_permission(private.photo_sled_id(name), 'edit_sled')
  );

create policy "SledWerx: owners and editors can replace sled photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'sled-photos'
    and private.has_sled_permission(private.photo_sled_id(name), 'edit_sled')
  )
  with check (
    bucket_id = 'sled-photos'
    and private.has_sled_permission(private.photo_sled_id(name), 'edit_sled')
  );

create policy "SledWerx: owners and editors can remove sled photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'sled-photos'
    and private.has_sled_permission(private.photo_sled_id(name), 'edit_sled')
  );

-- -----------------------------------------------------------------------------
-- Reading dates: no reading may be dated in the future, on every write path
-- (Update mileage, Fix last reading, create_sled, save_maintenance_entry and
-- direct API calls). Migration 2 had no such rule, so a far-future reading
-- would become the "latest" reading and block every later real one.
-- One day of slack covers time zones ahead of the database clock (UTC); the
-- app also checks against the user's own local date. Only new dates are
-- checked, so editing other fields of an existing reading never fails here.
-- -----------------------------------------------------------------------------
create function private.tg_sled_readings_date_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.read_on > current_date + 1
     and (tg_op = 'INSERT' or new.read_on is distinct from old.read_on) then
    raise exception 'The reading date cannot be in the future.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.tg_sled_readings_date_check() from public, anon, authenticated;

create trigger date_check before insert or update of read_on on public.sled_readings
  for each row execute function private.tg_sled_readings_date_check();

-- -----------------------------------------------------------------------------
-- create_sled: a new sled and its first reading, together or not at all.
-- Defaults to the caller's oldest garage ("My Garage" from sign-up).
-- -----------------------------------------------------------------------------
create function public.create_sled(
  p_make text,
  p_model text,
  p_model_year integer,
  p_odometer_mi numeric,
  p_engine_hours numeric default null,
  p_nickname text default null,
  p_vin text default null,
  p_read_on date default null,
  p_garage_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_garage_id uuid := p_garage_id;
  v_read_on date := coalesce(p_read_on, current_date);
  v_sled_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to add a snowmobile.' using errcode = '42501';
  end if;
  if p_odometer_mi is null then
    raise exception 'Enter the current odometer reading.' using errcode = '23502';
  end if;
  -- One day of slack for time zones ahead of the database clock (UTC).
  if v_read_on > current_date + 1 then
    raise exception 'The reading date cannot be in the future.' using errcode = '22023';
  end if;

  if v_garage_id is null then
    select g.id into v_garage_id
    from public.garages g
    where g.owner_id = v_uid and g.deleted_at is null
    order by g.created_at, g.id
    limit 1;
    if v_garage_id is null then
      raise exception 'Garage not found.' using errcode = '23503';
    end if;
  end if;

  insert into public.sleds (garage_id, model_year, make, model, nickname, vin)
  values (
    v_garage_id,
    p_model_year,
    btrim(p_make),
    btrim(p_model),
    nullif(btrim(p_nickname), ''),
    nullif(btrim(p_vin), '')
  )
  returning id into v_sled_id;

  insert into public.sled_readings (sled_id, read_on, odometer_mi, engine_hours)
  values (v_sled_id, v_read_on, p_odometer_mi, p_engine_hours);

  return v_sled_id;
end;
$$;

revoke all on function public.create_sled(text, text, integer, numeric, numeric, text, text, date, uuid)
  from public, anon;
grant execute on function public.create_sled(text, text, integer, numeric, numeric, text, text, date, uuid)
  to authenticated;
