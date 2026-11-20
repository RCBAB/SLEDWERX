/**
 * Integration test of the cleanup job against a THROWAWAY local Supabase
 * stack (CI's database job): real users, real uploads through the Storage
 * API with the real storage policies, real removals. Skipped unless the
 * CLEANUP_IT_* variables are set; never point them at a real project.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupDeps } from "./adapters";
import { runCleanup, type CleanupStorage } from "./run";

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
const list = (values: string[]) => `array[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}]::text[]`;
const SLED_BUCKET = "sled-photos";
const exists = (path: string, bucket = BUCKET) =>
  sql(`select count(*) from storage.objects where bucket_id = '${bucket}' and name = '${path}';`) === "1";
const etag = (path: string, bucket: string) =>
  sql(`select metadata ->> 'eTag' from storage.objects where bucket_id = '${bucket}' and name = '${path}';`);
const claimStatus = (path: string, bucket = BUCKET) =>
  sql(`select status from private.storage_cleanup_claims where bucket_id = '${bucket}' and object_path = '${path}';`);

/**
 * Makes files look uploaded two days ago. Storage resets updated_at on every
 * update, so each row is copied out, removed and put back with old
 * timestamps (the stored file itself is untouched).
 */
function age(paths: string[], bucket = BUCKET) {
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
                     v_cols, '${bucket}', $q$${list(paths)}$q$);
      execute format('delete from storage.objects where bucket_id = %L and name = any(%s)', '${bucket}', $q$${list(paths)}$q$);
      execute format('insert into storage.objects (%s, created_at, updated_at) select %s, now() - interval ''2 days'', now() - interval ''2 days'' from aged',
                     v_cols, v_cols);
    end $$;`);
}

async function signedInUser(admin: SupabaseClient, label: string) {
  const email = `cleanup-it-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(URL!, PUBLISHABLE_KEY!, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { client, email, id: created.data.user.id };
}

const jpeg = (label: string) => new Blob([`\xff\xd8\xff${label}${randomUUID()}`], { type: "image/jpeg" });

describe.skipIf(!enabled)("cleanup job on the local Supabase stack", () => {
  let admin: SupabaseClient;
  let owner: Awaited<ReturnType<typeof signedInUser>>;
  let mechanic: Awaited<ReturnType<typeof signedInUser>>;
  let sledId: string;
  let revisionId: string;
  const path = () => `${sledId}/${revisionId}/${randomUUID()}.jpg`;
  const files: Record<string, string> = {};
  const deps = () => cleanupDeps(admin);
  const later = () => Date.now() + 60_000;

  async function tryUpload(client: SupabaseClient, name: string, options: { upsert?: boolean; bucket?: string } = {}) {
    const { error } = await client.storage
      .from(options.bucket ?? BUCKET)
      .upload(name, jpeg(name), { contentType: "image/jpeg", upsert: options.upsert ?? false });
    return error;
  }
  async function upload(client: SupabaseClient, name: string, options: { upsert?: boolean; bucket?: string } = {}) {
    const error = await tryUpload(client, name, options);
    if (error) throw new Error(`upload failed: ${error.message}`);
  }
  const sledPath = () => `${sledId}/${randomUUID()}.jpg`;

  beforeAll(async () => {
    admin = createClient(URL!, SECRET_KEY!, noSession);
    sql(`select private.revoke_cleanup_deletion();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';`);
    owner = await signedInUser(admin, "owner");
    mechanic = await signedInUser(admin, "mech");

    const sled = await owner.client.rpc("create_sled", { p_make: "Polaris", p_model: "RMK", p_model_year: 2023, p_odometer_mi: 100 });
    if (sled.error) throw sled.error;
    sledId = sled.data as string;
    const invite = await owner.client.rpc("create_sled_invitation", { p_sled_id: sledId, p_email: mechanic.email, p_role: "mechanic" });
    if (invite.error) throw invite.error;
    const accepted = await mechanic.client.rpc("accept_sled_invitation", { p_token: invite.data[0].token });
    if (accepted.error) throw accepted.error;
    const setup = await owner.client.rpc("create_suspension_setup", { p_sled_id: sledId, p_name: "Trail" });
    if (setup.error) throw setup.error;
    revisionId = (setup.data as { revision_id: string }).revision_id;

    // The mechanic's upload whose record was never saved (the known failure case).
    files.mech = path();
    await upload(mechanic.client, files.mech);
    // Protected: an active photo and a photo in Recently Deleted.
    for (const key of ["active", "recoverable"]) {
      files[key] = path();
      await upload(owner.client, files[key]);
      const insert = await owner.client.from("suspension_photos").insert({ sled_id: sledId, revision_id: revisionId, path: files[key] }).select("id").single();
      if (insert.error) throw insert.error;
      if (key === "recoverable") {
        const removed = await owner.client.from("suspension_photos").update({ deleted_at: new Date().toISOString() }).eq("id", insert.data.id);
        if (removed.error) throw removed.error;
      }
    }
    // Orphans for the replacement and failure cases, and one too new to touch.
    for (const key of ["changed", "race", "fail"]) {
      files[key] = path();
      await upload(owner.client, files[key]);
    }
    files.fresh = path();
    await upload(mechanic.client, files.fresh);
    files.reupload = path();
    await upload(owner.client, files.reupload);
    age([files.mech, files.active, files.recoverable, files.changed, files.race, files.fail, files.reupload]);
    // Snowmobile photos (owners and editors may overwrite these when unclaimed).
    files.sledClaim = sledPath();
    files.sledRace = sledPath();
    for (const key of ["sledClaim", "sledRace"]) await upload(owner.client, files[key], { bucket: SLED_BUCKET });
    age([files.sledClaim, files.sledRace], SLED_BUCKET);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    sql(`select private.revoke_cleanup_deletion();
         select private.revoke_retention_maintenance();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';
         delete from private.storage_cleanup_claims;
         delete from private.cleanup_runs;`);
    await admin.storage.from(BUCKET).remove(Object.values(files));
    await admin.storage.from(SLED_BUCKET).remove(Object.values(files));
    for (const user of [owner, mechanic]) if (user) await admin.auth.admin.deleteUser(user.id);
  });

  it("mechanics still cannot delete files themselves (storage policy unchanged)", async () => {
    const { data } = await mechanic.client.storage.from(BUCKET).remove([files.mech]);
    expect(data ?? []).toHaveLength(0);
    expect(exists(files.mech)).toBe(true);
  });

  it("with CLEANUP_MODE=delete but the database switch off, runs report-only and removes nothing", async () => {
    const report = await runCleanup({ ...deps(), requestedMode: "delete", deadline: later() });
    expect(report).toMatchObject({ status: "completed", mode: "report" });
    expect(report.warnings).toContain("Deletion is not authorized in the database; running report-only.");
    for (const [key, name] of Object.entries(files)) expect(exists(name, key.startsWith("sled") ? SLED_BUCKET : BUCKET)).toBe(true);
  });

  it("a report run lists the mechanic's orphaned upload and protects active, recoverable and new files", async () => {
    const report = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(report.status).toBe("completed");
    const outcome = (name: string) =>
      sql(`select coalesce(max(outcome), 'not listed') from private.cleanup_candidates where run_id = ${report.runId} and object_path = '${name}';`);
    expect(outcome(files.mech)).toBe("would_delete");
    expect(outcome(files.active)).toBe("not listed");
    expect(outcome(files.recoverable)).toBe("not listed");
    expect(outcome(files.fresh)).toBe("not listed");
    expect((report.files as { buckets: Record<string, { threshold_applies: boolean; blocked: boolean }> }).buckets[BUCKET])
      .toMatchObject({ threshold_applies: false, blocked: false });
    for (const [key, name] of Object.entries(files)) expect(exists(name, key.startsWith("sled") ? SLED_BUCKET : BUCKET)).toBe(true);
  });

  it("a duplicate invocation while a run is in progress is refused", async () => {
    const running = sql(`select private.cleanup_begin_run('report', 'manual');`);
    const report = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(report.status).toBe("busy");
    sql(`select private.cleanup_finish_run(${running});`);
  });

  it("while a file is claimed, nobody but the service role can overwrite it or upload at its path; other uploads work", async () => {
    sql(`insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
         select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now(), now()
         from generate_series(1, 7) d;
         select private.authorize_cleanup_deletion('integration test (throwaway stack)');`);
    const run = Number(sql(`select private.cleanup_begin_run('delete', 'manual');`));
    sql(`select private.cleanup_process_records(${run}); select private.cleanup_report_files(${run});`);
    for (const [bucket, name] of [[SLED_BUCKET, files.sledClaim], [BUCKET, files.reupload]]) {
      const claim = await admin.rpc("cleanup_claim_file", { p_run_id: run, p_bucket_id: bucket, p_object_path: name });
      expect(claim.data).toMatchObject({ claimed: true });
    }

    // Overwrite (upsert) at the claimed path: refused by the storage policy.
    const before = etag(files.sledClaim, SLED_BUCKET);
    expect(await tryUpload(owner.client, files.sledClaim, { bucket: SLED_BUCKET, upsert: true })).not.toBeNull();
    expect(etag(files.sledClaim, SLED_BUCKET)).toBe(before);
    // Remove (still allowed for owners), then upload again at the same path: refused.
    const removed = await owner.client.storage.from(BUCKET).remove([files.reupload]);
    expect(removed.data).toHaveLength(1);
    expect(await tryUpload(owner.client, files.reupload)).not.toBeNull();
    expect(exists(files.reupload)).toBe(false);
    // Uploads to new paths are unaffected.
    expect(await tryUpload(owner.client, sledPath(), { bucket: SLED_BUCKET })).toBeNull();
    expect(await tryUpload(mechanic.client, path())).toBeNull();
    // The claim is still the same object.
    const verify = await admin.rpc("cleanup_verify_claim", { p_run_id: run, p_bucket_id: SLED_BUCKET, p_object_path: files.sledClaim });
    expect(verify.data).toEqual({ ok: true });

    sql(`select private.cleanup_finish_run(${run});`);
    expect(claimStatus(files.sledClaim, SLED_BUCKET)).toBe("released");
    expect(claimStatus(files.reupload)).toBe("missing");
    // Released: the owner's existing overwrite permission is back. Gone: the path stays closed.
    expect(await tryUpload(owner.client, files.sledClaim, { bucket: SLED_BUCKET, upsert: true })).toBeNull();
    expect(await tryUpload(owner.client, files.reupload)).not.toBeNull();
  });

  it("a file the service role replaces after its claim is not removed (verification)", async () => {
    const run = sql(`select private.cleanup_begin_run('delete', 'manual');`);
    sql(`select private.cleanup_process_records(${run}); select private.cleanup_report_files(${run});`);
    const claim = await admin.rpc("cleanup_claim_file", { p_run_id: Number(run), p_bucket_id: BUCKET, p_object_path: files.changed });
    expect(claim.data).toMatchObject({ claimed: true });
    await upload(admin, files.changed, { upsert: true });
    const verify = await admin.rpc("cleanup_verify_claim", { p_run_id: Number(run), p_bucket_id: BUCKET, p_object_path: files.changed });
    expect(verify.data).toEqual({ ok: false, reason: "changed" });
    expect(claimStatus(files.changed)).toBe("released");
    sql(`select private.cleanup_finish_run(${run});`);
    expect(exists(files.changed)).toBe(true);
  });

  it("a delete run removes only the orphans, refuses an owner's last-moment overwrite, detects a service-role one, and survives a Storage failure", async () => {
    const ownerAttempts: (string | null)[] = [];
    const real = deps();
    const storage: CleanupStorage = {
      remove: async (bucket, paths) =>
        paths[0] === files.fail ? { data: null, error: { message: "Simulated Storage error" } } : real.storage.remove(bucket, paths),
    };
    const report = await runCleanup({
      db: real.db,
      storage,
      requestedMode: "delete",
      deadline: later(),
      // Someone tries to replace the file between the final check and the removal.
      beforeRemove: async (file) => {
        if (file.object_path === files.sledRace) {
          const error = await tryUpload(owner.client, files.sledRace, { bucket: SLED_BUCKET, upsert: true });
          ownerAttempts.push(error?.message ?? null);
        }
        // The service role bypasses storage policies (only the job and administrators hold it).
        if (file.object_path === files.race) await upload(admin, files.race, { upsert: true });
      },
    });
    expect(report).toMatchObject({ status: "completed", mode: "delete" });
    expect(report.removal).toMatchObject({ removed: 2, replaced: 1, failed: 1 });
    expect(ownerAttempts).toHaveLength(1);
    expect(ownerAttempts[0]).not.toBeNull();
    expect(claimStatus(files.sledRace, SLED_BUCKET)).toBe("deleted");
    expect(exists(files.sledRace, SLED_BUCKET)).toBe(false);

    expect(exists(files.mech)).toBe(false);
    expect(claimStatus(files.mech)).toBe("deleted");
    for (const key of ["active", "recoverable", "fresh", "changed", "fail"]) expect(exists(files[key])).toBe(true);
    expect(claimStatus(files.fail)).toBe("released");
    expect(claimStatus(files.race)).toBe("replaced");
    expect(sql(`select count(*) from private.cleanup_review where source = 'claim' and object_path = '${files.race}';`)).toBe("1");

    // No record can ever point at a removed path.
    for (const key of ["mech", "race"]) {
      const attach = await mechanic.client.from("suspension_photos").insert({ sled_id: sledId, revision_id: revisionId, path: files[key] });
      expect(attach.error?.message).toBe("This photo was removed. Add it again.");
    }
  });

  it("the next run retries the failed removal and repeats nothing else", async () => {
    const report = await runCleanup({ ...deps(), requestedMode: "delete", deadline: later() });
    expect(report.status).toBe("completed");
    expect(report.removal).toMatchObject({ removed: 1, replaced: 0, failed: 0 });
    expect(exists(files.fail)).toBe(false);
    for (const key of ["active", "recoverable", "fresh", "changed"]) expect(exists(files[key])).toBe(true);
  });

  it("retention removes old operational history; a removed path stays closed after its run is gone", async () => {
    // The mechanic's removed file now belongs to a delete run from 401 days ago.
    const old = sql(`insert into private.cleanup_runs (mode, source, status, started_at, finished_at)
                     values ('delete', 'manual', 'completed', now() - interval '401 days', now() - interval '401 days') returning id;`);
    sql(`insert into private.cleanup_candidates (run_id, kind, bucket_id, object_path, outcome) values (${old}, 'file', '${BUCKET}', '${files.mech}', 'deleted');
         update private.storage_cleanup_claims set run_id = ${old} where bucket_id = '${BUCKET}' and object_path = '${files.mech}';`);

    // Switched off: only a preview.
    const preview = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(preview.retention).toMatchObject({ enabled: false, qualifying: { runs: 1 }, removed: { runs: 0, details: 0 } });
    expect(sql(`select count(*) from private.cleanup_runs where id = ${old};`)).toBe("1");

    sql(`select private.authorize_retention_maintenance('integration test (throwaway stack)');`);
    const report = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(report.status).toBe("completed");
    expect(report.retention).toMatchObject({ enabled: true, removed: { runs: 1, details: 1 } });
    expect(sql(`select count(*) from private.cleanup_runs where id = ${old};`)).toBe("0");

    // The tombstone is still there, without its run, and still closes the path.
    expect(sql(`select coalesce(run_id::text, 'none') || '|' || status from private.storage_cleanup_claims where object_path = '${files.mech}';`))
      .toBe("none|deleted");
    expect(await tryUpload(owner.client, files.mech)).not.toBeNull();
    expect(exists(files.mech)).toBe(false);
    const attach = await mechanic.client.from("suspension_photos").insert({ sled_id: sledId, revision_id: revisionId, path: files.mech });
    expect(attach.error?.message).toBe("This photo was removed. Add it again.");
  });
});
