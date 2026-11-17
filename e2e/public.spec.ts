import { expect, test } from "@playwright/test";

// These pages work without a session, so they run against any build.

test("homepage offers sign up and sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signup");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});

test("signed-out visitors are sent from the garage to sign in", async ({ page }) => {
  await page.goto("/garage");
  await expect(page).toHaveURL(/\/login\?next=%2Fgarage$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("signed-out visitors are sent from snowmobile pages to sign in", async ({ page }) => {
  await page.goto("/garage/new");
  await expect(page).toHaveURL(/\/login\?next=%2Fgarage%2Fnew$/);
  await page.goto("/garage/6aaaaaaa-0000-4000-8000-000000000001/edit");
  await expect(page).toHaveURL(/\/login\?next=%2Fgarage%2F6aaaaaaa-0000-4000-8000-000000000001%2Fedit$/);
});

test("sign-up form validates before contacting the server", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").filter({ visible: true }).fill("someone@example.com");
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill("long-enough-1");
  await page.getByLabel("Confirm password").filter({ visible: true }).fill("does-not-match");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Passwords don't match.")).toBeVisible();
  await expect(page).toHaveURL(/\/signup$/);
});

test("auth pages link to each other", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: /forgot/i }).click();
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await page.goto("/login");
  await page.getByRole("link", { name: /create/i }).click();
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
});

test("an expired or invalid email link shows an error on sign in", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=bogus&type=bogus");
  await expect(page).toHaveURL(/\/login\?error=link$/);
  await expect(page.getByText("That link is invalid or has expired.", { exact: false })).toBeVisible();
});
