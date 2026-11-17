import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, hasSupabase, signIn, signUp, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (Auth, database and Storage).
test.skip(!hasSupabase, NEEDS_SUPABASE);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 1500)}`);
});

const SLED_URL = /\/garage\/([0-9a-f-]{36})(\?.*)?$/;

// A small valid PNG (8x6, solid color) for photo uploads.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=",
  "base64",
);

type NewSled = { make: string; model: string; year: string; odometer: string; hours?: string; nickname?: string; vin?: string };

async function addSled(page: Page, sled: NewSled, photo = false): Promise<string> {
  await page.goto("/garage/new");
  await page.getByLabel("Manufacturer").filter({ visible: true }).fill(sled.make);
  await page.getByLabel("Model", { exact: true }).filter({ visible: true }).fill(sled.model);
  await page.getByLabel("Model year").filter({ visible: true }).fill(sled.year);
  if (sled.nickname) await page.getByLabel("Nickname (optional)").filter({ visible: true }).fill(sled.nickname);
  if (sled.vin) await page.getByLabel("VIN or serial number (optional)").filter({ visible: true }).fill(sled.vin);
  await page.getByLabel("Odometer (miles)").filter({ visible: true }).fill(sled.odometer);
  if (sled.hours) await page.getByLabel("Engine hours (optional)").filter({ visible: true }).fill(sled.hours);
  if (photo) {
    await page.locator('input[name="photo"]').setInputFiles({ name: "sled.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByRole("img", { name: "Snowmobile photo" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Add snowmobile" }).click();
  await expect(page).toHaveURL(SLED_URL, { timeout: 15_000 });
  return SLED_URL.exec(page.url())![1];
}

function updateMileage(page: Page) {
  return page.getByTestId("update-mileage");
}

test("add a snowmobile with every field and a private photo", async ({ page }) => {
  await signUp(page, uniqueEmail("add-sled"));
  await page.getByRole("link", { name: "Add snowmobile" }).first().click();
  await expect(page).toHaveURL(/\/garage\/new$/);

  await addSled(
    page,
    { make: "Polaris", model: "RMK Khaos", year: "2024", odometer: "1,234.5", hours: "51.2", nickname: "Blue Thunder", vin: "4XASKR123" },
    true,
  );
  await expect(page.getByText("Snowmobile added.").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blue Thunder", level: 1 })).toBeVisible();
  await expect(page.getByText("2024 Polaris RMK Khaos").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("1,234.5 mi");
  await expect(page.getByTestId("current-hours")).toHaveText("51.2 hrs");
  await expect(page.getByText("4XASKR123").filter({ visible: true })).toBeVisible();

  // The photo is served from the private bucket through a signed URL.
  const photo = page.getByRole("img", { name: "Blue Thunder" });
  await expect(photo).toHaveAttribute("src", /\/storage\/v1\/object\/sign\/sled-photos\//);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole("link", { name: "My Snowmobiles" }).first().click();
  const card = page.getByTestId("sled-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Blue Thunder");
  await expect(card).toContainText("1,234.5 mi");
});

test("validation, and several snowmobiles shown as cards", async ({ page }) => {
  await signUp(page, uniqueEmail("multi"));
  await page.goto("/garage/new");
  await page.getByLabel("Manufacturer").filter({ visible: true }).fill("Ski-Doo");
  await page.getByLabel("Model", { exact: true }).filter({ visible: true }).fill("Summit");
  await page.getByLabel("Model year").filter({ visible: true }).fill("1890");
  await page.getByRole("button", { name: "Add snowmobile" }).click();
  await expect(page.getByText("Model year must be 1950 or later.").filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/Enter the current odometer reading/).filter({ visible: true })).toBeVisible();
  await expect(page).toHaveURL(/\/garage\/new$/);
  // What was typed is kept.
  await expect(page.getByLabel("Model", { exact: true }).filter({ visible: true })).toHaveValue("Summit");

  await addSled(page, { make: "Ski-Doo", model: "Summit X", year: "2021", odometer: "0" });
  await expect(page.getByTestId("current-odometer")).toHaveText("0 mi");
  await expect(page.getByTestId("current-hours")).toHaveText("Not recorded");
  await addSled(page, { make: "Arctic Cat", model: "Riot 8000", year: "2023", odometer: "2200" });

  await page.goto("/garage");
  await expect(page.getByTestId("sled-card")).toHaveCount(2);
  await expect(page.getByTestId("sled-card").nth(0)).toContainText("Ski-Doo Summit X");
  await expect(page.getByTestId("sled-card").nth(1)).toContainText("Arctic Cat Riot 8000");
  await page.getByTestId("sled-card").nth(1).click();
  await expect(page.getByRole("heading", { name: "Arctic Cat Riot 8000", level: 1 })).toBeVisible();
});

test("edit details, including More details", async ({ page }) => {
  await signUp(page, uniqueEmail("edit"));
  const id = await addSled(page, { make: "Yamaha", model: "Sidewinder", year: "2022", odometer: "500" });

  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page).toHaveURL(new RegExp(`/garage/${id}/edit$`));
  await page.getByLabel("Nickname (optional)").filter({ visible: true }).fill("Yellow Jacket");
  await page.locator("summary", { hasText: "More details" }).filter({ visible: true }).click();
  await page.getByLabel("Status").filter({ visible: true }).selectOption("stored");
  await page.getByLabel("Engine", { exact: true }).filter({ visible: true }).fill("998 turbo triple");
  await page.getByLabel("Displacement (cc)").filter({ visible: true }).fill("998");
  await page.getByLabel("Notes").filter({ visible: true }).fill("Summer storage in the shed.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/garage/${id}\\?saved=1$`));
  await expect(page.getByText("Changes saved.").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yellow Jacket", level: 1 })).toBeVisible();
  await expect(page.getByText("Stored", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("998 turbo triple").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("998 cc").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Summer storage in the shed.").filter({ visible: true })).toBeVisible();

  // Invalid input is rejected and nothing is saved.
  await page.getByRole("link", { name: "Edit details" }).click();
  await page.getByLabel("Model", { exact: true }).filter({ visible: true }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter the model.").filter({ visible: true })).toBeVisible();
});

test("update mileage, refuse lower readings, replace a meter, fix and remove the last reading", async ({ page }) => {
  await signUp(page, uniqueEmail("mileage"));
  await addSled(page, { make: "Lynx", model: "Rave RE", year: "2020", odometer: "100", hours: "10" });

  const form = updateMileage(page);
  await form.getByLabel("Odometer (miles)").filter({ visible: true }).fill("150");
  await form.getByLabel("Engine hours").filter({ visible: true }).fill("12.5");
  await form.getByRole("button", { name: "Save reading" }).click();
  await expect(form.getByText("Mileage updated.")).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("150 mi");
  await expect(page.getByTestId("current-hours")).toHaveText("12.5 hrs");

  // Readings can't be dated after the user's own local today.
  const localDate = (offsetDays: number) =>
    page.evaluate((days) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date.toLocaleDateString("en-CA");
    }, offsetDays);
  await form.getByLabel("Odometer (miles)").filter({ visible: true }).fill("160");
  await form.getByLabel("Date").filter({ visible: true }).fill(await localDate(1));
  await form.getByRole("button", { name: "Save reading" }).click();
  await expect(form.getByText("The date can't be in the future.")).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("150 mi");
  await form.getByLabel("Date").filter({ visible: true }).fill(await localDate(0));

  await form.getByLabel("Odometer (miles)").filter({ visible: true }).fill("120");
  await form.getByRole("button", { name: "Save reading" }).click();
  await expect(form.getByText(/Odometer readings cannot go down/)).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("150 mi");

  // A replaced odometer starts again; lifetime miles carry on.
  await form.getByText("Meter replaced or reset?").click();
  await form.getByLabel("The odometer was replaced or reset").filter({ visible: true }).check();
  await form.getByLabel("Odometer (miles)").filter({ visible: true }).fill("5");
  await form.getByRole("button", { name: "Save reading" }).click();
  await expect(form.getByText("Mileage updated.")).toBeVisible();
  await expect(page.getByTestId("current-odometer")).toHaveText("5 mi");
  await expect(page.getByText("150 mi lifetime").filter({ visible: true })).toBeVisible();

  // Fix last reading: correct it, then remove it.
  const fix = page.getByTestId("fix-reading");
  await fix.getByText("Fix last reading").click();
  await fix.getByLabel("Odometer (miles)").filter({ visible: true }).fill("8");
  await fix.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByTestId("current-odometer")).toHaveText("8 mi");

  // The section may still be open after the correction; open it only if needed.
  if (!(await fix.evaluate((details: HTMLDetailsElement) => details.open))) {
    await fix.getByText("Fix last reading").click();
  }
  page.once("dialog", (dialog) => dialog.accept());
  await fix.getByRole("button", { name: "Remove last reading" }).click();
  await expect(page.getByTestId("current-odometer")).toHaveText("150 mi");
  await expect(page.getByTestId("reading-history").getByRole("listitem")).toHaveCount(2);
});

test("other people can't open your snowmobile", async ({ page, browser }) => {
  await signUp(page, uniqueEmail("owner"));
  const id = await addSled(page, { make: "Polaris", model: "Indy", year: "2018", odometer: "3000" });

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage, uniqueEmail("stranger"));
  await expect(otherPage.getByText("No snowmobiles yet").filter({ visible: true })).toBeVisible();
  for (const path of [`/garage/${id}`, `/garage/${id}/edit`]) {
    await otherPage.goto(path);
    await expect(otherPage.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();
  }
  await otherPage.goto("/garage/not-a-real-id");
  await expect(otherPage.getByRole("heading", { name: "Snowmobile not found" })).toBeVisible();
  await other.close();
});

test("a viewer sees a shared snowmobile read-only, photo included", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("share-owner");
  const viewerEmail = uniqueEmail("share-viewer");
  await signUp(page, ownerEmail);
  const id = await addSled(page, { make: "Arctic Cat", model: "M 8000", year: "2019", odometer: "4100", nickname: "Shared Cat" }, true);

  const viewer = await browser.newContext();
  const viewerPage = await viewer.newPage();
  await signUp(viewerPage, viewerEmail);

  // Share it with the existing invitation functions (the sharing screens come later).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const owner = createClient(url, key, options);
  await owner.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
  const { data: invitation, error: inviteError } = await owner.rpc("create_sled_invitation", {
    p_sled_id: id,
    p_email: viewerEmail,
    p_role: "viewer",
  });
  expect(inviteError).toBeNull();
  const recipient = createClient(url, key, options);
  await recipient.auth.signInWithPassword({ email: viewerEmail, password: PASSWORD });
  const { error: acceptError } = await recipient.rpc("accept_sled_invitation", { p_token: invitation![0].token });
  expect(acceptError).toBeNull();

  await viewerPage.goto("/garage");
  await expect(viewerPage.getByRole("heading", { name: "Shared with you" })).toBeVisible();
  await viewerPage.getByTestId("sled-card").click();
  await expect(viewerPage.getByRole("heading", { name: "Shared Cat", level: 1 })).toBeVisible();
  await expect(viewerPage.getByText("Shared with you · Viewer").filter({ visible: true })).toBeVisible();
  await expect(viewerPage.getByTestId("current-odometer")).toHaveText("4,100 mi");
  const photo = viewerPage.getByRole("img", { name: "Shared Cat" });
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await expect(viewerPage.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(viewerPage.getByTestId("update-mileage")).toHaveCount(0);
  await expect(viewerPage.getByTestId("fix-reading")).toHaveCount(0);
  await viewerPage.goto(`/garage/${id}/edit`);
  await expect(viewerPage).toHaveURL(new RegExp(`/garage/${id}$`));

  // Signing in again keeps the same access.
  await viewer.clearCookies();
  await viewerPage.goto("/login");
  await signIn(viewerPage, viewerEmail);
  await expect(viewerPage.getByTestId("sled-card")).toHaveCount(1);
  await viewer.close();
});
