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
const exists = (path: string) => sql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${path}';`) === "1";
const claimStatus = (path: string) => sql(`select status from private.storage_cleanup_claims where bucket_id = '${BUCKET}' and object_path = '${path}';`);

/**
 * Makes files look uploaded two days ago. Storage resets updated_at on every
 * update, so each row is copied out, removed and put back with old
 * timestamps (the stored file itself is untouched).
 */
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
                     v_cols, '${BUCKET}', $q$${list(paths)}$q$);
      execute format('delete from storage.objects where bucket_id = %L and name = any(%s)', '${BUCKET}', $q$${list(paths)}$q$);
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

  async function upload(client: SupabaseClient, name: string, options: { upsert?: boolean } = {}) {
    const { error } = await client.storage.from(BUCKET).upload(name, jpeg(name), { contentType: "image/jpeg", ...options });
    if (error) throw new Error(`upload failed: ${error.message}`);
  }

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
    age([files.mech, files.active, files.recoverable, files.changed, files.race, files.fail]);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    sql(`select private.revoke_cleanup_deletion();
         select private.cleanup_finish_run(id) from private.cleanup_runs where status = 'running';
         delete from private.storage_cleanup_claims;
         delete from private.cleanup_runs;`);
    await admin.storage.from(BUCKET).remove(Object.values(files));
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
    for (const name of Object.values(files)) expect(exists(name)).toBe(true);
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
    for (const name of Object.values(files)) expect(exists(name)).toBe(true);
  });

  it("a duplicate invocation while a run is in progress is refused", async () => {
    const running = sql(`select private.cleanup_begin_run('report', 'manual');`);
    const report = await runCleanup({ ...deps(), requestedMode: "report", deadline: later() });
    expect(report.status).toBe("busy");
    sql(`select private.cleanup_finish_run(${running});`);
  });

  it("a file replaced at the same path after its claim is not removed", async () => {
    sql(`insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at)
         select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day', now(), now()
         from generate_series(1, 7) d;
         select private.authorize_cleanup_deletion('integration test (throwaway stack)');`);
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

  it("a delete run removes only the orphans, detects a replacement in the last moment, and survives a Storage failure", async () => {
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
      // Someone replaces the file between the final check and the removal.
      beforeRemove: async (file) => {
        if (file.object_path === files.race) await upload(admin, files.race, { upsert: true });
      },
    });
    expect(report).toMatchObject({ status: "completed", mode: "delete" });
    expect(report.removal).toMatchObject({ removed: 1, replaced: 1, failed: 1 });

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
});
