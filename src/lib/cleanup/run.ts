import type { CleanupMode } from "./config";

/**
 * One cleanup run (Migration 8): start a run, process expired records, report
 * files and - only in a delete run - remove eligible orphaned photos one by
 * one through the Storage API. Every decision about what may be deleted is
 * made in the database; this code only carries out removals the database has
 * just claimed and verified, and reports back exactly what Storage removed.
 *
 * Fails closed: any database error stops the run (the run is closed with the
 * error and open claims are released); nothing is ever removed without a
 * successful claim and verification immediately before.
 */

export type DbError = { code?: string; message: string };
export type RpcResult = { data: unknown; error: DbError | null };

/** The database calls the job needs (service role). */
export interface CleanupDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
}

/** What Storage reports it removed. */
export type RemovedObject = { id?: string; name?: string; metadata?: Record<string, unknown> | null };

export interface CleanupStorage {
  remove(bucket: string, paths: string[]): Promise<{ data: RemovedObject[] | null; error: { message: string } | null }>;
}

export type EligibleFile = { bucket_id: string; object_path: string };

export type CleanupReport = {
  status: "completed" | "failed" | "busy";
  runId: number | null;
  requestedMode: CleanupMode;
  mode: CleanupMode;
  warnings: string[];
  records: unknown;
  files: unknown;
  removal: { removed: number; replaced: number; missing: number; skipped: number; failed: number; stoppedEarly: string | null };
  error: string | null;
};

export type RunCleanupOptions = {
  db: CleanupDb;
  storage: CleanupStorage;
  requestedMode: CleanupMode;
  warnings?: string[];
  /** Stop starting new file removals after this time (ms since epoch). */
  deadline: number;
  now?: () => number;
  /** Stop after this many failed removals in a row (Storage down). */
  maxConsecutiveFailures?: number;
  /** Test hook: runs right before each Storage removal. */
  beforeRemove?: (file: EligibleFile) => Promise<void>;
};

class CleanupDbFailure extends Error {
  constructor(step: string, error: DbError) {
    super(`${step} failed: ${error.message}${error.code ? ` (${error.code})` : ""}`);
  }
}

export async function runCleanup(options: RunCleanupOptions): Promise<CleanupReport> {
  const { db, storage, requestedMode, deadline } = options;
  const now = options.now ?? Date.now;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  const warnings = [...(options.warnings ?? [])];
  const removal = { removed: 0, replaced: 0, missing: 0, skipped: 0, failed: 0, stoppedEarly: null as string | null };
  const report = (fields: Partial<CleanupReport>): CleanupReport => ({
    status: "completed",
    runId: null,
    requestedMode,
    mode: "report",
    warnings,
    records: null,
    files: null,
    removal,
    error: null,
    ...fields,
  });

  // 1. Start a run. Deletion needs the database switch too: if it is off,
  //    the run continues report-only.
  let mode: CleanupMode = requestedMode;
  let begin = await db.rpc("cleanup_begin_run", { p_mode: mode });
  if (begin.error && mode === "delete" && begin.error.code === "42501") {
    warnings.push("Deletion is not authorized in the database; running report-only.");
    mode = "report";
    begin = await db.rpc("cleanup_begin_run", { p_mode: mode });
  }
  if (begin.error) {
    if (begin.error.code === "55P03") return report({ status: "busy", mode, error: "Another cleanup run is in progress." });
    return report({ status: "failed", mode, error: new CleanupDbFailure("Starting the run", begin.error).message });
  }
  const runId = Number(begin.data);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return report({ status: "failed", mode, error: "Starting the run returned no run id." });
  }

  const call = async (step: string, fn: string, args: Record<string, unknown>) => {
    const result = await db.rpc(fn, { p_run_id: runId, ...args });
    if (result.error) throw new CleanupDbFailure(step, result.error);
    return result.data;
  };

  let records: unknown = null;
  let files: unknown = null;
  try {
    // 2. Records (the database enforces the 200-row limit and every rule).
    records = await call("Processing records", "cleanup_process_records", {});
    // 3. Files: counts, safety checks, candidates.
    files = await call("Reporting files", "cleanup_report_files", {});

    // 4. Delete runs only: remove what the database lists, one file at a time.
    if (mode === "delete") {
      const eligible = ((await call("Listing removable files", "cleanup_eligible_files", {})) ?? []) as EligibleFile[];
      let consecutiveFailures = 0;
      for (const file of eligible) {
        if (now() >= deadline) {
          removal.stoppedEarly = "time";
          warnings.push("Stopped before the time limit; the remaining files wait for the next run.");
          break;
        }
        const target = { p_bucket_id: file.bucket_id, p_object_path: file.object_path };
        const claim = (await call("Claiming a file", "cleanup_claim_file", target)) as { claimed?: boolean };
        if (!claim?.claimed) {
          removal.skipped++;
          continue;
        }
        // Immediately before removal: still exactly the claimed object?
        const verify = (await call("Checking a file", "cleanup_verify_claim", target)) as { ok?: boolean };
        if (!verify?.ok) {
          removal.skipped++;
          continue;
        }
        await options.beforeRemove?.(file);

        let removed = false;
        let storageError: string | null = null;
        let removedObject: RemovedObject | null = null;
        try {
          const result = await storage.remove(file.bucket_id, [file.object_path]);
          if (result.error) {
            storageError = result.error.message;
          } else {
            removed = true;
            const objects = result.data ?? [];
            removedObject = objects.find((o) => o.name === file.object_path) ?? (objects.length === 1 ? objects[0] : null);
          }
        } catch (error) {
          storageError = error instanceof Error ? error.message : "Storage request failed.";
        }

        const outcome = (await call("Recording a file result", "cleanup_record_file_result", {
          ...target,
          p_removed: removed,
          p_error: storageError,
          p_deleted_object: removedObject,
        })) as { status?: string };

        switch (outcome?.status) {
          case "deleted":
            removal.removed++;
            consecutiveFailures = 0;
            break;
          case "replaced":
            removal.replaced++;
            consecutiveFailures = 0;
            warnings.push("A file was replaced at the same path just before removal; flagged for review.");
            break;
          case "missing":
            removal.missing++;
            consecutiveFailures = 0;
            break;
          default:
            removal.failed++;
            consecutiveFailures++;
        }
        if (consecutiveFailures >= maxConsecutiveFailures) {
          removal.stoppedEarly = "storage_failures";
          warnings.push(`Stopped after ${consecutiveFailures} failed removals in a row.`);
          break;
        }
      }
    }

    // 5. Close the run (open claims are released).
    await call("Finishing the run", "cleanup_finish_run", { p_error: null });
    return report({ runId, mode, records, files });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed.";
    await db.rpc("cleanup_finish_run", { p_run_id: runId, p_error: message }).catch(() => undefined);
    return report({ status: "failed", runId, mode, records, files, error: message });
  }
}

/** A short, content-free line for the logs. */
export function summarizeReport(report: CleanupReport) {
  const records = report.records as { candidates?: number; backlog?: number; rows?: number; outcomes?: unknown; needs_review?: boolean } | null;
  const files = report.files as { needs_review?: boolean; storage_unreadable?: boolean; registry_problems?: string[] } | null;
  return {
    event: "sledwerx.cleanup",
    status: report.status,
    run_id: report.runId,
    requested_mode: report.requestedMode,
    mode: report.mode,
    record_candidates: records?.candidates ?? null,
    record_backlog: records?.backlog ?? null,
    record_rows: records?.rows ?? null,
    record_outcomes: records?.outcomes ?? null,
    removal: report.removal,
    needs_review: Boolean(records?.needs_review || files?.needs_review),
    storage_unreadable: files?.storage_unreadable ?? null,
    registry_problems: files?.registry_problems?.length ?? null,
    warnings: report.warnings,
    error: report.error,
  };
}
