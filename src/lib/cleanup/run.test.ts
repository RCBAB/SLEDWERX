import { describe, expect, it, vi } from "vitest";

import { cleanupDeps } from "./adapters";
import { runCleanup, summarizeReport, type CleanupStorage, type RpcResult } from "./run";

type Handler = (args: Record<string, unknown>) => RpcResult | Promise<RpcResult>;

/** A fake database that answers like the cleanup functions do. */
function fakeDb(overrides: Record<string, Handler> = {}, files = ["a", "b"]) {
  const calls: [string, Record<string, unknown>][] = [];
  const handlers: Record<string, Handler> = {
    cleanup_begin_run: () => ({ data: 7, error: null }),
    cleanup_process_records: () => ({ data: { candidates: 2, backlog: 1, rows: 4, outcomes: { would_delete: 2 } }, error: null }),
    cleanup_report_files: () => ({ data: { needs_review: false }, error: null }),
    cleanup_eligible_files: () => ({ data: files.map((f) => ({ bucket_id: "suspension-photos", object_path: f })), error: null }),
    cleanup_claim_file: () => ({ data: { claimed: true }, error: null }),
    cleanup_verify_claim: () => ({ data: { ok: true }, error: null }),
    // Like the database: the removed object must be the claimed one.
    cleanup_record_file_result: (args) => {
      const removed = args.p_deleted_object as { id?: string } | null;
      const status = !args.p_removed
        ? "released"
        : !removed
          ? "missing"
          : removed.id === `id-${args.p_object_path}`
            ? "deleted"
            : "replaced";
      return { data: { status }, error: null };
    },
    cleanup_retention: () => ({ data: { enabled: false, qualifying: { runs: 0 }, removed: { details: 0, released_claims: 0, runs: 0 } }, error: null }),
    cleanup_finish_run: () => ({ data: {}, error: null }),
    ...overrides,
  };
  return {
    calls,
    names: () => calls.map(([fn]) => fn),
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push([fn, args]);
      const handler = handlers[fn];
      if (!handler) throw new Error(`unexpected call ${fn}`);
      return handler(args);
    },
  };
}

/** A fake Storage that removes the claimed object unless told otherwise. */
function fakeStorage(behaviour: (path: string) => Awaited<ReturnType<CleanupStorage["remove"]>> = (path) => ({
  data: [{ id: `id-${path}`, name: path, metadata: { eTag: "x", size: 1 } }],
  error: null,
})) {
  const remove = vi.fn(async (_bucket: string, paths: string[]) => behaviour(paths[0]));
  return { remove };
}

const later = () => Date.now() + 60_000;

describe("runCleanup: report-only", () => {
  it("reports records and files and never claims or removes anything", async () => {
    const db = fakeDb();
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "report", deadline: later() });
    expect(report).toMatchObject({ status: "completed", runId: 7, mode: "report", error: null });
    expect(db.names()).toEqual(["cleanup_begin_run", "cleanup_process_records", "cleanup_report_files", "cleanup_retention", "cleanup_finish_run"]);
    expect(db.calls[0][1]).toEqual({ p_mode: "report" });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("runs report-only when the database's deletion switch is off, even if CLEANUP_MODE=delete", async () => {
    const db = fakeDb({
      cleanup_begin_run: (args) =>
        args.p_mode === "delete"
          ? { data: null, error: { code: "42501", message: "Cleanup deletion is not authorized." } }
          : { data: 8, error: null },
    });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report).toMatchObject({ status: "completed", runId: 8, requestedMode: "delete", mode: "report" });
    expect(report.warnings).toContain("Deletion is not authorized in the database; running report-only.");
    expect(db.names()).not.toContain("cleanup_claim_file");
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("runCleanup: delete runs", () => {
  it("removes each listed file after a claim and a check, reporting exactly what Storage removed", async () => {
    const db = fakeDb();
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report.removal).toEqual({ removed: 2, replaced: 0, missing: 0, skipped: 0, failed: 0, stoppedEarly: null });
    expect(db.names()).toEqual([
      "cleanup_begin_run", "cleanup_process_records", "cleanup_report_files", "cleanup_eligible_files",
      "cleanup_claim_file", "cleanup_verify_claim", "cleanup_record_file_result",
      "cleanup_claim_file", "cleanup_verify_claim", "cleanup_record_file_result",
      "cleanup_retention", "cleanup_finish_run",
    ]);
    const result = db.calls.find(([fn]) => fn === "cleanup_record_file_result")![1];
    expect(result).toEqual({
      p_run_id: 7, p_bucket_id: "suspension-photos", p_object_path: "a", p_removed: true, p_error: null,
      p_deleted_object: { id: "id-a", name: "a", metadata: { eTag: "x", size: 1 } },
    });
    expect(storage.remove).toHaveBeenCalledWith("suspension-photos", ["a"]);
  });

  it("does not remove a file whose claim is refused (referenced, too new, changed, limit…)", async () => {
    const db = fakeDb({ cleanup_claim_file: (args) => ({ data: args.p_object_path === "a" ? { claimed: false, reason: "referenced" } : { claimed: true }, error: null }) });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith("suspension-photos", ["b"]);
    expect(report.removal).toMatchObject({ removed: 1, skipped: 1 });
  });

  it("does not remove a file that changed after its claim (same-path replacement)", async () => {
    const db = fakeDb({ cleanup_verify_claim: () => ({ data: { ok: false, reason: "changed" }, error: null }) });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(report.removal).toMatchObject({ removed: 0, skipped: 2 });
  });

  it("flags a replacement uploaded between the check and the removal", async () => {
    const db = fakeDb({}, ["a"]);
    const storage = fakeStorage((path) => ({ data: [{ id: "someone-elses-upload", name: path, metadata: {} }], error: null }));
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report.removal).toMatchObject({ removed: 0, replaced: 1 });
    expect(report.warnings).toContain("A file was replaced at the same path just before removal; flagged for review.");
  });

  it("records a Storage failure, keeps going, and stops after 3 failures in a row", async () => {
    const db = fakeDb({}, ["a", "b", "c", "d", "e"]);
    const storage = fakeStorage(() => ({ data: null, error: { message: "Storage unavailable" } }));
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(storage.remove).toHaveBeenCalledTimes(3);
    expect(report.removal).toMatchObject({ failed: 3, stoppedEarly: "storage_failures" });
    const result = db.calls.find(([fn]) => fn === "cleanup_record_file_result")![1];
    expect(result).toMatchObject({ p_removed: false, p_error: "Storage unavailable", p_deleted_object: null });
    expect(report.status).toBe("completed");
  });

  it("treats a thrown Storage request (timeout) as a failure, never as removed", async () => {
    const db = fakeDb({}, ["a"]);
    const storage = { remove: vi.fn(async () => Promise.reject(new Error("The operation was aborted due to timeout"))) };
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(db.calls.find(([fn]) => fn === "cleanup_record_file_result")![1]).toMatchObject({ p_removed: false });
    expect(report.removal.failed).toBe(1);
  });

  it("passes nothing when Storage removed nothing, so the database can tell", async () => {
    const db = fakeDb({}, ["a"]);
    const storage = fakeStorage(() => ({ data: [], error: null }));
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(db.calls.find(([fn]) => fn === "cleanup_record_file_result")![1]).toMatchObject({ p_removed: true, p_deleted_object: null });
    expect(report.removal.missing).toBe(1);
  });

  it("stops starting removals when the time budget is used up", async () => {
    const db = fakeDb();
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: Date.now() - 1 });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(db.names()).not.toContain("cleanup_claim_file");
    expect(report.removal.stoppedEarly).toBe("time");
    expect(db.names().at(-1)).toBe("cleanup_finish_run");
  });

  it("only works on the files the database lists (the 100-file limit is applied there)", async () => {
    const db = fakeDb({}, []);
    const storage = fakeStorage();
    await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("runCleanup: operational-history retention", () => {
  it("applies the retention step once per run, after the file work, in report runs too", async () => {
    const db = fakeDb();
    const report = await runCleanup({ db, storage: fakeStorage(), requestedMode: "report", deadline: later() });
    expect(db.names().filter((n) => n === "cleanup_retention")).toHaveLength(1);
    expect(report.retention).toMatchObject({ enabled: false });
  });

  it("a failed retention step fails the run (closed) and is reported", async () => {
    const db = fakeDb({ cleanup_retention: () => ({ data: null, error: { code: "SWC03", message: "Retention safety check failed" } }) });
    const report = await runCleanup({ db, storage: fakeStorage(), requestedMode: "report", deadline: later() });
    expect(report).toMatchObject({ status: "failed", error: "Applying retention failed: Retention safety check failed (SWC03)" });
    expect(db.calls.at(-1)).toEqual(["cleanup_finish_run", { p_run_id: 7, p_error: report.error }]);
  });
});

describe("runCleanup: failures never become permission to delete", () => {
  it("reports 'busy' when another run is in progress, and does nothing else", async () => {
    const db = fakeDb({ cleanup_begin_run: () => ({ data: null, error: { code: "55P03", message: "Another cleanup run is in progress." } }) });
    const report = await runCleanup({ db, storage: fakeStorage(), requestedMode: "delete", deadline: later() });
    expect(report.status).toBe("busy");
    expect(db.names()).toEqual(["cleanup_begin_run"]);
  });

  it("stops at a database error, closes the run with the error, and removes nothing after it", async () => {
    const db = fakeDb({ cleanup_claim_file: () => ({ data: null, error: { code: "SWC02", message: "The cleanup registry is incomplete." } }) });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report.status).toBe("failed");
    expect(report.error).toBe("Claiming a file failed: The cleanup registry is incomplete. (SWC02)");
    expect(storage.remove).not.toHaveBeenCalled();
    expect(db.calls.at(-1)).toEqual(["cleanup_finish_run", { p_run_id: 7, p_error: report.error }]);
  });

  it("stops if recording a result fails (the run's open claims are then closed by the database)", async () => {
    const db = fakeDb({ cleanup_record_file_result: () => ({ data: null, error: { message: "connection lost" } }) });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report.status).toBe("failed");
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it("fails when the records step fails, before any file work", async () => {
    const db = fakeDb({ cleanup_process_records: () => ({ data: null, error: { message: "boom" } }) });
    const storage = fakeStorage();
    const report = await runCleanup({ db, storage, requestedMode: "delete", deadline: later() });
    expect(report.status).toBe("failed");
    expect(db.names()).toEqual(["cleanup_begin_run", "cleanup_process_records", "cleanup_finish_run"]);
  });

  it("fails if the run id is missing", async () => {
    const db = fakeDb({ cleanup_begin_run: () => ({ data: null, error: null }) });
    const report = await runCleanup({ db, storage: fakeStorage(), requestedMode: "report", deadline: later() });
    expect(report).toMatchObject({ status: "failed", error: "Starting the run returned no run id." });
  });

  it("the summary for the logs holds counts, never paths or content", async () => {
    const report = await runCleanup({ db: fakeDb(), storage: fakeStorage(), requestedMode: "delete", deadline: later() });
    const line = JSON.stringify(summarizeReport(report));
    expect(line).toContain('"record_candidates":2');
    expect(line).not.toContain("suspension-photos");
  });
});

describe("cleanupDeps", () => {
  it("only calls cleanup functions", async () => {
    const client = { rpc: vi.fn(), storage: { from: vi.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db } = cleanupDeps(client as any);
    await expect(db.rpc("create_sled", {})).rejects.toThrow("Not a cleanup function: create_sled");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
