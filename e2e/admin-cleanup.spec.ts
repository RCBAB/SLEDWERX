import { execFileSync } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { NEEDS_SUPABASE, PASSWORD, addSled, hasSupabase, shareSled, signIn, signUp, uniqueEmail } from "./helpers";

// The administrator cleanup dashboard against the local Supabase stack. The
// tests change system-wide cleanup data, so they run in the desktop project
// only (phone and tablet sizes are checked by resizing).
const PSQL = process.env.E2E_PSQL;
test.skip(!hasSupabase || !PSQL, `${NEEDS_SUPABASE} (and E2E_PSQL for administrator setup)`);
test.describe.configure({ mode: "serial" });

const URL = "/admin/cleanup";
const dashboard = (page: Page) => page.getByTestId("cleanup-dashboard");

/** SQL as the database owner on the throwaway local stack (test setup only). */
function sql(query: string): string {
  return execFileSync("sh", ["-c", `${PSQL} -X -q -v ON_ERROR_STOP=1 -tA`], { input: query, encoding: "utf8" }).trim();
}
const userId = (email: string) => sql(`select id from auth.users where email = '${email}';`);
const resetCleanup = () =>
  sql(`select private.revoke_cleanup_deletion();
       delete from private.storage_cleanup_claims; delete from private.cleanup_runs;`);

async function expectNotFound(page: Page) {
  await page.goto(URL);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
  await expect(page.getByText("Daily report runs")).toHaveCount(0);
}

async function rpcAs(email: string | null) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (email) {
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw error;
  }
  return client.rpc("cleanup_dashboard");
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Changes system-wide data: desktop project only.");
});

test("signed-out visitors are sent to sign in, and the API refuses them", async ({ page }) => {
  await page.goto(URL);
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fcleanup$/);
  const { data, error } = await rpcAs(null);
  expect(data).toBeNull();
  expect(error).not.toBeNull();
});

test("owners, editors, mechanics and viewers get 'not found', and the API refuses them", async ({ page, browser }) => {
  const owner = uniqueEmail("adm-owner");
  await signUp(page, owner);
  const sledId = await addSled(page, { make: "Polaris", model: "RMK", year: "2022", odometer: "2000" });
  await expectNotFound(page);

  for (const role of ["editor", "mechanic", "viewer"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    const email = uniqueEmail(`adm-${role}`);
    await signUp(other, email);
    await shareSled(owner, sledId, email, role);
    await expectNotFound(other);
    const { data, error } = await rpcAs(email);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
    await context.close();
  }

  const { data, error } = await rpcAs(owner);
  expect(data).toBeNull();
  expect(error?.code).toBe("42501");
});

test.describe("an administrator", () => {
  let admin: string;

  test.beforeAll(() => resetCleanup());
  // Each test has its own browser context: sign the administrator in again.
  test.beforeEach(async ({ page }, testInfo) => {
    if (!admin || testInfo.title.startsWith("sees the empty state")) return;
    await page.goto(`/login?next=${encodeURIComponent(URL)}`);
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin\/cleanup$/);
  });
  test.afterAll(() => {
    resetCleanup();
    if (admin) sql(`delete from private.app_administrators where user_id = '${userId(admin)}';`);
  });

  test("sees the empty state before any cleanup has run", async ({ page }) => {
    admin = uniqueEmail("adm-admin");
    await signUp(page, admin);
    await expectNotFound(page);
    sql(`select private.grant_app_administrator('${userId(admin)}', 'e2e test administrator');`);

    await page.goto(URL);
    await expect(page.getByRole("heading", { name: "Cleanup monitoring", level: 1 })).toBeVisible();
    await expect(page.getByTestId("dashboard-empty")).toContainText("No cleanup runs yet");
    await expect(page.getByTestId("dashboard-mode")).toContainText("Report-only");
    await expect(page.getByTestId("dashboard-report-runs")).toContainText("0 of 7 required");
    await expect(page.getByTestId("dashboard-backup")).toContainText("Not recorded");
    await expect(page.getByTestId("dashboard-last-run")).toContainText("None yet");
    await expect(page.getByTestId("dashboard-no-warnings")).toBeVisible();
  });

  test("sees what the runs found, warnings, oversized groups and history", async ({ page }) => {
    sql(`
      insert into private.cleanup_runs (mode, source, status, started_at, finished_at, records_step_at, files_step_at, summary)
      select 'report', 'scheduled', 'completed', now() - d * interval '1 day', now() - d * interval '1 day' + interval '4 seconds',
             now() - d * interval '1 day', now() - d * interval '1 day',
             jsonb_build_object(
               'records', jsonb_build_object('candidates', 30 + d, 'backlog', 25, 'newly_expired', 5 + d, 'rows', 120, 'limit', 200,
                                             'outcomes', jsonb_build_object('would_delete', 20, 'too_large', 1), 'needs_review', true),
               'files', jsonb_build_object('storage_unreadable', false, 'needs_review', true, 'buckets', jsonb_build_object(
                 'issue-photos', jsonb_build_object('objects', 8, 'referenced', 5, 'orphans', 3, 'blocked', false),
                 'suspension-photos', jsonb_build_object('objects', 4, 'referenced', 4, 'orphans', 0, 'unrecognized', 1, 'blocked', false))))
      from generate_series(7, 1, -1) d;
      insert into private.cleanup_candidates (run_id, kind, table_name, record_id, sled_id, group_rows, outcome, detail)
      select max(id), 'record', 'sleds', gen_random_uuid(), gen_random_uuid(), 512, 'too_large', 'Needs administrator review'
      from private.cleanup_runs;
      insert into private.cleanup_candidates (run_id, kind, bucket_id, object_path, outcome, detail)
      select max(id), 'file', 'suspension-photos', 'notes/readme.txt', 'unrecognized', 'Not a SledWerx photo path' from private.cleanup_runs;
      insert into private.cleanup_runs (mode, source, status, started_at, finished_at, error)
      values ('report', 'scheduled', 'failed', now(), now(), 'Reporting files failed: test error');`);

    await page.goto(URL);
    await expect(page.getByTestId("dashboard-report-runs")).toContainText("7 of 7 required");
    await expect(page.getByRole("progressbar", { name: "Successful daily report runs" })).toHaveAttribute("aria-valuenow", "7");
    await expect(page.getByTestId("dashboard-last-run")).toContainText("failed");
    await expect(page.getByTestId("dashboard-last-run")).toContainText("Reporting files failed: test error");
    await expect(page.getByTestId("dashboard-warnings")).toContainText("1 of the last 14 runs failed or did not finish.");
    await expect(page.getByTestId("records-candidates")).toContainText("31");
    await expect(page.getByTestId("records-backlog")).toContainText("25");
    await expect(page.getByTestId("records-new")).toContainText("6");
    await expect(page.getByTestId("bucket-row")).toHaveCount(2);
    await expect(page.getByTestId("bucket-row").filter({ hasText: "issue-photos" })).toContainText("3");
    await expect(page.getByTestId("oversized-row")).toHaveCount(1);
    await expect(page.getByTestId("oversized-row")).toContainText("512");
    await expect(page.getByTestId("attention-row").filter({ hasText: "notes/readme.txt" })).toContainText("Unrecognised path");
    await expect(page.getByTestId("history-row")).toHaveCount(8);
  });

  test("sees deletion authorized in the database, while the server setting keeps runs report-only", async ({ page }) => {
    sql(`select private.authorize_cleanup_deletion('e2e backup SECRET-REFERENCE');`);
    await page.goto(URL);
    await expect(page.getByTestId("dashboard-mode")).toContainText("Report-only");
    await expect(page.getByTestId("dashboard-mode")).toContainText("Database switch: on");
    await expect(page.getByTestId("dashboard-mode")).toContainText("Only one switch is on (database)");
    await expect(page.getByTestId("dashboard-backup")).toContainText("Recorded");
    await expect(page.getByTestId("dashboard-backup")).toContainText("Deletion authorized");
    await expect(page.locator("body")).not.toContainText("SECRET-REFERENCE");
  });

  test("the dashboard is read-only: no buttons, forms or inputs", async ({ page }) => {
    await page.goto(URL);
    await expect(dashboard(page)).toBeVisible();
    await expect(dashboard(page).locator("button, form, input, select, textarea")).toHaveCount(0);
  });

  test("works on phone, tablet and desktop, passes accessibility checks and is keyboard-navigable", async ({ page }) => {
    for (const [width, height] of [
      [360, 780],
      [768, 1024],
      [1440, 1000],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(URL);
      await expect(dashboard(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const { violations } = await new AxeBuilder({ page }).include("main").analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    // Wide tables scroll inside their own region, reachable by keyboard.
    const region = page.getByRole("region", { name: "Recent cleanup runs" });
    await region.focus();
    await expect(region).toBeFocused();
    await page.keyboard.press("ArrowRight");
  });

  test("loses access as soon as it is revoked", async ({ page }) => {
    await page.goto(URL);
    await expect(dashboard(page)).toBeVisible();
    sql(`select private.revoke_app_administrator('${userId(admin)}');`);
    await expectNotFound(page);
  });
});
