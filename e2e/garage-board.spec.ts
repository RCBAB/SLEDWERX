import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, addSled, hasSupabase, shareSled, signIn, signUp, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (Migrations 1-5; Phase 5 adds no migration).
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

// Garage Board
const garage = (page: Page) => visible(page.getByTestId("garage-board"));
const garageSled = (page: Page, name: string) => garage(page).getByRole("article", { name, exact: true });
const garageTask = (page: Page, sled: string, task: string) =>
  garageSled(page, sled)
    .getByTestId("garage-task")
    .filter({ has: page.getByText(task, { exact: true }) });

// The sled's own Maintenance Board (Phase 4)
const sledBoard = (page: Page) => visible(page.getByTestId("maintenance-board"));
const sledTask = (page: Page, task: string) =>
  sledBoard(page)
    .getByTestId("board-row")
    .filter({ has: page.getByText(task, { exact: true }) });
const history = (page: Page) => page.locator("#service-history").getByTestId("service-record");

/** Adds a task to a sled's board from its own page (schedule editing stays there). */
async function addToBoard(page: Page, s: { task?: string; newTask?: string; miles?: string; before?: string }) {
  await visible(sledBoard(page).getByRole("button", { name: "Add to board" })).first().click();
  const dialog = page.getByRole("dialog", { name: "Add to board" });
  if (s.task) await label(dialog, "Task", true).selectOption({ label: s.task });
  if (s.newTask) await label(dialog, "New task", true).fill(s.newTask);
  if (s.miles) await label(dialog, "Every … miles", true).fill(s.miles);
  if (s.before) {
    await dialog.locator("details summary").click();
    await label(dialog, "Miles then").fill(s.before);
  }
  await dialog.getByRole("button", { name: "Add to board" }).click();
  await expect(dialog).toBeHidden();
  await expect(sledTask(page, (s.newTask ?? s.task)!)).toBeVisible();
}

async function openGarageBoard(page: Page) {
  await visible(page.getByRole("link", { name: "Garage Board" })).first().click();
  await expect(page).toHaveURL(/\/garage\/board$/);
  await expect(garage(page)).toBeVisible();
}

function localDate(page: Page) {
  return page.evaluate(() => new Date().toLocaleDateString("en-CA"));
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function chooseLayout(page: Page, layout: "Cards" | "Compact") {
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: layout }).click();
  await expect(garage(page)).toHaveAttribute("data-layout", layout.toLowerCase());
}

test("Garage Board is in the navigation and shows every snowmobile, yours first, then shared", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("gb-owner");
  const friendEmail = uniqueEmail("gb-friend");
  await signUp(page, ownerEmail);
  await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Big Blue" }, true);
  await addToBoard(page, { newTask: "Change oil", miles: "1000", before: "900" });
  await addToBoard(page, { newTask: "Track tension", miles: "500", before: "1520" });
  await addToBoard(page, { newTask: "Grease suspension", miles: "1000", before: "1900" });
  await addToBoard(page, { newTask: "Wax hood" });
  await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "300", nickname: "Kid's sled" });

  // A friend's sled, shared with the owner as a viewer.
  const friendContext = await browser.newContext();
  const friend = await friendContext.newPage();
  await signUp(friend, friendEmail);
  const friendSled = await addSled(friend, { make: "Arctic Cat", model: "Riot", year: "2021", odometer: "800", nickname: "Dad's Cat" });
  await shareSled(friendEmail, friendSled, ownerEmail, "viewer");
  await friendContext.close();

  // My Snowmobiles stays the home page; Garage Board is in the navigation.
  await page.goto("/garage");
  await openGarageBoard(page);
  await expect(visible(page.getByRole("link", { name: "Garage Board" })).first()).toHaveAttribute("aria-current", "page");
  await expect(garage(page)).toHaveAttribute("data-layout", "cards");

  // Yours first, in the order they were added; then shared.
  await expect(garage(page).getByTestId("garage-owned").getByRole("article")).toHaveText([/Big Blue/, /Kid's sled/]);
  await expect(garage(page).getByTestId("garage-shared").getByRole("article")).toHaveText([/Dad's Cat/]);
  await expect(garageSled(page, "Dad's Cat")).toContainText("Viewer");

  // Photo, name, mileage and the overall status.
  const blue = garageSled(page, "Big Blue");
  await expect(blue.getByRole("img", { name: "Big Blue", exact: true })).toBeVisible();
  await expect(blue.getByTestId("sled-meters")).toHaveText("2,000 mi · 150 hrs");
  await expect(blue.getByTestId("sled-overall")).toHaveAttribute("data-tone", "red");
  await expect(blue.getByTestId("sled-overall")).toContainText("1 overdue · 1 due soon");
  await expect(garageSled(page, "Kid's sled").getByTestId("sled-overall")).toHaveAttribute("data-tone", "neutral");

  // Every task, in the Phase 4 order, with last done and next due.
  await expect
    .poll(() => blue.getByTestId("garage-task").evaluateAll((els) => els.map((e) => e.getAttribute("data-status"))))
    .toEqual(["overdue", "upcoming", "good", "unscheduled"]);
  const oil = garageTask(page, "Big Blue", "Change oil");
  await expect(oil.getByTestId("board-status")).toHaveText("Overdue by 100 mi");
  await expect(oil.getByTestId("board-last-done")).toContainText("Done before SledWerx");
  await expect(oil.getByTestId("board-next-due")).toHaveText("Next due 1,900 mi");
  await expect(garageTask(page, "Big Blue", "Grease suspension").getByTestId("board-next-due")).toHaveText("Next due 2,900 mi");

  // Compact shows the same tasks.
  await chooseLayout(page, "Compact");
  await expect(garageSled(page, "Big Blue").getByTestId("garage-task")).toHaveCount(4);
  await expect(garageTask(page, "Big Blue", "Change oil").getByTestId("board-next-due")).toContainText("1,900 mi");
  await noSidewaysScroll(page);
  await chooseLayout(page, "Cards");
  await noSidewaysScroll(page);

  // Schedules are edited on the sled's own page.
  await expect(blue.getByRole("button", { name: /schedule/i })).toHaveCount(0);
  await blue.getByRole("link", { name: "Edit schedules for Big Blue" }).click();
  await expect(page).toHaveURL(/\/garage\/[0-9a-f-]{36}#board-heading$/);
  await expect(sledTask(page, "Change oil").getByRole("button", { name: "Schedule for Change oil" })).toBeVisible();
});

test("Done from either layout saves one service record and updates both boards", async ({ page }) => {
  await signUp(page, uniqueEmail("gb-done"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Big Blue" });
  await addToBoard(page, { newTask: "Change oil", miles: "1000", before: "900" });
  await addToBoard(page, { newTask: "Track tension", miles: "500", before: "1520" });
  await addToBoard(page, { newTask: "Inspect belt", miles: "1000", before: "1500" });
  await openGarageBoard(page);

  // Full Cards: same Done form as the sled page, defaulting to today and the current meters.
  await garageTask(page, "Big Blue", "Change oil").getByRole("button", { name: "Mark Change oil done on Big Blue" }).click();
  let dialog = page.getByRole("dialog", { name: "Change oil" });
  await expect(dialog).toContainText("Big Blue");
  await expect(label(dialog, "Date", true)).toHaveValue(await localDate(page));
  await expect(label(dialog, "Mileage (odometer)")).toHaveValue("2000");
  await expect(label(dialog, "Engine hours (optional)")).toHaveValue("150");
  await noSidewaysScroll(page);
  // Same validation: mileage can't go below the sled's history.
  await label(dialog, "Mileage (odometer)").fill("100");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toContainText("Odometer readings cannot go down.");
  await label(dialog, "Mileage (odometer)").fill("2000");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageTask(page, "Big Blue", "Change oil")).toHaveAttribute("data-status", "good");
  await expect(garageTask(page, "Big Blue", "Change oil").getByTestId("board-next-due")).toHaveText("Next due 3,000 mi");

  // Compact: Done there too.
  await chooseLayout(page, "Compact");
  await garageTask(page, "Big Blue", "Track tension").getByRole("button", { name: "Mark Track tension done on Big Blue" }).click();
  dialog = page.getByRole("dialog", { name: "Track tension" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageTask(page, "Big Blue", "Track tension")).toHaveAttribute("data-status", "good");

  // The sled's own page shows the same: two ordinary service records.
  await garageSled(page, "Big Blue").getByRole("link", { name: "Big Blue", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}$`));
  await expect(sledTask(page, "Change oil")).toHaveAttribute("data-status", "good");
  await expect(sledTask(page, "Track tension")).toHaveAttribute("data-status", "good");
  await expect(history(page)).toHaveCount(2);

  // Completing on the sled page, then going Back, shows it on the Garage Board.
  await sledTask(page, "Inspect belt").getByRole("button", { name: "Mark Inspect belt done" }).click();
  dialog = page.getByRole("dialog", { name: "Inspect belt" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(sledTask(page, "Inspect belt")).toHaveAttribute("data-status", "good");
  await page.goBack();
  await expect(page).toHaveURL(/\/garage\/board$/);
  await expect(garageTask(page, "Big Blue", "Inspect belt")).toHaveAttribute("data-status", "good");
  await expect(garageSled(page, "Big Blue").getByTestId("sled-overall")).toHaveAttribute("data-tone", "green");

  // And the other way: Garage Board change, then Forward to the sled page.
  await garageTask(page, "Big Blue", "Change oil").getByRole("button", { name: "Mark Change oil done on Big Blue" }).click();
  dialog = page.getByRole("dialog", { name: "Change oil" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/garage/${sledId}$`));
  await expect(history(page)).toHaveCount(4);
});

test("a package is completed from the Garage Board as one record", async ({ page }) => {
  await signUp(page, uniqueEmail("gb-pkg"));
  await page.goto("/garage/library");
  for (const task of ["Check track tension", "Grease suspension"]) {
    await label(page, "New task", true).fill(task);
    await visible(page.getByRole("button", { name: "Add task" })).click();
    await expect(page.getByTestId("library-tasks")).toContainText(task);
  }
  await label(page, "New package", true).fill("Preseason service");
  await visible(page.getByRole("button", { name: "Add package" })).click();
  const pkg = page.getByTestId("package-card").filter({ hasText: "Preseason service" });
  for (const task of ["Check track tension", "Grease suspension"]) {
    await label(pkg, "Add a task to Preseason service").selectOption({ label: task });
    await pkg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pkg.getByRole("listitem").filter({ hasText: task })).toBeVisible();
  }
  await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "800", nickname: "Summit" });
  await addToBoard(page, { task: "Check track tension", miles: "500" });
  await addToBoard(page, { task: "Grease suspension", miles: "1000" });

  await openGarageBoard(page);
  await expect(garageTask(page, "Summit", "Check track tension")).toHaveAttribute("data-status", "no_record");
  await garageSled(page, "Summit").getByRole("button", { name: "Complete package on Summit" }).click();
  const sheet = page.getByRole("dialog", { name: "Complete package" });
  await expect(label(sheet, "Check track tension")).toBeChecked();
  await expect(label(sheet, "Grease suspension")).toBeChecked();
  await expect(label(sheet, "Mileage (odometer)")).toHaveValue("800");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(garageTask(page, "Summit", "Check track tension")).toHaveAttribute("data-status", "good");
  await expect(garageTask(page, "Summit", "Grease suspension")).toHaveAttribute("data-status", "good");

  await garageSled(page, "Summit").getByRole("link", { name: "Summit", exact: true }).click();
  await expect(history(page)).toHaveCount(1);
  await expect(history(page).filter({ hasText: "Preseason service" })).toHaveCount(1);
});

test("mechanics can mark tasks done; viewers only see; neither edits schedules", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("gb-own");
  const mechanicEmail = uniqueEmail("gb-mech");
  const viewerEmail = uniqueEmail("gb-view");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "1000", nickname: "Sidewinder" });
  await addToBoard(page, { newTask: "Change oil", miles: "500", before: "100" });

  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  await mechanic.goto("/garage/board");
  const mechSled = garageSled(mechanic, "Sidewinder");
  await expect(garage(mechanic).getByTestId("garage-shared")).toContainText("Mechanic");
  await expect(mechSled.getByRole("link", { name: /Edit schedules/ })).toHaveCount(0);
  await garageTask(mechanic, "Sidewinder", "Change oil").getByRole("button", { name: "Mark Change oil done on Sidewinder" }).click();
  const dialog = mechanic.getByRole("dialog", { name: "Change oil" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageTask(mechanic, "Sidewinder", "Change oil")).toHaveAttribute("data-status", "good");

  await viewer.goto("/garage/board");
  await expect(garageTask(viewer, "Sidewinder", "Change oil")).toHaveAttribute("data-status", "good");
  await expect(garageSled(viewer, "Sidewinder").getByRole("button")).toHaveCount(0);
  await expect(garageSled(viewer, "Sidewinder").getByRole("link", { name: /Edit schedules/ })).toHaveCount(0);
  await expect(garage(viewer).getByTestId("garage-owned")).toHaveCount(0);

  await page.goto("/garage/board");
  await expect(garageTask(page, "Sidewinder", "Change oil")).toHaveAttribute("data-status", "good");

  await mechanicContext.close();
  await viewerContext.close();
});

test("the chosen layout is remembered, also when signing in elsewhere", async ({ page, browser }) => {
  const email = uniqueEmail("gb-pref");
  await signUp(page, email);
  await addSled(page, { make: "Lynx", model: "Rave", year: "2020", odometer: "500", nickname: "Rave" });
  await openGarageBoard(page);
  await expect(garage(page)).toHaveAttribute("data-layout", "cards");
  await chooseLayout(page, "Compact");
  // Saved in the background; a reload shows the saved layout.
  await expect(async () => {
    await page.reload();
    await expect(garage(page)).toHaveAttribute("data-layout", "compact", { timeout: 2000 });
  }).toPass();

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto("/login");
  await signIn(other, email, PASSWORD);
  await expect(other).toHaveURL(/\/garage$/); // My Snowmobiles stays the home page
  await other.goto("/garage/board");
  await expect(garage(other)).toHaveAttribute("data-layout", "compact");
  await otherContext.close();
});

test("wall display: full window, large touch targets, auto-refresh, and exit", async ({ page, browser }) => {
  const email = uniqueEmail("gb-wall");
  await signUp(page, email);
  const sledId = await addSled(page, { make: "Polaris", model: "Indy", year: "2024", odometer: "1000", nickname: "Indy" });
  await addToBoard(page, { newTask: "Change oil", miles: "500", before: "100" });
  await addToBoard(page, { newTask: "Track tension", miles: "500", before: "100" });

  // Open the wall display from the Garage Board.
  await page.clock.install();
  await page.goto("/garage/board");
  await visible(page.getByRole("button", { name: "Wall display" })).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  await expect(page).toHaveURL(/\/garage\/board\?display=wall$/);
  await expect(garage(page).getByTestId("wall-clock")).toContainText("Updated");
  const box = await garage(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  const done = garageTask(page, "Indy", "Change oil").getByRole("button", { name: "Mark Change oil done on Indy" });
  expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expect(
    garage(page).getByRole("button", { name: "Full screen" }).or(garage(page).getByText("this browser can't go full screen")),
  ).toBeVisible();
  await noSidewaysScroll(page);

  // Completing on the wall works like everywhere else.
  await done.click();
  const dialog = page.getByRole("dialog", { name: "Change oil" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(garageTask(page, "Indy", "Change oil")).toHaveAttribute("data-status", "good");

  // Work logged on another device appears after the next automatic refresh.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await phone.goto("/login");
  await signIn(phone, email, PASSWORD);
  await expect(phone).toHaveURL(/\/garage$/);
  await phone.goto(`/garage/${sledId}`);
  await sledTask(phone, "Track tension").getByRole("button", { name: "Mark Track tension done" }).click();
  const phoneDialog = phone.getByRole("dialog", { name: "Track tension" });
  await phoneDialog.getByRole("button", { name: "Save" }).click();
  await expect(phoneDialog).toBeHidden();
  await phoneContext.close();
  await expect(garageTask(page, "Indy", "Track tension")).toHaveAttribute("data-status", "overdue");
  await page.clock.fastForward("05:01");
  await expect(garageTask(page, "Indy", "Track tension")).toHaveAttribute("data-status", "good");

  // Exit, then open it directly by its link.
  await garage(page).getByRole("button", { name: "Exit wall display" }).click();
  await expect(garage(page)).toHaveAttribute("data-wall", "off");
  await expect(page).toHaveURL(/\/garage\/board$/);
  await page.goto("/garage/board?display=wall");
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  await expect(garage(page).getByRole("button", { name: "Exit wall display" })).toBeVisible();
});
