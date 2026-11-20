import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, PHOTOS_URL, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Phase 6.2: Suspension Quick Tune (Migrations 7 and 9). Needs the local Supabase stack.
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
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

const suspensionPage = (page: Page) => visible(page.getByTestId("suspension-page"));
const activeName = (page: Page) => suspensionPage(page).getByTestId("active-name");
const activeEquipment = (page: Page) => suspensionPage(page).getByTestId("active-equipment").getByTestId("equipment");
const notice = (page: Page) => suspensionPage(page).getByTestId("suspension-notice");
const section = (page: Page, id: string) => suspensionPage(page).locator(`[data-section="${id}"]`);
const tuneInput = (page: Page, sectionId: string, name: string) => section(page, sectionId).getByRole("textbox", { name, exact: true });
const bar = (page: Page) => page.getByTestId("quick-tune-bar");
const config = (page: Page, n: number) =>
  suspensionPage(page).getByTestId("configuration-history").locator(`[data-testid="configuration"][data-number="${n}"]`);
const configs = (page: Page) => suspensionPage(page).getByTestId("configuration-history").getByTestId("configuration");

const FRONT = "front-ski-shocks";
const BOTH = "Compression (Both ski shocks)";

async function openSuspension(page: Page, sledId: string, view?: "quick" | "map") {
  await page.goto(`/garage/${sledId}/suspension${view ? `?view=${view}` : ""}`);
  await expect(suspensionPage(page).getByRole("heading", { name: "Suspension", exact: true })).toBeVisible();
}

/** A new sled with the suggested settings list, on its Quick Tune page. */
async function sledWithTemplate(page: Page, email: string, nickname = "Blue") {
  await signUp(page, email);
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname });
  await openSuspension(page, sledId);
  await suspensionPage(page).getByRole("button", { name: "Use suggested settings" }).click();
  await expect(tuneInput(page, FRONT, BOTH)).toBeVisible({ timeout: 15_000 });
  return sledId;
}

/** Type values into Quick Tune ({ "<section>|<name>": "value" }) and save them as the next configuration. */
async function tune(page: Page, values: Record<string, string>, note?: string) {
  for (const [key, value] of Object.entries(values)) {
    const [sectionId, name] = key.split("|");
    await tuneInput(page, sectionId, name).fill(value);
  }
  if (note) await bar(page).getByRole("textbox", { name: "Notes (optional)" }).fill(note);
  await bar(page).getByRole("button", { name: "Save Adjustments" }).click();
  await expect(bar(page)).toBeHidden({ timeout: 15_000 });
}

async function changeEquipment(page: Page, scope: Locator, buttonName: string, ski: "C&A Pro XPT" | "C&A Pro XCS", carbide: string) {
  await scope.getByRole("button", { name: buttonName }).click();
  const dialog = page.getByRole("dialog", { name: "Skis & carbides" });
  await dialog.getByText(ski, { exact: true }).click();
  await dialog.getByText(carbide, { exact: true }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByTestId("equipment-confirm")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm change" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function evaluate(page: Page, n: number, ride: { rating: string; conditions?: string[]; temp?: string; note?: string }) {
  await config(page, n)
    .getByRole("button", { name: `Add ride evaluation to Trail ${n}` })
    .click();
  const dialog = page.getByRole("dialog", { name: "Ride evaluation" });
  await dialog.getByText(ride.rating, { exact: true }).click();
  for (const c of ride.conditions ?? []) await dialog.getByText(c, { exact: true }).click();
  if (ride.temp) await label(dialog, "Day's high °F (optional)").fill(ride.temp);
  if (ride.note) await label(dialog, "Ride notes (optional)").fill(ride.note);
  await dialog.getByRole("button", { name: "Save evaluation" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** A signed-in API client (for checking what is stored). */
async function apiAs(email: string) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return client;
}

async function configCount(email: string, sledId: string) {
  const api = await apiAs(email);
  const { count } = await api.from("suspension_revisions").select("id", { count: "exact", head: true }).eq("sled_id", sledId);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Quick Tune
// ---------------------------------------------------------------------------
test("first visit: suggested settings or blank; Quick Tune is the default and the chosen view is remembered", async ({ page }) => {
  await signUp(page, uniqueEmail("qt-first"));
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2024", odometer: "100", nickname: "Summit" });
  await openSuspension(page, sledId);
  await expect(activeName(page)).toHaveText("None yet");
  await expect(suspensionPage(page).getByTestId("quick-tune")).toBeVisible();
  await expect(suspensionPage(page).getByRole("button", { name: "Quick Tune" })).toHaveAttribute("aria-pressed", "true");
  // All five zones on one page.
  await expect(suspensionPage(page).getByTestId("quick-tune-section").getByRole("heading")).toHaveText([
    /Front Ski Shocks/,
    /Front Track Shock/,
    /Rear Track Shock/,
    /Springs & Limiter Strap/,
    /Rear General/,
  ]);

  // Start blank: the settings list opens with Add setting.
  await suspensionPage(page).getByRole("button", { name: "Start blank" }).click();
  const add = page.getByRole("dialog", { name: "Add setting" });
  await expect(add).toBeVisible();
  await add.getByRole("button", { name: "Close" }).click();

  // One suggested template, then customized: rename and change the unit.
  await suspensionPage(page)
    .getByText(/What's in the suggested list/)
    .click();
  await expect(suspensionPage(page).getByTestId("template-preview")).toContainText("Compression (clicks)");
  await suspensionPage(page).getByRole("button", { name: "Use suggested settings" }).click();
  await expect(tuneInput(page, FRONT, BOTH)).toBeVisible({ timeout: 15_000 });
  await expect(suspensionPage(page).getByTestId("getting-started")).toHaveCount(0);
  await expect(section(page, "springs-limiter").getByTestId("qt-name")).toHaveText(["Limiter strap", "Torsion spring position"]);
  const editor = suspensionPage(page).getByTestId("settings-editor");
  if (!(await editor.isVisible())) await suspensionPage(page).locator("summary", { hasText: "Customize settings" }).click();
  await editor.getByRole("button", { name: "Edit Track tension" }).click();
  const edit = page.getByRole("dialog", { name: "Edit setting" });
  await label(edit, "Setting name").fill("Track tension (sag)");
  await label(edit, "Unit (optional)").fill("mm");
  await edit.getByRole("button", { name: "Save setting" }).click();
  await expect(edit).toBeHidden({ timeout: 15_000 });
  await expect(section(page, "rear-general").getByTestId("qt-name")).toHaveText(["Track tension (sag)"]);

  // The map is the other view; the choice is remembered.
  await suspensionPage(page).getByRole("button", { name: "Suspension Map" }).click();
  await expect(suspensionPage(page).getByTestId("suspension-map")).toBeVisible();
  await page.reload();
  await expect(suspensionPage(page).getByTestId("suspension-map")).toBeVisible();
  await suspensionPage(page).getByRole("button", { name: "Quick Tune" }).click();
  await page.reload();
  await expect(suspensionPage(page).getByTestId("quick-tune")).toBeVisible();
});

test("Quick Tune: several changes save together as Trail 1, Trail 2, ...; saved value and difference; discard; left and right", async ({
  page,
}) => {
  const email = uniqueEmail("qt-batch");
  const sledId = await sledWithTemplate(page, email);

  // Trail 1: several values at once (the pair sets both ski shocks).
  await tuneInput(page, FRONT, BOTH).fill("10");
  await tuneInput(page, "springs-limiter", "Limiter strap").fill("3");
  await expect(bar(page).getByTestId("change-count")).toHaveText("3 changes");
  await bar(page).getByRole("button", { name: "Save Adjustments" }).click();
  await expect(bar(page)).toBeHidden({ timeout: 15_000 });
  await expect(notice(page)).toContainText("Saved as Trail 1. It's the active configuration now.");
  await expect(activeName(page)).toHaveText("Trail 1");

  // Large + / −: the saved value and the difference show next to the change.
  const increase = section(page, FRONT).getByRole("button", { name: `Increase ${BOTH}` });
  await increase.click();
  await increase.click();
  await expect(tuneInput(page, FRONT, BOTH)).toHaveValue("12");
  await expect(section(page, FRONT).getByTestId("qt-change").first()).toHaveText("Was 10 clicks · +2");
  await section(page, "springs-limiter").getByRole("button", { name: "Decrease Limiter strap" }).click();
  await expect(bar(page).getByTestId("change-count")).toHaveText("3 changes");

  // Discard: back to Trail 1's values; nothing saved.
  await bar(page).getByRole("button", { name: "Discard Changes" }).click();
  await expect(bar(page)).toBeHidden();
  await expect(tuneInput(page, FRONT, BOTH)).toHaveValue("10");
  expect(await configCount(email, sledId)).toBe(1);

  // Typing the saved value again isn't a change.
  await tuneInput(page, "springs-limiter", "Limiter strap").fill("3.0");
  await expect(bar(page)).toBeHidden();

  // Trail 2, with a note; Trail 1 is kept as it was.
  await increase.click();
  await increase.click();
  await tune(page, { "rear-track-shock|Rebound": "6" }, "Softer front");
  await expect(activeName(page)).toHaveText("Trail 2");
  await expect(config(page, 2).getByTestId("configuration-changes")).toContainText("Trail 1 → Trail 2");
  await expect(config(page, 2).getByTestId("configuration-changes")).toContainText("Compression: 10 → 12 clicks (+2)");
  await expect(config(page, 2).getByTestId("configuration-changes")).toContainText("Rebound: set to 6 clicks");
  await expect(config(page, 2).getByTestId("configuration-note")).toHaveText("Softer front");
  await expect(config(page, 2)).toHaveAttribute("data-active", "true");
  await expect(config(page, 1)).toHaveAttribute("data-active", "false");
  await config(page, 1).getByRole("button", { name: "View Trail 1" }).click();
  const view = page.getByRole("dialog", { name: "Trail 1" });
  await expect(view.getByTestId("detail-value").filter({ hasText: "Compression (Left)" })).toContainText("10 clicks");
  await view.getByRole("button", { name: "Close" }).click();

  // Left and right separately when needed.
  await section(page, FRONT).getByRole("button", { name: "Adjust Rebound left and right separately" }).click();
  await tuneInput(page, FRONT, "Rebound (Left)").fill("7");
  await tuneInput(page, FRONT, "Rebound (Right)").fill("8");
  await tune(page, {});
  await expect(activeName(page)).toHaveText("Trail 3");
  await expect(section(page, FRONT).locator('[data-pair][data-separate="true"]')).toHaveCount(1);
  await expect(tuneInput(page, FRONT, "Rebound (Right)")).toHaveValue("8");
  expect(await configCount(email, sledId)).toBe(3);

  // Measurements are typed (no + / −); invalid numbers can't be saved.
  await expect(section(page, "rear-general").getByRole("button", { name: /Increase|Decrease/ })).toHaveCount(0);
  await tuneInput(page, "rear-general", "Track tension").fill("1-2");
  await expect(bar(page).getByRole("button", { name: "Save Adjustments" })).toBeDisabled();
  await tuneInput(page, "rear-general", "Track tension").fill("1.25");
  await tune(page, {});
  await expect(activeName(page)).toHaveText("Trail 4");
});

test("skis and carbides: changed from the snowmobile page or Quick Tune, shown the same on both, kept per configuration", async ({
  page,
}) => {
  const email = uniqueEmail("qt-ski");
  const sledId = await sledWithTemplate(page, email);
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });

  // Snowmobile page: Active Ski Configuration, with confirmation before the change.
  await page.goto(`/garage/${sledId}`);
  const summary = visible(page.locator("#suspension")).getByTestId("suspension-summary");
  await expect(summary.getByTestId("ski-configuration")).toContainText("Not recorded");
  await summary.getByRole("button", { name: "Change skis or carbides on Blue" }).click();
  const dialog = page.getByRole("dialog", { name: "Skis & carbides" });
  await dialog.getByText("C&A Pro XPT", { exact: true }).click();
  await dialog.getByText('6"', { exact: true }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByTestId("equipment-confirm")).toContainText("Trail 1 is kept as it is.");
  await dialog.getByRole("button", { name: "Back" }).click(); // nothing changes until confirmed
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Confirm change" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(summary).toContainText("Skis and carbides saved as Trail 2.");
  await expect(summary.getByTestId("ski-configuration")).toContainText('C&A Pro XPT · 6" carbides');
  await expect(summary.getByTestId("suspension-active")).toHaveText("Trail 2 · Active");

  // Garage Board shows the same record.
  await page.goto("/garage/board");
  const card = visible(page.getByTestId("garage-board")).getByRole("article", { name: "Blue", exact: true });
  await expect(card.getByTestId("ski-configuration")).toContainText('C&A Pro XPT · 6" carbides');

  // Quick Tune shows it too, and changes it.
  await openSuspension(page, sledId);
  await expect(activeEquipment(page)).toHaveText('C&A Pro XPT · 6" carbides');
  await changeEquipment(page, suspensionPage(page), "Change skis or carbides", "C&A Pro XCS", '7.5"');
  await expect(activeName(page)).toHaveText("Trail 3");
  await expect(activeEquipment(page)).toHaveText('C&A Pro XCS · 7.5" carbides');
  await expect(config(page, 3).getByTestId("configuration-changes")).toContainText("Skis: XPT → XCS");
  await expect(config(page, 3).getByTestId("configuration-changes")).toContainText('Carbides: 6" → 7.5"');
  // Every suspension value was copied; history keeps each configuration's equipment.
  await expect(tuneInput(page, FRONT, BOTH)).toHaveValue("10");
  await expect(config(page, 2).getByTestId("equipment")).toHaveText('C&A Pro XPT · 6" carbides');
  await expect(config(page, 1).getByTestId("equipment")).toHaveText("Not recorded");

  await page.goto(`/garage/${sledId}`);
  await expect(summary.getByTestId("ski-configuration")).toContainText('C&A Pro XCS · 7.5" carbides');
});

test("activating older configurations: viewing never activates; other equipment must be confirmed; cancel changes nothing", async ({
  page,
}) => {
  const email = uniqueEmail("qt-act");
  const sledId = await sledWithTemplate(page, email);
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" }); // Trail 1 (no equipment recorded)
  await changeEquipment(page, suspensionPage(page), "Change skis or carbides", "C&A Pro XPT", '6"'); // Trail 2
  await tune(page, { [`${FRONT}|${BOTH}`]: "12" }); // Trail 3, XPT 6"
  await changeEquipment(page, suspensionPage(page), "Change skis or carbides", "C&A Pro XCS", '7.5"'); // Trail 4
  await expect(activeName(page)).toHaveText("Trail 4");
  expect(await configCount(email, sledId)).toBe(4);

  // Viewing an older configuration doesn't activate it.
  await config(page, 3).getByRole("button", { name: "View Trail 3" }).click();
  await page.getByRole("dialog", { name: "Trail 3" }).getByRole("button", { name: "Close" }).click();
  await expect(activeName(page)).toHaveText("Trail 4");

  // Other skis and carbides: both shown; confirmation required; Cancel changes nothing.
  await config(page, 3).getByRole("button", { name: "Make Trail 3 active" }).click();
  let dialog = page.getByRole("dialog", { name: "Make active" });
  await expect(dialog.getByTestId("required-equipment")).toHaveText('C&A Pro XPT · 6" carbides');
  await expect(dialog.getByTestId("installed-equipment")).toHaveText('C&A Pro XCS · 7.5" carbides');
  await expect(dialog.getByRole("button", { name: "Activate Trail 3" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(activeName(page)).toHaveText("Trail 4");
  await expect(activeEquipment(page)).toHaveText('C&A Pro XCS · 7.5" carbides');

  await config(page, 3).getByRole("button", { name: "Make Trail 3 active" }).click();
  dialog = page.getByRole("dialog", { name: "Make active" });
  await expect(dialog.getByTestId("activate-changes")).toContainText("Skis: XCS → XPT");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Activate Trail 3" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(activeName(page)).toHaveText("Trail 3");
  await expect(activeEquipment(page)).toHaveText('C&A Pro XPT · 6" carbides');
  await expect(tuneInput(page, FRONT, BOTH)).toHaveValue("12");

  // Same equipment: no confirmation needed. Nothing new is created by activating.
  await config(page, 2).getByRole("button", { name: "Make Trail 2 active" }).click();
  dialog = page.getByRole("dialog", { name: "Make active" });
  await expect(dialog.getByTestId("equipment-mismatch")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Activate Trail 2" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(activeName(page)).toHaveText("Trail 2");
  expect(await configCount(email, sledId)).toBe(4);

  // The next save is Trail 5, made from Trail 2; nothing older is overwritten.
  await tune(page, { "springs-limiter|Limiter strap": "4" });
  await expect(activeName(page)).toHaveText("Trail 5");
  await expect(config(page, 5).getByTestId("configuration-changes")).toContainText("Trail 2 → Trail 5");
  await expect(configs(page)).toHaveCount(5);
  await expect(config(page, 3).getByTestId("equipment")).toHaveText('C&A Pro XPT · 6" carbides');
  await expect(config(page, 4).getByTestId("equipment")).toHaveText('C&A Pro XCS · 7.5" carbides');
});

test("ride evaluations: several per configuration with conditions and temperature; Disliked warnings never block", async ({ page }) => {
  const email = uniqueEmail("qt-eval");
  const sledId = await sledWithTemplate(page, email);
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" }); // Trail 1
  await evaluate(page, 1, { rating: "Disliked", conditions: ["Loose Snow", "Sloppy"], temp: "28", note: "Pushy in the ruts" });
  await evaluate(page, 1, { rating: "Liked", conditions: ["Hard Pack"] });
  await evaluate(page, 1, { rating: "Neutral / needs more testing" });
  expect(await configCount(email, sledId)).toBe(1); // evaluations never create a configuration

  const list = config(page, 1).getByTestId("evaluation");
  await expect(list).toHaveCount(3);
  const disliked = list.filter({ has: page.locator('[data-rating="disliked"]') });
  await expect(disliked.getByTestId("conditions").getByRole("listitem")).toHaveText(["Loose Snow", "Sloppy"]);
  await expect(disliked.getByTestId("evaluation-temp")).toHaveText("High 28 °F");
  await expect(disliked.getByTestId("evaluation-note")).toHaveText("Pushy in the ruts");
  await expect(list.filter({ has: page.locator('[data-rating="neutral"]') }).getByTestId("evaluation-temp")).toHaveCount(0);

  // Editing keeps it on Trail 1.
  await disliked.getByRole("button", { name: /Edit evaluation/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit ride evaluation" });
  await edit.getByText("Fresh Snow", { exact: true }).click();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden({ timeout: 15_000 });
  await expect(disliked.getByTestId("conditions").getByRole("listitem")).toHaveText(["Loose Snow", "Sloppy", "Fresh Snow"]);

  // Trail 2, then recreating Trail 1's values warns (with the conditions), but saves.
  await tune(page, { [`${FRONT}|${BOTH}`]: "12" });
  await tuneInput(page, FRONT, BOTH).fill("10");
  await expect(bar(page).getByTestId("dislike-warning")).toContainText(
    "This suspension configuration was previously rated Disliked under Loose Snow, Sloppy and Fresh Snow conditions. It was rated Liked under Hard Pack too.",
  );
  await expect(bar(page).getByRole("button", { name: "Save Adjustments" })).toBeEnabled();
  await bar(page).getByRole("button", { name: "Discard Changes" }).click();

  // Reactivating it warns too; still allowed.
  await config(page, 1).getByRole("button", { name: "Make Trail 1 active" }).click();
  const dialog = page.getByRole("dialog", { name: "Make active" });
  await expect(dialog.getByTestId("dislike-warning")).toContainText("previously rated Disliked under Loose Snow");
  await dialog.getByRole("button", { name: "Activate Trail 1" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(activeName(page)).toHaveText("Trail 1");
  await expect(suspensionPage(page).getByTestId("active-evaluation")).toBeVisible();
  // Switching keeps every evaluation.
  await expect(config(page, 1).getByTestId("evaluation")).toHaveCount(3);
});

test("comparing configurations shows numbers, active status, equipment, differences and evaluations", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-cmp"));
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });
  await changeEquipment(page, suspensionPage(page), "Change skis or carbides", "C&A Pro XPT", '6"');
  await tune(page, { [`${FRONT}|${BOTH}`]: "12" }); // Trail 3
  await evaluate(page, 3, { rating: "Liked", conditions: ["Perfect Groomed"], temp: "15", note: "Planted" });

  const compare = suspensionPage(page).getByTestId("compare");
  await label(compare, "Compare").selectOption({ label: "Trail 1" });
  await label(compare, "With").selectOption({ label: "Trail 3 (active)" });
  await expect(compare.getByTestId("compare-summary")).toHaveText("Trail 1 → Trail 3: 2 settings differ, different skis or carbides");
  await expect(compare.getByTestId("compare-equipment")).toHaveText(["Skis: — → XPT", 'Carbides: — → 6"']);
  await expect(compare.getByTestId("compare-config").nth(1)).toContainText("Active");
  await expect(compare.getByTestId("compare-config").first()).toContainText("Inactive");
  await expect(compare.getByTestId("compare-evaluations")).toContainText("Perfect Groomed");
  await expect(compare.getByTestId("compare-evaluations")).toContainText("High 15 °F");
  await expect(compare.getByTestId("compare-evaluations")).toContainText("Planted");
  void sledId;
});

test("unsaved adjustments are protected when leaving the page or switching views", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-dirty"));
  await tuneInput(page, FRONT, BOTH).fill("9");
  await expect(bar(page)).toBeVisible();

  // Leaving: asked first; staying keeps the edits.
  page.once("dialog", (d) => void d.dismiss());
  await visible(page.getByRole("link", { name: "Blue", exact: true }))
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}/suspension`));
  await expect(tuneInput(page, FRONT, BOTH)).toHaveValue("9");

  // Switching views: asked too.
  page.once("dialog", (d) => void d.dismiss());
  await suspensionPage(page).getByRole("button", { name: "Suspension Map" }).click();
  await expect(suspensionPage(page).getByTestId("quick-tune")).toBeVisible();
  // Equipment can't change underneath unsaved edits.
  await expect(suspensionPage(page).getByRole("button", { name: "Change skis or carbides" })).toBeDisabled();

  // Leaving anyway discards them.
  page.once("dialog", (d) => void d.accept());
  await visible(page.getByRole("link", { name: "Blue", exact: true }))
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}$`));
});

test("the Suspension Map stays available: zones, values and Record adjustment save the next Trail", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-map"));
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });
  await openSuspension(page, sledId, "map");
  const map = suspensionPage(page).getByTestId("suspension-map");
  await expect(map.getByTestId("zone-panel")).toHaveAttribute("data-zone", "front_left_shock");
  await expect(map.getByTestId("zone-panel").getByTestId("zone-setting-value").first()).toContainText("10");
  await map
    .getByRole("button", { name: /Rear track shock/ })
    .first()
    .click();
  await expect(map.getByTestId("zone-panel")).toHaveAttribute("data-zone", "rear_rear_shock");
  await map.getByTestId("zone-panel").getByRole("button", { name: "Record adjustment" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  await label(dialog, "Rear track shock: Rebound", true).fill("5");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(activeName(page)).toHaveText("Trail 2");
  await expect(config(page, 2).getByTestId("configuration-changes")).toContainText("Rebound: set to 5 clicks");
});

test("roles: mechanics tune, evaluate, activate and change equipment; viewers only read; others see nothing", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("qt-r-o");
  const mechanicEmail = uniqueEmail("qt-r-m");
  const viewerEmail = uniqueEmail("qt-r-v");
  const strangerEmail = uniqueEmail("qt-r-x");
  const sledId = await sledWithTemplate(page, ownerEmail, "Riot");
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });
  await tune(page, { [`${FRONT}|${BOTH}`]: "11" });

  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext()));
  const [mechanic, viewer, stranger] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await signUp(stranger, strangerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic.
  await openSuspension(mechanic, sledId);
  await tune(mechanic, { "springs-limiter|Limiter strap": "2" });
  await expect(activeName(mechanic)).toHaveText("Trail 3");
  await evaluate(mechanic, 3, { rating: "Liked", conditions: ["Hard Pack"] });
  await config(mechanic, 1).getByRole("button", { name: "Make Trail 1 active" }).click();
  await mechanic.getByRole("dialog", { name: "Make active" }).getByRole("button", { name: "Activate Trail 1" }).click();
  await expect(activeName(mechanic)).toHaveText("Trail 1");
  await changeEquipment(mechanic, suspensionPage(mechanic), "Change skis or carbides", "C&A Pro XCS", '9"');
  await expect(activeName(mechanic)).toHaveText("Trail 4");
  await expect(suspensionPage(mechanic).getByRole("heading", { name: /Settings list|Recently deleted/ })).toHaveCount(0);
  await expect(suspensionPage(mechanic).getByRole("button", { name: /Add setting|Use suggested/ })).toHaveCount(0);

  // Viewer: values only.
  await openSuspension(viewer, sledId);
  await expect(activeName(viewer)).toHaveText("Trail 4");
  await expect(suspensionPage(viewer).getByTestId("quick-tune").getByRole("textbox")).toHaveCount(0);
  await expect(section(viewer, FRONT).getByTestId("qt-value").first()).toHaveText("10 clicks");
  await expect(
    suspensionPage(viewer).getByRole("button", { name: /Make Trail|Add ride evaluation|Change skis|Increase|Record adjustment/ }),
  ).toHaveCount(0);
  await expect(suspensionPage(viewer).getByTestId("read-only-note")).toBeVisible();

  // Someone without access: no page; the API refuses.
  await stranger.goto(`/garage/${sledId}/suspension`);
  await expect(stranger.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();
  const api = await apiAs(strangerEmail);
  expect((await api.from("sled_suspension_state").select("sled_id").eq("sled_id", sledId)).data ?? []).toHaveLength(0);
  expect((await api.from("suspension_revisions").select("id").eq("sled_id", sledId)).data ?? []).toHaveLength(0);
  const save = await api.rpc("save_suspension_configuration", {
    p_sled_id: sledId,
    p_changes: {},
    p_ski_model: "ca_pro_xpt",
    p_idempotency_key: crypto.randomUUID(),
  });
  expect(save.error).not.toBeNull();

  await Promise.all(contexts.map((c) => c.close()));
});

// ---------------------------------------------------------------------------
// Snowmobile page, Garage Board and Wall Display
// ---------------------------------------------------------------------------
const garage = (page: Page) => visible(page.getByTestId("garage-board"));
const garageSled = (page: Page, name: string) => garage(page).getByRole("article", { name, exact: true });
const summaryIn = (scope: Locator) => scope.getByTestId("suspension-summary");
const keyboard = (page: Page) => page.getByTestId("wall-keyboard");
const tapKeys = async (page: Page, keys: string[]) => {
  for (const key of keys) await keyboard(page).getByRole("button", { name: key, exact: true }).click();
};

async function quickAdjust(page: Page, scope: Locator, sledName: string, values: Record<string, string>) {
  await scope.getByRole("button", { name: `Adjust suspension on ${sledName}` }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  for (const [field, value] of Object.entries(values)) await label(dialog, field, true).fill(value);
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function quickEvaluation(page: Page, scope: Locator, sledName: string, rating: string, conditions: string[] = []) {
  await scope.getByRole("button", { name: `Add ride evaluation on ${sledName}` }).click();
  const dialog = page.getByRole("dialog", { name: "Ride evaluation" });
  await dialog.getByText(rating, { exact: true }).click();
  for (const c of conditions) await dialog.getByText(c, { exact: true }).click();
  await dialog.getByRole("button", { name: "Save evaluation" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("snowmobile page: active Trail, quick adjust and ride evaluation; nothing else on the page changes", async ({ page }) => {
  await signUp(page, uniqueEmail("qt-page"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  const section = visible(page.locator("#suspension"));
  await expect(summaryIn(section).getByTestId("suspension-none")).toHaveText("No configuration yet");

  await openSuspension(page, sledId);
  await suspensionPage(page).getByRole("button", { name: "Use suggested settings" }).click();
  await expect(tuneInput(page, FRONT, BOTH)).toBeVisible({ timeout: 15_000 });
  await page.goto(`/garage/${sledId}`);
  await quickAdjust(page, summaryIn(section), "Blue", { "Left ski shock: Compression": "12" });
  await expect(summaryIn(section)).toContainText("Saved as Trail 1.");
  await expect(summaryIn(section).getByTestId("suspension-active")).toHaveText("Trail 1 · Active");
  await quickEvaluation(page, summaryIn(section), "Blue", "Liked", ["Hard Pack"]);
  await expect(summaryIn(section).getByTestId("suspension-feedback").getByTestId("feedback-rating")).toHaveText("Liked");
  await expect(summaryIn(section).getByTestId("suspension-feedback").getByTestId("conditions")).toHaveText("Hard Pack");

  await summaryIn(section).getByRole("button", { name: "View suspension setup on Blue" }).click();
  const view = page.getByRole("dialog", { name: "Suspension setup" });
  await expect(view.getByTestId("active-value").first()).toHaveText("Compression (Left)12 clicks");
  await view.getByRole("button", { name: "Close" }).click();

  // Mileage, readings and Ready are untouched.
  await expect(visible(page.getByTestId("current-odometer"))).toHaveText("2,000 mi");
  await expect(visible(page.getByTestId("reading-history")).getByRole("listitem")).toHaveCount(1);
  await expect(visible(page.locator("#sled-name").locator("xpath=..").getByTestId("sled-status"))).toHaveAttribute("data-status", "ready");
  await summaryIn(section).getByRole("link", { name: "Open suspension tuning for Blue" }).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}/suspension$`));
  await expect(activeName(page)).toHaveText("Trail 1");
});

test("Garage Board: Cards, Compact and Wall Display show the active Trail and skis; actions follow the role", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("qt-gb-o");
  const viewerEmail = uniqueEmail("qt-gb-v");
  const sledId = await sledWithTemplate(page, ownerEmail, "Summit");
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });

  await page.goto("/garage/board");
  const card = garageSled(page, "Summit");
  await expect(summaryIn(card).getByTestId("suspension-active")).toHaveText("Trail 1 · Active");
  await quickAdjust(page, summaryIn(card), "Summit", { "Left ski shock: Compression": "11" });
  await expect(summaryIn(card).getByTestId("suspension-active")).toHaveText("Trail 2 · Active");
  await changeEquipment(page, summaryIn(card), "Change skis or carbides on Summit", "C&A Pro XPT", '9"');
  await expect(summaryIn(card).getByTestId("ski-configuration")).toContainText('C&A Pro XPT · 9" carbides');
  await expect(card.getByTestId("sled-status")).toHaveAttribute("data-status", "ready");

  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  await quickEvaluation(page, summaryIn(garageSled(page, "Summit")), "Summit", "Disliked", ["Sloppy"]);
  await expect(summaryIn(garageSled(page, "Summit")).getByTestId("feedback-rating")).toHaveText("Disliked");

  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  const adjust = summaryIn(garageSled(page, "Summit")).getByRole("button", { name: "Adjust suspension on Summit" });
  expect((await adjust.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await visible(page.getByRole("button", { name: "Exit wall display" })).click();
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Cards" }).click();

  const context = await browser.newContext();
  const viewer = await context.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");
  await viewer.goto("/garage/board");
  const viewerSummary = summaryIn(garageSled(viewer, "Summit"));
  await expect(viewerSummary.getByTestId("suspension-active")).toHaveText("Trail 3 · Active");
  await expect(viewerSummary.getByTestId("ski-configuration")).toContainText('C&A Pro XPT · 9" carbides');
  await expect(viewerSummary.getByRole("button")).toHaveText(["View"]);
  await context.close();

  // My Snowmobiles is unchanged: no suspension there.
  await page.goto("/garage");
  await expect(visible(page.getByTestId("sled-card")).getByTestId("suspension-summary")).toHaveCount(0);
});

test("Wall Display keyboard: ± only on suspension values; only valid numbers; mileage pads unchanged", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-kb"), "Rave");
  void sledId;
  await page.goto("/garage/board");
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  await summaryIn(garageSled(page, "Rave")).getByRole("button", { name: "Adjust suspension on Rave" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  const preload = label(dialog, "Left ski shock: Preload", true);
  await preload.click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  await expect(keyboard(page)).toHaveAttribute("data-signed", "true");
  const typed = async (keys: string[]) => {
    await tapKeys(page, ["Clear", ...keys]);
    return preload.inputValue();
  };
  const pm = "Plus or minus";
  const dot = "Decimal point";
  expect(await typed(["1", dot, "5", pm])).toBe("-1.5");
  expect(await typed(["4", pm, "3", pm, "1", "2"])).toBe("4312");
  expect(await typed(["1", dot, "2", dot, "3"])).toBe("1.23");
  expect(await typed(["1", dot, "5", pm])).toBe("-1.5");
  await label(dialog, "Mileage", true).click();
  await expect(keyboard(page)).not.toHaveAttribute("data-signed", "true");
  await expect(keyboard(page).getByRole("button", { name: "Plus or minus" })).toHaveCount(0);

  for (const bad of ["4-3-12", "1.2.3"]) {
    await preload.fill(bad);
    await expect(dialog.getByText("Enter a number for Preload.")).toBeVisible();
  }
  await preload.fill("-1.5");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(summaryIn(garageSled(page, "Rave")).getByTestId("suspension-active")).toHaveText("Trail 1 · Active");
  await summaryIn(garageSled(page, "Rave")).getByRole("button", { name: "View suspension setup on Rave" }).click();
  await expect(
    page.getByRole("dialog", { name: "Suspension setup" }).getByTestId("active-value").filter({ hasText: "Preload" }).first(),
  ).toHaveText("Preload (Left)-1.5 in");
});

// ---------------------------------------------------------------------------
// Photos (uploads stay off; Migration 8 cleanup behaviour unchanged)
// ---------------------------------------------------------------------------
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=", "base64");
const pngs = (count: number, prefix = "photo") =>
  Array.from({ length: count }, (_, n) => ({ name: `${prefix}-${n}.png`, mimeType: "image/png", buffer: PNG }));
const objectPath = (sledId: string, parentId: string) => `${sledId}/${parentId}/${crypto.randomUUID()}.jpg`;

test("photo uploads stay off (the default): no upload control anywhere; existing photos stay visible and removable", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-nophoto"));
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });

  // A reference photo added while uploads were on (the second test server, same database).
  await page.goto(`${PHOTOS_URL}/garage/${sledId}/suspension?view=map`);
  await suspensionPage(page).getByTestId("zone-panel").getByRole("button", { name: "Reference photos of Compression" }).click();
  let dialog = page.getByRole("dialog", { name: "Reference photos" });
  await dialog.locator('input[type="file"]').setInputFiles(pngs(1));
  await dialog.getByRole("button", { name: "Upload 1 photo" }).click();
  await expect(dialog.getByText("1 photo added.")).toBeVisible();

  // Uploads off: Quick Tune, the map, Record adjustment and the history offer no upload.
  await openSuspension(page, sledId, "quick");
  await expect(suspensionPage(page).locator('input[type="file"]')).toHaveCount(0);
  await expect(suspensionPage(page).getByRole("button", { name: /^Photos of Trail/ })).toHaveCount(0);
  await section(page, FRONT).getByRole("button", { name: "Reference photos of Compression" }).click();
  dialog = page.getByRole("dialog", { name: "Reference photos" });
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Add photos" })).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove photo 1 of Compression" }).click({ trial: true });
  await dialog.getByRole("button", { name: "Close" }).click();

  await openSuspension(page, sledId, "map");
  await expect(suspensionPage(page).getByText("Add reference photos")).toHaveCount(0);
  await suspensionPage(page).getByTestId("zone-panel").getByRole("button", { name: "Record adjustment" }).click();
  dialog = page.getByRole("dialog", { name: "Record adjustment" });
  await expect(dialog.getByText("Photos (optional)")).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
});

test("a file whose record can't be saved: owners and editors remove it; a mechanic's stays for the Migration 8 cleanup", async ({
  page,
  browser,
}) => {
  // Same calls as the app (upload, then record, then remove on failure), made through the API so the record save can
  // be made to fail on purpose: the parent is deleted between the upload and the save. Real storage policies and RLS.
  const ownerEmail = uniqueEmail("qt-cl-o");
  const editorEmail = uniqueEmail("qt-cl-e");
  const mechanicEmail = uniqueEmail("qt-cl-m");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", nickname: "Blue" });
  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  const [editorPage, mechanicPage] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(editorPage, editorEmail);
  await signUp(mechanicPage, mechanicEmail);
  await shareSled(ownerEmail, sledId, editorEmail, "editor");
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  const [owner, editor, mechanic] = await Promise.all([apiAs(ownerEmail), apiAs(editorEmail), apiAs(mechanicEmail)]);
  const bucket = (client: typeof owner) => client.storage.from("suspension-photos");
  const listed = async (folder: string) => ((await bucket(owner).list(folder)).data ?? []).map((f) => f.name);

  const { data: setting } = await owner
    .from("suspension_settings")
    .insert({ sled_id: sledId, name: "Compression", zone: "front_left_shock" })
    .select("id")
    .single();
  const newSetup = async (name: string) => {
    const { data } = await owner.rpc("create_suspension_setup", { p_sled_id: sledId, p_name: name });
    const setupId = (data as { setup_id: string }).setup_id;
    const { data: revision } = await owner.from("suspension_revisions").select("id").eq("setup_id", setupId).single();
    return { setupId, revisionId: revision!.id };
  };

  // Editor, reference photo: the setting is removed before the save; the file is removed again.
  const editorPath = objectPath(sledId, setting!.id);
  expect((await bucket(editor).upload(editorPath, PNG, { contentType: "image/jpeg" })).error).toBeNull();
  await owner.from("suspension_settings").update({ deleted_at: new Date().toISOString(), version: 1 }).eq("id", setting!.id);
  const editorSave = await editor
    .from("suspension_photos")
    .insert({ sled_id: sledId, setting_id: setting!.id, path: editorPath })
    .select("id");
  expect(editorSave.error?.message).toContain("Restore it before adding photos.");
  expect((await bucket(editor).remove([editorPath])).data).toHaveLength(1);
  expect(await listed(`${sledId}/${setting!.id}`)).toHaveLength(0);

  // Mechanic, adjustment photo: both saves fail; the remove is refused (owners and editors only); the file stays,
  // unreferenced, for the Migration 8 cleanup.
  const b = await newSetup("Powder");
  const mechanicPath = objectPath(sledId, b.revisionId);
  expect((await bucket(mechanic).upload(mechanicPath, PNG, { contentType: "image/jpeg" })).error).toBeNull();
  await owner.from("suspension_setups").update({ deleted_at: new Date().toISOString(), version: 1 }).eq("id", b.setupId);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      (await mechanic.from("suspension_photos").insert({ sled_id: sledId, revision_id: b.revisionId, path: mechanicPath })).error,
    ).not.toBeNull();
  }
  expect((await bucket(mechanic).remove([mechanicPath])).data ?? []).toHaveLength(0);
  expect(await listed(`${sledId}/${b.revisionId}`)).toHaveLength(1);
  const { count } = await owner.from("suspension_photos").select("id", { count: "exact", head: true }).eq("path", mechanicPath);
  expect(count).toBe(0);
  expect((await bucket(owner).remove([mechanicPath])).data).toHaveLength(1);

  await Promise.all(contexts.map((c) => c.close()));
});

test.describe("with photo uploads turned on", () => {
  test.use({ baseURL: PHOTOS_URL });

  test("reference photos (owners and editors) and adjustment photos (also mechanics) still work for when uploads return", async ({
    page,
    browser,
  }) => {
    const ownerEmail = uniqueEmail("qt-ph-o");
    const mechanicEmail = uniqueEmail("qt-ph-m");
    const sledId = await sledWithTemplate(page, ownerEmail);
    await tune(page, { [`${FRONT}|${BOTH}`]: "10" });

    // Reference photo from the map's zone panel.
    await openSuspension(page, sledId, "map");
    await suspensionPage(page).getByTestId("zone-panel").getByRole("button", { name: "Reference photos of Compression" }).click();
    let dialog = page.getByRole("dialog", { name: "Reference photos" });
    await dialog.locator('input[type="file"]').setInputFiles(pngs(2));
    await dialog.getByRole("button", { name: "Upload 2 photos" }).click();
    await expect(dialog.getByText("2 photos added.")).toBeVisible();
    await expect(await violations(axeFor(page, "dialog[open]"))).toEqual([]);
    await dialog.getByRole("button", { name: "Close" }).click();

    // Adjustment photos while recording an adjustment, then later from the history.
    await suspensionPage(page).getByTestId("zone-panel").getByRole("button", { name: "Record adjustment" }).click();
    dialog = page.getByRole("dialog", { name: "Record adjustment" });
    await label(dialog, "Left ski shock: Compression", true).fill("12");
    await dialog.locator('input[type="file"]').setInputFiles(pngs(1, "adj"));
    await dialog.getByRole("button", { name: "Save adjustment" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(config(page, 2).getByTestId("revision-photos").getByTestId("photo")).toHaveCount(1);

    const context = await browser.newContext({ baseURL: PHOTOS_URL });
    const mechanic = await context.newPage();
    await signUp(mechanic, mechanicEmail);
    await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
    await openSuspension(mechanic, sledId);
    await config(mechanic, 1).getByRole("button", { name: "Photos of Trail 1" }).click();
    dialog = mechanic.getByRole("dialog", { name: "Adjustment photos" });
    await dialog.locator('input[type="file"]').setInputFiles(pngs(1, "mech"));
    await dialog.getByRole("button", { name: "Upload 1 photo" }).click();
    await expect(dialog.getByText("1 photo added.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Remove photo/ })).toHaveCount(0);
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------
// Every axe rule is checked, color contrast included (primary buttons use #d92b12, 4.88:1).
const axeFor = (page: Page, include: string) => new AxeBuilder({ page }).include(include);
const violations = async (builder: AxeBuilder) =>
  (await builder.analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

test("accessibility: Quick Tune and its sheets pass automated checks; no sideways scrolling; 44 px targets", async ({ page }) => {
  const sledId = await sledWithTemplate(page, uniqueEmail("qt-a11y"));
  await tune(page, { [`${FRONT}|${BOTH}`]: "10" });
  await tune(page, { [`${FRONT}|${BOTH}`]: "12" });
  await evaluate(page, 2, { rating: "Liked", conditions: ["Hard Pack"], temp: "20" });

  const noSidewaysScroll = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const smallTargets = (scope: string) =>
    page.evaluate((sel) => {
      const out: string[] = [];
      for (const root of document.querySelectorAll(sel))
        for (const el of root.querySelectorAll<HTMLElement>("button, a, select, summary, input:not([type=hidden]):not(.sr-only)")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height && (r.height < 44 || r.width < 44))
            out.push(`${el.tagName} ${el.textContent?.trim() || el.getAttribute("aria-label")}`);
        }
      return out;
    }, scope);

  await expect(await violations(axeFor(page, '[data-testid="suspension-page"]'))).toEqual([]);
  await noSidewaysScroll();
  expect(await smallTargets('[data-testid="quick-tune"]')).toEqual([]);
  expect(await smallTargets('[data-testid="active-configuration"]')).toEqual([]);

  // With unsaved changes: the Save bar.
  await section(page, FRONT)
    .getByRole("button", { name: `Increase ${BOTH}` })
    .click();
  await expect(await violations(axeFor(page, '[data-testid="quick-tune-bar"]'))).toEqual([]);
  expect(await smallTargets('[data-testid="quick-tune-bar"]')).toEqual([]);
  await noSidewaysScroll();
  await bar(page).getByRole("button", { name: "Discard Changes" }).click();

  for (const [scope, button, title] of [
    ["active-configuration", "Add ride evaluation to Trail 2", "Ride evaluation"],
    ["active-configuration", "Change skis or carbides", "Skis & carbides"],
    ["configuration-history", "Make Trail 1 active", "Make active"],
    ["configuration-history", "View Trail 1", "Trail 1"],
  ] as const) {
    await suspensionPage(page).getByTestId(scope).getByRole("button", { name: button }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
    await expect(await violations(axeFor(page, "dialog[open]"))).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  // The map view, a small phone, the snowmobile page and the Garage Board.
  await openSuspension(page, sledId, "map");
  await expect(await violations(axeFor(page, '[data-testid="suspension-page"]'))).toEqual([]);
  await openSuspension(page, sledId, "quick");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 360, height: 740 });
  await noSidewaysScroll();
  await section(page, FRONT)
    .getByRole("button", { name: `Increase ${BOTH}` })
    .click();
  await noSidewaysScroll();
  await bar(page).getByRole("button", { name: "Discard Changes" }).click();
  await page.setViewportSize(size);
  await page.goto(`/garage/${sledId}`);
  await expect(await violations(axeFor(page, "#suspension"))).toEqual([]);
  expect(await smallTargets("#suspension")).toEqual([]);
  await noSidewaysScroll();
  await page.goto("/garage/board");
  await expect(await violations(axeFor(page, '[data-testid="suspension-summary"]'))).toEqual([]);
  await noSidewaysScroll();
});
