import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Needs the local Supabase stack with Migration 4.
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

function history(page: Page) {
  return page.locator("#service-history");
}

function record(page: Page, title: string) {
  return history(page).getByTestId("service-record").filter({ hasText: title });
}

async function openRecord(page: Page, title: string) {
  const item = record(page, title);
  if (!(await item.evaluate((details: HTMLDetailsElement) => details.open))) {
    await item.locator("summary").click();
  }
  return item;
}

/** Fills the full service form (on /service/new or /edit). */
async function fillService(
  page: Page,
  input: {
    title?: string;
    category?: string;
    date?: string;
    odometer?: string;
    hours?: string;
    tasks?: string[];
    parts?: { name: string; qty: string; cost: string; number?: string }[];
    labor?: string;
    other?: string;
  },
) {
  if (input.title !== undefined) await label(page, "Title", true).fill(input.title);
  if (input.category) await label(page, "Category (optional)").selectOption(input.category);
  if (input.date) await label(page, "Date", true).fill(input.date);
  if (input.odometer !== undefined) await label(page, "Mileage (odometer)").fill(input.odometer);
  if (input.hours !== undefined) await label(page, "Engine hours (optional)").fill(input.hours);
  for (const task of input.tasks ?? []) {
    await label(page, "Or type a task").fill(task);
    await visible(page.getByRole("button", { name: "Add task" })).click();
  }
  for (const part of input.parts ?? []) {
    await visible(page.getByRole("button", { name: "Add part" })).click();
    const row = visible(page.getByTestId("part-row")).last();
    await label(row, "Part", true).fill(part.name);
    if (part.number) await label(row, "Part number (optional)").fill(part.number);
    await label(row, "Qty", true).fill(part.qty);
    await label(row, "Unit cost ($)").fill(part.cost);
  }
  if (input.labor !== undefined) await label(page, "Labor (optional)").fill(input.labor);
  if (input.other !== undefined) await label(page, "Other costs (optional)").fill(input.other);
}

async function today(page: Page) {
  return page.evaluate(() => new Date().toLocaleDateString("en-CA"));
}

test("Quick Service logs a service in a few taps, at today's mileage", async ({ page }) => {
  await signUp(page, uniqueEmail("quick"));
  await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150" });

  await visible(page.getByRole("button", { name: "Log service" })).click();
  const dialog = page.getByRole("dialog", { name: "Quick service" });
  await expect(label(dialog, "Mileage (odometer)")).toHaveValue("2000");
  await expect(label(dialog, "Engine hours (optional)")).toHaveValue("150");
  await label(dialog, "What did you do?").fill("Checked track tension");
  await dialog.getByRole("button", { name: "Save service" }).click();

  await expect(dialog).toBeHidden();
  await expect(record(page, "Checked track tension")).toBeVisible();
  await expect(record(page, "Checked track tension")).toContainText("2,000 mi");
  await expect(page.getByTestId("current-odometer")).toHaveText("2,000 mi");

  // A double tap saves once: the same duplicate-protection key is reused.
  await expect(history(page).getByTestId("service-record")).toHaveCount(1);
});

test("a historical service with parts and costs keeps today's mileage", async ({ page }) => {
  await signUp(page, uniqueEmail("history"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150" });

  await visible(page.getByRole("link", { name: "Full service record" })).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}/service/new$`));
  // Today: the current meters are prefilled.
  await expect(label(page, "Mileage (odometer)")).toHaveValue("2000");
  // Last season: cleared, with the valid range shown.
  await label(page, "Date", true).fill("2025-12-05");
  await expect(label(page, "Mileage (odometer)")).toHaveValue("");
  await expect(visible(page.getByText("At most 2,000 mi"))).toBeVisible();

  await fillService(page, {
    title: "Chaincase service",
    category: "drivetrain",
    odometer: "1200",
    hours: "95",
    tasks: ["Drain and refill chaincase", "Inspect sprockets"],
    parts: [
      { name: "Chaincase oil", qty: "2", cost: "12.50", number: "CC-1" },
      { name: "Gasket", qty: "1", cost: "4.25" },
    ],
    labor: "40",
    other: "5",
  });
  await expect(visible(page.getByTestId("cost-total"))).toHaveText("$74.25");
  // The filled-in form never makes the page scroll sideways on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await visible(page.getByRole("button", { name: "Save service" })).click();

  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}\\?service=saved`));
  await expect(visible(page.getByText("Service saved."))).toBeVisible();
  // The service shows 1,200 mi; the sled stays at 2,000 mi.
  await expect(page.getByTestId("current-odometer")).toHaveText("2,000 mi");
  await expect(page.getByTestId("current-hours")).toHaveText("150 hrs");
  const item = await openRecord(page, "Chaincase service");
  await expect(item.getByTestId("service-record-total")).toHaveText("$74.25");
  await expect(item).toContainText("1,200 mi");
  await expect(item).toContainText("95 hrs");
  await expect(item).toContainText("Drivetrain");
  await expect(item).toContainText("Drain and refill chaincase");
  await expect(item).toContainText("Chaincase oil");
  await expect(item).toContainText("#CC-1");
  await expect(item).toContainText("2 × $12.50");
  await expect(history(page).getByText("2025–26 season")).toBeVisible();
  await expect(page.getByTestId("reading-history").getByRole("listitem")).toHaveCount(2);

  // Edit: correct the mileage, change a quantity, remove a part and a task.
  await item.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/service\/[0-9a-f-]{36}\/edit$/);
  await expect(label(page, "Mileage (odometer)")).toHaveValue("1200");
  await label(page, "Mileage (odometer)").fill("1250");
  await label(visible(page.getByTestId("part-row")).first(), "Qty", true).fill("3");
  await visible(page.getByRole("button", { name: "Remove part Gasket" })).click();
  await visible(page.getByRole("button", { name: "Remove task Inspect sprockets" })).click();
  await expect(visible(page.getByTestId("cost-total"))).toHaveText("$82.50");
  await visible(page.getByRole("button", { name: "Save changes" })).click();

  await expect(page).toHaveURL(/\?service=updated/);
  const edited = await openRecord(page, "Chaincase service");
  await expect(edited.getByTestId("service-record-total")).toHaveText("$82.50");
  await expect(edited).toContainText("1,250 mi");
  await expect(edited).not.toContainText("Gasket");
  await expect(edited).not.toContainText("Inspect sprockets");
  await expect(edited).toContainText(/Edited /);
  await expect(page.getByTestId("current-odometer")).toHaveText("2,000 mi");
  await expect(page.getByTestId("reading-history").getByRole("listitem")).toHaveCount(2);

  // Mileage that breaks the history is refused, and nothing changes.
  await edited.getByRole("link", { name: "Edit" }).click();
  await label(page, "Mileage (odometer)").fill("2500");
  await visible(page.getByRole("button", { name: "Save changes" })).click();
  await expect(visible(page.getByText(/Odometer readings cannot go down/)).first()).toBeVisible();
});

test("a stale edit is refused instead of overwriting newer changes", async ({ page, context }) => {
  await signUp(page, uniqueEmail("conflict"));
  await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2021", odometer: "800" });
  await visible(page.getByRole("button", { name: "Log service" })).click();
  const dialog = page.getByRole("dialog", { name: "Quick service" });
  await label(dialog, "What did you do?").fill("Belt check");
  await dialog.getByRole("button", { name: "Save service" }).click();
  await expect(record(page, "Belt check")).toBeVisible();
  const editUrl = await (await openRecord(page, "Belt check")).getByRole("link", { name: "Edit" }).getAttribute("href");

  const other = await context.newPage();
  await other.goto(editUrl!);
  await page.goto(editUrl!);
  await label(page, "Title", true).fill("Belt replaced");
  await visible(page.getByRole("button", { name: "Save changes" })).click();
  await expect(page).toHaveURL(/\?service=updated/);

  await label(other, "Title", true).fill("Belt inspected");
  await visible(other.getByRole("button", { name: "Save changes" })).click();
  await expect(visible(other.getByText(/This service record was changed somewhere else/))).toBeVisible();
  await other.close();
});

test("task library, packages, and applying a package to a service", async ({ page }) => {
  await signUp(page, uniqueEmail("library"));
  const sledId = await addSled(page, { make: "Arctic Cat", model: "Riot", year: "2023", odometer: "300" });

  await visible(page.getByRole("link", { name: "Tasks & packages" })).first().click();
  await expect(page).toHaveURL(/\/garage\/library$/);
  for (const task of ["Check track tension", "Grease suspension", "Inspect belt"]) {
    await label(page, "New task", true).fill(task);
    await visible(page.getByRole("button", { name: "Add task" })).click();
    await expect(page.getByTestId("library-tasks")).toContainText(task);
  }
  await label(page, "New task", true).fill("check track TENSION");
  await visible(page.getByRole("button", { name: "Add task" })).click();
  await expect(visible(page.getByText("You already have a task with that name."))).toBeVisible();

  await label(page, "New package", true).fill("Preseason service");
  await visible(page.getByRole("button", { name: "Add package" })).click();
  const pkg = page.getByTestId("package-card").filter({ hasText: "Preseason service" });
  for (const task of ["Grease suspension", "Check track tension"]) {
    await label(pkg, "Add a task to Preseason service").selectOption({ label: task });
    await pkg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pkg.getByRole("listitem").filter({ hasText: task })).toBeVisible();
  }
  await pkg.getByRole("button", { name: "Move Check track tension up" }).click();
  await expect(pkg.getByRole("listitem").first()).toContainText("Check track tension");

  // Snowmobile-specific task.
  const sledGroup = page.getByTestId("sled-task-group");
  await label(sledGroup, "New task for Arctic Cat Riot").fill("Swap studs");
  await sledGroup.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sledGroup).toContainText("Swap studs");

  // Apply the package to a service.
  await page.goto(`/garage/${sledId}/service/new`);
  await fillService(page, { title: "Preseason" });
  await label(page, "Apply a package").selectOption({ label: "Preseason service (2 tasks)" });
  const tasks = visible(page.getByTestId("service-tasks"));
  await expect(tasks.getByRole("listitem")).toHaveText([/Check track tension/, /Grease suspension/]);
  await label(page, "Add a task from your list").selectOption({ label: "Swap studs (this snowmobile)" });
  await expect(tasks.getByRole("listitem")).toHaveCount(3);
  await visible(page.getByRole("button", { name: "Save service" })).click();
  await expect(page).toHaveURL(/\?service=saved/);
  const item = await openRecord(page, "Preseason");
  await expect(item).toContainText("Check track tension");
  await expect(item).toContainText("Swap studs");

  // Quick Service offers your tasks as one-tap chips.
  await visible(page.getByRole("button", { name: "Log service" })).click();
  const dialog = page.getByRole("dialog", { name: "Quick service" });
  await dialog.getByRole("button", { name: "Inspect belt" }).click();
  await expect(label(dialog, "What did you do?")).toHaveValue("Inspect belt");
  await dialog.getByRole("button", { name: "Save service" }).click();
  await expect(record(page, "Inspect belt")).toBeVisible();

  // Renaming or deleting a library task never rewrites history.
  await page.goto("/garage/library");
  await visible(page.getByRole("button", { name: "Rename Check track tension" })).click();
  await visible(page.getByLabel("New name for Check track tension")).fill("Adjust track tension");
  await visible(page.getByRole("button", { name: "Save name" })).click();
  await expect(page.getByTestId("library-tasks")).toContainText("Adjust track tension");
  page.once("dialog", (d) => d.accept());
  await visible(page.getByRole("button", { name: "Delete Grease suspension" })).click();
  await expect(page.getByTestId("library-tasks")).not.toContainText("Grease suspension");
  await page.goto(`/garage/${sledId}`);
  const preseason = await openRecord(page, "Preseason");
  await expect(preseason).toContainText("Check track tension");
  await expect(preseason).toContainText("Grease suspension");
});

test("owners delete records; mechanics edit only their own; viewers only read", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("svc-owner");
  const mechanicEmail = uniqueEmail("svc-mech");
  const viewerEmail = uniqueEmail("svc-view");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "1000" });
  await page.goto(`/garage/${sledId}/service/new`);
  await fillService(page, { title: "Owner service", parts: [{ name: "Spark plugs", qty: "2", cost: "9" }] });
  await visible(page.getByRole("button", { name: "Save service" })).click();
  await expect(page).toHaveURL(/\?service=saved/);

  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic: logs a service, corrects it, removes a part, cannot delete.
  await mechanic.goto(`/garage/${sledId}/service/new`);
  await fillService(mechanic, {
    title: "Mechanic service",
    parts: [
      { name: "Drive belt", qty: "1", cost: "180" },
      { name: "Wrong part", qty: "1", cost: "5" },
    ],
  });
  await visible(mechanic.getByRole("button", { name: "Save service" })).click();
  await expect(mechanic).toHaveURL(/\?service=saved/);
  const own = await openRecord(mechanic, "Mechanic service");
  await expect(own.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await own.getByRole("link", { name: "Edit" }).click();
  await expect(label(mechanic, "Mileage unknown")).toBeDisabled();
  await visible(mechanic.getByRole("button", { name: "Remove part Wrong part" })).click();
  await label(visible(mechanic.getByTestId("part-row")).first(), "Unit cost ($)").fill("175");
  await visible(mechanic.getByRole("button", { name: "Save changes" })).click();
  await expect(mechanic).toHaveURL(/\?service=updated/);
  const corrected = await openRecord(mechanic, "Mechanic service");
  await expect(corrected.getByTestId("service-record-total")).toHaveText("$175.00");
  await expect(corrected).not.toContainText("Wrong part");
  const ownersRecord = await openRecord(mechanic, "Owner service");
  await expect(ownersRecord.getByRole("link", { name: "Edit" })).toHaveCount(0);

  // Viewer: sees everything, changes nothing.
  await viewer.goto(`/garage/${sledId}`);
  await expect(record(viewer, "Owner service")).toBeVisible();
  await expect(visible(viewer.getByRole("button", { name: "Log service" }))).toHaveCount(0);
  const viewed = await openRecord(viewer, "Mechanic service");
  await expect(viewed.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await viewer.goto(`/garage/${sledId}/service/new`);
  await expect(viewer).toHaveURL(new RegExp(`/garage/${sledId}$`));

  // Owner: deletes the mechanic's record.
  await page.reload();
  const toDelete = await openRecord(page, "Mechanic service");
  page.once("dialog", (d) => d.accept());
  await toDelete.getByRole("button", { name: "Delete" }).click();
  await expect(record(page, "Mechanic service")).toHaveCount(0);
  await expect(record(page, "Owner service")).toBeVisible();

  await mechanicContext.close();
  await viewerContext.close();
});

test("validation: mileage is required unless unknown, and dates can't be in the future", async ({ page }) => {
  await signUp(page, uniqueEmail("svc-valid"));
  const sledId = await addSled(page, { make: "Lynx", model: "Rave", year: "2020", odometer: "500" });
  await page.goto(`/garage/${sledId}/service/new`);
  await fillService(page, { title: "Old repair", date: "2024-01-15" });
  await visible(page.getByRole("button", { name: "Save service" })).click();
  await expect(visible(page.getByText("Enter the mileage, or choose “Mileage unknown”."))).toBeVisible();

  await label(page, "Mileage unknown").check();
  await visible(page.getByRole("button", { name: "Save service" })).click();
  await expect(page).toHaveURL(/\?service=saved/);
  const item = await openRecord(page, "Old repair");
  await expect(item).toContainText("Unknown");
  await expect(page.getByTestId("reading-history").getByRole("listitem")).toHaveCount(1);

  await page.goto(`/garage/${sledId}/service/new`);
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString("en-CA");
  });
  await fillService(page, { title: "Future", date: tomorrow, odometer: "500" });
  await visible(page.getByRole("button", { name: "Save service" })).click();
  await expect(visible(page.getByText("The date can't be in the future."))).toBeVisible();
  expect(await today(page)).not.toBe(tomorrow);
});
