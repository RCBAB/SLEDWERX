import { beforeEach, describe, expect, it, vi } from "vitest";

// Correcting a check's outcome (Decision G) is two steps: the record edit
// (update_maintenance_entry), then the outcome. These tests replace the
// database client to check what happens when the second step fails, and that
// retrying runs only that step, so nothing is saved or logged twice.

type Result = { error: { code?: string; message?: string } | null };
const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  updates: [] as { table: string; values: unknown; filters: [string, ...unknown[]][] }[],
  updateResults: [] as Result[],
}));

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => ({ id: "user" }) }));
vi.mock("@/lib/sleds/queries", () => ({ getSled: async () => ({ id: SLED, ownerId: "user", role: "owner" }) }));
vi.mock("@/lib/service/queries", () => ({ taskOptionsForSled: async () => [{ id: TASK, name: "Drive belt" }] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: db.rpc,
    from: (table: string) => ({
      update: (values: unknown) => {
        const entry = { table, values, filters: [] as [string, ...unknown[]][] };
        db.updates.push(entry);
        const builder = {
          eq: (...a: unknown[]) => (entry.filters.push(["eq", ...a]), builder),
          in: (...a: unknown[]) => (entry.filters.push(["in", ...a]), builder),
          is: (...a: unknown[]) => (entry.filters.push(["is", ...a]), builder),
          not: (...a: unknown[]) => (entry.filters.push(["not", ...a]), builder),
          neq: (...a: unknown[]) => (entry.filters.push(["neq", ...a]), builder),
          then: (resolve: (r: Result) => unknown) => resolve(db.updateResults.shift() ?? { error: null }),
        };
        return builder;
      },
    }),
  }),
}));

const SLED = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";

import { retryCorrections, updateService } from "./service-actions";

function form() {
  const f = new FormData();
  f.set("sledId", SLED);
  f.set("entryId", ENTRY);
  f.set("version", "3");
  f.set("title", "Inspection");
  f.set("category", "inspection");
  f.set("performedOn", "2026-11-01");
  f.set("odometer", "2000");
  f.set("tasks", JSON.stringify([{ id: ITEM, taskId: TASK, name: "Drive belt", outcome: "good" }]));
  f.set("parts", "[]");
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.updates.length = 0;
  db.updateResults.length = 0;
  db.rpc.mockResolvedValue({ data: { entry_id: ENTRY }, error: null });
});

describe("correcting a check's outcome", () => {
  it("edits the record, then changes only an existing check whose outcome differs", async () => {
    const result = await updateService({}, form());
    expect(result).toMatchObject({ ok: true });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0][0]).toBe("update_maintenance_entry");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ table: "maintenance_entry_tasks", values: { outcome: "good" } });
    expect(db.updates[0].filters).toEqual([
      ["eq", "entry_id", ENTRY],
      ["in", "id", [ITEM]],
      ["is", "deleted_at", null],
      ["not", "outcome", "is", null],
      ["neq", "outcome", "good"],
    ]);
  });

  it("says clearly when the record was saved but the correction wasn't", async () => {
    db.updateResults.push({ error: { code: "08006", message: "connection lost" } });
    const result = await updateService({}, form());
    expect(result.ok).toBeUndefined();
    expect(result.correctionPending).toBe(true);
    expect(result.error).toMatch(/^Your other changes were saved, but the check result could not be changed/);
    expect(result.error).toContain("Retry check result");
  });

  it("retries only the correction: the record isn't edited (or logged) again", async () => {
    const retried = await retryCorrections({ correctionPending: true }, form());
    expect(retried).toMatchObject({ ok: true });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(1);
    // Already-corrected items are filtered out, so a repeat changes nothing.
    expect(db.updates[0].filters).toContainEqual(["neq", "outcome", "good"]);
  });

  it("keeps offering the retry while it keeps failing", async () => {
    db.updateResults.push({ error: { code: "08006", message: "connection lost" } });
    const retried = await retryCorrections({ correctionPending: true }, form());
    expect(retried).toMatchObject({ correctionPending: true });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
