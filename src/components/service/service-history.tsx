import { CheckCircle2, ChevronDown, Gauge, Pencil } from "lucide-react";
import Link from "next/link";

import { OUTCOME_LABEL } from "@/lib/board/tracking";
import { CATEGORY_SHORT_LABELS } from "@/lib/service/constants";
import { formatUsd, partLineTotal } from "@/lib/service/costs";
import { groupBySeason } from "@/lib/service/history";
import type { ServiceRecord } from "@/lib/service/queries";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { serviceCapabilities } from "@/lib/sleds/permissions";

import { DeleteServiceButton } from "./delete-service";

export function ServiceHistory({
  sledId,
  records,
  role,
  userId,
  resolvedIssues,
}: {
  sledId: string;
  records: ServiceRecord[];
  role: SledRole;
  userId: string;
  /** Issues each record resolved (Phase 6.1): shown on the record, not copied into it. */
  resolvedIssues?: Map<string, { id: string; title: string }[]>;
}) {
  if (!records.length) {
    return <p className="mt-4 text-muted">No services logged yet.</p>;
  }
  const allTime = records.reduce((sum, r) => sum + r.costs.total, 0);

  return (
    <div className="mt-4 space-y-8">
      <p className="text-sm text-muted">
        {records.length} {records.length === 1 ? "service" : "services"} ·{" "}
        <span className="font-semibold text-foreground" data-testid="service-total-spent">
          {formatUsd(allTime)}
        </span>{" "}
        spent
      </p>
      {groupBySeason(records).map((group) => (
        <section key={group.season} aria-label={`${group.season} season`}>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">{group.season} season</h3>
            <span className="text-sm tabular-nums text-muted">{formatUsd(group.total)}</span>
          </div>
          <ul className="space-y-3" data-testid="service-list">
            {group.records.map((record) => (
              <li key={record.id}>
                <ServiceItem
                  sledId={sledId}
                  record={record}
                  can={serviceCapabilities(role, record.createdBy, userId)}
                  issues={resolvedIssues?.get(record.id) ?? []}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ServiceItem({
  sledId,
  record,
  can,
  issues,
}: {
  sledId: string;
  record: ServiceRecord;
  can: ReturnType<typeof serviceCapabilities>;
  issues: { id: string; title: string }[];
}) {
  return (
    <details className="group rounded-2xl border border-white/10 bg-surface/70 open:bg-surface" data-testid="service-record">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 marker:hidden sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">{formatDate(record.performedOn)}</p>
          <p className="mt-0.5 truncate font-semibold">{record.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {record.category ? (
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs font-semibold text-foreground/80">
                {CATEGORY_SHORT_LABELS[record.category]}
              </span>
            ) : null}
            {record.odometer != null ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Gauge aria-hidden className="size-3.5" />
                {formatMiles(record.odometer)}
              </span>
            ) : null}
          </p>
        </div>
        <span className="font-semibold tabular-nums" data-testid="service-record-total">
          {formatUsd(record.costs.total)}
        </span>
        <ChevronDown aria-hidden className="mt-1 size-5 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>

      <div className="space-y-5 border-t border-white/10 p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Detail label="Mileage" value={record.odometer != null ? formatMiles(record.odometer) : "Unknown"} />
          <Detail label="Engine hours" value={record.engineHours != null ? formatHours(record.engineHours) : "—"} />
          <Detail label="Done by" value={record.doneBy || "—"} />
          <Detail label="Category" value={record.category ? CATEGORY_SHORT_LABELS[record.category] : "—"} />
        </dl>

        {record.tasks.length ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">Work performed</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
              {record.tasks.map((task) => (
                <li key={task.id} data-testid="service-task">
                  {task.name}
                  {task.outcome ? (
                    <>
                      {" · Checked · "}
                      <span className={task.outcome === "needs_replacement" ? "font-semibold text-red-300" : "font-semibold text-emerald-300"}>
                        {OUTCOME_LABEL[task.outcome]}
                      </span>
                    </>
                  ) : null}
                  {task.note ? <span className="text-muted"> · {task.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {record.parts.length ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">Parts</h4>
            <table className="mt-2 w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Part</th>
                  <th>Quantity and unit cost</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {record.parts.map((part) => (
                  <tr key={part.id}>
                    <td className="py-1.5 pr-3">
                      {part.name}
                      {part.partNumber ? <span className="ml-2 text-xs text-muted">#{part.partNumber}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                      {part.quantity} × {formatUsd(part.unitCost)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatUsd(partLineTotal(part))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-2 rounded-xl bg-black/20 p-3 text-sm sm:grid-cols-4">
          <Detail label="Parts" value={formatUsd(record.costs.parts)} />
          <Detail label="Labor" value={formatUsd(record.costs.labor)} />
          <Detail label="Other" value={formatUsd(record.costs.other)} />
          <Detail label="Total" value={formatUsd(record.costs.total)} strong />
        </dl>

        {record.notes ? <p className="whitespace-pre-line text-sm text-foreground/90">{record.notes}</p> : null}
        {issues.length ? (
          <ul className="space-y-1 text-sm" data-testid="service-resolved-issues">
            {issues.map((issue) => (
              <li key={issue.id} className="flex items-center gap-2 text-emerald-200">
                <CheckCircle2 aria-hidden className="size-4 shrink-0" />
                Resolved issue: {issue.title}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {record.editedAt ? `Edited ${formatDate(record.editedAt.slice(0, 10))}` : null}
          </p>
          <div className="flex items-center gap-1">
            {can.canEdit ? (
              <Link
                href={`/garage/${sledId}/service/${record.id}/edit`}
                className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-white/5"
              >
                <Pencil aria-hidden className="size-4" />
                Edit
              </Link>
            ) : null}
            {can.canDelete ? (
              <DeleteServiceButton sledId={sledId} entryId={record.id} version={record.version} title={record.title} />
            ) : null}
          </div>
        </div>
      </div>
    </details>
  );
}

function Detail({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</dd>
    </div>
  );
}
