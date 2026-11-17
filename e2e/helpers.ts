import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "snow-trail-2026";

export const hasSupabase = Boolean(process.env.E2E_SUPABASE);
export const NEEDS_SUPABASE = "Set E2E_SUPABASE=1 with a local Supabase stack to run these tests.";

export function uniqueEmail(label: string) {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export async function signUp(page: Page, email: string, name?: string) {
  await page.goto("/signup");
  if (name) await page.getByLabel("Name (optional)").filter({ visible: true }).fill(name);
  await page.getByLabel("Email").filter({ visible: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").filter({ visible: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/garage$/);
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel("Email").filter({ visible: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
}

export const SLED_URL = /\/garage\/([0-9a-f-]{36})(\?.*)?$/;

// A small valid PNG (8x6, solid color) for photo uploads.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQq7iDFTEMpAQAMUJFYTtzHLAAAAAASUVORK5CYII=",
  "base64",
);

export type NewSled = { make: string; model: string; year: string; odometer: string; hours?: string; nickname?: string; vin?: string };

export async function addSled(page: Page, sled: NewSled, photo = false): Promise<string> {
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

/**
 * Shares a sled with another user through the existing invitation functions
 * (the sharing screens come in a later phase). Both users must exist.
 */
export async function shareSled(ownerEmail: string, sledId: string, recipientEmail: string, role: "editor" | "mechanic" | "viewer") {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const owner = createClient(url, key, options);
  await owner.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
  const { data: invitation, error } = await owner.rpc("create_sled_invitation", {
    p_sled_id: sledId,
    p_email: recipientEmail,
    p_role: role,
  });
  expect(error).toBeNull();
  const recipient = createClient(url, key, options);
  await recipient.auth.signInWithPassword({ email: recipientEmail, password: PASSWORD });
  const { error: acceptError } = await recipient.rpc("accept_sled_invitation", { p_token: invitation![0].token });
  expect(acceptError).toBeNull();
}
