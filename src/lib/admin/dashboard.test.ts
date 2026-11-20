import { describe, expect, it } from "vitest";

import { bucketRows, effectiveMode, formatDuration, formatUtc, outcomeLabel, parseDashboard, runStatusTone, shortId, totalOrphans } from "./dashboard";

const empty = {
  generated_at: "2026-11-20T10:00:00Z",
  settings: {
    deletion_enabled: false,
    deletion_authorized_at: null,
    backup_recorded: false,
    required_report_runs: 7,
    max_records_per_run: 200,
    max_files_per_run: 100,
    bucket_threshold_percent: 10,
    bucket_threshold_min_files: 100,
    min_file_age_hours: 24,
    installed_at: "2026-11-19T10:00:00Z",
  },
  report_days: 0,
  last_run: null,
  latest: null,
  too_large: [],
  review: [],
  review_counts: {},
  claims: {},
  registry_problems: [],
  warnings: [],
  history: [],
};

describe("parseDashboard", () => {
  it("reads an empty installation", () => {
    const data = parseDashboard(empty);
    expect(data).not.toBeNull();
    expect(data!.history).toEqual([]);
    expect(data!.latest).toBeNull();
    expect(totalOrphans(data!)).toBe(0);
  });

  it("reads buckets, history and review items", () => {
    const data = parseDashboard({
      ...empty,
      report_days: 3,
      latest: {
        id: 9,
        mode: "report",
        status: "completed",
        started_at: "2026-11-20T09:00:00Z",
        finished_at: "2026-11-20T09:00:04Z",
        records_deleted: 0,
        files_deleted: 0,
        records: { candidates: 12, backlog: 9, newly_expired: 3, rows: 40, outcomes: { would_delete: 10 } },
        files: {
          buckets: {
            "suspension-photos": { objects: 20, orphans: 2, blocked: false },
            "issue-photos": { objects: 150, orphans: 20, blocked: true, blocked_reason: "More than 10%" },
          },
        },
      },
      history: [{ id: 9, mode: "report", source: "scheduled", status: "completed", started_at: null, finished_at: null, records_deleted: 0, files_deleted: 0, record_candidates: 12, orphans: 22, needs_review: true, has_error: false }],
    });
    expect(data!.report_days).toBe(3);
    expect(bucketRows(data!).map((b) => b.id)).toEqual(["issue-photos", "suspension-photos"]);
    expect(totalOrphans(data!)).toBe(22);
    expect(data!.history[0].needs_review).toBe(true);
  });

  it("never crashes on unexpected values; they become safe defaults", () => {
    const data = parseDashboard({ ...empty, settings: "nonsense", history: [{ id: "x", status: "weird" }], warnings: "oops" });
    expect(data).not.toBeNull();
    expect(data!.settings.deletion_enabled).toBe(false);
    expect(data!.warnings).toEqual([]);
    expect(data!.history[0].status).toBe("failed");
  });

  it("returns null for something that is not dashboard data at all", () => {
    expect(parseDashboard(null)).toBeNull();
    expect(parseDashboard("text")).toBeNull();
  });
});

describe("display helpers", () => {
  it("shows the effective mode from both switches", () => {
    expect(effectiveMode(false, false)).toMatchObject({ label: "Report-only", tone: "good" });
    expect(effectiveMode(true, false)).toMatchObject({ label: "Report-only", tone: "warn" });
    expect(effectiveMode(false, true)).toMatchObject({ label: "Report-only", tone: "warn" });
    expect(effectiveMode(true, true)).toMatchObject({ label: "Deletion", tone: "bad" });
  });
  it("formats times in UTC and durations", () => {
    expect(formatUtc("2026-11-20T13:34:56.789Z")).toBe("2026-11-20 13:34 UTC");
    expect(formatUtc(null)).toBe("—");
    expect(formatUtc("not a date")).toBe("—");
    expect(formatDuration("2026-11-20T13:34:00Z", "2026-11-20T13:34:04Z")).toBe("4 s");
    expect(formatDuration("2026-11-20T13:34:00Z", null)).toBe("—");
  });
  it("labels outcomes and statuses", () => {
    expect(outcomeLabel("too_large")).toBe("Too large (review)");
    expect(outcomeLabel("something_new")).toBe("something new");
    expect(runStatusTone("completed")).toBe("good");
    expect(runStatusTone("abandoned")).toBe("bad");
    expect(shortId("0123456789abcdef")).toBe("01234567");
    expect(shortId(null)).toBe("—");
  });
});
