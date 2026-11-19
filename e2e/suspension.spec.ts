import AxeBuilder from "@axe-core/playwright";
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
  await visible(page.getByRole("link", { name: "Open suspension tuning for Blue" })).click();
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

// ---------------------------------------------------------------------------
// Checkpoint 5 follow-up: failed photo saves and cleanup, by role
// ---------------------------------------------------------------------------
const objectPath = (sledId: string, parentId: string) => `${sledId}/${parentId}/${crypto.randomUUID()}.jpg`;

test("mechanic: an adjustment photo for a revision removed meanwhile is refused before any file is uploaded", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-mo-o");
  const mechanicEmail = uniqueEmail("sus-mo-m");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2021", odometer: "800", nickname: "Rave" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });
  await createSetup(page, "Powder");

  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");

  // The mechanic picks a photo for Powder rev 1 ...
  await openSuspension(mechanic, sledId);
  await setupTab(mechanic, "Powder").click();
  const dialog = await openRevisionPhotos(mechanic, 1);
  await dialog.locator('input[type="file"]').setInputFiles(pngs(1));

  // ... while the owner deletes Powder (its revisions go with it).
  await setupTab(page, "Powder").click();
  page.once("dialog", (d) => d.accept());
  await selectedSetup(page).getByRole("button", { name: "Delete" }).click();
  await expect(setupTab(page, "Powder")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Upload 1 photo" }).click();
  await expect(dialog.getByText("This was removed meanwhile. Reload the page and try again.")).toBeVisible();

  // Nothing reached the bucket (checked as the owner, who can see deleted revisions).
  const api = await apiAs(ownerEmail);
  const { data: powder } = await api.from("suspension_setups").select("id").eq("sled_id", sledId).eq("name", "Powder").single();
  const { data: revision } = await api.from("suspension_revisions").select("id").eq("setup_id", powder!.id).single();
  const { data: files, error } = await api.storage.from("suspension-photos").list(`${sledId}/${revision!.id}`);
  expect(error).toBeNull();
  expect(files ?? []).toHaveLength(0);
  await mechanicContext.close();
});

test("a file whose record can't be saved: owners and editors remove it; a mechanic's stays for the Migration 8 cleanup", async ({
  page,
  browser,
}) => {
  // Same calls as the app (upload, then record, then remove on failure), made through
  // the API so the record save can be made to fail on purpose: the parent is deleted
  // between the upload and the save. Real storage policies and RLS apply throughout.
  const ownerEmail = uniqueEmail("sus-cl-o");
  const editorEmail = uniqueEmail("sus-cl-e");
  const mechanicEmail = uniqueEmail("sus-cl-m");
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
  const listed = async (folder: string) => ((await bucket(owner).list(folder)).data ?? []).map((f) => f.name);

  // --- Editor, reference photo: upload succeeds, the setting is removed, the save fails, the file is removed.
  const editorPath = objectPath(sledId, setting!.id);
  expect((await bucket(editor).upload(editorPath, PNG, { contentType: "image/jpeg" })).error).toBeNull();
  await owner.from("suspension_settings").update({ deleted_at: new Date().toISOString(), version: 1 }).eq("id", setting!.id);
  const editorSave = await editor
    .from("suspension_photos")
    .insert({ sled_id: sledId, setting_id: setting!.id, path: editorPath })
    .select("id");
  expect(editorSave.error?.message).toContain("Restore it before adding photos.");
  expect(await listed(`${sledId}/${setting!.id}`)).toHaveLength(1);
  const editorRemove = await bucket(editor).remove([editorPath]);
  expect(editorRemove.error).toBeNull();
  expect(editorRemove.data).toHaveLength(1);
  expect(await listed(`${sledId}/${setting!.id}`)).toHaveLength(0);

  // --- Owner, adjustment photo: same, removed again.
  const a = await newSetup("Trail");
  const ownerPath = objectPath(sledId, a.revisionId);
  expect((await bucket(owner).upload(ownerPath, PNG, { contentType: "image/jpeg" })).error).toBeNull();
  await owner.from("suspension_setups").update({ deleted_at: new Date().toISOString(), version: 1 }).eq("id", a.setupId);
  expect(
    (await owner.from("suspension_photos").insert({ sled_id: sledId, revision_id: a.revisionId, path: ownerPath })).error,
  ).not.toBeNull();
  expect((await bucket(owner).remove([ownerPath])).data).toHaveLength(1);
  expect(await listed(`${sledId}/${a.revisionId}`)).toHaveLength(0);

  // --- Mechanic, adjustment photo: the upload succeeds, both saves fail, and the remove is refused by the
  // storage policy (owners and editors only): the file stays, unreferenced, for the Migration 8 cleanup.
  const b = await newSetup("Powder");
  const mechanicPath = objectPath(sledId, b.revisionId);
  expect((await bucket(mechanic).upload(mechanicPath, PNG, { contentType: "image/jpeg" })).error).toBeNull();
  await owner.from("suspension_setups").update({ deleted_at: new Date().toISOString(), version: 1 }).eq("id", b.setupId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const save = await mechanic.from("suspension_photos").insert({ sled_id: sledId, revision_id: b.revisionId, path: mechanicPath });
    expect(save.error).not.toBeNull();
  }
  const mechanicRemove = await bucket(mechanic).remove([mechanicPath]);
  expect(mechanicRemove.data ?? []).toHaveLength(0); // nothing removed
  expect(await listed(`${sledId}/${b.revisionId}`)).toHaveLength(1);
  // No photo record points at it: this is what the Migration 8 sweep looks for.
  const { count } = await owner.from("suspension_photos").select("id", { count: "exact", head: true }).eq("path", mechanicPath);
  expect(count).toBe(0);
  // An owner (or the future cleanup job) can remove it.
  expect((await bucket(owner).remove([mechanicPath])).data).toHaveLength(1);
  expect(await listed(`${sledId}/${b.revisionId}`)).toHaveLength(0);

  await Promise.all(contexts.map((c) => c.close()));
});

// ---------------------------------------------------------------------------
// Checkpoint 6: sled page and Garage Board (Cards, Compact, Wall Display)
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

async function quickFeedback(page: Page, scope: Locator, sledName: string, rating: string) {
  await scope.getByRole("button", { name: `Add ride feedback on ${sledName}` }).click();
  const dialog = page.getByRole("dialog", { name: "Ride feedback" });
  await dialog.getByText(rating, { exact: true }).click();
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test("sled page: the Suspension section shows the active setup with quick adjust and feedback", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-page"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  const section = visible(page.locator("#suspension"));
  await expect(summaryIn(section).getByTestId("suspension-none")).toHaveText("No active setup");
  await expect(summaryIn(section).getByRole("button")).toHaveCount(0);

  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await addSetting(page, { name: "Preload", zone: "Rear track shock", chip: "Turns" });
  await createSetup(page, "Trail", { activate: true });

  await page.goto(`/garage/${sledId}`);
  await expect(summaryIn(section).getByTestId("suspension-active")).toHaveText("Trail · Rev 1");
  await expect(summaryIn(section)).toContainText("No ride feedback yet");

  // Adjust from the sled page: the collapsible form, the first zone open.
  await summaryIn(section).getByRole("button", { name: "Adjust suspension on Blue" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  await expect(zoneToggle(dialog, "front_left_shock")).toHaveAttribute("aria-expanded", "true");
  await expect(zoneToggle(dialog, "rear_rear_shock")).toHaveAttribute("aria-expanded", "false");
  await expect(label(dialog, "Mileage", true)).toHaveValue("2000");
  await label(dialog, "Left ski shock: Compression", true).fill("12");
  await zoneToggle(dialog, "rear_rear_shock").click();
  await label(dialog, "Rear track shock: Preload", true).fill("-1");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(summaryIn(section)).toContainText("Adjustment saved.");
  await expect(summaryIn(section).getByTestId("suspension-active")).toHaveText("Trail · Rev 2");

  await quickFeedback(page, summaryIn(section), "Blue", "Improved");
  await expect(summaryIn(section).getByTestId("suspension-feedback").getByTestId("feedback-rating")).toHaveText("Improved");

  await summaryIn(section).getByRole("button", { name: "View suspension setup on Blue" }).click();
  const view = page.getByRole("dialog", { name: "Suspension setup" });
  await expect(view.getByTestId("active-value")).toHaveText(["Compression12 Clicks", "Preload-1 Turns"]);
  await view.getByRole("button", { name: "Close" }).click();

  // Nothing else on the page changed: mileage, readings and Ready.
  await expect(visible(page.getByTestId("current-odometer"))).toHaveText("2,000 mi");
  await expect(visible(page.getByTestId("reading-history")).getByRole("listitem")).toHaveCount(1);
  await expect(visible(page.locator("#sled-name").locator("xpath=..").getByTestId("sled-status"))).toHaveAttribute("data-status", "ready");

  await summaryIn(section).getByRole("link", { name: "Open suspension tuning for Blue" }).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}/suspension$`));
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(1);
});

test("Garage Board: Cards, Compact and Wall Display show the setup; actions follow the role", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("sus-gb-o");
  const mechanicEmail = uniqueEmail("sus-gb-m");
  const viewerEmail = uniqueEmail("sus-gb-v");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "500", nickname: "Summit" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });

  // Cards (default).
  await page.goto("/garage/board");
  const card = garageSled(page, "Summit");
  await expect(summaryIn(card).getByTestId("suspension-active")).toHaveText("Trail · Rev 1");
  await quickAdjust(page, summaryIn(card), "Summit", { "Left ski shock: Compression": "10" });
  await expect(summaryIn(card).getByTestId("suspension-active")).toHaveText("Trail · Rev 2");
  // The rest of the board is unchanged (no tasks yet, Ready).
  await expect(card.getByTestId("sled-status")).toHaveAttribute("data-status", "ready");

  // Compact.
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  await quickFeedback(page, summaryIn(garageSled(page, "Summit")), "Summit", "Worse");
  await expect(summaryIn(garageSled(page, "Summit")).getByTestId("feedback-rating")).toHaveText("Worse");

  // Wall Display: large controls.
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  const adjust = summaryIn(garageSled(page, "Summit")).getByRole("button", { name: "Adjust suspension on Summit" });
  expect((await adjust.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await visible(page.getByRole("button", { name: "Exit wall display" })).click();
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Cards" }).click();

  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  const [mechanic, viewer] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic: adjusts and adds feedback from the board.
  await mechanic.goto("/garage/board");
  await quickAdjust(mechanic, summaryIn(garageSled(mechanic, "Summit")), "Summit", { "Left ski shock: Compression": "8" });
  await expect(summaryIn(garageSled(mechanic, "Summit")).getByTestId("suspension-active")).toHaveText("Trail · Rev 3");
  await quickFeedback(mechanic, summaryIn(garageSled(mechanic, "Summit")), "Summit", "Improved");

  // Viewer: sees the setup and its values; no adjust or feedback.
  await viewer.goto("/garage/board");
  const viewerSummary = summaryIn(garageSled(viewer, "Summit"));
  await expect(viewerSummary.getByTestId("suspension-active")).toHaveText("Trail · Rev 3");
  await expect(viewerSummary.getByRole("button", { name: /Adjust suspension|Add ride feedback/ })).toHaveCount(0);
  await viewerSummary.getByRole("button", { name: "View suspension setup on Summit" }).click();
  await expect(viewer.getByRole("dialog", { name: "Suspension setup" }).getByTestId("active-value")).toHaveText(["Compression8 Clicks"]);

  // My Snowmobiles is unchanged: no suspension there.
  await page.goto("/garage");
  await expect(visible(page.getByTestId("sled-card")).getByTestId("suspension-summary")).toHaveCount(0);
  await Promise.all(contexts.map((c) => c.close()));
});

test("Wall Display keyboard: ± only on suspension values; negatives save; mileage pads unchanged", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-kb"));
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2021", odometer: "800", hours: "40", nickname: "Rave" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Preload", zone: "Left ski shock", chip: "Turns" });
  await addSetting(page, { name: "Spring", zone: "Left ski shock", text: true });
  await createSetup(page, "Trail", { activate: true });

  await page.goto("/garage/board");
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  await summaryIn(garageSled(page, "Rave")).getByRole("button", { name: "Adjust suspension on Rave" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });

  // A suspension number: the number pad with ±.
  const preload = label(dialog, "Left ski shock: Preload", true);
  await preload.click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  await expect(keyboard(page)).toHaveAttribute("data-signed", "true");
  await tapKeys(page, ["1", "Decimal point", "5", "Plus or minus"]);
  await expect(preload).toHaveValue("-1.5");
  await tapKeys(page, ["Plus or minus"]);
  await expect(preload).toHaveValue("1.5");
  await tapKeys(page, ["Plus or minus"]);
  await expect(preload).toHaveValue("-1.5");
  await expect(dialog.getByTestId("adjust-changes")).toContainText("Preload: set to -1.5 Turns");

  // A suspension text value gets the full keyboard; mileage gets the number pad without ±.
  await label(dialog, "Left ski shock: Spring", true).click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "text");
  await label(dialog, "Mileage", true).click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  await expect(keyboard(page)).not.toHaveAttribute("data-signed", "true");
  await expect(keyboard(page).getByRole("button", { name: "Plus or minus" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await summaryIn(garageSled(page, "Rave")).getByRole("button", { name: "View suspension setup on Rave" }).click();
  await expect(page.getByRole("dialog", { name: "Suspension setup" }).getByTestId("active-value").first()).toHaveText("Preload-1.5 Turns");
  await page.getByRole("dialog", { name: "Suspension setup" }).getByRole("button", { name: "Close" }).click();

  // Update mileage / hours on the Wall Display: unchanged number pad, no ±.
  await garageSled(page, "Rave")
    .getByRole("button", { name: /Update mileage \/ hours/ })
    .click();
  const meters = page.getByRole("dialog", { name: "Update mileage / hours" });
  await label(meters, "Odometer (miles)").click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  await expect(keyboard(page).getByRole("button", { name: "Plus or minus" })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Checkpoint 7: roles end to end, keyboard sequences, accessibility
// ---------------------------------------------------------------------------
test("roles on the Garage Board and beyond: editor and owner full, mechanic adjusts, viewer reads, others nothing", async ({
  page,
  browser,
}) => {
  const ownerEmail = uniqueEmail("sus-r7-o");
  const editorEmail = uniqueEmail("sus-r7-e");
  const mechanicEmail = uniqueEmail("sus-r7-m");
  const viewerEmail = uniqueEmail("sus-r7-v");
  const strangerEmail = uniqueEmail("sus-r7-x");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Arctic Cat", model: "Riot", year: "2024", odometer: "300", nickname: "Riot" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await createSetup(page, "Trail", { activate: true });

  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const [editor, mechanic, viewer, stranger] = await Promise.all(contexts.map((c) => c.newPage()));
  await signUp(editor, editorEmail);
  await signUp(mechanic, mechanicEmail);
  await signUp(viewer, viewerEmail);
  await signUp(stranger, strangerEmail);
  await shareSled(ownerEmail, sledId, editorEmail, "editor");
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Editor, on the Garage Board: views, adjusts, adds feedback, opens the full page and manages there.
  await editor.goto("/garage/board");
  const editorBoard = summaryIn(garageSled(editor, "Riot"));
  await expect(editorBoard.getByTestId("suspension-active")).toHaveText("Trail · Rev 1");
  await editorBoard.getByRole("button", { name: "View suspension setup on Riot" }).click();
  await expect(editor.getByRole("dialog", { name: "Suspension setup" }).getByTestId("active-value")).toHaveText(["Compression—"]);
  await editor.getByRole("dialog", { name: "Suspension setup" }).getByRole("button", { name: "Close", exact: true }).click();
  await quickAdjust(editor, editorBoard, "Riot", { "Left ski shock: Compression": "11" });
  await expect(editorBoard.getByTestId("suspension-active")).toHaveText("Trail · Rev 2");
  await quickFeedback(editor, editorBoard, "Riot", "No change");
  await expect(editorBoard.getByTestId("feedback-rating")).toHaveText("No change");
  await editorBoard.getByRole("link", { name: "Open suspension tuning for Riot" }).click();
  await expect(editor).toHaveURL(new RegExp(`/garage/${sledId}/suspension$`));
  await expect(visible(editor.getByRole("button", { name: "New setup" }))).toBeVisible();
  await expect(visible(editor.getByRole("button", { name: "Add setting", exact: true }))).toBeVisible();
  await expect(suspensionPage(editor).getByRole("heading", { name: "Recently deleted" })).toBeVisible();

  // Owner keeps full access, including what the editor saved.
  await page.goto("/garage/board");
  const ownerBoard = summaryIn(garageSled(page, "Riot"));
  await expect(ownerBoard.getByRole("button", { name: /View suspension setup|Adjust suspension|Add ride feedback/ })).toHaveCount(3);
  await openSuspension(page, sledId);
  await expect(revisionCard(page, 2).getByTestId("feedback")).toHaveCount(1);
  await expect(selectedSetup(page).getByRole("button", { name: "Rename" })).toBeVisible();

  // Mechanic: adjusts and adds feedback; manages nothing.
  await mechanic.goto("/garage/board");
  const mechanicBoard = summaryIn(garageSled(mechanic, "Riot"));
  await expect(mechanicBoard.getByRole("button", { name: /View suspension setup|Adjust suspension|Add ride feedback/ })).toHaveCount(3);
  await openSuspension(mechanic, sledId);
  await expect(
    suspensionPage(mechanic).getByRole("button", { name: /New setup|Add setting|Set active|Rename|Delete|Restore Trail/ }),
  ).toHaveCount(0);
  await expect(suspensionPage(mechanic).getByRole("heading", { name: /Settings list|Recently deleted/ })).toHaveCount(0);

  // Viewer: read-only everywhere.
  await viewer.goto("/garage/board");
  const viewerBoard = summaryIn(garageSled(viewer, "Riot"));
  await expect(viewerBoard.getByRole("button")).toHaveText(["View setup"]);
  await openSuspension(viewer, sledId);
  await expect(
    suspensionPage(viewer).getByRole("button", {
      name: /Record adjustment|Add ride feedback|Restore rev|New setup|Add setting|Rename|Delete/,
    }),
  ).toHaveCount(0);

  // Someone without access: not on their board, no page, and the API refuses reads and writes.
  await stranger.goto("/garage/board");
  await expect(garage(stranger).getByRole("article", { name: "Riot" })).toHaveCount(0);
  await stranger.goto(`/garage/${sledId}/suspension`);
  await expect(stranger.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();
  const api = await apiAs(strangerEmail);
  for (const table of [
    "suspension_settings",
    "suspension_setups",
    "suspension_revisions",
    "suspension_feedback",
    "suspension_photos",
  ] as const) {
    const { data } = await api.from(table).select("id").eq("sled_id", sledId);
    expect(data ?? []).toHaveLength(0);
  }
  expect((await api.from("suspension_settings").insert({ sled_id: sledId, name: "Sneaky", zone: "rear_general" })).error).not.toBeNull();
  const owner = await apiAs(ownerEmail);
  const { data: setup } = await owner.from("suspension_setups").select("id").eq("sled_id", sledId).single();
  const { data: latest } = await owner
    .from("suspension_revisions")
    .select("id")
    .eq("setup_id", setup!.id)
    .order("revision_number", { ascending: false })
    .limit(1)
    .single();
  const attempt = await api.rpc("save_suspension_revision", {
    p_setup_id: setup!.id,
    p_base_revision_id: latest!.id,
    p_changes: {},
    p_idempotency_key: crypto.randomUUID(),
  });
  expect(attempt.error).not.toBeNull();
  expect((await api.rpc("activate_suspension_setup", { p_setup_id: setup!.id })).error).not.toBeNull();
  expect((await api.storage.from("suspension-photos").list(sledId)).data ?? []).toHaveLength(0);

  await Promise.all(contexts.map((c) => c.close()));
});

test("Wall Display keyboard: only valid numbers can be typed; invalid text is refused on save", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-seq"));
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2021", odometer: "800", nickname: "Rave" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Preload", zone: "Left ski shock", chip: "Turns" });
  await createSetup(page, "Trail", { activate: true });
  await page.goto("/garage/board");
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await summaryIn(garageSled(page, "Rave")).getByRole("button", { name: "Adjust suspension on Rave" }).click();
  const dialog = page.getByRole("dialog", { name: "Record adjustment" });
  const preload = label(dialog, "Left ski shock: Preload", true);
  await preload.click();
  await expect(keyboard(page)).toHaveAttribute("data-signed", "true");

  const typed = async (keys: string[]) => {
    await tapKeys(page, ["Clear", ...keys]);
    return preload.inputValue();
  };
  const pm = "Plus or minus";
  const dot = "Decimal point";
  expect(await typed(["1", dot, "5"])).toBe("1.5");
  expect(await typed(["1", dot, "5", pm])).toBe("-1.5");
  expect(await typed(["0", dot, "5"])).toBe("0.5");
  expect(await typed([pm, "0", dot, "5"])).toBe("-0.5");
  expect(await typed(["1", "2"])).toBe("12");
  // 4-3-12 and 1.2.3 can't be typed on the pad.
  expect(await typed(["4", pm, "3", pm, "1", "2"])).toBe("4312");
  expect(await typed(["1", dot, "2", dot, "3"])).toBe("1.23");
  // A digit typed in front of the minus goes after it.
  await typed([pm, "1", "2"]);
  await preload.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
  await tapKeys(page, ["3"]);
  await expect(preload).toHaveValue("-312");
  // The Save row stays above the keyboard.
  const keyboardTop = (await keyboard(page).boundingBox())!.y;
  const save = dialog.getByRole("button", { name: "Save adjustment" });
  expect((await save.boundingBox())!.y + (await save.boundingBox())!.height).toBeLessThanOrEqual(keyboardTop + 1);

  // Typed with a physical keyboard instead, invalid text is flagged and never saved.
  for (const bad of ["4-3-12", "1.2.3"]) {
    await preload.fill(bad);
    await expect(dialog.getByText("Enter a number for Preload.")).toBeVisible();
    await save.click();
    await expect(dialog.getByText("Enter a number for Preload.")).toBeVisible();
    await expect(dialog).toBeVisible();
  }
  await preload.fill("-0.5");
  await save.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(summaryIn(garageSled(page, "Rave")).getByTestId("suspension-active")).toHaveText("Trail · Rev 2");
});

// Pre-existing, app-wide: white text on the brand accent (#ff3b1f) is 3.56:1. Reported
// separately (a design-token change for every screen); all other rules are checked.
const axeFor = (page: Page, include: string) => new AxeBuilder({ page }).include(include).disableRules(["color-contrast"]);
const violations = async (builder: AxeBuilder) =>
  (await builder.analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

test("accessibility: suspension screens pass automated checks; no sideways scrolling; 44 px targets", async ({ page }) => {
  await signUp(page, uniqueEmail("sus-a11y"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Blue" });
  await openSuspension(page, sledId);
  await addSetting(page, { name: "Compression", zone: "Left ski shock", chip: "Clicks" });
  await addSetting(page, { name: "Spring", zone: "Springs & limiter strap", text: true });
  await createSetup(page, "Trail", { activate: true });
  await adjustValues(page, { "Left ski shock: Compression": "12" }, "Baseline");
  await addFeedback(page, 2, "Improved", "Smooth");

  const noSidewaysScroll = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const smallTargets = (scope: string) =>
    page.evaluate((sel) => {
      const out: string[] = [];
      for (const root of document.querySelectorAll(sel))
        for (const el of root.querySelectorAll<HTMLElement>("button, a, select, summary, input:not([type=hidden]):not(.sr-only)")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height && (r.width < 43.5 || r.height < 43.5))
            out.push(`${el.tagName} ${el.getAttribute("aria-label") ?? el.textContent}`);
        }
      return out;
    }, scope);

  // The Suspension page, and its sheets (focus moves into each).
  await expect(await violations(axeFor(page, '[data-testid="suspension-page"]'))).toEqual([]);
  await noSidewaysScroll();
  expect(await smallTargets('[data-testid="suspension-page"]')).toEqual([]);
  for (const [button, title] of [
    ["Record adjustment", "Record adjustment"],
    ["Add ride feedback to rev 2", "Ride feedback"],
    ["Restore rev 1", "Restore revision"],
    ["Photos of rev 2", "Adjustment photos"],
  ] as const) {
    await suspensionPage(page).getByRole("button", { name: button }).first().click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
    await expect(await violations(axeFor(page, "dialog[open]"))).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  // A small phone (360 px): history metadata never runs under the feedback buttons; no sideways scrolling.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 360, height: 740 });
  await noSidewaysScroll();
  const overlaps = await page.evaluate(() => {
    let n = 0;
    for (const li of document.querySelectorAll('[data-testid="feedback"]')) {
      const text = li.querySelector("p")!.getBoundingClientRect();
      for (const b of li.querySelectorAll("button")) {
        const r = b.getBoundingClientRect();
        if (r.width && r.left < text.right && r.right > text.left && r.top < text.bottom && r.bottom > text.top) n++;
      }
    }
    return n;
  });
  expect(overlaps).toBe(0);
  await page.setViewportSize(size);

  // The sled page section and the Garage Board.
  await page.goto(`/garage/${sledId}`);
  await expect(await violations(axeFor(page, "#suspension"))).toEqual([]);
  expect(await smallTargets("#suspension")).toEqual([]);
  await noSidewaysScroll();
  await page.goto("/garage/board");
  await expect(await violations(axeFor(page, '[data-testid="suspension-summary"]'))).toEqual([]);
  expect(await smallTargets('[data-testid="suspension-summary"]')).toEqual([]);
  await noSidewaysScroll();
});
