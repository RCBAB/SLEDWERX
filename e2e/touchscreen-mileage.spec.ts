import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, addSled, hasSupabase, shareSled, signIn, signUp, uniqueEmail } from "./helpers";

// Phase 5.1: Update Mileage / Hours, service notes, and the Wall Display keyboard.
// Needs the local Supabase stack (no new migration).
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

const garage = (page: Page) => visible(page.getByTestId("garage-board"));
const garageSled = (page: Page, name: string) => garage(page).getByRole("article", { name, exact: true });
const garageTask = (page: Page, sled: string, task: string) =>
  garageSled(page, sled).getByTestId("garage-task").filter({ has: page.getByText(task, { exact: true }) });
const sledBoard = (page: Page) => visible(page.getByTestId("maintenance-board"));
const sledTask = (page: Page, task: string) =>
  sledBoard(page).getByTestId("board-row").filter({ has: page.getByText(task, { exact: true }) });
const records = (page: Page) => page.locator("#service-history").getByTestId("service-record");
const keyboard = (page: Page) => page.getByTestId("wall-keyboard");

async function addToBoard(page: Page, task: string, miles: string, before: string) {
  await visible(sledBoard(page).getByRole("button", { name: "Add to board" })).first().click();
  const dialog = page.getByRole("dialog", { name: "Add to board" });
  await label(dialog, "New task", true).fill(task);
  await label(dialog, "Every … miles", true).fill(miles);
  await dialog.locator("details summary").click();
  await label(dialog, "Miles then").fill(before);
  await dialog.getByRole("button", { name: "Add to board" }).click();
  await expect(dialog).toBeHidden();
}

/** Opens Update mileage / hours for a sled (sled page or Garage Board). */
async function openMeters(scope: Page | Locator, page: Page, sledName: string) {
  await visible(scope.getByRole("button", { name: `Update mileage / hours for ${sledName}` })).first().click();
  const dialog = page.getByRole("dialog", { name: "Update mileage / hours" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openRecord(page: Page, title: string) {
  const item = records(page).filter({ hasText: title }).first();
  if (!(await item.evaluate((d: HTMLDetailsElement) => d.open))) await item.locator("summary").click();
  return item;
}

/** Taps on-screen keys in order. */
async function tapKeys(page: Page, keys: string[]) {
  for (const key of keys) await keyboard(page).getByRole("button", { name: key, exact: true }).click();
}

async function bottomOf(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return box.y + box.height;
}

test("sled page: Update Mileage / Hours beside Log service; Reading history kept", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("mu-owner");
  const mechanicEmail = uniqueEmail("mu-mech");
  const viewerEmail = uniqueEmail("mu-view");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Big Blue" });

  // The button sits with Log service; the old inline entry form is gone.
  const actions = visible(page.getByRole("button", { name: "Log service" })).locator("xpath=..");
  await expect(actions.getByRole("button", { name: "Update mileage / hours for Big Blue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save reading" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Reading history" })).toBeVisible();
  await expect(page.getByTestId("fix-reading")).toBeVisible();

  // Hours only: the mileage stays, and only hours are recorded.
  let dialog = await openMeters(page, page, "Big Blue");
  await expect(label(dialog, "Odometer (miles)")).toHaveValue("2000");
  await expect(label(dialog, "Engine hours")).toHaveValue("150");
  await label(dialog, "Engine hours").fill("152.5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("current-hours")).toHaveText("152.5 hrs");
  await expect(page.getByTestId("current-odometer")).toHaveText("2,000 mi");
  const history = page.getByTestId("reading-history").getByRole("listitem");
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("152.5 hrs");
  await expect(history.first()).not.toContainText("2,000 mi");

  // Nothing changed: nothing saved.
  dialog = await openMeters(page, page, "Big Blue");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Nothing changed.", { exact: false })).toBeVisible();
  // Lower hours are refused (on the server), mileage untouched.
  await label(dialog, "Engine hours").fill("150");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Engine hours can't be lower than the current 152.5 hrs.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(history).toHaveCount(2);

  // Mechanics can update readings; viewers can't.
  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  await mechanic.goto(`/garage/${sledId}`);
  dialog = await openMeters(mechanic, mechanic, "Big Blue");
  await label(dialog, "Odometer (miles)").fill("2050");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(mechanic.getByTestId("current-odometer")).toHaveText("2,050 mi");

  await viewer.goto(`/garage/${sledId}`);
  await expect(viewer.getByTestId("current-odometer")).toHaveText("2,050 mi");
  await expect(viewer.getByRole("button", { name: /Update mileage \/ hours/ })).toHaveCount(0);
  await viewer.goto("/garage/board");
  await expect(garageSled(viewer, "Big Blue").getByRole("button", { name: /Update mileage \/ hours/ })).toHaveCount(0);

  await mechanicContext.close();
  await viewerContext.close();
});

test("Garage Board: update readings from Cards and Compact; statuses and the sled page follow", async ({ page }) => {
  await signUp(page, uniqueEmail("mu-board"));
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "2000", hours: "100", nickname: "Summit" });
  await addToBoard(page, "Change oil", "500", "1800");
  await page.goto("/garage/board");
  await expect(garageTask(page, "Summit", "Change oil")).toHaveAttribute("data-status", "good");

  // Full Cards: more miles make it overdue.
  let dialog = await openMeters(garageSled(page, "Summit"), page, "Summit");
  await label(dialog, "Odometer (miles)").fill("2350");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageSled(page, "Summit").getByTestId("sled-meters")).toHaveText("2,350 mi · 100 hrs");
  await expect(garageTask(page, "Summit", "Change oil")).toHaveAttribute("data-status", "overdue");
  await expect(garageTask(page, "Summit", "Change oil").getByTestId("board-status")).toHaveText("Overdue by 50 mi");

  // Compact: hours only.
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  dialog = await openMeters(garageSled(page, "Summit"), page, "Summit");
  await label(dialog, "Engine hours").fill("104");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageSled(page, "Summit").getByTestId("sled-meters")).toHaveText("2,350 mi · 104 hrs");
  // A lower mileage is refused here too.
  dialog = await openMeters(garageSled(page, "Summit"), page, "Summit");
  await label(dialog, "Odometer (miles)").fill("2300");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Mileage can't be lower than the current 2,350 mi.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The sled page shows the same.
  await page.goto(`/garage/${sledId}`);
  await expect(page.getByTestId("current-odometer")).toHaveText("2,350 mi");
  await expect(page.getByTestId("current-hours")).toHaveText("104 hrs");
  await expect(sledTask(page, "Change oil")).toHaveAttribute("data-status", "overdue");
});

test("a confirmed meter reset is the only way to enter a lower reading", async ({ page }) => {
  await signUp(page, uniqueEmail("mu-reset"));
  await addSled(page, { make: "Lynx", model: "Rave", year: "2020", odometer: "4000", hours: "300", nickname: "Rave" });
  const dialog = await openMeters(page, page, "Rave");
  await label(dialog, "Engine hours").fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Engine hours can't be lower", { exact: false })).toBeVisible();
  await dialog.getByText("More options").click();
  await label(dialog, "The hour meter was replaced or reset").check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Confirm that the meter was replaced or reset.")).toBeVisible();
  await expect(page.getByTestId("current-hours")).toHaveText("300 hrs");
  await label(dialog, "Yes, the meter was replaced or reset").check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("current-hours")).toHaveText("2 hrs");
  await expect(page.getByText("300 hrs lifetime").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("4,000 mi");
  await expect(page.getByTestId("reading-history").getByRole("listitem").first()).toContainText("Hour meter replaced");
});

test("notes are saved with Done and Complete package, on the sled page and the Garage Board", async ({ page }) => {
  await signUp(page, uniqueEmail("mu-notes"));
  await page.goto("/garage/library");
  await label(page, "New task", true).fill("Grease suspension");
  await visible(page.getByRole("button", { name: "Add task" })).click();
  await label(page, "New package", true).fill("Weekly check");
  await visible(page.getByRole("button", { name: "Add package" })).click();
  const pkg = page.getByTestId("package-card").filter({ hasText: "Weekly check" });
  await label(pkg, "Add a task to Weekly check").selectOption({ label: "Grease suspension" });
  await pkg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(pkg.getByRole("listitem").filter({ hasText: "Grease suspension" })).toBeVisible();

  const sledId = await addSled(page, { make: "Arctic Cat", model: "Riot", year: "2021", odometer: "900", nickname: "Riot" });
  await addToBoard(page, "Change oil", "1000", "500");

  // Sled page: Done with a note.
  await sledTask(page, "Change oil").getByRole("button", { name: "Mark Change oil done" }).click();
  let dialog = page.getByRole("dialog", { name: "Change oil" });
  await label(dialog, "Notes (optional)").fill("Used 5W-40 synthetic.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(await openRecord(page, "Change oil")).toContainText("Used 5W-40 synthetic.");

  // Garage Board: Complete package with a note.
  await page.goto("/garage/board");
  await garageSled(page, "Riot").getByRole("button", { name: "Complete package on Riot" }).click();
  dialog = page.getByRole("dialog", { name: "Complete package" });
  await label(dialog, "Notes (optional)").fill("Left front shock is weeping.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await page.goto(`/garage/${sledId}`);
  await expect(await openRecord(page, "Weekly check")).toContainText("Left front shock is weeping.");
  await expect(records(page)).toHaveCount(2);
});

test("Wall Display keyboard: number pad and full keyboard, never covering the form", async ({ page }) => {
  await signUp(page, uniqueEmail("mu-kb"));
  const sledId = await addSled(page, { make: "Polaris", model: "Indy", year: "2024", odometer: "1000", hours: "50", nickname: "Indy" });
  await addToBoard(page, "Change oil", "500", "600");

  // Never on the sled page or the ordinary Garage Board.
  let dialog = await openMeters(page, page, "Indy");
  await label(dialog, "Odometer (miles)").click();
  await expect(label(dialog, "Odometer (miles)")).toBeFocused();
  await expect(keyboard(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.goto("/garage/board");
  dialog = await openMeters(garageSled(page, "Indy"), page, "Indy");
  await label(dialog, "Odometer (miles)").click();
  await expect(keyboard(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  // Wall Display: on by default; the number pad for mileage.
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  await expect(garage(page).getByRole("button", { name: "Keyboard: On" })).toHaveAttribute("aria-pressed", "true");
  dialog = await openMeters(garageSled(page, "Indy"), page, "Indy");
  const odometer = label(dialog, "Odometer (miles)");
  await odometer.click();
  await expect(keyboard(page)).toBeVisible();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  // The system touch keyboard (e.g. Windows) is kept closed while ours shows.
  await expect(odometer).toHaveAttribute("inputmode", "none");
  await tapKeys(page, ["Clear", "1", "2", "0", "5", "Decimal point", "5", "Decimal point", "9", "Backspace"]);
  await expect(odometer).toHaveValue("1205.5");
  await expect(odometer).toBeFocused();
  // Field, its hint and the Save row stay above the keyboard.
  const keyboardTop = (await keyboard(page).boundingBox())!.y;
  expect(await bottomOf(odometer)).toBeLessThanOrEqual(keyboardTop);
  expect(await bottomOf(dialog.getByRole("button", { name: "Save" }))).toBeLessThanOrEqual(keyboardTop);
  // Keys never submit the form; Save does.
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(keyboard(page)).toHaveCount(0);
  await expect(garageTask(page, "Indy", "Change oil")).toHaveAttribute("data-status", "overdue");

  // A validation message stays visible above the keyboard.
  dialog = await openMeters(garageSled(page, "Indy"), page, "Indy");
  await label(dialog, "Engine hours").click();
  await tapKeys(page, ["Clear", "4", "0"]);
  await dialog.getByRole("button", { name: "Save" }).click();
  const message = dialog.getByText("Engine hours can't be lower", { exact: false });
  await expect(message).toBeVisible();
  await label(dialog, "Engine hours").click();
  await expect(keyboard(page)).toBeVisible();
  expect(await bottomOf(message)).toBeLessThanOrEqual((await keyboard(page).boundingBox())!.y);
  // Esc closes the keyboard first, then the dialog.
  await page.keyboard.press("Escape");
  await expect(keyboard(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");

  // The full keyboard for notes, in Done.
  await garageTask(page, "Indy", "Change oil").getByRole("button", { name: "Mark Change oil done on Indy" }).click();
  dialog = page.getByRole("dialog", { name: "Change oil" });
  const mileage = label(dialog, "Mileage (odometer)");
  await mileage.click();
  await expect(keyboard(page)).toHaveAttribute("data-mode", "decimal");
  await expect(mileage).toHaveAttribute("inputmode", "none");
  const notes = label(dialog, "Notes (optional)");
  await notes.click();
  // Moving on gives the previous field its own inputmode back.
  await expect(mileage).toHaveAttribute("inputmode", "decimal");
  await expect(keyboard(page)).toHaveAttribute("data-mode", "text");
  await tapKeys(page, ["Shift", "N", "e", "w", "Space", "f", "i", "l", "t", "e", "r", "Numbers and symbols", "!", "Letters"]);
  await expect(notes).toHaveValue("New filter!");
  expect(await bottomOf(notes)).toBeLessThanOrEqual((await keyboard(page).boundingBox())!.y);
  // A physical keyboard types normally and the on-screen one steps aside.
  await page.keyboard.type(" Torque 20");
  await expect(notes).toHaveValue("New filter! Torque 20");
  await expect(keyboard(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageTask(page, "Indy", "Change oil")).toHaveAttribute("data-status", "good");

  // Switching it off is remembered (also in a new sign-in).
  await garage(page).getByRole("button", { name: "Keyboard: On" }).click();
  await expect(garage(page).getByRole("button", { name: "Keyboard: Off" })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(garage(page).getByRole("button", { name: "Keyboard: Off" })).toBeVisible({ timeout: 2000 });
  }).toPass();
  dialog = await openMeters(garageSled(page, "Indy"), page, "Indy");
  await label(dialog, "Odometer (miles)").click();
  await expect(keyboard(page)).toHaveCount(0);
  await expect(label(dialog, "Odometer (miles)")).toHaveAttribute("inputmode", "decimal");

  // The note made it into the service history.
  await page.goto(`/garage/${sledId}`);
  await expect(await openRecord(page, "Change oil")).toContainText("New filter! Torque 20");
});

test("keyboard preference follows the account", async ({ page, browser }) => {
  const email = uniqueEmail("mu-kbpref");
  await signUp(page, email);
  await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "500", nickname: "Sidewinder" });
  await page.goto("/garage/board?display=wall");
  await garage(page).getByRole("button", { name: "Keyboard: On" }).click();
  await expect(garage(page).getByRole("button", { name: "Keyboard: Off" })).toBeVisible();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/login");
  await signIn(otherPage, email, PASSWORD);
  await expect(otherPage).toHaveURL(/\/garage$/);
  await expect(async () => {
    await otherPage.goto("/garage/board?display=wall");
    await expect(garage(otherPage).getByRole("button", { name: "Keyboard: Off" })).toBeVisible({ timeout: 2000 });
  }).toPass();
  await other.close();
});
