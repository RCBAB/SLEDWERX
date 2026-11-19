import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

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
