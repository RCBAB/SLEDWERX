import { expect, test, type Page } from "@playwright/test";

// Needs a running Supabase Auth server (CI uses the local Supabase stack) and
// its Mailpit inbox for the password-reset email.
const MAILPIT_URL = process.env.MAILPIT_URL;
test.skip(!process.env.E2E_SUPABASE, "Set E2E_SUPABASE=1 with a local Supabase stack to run auth tests.");

const PASSWORD = "snow-trail-2026";

// On failure, print where the page ended up and what it shows (CI logs).
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const text = await page.locator("body").innerText().catch(() => "(no body)");
  console.log(`[${testInfo.title}] url=${page.url()}\n${text.slice(0, 1500)}`);
});

function uniqueEmail(label: string) {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function signUp(page: Page, email: string, name?: string) {
  await page.goto("/signup");
  if (name) await page.getByLabel("Name (optional)").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/garage$/);
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
}

test("sign up lands in an empty garage with the profile name", async ({ page }) => {
  await signUp(page, uniqueEmail("signup"), "Alex Rider");
  await expect(page.getByRole("heading", { name: "My Snowmobiles", level: 1 })).toBeVisible();
  await expect(page.getByText("Welcome, Alex Rider.")).toBeVisible();
  await expect(page.getByText("No snowmobiles yet")).toBeVisible();
  await expect(page.getByTestId("account-name")).toContainText("Alex Rider");
});

test("sign out, wrong password, then sign in again", async ({ page }) => {
  const email = uniqueEmail("login");
  await signUp(page, email);
  await signOut(page);
  await expect(page.getByText("You've signed out.")).toBeVisible();

  // The session is gone: the garage redirects to sign in.
  await page.goto("/garage");
  await expect(page).toHaveURL(/\/login\?next=%2Fgarage$/);

  await signIn(page, email, "not-the-password");
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();

  await signIn(page, email);
  await expect(page).toHaveURL(/\/garage$/);
  await expect(page.getByText("Welcome to your garage.")).toBeVisible();
});

test("signed-in users skip the homepage and sign-in pages", async ({ page }) => {
  await signUp(page, uniqueEmail("redirect"));
  for (const path of ["/", "/login", "/signup"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/garage$/);
  }
});

test("sign in ignores off-site next= redirects", async ({ page }) => {
  const email = uniqueEmail("next");
  await signUp(page, email);
  await signOut(page);
  await page.goto("/login?next=//evil.example/steal");
  await signIn(page, email);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/garage$/);
});

test("navigation adapts to the screen size", async ({ page, isMobile }) => {
  await signUp(page, uniqueEmail("nav"));
  const navLink = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My Snowmobiles" });
  await expect(navLink).toHaveCount(1); // only the visible one is exposed
  await expect(navLink).toBeVisible();
  await expect(navLink).toHaveAttribute("aria-current", "page");
  const box = await navLink.boundingBox();
  const viewport = page.viewportSize()!;
  if (isMobile) expect(box!.y).toBeGreaterThan(viewport.height / 2); // bottom bar
  else expect(box!.x).toBeLessThan(viewport.width / 3); // sidebar
});

test("password reset by email", async ({ page }) => {
  test.skip(!MAILPIT_URL, "Set MAILPIT_URL to the local Mailpit inbox.");
  const email = uniqueEmail("reset");
  await signUp(page, email);
  await signOut(page);

  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/If an account exists/)).toBeVisible();

  let link: string | null = null;
  await expect.poll(async () => (link = await findResetLink(email)), { timeout: 20_000 }).toBeTruthy();
  await page.goto(link!);
  await expect(page).toHaveURL(/\/reset-password$/);

  const newPassword = "fresh-powder-2026";
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/garage$/);

  await signOut(page);
  await signIn(page, email, newPassword);
  await expect(page).toHaveURL(/\/garage$/);
});

async function findResetLink(email: string): Promise<string | null> {
  const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  if (!search.ok) return null;
  const { messages } = (await search.json()) as { messages: { ID: string }[] };
  if (!messages?.length) return null;
  const message = await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`);
  const { Text, HTML } = (await message.json()) as { Text?: string; HTML?: string };
  const match = `${Text ?? ""} ${HTML ?? ""}`.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/);
  return match ? match[0].replaceAll("&amp;", "&") : null;
}
