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
