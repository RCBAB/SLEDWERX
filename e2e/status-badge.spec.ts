import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, addSled, hasSupabase, signUp, uniqueEmail } from "./helpers";

// An open Critical issue turns a stored "Ready" into a red "Not ready" badge
// everywhere (Garage Board, sled page, My Snowmobiles), without changing the
// stored status. Needs the local Supabase stack (Migration 6, no new migration).
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
const sledCard = (page: Page, name: string) => visible(page.getByTestId("sled-card")).filter({ hasText: name });
const pageBadge = (page: Page) => visible(page.locator("#sled-name").locator("xpath=..").getByTestId("sled-status"));

async function reportIssue(page: Page, scope: Page | Locator, sledName: string, title: string, priority: string) {
  await visible(scope.getByRole("button", { name: `Report issue on ${sledName}` })).first().click();
  const dialog = page.getByRole("dialog", { name: "Report issue" });
  await label(dialog, "Title", true).fill(title);
  await dialog.getByText(priority, { exact: true }).click();
  await dialog.getByRole("button", { name: "Save issue" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function openIssue(page: Page, scope: Locator, title: string) {
  await scope
    .getByTestId("issue-row")
    .filter({ has: page.getByTestId("issue-title").getByText(title, { exact: true }) })
    .getByRole("button")
    .click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog.getByTestId("issue-detail")).toBeVisible();
  return dialog;
}

async function expectBadge(badge: Locator, status: string, text: string) {
  await expect(badge).toHaveAttribute("data-status", status);
  await expect(badge).toContainText(text);
}

test("an open Critical issue shows Not ready instead of Ready, everywhere, until it's resolved or deleted", async ({ page }) => {
  await signUp(page, uniqueEmail("badge"));
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000", nickname: "Big Blue" });
  await expectBadge(pageBadge(page), "ready", "Ready");

  // A High issue doesn't change the badge.
  await page.goto("/garage/board");
  await reportIssue(page, garageSled(page, "Big Blue"), "Big Blue", "Track squeak", "High");
  await expectBadge(garageSled(page, "Big Blue").getByTestId("sled-status"), "ready", "Ready");

  // Two Critical issues: Not ready on the Garage Board (Cards and Compact), with the warning banner.
  await reportIssue(page, garageSled(page, "Big Blue"), "Big Blue", "Brake failure", "Critical");
  await reportIssue(page, garageSled(page, "Big Blue"), "Big Blue", "Throttle sticks", "Critical");
  const board = garageSled(page, "Big Blue");
  await expectBadge(board.getByTestId("sled-status"), "not_ready", "Not ready");
  await expect(board.getByTestId("sled-status")).not.toContainText(/^Ready/);
  await expect(board.getByTestId("ride-warning")).toHaveText("Not ready to ride: 2 critical issues");
  await garage(page).getByRole("group", { name: "Layout" }).getByRole("button", { name: "Compact" }).click();
  await expectBadge(board.getByTestId("sled-status"), "not_ready", "Not ready");

  // Wall Display uses the same heading.
  await page.goto("/garage/board?display=wall");
  await expectBadge(garageSled(page, "Big Blue").getByTestId("sled-status"), "not_ready", "Not ready");

  // The sled page and My Snowmobiles agree.
  await page.goto(`/garage/${sledId}`);
  await expectBadge(pageBadge(page), "not_ready", "Not ready");
  await page.goto("/garage");
  await expectBadge(sledCard(page, "Big Blue").getByTestId("sled-status"), "not_ready", "Not ready");

  // The stored status is untouched: Edit details still says Ready.
  await page.goto(`/garage/${sledId}/edit`);
  await page.locator("summary", { hasText: "More details" }).filter({ visible: true }).click();
  await expect(label(page, "Status", true)).toHaveValue("ready");

  // Resolving one Critical issue isn't enough; the last one restores Ready.
  await page.goto(`/garage/${sledId}`);
  const issues = visible(page.getByTestId("sled-issues")).first();
  let dialog = await openIssue(page, issues, "Brake failure");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  const resolve = page.getByRole("dialog", { name: "Resolve issue" });
  await resolve.getByRole("button", { name: "Mark resolved" }).click();
  dialog = page.getByRole("dialog", { name: "Brake failure" });
  await expect(dialog.getByTestId("issue-detail")).toHaveAttribute("data-status", "resolved");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expectBadge(pageBadge(page), "not_ready", "Not ready");

  // Deleting the last open Critical issue restores Ready too.
  dialog = await openIssue(page, issues, "Throttle sticks");
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expectBadge(pageBadge(page), "ready", "Ready");
  await page.goto("/garage/board");
  await expectBadge(garageSled(page, "Big Blue").getByTestId("sled-status"), "ready", "Ready");
  await expect(garageSled(page, "Big Blue").getByTestId("ride-warning")).toHaveCount(0);
  await page.goto("/garage");
  await expectBadge(sledCard(page, "Big Blue").getByTestId("sled-status"), "ready", "Ready");

  // Reopening a resolved Critical issue makes it Not ready again.
  await page.goto(`/garage/${sledId}`);
  await issues.getByRole("button", { name: /Resolved issues/ }).click();
  dialog = await openIssue(page, issues.getByTestId("resolved-issues"), "Brake failure");
  await dialog.getByRole("button", { name: "Reopen" }).click();
  await expect(dialog.getByTestId("issue-detail")).toHaveAttribute("data-status", "open");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expectBadge(pageBadge(page), "not_ready", "Not ready");
});

test("Needs attention, Out of service and Stored are never overridden", async ({ page }) => {
  await signUp(page, uniqueEmail("badge-other"));
  const statuses = [
    ["needs_attention", "Needs attention", "Amber"],
    ["out_of_service", "Out of service", "Shop"],
    ["stored", "Stored", "Summer"],
  ] as const;
  for (const [status, , nickname] of statuses) {
    const id = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2023", odometer: "500", nickname });
    await page.goto(`/garage/${id}/edit`);
    await page.locator("summary", { hasText: "More details" }).filter({ visible: true }).click();
    await label(page, "Status", true).selectOption(status);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/garage/${id}\\?saved=1$`));
    await reportIssue(page, page, nickname, "Critical problem", "Critical");
  }

  await page.goto("/garage/board");
  for (const [status, text, nickname] of statuses) {
    await expectBadge(garageSled(page, nickname).getByTestId("sled-status"), status, text);
    // The warning banner still shows.
    await expect(garageSled(page, nickname).getByTestId("ride-warning")).toBeVisible();
  }
  await page.goto("/garage");
  for (const [status, text, nickname] of statuses) {
    await expectBadge(sledCard(page, nickname).getByTestId("sled-status"), status, text);
  }
});
