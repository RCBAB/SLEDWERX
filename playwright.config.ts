import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://127.0.0.1:${PORT}`;
// Set PLAYWRIGHT_CHROMIUM_PATH to use an already-installed Chromium.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // Runs the production build (`npm run build` first), twice: suspension photo
  // uploads off (the default, as in production for now) and, on the next
  // port, on (for the photo tests; see e2e/helpers.ts PHOTOS_URL).
  webServer: [
    {
      command: `npx next start -p ${PORT} -H 127.0.0.1`,
      url: baseURL,
      env: { SUSPENSION_PHOTO_UPLOADS: "" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npx next start -p ${PORT + 1} -H 127.0.0.1`,
      url: `http://127.0.0.1:${PORT + 1}`,
      env: { SUSPENSION_PHOTO_UPLOADS: "on" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
