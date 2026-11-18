import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, shareSled, signUp, uniqueEmail } from "./helpers";

// Phase 6.1: the issue log on the sled page and the Garage Board.
// Needs the local Supabase stack with Migration 6.
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 2000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const label = (scope: Page | Locator, text: string, exact = false) => visible(scope.getByLabel(text, { exact }));

// A small valid PNG (8x6, solid color).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=",
  "base64",
);

const issuesSection = (page: Page) => visible(page.getByTestId("sled-issues")).first();
const openIssues = (page: Page) => issuesSection(page).getByTestId("open-issues").getByTestId("issue-row");
const issueRow = (scope: Locator, title: string) =>
  scope.getByTestId("issue-row").filter({ has: scope.page().getByTestId("issue-title").getByText(title, { exact: true }) });
const garage = (page: Page) => visible(page.getByTestId("garage-board"));
const garageSled = (page: Page, name: string) => garage(page).getByRole("article", { name, exact: true });
const records = (page: Page) => page.locator("#service-history").getByTestId("service-record");

async function reportIssue(
  page: Page,
  scope: Page | Locator,
  sledName: string,
  issue: { title: string; priority?: string; description?: string; odometer?: string; photos?: number },
) {
  await visible(scope.getByRole("button", { name: `Report issue on ${sledName}` })).first().click();
  const dialog = page.getByRole("dialog", { name: "Report issue" });
  await label(dialog, "Title", true).fill(issue.title);
  if (issue.priority) await dialog.getByText(issue.priority, { exact: true }).click();
  if (issue.description) await label(dialog, "Description (optional)").fill(issue.description);
  if (issue.odometer !== undefined) await label(dialog, "Mileage (odometer)").fill(issue.odometer);
  if (issue.photos) {
    await dialog.locator('input[type="file"]').setInputFiles(
      Array.from({ length: issue.photos }, (_, n) => ({ name: `photo-${n}.png`, mimeType: "image/png", buffer: PNG })),
    );
    await expect(dialog.getByTestId("new-issue-photos").getByRole("listitem")).toHaveCount(issue.photos);
  }
  await dialog.getByRole("button", { name: "Save issue" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function openIssue(page: Page, scope: Locator, title: string) {
  await issueRow(scope, title).getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog.getByTestId("issue-detail")).toBeVisible();
  return dialog;
}

async function logService(page: Page, title: string) {
  await visible(page.getByRole("button", { name: "Log service" })).click();
  const dialog = page.getByRole("dialog", { name: "Quick service" });
  await label(dialog, "What did you do?").fill(title);
  await dialog.getByRole("button", { name: "Save service" }).click();
  await expect(dialog).toBeHidden();
}

test("report, view, edit and resolve issues on the sled page", async ({ page }) => {
  await signUp(page, uniqueEmail("iss"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", hours: "150", nickname: "Big Blue" });
  await expect(issuesSection(page)).toContainText("No open issues.");

  // Report: mileage comes from the current reading and can be changed; photos attach.
  await visible(page.getByRole("button", { name: "Report issue on Big Blue" })).click();
  let dialog = page.getByRole("dialog", { name: "Report issue" });
  await expect(label(dialog, "Mileage (odometer)")).toHaveValue("2000");
  await dialog.getByRole("button", { name: "Close" }).click();
  await reportIssue(page, page, "Big Blue", {
    title: "Track squeaks at low speed",
    priority: "High",
    description: "Worse when cold.",
    odometer: "1985",
    photos: 2,
  });
  await reportIssue(page, page, "Big Blue", { title: "Brake lever spongy", priority: "Critical" });
  await reportIssue(page, page, "Big Blue", { title: "Loose mirror", priority: "Low" });

  // Most urgent first.
  await expect(openIssues(page).getByTestId("issue-title")).toHaveText(["Brake lever spongy", "Track squeaks at low speed", "Loose mirror"]);
  // No reading was created by the issue mileage.
  await expect(page.getByTestId("current-odometer")).toHaveText("2,000 mi");
  await expect(page.getByTestId("reading-history").getByRole("listitem")).toHaveCount(1);

  // Details, with photos.
  dialog = await openIssue(page, issuesSection(page), "Track squeaks at low speed");
  await expect(dialog).toContainText("Worse when cold.");
  await expect(dialog).toContainText("1,985 mi");
  const photos = dialog.getByTestId("issue-photos").getByRole("img");
  await expect(photos).toHaveCount(2);
  await expect.poll(() => photos.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // Edit.
  await dialog.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit issue" });
  await label(edit, "Title", true).fill("Track squeaks at idle");
  await edit.getByText("Medium", { exact: true }).click();
  await edit.getByRole("button", { name: "Save changes" }).click();
  dialog = page.getByRole("dialog", { name: "Track squeaks at idle" });
  await expect(dialog.getByTestId("issue-priority")).toHaveText("Medium");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(openIssues(page).getByTestId("issue-title")).toHaveText(["Brake lever spongy", "Track squeaks at idle", "Loose mirror"]);

  // Resolve manually, with notes: it leaves the active list, stays in history.
  dialog = await openIssue(page, issuesSection(page), "Loose mirror");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  let resolve = page.getByRole("dialog", { name: "Resolve issue" });
  await label(resolve, "Notes (optional)").fill("Tightened the bolt.");
  await resolve.getByRole("button", { name: "Mark resolved" }).click();
  dialog = page.getByRole("dialog", { name: "Loose mirror" });
  await expect(dialog.getByTestId("issue-resolution")).toContainText("Tightened the bolt.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(openIssues(page)).toHaveCount(2);
  await issuesSection(page).getByRole("button", { name: "Resolved issues (1)" }).click();
  await expect(issuesSection(page).getByTestId("resolved-issues")).toContainText("Loose mirror");

  // Resolve by linking a completed service: a link, not a copy.
  await logService(page, "Replaced brake fluid");
  await expect(records(page)).toHaveCount(1);
  dialog = await openIssue(page, issuesSection(page), "Brake lever spongy");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  resolve = page.getByRole("dialog", { name: "Resolve issue" });
  await resolve.getByText("Fixed by a service record").click();
  const option = resolve.locator("option", { hasText: "Replaced brake fluid" });
  await expect(option).toHaveCount(1);
  await label(resolve, "Service record").selectOption((await option.getAttribute("value"))!);
  await resolve.getByRole("button", { name: "Mark resolved" }).click();
  dialog = page.getByRole("dialog", { name: "Brake lever spongy" });
  await expect(dialog.getByTestId("issue-resolution")).toContainText("By service: Replaced brake fluid");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(records(page)).toHaveCount(1);
  const record = records(page).first();
  await record.locator("summary").click();
  await expect(record.getByTestId("service-resolved-issues")).toHaveText("Resolved issue: Brake lever spongy");

  // Reopen.
  dialog = await openIssue(page, issuesSection(page).getByTestId("resolved-issues"), "Loose mirror");
  await dialog.getByRole("button", { name: "Reopen" }).click();
  await expect(dialog.getByTestId("issue-detail")).toHaveAttribute("data-status", "open");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(openIssues(page).getByTestId("issue-title")).toHaveText(["Track squeaks at idle", "Loose mirror"]);

  // Delete (owner): Recently Deleted.
  dialog = await openIssue(page, issuesSection(page), "Loose mirror");
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(openIssues(page)).toHaveCount(1);
  await page.goto(`/garage/${sledId}`);
  await expect(openIssues(page)).toHaveCount(1);
});

test("Garage Board: open issues, up to three per sled, and the ready-to-ride warning", async ({ page }) => {
  await signUp(page, uniqueEmail("iss-board"));
  await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "800", nickname: "Summit" });
  await page.goto("/garage/board");
  await expect(garageSled(page, "Summit").getByTestId("ride-warning")).toHaveCount(0);

  for (const [title, priority] of [
    ["Seat cover torn", "Low"],
    ["Hand warmer out", "Medium"],
    ["Track squeak", "High"],
    ["Loose ski bolt", "Medium"],
  ] as const) {
    await reportIssue(page, garageSled(page, "Summit"), "Summit", { title, priority });
  }
  const sled = garageSled(page, "Summit");
  await expect(sled.getByTestId("issue-summary")).toHaveText("4 open issues · 1 high");
  await expect(sled.getByTestId("board-issues").getByTestId("issue-row")).toHaveCount(3);
  await expect(sled.getByTestId("board-issues").getByTestId("issue-title").first()).toHaveText("Track squeak");
  await sled.getByRole("button", { name: "and 1 more open issue" }).click();
  const all = page.getByRole("dialog", { name: "Open issues" });
  await expect(all.getByTestId("issue-row")).toHaveCount(4);
  await all.getByRole("button", { name: "Close" }).click();

  // A critical issue: not ready to ride (maintenance status is unchanged).
  await reportIssue(page, sled, "Summit", { title: "Brake failure", priority: "Critical" });
  await expect(sled.getByTestId("ride-warning")).toHaveText("Not ready to ride: critical issue “Brake failure”");
  await expect(sled.getByTestId("sled-overall")).toHaveAttribute("data-tone", "neutral");

  // Compact shows the same; resolving the critical issue clears the warning.
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  await expect(sled.getByTestId("ride-warning")).toBeVisible();
  const dialog = await openIssue(page, sled, "Brake failure");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  const resolve = page.getByRole("dialog", { name: "Resolve issue" });
  await resolve.getByRole("button", { name: "Mark resolved" }).click();
  await page.getByRole("dialog", { name: "Brake failure" }).getByRole("button", { name: "Close" }).click();
  await expect(sled.getByTestId("ride-warning")).toHaveCount(0);
  await expect(sled.getByTestId("issue-summary")).toHaveText("4 open issues · 1 high");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Wall Display: report an issue with the on-screen keyboard", async ({ page }) => {
  await signUp(page, uniqueEmail("iss-wall"));
  await addSled(page, { make: "Polaris", model: "Indy", year: "2024", odometer: "1000", nickname: "Indy" });
  await page.goto("/garage/board?display=wall");
  await expect(garage(page)).toHaveAttribute("data-wall", "on");
  const keyboard = page.getByTestId("wall-keyboard");

  await garageSled(page, "Indy").getByRole("button", { name: "Report issue on Indy" }).click();
  const dialog = page.getByRole("dialog", { name: "Report issue" });
  await label(dialog, "Title", true).click();
  await expect(keyboard).toHaveAttribute("data-mode", "text");
  for (const key of ["Shift", "B", "e", "l", "t", "Space", "s", "l", "i", "p", "s"]) {
    await keyboard.getByRole("button", { name: key, exact: true }).click();
  }
  await expect(label(dialog, "Title", true)).toHaveValue("Belt slips");
  await label(dialog, "Mileage (odometer)").click();
  await expect(keyboard).toHaveAttribute("data-mode", "decimal");
  for (const key of ["Clear", "1", "0", "5", "0"]) await keyboard.getByRole("button", { name: key, exact: true }).click();
  await expect(label(dialog, "Mileage (odometer)")).toHaveValue("1050");
  const keyboardTop = (await keyboard.boundingBox())!.y;
  const save = dialog.getByRole("button", { name: "Save issue" });
  const saveBox = (await save.boundingBox())!;
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(keyboardTop);
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(issueRow(garageSled(page, "Indy"), "Belt slips")).toContainText("1,050 mi");
});

test("permissions: mechanics report and resolve their own; viewers only read", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("iss-own");
  const mechanicEmail = uniqueEmail("iss-mech");
  const viewerEmail = uniqueEmail("iss-view");
  await signUp(page, ownerEmail);
  const sledId = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "1000", nickname: "Sidewinder" });
  await reportIssue(page, page, "Sidewinder", { title: "Owner's issue", priority: "High" });

  const mechanicContext = await browser.newContext();
  const mechanic = await mechanicContext.newPage();
  await signUp(mechanic, mechanicEmail);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await signUp(viewer, viewerEmail);
  await shareSled(ownerEmail, sledId, mechanicEmail, "mechanic");
  await shareSled(ownerEmail, sledId, viewerEmail, "viewer");

  // Mechanic: can't change the owner's issue; reports, adds a photo to and resolves their own.
  await mechanic.goto(`/garage/${sledId}`);
  let dialog = await openIssue(mechanic, issuesSection(mechanic), "Owner's issue");
  await expect(dialog.getByRole("button", { name: "Resolve" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await reportIssue(mechanic, mechanic, "Sidewinder", { title: "Mechanic's issue", photos: 1 });
  dialog = await openIssue(mechanic, issuesSection(mechanic), "Mechanic's issue");
  await expect(dialog.getByTestId("issue-photos").getByRole("img")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await mechanic.getByRole("dialog", { name: "Resolve issue" }).getByRole("button", { name: "Mark resolved" }).click();
  await expect(mechanic.getByRole("dialog", { name: "Mechanic's issue" }).getByTestId("issue-detail")).toHaveAttribute("data-status", "resolved");

  // Viewer: sees issues, changes nothing.
  await viewer.goto(`/garage/${sledId}`);
  await expect(openIssues(viewer).getByTestId("issue-title")).toHaveText(["Owner's issue"]);
  await expect(viewer.getByRole("button", { name: /Report issue/ })).toHaveCount(0);
  dialog = await openIssue(viewer, issuesSection(viewer), "Owner's issue");
  await expect(dialog.getByRole("button", { name: /Resolve|Edit|Delete|Reopen/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await viewer.goto("/garage/board");
  await expect(garageSled(viewer, "Sidewinder").getByTestId("issue-row")).toHaveCount(1);
  await expect(garageSled(viewer, "Sidewinder").getByRole("button", { name: /Report issue/ })).toHaveCount(0);

  // Someone else can't see the sled or its issues at all.
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await signUp(stranger, uniqueEmail("iss-stranger"));
  await stranger.goto(`/garage/${sledId}`);
  await expect(stranger.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();

  await mechanicContext.close();
  await viewerContext.close();
  await strangerContext.close();
});
