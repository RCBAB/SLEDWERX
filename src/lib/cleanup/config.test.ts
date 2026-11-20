import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "./auth";
import { readCleanupConfig, readCronSecret } from "./config";

const SECRET = "a-cron-secret-of-32-characters!!";
const base = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
  SUPABASE_SECRET_KEY: "sb_secret_xyz",
};

describe("cron authentication", () => {
  it("accepts exactly 'Bearer <CRON_SECRET>'", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
  it("rejects a missing, wrong or differently formatted header", () => {
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("", SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer wrong", SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
  });
  it("rejects everything when no secret is configured", () => {
    expect(isAuthorizedCronRequest("Bearer ", null)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer null", null)).toBe(false);
  });
  it("only accepts a CRON_SECRET of at least 16 characters", () => {
    expect(readCronSecret({})).toBeNull();
    expect(readCronSecret({ CRON_SECRET: "short" })).toBeNull();
    expect(readCronSecret({ CRON_SECRET: `  ${SECRET} ` })).toBe(SECRET);
  });
});

describe("cleanup configuration", () => {
  it("defaults to report-only", () => {
    const result = readCleanupConfig(base);
    expect(result).toEqual({
      ok: true,
      config: { supabaseUrl: base.NEXT_PUBLIC_SUPABASE_URL, secretKey: "sb_secret_xyz", requestedMode: "report", warnings: [] },
    });
  });
  it("asks for deletion only with CLEANUP_MODE=delete", () => {
    expect(readCleanupConfig({ ...base, CLEANUP_MODE: "delete" })).toMatchObject({ ok: true, config: { requestedMode: "delete" } });
    expect(readCleanupConfig({ ...base, CLEANUP_MODE: " DELETE " })).toMatchObject({ ok: true, config: { requestedMode: "delete" } });
    expect(readCleanupConfig({ ...base, CLEANUP_MODE: "report" })).toMatchObject({ ok: true, config: { requestedMode: "report" } });
  });
  it("runs report-only for any other value, with a warning", () => {
    const result = readCleanupConfig({ ...base, CLEANUP_MODE: "yes" });
    expect(result).toMatchObject({ ok: true, config: { requestedMode: "report" } });
    if (result.ok) expect(result.config.warnings).toHaveLength(1);
  });
  it("never deletes from a preview or development deployment", () => {
    for (const VERCEL_ENV of ["preview", "development"]) {
      const result = readCleanupConfig({ ...base, CLEANUP_MODE: "delete", VERCEL_ENV });
      expect(result).toMatchObject({ ok: true, config: { requestedMode: "report" } });
      if (result.ok) expect(result.config.warnings[0]).toContain("only allowed in the production deployment");
    }
    expect(readCleanupConfig({ ...base, CLEANUP_MODE: "delete", VERCEL_ENV: "production" })).toMatchObject({
      config: { requestedMode: "delete" },
    });
  });
  it("refuses to run without the URL or the secret key", () => {
    expect(readCleanupConfig({ SUPABASE_SECRET_KEY: "sb_secret_xyz" })).toEqual({
      ok: false,
      problems: ["NEXT_PUBLIC_SUPABASE_URL is not set."],
    });
    expect(readCleanupConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://x" })).toEqual({ ok: false, problems: ["SUPABASE_SECRET_KEY is not set."] });
  });
  it("refuses the publishable key in place of the secret key", () => {
    expect(readCleanupConfig({ ...base, SUPABASE_SECRET_KEY: "sb_publishable_abc" })).toMatchObject({ ok: false });
    expect(readCleanupConfig({ ...base, SUPABASE_SECRET_KEY: "sb_publishable_other" })).toMatchObject({ ok: false });
  });
  it("refuses to run if the secret key is also in a NEXT_PUBLIC_ variable (sent to browsers)", () => {
    const result = readCleanupConfig({ ...base, NEXT_PUBLIC_SOMETHING: "sb_secret_xyz" });
    expect(result).toEqual({
      ok: false,
      problems: ["The secret key is also in NEXT_PUBLIC_SOMETHING, which is sent to browsers. Remove it and rotate the key."],
    });
  });
});
