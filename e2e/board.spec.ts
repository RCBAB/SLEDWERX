import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Needs the local Supabase stack with Migration 5.
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

const board = (page: Page) => visible(page.getByTestId("maintenance-board"));
const rows = (page: Page) => board(page).getByTestId("board-row");
const row = (page: Page, task: string) => rows(page).filter({ has: page.getByText(task, { exact: true }) });
const history = (page: Page) => page.locator("#service-history").getByTestId("service-record");

type Schedule = {
  task?: string;
  newTask?: string;
  miles?: string;
  hours?: string;
  every?: string;
  unit?: "Days" | "Weeks" | "Months";
  season?: { month: string; day: string };
  before?: { date?: string; miles?: string; hours?: string };
};

async function fillSchedule(dialog: Locator, s: Schedule) {
  if (s.miles !== undefined) await label(dialog, "Every … miles", true).fill(s.miles);
  if (s.hours !== undefined) await label(dialog, "Every … engine hours", true).fill(s.hours);
  if (s.every !== undefined) await label(dialog, "Every …", true).fill(s.every);
  if (s.unit) await label(dialog, "Days, weeks or months").selectOption({ label: s.unit });
  if (s.season) {
    await label(dialog, "Once a season").check();
    await label(dialog, "Due by month").selectOption({ label: s.season.month });
    await label(dialog, "Day", true).fill(s.season.day);
  }
  if (s.before) {
    const details = dialog.locator("details");
    if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) await details.locator("summary").click();
    if (s.before.date) await label(dialog, "Date", true).fill(s.before.date);
    if (s.before.miles) await label(dialog, "Miles then").fill(s.before.miles);
    if (s.before.hours) await label(dialog, "Hours then").fill(s.before.hours);
  }
}

async function addToBoard(page: Page, s: Schedule) {
  await visible(board(page).getByRole("button", { name: "Add to board" })).first().click();
  const dialog = page.getByRole("dialog", { name: "Add to board" });
  if (s.task) await label(dialog, "Task", true).selectOption({ label: s.task });
  if (s.newTask) await label(dialog, "New task", true).fill(s.newTask);
  await fillSchedule(dialog, s);
  await dialog.getByRole("button", { name: "Add to board" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, (s.newTask ?? s.task)!)).toBeVisible();
}

async function markDone(page: Page, task: string, input: { date?: string; odometer?: string; unknown?: boolean } = {}) {
  await row(page, task).getByRole("button", { name: `Mark ${task} done` }).click();
  const dialog = page.getByRole("dialog", { name: task });
  if (input.date) await label(dialog, "Date", true).fill(input.date);
  if (input.unknown) await label(dialog, "Mileage unknown").check();
  if (input.odometer !== undefined) await label(dialog, "Mileage (odometer)").fill(input.odometer);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

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

test("the board shows every task in color order, and Mark Done updates it", async ({ page }) => {
  await signUp(page, uniqueEmail("board"));
  await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150" });

  // The board is the first section on the sled page.
  await expect(board(page)).toBeVisible();
  await expect(board(page)).toContainText("Nothing on the board yet");
  await noSidewaysScroll(page);

  await addToBoard(page, { newTask: "Grease suspension", miles: "1000", before: { miles: "1900" } });
  await addToBoard(page, { newTask: "Wax hood" });
  await addToBoard(page, { newTask: "Change oil", miles: "1000", before: { miles: "900" } });
  await addToBoard(page, { newTask: "Track tension", miles: "500", before: { miles: "1520" } });
  await addToBoard(page, { newTask: "Inspect belt", every: "12", unit: "Months" });

  // Red, then yellow (no record first), then green, then not scheduled.
  await expect(rows(page)).toHaveCount(5);
  await expect.poll(() => rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual([
    "overdue",
    "no_record",
    "upcoming",
    "good",
    "unscheduled",
  ]);
  const status = (task: string) => row(page, task).getByTestId("board-status");
  await expect(status("Change oil")).toHaveText("Overdue by 100 mi");
  await expect(status("Inspect belt")).toHaveText("No record yet");
  await expect(status("Track tension")).toHaveText("Due in 20 mi");
  await expect(status("Grease suspension")).toHaveText("Next due in 900 mi");
  await expect(status("Wax hood")).toHaveText("Not scheduled");
  await expect(row(page, "Change oil").getByTestId("board-last-done")).toContainText("Done before SledWerx");
  await expect(row(page, "Inspect belt").getByTestId("board-last-done")).toHaveText("Never done in SledWerx");
  await noSidewaysScroll(page);

  // Every row's text, the interval line ("Every 1,000 mi") included, meets WCAG AA contrast.
  await expect(row(page, "Change oil")).toContainText("Every 1,000 mi");
  const contrast = await new AxeBuilder({ page }).include('[data-testid="maintenance-board"]').withRules(["color-contrast"]).analyze();
  expect(contrast.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);

  // Mark Done defaults to today and the current mileage and hours.
  await row(page, "Change oil").getByRole("button", { name: "Mark Change oil done" }).click();
  const dialog = page.getByRole("dialog", { name: "Change oil" });
  await expect(label(dialog, "Date", true)).toHaveValue(await localDate(page));
  await expect(label(dialog, "Mileage (odometer)")).toHaveValue("2000");
  await expect(label(dialog, "Engine hours (optional)")).toHaveValue("150");
  await noSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // It becomes an ordinary service record, and the board recalculates.
  await expect(status("Change oil")).toHaveText("Next due in 1,000 mi");
  await expect(row(page, "Change oil")).toHaveAttribute("data-status", "good");
  await expect(row(page, "Change oil").getByTestId("board-last-done")).toContainText("2,000 mi");
  await expect(history(page).filter({ hasText: "Change oil" })).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute("data-status", "no_record");

  // An older (backdated) service leaves the board on the newest one.
  await markDone(page, "Change oil", { date: await localDate(page, 60), unknown: true });
  await expect(history(page).filter({ hasText: "Change oil" })).toHaveCount(2);
  await expect(status("Change oil")).toHaveText("Next due in 1,000 mi");
  await expect(row(page, "Change oil").getByTestId("board-last-done")).toContainText("2,000 mi");

  // A service without mileage is never given an estimated mileage.
  await markDone(page, "Grease suspension", { date: await localDate(page, 3), unknown: true });
  await expect(status("Grease suspension")).toHaveText("Mileage unknown");
  await expect(row(page, "Grease suspension").getByTestId("board-last-done")).toContainText("mileage unknown");
  await expect(row(page, "Grease suspension")).not.toContainText("1,900");
});

test("several tasks or a package are completed in one service record", async ({ page }) => {
  await signUp(page, uniqueEmail("board-multi"));
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "800" });

  // Tasks and a package from the library.
  await page.goto("/garage/library");
  for (const task of ["Check track tension", "Grease suspension", "Inspect belt"]) {
    await label(page, "New task", true).fill(task);
    await visible(page.getByRole("button", { name: "Add task" })).click();
    await expect(page.getByTestId("library-tasks")).toContainText(task);
  }
  await label(page, "New package", true).fill("Preseason service");
  await visible(page.getByRole("button", { name: "Add package" })).click();
  const pkg = page.getByTestId("package-card").filter({ hasText: "Preseason service" });
  for (const task of ["Check track tension", "Inspect belt"]) {
    await label(pkg, "Add a task to Preseason service").selectOption({ label: task });
    await pkg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pkg.getByRole("listitem").filter({ hasText: task })).toBeVisible();
  }

  await page.goto(`/garage/${sledId}`);
  await addToBoard(page, { task: "Check track tension", miles: "500" });
  await addToBoard(page, { task: "Grease suspension", miles: "1000" });
  await addToBoard(page, { task: "Inspect belt", every: "1", unit: "Months" });
  await expect(rows(page)).toHaveCount(3);

  // Select two, then Done: one record with both tasks.
  await visible(board(page).getByRole("button", { name: "Select", exact: true })).click();
  await board(page).getByRole("button", { name: "Select Check track tension" }).click();
  await board(page).getByRole("button", { name: "Select Grease suspension" }).click();
  await board(page).getByRole("button", { name: "Done (2)" }).click();
  const dialog = page.getByRole("dialog", { name: "Mark done" });
  await expect(dialog.getByTestId("done-tasks").getByRole("listitem")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(history(page)).toHaveCount(1);
  for (const task of ["Check track tension", "Grease suspension"]) {
    await expect(row(page, task)).toHaveAttribute("data-status", "good");
    await expect(row(page, task).getByTestId("board-last-done")).toContainText("Last done");
  }
  await expect(row(page, "Inspect belt")).toHaveAttribute("data-status", "no_record");

  // Complete a package.
  await visible(board(page).getByRole("button", { name: "Complete package" })).click();
  const sheet = page.getByRole("dialog", { name: "Complete package" });
  await expect(label(sheet, "Check track tension")).toBeChecked();
  await expect(label(sheet, "Inspect belt")).toBeChecked();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(history(page)).toHaveCount(2);
  await expect(history(page).filter({ hasText: "Preseason service" })).toHaveCount(1);
  await expect(row(page, "Inspect belt")).toHaveAttribute("data-status", "good");
});

test("schedules can be changed, paused, made seasonal, and removed", async ({ page }) => {
  await signUp(page, uniqueEmail("board-sched"));
  await addSled(page, { make: "Arctic Cat", model: "Riot", year: "2021", odometer: "3000" });
  await addToBoard(page, { newTask: "Change chaincase oil", miles: "1000", before: { miles: "1500" } });
  await addToBoard(page, { newTask: "Preseason check", season: { month: "November", day: "1" } });
  await expect(row(page, "Change chaincase oil")).toHaveAttribute("data-status", "overdue");
  await expect(row(page, "Preseason check")).toContainText("Once a season by Nov 1");

  // Pause it: kept on the board, never due, sorted last.
  await row(page, "Change chaincase oil").getByRole("button", { name: "Schedule for Change chaincase oil" }).click();
  let dialog = page.getByRole("dialog", { name: "Change chaincase oil" });
  await expect(label(dialog, "Every … miles", true)).toHaveValue("1000");
  await label(dialog, "Paused").check();
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Change chaincase oil")).toHaveAttribute("data-status", "paused");
  await expect(rows(page).last()).toContainText("Change chaincase oil");

  // Change the interval.
  await row(page, "Change chaincase oil").getByRole("button", { name: "Schedule for Change chaincase oil" }).click();
  dialog = page.getByRole("dialog", { name: "Change chaincase oil" });
  await label(dialog, "Paused").uncheck();
  await label(dialog, "Every … miles", true).fill("2000");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Change chaincase oil").getByTestId("board-status")).toHaveText("Next due in 500 mi");

  // A season date that doesn't exist is refused.
  await row(page, "Preseason check").getByRole("button", { name: "Schedule for Preseason check" }).click();
  dialog = page.getByRole("dialog", { name: "Preseason check" });
  await label(dialog, "Due by month").selectOption({ label: "February" });
  await label(dialog, "Day", true).fill("30");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog).toContainText("That day isn't in that month.");

  // Remove it from the board: the history is kept.
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Remove from board" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Preseason check")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
});

test("mechanics can mark tasks done; viewers only see the board", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("board-owner");
  const mechanicEmail = uniqueEmail("board-mech");
  const viewerEmail = uniqueEmail("board-view");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "1000" });
  await addToBoard(page, { newTask: "Change oil", miles: "500", before: { miles: "100" } });

  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  await mechanic.goto(`/garage/${sledId}`);
  await expect(row(mechanic, "Change oil")).toHaveAttribute("data-status", "overdue");
  await expect(board(mechanic).getByRole("button", { name: "Add to board" })).toHaveCount(0);
  await expect(board(mechanic).getByRole("button", { name: "Schedule for Change oil" })).toHaveCount(0);
  await markDone(mechanic, "Change oil");
  await expect(row(mechanic, "Change oil")).toHaveAttribute("data-status", "good");

  await viewer.goto(`/garage/${sledId}`);
  await expect(row(viewer, "Change oil")).toHaveAttribute("data-status", "good");
  await expect(board(viewer).getByRole("button")).toHaveCount(0);

  await page.reload();
  await expect(row(page, "Change oil")).toHaveAttribute("data-status", "good");

  await mechanicContext.close();
  await viewerContext.close();
});
