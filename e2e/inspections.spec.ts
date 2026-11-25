import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, signUp, uniqueEmail } from "./helpers";

// Maintenance inspection & replacement tracking (Migration 13, PR 2): the
// card's two schedules, Checked / Replaced, Needs Replacement, Quick Check,
// the offer after a mileage update, starting points, correcting a check, and
// the Garage Board / wall display. Needs the local Supabase stack.
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));
const choose = (scope: Locator, text: string) => scope.getByText(text, { exact: true }).click();

const board = (page: Page) => visible(page.getByTestId("maintenance-board"));
const rows = (page: Page) => board(page).getByTestId("board-row");
const row = (page: Page, task: string) => rows(page).filter({ has: page.getByText(task, { exact: true }) });
const history = (page: Page) => page.locator("#service-history").getByTestId("service-record");

function localDate(page: Page, daysAgo = 0) {
  return page.evaluate((n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toLocaleDateString("en-CA");
  }, daysAgo);
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

type Start = { kind: "Known" | "Start tracking now" | "Unknown"; date?: string; miles?: string };
type Part = { miles?: string; every?: string; unit?: "Days" | "Weeks" | "Months"; eachReading?: boolean; start?: Start };

async function fillPart(section: Locator, part: Part) {
  if (part.miles !== undefined) await label(section, "Every … miles", true).fill(part.miles);
  if (part.every !== undefined) await label(section, "Every …", true).fill(part.every);
  if (part.unit) await label(section, "Days, weeks or months").selectOption({ label: part.unit });
  if (part.eachReading) await label(section, "Every mileage update").check();
  if (part.start) {
    await choose(section, part.start.kind);
    if (part.start.date) await section.getByLabel(/: date$/).fill(part.start.date);
    if (part.start.miles) await label(section, "Miles then").fill(part.start.miles);
  }
}

/** Add to board with what's tracked and each schedule. */
async function addTracked(page: Page, name: string, tracks: "Inspection only" | "Both", check: Part, replace: Part = {}) {
  await visible(board(page).getByRole("button", { name: "Add to board" }))
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add to board" });
  await label(dialog, "New task", true).fill(name);
  await choose(dialog, tracks);
  await fillPart(dialog.getByTestId("check-schedule"), check);
  if (tracks === "Both") await fillPart(dialog.getByTestId("replacement-schedule"), replace);
  await dialog.getByRole("button", { name: "Add to board" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, name)).toBeVisible();
}

async function addReplacement(page: Page, name: string, miles: string) {
  await visible(board(page).getByRole("button", { name: "Add to board" }))
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add to board" });
  await label(dialog, "New task", true).fill(name);
  await label(dialog, "Every … miles", true).fill(miles);
  await dialog.getByRole("button", { name: "Add to board" }).click();
  await expect(dialog).toBeHidden();
}

async function checked(page: Page, task: string, outcome: "Good" | "Needs Replacement") {
  await row(page, task)
    .getByRole("button", { name: `Checked: ${task}` })
    .click();
  const dialog = page.getByRole("dialog", { name: task });
  await choose(dialog, outcome);
  await dialog.getByRole("button", { name: "Save check" }).click();
  await expect(dialog).toBeHidden();
}

async function updateMileage(page: Page, odometer: string) {
  await visible(page.getByRole("button", { name: /^Update mileage \/ hours for / }))
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Update mileage / hours" });
  await label(dialog, "Odometer (miles)").fill(odometer);
  await dialog.getByRole("button", { name: "Save" }).click();
}

test("converting an item, Checked, Needs Replacement, Replaced, and correcting a check", async ({ page }) => {
  await signUp(page, uniqueEmail("insp-card"));
  await addSled(page, { make: "Polaris", model: "RMK", year: "2023", odometer: "2000", hours: "100" });
  await addReplacement(page, "Change oil", "1000");
  await addReplacement(page, "Drive belt", "1000");

  // Convert the belt to inspection only (Decision D): its schedule moves across.
  await row(page, "Drive belt").getByRole("button", { name: "Schedule for Drive belt" }).click();
  const schedule = page.getByRole("dialog", { name: "Drive belt" });
  await choose(schedule, "Inspection only");
  const checkSchedule = schedule.getByTestId("check-schedule");
  await expect(label(checkSchedule, "Every … miles", true)).toHaveValue("1000");
  await expect(checkSchedule.getByRole("radio", { name: "Unknown" })).toBeChecked();
  await expect(schedule.getByTestId("replacement-schedule")).toHaveCount(0);
  await noSidewaysScroll(page);
  await schedule.getByRole("button", { name: "Save schedule" }).click();
  await expect(schedule).toBeHidden();

  // Unknown history asks for an initial check; Checked replaces Done (Decision E).
  const belt = row(page, "Drive belt");
  await expect(belt).toHaveAttribute("data-tracks", "inspection");
  await expect(belt).toHaveAttribute("data-status", "check_due");
  await expect(belt.getByTestId("check-status")).toHaveText("Initial check needed");
  await expect(belt.getByTestId("check-last")).toHaveText("Never checked");
  await expect(belt).toContainText("Check: every 1,000 mi");
  await expect(belt.getByRole("button", { name: "Mark Drive belt done" })).toHaveCount(0);
  await expect(belt.getByRole("button", { name: "Replaced: Drive belt" })).toHaveCount(0);
  // A replacement-only item is unchanged.
  await expect(row(page, "Change oil")).toHaveAttribute("data-tracks", "replacement");
  await expect(row(page, "Change oil").getByRole("button", { name: "Mark Change oil done" })).toBeVisible();
  await expect(visible(board(page).getByRole("button", { name: "Quick Check (1)" }))).toBeVisible();

  // Checked: date and mileage filled in; Needs Replacement flags the item, first on the board.
  await belt.getByRole("button", { name: "Checked: Drive belt" }).click();
  const check = page.getByRole("dialog", { name: "Drive belt" });
  await expect(label(check, "Date", true)).toHaveValue(await localDate(page));
  await expect(label(check, "Mileage (odometer)")).toHaveValue("2000");
  await expect(check.getByText("Skip", { exact: true })).toHaveCount(0);
  await noSidewaysScroll(page);
  await choose(check, "Needs Replacement");
  await check.getByRole("button", { name: "Save check" }).click();
  await expect(check).toBeHidden();
  await expect(belt.getByTestId("needs-replacement")).toBeVisible();
  await expect(belt).toHaveAttribute("data-status", "needs_replacement");
  await expect(rows(page).first()).toContainText("Drive belt");
  await expect(belt.getByTestId("check-last")).toContainText("2,000 mi");
  await expect(belt.getByTestId("check-last")).toContainText("Needs Replacement");
  await expect(history(page).first()).toContainText("Inspection");
  await expect(history(page).first().getByTestId("service-task")).toContainText("Drive belt · Checked · Needs Replacement");

  // A later Good check does not clear it.
  await checked(page, "Drive belt", "Good");
  await expect(belt.getByTestId("check-last")).toContainText("Good");
  await expect(belt.getByTestId("needs-replacement")).toBeVisible();

  // Replaced (the existing Mark Done form) clears it.
  await belt.getByRole("button", { name: "Replaced: Drive belt" }).click();
  const replaced = page.getByRole("dialog", { name: "Drive belt" });
  await expect(replaced).toContainText("resets both schedules");
  await replaced.getByRole("button", { name: "Save" }).click();
  await expect(replaced).toBeHidden();
  await expect(belt.getByTestId("needs-replacement")).toHaveCount(0);
  // On an inspection only item a replacement counts as the latest check (Decision D).
  await expect(belt.getByTestId("check-last")).toContainText("Last done");
  await expect(belt.getByRole("button", { name: "Replaced: Drive belt" })).toHaveCount(0);

  // A mistaken Needs Replacement, corrected on the record (Decision G), is recalculated.
  await checked(page, "Drive belt", "Needs Replacement");
  await expect(belt.getByTestId("needs-replacement")).toBeVisible();
  const mistaken = history(page).first();
  await mistaken.locator("summary").click();
  await mistaken.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/service\/[0-9a-f-]{36}\/edit$/);
  const outcome = visible(page.getByTestId("check-outcome"));
  await expect(outcome.getByRole("radio", { name: "Needs Replacement" })).toBeChecked();
  await choose(outcome, "Good");
  await visible(page.getByRole("button", { name: "Save changes" })).click();
  await expect(page).toHaveURL(/\?service=updated/);
  await expect(row(page, "Drive belt").getByTestId("needs-replacement")).toHaveCount(0);
  await expect(row(page, "Drive belt").getByTestId("check-last")).toContainText("Good");
  const corrected = history(page).first();
  await corrected.locator("summary").click();
  await expect(corrected.getByTestId("service-task")).toContainText("Drive belt · Checked · Good");
  await expect(corrected).toContainText(/Edited /);

  // With nothing due, a mileage update just closes.
  await updateMileage(page, "2100");
  await expect(page.getByRole("dialog", { name: "Update mileage / hours" })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Inspections due" })).toHaveCount(0);
  await expect(page.getByTestId("current-odometer")).toHaveText("2,100 mi");
});

test("Quick Check, Mark All as Good, Skip, starting points and the offer after a mileage update", async ({ page }) => {
  await signUp(page, uniqueEmail("insp-quick"));
  await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2024", odometer: "1000", hours: "50" });

  // Starting points: start tracking now, known, unknown.
  await addTracked(page, "Spark plugs", "Inspection only", { eachReading: true, start: { kind: "Unknown" } });
  await addTracked(page, "Chaincase", "Inspection only", { every: "1", unit: "Months", start: { kind: "Start tracking now" } });
  await addTracked(
    page,
    "Ski carbides",
    "Both",
    { every: "1", unit: "Months", start: { kind: "Known", date: await localDate(page, 40) } },
    { miles: "2000", start: { kind: "Start tracking now" } },
  );
  await addTracked(page, "Track", "Inspection only", { miles: "500", start: { kind: "Known", miles: "500" } });
  await addTracked(page, "Bogie wheels", "Inspection only", { every: "1", unit: "Months", start: { kind: "Unknown" } });

  await expect(row(page, "Spark plugs").getByTestId("check-status")).toHaveText("Initial check needed");
  await expect(row(page, "Chaincase").getByTestId("check-status")).toHaveText("Next check in 30 days");
  await expect(row(page, "Chaincase").getByTestId("check-last")).toContainText("Tracking since");
  await expect(row(page, "Chaincase")).toHaveAttribute("data-status", "good");
  await expect(row(page, "Ski carbides").getByTestId("check-status")).toContainText("Check overdue by");
  await expect(row(page, "Ski carbides").getByTestId("replace-status")).toHaveText("Replace in 2,000 mi");
  await expect(row(page, "Ski carbides").getByTestId("replace-last")).toContainText("Tracking since");
  await expect(row(page, "Ski carbides").getByTestId("replace-last")).not.toContainText("Replaced");
  await expect(row(page, "Track")).toHaveAttribute("data-status", "upcoming");
  await expect(row(page, "Bogie wheels").getByTestId("check-status")).toHaveText("Initial check needed");

  // Quick Check: due items first, due soon set to Skip (Decision F).
  await visible(board(page).getByRole("button", { name: "Quick Check (3)" })).click();
  const quick = page.getByRole("dialog", { name: "Quick Check" });
  const items = quick.getByTestId("check-item");
  await expect(items).toHaveCount(4);
  await expect(items.nth(3)).toContainText("Track");
  await expect(items.nth(3)).toContainText("Due soon");
  await expect(items.nth(3).getByRole("radio", { name: "Skip" })).toBeChecked();
  await expect(items.nth(0).getByRole("radio", { name: "Good" })).not.toBeChecked();
  await noSidewaysScroll(page);
  await quick.getByRole("button", { name: "Mark All as Good" }).click();
  await expect(items.nth(3).getByRole("radio", { name: "Skip" })).toBeChecked();
  const bogie = items.filter({ hasText: "Bogie wheels" });
  await choose(bogie, "Needs Replacement");
  await bogie.getByRole("button", { name: "Add a note" }).click();
  await label(bogie, "Note for Bogie wheels (optional)").fill("Two cracked");
  await quick.getByRole("button", { name: "Save checks (3)" }).click();
  await expect(quick).toBeHidden();

  await expect(row(page, "Spark plugs").getByTestId("check-status")).toHaveText("Check at the next mileage update");
  await expect(row(page, "Ski carbides").getByTestId("check-last")).toContainText("Good");
  await expect(row(page, "Bogie wheels").getByTestId("needs-replacement")).toBeVisible();
  await expect(row(page, "Track")).toHaveAttribute("data-status", "upcoming");
  await expect(history(page)).toHaveCount(1);
  await expect(history(page).first().getByTestId("service-task").filter({ hasText: "Bogie wheels" })).toContainText(
    "Checked · Needs Replacement · Two cracked",
  );
  await expect(visible(board(page).getByRole("button", { name: /^Quick Check/ }))).toHaveCount(0);

  // A mileage update offers Quick Check when checks are due; Later leaves them outstanding.
  await updateMileage(page, "1010");
  const offer = page.getByRole("dialog", { name: "Inspections due" });
  await expect(offer).toContainText("2 inspections are due. Quick Check now?");
  await offer.getByRole("button", { name: "Later" }).click();
  await expect(offer).toBeHidden();
  await expect(row(page, "Spark plugs").getByTestId("check-status")).toHaveText("Check due: mileage updated");
  await expect(visible(board(page).getByRole("button", { name: "Quick Check (2)" }))).toBeVisible();

  // Or straight into Quick Check.
  await updateMileage(page, "1020");
  await page.getByRole("dialog", { name: "Inspections due" }).getByRole("button", { name: "Quick Check" }).click();
  const after = page.getByRole("dialog", { name: "Quick Check" });
  await expect(label(after, "Mileage (odometer)")).toHaveValue("1020");
  await expect(after.getByTestId("check-item")).toHaveCount(2);
  await after.getByRole("button", { name: "Mark All as Good" }).click();
  await after.getByRole("button", { name: "Save checks (2)" }).click();
  await expect(after).toBeHidden();
  await expect(visible(board(page).getByRole("button", { name: /^Quick Check/ }))).toHaveCount(0);

  // Every Mileage Update: due again after the next one.
  await updateMileage(page, "1030");
  const again = page.getByRole("dialog", { name: "Inspections due" });
  await expect(again).toContainText("1 inspection is due.");
  await again.getByRole("button", { name: "Later" }).click();
  await expect(again).toBeHidden();
  await expect(row(page, "Spark plugs").getByTestId("check-status")).toHaveText("Check due: mileage updated");
});

test("Garage Board cards, compact chips and the wall display", async ({ page }) => {
  await signUp(page, uniqueEmail("insp-garage"));
  await addSled(page, { make: "Arctic Cat", model: "Catalyst", year: "2025", odometer: "500", nickname: "Cat" });
  await addReplacement(page, "Change oil", "1000");
  await addTracked(page, "Drive belt", "Both", { every: "1", unit: "Months", start: { kind: "Unknown" } }, { miles: "3000" });

  await page.goto("/garage/board");
  const garage = visible(page.getByTestId("garage-board"));
  const task = (name: string) => garage.getByTestId("garage-task").filter({ has: page.getByText(name, { exact: true }) });
  await expect(task("Drive belt")).toHaveAttribute("data-tracks", "both");
  await expect(task("Drive belt").getByTestId("check-status")).toHaveText("Initial check needed");
  await expect(task("Drive belt").getByRole("button", { name: "Replaced: Drive belt on Cat" })).toBeVisible();
  await expect(task("Change oil").getByRole("button", { name: "Mark Change oil done on Cat" })).toBeVisible();
  await expect(garage.getByTestId("sled-overall")).toContainText("1 check due");
  await noSidewaysScroll(page);

  // Compact: chips.
  await garage.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  await expect(garage).toHaveAttribute("data-layout", "compact");
  await expect(task("Drive belt").getByTestId("tracking-chips")).toHaveText("Initial check");
  await noSidewaysScroll(page);

  // Wall display: large touch targets; Quick Check works there too.
  await garage.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Cards" }).click();
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage).toHaveAttribute("data-wall", "on");
  const checkedButton = task("Drive belt").getByRole("button", { name: "Checked: Drive belt on Cat" });
  expect((await checkedButton.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await garage.getByRole("button", { name: "Quick Check on Cat: 1 due" }).click();
  const quick = page.getByRole("dialog", { name: "Quick Check" });
  const good = quick.getByTestId("check-item").getByText("Good", { exact: true });
  expect((await good.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await good.click();
  await quick.getByRole("button", { name: "Save checks (1)" }).click();
  await expect(quick).toBeHidden();
  await expect(task("Drive belt").getByTestId("check-last")).toContainText("Good");
  await expect(garage.getByRole("button", { name: /^Quick Check on Cat/ })).toHaveCount(0);
  await noSidewaysScroll(page);
});
