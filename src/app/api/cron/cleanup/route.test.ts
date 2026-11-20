import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runCleanup: vi.fn(),
  createCleanupAdminClient: vi.fn(() => ({})),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
vi.mock("@/lib/cleanup/admin-client", () => ({ createCleanupAdminClient: mocks.createCleanupAdminClient }));
vi.mock("@/lib/cleanup/adapters", () => ({ cleanupDeps: () => ({ db: {}, storage: {} }) }));
vi.mock("@/lib/cleanup/run", async (original) => ({
  ...(await original<typeof import("@/lib/cleanup/run")>()),
  runCleanup: mocks.runCleanup,
}));

import { GET } from "./route";

const SECRET = "a-cron-secret-of-32-characters!!";
const KEY = "sb_secret_never_in_a_response";
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/cleanup", { headers: authorization ? { authorization } : {} });
const completed = {
  status: "completed",
  runId: 1,
  requestedMode: "report",
  mode: "report",
  warnings: [],
  records: null,
  files: null,
  removal: { removed: 0, replaced: 0, missing: 0, skipped: 0, failed: 0, stoppedEarly: null },
  error: null,
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", KEY);
  vi.stubEnv("CLEANUP_MODE", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.runCleanup.mockResolvedValue(completed);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.runCleanup.mockReset();
});

describe("GET /api/cron/cleanup", () => {
  it("refuses everything when CRON_SECRET is not set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(mocks.runCleanup).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without revealing the configuration", async () => {
    for (const header of [undefined, "Bearer wrong", SECRET]) {
      const response = await GET(request(header));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized." });
    }
    expect(mocks.runCleanup).not.toHaveBeenCalled();
    expect(mocks.createCleanupAdminClient).not.toHaveBeenCalled();
  });

  it("does not run without the secret key, and never echoes it", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(mocks.runCleanup).not.toHaveBeenCalled();
  });

  it("runs report-only by default", async () => {
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.runCleanup).toHaveBeenCalledWith(expect.objectContaining({ requestedMode: "report" }));
    expect(JSON.stringify(await response.json())).not.toContain(KEY);
  });

  it("asks for deletion only with CLEANUP_MODE=delete (the database must agree too)", async () => {
    vi.stubEnv("CLEANUP_MODE", "delete");
    await GET(request(`Bearer ${SECRET}`));
    expect(mocks.runCleanup).toHaveBeenCalledWith(expect.objectContaining({ requestedMode: "delete" }));
  });

  it("never asks for deletion from a preview deployment", async () => {
    vi.stubEnv("CLEANUP_MODE", "delete");
    vi.stubEnv("VERCEL_ENV", "preview");
    await GET(request(`Bearer ${SECRET}`));
    expect(mocks.runCleanup).toHaveBeenCalledWith(expect.objectContaining({ requestedMode: "report" }));
  });

  it("answers 409 to a duplicate invocation and 500 to a failed run", async () => {
    mocks.runCleanup.mockResolvedValueOnce({ ...completed, status: "busy" });
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(409);
    mocks.runCleanup.mockResolvedValueOnce({ ...completed, status: "failed", error: "Processing records failed" });
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(500);
  });

  it("logs a summary line without the secret key", async () => {
    await GET(request(`Bearer ${SECRET}`));
    const logged = vi.mocked(console.info).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"event":"sledwerx.cleanup"');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(SECRET);
  });
});
