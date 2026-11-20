import { CircleAlert, CircleCheck, Clock, Database, FileWarning, History, Images, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/components/ui/cn";
import {
  bucketRows,
  effectiveMode,
  formatDuration,
  formatUtc,
  outcomeLabel,
  runStatusTone,
  shortId,
  totalOrphans,
  type CleanupDashboardData,
  type Tone,
} from "@/lib/admin/dashboard";

export type ServerStatus = {
  /** CLEANUP_MODE asks for deletion (on this deployment). */
  requestsDelete: boolean;
  /** CRON_SECRET and the secret key are set (values never shown). */
  jobConfigured: boolean;
};

const TONE_BADGE: Record<Tone, string> = {
  good: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  warn: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  bad: "border-red-400/50 bg-red-400/10 text-red-200",
  neutral: "border-white/15 bg-white/5 text-foreground",
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", TONE_BADGE[tone])}>
      {children}
    </span>
  );
}

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 rounded-2xl border border-white/10 bg-surface/70 p-4 sm:p-6" data-testid={id}>
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-display text-xl font-bold uppercase italic tracking-tight">
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-background/40 p-4" data-testid={testId}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-bold">{value}</dd>
      {sub ? <dd className="mt-1 text-sm text-muted">{sub}</dd> : null}
    </div>
  );
}

/** A table that scrolls on its own on narrow screens (keyboard-scrollable). */
function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="-mx-1 overflow-x-auto px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </div>
  );
}

const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted";
const td = "px-3 py-2 align-top";

export function CleanupDashboard({ data, server }: { data: CleanupDashboardData; server: ServerStatus }) {
  const { settings } = data;
  const mode = effectiveMode(settings.deletion_enabled, server.requestsDelete);
  const required = settings.required_report_runs || 7;
  const reportDays = Math.min(data.report_days, required);
  const hasRuns = data.history.length > 0 || data.last_run !== null;
  const latest = data.latest;
  const records = latest?.records ?? null;
  const buckets = bucketRows(data);
  // The review list already includes failed and replaced file removals.
  const attention = Object.entries(data.review_counts)
    .filter(([outcome]) => outcome !== "too_large")
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6" data-testid="cleanup-dashboard">
      {/* Status */}
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Mode"
          testId="dashboard-mode"
          value={<Badge tone={mode.tone}>{mode.label}</Badge>}
          sub={
            <>
              {mode.detail}
              <span className="mt-2 block">
                Database switch: <strong className="text-foreground">{settings.deletion_enabled ? "on" : "off"}</strong> · Server setting:{" "}
                <strong className="text-foreground">{server.requestsDelete ? "delete" : "report"}</strong>
              </span>
            </>
          }
        />
        <Stat
          label="Daily report runs"
          testId="dashboard-report-runs"
          value={
            <>
              {data.report_days} <span className="text-base font-semibold text-muted">of {required} required</span>
            </>
          }
          sub={
            <span
              role="progressbar"
              aria-label="Successful daily report runs"
              aria-valuemin={0}
              aria-valuemax={required}
              aria-valuenow={reportDays}
              className="mt-1 block h-2 overflow-hidden rounded-full bg-white/10"
            >
              <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${(reportDays / required) * 100}%` }} />
            </span>
          }
        />
        <Stat
          label="Backup attestation"
          testId="dashboard-backup"
          value={<Badge tone={settings.backup_recorded ? "good" : "neutral"}>{settings.backup_recorded ? "Recorded" : "Not recorded"}</Badge>}
          sub={
            settings.deletion_authorized_at
              ? `Deletion authorized ${formatUtc(settings.deletion_authorized_at)}.`
              : "Required before deletion can be authorized. The reference itself is not shown here."
          }
        />
        <Stat
          label="Last run"
          testId="dashboard-last-run"
          value={
            data.last_run ? (
              <Badge tone={runStatusTone(data.last_run.status)}>
                {data.last_run.status} · {data.last_run.mode === "delete" ? "deletion" : "report"}
              </Badge>
            ) : (
              <span className="text-base font-semibold text-muted">None yet</span>
            )
          }
          sub={
            data.last_run ? (
              <>
                Run #{data.last_run.id}, {formatUtc(data.last_run.started_at)} ({formatDuration(data.last_run.started_at, data.last_run.finished_at)})
                {data.last_run.error ? <span className="mt-1 block break-words text-red-200">{data.last_run.error}</span> : null}
              </>
            ) : server.jobConfigured ? (
              "The daily job is configured but has not run yet."
            ) : (
              "The daily job is not configured on this deployment."
            )
          }
        />
      </dl>

      {/* Warnings */}
      {data.warnings.length > 0 || data.registry_problems.length > 0 ? (
        <section aria-labelledby="dashboard-warnings-title" className="rounded-2xl border border-red-400/40 bg-red-400/10 p-4 sm:p-6" data-testid="dashboard-warnings">
          <h2 id="dashboard-warnings-title" className="flex items-center gap-2 font-semibold">
            <ShieldAlert aria-hidden className="size-5 text-red-300" />
            Security and safety warnings
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
            {data.registry_problems.map((problem) => (
              <li key={problem}>Registry: {problem}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-200" data-testid="dashboard-no-warnings">
          <ShieldCheck aria-hidden className="size-4" />
          No security or safety warnings.
        </p>
      )}

      {!hasRuns ? (
        <section className="rounded-2xl border border-dashed border-white/15 bg-surface/40 px-5 py-10 text-center" data-testid="dashboard-empty">
          <Clock aria-hidden className="mx-auto size-8 text-muted" />
          <h2 className="mt-3 font-semibold">No cleanup runs yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted">
            Once the daily job runs, this page shows what it found: expired records, orphaned photos, anything that needs review, and
            the history of runs. Seven successful daily report runs are needed before deletion can be considered.
          </p>
        </section>
      ) : null}

      {latest ? (
        <div className="grid gap-6">
          <Section id="dashboard-records" title="Expired records" icon={<Database aria-hidden className="size-5 text-accent-hot" />}>
            <p className="text-sm text-muted">
              Latest report: run #{latest.id}, {formatUtc(latest.started_at)}
              {latest.mode === "delete" ? ` · ${latest.records_deleted} rows deleted` : " · report-only"}.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Eligible" value={records?.candidates ?? 0} testId="records-candidates" />
              <Stat label="Backlog" value={records?.backlog ?? 0} sub="Overdue when cleanup was installed" testId="records-backlog" />
              <Stat label="Newly expired" value={records?.newly_expired ?? 0} testId="records-new" />
              <Stat label={latest.mode === "delete" ? "Rows deleted" : "Rows this run"} value={records?.rows ?? 0} sub={`Limit ${settings.max_records_per_run}`} />
            </dl>
            {records?.outcomes && Object.keys(records.outcomes).length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Record outcomes">
                {Object.entries(records.outcomes)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([outcome, n]) => (
                    <li key={outcome}>
                      <Badge tone={outcome === "too_large" || outcome === "failed" ? "warn" : "neutral"}>
                        {outcomeLabel(outcome)}: {n}
                      </Badge>
                    </li>
                  ))}
              </ul>
            ) : null}
            {records?.large_backlog ? (
              <p className="mt-3 text-sm text-amber-100">Large backlog: more than 1,000 eligible records.</p>
            ) : null}
          </Section>

          <Section id="dashboard-files" title="Orphaned photos" icon={<Images aria-hidden className="size-5 text-accent-hot" />}>
            <p className="text-sm text-muted">
              {totalOrphans(data)} orphaned file(s) in the latest report. The 10% limit applies only to buckets of {settings.bucket_threshold_min_files}+
              files.
            </p>
            {buckets.length > 0 ? (
              <TableWrap label="Photos by bucket">
                <table className="mt-3 w-full min-w-[34rem] text-sm">
                  <caption className="sr-only">Photo files by bucket in the latest report</caption>
                  <thead>
                    <tr className="border-b border-white/10">
                      <th scope="col" className={th}>Bucket</th>
                      <th scope="col" className={th}>Files</th>
                      <th scope="col" className={th}>Orphans</th>
                      <th scope="col" className={th}>Too new</th>
                      <th scope="col" className={th}>Problems</th>
                      <th scope="col" className={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buckets.map((b) => (
                      <tr key={b.id} className="border-b border-white/5" data-testid="bucket-row">
                        <th scope="row" className={cn(td, "text-left font-semibold")}>{b.id}</th>
                        <td className={td}>{b.objects ?? 0}</td>
                        <td className={td}>{b.orphans ?? 0}</td>
                        <td className={td}>{b.too_new ?? 0}</td>
                        <td className={td}>{(b.unrecognized ?? 0) + (b.metadata_missing ?? 0)}</td>
                        <td className={td}>
                          {b.blocked ? (
                            <>
                              <Badge tone="warn">Blocked</Badge>
                              {b.blocked_reason ? <span className="mt-1 block text-xs text-muted">{b.blocked_reason}</span> : null}
                            </>
                          ) : (
                            <Badge tone="good">OK</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            ) : null}
            {latest.files?.storage_unreadable ? (
              <p className="mt-3 text-sm text-red-200">Storage looked empty while records point at files; nothing was removed.</p>
            ) : null}
          </Section>
        </div>
      ) : null}

      {hasRuns ? (
        <Section id="dashboard-oversized" title="Oversized groups awaiting review" icon={<FileWarning aria-hidden className="size-5 text-accent-hot" />}>
          {data.too_large.length === 0 ? (
            <p className="text-sm text-muted">None. Every deletion group fits within the {settings.max_records_per_run}-row limit.</p>
          ) : (
            <>
              <p className="text-sm text-muted">
                Skipped whole (never partly deleted). Purging one needs a separately approved, one-time higher limit.
              </p>
              <TableWrap label="Oversized groups">
                <table className="mt-3 w-full min-w-[30rem] text-sm">
                  <caption className="sr-only">Deletion groups larger than the per-run limit</caption>
                  <thead>
                    <tr className="border-b border-white/10">
                      <th scope="col" className={th}>Table</th>
                      <th scope="col" className={th}>Record</th>
                      <th scope="col" className={th}>Snowmobile</th>
                      <th scope="col" className={th}>Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.too_large.map((g) => (
                      <tr key={`${g.table}-${g.record_id}`} className="border-b border-white/5" data-testid="oversized-row">
                        <th scope="row" className={cn(td, "text-left font-semibold")}>{g.table}</th>
                        <td className={cn(td, "font-mono")} title={g.record_id ?? undefined}>{shortId(g.record_id)}</td>
                        <td className={cn(td, "font-mono")} title={g.sled_id ?? undefined}>{shortId(g.sled_id)}</td>
                        <td className={td}>{g.rows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          )}
        </Section>
      ) : null}

      {hasRuns ? (
        <Section id="dashboard-attention" title="Needs attention" icon={<CircleAlert aria-hidden className="size-5 text-accent-hot" />}>
          {attention.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <CircleCheck aria-hidden className="size-4 text-emerald-300" />
              No blocked, unrecognised or failed files.
            </p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2" aria-label="Items needing attention">
                {attention.map(([key, n]) => (
                  <li key={key}>
                    <Badge tone={key.includes("replaced") || key.includes("failed") ? "bad" : "warn"}>
                      {outcomeLabel(key)}: {n}
                    </Badge>
                  </li>
                ))}
              </ul>
              {data.review.length > 0 ? (
                <TableWrap label="Items needing attention">
                  <table className="mt-3 w-full min-w-[40rem] text-sm">
                    <caption className="sr-only">Files and operations needing attention</caption>
                    <thead>
                      <tr className="border-b border-white/10">
                        <th scope="col" className={th}>Issue</th>
                        <th scope="col" className={th}>Where</th>
                        <th scope="col" className={th}>Detail</th>
                        <th scope="col" className={th}>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.review.map((item, index) => (
                        <tr key={index} className="border-b border-white/5" data-testid="attention-row">
                          <th scope="row" className={cn(td, "text-left font-semibold")}>{outcomeLabel(item.outcome)}</th>
                          <td className={cn(td, "break-all font-mono text-xs")}>
                            {item.bucket_id ? `${item.bucket_id}/${item.object_path ?? ""}` : item.table_name}
                          </td>
                          <td className={cn(td, "text-muted")}>{item.detail ?? "—"}</td>
                          <td className={cn(td, "whitespace-nowrap text-muted")}>{formatUtc(item.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : null}
            </>
          )}
        </Section>
      ) : null}

      {hasRuns ? (
        <Section id="dashboard-history" title="Recent runs" icon={<History aria-hidden className="size-5 text-accent-hot" />}>
          <TableWrap label="Recent cleanup runs">
            <table className="w-full min-w-[42rem] text-sm">
              <caption className="sr-only">The last {data.history.length} cleanup runs</caption>
              <thead>
                <tr className="border-b border-white/10">
                  <th scope="col" className={th}>Run</th>
                  <th scope="col" className={th}>Started</th>
                  <th scope="col" className={th}>Mode</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}>Records</th>
                  <th scope="col" className={th}>Orphans</th>
                  <th scope="col" className={th}>Deleted</th>
                  <th scope="col" className={th}>Review</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((run) => (
                  <tr key={run.id} className="border-b border-white/5" data-testid="history-row">
                    <th scope="row" className={cn(td, "text-left font-semibold")}>#{run.id}</th>
                    <td className={cn(td, "whitespace-nowrap")}>{formatUtc(run.started_at)}</td>
                    <td className={td}>
                      {run.mode === "delete" ? "Deletion" : "Report"}
                      {run.source === "manual" ? <span className="block text-xs text-muted">manual</span> : null}
                    </td>
                    <td className={td}>
                      <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
                    </td>
                    <td className={td}>{run.record_candidates ?? "—"}</td>
                    <td className={td}>{run.orphans ?? "—"}</td>
                    <td className={cn(td, "whitespace-nowrap")}>
                      {run.records_deleted} rows · {run.files_deleted} files
                    </td>
                    <td className={td}>{run.needs_review || run.has_error ? <Badge tone="warn">Yes</Badge> : <span className="text-muted">No</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      ) : null}

      <section aria-labelledby="dashboard-limits-title" className="text-sm text-muted" data-testid="dashboard-limits">
        <h2 id="dashboard-limits-title" className="font-semibold text-foreground">
          Safety limits (read-only)
        </h2>
        <p className="mt-1">
          At most {settings.max_records_per_run} rows and {settings.max_files_per_run} photos per run · files must be at least{" "}
          {settings.min_file_age_hours} hours old · at most {settings.bucket_threshold_percent}% of a bucket of {settings.bucket_threshold_min_files}+ files ·{" "}
          {required} daily report runs before deletion. Limits, switches and backups are changed only in the database (see docs/cleanup.md).
        </p>
      </section>
    </div>
  );
}
