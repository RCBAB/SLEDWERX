import { expect, test, type Locator, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PHOTOS_URL, addSled, hasSupabase, signUp, uniqueEmail } from "./helpers";

// Measurement / Turns (Migration 12): turns adjustments, Record Measurement on the
// same Trail, reminders, outdated photos, History, and the dashboards.
test.skip(!hasSupabase, NEEDS_SUPABASE);
test.use({ baseURL: PHOTOS_URL });

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 3000)}`);
});

const visible = (locator: Locator) => locator.filter({ visible: true });
const suspensionPage = (page: Page) => visible(page.getByTestId("suspension-page"));
const activeName = (page: Page) => suspensionPage(page).getByTestId("active-name").first();
const rearGeneral = (page: Page) => suspensionPage(page).locator('[data-section="rear-general"]');
const tension = (page: Page) => rearGeneral(page).locator('[data-testid="qt-control"]', { hasText: "Track tension" });
const bar = (page: Page) => page.getByTestId("quick-tune-bar");
const config = (page: Page, n: number) =>
  suspensionPage(page).getByTestId("configuration-history").locator(`[data-testid="configuration"][data-number="${n}"]`);

async function saveBar(page: Page) {
  await bar(page).getByRole("button", { name: "Save Adjustments" }).click();
  await expect(bar(page)).toBeHidden({ timeout: 15_000 });
}

async function turns(page: Page, text: string) {
  const row = tension(page);
  await row.getByRole("group", { name: "How to adjust Track tension" }).getByRole("button", { name: "Turns" }).click();
  await row.getByRole("textbox", { name: "Turns for Track tension" }).fill(text);
}

test("turns, Record Measurement, reminders, photos, History and the dashboards", async ({ page }) => {
  test.setTimeout(180_000);
  await signUp(page, uniqueEmail("turns"));
  const sledId = await addSled(page, { make: "Ski-Doo", model: "Summit", year: "2025", odometer: "500", nickname: "Turns" });
  await page.goto(`/garage/${sledId}/suspension?view=quick`);
  await suspensionPage(page).getByRole("button", { name: "Use suggested settings" }).click();
  await rearGeneral(page).getByRole("textbox", { name: "Track tension", exact: true }).fill("1.25");
  await saveBar(page);
  await expect(activeName(page)).toHaveText("Trail 1");

  // Track tension: Measurement and Turns (the unit stays "in").
  const editor = suspensionPage(page).getByTestId("settings-editor");
  if (!(await editor.isVisible())) await suspensionPage(page).locator("summary", { hasText: "Customize settings" }).click();
  await editor.getByRole("button", { name: "Edit Track tension" }).click();
  const edit = page.getByRole("dialog", { name: "Edit setting" });
  await edit.getByTestId("input-methods").getByText("Measurement and Turns").click();
  await expect(edit.getByRole("combobox", { name: "Unit (optional)" })).toHaveValue("in");
  await edit.getByRole("button", { name: "Save setting" }).click();
  await expect(edit).toBeHidden({ timeout: 15_000 });
  await expect(tension(page)).toHaveAttribute("data-input-methods", "both");

  // +2 turns (four half-turn taps): Trail 2, measurement blank, both reminders.
  await tension(page).getByRole("group", { name: "How to adjust Track tension" }).getByRole("button", { name: "Turns" }).click();
  for (let n = 0; n < 4; n++) await tension(page).getByRole("button", { name: "Tighten Track tension half a turn" }).click();
  await expect(tension(page).getByRole("textbox", { name: "Turns for Track tension" })).toHaveValue("+2");
  await expect(tension(page).getByTestId("qt-turns-change")).toContainText("+2 turns");
  await saveBar(page);
  await expect(activeName(page)).toHaveText("Trail 2");
  await expect(tension(page).getByTestId("qt-cumulative")).toContainText("+2 turns");
  await expect(tension(page).getByTestId("measurement-needed")).toBeVisible();
  await expect(tension(page).getByTestId("photo-needed")).toBeVisible();
  await expect(suspensionPage(page).getByTestId("suspension-reminders")).toContainText("Track tension");

  // +1, then −0.5: +2.5 cumulative, each its own Trail.
  await turns(page, "+1");
  await saveBar(page);
  await expect(activeName(page)).toHaveText("Trail 3");
  await expect(tension(page).getByTestId("qt-cumulative")).toContainText("+3 turns");
  await turns(page, "-0.5");
  await saveBar(page);
  await expect(activeName(page)).toHaveText("Trail 4");
  await expect(tension(page).getByTestId("qt-cumulative")).toContainText("+2.5 turns");

  // More than 20 turns asks for confirmation; Discard drops it.
  await turns(page, "25");
  await expect(bar(page).getByTestId("large-turns-warning")).toBeVisible();
  await bar(page).getByRole("button", { name: "Save Adjustments" }).click();
  await expect(bar(page).getByRole("button", { name: "Save Anyway" })).toBeVisible();
  await bar(page).getByRole("button", { name: "Discard Changes" }).click();
  await expect(bar(page)).toBeHidden();

  // The snowmobile page and Record adjustment: reminders, and Track tension read-only there.
  await page.goto(`/garage/${sledId}`);
  const summary = visible(page.getByTestId("suspension-summary"));
  await expect(summary.getByTestId("suspension-reminders")).toContainText("Track tension");
  await summary.getByRole("button", { name: /^Adjust suspension on/ }).click();
  const adjust = page.getByRole("dialog", { name: "Record adjustment" });
  await adjust.getByRole("button", { name: /Rear general/i }).click();
  await expect(adjust.getByTestId("adjust-turns-setting")).toContainText("+2.5 turns");
  await expect(adjust.getByRole("link", { name: "Adjust Track tension in Quick Tune" })).toBeVisible();
  await adjust.getByRole("button", { name: "Close" }).click();

  // The Garage Board: counts only; they open the Suspension page.
  await page.goto("/garage/board");
  const counts = visible(page.getByTestId("suspension-reminder-counts")).first();
  await expect(counts).toContainText("1 measurement needed · 1 photo needed");
  await counts.click();
  await expect(suspensionPage(page)).toBeVisible();

  // Record the measurement on Trail 4: no new Trail; Measurement Needed clears, Photo Needed stays.
  await page.goto(`/garage/${sledId}/suspension?view=quick`);
  await tension(page).getByRole("textbox", { name: "Measured Track tension" }).fill("1.5");
  await tension(page).getByRole("button", { name: "Record Measurement" }).click();
  await expect(suspensionPage(page).getByTestId("suspension-notice")).toContainText("Measurement recorded for Track tension on Trail 4");
  await expect(activeName(page)).toHaveText("Trail 4");
  await expect(tension(page).getByTestId("qt-measured")).toContainText("Measured 1.5 in after +2.5 turns");
  await expect(tension(page).getByTestId("measurement-needed")).toHaveCount(0);
  await expect(tension(page).getByTestId("photo-needed")).toBeVisible();

  // A correction, still on Trail 4.
  await tension(page).getByRole("button", { name: "Correct the recorded measurement of Track tension" }).click();
  await tension(page).getByRole("textbox", { name: "Measured Track tension" }).fill("1.75");
  await tension(page).getByRole("button", { name: "Save Correction" }).click();
  await expect(tension(page).getByTestId("qt-measured")).toContainText("Measured 1.75 in after +2.5 turns");
  await expect(activeName(page)).toHaveText("Trail 4");

  // One new photo clears Photo Needed on Trail 4.
  await tension(page)
    .getByRole("button", { name: /^Measurement photos of Track tension on Trail 4,/ })
    .click();
  const photos = page.getByRole("dialog", { name: "Measurement photos" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=", "base64");
  await photos.getByLabel("Choose photo 1 of Track tension (file)").setInputFiles({ name: "t.png", mimeType: "image/png", buffer: png });
  await expect(photos.getByText(/^Photo added to Trail 4\.$/)).toBeVisible({ timeout: 20_000 });
  await photos.getByRole("button", { name: "Close" }).click();
  await expect(tension(page).getByTestId("photo-needed")).toHaveCount(0, { timeout: 15_000 });
  await expect(suspensionPage(page).getByTestId("suspension-reminders")).toHaveCount(0);

  // History: each adjustment, and the measurement with its correction.
  await expect(config(page, 3).getByTestId("configuration-changes")).toContainText("Track tension: +1 turn (total +3 turns)");
  await expect(config(page, 4).getByTestId("configuration-measurements")).toContainText("Track tension measured 1.5 in after +2.5 turns");
  await expect(config(page, 4).getByTestId("configuration-measurements")).toContainText("Track tension corrected to 1.75 in");
  await expect(config(page, 2).getByTestId("configuration-reminders")).toContainText("Track tension");

  // The next Trail starts from the measurement; turns restart; the carried photo is outdated.
  await turns(page, "+1");
  await saveBar(page);
  await expect(activeName(page)).toHaveText("Trail 5");
  await expect(tension(page).getByTestId("qt-cumulative")).toContainText("+1 turn");
  await tension(page)
    .getByRole("button", { name: /^Measurement photos of Track tension on Trail 5,/ })
    .click();
  await expect(photos.getByTestId("photo-outdated")).toBeVisible();
  await photos.getByRole("button", { name: "Close" }).click();

  // Making Trail 2 active brings back its own reminders.
  await config(page, 2).getByRole("button", { name: "Make Trail 2 active" }).click();
  const activate = page.getByRole("dialog", { name: "Make active" });
  await activate.getByRole("button", { name: "Activate Trail 2" }).click();
  await expect(activate).toBeHidden({ timeout: 15_000 });
  await expect(activeName(page)).toHaveText("Trail 2");
  await expect(tension(page).getByTestId("qt-cumulative")).toContainText("+2 turns");
  await expect(tension(page).getByTestId("measurement-needed")).toBeVisible();
});
