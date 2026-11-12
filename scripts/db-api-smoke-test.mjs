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
