// End-to-end check of the database foundation through the real Supabase Auth
// and REST API, using the same client library as the app.
//
// Runs against a LOCAL Supabase stack only (npx supabase start). Requires:
//   SUPABASE_URL       e.g. http://127.0.0.1:54321
//   SUPABASE_ANON_KEY  the local stack's anon/publishable key
//
// Never point this at the live project: it creates test accounts.

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required.");
  process.exit(1);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error("Refusing to run: SUPABASE_URL must be a local Supabase stack.");
  process.exit(1);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const run = Date.now();
let failures = 0;

function check(condition, description, detail) {
  if (condition) {
    console.log(`ok - ${description}`);
  } else {
    failures += 1;
    console.log(`not ok - ${description}`);
    if (detail !== undefined) console.log(`  ${JSON.stringify(detail)}`);
  }
}

async function signUp(name) {
  const client = createClient(url, key, options);
  const email = `smoke-${name}-${run}@example.com`;
  const { data, error } = await client.auth.signUp({
    email,
    password: `Smoke-test-${run}!`,
    options: { data: { display_name: name } },
  });
  if (error || !data.session) {
    throw new Error(`Sign-up failed for ${name}: ${error?.message ?? "no session"}`);
  }
  return { client, email, id: data.user.id };
}

const alex = await signUp("alex");
const blake = await signUp("blake");
const anon = createClient(url, key, options);

// Sign-up trigger
{
  const { data, error } = await alex.client.from("garages").select("id, is_default");
  check(!error && data.length === 1 && data[0].is_default, "sign-up creates a default garage", error ?? data);
  const profile = await alex.client.from("profiles").select("display_name").eq("id", alex.id).single();
  check(profile.data?.display_name === "alex", "sign-up creates a profile with the display name", profile);
}

// Owner creates a sled
const garageId = (await alex.client.from("garages").select("id").single()).data.id;
const created = await alex.client
  .from("sleds")
  .insert({ garage_id: garageId, model_year: 2024, make: "Polaris", model: "RMK" })
  .select("id, owner_id, version")
  .single();
check(!created.error && created.data.owner_id === alex.id, "owner can add a sled through the API", created.error);
const sledId = created.data.id;

// Isolation
{
  const { data } = await blake.client.from("sleds").select("id");
  check(data?.length === 0, "another user cannot see the sled");
  const { error } = await anon.from("sleds").select("id");
  check(Boolean(error), "anonymous requests are refused", error);
}

// Sharing
const invite = await alex.client.rpc("create_sled_invitation", {
  p_sled_id: sledId,
  p_email: blake.email,
  p_role: "viewer",
});
check(!invite.error && invite.data?.[0]?.token, "owner can create an invitation", invite.error);

{
  const forged = await blake.client.from("sled_shares").insert({ sled_id: sledId, user_id: blake.id, role: "editor" });
  check(Boolean(forged.error), "a user cannot grant themselves access", forged.error);
}

const accepted = await blake.client.rpc("accept_sled_invitation", { p_token: invite.data[0].token });
check(accepted.data === sledId, "the invited user can accept", accepted.error);

{
  const { data } = await blake.client.from("sleds").select("id");
  check(data?.length === 1 && data[0].id === sledId, "the viewer sees the shared sled");
  const { data: garages } = await blake.client.from("garages").select("id").eq("id", garageId);
  check(garages?.length === 0, "the viewer cannot see the owner's garage");
  const edit = await blake.client.from("sleds").update({ nickname: "hijack" }).eq("id", sledId).select();
  check(edit.data?.length === 0, "the viewer cannot edit the sled", edit);
  const reshare = await blake.client.rpc("create_sled_invitation", {
    p_sled_id: sledId,
    p_email: `other-${run}@example.com`,
    p_role: "editor",
  });
  check(Boolean(reshare.error), "the viewer cannot share the sled", reshare.error);
  const audit = await blake.client.from("audit_log").select("id").eq("sled_id", sledId);
  check(audit.data?.length === 0, "the viewer cannot read the owner's audit history", audit);
}

// Offline conflict detection
{
  const stale = await alex.client
    .from("sleds")
    .update({ nickname: "from an old copy", version: created.data.version - 1 })
    .eq("id", sledId);
  check(stale.error?.code === "PT409", "an out-of-date update is rejected with a conflict error", stale.error);
  const current = await alex.client
    .from("sleds")
    .update({ nickname: "Blue", version: created.data.version })
    .eq("id", sledId)
    .select("version")
    .single();
  check(current.data?.version === created.data.version + 1, "an up-to-date update succeeds", current.error);
}

// Recently Deleted suspends sharing; restoring does not reactivate it
{
  const versionOf = async () =>
    (await alex.client.from("sleds").select("version").eq("id", sledId).single()).data.version;

  const deleted = await alex.client
    .from("sleds")
    .update({ deleted_at: new Date().toISOString(), version: await versionOf() })
    .eq("id", sledId);
  check(!deleted.error, "owner can move the sled to Recently Deleted", deleted.error);
  check((await blake.client.from("sleds").select("id")).data?.length === 0,
    "shared access is suspended immediately");

  const restored = await alex.client
    .from("sleds")
    .update({ deleted_at: null, version: await versionOf() })
    .eq("id", sledId);
  check(!restored.error, "owner can restore the sled", restored.error);
  check((await blake.client.from("sleds").select("id")).data?.length === 0,
    "restoring does not reactivate shared access");

  const own = await blake.client.from("sled_shares").select("id, suspended_at").eq("sled_id", sledId).single();
  check(Boolean(own.data?.suspended_at), "the shared user can see their access is suspended", own);
  const selfReactivate = await blake.client.rpc("reactivate_sled_share", { p_share_id: own.data?.id });
  check(Boolean(selfReactivate.error), "a shared user cannot reactivate their own access", selfReactivate.error);

  const reactivated = await alex.client.rpc("reactivate_sled_share", { p_share_id: own.data?.id });
  check(!reactivated.error, "the owner can reactivate access", reactivated.error);
  check((await blake.client.from("sleds").select("id")).data?.length === 1,
    "reactivated access works again");
}

// Maintenance logbook (Migration 2), with the viewer's access active again
{
  const task = await alex.client.from("maintenance_tasks").insert({ name: "Chaincase oil" }).select("id").single();
  check(!task.error, "owner can add a task to their library", task.error);
  const secret = await alex.client.from("maintenance_tasks").insert({ name: "Private task" }).select("id").single();

  const plan = await alex.client
    .from("maintenance_plans")
    .insert({ sled_id: sledId, task_id: task.data?.id, interval_mi: 500, interval_hours: 25, interval_days: 365 })
    .select("id")
    .single();
  check(!plan.error, "owner can schedule by miles, engine hours and days", plan.error);

  const reading = await alex.client
    .from("sled_readings")
    .insert({ sled_id: sledId, read_on: "2026-07-01", odometer_mi: 1000, engine_hours: 40 })
    .select("id")
    .single();
  check(!reading.error, "owner can record mileage and engine hours", reading.error);

  const entry = await alex.client
    .from("maintenance_entries")
    .insert({ sled_id: sledId, performed_on: "2026-07-01", title: "Chaincase service", labor_cost: 40, reading_id: reading.data?.id })
    .select("id, version")
    .single();
  check(!entry.error, "owner can log maintenance", entry.error);
  const entryTask = await alex.client
    .from("maintenance_entry_tasks")
    .insert({ entry_id: entry.data?.id, task_id: task.data?.id })
    .select("task_name")
    .single();
  check(entryTask.data?.task_name === "Chaincase oil", "logged tasks keep the task name", entryTask.error);
  const part = await alex.client
    .from("maintenance_entry_parts")
    .insert({ entry_id: entry.data?.id, name: "Chaincase oil 12 oz", quantity: 2, unit_cost: 10 });
  check(!part.error, "owner can record parts used", part.error);
  const cost = await alex.client.from("maintenance_entry_costs").select("total_cost").eq("entry_id", entry.data?.id).single();
  check(Number(cost.data?.total_cost) === 60, "entry cost totals labor and parts", cost);

  const stale = await alex.client
    .from("maintenance_entries")
    .update({ title: "From an old copy", version: entry.data.version - 1 })
    .eq("id", entry.data?.id);
  check(stale.error?.code === "PT409", "an out-of-date entry update is rejected", stale.error);

  const seen = await blake.client.from("maintenance_tasks").select("id");
  const ids = (seen.data ?? []).map((row) => row.id);
  check(ids.includes(task.data?.id) && !ids.includes(secret.data?.id),
    "shared users see only tasks used on the shared sled", seen);
  const viewerEntry = await blake.client
    .from("maintenance_entries")
    .insert({ sled_id: sledId, performed_on: "2026-07-02", title: "Viewer entry" });
  check(Boolean(viewerEntry.error), "viewers cannot log maintenance", viewerEntry.error);

  const removed = await alex.client
    .from("maintenance_entries")
    .update({ deleted_at: new Date().toISOString(), version: entry.data.version })
    .eq("id", entry.data?.id);
  check(!removed.error, "owner can move an entry to Recently Deleted", removed.error);
  const kept = await alex.client.from("sled_reading_history").select("id, total_mi").eq("id", reading.data?.id);
  check(kept.data?.length === 1 && Number(kept.data[0].total_mi) === 1000,
    "deleting the entry keeps its mileage reading", kept);
}

// Atomic, duplicate-safe saving (save_maintenance_entry)
{
  const key = crypto.randomUUID();
  const args = {
    p_idempotency_key: key,
    p_sled_id: sledId,
    p_performed_on: "2026-08-01",
    p_title: "Track and clutch service",
    p_labor_cost: 25,
    p_reading: { odometer_mi: 1100, engine_hours: 45 },
    p_tasks: [{ task_name: "Cleaned clutch" }],
    p_parts: [{ name: "Clutch cleaner", quantity: 1, unit_cost: 9.5 }],
  };
  const first = await alex.client.rpc("save_maintenance_entry", args);
  check(!first.error && first.data?.duplicate === false && first.data?.entry_id,
    "a complete entry saves in one call", first.error ?? first.data);
  const again = await alex.client.rpc("save_maintenance_entry", args);
  check(again.data?.duplicate === true && again.data?.entry_id === first.data?.entry_id,
    "resubmitting the same request returns the saved entry", again.error ?? again.data);
  const entries = await alex.client.from("maintenance_entries").select("id").eq("client_request_id", key);
  check(entries.data?.length === 1, "duplicate submissions create no duplicate entries", entries);

  const readingsBefore = await alex.client.from("sled_readings").select("id").eq("sled_id", sledId);
  const failed = await alex.client.rpc("save_maintenance_entry", {
    ...args,
    p_idempotency_key: crypto.randomUUID(),
    p_reading: { odometer_mi: 1200 },
    p_parts: [{ name: "Bad part", quantity: 0 }],
  });
  const readingsAfter = await alex.client.from("sled_readings").select("id").eq("sled_id", sledId);
  check(Boolean(failed.error) && readingsAfter.data?.length === readingsBefore.data?.length,
    "a failed save leaves nothing behind", failed.error);

  const viewerSave = await blake.client.rpc("save_maintenance_entry", {
    p_idempotency_key: crypto.randomUUID(),
    p_sled_id: sledId,
    p_performed_on: "2026-08-02",
    p_title: "Viewer attempt",
  });
  check(Boolean(viewerSave.error), "viewers cannot save entries through the function", viewerSave.error);
}

// Revocation
{
  const share = await alex.client.from("sled_shares").select("id").eq("sled_id", sledId).single();
  const revoked = await alex.client.rpc("revoke_sled_share", { p_share_id: share.data.id });
  check(!revoked.error, "owner can revoke access", revoked.error);
  const { data } = await blake.client.from("sleds").select("id");
  check(data?.length === 0, "revoked access takes effect immediately");
}

// Audit
{
  const { data } = await alex.client.from("audit_log").select("table_name").eq("sled_id", sledId);
  check(data?.some((row) => row.table_name === "sled_shares"), "the owner can read the sled's audit history");
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
