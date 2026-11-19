import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Phase 6.2: suspension setup & tuning. Needs the local Supabase stack with Migration 7.
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
const setupTab = (page: Page, name: string) =>
  suspensionPage(page)
    .getByTestId("setup-tab")
    .filter({ hasText: new RegExp(`^${name}`) });
const selectedSetup = (page: Page) => suspensionPage(page).getByTestId("selected-setup");
const zoneSettings = (page: Page, zone: string) =>
  suspensionPage(page).getByTestId("settings-editor").locator(`[data-zone="${zone}"]`).getByTestId("setting-name");
const deletedItems = (page: Page) => suspensionPage(page).getByTestId("deleted-item");

async function openSuspension(page: Page, sledId: string) {
  await page.goto(`/garage/${sledId}/suspension`);
  await expect(suspensionPage(page).getByRole("heading", { name: "Suspension tuning" })).toBeVisible();
}

type NewSetting = { name: string; zone: string; text?: boolean; unit?: string; chip?: string };

async function addSetting(page: Page, setting: NewSetting) {
  await visible(page.getByRole("button", { name: "Add setting", exact: true })).click();
  const dialog = page.getByRole("dialog", { name: "Add setting" });
  await label(dialog, "Setting name").fill(setting.name);
  await label(dialog, "Where on the sled").selectOption({ label: setting.zone });
  if (setting.text) await dialog.getByText("Text", { exact: true }).click();
  if (setting.chip) await dialog.getByRole("group", { name: "Unit suggestions" }).getByRole("button", { name: setting.chip }).click();
  if (setting.unit) await label(dialog, "Unit (optional)").fill(setting.unit);
  await dialog.getByRole("button", { name: "Add setting" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function createSetup(page: Page, name: string, options: { activate?: boolean; copy?: string } = {}) {
  await visible(page.getByRole("button", { name: /^(New setup|Create a setup)$/ }))
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New setup" });
  await label(dialog, "Setup name").fill(name);
  if (options.copy) {
    await dialog.getByText("A copy of a saved revision").click();
    await label(dialog, "Revision to copy").selectOption({ label: options.copy });
  }
  if (options.activate) await label(dialog, "Make this the active setup").check();
  await dialog.getByRole("button", { name: "Create setup" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("a new snowmobile starts blank; the owner builds the settings list and setups", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-own"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  await visible(page.getByRole("link", { name: "Suspension", exact: true })).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}/suspension$`));

  // Nothing is pre-filled: no settings, no setups.
  await expect(visible(page.getByTestId("no-settings"))).toBeVisible();
  await expect(visible(page.getByTestId("no-setups"))).toBeVisible();
  await expect(suspensionPage(page).getByTestId("setting-row")).toHaveCount(0);

  // Custom settings with a suggested unit, a typed unit, and a text setting.
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await addSetting(page, { name: "Rebound", zone: "Left ski shock", unit: "clicks out" });
  await addSetting(page, { name: "Spring", zone: "Springs & limiter strap", text: true });
  await expect(zoneSettings(page, "front_left_shock")).toHaveText(["Compression", "Rebound"]);
  await expect(suspensionPage(page).locator('[data-zone="front_left_shock"]').getByTestId("setting-row").first()).toContainText(
    "Number · Clicks",
  );
  await expect(suspensionPage(page).locator('[data-zone="rear_springs_limiter"]').getByTestId("setting-row")).toContainText("Text");
  await expect(visible(page.getByTestId("no-settings"))).toHaveCount(0);

  // The same name twice in one zone is refused (adding from the zone preselects it).
  await suspensionPage(page).getByRole("button", { name: "Add setting to Left ski shock" }).click();
  let dialog = page.getByRole("dialog", { name: "Add setting" });
  await expect(label(dialog, "Where on the sled")).toHaveValue("front_left_shock");
  await label(dialog, "Setting name").fill("compression");
  await dialog.getByRole("button", { name: "Add setting" }).click();
  await expect(dialog.getByText("There's already a setting with that name in this part of the sled.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // Reorder and edit.
  await suspensionPage(page).getByRole("button", { name: "Move Rebound up" }).click();
  await expect(zoneSettings(page, "front_left_shock")).toHaveText(["Rebound", "Compression"]);
  await suspensionPage(page).getByRole("button", { name: "Edit Compression" }).click();
  dialog = page.getByRole("dialog", { name: "Edit setting" });
  await label(dialog, "Setting name").fill("High-speed compression");
  await dialog.getByRole("button", { name: "Save setting" }).click();
  await expect(dialog).toBeHidden();
  await expect(zoneSettings(page, "front_left_shock")).toHaveText(["Rebound", "High-speed compression"]);

  // Setups: one made active on purpose, one not.
  await createSetup(page, "Trail", { activate: true });
  await expect(setupTab(page, "Trail").getByTestId("active-badge")).toBeVisible();
  await expect(selectedSetup(page).getByTestId("selected-setup-name")).toHaveText("Trail");
  await expect(selectedSetup(page).getByTestId("setup-summary")).toContainText("Revision 1");
  await createSetup(page, "Deep powder");
  await expect(selectedSetup(page).getByTestId("selected-setup-name")).toHaveText("Deep powder");
  await expect(setupTab(page, "Deep powder").getByTestId("active-badge")).toHaveCount(0);
  await expect(setupTab(page, "Trail").getByTestId("active-badge")).toBeVisible();

  // Setup names are unique per sled.
  await visible(page.getByRole("button", { name: "New setup" })).click();
  dialog = page.getByRole("dialog", { name: "New setup" });
  await label(dialog, "Setup name").fill("trail");
  await dialog.getByRole("button", { name: "Create setup" }).click();
  await expect(dialog.getByText("There's already a setup with that name on this snowmobile.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The active setup can't be deleted.
  await setupTab(page, "Trail").click();
  await expect(selectedSetup(page).getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(selectedSetup(page).getByTestId("active-delete-hint")).toBeVisible();

  // Switching the active setup, then deleting and restoring the other one.
  await setupTab(page, "Deep powder").click();
  await selectedSetup(page).getByRole("button", { name: "Set active" }).click();
  await expect(setupTab(page, "Deep powder").getByTestId("active-badge")).toBeVisible();
  await expect(setupTab(page, "Trail").getByTestId("active-badge")).toHaveCount(0);
  await setupTab(page, "Trail").click();
  page.once("dialog", (d) => d.accept());
  await selectedSetup(page).getByRole("button", { name: "Delete" }).click();
  await expect(setupTab(page, "Trail")).toHaveCount(0);
  await expect(deletedItems(page).filter({ hasText: "Trail" })).toContainText("Setup, with its history");
  await suspensionPage(page).getByRole("button", { name: "Restore Trail" }).click();
  await expect(setupTab(page, "Trail")).toBeVisible();
  await expect(setupTab(page, "Trail").getByTestId("active-badge")).toHaveCount(0);
  await expect(deletedItems(page)).toHaveCount(0);

  // Rename.
  await setupTab(page, "Trail").click();
  await selectedSetup(page).getByRole("button", { name: "Rename" }).click();
  dialog = page.getByRole("dialog", { name: "Rename setup" });
  await label(dialog, "Setup name").fill("Trail 2026");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(setupTab(page, "Trail 2026")).toBeVisible();

  // Removing a setting puts it in Recently Deleted; it can be restored.
  page.once("dialog", (d) => d.accept());
  await suspensionPage(page).getByRole("button", { name: "Remove Spring" }).click();
  await expect(zoneSettings(page, "rear_springs_limiter")).toHaveCount(0);
  await expect(deletedItems(page).filter({ hasText: "Spring" })).toContainText("Springs & limiter strap");
  await suspensionPage(page).getByRole("button", { name: "Restore Spring" }).click();
  await expect(zoneSettings(page, "rear_springs_limiter")).toHaveText(["Spring"]);

  // The sled's mileage history is untouched by all of this.
  await page.goto(`/garage/${sledId}`);
  await expect(visible(page.getByTestId("reading-history")).getByRole("listitem")).toHaveCount(1);
});

test("roles: editors manage, mechanics and viewers can't; others see nothing", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-o");
  const editorEmail = uniqueEmail("sus-e");
  const mechanicEmail = uniqueEmail("sus-m");
  const viewerEmail = uniqueEmail("sus-v");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "500", nickname: "Summit" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Front track shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });

  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const [editor, mechanic, viewer, stranger] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(editor, editorEmail);
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await signUp(stranger, uniqueEmail("sus-x"));
  await shareSled(ownerEmail, sledId, editorEmail, "editor");
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Editor: manages setups and settings.
  await openSuspension(editor, sledId);
  await addSetting(editor, { name: "Rebound", zone: "Front track shock", unit: "Clicks" });
  await expect(zoneSettings(editor, "rear_front_shock")).toHaveText(["Compression", "Rebound"]);
  await createSetup(editor, "Deep powder");
  await expect(selectedSetup(editor).getByRole("button", { name: "Set active" })).toBeVisible();

  // Mechanic: sees the setups, but no management controls.
  await openSuspension(mechanic, sledId);
  await expect(setupTab(mechanic, "Trail").getByTestId("active-badge")).toBeVisible();
  await expect(
    suspensionPage(mechanic).getByRole("button", { name: /New setup|Add setting|Set active|Rename|Delete|Restore/ }),
  ).toHaveCount(0);
  await expect(suspensionPage(mechanic).getByRole("heading", { name: "Settings list" })).toHaveCount(0);
  await expect(suspensionPage(mechanic).getByRole("heading", { name: "Recently deleted" })).toHaveCount(0);

  // Viewer: read only.
  await openSuspension(viewer, sledId);
  await expect(visible(viewer.getByTestId("read-only-note"))).toBeVisible();
  await expect(suspensionPage(viewer).getByRole("button", { name: /New setup|Add setting|Set active|Rename|Delete/ })).toHaveCount(0);

  // Someone the sled isn't shared with can't open it.
  await stranger.goto(`/garage/${sledId}/suspension`);
  await expect(stranger.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();

  await Promise.all(contexts.map((c) => c.close()));
});

// ---------------------------------------------------------------------------
// Checkpoint 3: the map, zones and adjustments
// ---------------------------------------------------------------------------
const marker = (page: Page, zone: string) => suspensionPage(page).locator(`[data-testid="diagram-zone"][data-zone="${zone}"]`);
const zonePanel = (page: Page) => suspensionPage(page).getByTestId("zone-panel");
const zoneValue = (page: Page, name: string) =>
  zonePanel(page)
    .getByTestId("zone-setting")
    .filter({ has: page.getByTestId("zone-setting-name").getByText(name, { exact: true }) })
    .getByTestId("zone-setting-value");

const adjustZone = (dialog: Locator, zone: string) => dialog.locator(`[data-testid="adjust-zone"][data-zone="${zone}"]`);
const zoneToggle = (dialog: Locator, zone: string) => adjustZone(dialog, zone).locator("button[aria-expanded]");

async function openAdjust(page: Page) {
  await zonePanel(page).getByRole("button", { name: "Record adjustment" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the map selects zones (mouse and keyboard) and adjustments save new revisions", async ({ page, context }) => {
  await signUp(page, uniqueEmail("sus-adj"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await addSetting(page, { name: "Spring", zone: "Springs & limiter strap", text: true });
  await createSetup(page, "Trail", { activate: true });

  // The map: seven numbered zones; clicking and arrow keys select them, and the zone list follows.
  await expect(suspensionPage(page).getByTestId("diagram-zone")).toHaveCount(7);
  await expect(suspensionPage(page).getByTestId("zone-option")).toHaveCount(7);
  await marker(page, "rear_springs_limiter").click();
  await expect(zonePanel(page)).toHaveAttribute("data-zone", "rear_springs_limiter");
  await expect(marker(page, "rear_springs_limiter")).toHaveAttribute("aria-pressed", "true");
  await expect(suspensionPage(page).locator('[data-testid="zone-option"][data-zone="rear_springs_limiter"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("ArrowDown");
  await expect(zonePanel(page)).toHaveAttribute("data-zone", "rear_general");
  await expect(marker(page, "rear_general")).toBeFocused();
  await expect(zonePanel(page).getByTestId("zone-empty")).toBeVisible();
  await suspensionPage(page).locator('[data-testid="zone-option"][data-zone="front_left_shock"]').click();
  await expect(zonePanel(page)).toHaveAttribute("data-zone", "front_left_shock");
  await expect(zoneValue(page, "Compression")).toContainText("—");

  // Adjust: mileage and hours are prefilled from the readings; only changes are saved.
  let dialog = await openAdjust(page);
  await expect(label(dialog, "Mileage", true)).toHaveValue("2000");
  await expect(label(dialog, "Engine hours", true)).toHaveValue("150");
  // Only the zone picked on the map is open; the others start collapsed.
  await expect(zoneToggle(dialog, "front_left_shock")).toHaveAttribute("aria-expanded", "true");
  await expect(zoneToggle(dialog, "rear_springs_limiter")).toHaveAttribute("aria-expanded", "false");
  await expect(label(dialog, "Springs & limiter strap: Spring", true)).toHaveCount(0);
  await label(dialog, "Left ski shock: Compression", true).fill("soft");
  await expect(dialog.getByText("Enter a number for Compression.")).toBeVisible();
  // A collapsed zone still shows that it needs fixing.
  await zoneToggle(dialog, "front_left_shock").click();
  await expect(adjustZone(dialog, "front_left_shock").getByTestId("zone-status")).toHaveText("Needs fixing");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  // The server's message opens the zone again.
  await expect(zoneToggle(dialog, "front_left_shock")).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText("Enter a number for Compression.")).toBeVisible();
  await label(dialog, "Left ski shock: Compression", true).fill("+12");
  // Opening another zone keeps the first one open (keyboard works too).
  await zoneToggle(dialog, "rear_springs_limiter").focus();
  await page.keyboard.press("Enter");
  await expect(zoneToggle(dialog, "rear_springs_limiter")).toHaveAttribute("aria-expanded", "true");
  await expect(zoneToggle(dialog, "front_left_shock")).toHaveAttribute("aria-expanded", "true");
  await label(dialog, "Springs & limiter strap: Spring", true).fill("Stiff");
  // Collapsing keeps the typed values and shows the unsaved changes on the header.
  await zoneToggle(dialog, "front_left_shock").click();
  await zoneToggle(dialog, "rear_springs_limiter").click();
  await expect(adjustZone(dialog, "front_left_shock").getByTestId("zone-status")).toHaveText("1 change");
  await expect(adjustZone(dialog, "rear_springs_limiter").getByTestId("zone-status")).toHaveText("1 change");
  await zoneToggle(dialog, "rear_springs_limiter").click();
  await expect(label(dialog, "Springs & limiter strap: Spring", true)).toHaveValue("Stiff");
  await expect(dialog.getByTestId("adjust-changes")).toContainText("2 changes");
  await label(dialog, "Mileage", true).fill("2100");
  await label(dialog, "What did you change and why? (optional)").fill("Baseline");
  // A double click still saves once.
  await dialog.getByRole("button", { name: "Save adjustment" }).dblclick();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(visible(page.getByTestId("adjust-notice"))).toContainText("Adjustment saved as revision 2.");
  await expect(zoneValue(page, "Compression")).toContainText("12");
  await expect(zoneValue(page, "Compression")).toContainText("Clicks");
  await expect(selectedSetup(page).getByTestId("setup-summary")).toContainText("Revision 2");
  await expect(selectedSetup(page).getByTestId("setup-summary")).toContainText("2 revisions");

  // Saving without a change is refused.
  dialog = await openAdjust(page);
  await expect(dialog.getByTestId("adjust-changes")).toContainText("No changes yet");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog.getByText("Nothing changed. Change at least one value to save an adjustment.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // Someone else saving first: the second save is refused with a reload message.
  const other = await context.newPage();
  await openSuspension(other, sledId);
  const otherDialog = await openAdjust(other);
  dialog = await openAdjust(page);
  await label(otherDialog, "Left ski shock: Compression", true).fill("14");
  await otherDialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(otherDialog).toBeHidden({ timeout: 15_000 });
  await label(dialog, "Left ski shock: Compression", true).fill("10");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog.getByText("This setup was changed by someone else. Reload it and try again.")).toBeVisible();
  await dialog.getByRole("button", { name: "Reload" }).click();
  await expect(dialog).toBeHidden();
  await expect(zoneValue(page, "Compression")).toContainText("14");
  await expect(selectedSetup(page).getByTestId("setup-summary")).toContainText("Revision 3");
  await other.close();

  // A blank value clears the setting.
  dialog = await openAdjust(page);
  await zoneToggle(dialog, "rear_springs_limiter").click();
  await label(dialog, "Springs & limiter strap: Spring", true).fill("");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await marker(page, "rear_springs_limiter").click();
  await expect(zoneValue(page, "Spring")).toContainText("—");

  // The mileage typed on the revision never became a reading.
  await page.goto(`/garage/${sledId}`);
  await expect(visible(page.getByTestId("current-odometer"))).toHaveText("2,000 mi");
  await expect(visible(page.getByTestId("reading-history")).getByRole("listitem")).toHaveCount(1);
});

test("mechanics record adjustments; viewers can't", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-adj-o");
  const mechanicEmail = uniqueEmail("sus-adj-m");
  const viewerEmail = uniqueEmail("sus-adj-v");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2021", odometer: "800", nickname: "Rave" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Preload", zone: "Rear track shock", chip: "Turns" });
  await createSetup(page, "Trail", { activate: true });

  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  const [mechanic, viewer] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  await openSuspension(mechanic, sledId);
  await marker(mechanic, "rear_rear_shock").click();
  const dialog = await openAdjust(mechanic);
  await label(dialog, "Rear track shock: Preload", true).fill("-1.5");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(zoneValue(mechanic, "Preload")).toContainText("-1.5");

  await openSuspension(viewer, sledId);
  await marker(viewer, "rear_rear_shock").click();
  await expect(zoneValue(viewer, "Preload")).toContainText("-1.5");
  await expect(zonePanel(viewer).getByRole("button", { name: "Record adjustment" })).toHaveCount(0);

  await Promise.all(contexts.map((c) => c.close()));
});

// ---------------------------------------------------------------------------
// Checkpoint 4: history, feedback, comparison and restore
// ---------------------------------------------------------------------------
const revisionCard = (page: Page, n: number) =>
  suspensionPage(page).getByTestId("revision-history").locator(`[data-testid="revision"][data-number="${n}"]`);

async function adjustValues(page: Page, values: Record<string, string>, note?: string) {
  const dialog = await openAdjust(page);
  for (const [field, value] of Object.entries(values)) await label(dialog, field, true).fill(value);
  if (note) await label(dialog, "What did you change and why? (optional)").fill(note);
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function addFeedback(page: Page, n: number, rating: "Improved" | "Worse" | "No change", note?: string) {
  await revisionCard(page, n)
    .getByRole("button", { name: `Add ride feedback to rev ${n}` })
    .click();
  const dialog = page.getByRole("dialog", { name: "Ride feedback" });
  await dialog.getByText(rating, { exact: true }).click();
  if (note) await label(dialog, "Notes (optional)").fill(note);
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("history, multiple feedback, comparison across setups, and restore", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-hist"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await addSetting(page, { name: "Rebound", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });
  await adjustValues(page, { "Left ski shock: Compression": "12", "Left ski shock: Rebound": "8" }, "Baseline");
  await adjustValues(page, { "Left ski shock: Rebound": "10" }, "More rebound");

  // History: newest first, what changed, who, when, mileage; the first revision started blank.
  const cards = suspensionPage(page).getByTestId("revision-history").getByTestId("revision");
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toHaveAttribute("data-number", "3");
  await expect(revisionCard(page, 3)).toContainText("Current");
  await expect(revisionCard(page, 3).getByTestId("revision-changes")).toContainText("Rebound: 8 → 10 Clicks");
  await expect(revisionCard(page, 3).getByTestId("revision-changes")).not.toContainText("Compression");
  await expect(revisionCard(page, 3).getByTestId("revision-note")).toHaveText("More rebound");
  await expect(revisionCard(page, 3).getByTestId("revision-meta")).toContainText("You");
  await expect(revisionCard(page, 3).getByTestId("revision-meta")).toContainText("2,000 mi");
  await expect(revisionCard(page, 2).getByTestId("revision-changes")).toContainText("Compression: set to 12 Clicks");
  await expect(revisionCard(page, 1).getByTestId("revision-changes")).toHaveText("Started blank.");
  await expect(revisionCard(page, 3).getByRole("button", { name: "Restore rev 3" })).toHaveCount(0);

  // Several feedback entries on one revision; edit and remove.
  await addFeedback(page, 2, "Improved", "Smooth on the trail");
  await addFeedback(page, 2, "Worse", "Harsh in the whoops");
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(2);
  await expect(revisionCard(page, 2).getByTestId("feedback-rating")).toHaveText(["Worse", "Improved"]);
  await revisionCard(page, 2)
    .getByRole("button", { name: /^Edit feedback/ })
    .first()
    .click();
  let dialog = page.getByRole("dialog", { name: "Edit feedback" });
  await label(dialog, "Notes (optional)").fill("Harsh in the whoops at speed");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(revisionCard(page, 2).getByTestId("feedback-note").first()).toHaveText("Harsh in the whoops at speed");
  page.once("dialog", (d) => d.accept());
  await revisionCard(page, 2)
    .getByRole("button", { name: /^Remove feedback/ })
    .last()
    .click();
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(1);
  await addFeedback(page, 2, "No change");
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(2);

  // Compare: rev 1 against the current revision.
  await revisionCard(page, 1).getByRole("button", { name: "Compare rev 1" }).click();
  const compare = suspensionPage(page).getByTestId("compare");
  await expect(compare.getByTestId("compare-summary")).toHaveText("2 settings differ");
  await expect(compare.getByTestId("compare-changed").getByTestId("compare-name")).toHaveText(["Compression", "Rebound"]);
  await expect(compare.getByTestId("compare-changed").getByTestId("compare-b")).toHaveText(["12 Clicks", "10 Clicks"]);
  await expect(compare.getByTestId("compare-changed").getByTestId("compare-a")).toHaveText(["—", "—"]);

  // Compare across setups: a copy of rev 2 as a new setup.
  await createSetup(page, "Powder", { copy: "Trail · Rev 2" });
  await label(compare, "Compare").selectOption({ label: "Powder · Rev 1 (current)" });
  await label(compare, "With").selectOption({ label: "Trail · Rev 3 (current)" });
  await expect(compare.getByTestId("compare-summary")).toHaveText("1 setting differs");
  await expect(compare.getByTestId("compare-changed").getByTestId("compare-name")).toHaveText(["Rebound"]);
  await expect(compare.getByTestId("compare-changed").getByTestId("compare-a")).toHaveText("8 Clicks");
  await compare.getByTestId("compare-same").locator("summary").click();
  await expect(compare.getByTestId("compare-same").getByTestId("compare-name")).toHaveText(["Compression"]);

  // Restore rev 2: a new revision with its values; nothing is erased.
  await setupTab(page, "Trail").click();
  await revisionCard(page, 2).getByRole("button", { name: "Restore rev 2" }).click();
  dialog = page.getByRole("dialog", { name: "Restore revision" });
  await expect(dialog.getByTestId("restore-changes")).toContainText("Rebound: 10 → 8 Clicks");
  await expect(label(dialog, "Mileage", true)).toHaveValue("2000");
  await dialog.getByRole("button", { name: "Restore rev 2" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(visible(page.getByTestId("adjust-notice"))).toContainText("Rev 2 restored as revision 4.");
  await expect(cards).toHaveCount(4);
  await expect(revisionCard(page, 4).getByTestId("restored-from")).toHaveText("Restored from rev 2");
  await expect(revisionCard(page, 4).getByTestId("revision-note")).toHaveText("Restored revision 2");
  await expect(revisionCard(page, 3).getByTestId("revision-note")).toHaveText("More rebound");
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(2);
  await expect(zoneValue(page, "Rebound")).toContainText("8");

  // Restoring values the setup already has is refused.
  await revisionCard(page, 2).getByRole("button", { name: "Restore rev 2" }).click();
  dialog = page.getByRole("dialog", { name: "Restore revision" });
  await expect(dialog.getByTestId("restore-changes")).toContainText("Rev 4 already has these values.");
  await dialog.getByRole("button", { name: "Restore rev 2" }).click();
  await expect(dialog.getByText("The latest revision already has these values.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(cards).toHaveCount(4);

  // Still no readings were created.
  await page.goto(`/garage/${sledId}`);
  await expect(visible(page.getByTestId("reading-history")).getByRole("listitem")).toHaveCount(1);
});

test("feedback and restore by role: mechanics add and edit their own; viewers only read", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-fb-o");
  const mechanicEmail = uniqueEmail("sus-fb-m");
  const viewerEmail = uniqueEmail("sus-fb-v");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "500", nickname: "Summit" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });
  await adjustValues(page, { "Left ski shock: Compression": "12" });
  await addFeedback(page, 2, "Improved", "Owner's ride");

  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  const [mechanic, viewer] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic: can't change the owner's feedback; adds and edits their own (but can't remove it); can restore.
  await openSuspension(mechanic, sledId);
  await expect(revisionCard(mechanic, 2).getByRole("button", { name: /^(Edit|Remove) feedback/ })).toHaveCount(0);
  await addFeedback(mechanic, 2, "No change", "Mechanic's ride");
  await expect(revisionCard(mechanic, 2).getByTestId("feedback")).toHaveCount(2);
  await expect(revisionCard(mechanic, 2).getByRole("button", { name: /^Edit feedback/ })).toHaveCount(1);
  await expect(revisionCard(mechanic, 2).getByRole("button", { name: /^Remove feedback/ })).toHaveCount(0);
  await revisionCard(mechanic, 2)
    .getByRole("button", { name: /^Edit feedback/ })
    .click();
  const dialog = mechanic.getByRole("dialog", { name: "Edit feedback" });
  await dialog.getByText("Worse", { exact: true }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(revisionCard(mechanic, 2).getByTestId("feedback-rating")).toHaveText(["Worse", "Improved"]);
  await revisionCard(mechanic, 1).getByRole("button", { name: "Restore rev 1" }).click();
  await mechanic.getByRole("dialog", { name: "Restore revision" }).getByRole("button", { name: "Restore rev 1" }).click();
  await expect(revisionCard(mechanic, 3).getByTestId("restored-from")).toHaveText("Restored from rev 1");

  // Viewer: sees history and feedback, can compare, but adds, edits or restores nothing.
  await openSuspension(viewer, sledId);
  await expect(revisionCard(viewer, 2).getByTestId("feedback")).toHaveCount(2);
  await expect(
    suspensionPage(viewer).getByRole("button", { name: /Add ride feedback|Restore rev|Edit feedback|Remove feedback/ }),
  ).toHaveCount(0);
  await revisionCard(viewer, 1).getByRole("button", { name: "Compare rev 1" }).click();
  await expect(suspensionPage(viewer).getByTestId("compare").getByTestId("compare-summary")).toHaveText("Same values in both.");

  await Promise.all(contexts.map((c) => c.close()));
});

// ---------------------------------------------------------------------------
// Checkpoint 5: photos, and Recently Deleted feedback
// ---------------------------------------------------------------------------
// A small valid PNG (8x6, solid color).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=", "base64");
const pngs = (count: number, prefix = "photo") =>
  Array.from({ length: count }, (_, n) => ({ name: `${prefix}-${n}.png`, mimeType: "image/png", buffer: PNG }));

async function openReferencePhotos(page: Page, setting: string) {
  await zonePanel(page)
    .getByRole("button", { name: `Reference photos of ${setting}` })
    .click();
  const dialog = page.getByRole("dialog", { name: "Reference photos" });
  await expect(dialog.getByTestId("photo-manager")).toBeVisible();
  return dialog;
}

async function openRevisionPhotos(page: Page, n: number) {
  await revisionCard(page, n)
    .getByRole("button", { name: `Photos of rev ${n}` })
    .click();
  const dialog = page.getByRole("dialog", { name: "Adjustment photos" });
  await expect(dialog.getByTestId("photo-manager")).toBeVisible();
  return dialog;
}

async function uploadIn(dialog: Locator, files: { name: string; mimeType: string; buffer: Buffer }[], expectSelected = files.length) {
  await dialog.locator('input[type="file"]').setInputFiles(files);
  await expect(dialog.getByTestId("new-photos").getByRole("listitem")).toHaveCount(expectSelected);
  await dialog.getByRole("button", { name: /^Upload \d+ photos?$/ }).click();
}

/** A signed-in API client (for checking what is in the bucket). */
async function apiAs(email: string) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return client;
}

test("reference and adjustment photos: limits, validation, removal and history", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-photo"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", nickname: "Blue" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });

  // Reference photos: up to 6 per setting.
  let dialog = await openReferencePhotos(page, "Compression");
  await expect(dialog.getByTestId("no-photos")).toBeVisible();
  await uploadIn(dialog, pngs(2));
  await expect(dialog.getByText("2 photos added.")).toBeVisible();
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(2);
  // Picking more than fit keeps only what fits (4 more).
  await uploadIn(dialog, pngs(5, "more"), 4);
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(6);
  await expect(dialog.getByText("This already has 6 photos.")).toBeVisible();
  // Photos open in full and can be removed by the owner.
  await expect(dialog.getByRole("link", { name: "Open photo 1 of Compression" })).toHaveAttribute("href", /suspension-photos/);
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Remove photo 6 of Compression" }).click();
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(5);
  // A file that isn't an image is refused before anything is uploaded.
  await uploadIn(dialog, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") }]);
  await expect(dialog.getByText("Choose an image file, such as a JPEG or PNG.")).toBeVisible();
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(5);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(zonePanel(page).getByRole("button", { name: "Reference photos of Compression" })).toHaveText("5 reference photos");

  // Adjustment photos are added while recording an adjustment.
  dialog = await openAdjust(page);
  await label(dialog, "Left ski shock: Compression", true).fill("12");
  await dialog.locator('input[type="file"]').setInputFiles(pngs(2, "adj"));
  await expect(dialog.getByTestId("new-photos").getByRole("listitem")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(visible(page.getByTestId("adjust-notice"))).toContainText("Adjustment saved as revision 2.");
  await expect(revisionCard(page, 2).getByTestId("revision-photos").getByTestId("photo")).toHaveCount(2);
  await expect(revisionCard(page, 1).getByTestId("revision-photos")).toHaveCount(0);

  // ... and later from the history; they stay with their revision.
  dialog = await openRevisionPhotos(page, 1);
  await uploadIn(dialog, pngs(1, "late"));
  await expect(dialog.getByText("1 photo added.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(revisionCard(page, 1).getByTestId("revision-photos").getByTestId("photo")).toHaveCount(1);
  await expect(revisionCard(page, 2).getByTestId("revision-photos").getByTestId("photo")).toHaveCount(2);
});

test("photos by role: mechanics add adjustment photos only; viewers only look", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-ph-o");
  const mechanicEmail = uniqueEmail("sus-ph-m");
  const viewerEmail = uniqueEmail("sus-ph-v");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2021", odometer: "800", nickname: "Rave" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });
  const owner = await openReferencePhotos(page, "Compression");
  await uploadIn(owner, pngs(1));
  await expect(owner.getByText("1 photo added.")).toBeVisible();

  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  const [mechanic, viewer] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic: sees reference photos but can't add or remove them; adds adjustment photos, can't remove them.
  await openSuspension(mechanic, sledId);
  let dialog = await openReferencePhotos(mechanic, "Compression");
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Add photos|Remove photo/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  dialog = await openRevisionPhotos(mechanic, 1);
  await uploadIn(dialog, pngs(1, "mech"));
  await expect(dialog.getByText("1 photo added.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Remove photo/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  // The storage policy refuses a mechanic's reference photo even outside the app.
  const api = await apiAs(mechanicEmail);
  const { data: setting } = await api.from("suspension_settings").select("id").eq("sled_id", sledId).single();
  const { error: refused } = await api.storage
    .from("suspension-photos")
    .upload(`${sledId}/${setting!.id}/00000000-0000-4000-8000-000000000001.jpg`, PNG, {
      contentType: "image/jpeg",
    });
  expect(refused).not.toBeNull();

  // Viewer: sees both kinds of photos, adds and removes nothing.
  await openSuspension(viewer, sledId);
  await expect(revisionCard(viewer, 1).getByTestId("revision-photos").getByTestId("photo")).toHaveCount(1);
  await expect(suspensionPage(viewer).getByRole("button", { name: /Remove photo/ })).toHaveCount(0);
  dialog = await openReferencePhotos(viewer, "Compression");
  await expect(dialog.getByTestId("photo-grid").getByTestId("photo")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Add photos|Remove photo/ })).toHaveCount(0);

  await Promise.all(contexts.map((c) => c.close()));
});

test("a photo for something removed meanwhile is refused before any file is uploaded", async ({ page, context }) => {
  const email = uniqueEmail("sus-orphan");
  await signUp(page, email);
  const sledId = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "100", nickname: "Side" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Preload", zone: "Left ski shock", chip: "Turns" });
  const dialog = await openReferencePhotos(page, "Preload");
  await dialog.locator('input[type="file"]').setInputFiles(pngs(1));

  // Meanwhile the setting is removed in another tab.
  const other = await context.newPage();
  await openSuspension(other, sledId);
  await suspensionPage(other).locator("summary", { hasText: "Customize settings" }).click();
  other.once("dialog", (d) => d.accept());
  await suspensionPage(other).getByRole("button", { name: "Remove Preload" }).click();
  await expect(zoneSettings(other, "front_left_shock")).toHaveCount(0);
  await other.close();

  await dialog.getByRole("button", { name: "Upload 1 photo" }).click();
  await expect(dialog.getByText("This was removed meanwhile. Reload the page and try again.")).toBeVisible();
  // Nothing reached the bucket.
  const api = await apiAs(email);
  const { data: setting } = await api.from("suspension_settings").select("id").eq("sled_id", sledId).single();
  const { data: files } = await api.storage.from("suspension-photos").list(`${sledId}/${setting!.id}`);
  expect(files ?? []).toHaveLength(0);
});

test("removed ride feedback is restored from Recently Deleted exactly as it was", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-fbdel"));
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "500", nickname: "Summit" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });
  await adjustValues(page, { "Left ski shock: Compression": "12" });
  await addFeedback(page, 2, "Worse", "Harsh in the whoops");
  const before = (await revisionCard(page, 2).getByTestId("feedback").textContent()) ?? "";

  page.once("dialog", (d) => d.accept());
  await revisionCard(page, 2)
    .getByRole("button", { name: /^Remove feedback/ })
    .click();
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(0);
  const item = deletedItems(page).filter({ hasText: "Worse · Trail rev 2" });
  await expect(item).toHaveAttribute("data-kind", "feedback");
  await expect(item).toContainText("Ride feedback · ridden");
  await expect(item).toContainText("“Harsh in the whoops”");
  await item.getByRole("button", { name: "Restore Worse · Trail rev 2" }).click();
  await expect(deletedItems(page)).toHaveCount(0);
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(1);
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveText(before);

  // Feedback that goes with its setup comes back with the setup (not listed on its own).
  await createSetup(page, "Powder", { activate: true });
  await setupTab(page, "Trail").click();
  page.once("dialog", (d) => d.accept());
  await selectedSetup(page).getByRole("button", { name: "Delete" }).click();
  await expect(deletedItems(page)).toHaveCount(1);
  await expect(deletedItems(page)).toHaveAttribute("data-kind", "setup");
});
