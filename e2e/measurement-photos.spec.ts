import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, PHOTOS_URL, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Measurement photos (Migration 10): up to 2 per measurement per Trail configuration.
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2500)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const suspensionPage = (page: Page) => visible(page.getByTestId("suspension-page"));
const activeName = (page: Page) => suspensionPage(page).getByTestId("active-name");
const section = (page: Page, id: string) => suspensionPage(page).locator(`[data-section="${id}"]`);
const bar = (page: Page) => page.getByTestId("quick-tune-bar");
const config = (page: Page, n: number) =>
  suspensionPage(page).getByTestId("configuration-history").locator(`[data-testid="configuration"][data-number="${n}"]`);
const photoButton = (scope: Locator, name: string, trail: number) =>
  scope.getByRole("button", { name: new RegExp(`^Measurement photos of ${name.replace(/[()]/g, "\\$&")} on Trail ${trail},`) });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Measurement photos" });
const slots = (page: Page) => dialog(page).getByTestId("measurement-slot");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=", "base64");
const png = (name: string) => ({ name: `${name}.png`, mimeType: "image/png", buffer: PNG });

async function apiAs(email: string) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return client;
}

/** A sled with the suggested settings and Trail 1 (Track tension 1.25 in, a Liked evaluation). */
async function sledWithTrail1(page: Page, email: string) {
  await signUp(page, email);
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", nickname: "Blue" });
  await page.goto(`/garage/${sledId}/suspension?view=quick`);
  await suspensionPage(page).getByRole("button", { name: "Use suggested settings" }).click();
  await save(page, { "rear-general|Track tension": "1.25" });
  await expect(activeName(page)).toHaveText("Trail 1");
  await config(page, 1).getByRole("button", { name: "Add ride evaluation to Trail 1" }).click();
  const evaluation = page.getByRole("dialog", { name: "Ride evaluation" });
  await evaluation.getByText("Liked", { exact: true }).click();
  await evaluation.getByRole("button", { name: "Save evaluation" }).click();
  await expect(evaluation).toBeHidden({ timeout: 15_000 });
  return sledId;
}

async function save(page: Page, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const [sectionId, name] = key.split("|");
    await section(page, sectionId).getByRole("textbox", { name, exact: true }).fill(value);
  }
  await bar(page).getByRole("button", { name: "Save Adjustments" }).click();
  await expect(bar(page)).toBeHidden({ timeout: 15_000 });
}

async function choose(page: Page, slot: number, name: string, file = png(`photo-${slot}`)) {
  await dialog(page).getByLabel(`Choose photo ${slot} of ${name} (file)`).setInputFiles(file);
  await expect(dialog(page).getByText(/^Photo added to Trail \d+\.$/)).toBeVisible({ timeout: 20_000 });
}

/** Active measurement-photo paths of one Trail configuration, by slot. */
async function paths(email: string, sledId: string, trail: number) {
  const api = await apiAs(email);
  const { data: revision } = await api.from("suspension_revisions").select("id").eq("sled_id", sledId).eq("config_number", trail).single();
  const { data } = await api
    .from("sled_measurement_photos")
    .select("slot, path")
    .eq("revision_id", revision!.id)
    .is("deleted_at", null)
    .order("slot");
  return (data ?? []).map((r) => `${r.slot}:${r.path}`);
}

async function snapshot(email: string, sledId: string) {
  const api = await apiAs(email);
  const { data: revisions } = await api
    .from("suspension_revisions")
    .select("config_number, setting_values")
    .eq("sled_id", sledId)
    .order("config_number");
  const { count: evaluations } = await api.from("suspension_feedback").select("id", { count: "exact", head: true }).eq("sled_id", sledId);
  const { data: state } = await api.from("sled_suspension_state").select("active_revision_id").eq("sled_id", sledId).single();
  return { revisions, evaluations, active: state?.active_revision_id };
}

test.describe("with photo uploads turned on", () => {
  test.use({ baseURL: PHOTOS_URL });

  test("add, limit, view, replace and remove; older Trails; carry-forward; never a new Trail", async ({ page }) => {
    const email = uniqueEmail("mp-flow");
    const sledId = await sledWithTrail1(page, email);
    const before = await snapshot(email, sledId);
    const rearGeneral = section(page, "rear-general");

    // 1-3. One photo, a second, and no room for a third.
    await expect(photoButton(rearGeneral, "Track tension", 1)).toHaveText("0/2");
    await photoButton(rearGeneral, "Track tension", 1).click();
    await expect(dialog(page).getByTestId("measurement-trail")).toHaveText("Trail 1");
    await choose(page, 1, "Track tension");
    await expect(slots(page).nth(0)).toHaveAttribute("data-filled", "true");
    await choose(page, 2, "Track tension");
    await expect(slots(page).nth(1)).toHaveAttribute("data-filled", "true");
    await expect(dialog(page).getByRole("button", { name: /^(Take|Choose) photo/ })).toHaveCount(0);
    await expect(
      await new AxeBuilder({ page })
        .include("dialog[open]")
        .analyze()
        .then((r) => r.violations.map((v) => v.id)),
    ).toEqual([]);
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(photoButton(rearGeneral, "Track tension", 1)).toHaveText("2/2");
    const api = await apiAs(email);
    const { data: rev1 } = await api.from("suspension_revisions").select("id").eq("sled_id", sledId).eq("config_number", 1).single();
    const third = await api.rpc("add_suspension_measurement_photo", {
      p_revision_id: rev1!.id,
      p_setting_id: (await api.from("suspension_settings").select("id").eq("sled_id", sledId).eq("name", "Track tension").single()).data!
        .id,
      p_path: `${sledId}/${rev1!.id}/${crypto.randomUUID()}.jpg`,
    });
    expect(third.error?.message).toBe("At most 2 photos per measurement.");

    // View, enlarged.
    await photoButton(rearGeneral, "Track tension", 1).click();
    await dialog(page).getByRole("button", { name: "View photo 1 of Track tension on Trail 1" }).click();
    await expect(dialog(page).getByTestId("measurement-photo-viewer").getByRole("img")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Back to photos" }).click();

    // 4-5. Replace one, remove the other.
    const trail1Before = await paths(email, sledId, 1);
    await dialog(page).getByLabel("Replace photo 1 of Track tension (file)").setInputFiles(png("replacement"));
    await expect(dialog(page).getByText("Photo 1 replaced on Trail 1.")).toBeVisible({ timeout: 20_000 });
    const trail1Replaced = await paths(email, sledId, 1);
    expect(trail1Replaced[0]).not.toBe(trail1Before[0]);
    expect(trail1Replaced[1]).toBe(trail1Before[1]);
    page.once("dialog", (d) => void d.accept());
    await dialog(page).getByRole("button", { name: "Remove photo 2 of Track tension" }).click();
    await expect(dialog(page).getByText("Photo 2 removed from Trail 1.")).toBeVisible();
    await expect(slots(page).nth(1)).toHaveAttribute("data-filled", "false");
    await choose(page, 2, "Track tension");
    await dialog(page).getByRole("button", { name: "Close" }).click();

    // 7. A new Trail carries the photos forward (same files, its own rows).
    await save(page, { "rear-general|Track tension": "1.5" });
    await expect(activeName(page)).toHaveText("Trail 2");
    await expect(photoButton(rearGeneral, "Track tension", 2)).toHaveText("2/2");
    expect(await paths(email, sledId, 2)).toEqual(await paths(email, sledId, 1));

    // 8. Replacing in Trail 2 leaves Trail 1 alone.
    const trail1 = await paths(email, sledId, 1);
    await photoButton(rearGeneral, "Track tension", 2).click();
    await expect(dialog(page).getByTestId("measurement-trail")).toHaveText("Trail 2");
    await dialog(page).getByLabel("Replace photo 1 of Track tension (file)").setInputFiles(png("trail-2"));
    await expect(dialog(page).getByText("Photo 1 replaced on Trail 2.")).toBeVisible({ timeout: 20_000 });
    await dialog(page).getByRole("button", { name: "Close" }).click();
    const trail2 = await paths(email, sledId, 2);
    expect(trail2[0]).not.toBe(trail1[0]);
    expect(trail2[1]).toBe(trail1[1]);
    expect(await paths(email, sledId, 1)).toEqual(trail1);

    // 6. Photos on an older Trail from its View: Trail 2 isn't touched.
    await config(page, 1).getByRole("button", { name: "View Trail 1" }).click();
    const view = page.getByRole("dialog", { name: "Trail 1" });
    await photoButton(view, "Rebound", 1).first().click();
    await expect(dialog(page).getByTestId("measurement-trail")).toHaveText("Trail 1");
    await choose(page, 1, "Rebound");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    expect(await paths(email, sledId, 2)).toEqual(trail2);

    // 9-10. No configuration was created; values, evaluations and the active Trail are as saved.
    const after = await snapshot(email, sledId);
    expect(after.revisions).toHaveLength(2);
    expect(after.revisions![0]).toEqual(before.revisions![0]);
    expect(after.evaluations).toBe(before.evaluations);
    await expect(activeName(page)).toHaveText("Trail 2");
    await expect(config(page, 1).getByTestId("evaluation")).toHaveCount(1);
  });

  test("photo changes never trigger the unsaved-adjustments warning or touch pending values", async ({ page }) => {
    await sledWithTrail1(page, uniqueEmail("mp-dirty"));
    const prompts: string[] = [];
    page.on("dialog", (d) => {
      prompts.push(d.message());
      void d.accept();
    });
    await section(page, "rear-general").getByRole("textbox", { name: "Track tension", exact: true }).fill("2");
    await expect(bar(page).getByTestId("change-count")).toHaveText("1 change");
    await photoButton(section(page, "rear-general"), "Track tension", 1).click();
    await choose(page, 1, "Track tension");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(bar(page).getByTestId("change-count")).toHaveText("1 change");
    await expect(section(page, "rear-general").getByRole("textbox", { name: "Track tension", exact: true })).toHaveValue("2");
    expect(prompts).toEqual([]);
    await expect(activeName(page)).toHaveText("Trail 1");
  });

  test("roles: mechanics add; only owners and editors replace and remove; others can't reach the photos", async ({ page, browser }) => {
    const ownerEmail = uniqueEmail("mp-r-o");
    const mechanicEmail = uniqueEmail("mp-r-m");
    const strangerEmail = uniqueEmail("mp-r-x");
    const sledId = await sledWithTrail1(page, ownerEmail);
    await photoButton(section(page, "rear-general"), "Track tension", 1).click();
    await choose(page, 1, "Track tension");
    await dialog(page).getByRole("button", { name: "Close" }).click();

    const contexts = await Promise.all([1, 2].map(() => browser.newContext({ baseURL: PHOTOS_URL })));
    const [mechanic, stranger] = await Promise.all(contexts.map((c) => c.newPage()));
    await signUp(mechanic, mechanicEmail);
    await signUp(stranger, strangerEmail);
    await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");

    await mechanic.goto(`/garage/${sledId}/suspension?view=quick`);
    await photoButton(section(mechanic, "rear-general"), "Track tension", 1).click();
    await expect(dialog(mechanic).getByRole("button", { name: /^(Replace|Remove) photo/ })).toHaveCount(0);
    await choose(mechanic, 2, "Track tension");

    // 11. Someone without access: no rows, no files.
    const [path] = await paths(ownerEmail, sledId, 1);
    const api = await apiAs(strangerEmail);
    expect((await api.from("sled_measurement_photos").select("id").eq("sled_id", sledId)).data ?? []).toHaveLength(0);
    const download = await api.storage.from("suspension-photos").download(path.slice(2));
    expect(download.error).not.toBeNull();
    expect((await api.storage.from("suspension-photos").createSignedUrl(path.slice(2), 60)).error).not.toBeNull();
    await stranger.goto(`/garage/${sledId}/suspension`);
    await expect(stranger.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();
    await Promise.all(contexts.map((c) => c.close()));
  });
});

test("with photo uploads off: existing measurement photos are shown, but none can be added or replaced", async ({ page }) => {
  const email = uniqueEmail("mp-off");
  const sledId = await sledWithTrail1(page, email);
  // Uploads off (this server): nothing to add, so no camera on empty measurements.
  await expect(section(page, "rear-general").getByTestId("measurement-photo-button")).toHaveCount(0);

  // A photo added while uploads were on (the second test server).
  await page.goto(`${PHOTOS_URL}/garage/${sledId}/suspension?view=quick`);
  await photoButton(section(page, "rear-general"), "Track tension", 1).click();
  await choose(page, 1, "Track tension");

  await page.goto(`/garage/${sledId}/suspension?view=quick`);
  await photoButton(section(page, "rear-general"), "Track tension", 1).click();
  await expect(slots(page).nth(0)).toHaveAttribute("data-filled", "true");
  await expect(dialog(page).getByRole("button", { name: /^(Take|Choose|Replace) photo/ })).toHaveCount(0);
  await expect(dialog(page).locator('input[type="file"]')).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Remove photo 1 of Track tension" })).toBeVisible();
});
