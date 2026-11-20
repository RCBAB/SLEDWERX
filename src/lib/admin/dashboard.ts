import { z } from "zod";

/**
 * The read-only cleanup dashboard's data, as returned by the database
 * function public.cleanup_dashboard() (administrators only). Parsed
 * defensively: anything unexpected becomes "unknown" rather than crashing
 * the page or showing a misleading value.
 */

const num = z.coerce.number().catch(0);
const optNum = z.coerce.number().nullable().catch(null);
const str = z.string().nullable().catch(null);
const bool = z.boolean().catch(false);

const bucketSchema = z
  .object({
    objects: num,
    referenced: num,
    orphans: num,
    too_new: num,
    unrecognized: num,
    metadata_missing: num,
    threshold_applies: bool,
    blocked: bool,
    blocked_reason: str,
  })
  .partial()
  .catch({});

const runSchema = z.object({
  id: num,
  mode: z.enum(["report", "delete"]).catch("report"),
  source: z.string().catch("scheduled"),
  status: z.enum(["running", "completed", "failed", "abandoned"]).catch("failed"),
  started_at: str,
  finished_at: str,
  error: str,
});

export const dashboardSchema = z.object({
  generated_at: str,
  settings: z
    .object({
      deletion_enabled: bool,
      deletion_authorized_at: str,
      backup_recorded: bool,
      required_report_runs: num,
      max_records_per_run: num,
      max_files_per_run: num,
      bucket_threshold_percent: num,
      bucket_threshold_min_files: num,
      min_file_age_hours: num,
      installed_at: str,
    })
    .catch({
      deletion_enabled: false,
      deletion_authorized_at: null,
      backup_recorded: false,
      required_report_runs: 7,
      max_records_per_run: 0,
      max_files_per_run: 0,
      bucket_threshold_percent: 0,
      bucket_threshold_min_files: 0,
      min_file_age_hours: 0,
      installed_at: null,
    }),
  report_days: num,
  last_run: runSchema.nullable().catch(null),
  latest: z
    .object({
      id: num,
      mode: z.enum(["report", "delete"]).catch("report"),
      status: z.string().catch("failed"),
      started_at: str,
      finished_at: str,
      records_deleted: num,
      files_deleted: num,
      records: z
        .object({
          candidates: num,
          backlog: num,
          newly_expired: num,
          rows: num,
          limit: num,
          outcomes: z.record(z.string(), num).catch({}),
          needs_review: bool,
          large_backlog: bool,
        })
        .partial()
        .nullable()
        .catch(null),
      files: z
        .object({
          buckets: z.record(z.string(), bucketSchema).catch({}),
          storage_unreadable: bool,
          needs_review: bool,
        })
        .partial()
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
  too_large: z
    .array(z.object({ table: z.string().catch("?"), record_id: str, sled_id: str, rows: num, expired_at: str }))
    .catch([]),
  review: z
    .array(
      z.object({
        source: z.string().catch("run"),
        kind: z.string().catch("file"),
        outcome: z.string().catch("unknown"),
        table_name: str,
        bucket_id: str,
        object_path: str,
        detail: str,
        at: str,
      }),
    )
    .catch([]),
  review_counts: z.record(z.string(), num).catch({}),
  claims: z.record(z.string(), num).catch({}),
  registry_problems: z.array(z.string()).catch([]),
  retention: z
    .object({
      enabled: bool,
      authorized_at: str,
      periods: z
        .object({
          run_days: num,
          report_candidate_days: num,
          delete_candidate_days: num,
          released_claim_days: num,
          keep_report_runs: num,
          batch_size: num,
        })
        .partial()
        .catch({}),
      qualifying: z.object({ runs: num, report_candidates: num, delete_candidates: num, released_claims: num }).partial().catch({}),
      last: z
        .object({
          run_id: num,
          at: str,
          summary: z
            .object({ enabled: bool, removed: z.object({ details: num, released_claims: num, runs: num }).partial().catch({}) })
            .partial()
            .nullable()
            .catch(null),
        })
        .nullable()
        .catch(null),
      last_error: str,
      failed_claims_unreviewed: num,
      failed_claims_reviewed: num,
      tombstones: num,
    })
    .nullable()
    .catch(null),
  warnings: z.array(z.string()).catch([]),
  history: z
    .array(
      runSchema.omit({ error: true }).extend({
        records_deleted: num,
        files_deleted: num,
        record_candidates: optNum,
        orphans: optNum,
        needs_review: bool,
        has_error: bool,
      }),
    )
    .catch([]),
});

export type CleanupDashboardData = z.infer<typeof dashboardSchema>;

export function parseDashboard(raw: unknown): CleanupDashboardData | null {
  const result = dashboardSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** "2026-11-20 13:34 UTC" (administrators may be anywhere; UTC is unambiguous). */
export function formatUtc(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "under 1 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** First 8 characters of an id: enough to look it up, without a wall of hex. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

export type Tone = "good" | "warn" | "bad" | "neutral";

export function runStatusTone(status: string): Tone {
  if (status === "completed") return "good";
  if (status === "running") return "neutral";
  return "bad";
}

export const OUTCOME_LABEL: Record<string, string> = {
  would_delete: "Would delete",
  would_defer: "Next run",
  deleted: "Deleted",
  deferred: "Next run",
  in_group: "With its group",
  too_large: "Too large (review)",
  not_eligible: "No longer eligible",
  failed: "Failed",
  eligible: "Removable",
  blocked: "Blocked",
  unrecognized: "Unrecognised path",
  metadata_missing: "Incomplete metadata",
  claimed: "Claimed",
  not_claimed: "Not claimed",
  replaced: "Replaced (review)",
  missing: "Already gone",
  released: "Released",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome.replaceAll("_", " ");
}

/** What the job will do on its next run, from both switches. */
export function effectiveMode(databaseSwitch: boolean, serverRequestsDelete: boolean): {
  label: string;
  tone: Tone;
  detail: string;
} {
  if (databaseSwitch && serverRequestsDelete) {
    return { label: "Deletion", tone: "bad", detail: "Both switches are on: the next run deletes eligible records and photos." };
  }
  if (databaseSwitch || serverRequestsDelete) {
    return {
      label: "Report-only",
      tone: "warn",
      detail: `Only one switch is on (${databaseSwitch ? "database" : "server setting"}); runs stay report-only.`,
    };
  }
  return { label: "Report-only", tone: "good", detail: "Both switches are off: runs only report." };
}

/** Orphans per bucket, sorted by bucket id. */
export function bucketRows(data: CleanupDashboardData) {
  const buckets = data.latest?.files?.buckets ?? {};
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, b]) => ({ id, ...b }));
}

export function totalOrphans(data: CleanupDashboardData): number {
  return bucketRows(data).reduce((sum, b) => sum + (b.orphans ?? 0), 0);
}

/** Operational-history rows that qualify for removal now. */
export function retentionQualifying(data: CleanupDashboardData): number {
  const q = data.retention?.qualifying ?? {};
  return (q.runs ?? 0) + (q.report_candidates ?? 0) + (q.delete_candidates ?? 0) + (q.released_claims ?? 0);
}
