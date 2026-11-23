/**
 * Integration test of the cleanup job with MEASUREMENT PHOTOS (Migrations 10
 * and 11) against a THROWAWAY local Supabase stack (CI's database job): real
 * users, real uploads with the real storage policies, real removals.
 *
 * Shared files: a file used by several Trail configurations is never removed
 * while any row (active or in Recently Deleted) refers to it; it is removed
 * only after its last row is purged. Purging an old configuration keeps, and
 * keeps viewable, a file another configuration still uses, and the next save
 * can still carry it forward.
 *
 * Skipped unless the CLEANUP_IT_* variables are set; never point them at a
 * real project. Runs in its own CI step (it changes the cleanup's settings).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupDeps } from "./adapters";
import { runCleanup } from "./run";

const URL = process.env.CLEANUP_IT_URL;
const SECRET_KEY = process.env.CLEANUP_IT_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.CLEANUP_IT_PUBLISHABLE_KEY;
const PSQL = process.env.CLEANUP_IT_PSQL;
const enabled = Boolean(URL && SECRET_KEY && PUBLISHABLE_KEY && PSQL && process.env.THROWAWAY_DATABASE === "yes");

const BUCKET = "suspension-photos";
const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function sql(query: string): string {
  return execFileSync("sh", ["-c", `${PSQL} -X -q -v ON_ERROR_STOP=1 -tA`], { input: query, encoding: "utf8" }).trim();
}
const quoted = (values: string[]) => `array[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}]::text[]`;
const exists = (path: string) => sql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${path}';`) === "1";
const rowsWith = (path: string) => Number(sql(`select count(*) from public.sled_measurement_photos where path = '${path}';`));

/** Makes files look uploaded two days ago (rows are copied out and back with old timestamps; the stored file is untouched). */
function age(paths: string[]) {
  sql(`
    select set_config('storage.allow_delete_query', 'true', false);
    do $$
    declare v_cols text;
    begin
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
      from information_schema.columns
      where table_schema = 'storage' and table_name = 'objects' and is_generated = 'NEVER'
        and column_name not in ('created_at', 'updated_at');
      execute format('create temporary table aged on commit drop as select %s from storage.objects where bucket_id = %L and name = any(%s)',
                     v_cols, '${BUCKET}', $q$${quoted(paths)}$q$);
      execute format('delete from storage.objects where bucket_id = %L and name = any(%s)', '${BUCKET}', $q$${quoted(paths)}$q$);
      execute format('insert into storage.objects (%s, created_at, updated_at) select %s, now() - interval ''2 days'', now() - interval ''2 days'' from aged',
                     v_cols, v_cols);
    end $$;`);
}

async function signedInUser(admin: SupabaseClient, label: string) {
  const email = `measurement-it-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(URL!, PUBLISHABLE_KEY!, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { client, email, id: created.data.user.id };
}

const jpeg = (label: string) => new Blob([`\xff\xd8\xff${label}${randomUUID()}`], { type: "image/jpeg" });

async function ok<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

describe.skipIf(!enabled)("measurement photos and the cleanup job on the local Supabase stack", () => {
  let admin: SupabaseClient;
  let owner: Awaited<ReturnType<typeof signedInUser>>;
  let mechanic: Awaited<ReturnType<typeof signedInUser>>;
  let stranger: Awaited<ReturnType<typeof signedInUser>>;
  let sledId: string;
  let sagId: string;
  const trail: Record<string, string> = {};
  const files: Record<string, string> = {};
  const deps = () => cleanupDeps(admin);
  const later = () => Date.now() + 60_000;
  const folder = (revisionId: string) => `${sledId}/${revisionId}/${randomUUID()}.jpg`;

  async function upload(client: SupabaseClient, name: string) {
    const { error } = await client.storage.from(BUCKET).upload(name, jpeg(name), { contentType: "image/jpeg", upsert: false });
    if (error) throw new Error(`upload failed: ${error.message}`);
  }
  async function save(base: string | null, value: string) {
    const data = await ok(
      owner.client.rpc("save_suspension_configuration", {
        p_sled_id: sledId,
        ...(base ? { p_base_revision_id: base } : {}),
        p_changes: { [sagId]: value },
        p_idempotency_key: randomUUID(),
      }),
    );
    return (data as { revision_id: string }).revision_id;
  }
  const addPhoto = (revisionId: string, path: string) =>
    ok(owner.client.rpc("add_suspension_measurement_photo", { p_revision_id: revisionId, p_setting_id: sagId, p_path: path }));
  const paths = (revisionId: string) =>
    sql(`select coalesce(string_agg(path, ',' order by slot), '') from public.sled_measurement_photos
         where revision_id = '${revisionId}' and deleted_at is null;`);

  beforeAll(async () => {
    admin = createClient(URL!, SECRET_KEY!, noSession);
    sql(`select private.revoke_cleanup_deletion();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';`);
    owner = await signedInUser(admin, "owner");
    mechanic = await signedInUser(admin, "mech");
    stranger = await signedInUser(admin, "other");

    sledId = (await ok(
      owner.client.rpc("create_sled", { p_make: "Lynx", p_model: "Rave", p_model_year: 2024, p_odometer_mi: 100 }),
    )) as string;
    const invite = await ok(owner.client.rpc("create_sled_invitation", { p_sled_id: sledId, p_email: mechanic.email, p_role: "mechanic" }));
    await ok(mechanic.client.rpc("accept_sled_invitation", { p_token: (invite as { token: string }[])[0].token }));
    sagId = (await ok(
      owner.client
        .from("suspension_settings")
        .insert({ sled_id: sledId, name: "Sag", zone: "rear_general", unit: "mm" })
        .select("id")
        .single(),
    ))!.id;

    // Trail 1 with photo A; Trail 2 carries A forward, then replaces it with B.
    trail.one = await save(null, "30");
    files.a = folder(trail.one);
    await upload(owner.client, files.a);
    await addPhoto(trail.one, files.a);
    trail.two = await save(trail.one, "31");
    files.b = folder(trail.two);
    await upload(owner.client, files.b);
    const carried = sql(
      `select id || '|' || version from public.sled_measurement_photos where revision_id = '${trail.two}' and path = '${files.a}';`,
    );
    const [carriedId, carriedVersion] = carried.split("|");
    await ok(
      owner.client.rpc("replace_suspension_measurement_photo", {
        p_photo_id: carriedId,
        p_version: Number(carriedVersion),
        p_path: files.b,
      }),
    );
    // A is then removed from Trail 1 as well: every row of A is in Recently Deleted.
    const trailOneRow = sql(
      `select id || '|' || version from public.sled_measurement_photos where revision_id = '${trail.one}' and path = '${files.a}';`,
    );
    const [rowId, rowVersion] = trailOneRow.split("|");
    await ok(
      owner.client
        .from("sled_measurement_photos")
        .update({ deleted_at: new Date().toISOString(), version: Number(rowVersion) })
        .eq("id", rowId),
    );

    // An older setup's configuration with photo C, which Trail 2 also uses.
    trail.old = (
      (await ok(owner.client.rpc("create_suspension_setup", { p_sled_id: sledId, p_name: "Old" }))) as { revision_id: string }
    ).revision_id;
    files.c = folder(trail.old);
    await upload(owner.client, files.c);
    await addPhoto(trail.old, files.c);
    await addPhoto(trail.two, files.c);

    // A mechanic's upload whose record never got saved, and a fresh upload.
    files.m = folder(trail.two);
    await upload(mechanic.client, files.m);
    files.f = folder(trail.two);
    await upload(mechanic.client, files.f);
    age([files.a, files.b, files.c, files.m]);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    // Leave the cleanup exactly as a fresh install (later CI steps test it from scratch).
    sql(`select private.revoke_cleanup_deletion();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';
         delete from private.storage_cleanup_claims;
         delete from private.cleanup_runs;
         alter table private.cleanup_settings disable trigger guard;
         update private.cleanup_settings set deletion_authorized_at = null, deletion_backup_reference = null;
         alter table private.cleanup_settings enable trigger guard;`);
    await admin.storage.from(BUCKET).remove(Object.values(files));
    for (const user of [owner, mechanic, stranger]) if (user) await admin.auth.admin.deleteUser(user.id);
  });

  it("a report run lists only the upload with no record; shared and recently removed files are protected", async () => {
    const report = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(report.status).toBe("completed");
    const listed = sql(`select coalesce(string_agg(object_path, ','), '') from private.cleanup_candidates
                        where run_id = ${report.runId} and kind = 'file' and bucket_id = '${BUCKET}';`);
    expect(listed).toBe(files.m);
    expect(rowsWith(files.a)).toBe(2); // both rows in Recently Deleted
    for (const key of ["a", "b", "c", "m", "f"]) expect(exists(files[key])).toBe(true);
  });

  it("30 days on, a delete run purges the rows and removes only files no configuration uses any more", async () => {
    // Every row of A, and the old setup with its configuration and photo row, expire.
    const setupId = sql(`select setup_id from public.suspension_revisions where id = '${trail.old}';`);
    sql(`
      alter table public.suspension_setups disable trigger guard;
      alter table public.suspension_setups disable trigger quick_tune;
      update public.suspension_setups set deleted_at = now() - interval '31 days', version = version where id = '${setupId}';
      alter table public.suspension_setups enable trigger guard;
      alter table public.suspension_setups enable trigger quick_tune;
      alter table public.suspension_revisions disable trigger guard;
      update public.suspension_revisions set deleted_at = now() - interval '31 days' where setup_id = '${setupId}';
      alter table public.suspension_revisions enable trigger guard;
      alter table public.sled_measurement_photos disable trigger guard;
      update public.sled_measurement_photos set deleted_at = now() - interval '31 days'
        where path = '${files.a}' or revision_id = '${trail.old}';
      alter table public.sled_measurement_photos enable trigger guard;
      insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
        select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now(), now()
        from generate_series(1, 7) d;
      select private.authorize_cleanup_deletion('integration test (throwaway stack)');`);

    const report = await runCleanup({ ...deps(), requestedMode: "delete", deadline: later() });
    expect(report).toMatchObject({ status: "completed", mode: "delete" });
    expect(report.removal).toMatchObject({ removed: 2, replaced: 0, failed: 0 });

    expect(rowsWith(files.a)).toBe(0);
    expect(sql(`select count(*) from public.suspension_revisions where id = '${trail.old}';`)).toBe("0");
    expect(exists(files.a)).toBe(false); // its last rows were purged
    expect(exists(files.m)).toBe(false); // never had a row
    expect(exists(files.b)).toBe(true); // Trail 2
    expect(exists(files.c)).toBe(true); // Trail 2, though its folder's configuration is gone
    expect(exists(files.f)).toBe(true); // too new
    expect(paths(trail.two)).toBe(`${files.b},${files.c}`);
  });

  it("a file kept for another configuration stays viewable for the snowmobile's people only (Migration 11)", async () => {
    for (const client of [owner.client, mechanic.client]) {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(files.c, 60);
      expect(error).toBeNull();
      expect(data?.signedUrl).toBeTruthy();
    }
    expect((await stranger.client.storage.from(BUCKET).createSignedUrl(files.c, 60)).error).not.toBeNull();
    expect((await stranger.client.storage.from(BUCKET).download(files.c)).error).not.toBeNull();
  });

  it("the next save still carries the photos forward (Migration 11), and removed files can't come back", async () => {
    trail.three = await save(trail.two, "32");
    expect(paths(trail.three)).toBe(`${files.b},${files.c}`);
    for (const key of ["a", "m"]) {
      const attach = await owner.client.rpc("add_suspension_measurement_photo", {
        p_revision_id: trail.three,
        p_setting_id: sagId,
        p_path: files[key],
      });
      expect(attach.error?.message).toMatch(/^(This photo was removed\. Add it again\.|At most 2 photos per measurement\.)$/);
    }
    const settingTwo = (await ok(
      owner.client
        .from("suspension_settings")
        .insert({ sled_id: sledId, name: "Height", zone: "rear_general", unit: "in" })
        .select("id")
        .single(),
    ))!.id;
    const reattach = await owner.client.rpc("add_suspension_measurement_photo", {
      p_revision_id: trail.three,
      p_setting_id: settingTwo,
      p_path: files.a,
    });
    expect(reattach.error?.message).toBe("This photo was removed. Add it again.");
  });
});
