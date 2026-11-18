import { Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { MaintenanceBoard } from "@/components/board/maintenance-board";
import { SledIssues } from "@/components/issues/issues";
import { QuickService } from "@/components/service/quick-service";
import { ServiceHistory } from "@/components/service/service-history";
import { BackLink } from "@/components/sleds/back-link";
import { FixLastReadingForm } from "@/components/sleds/reading-forms";
import { SledSkeleton } from "@/components/sleds/skeletons";
import { SledPhoto } from "@/components/sleds/sled-photo";
import { StatusBadge } from "@/components/sleds/status-badge";
import { UpdateMetersButton } from "@/components/sleds/update-meters";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import type { RangeReading } from "@/lib/service/meter-range";
import { getBoard } from "@/lib/board/queries";
import { issuesResolvedByEntry, listSledIssues } from "@/lib/issues/queries";
import { hasCriticalIssue } from "@/lib/issues/types";
import { listPackages, listServiceRecords, taskOptionsForSled } from "@/lib/service/queries";
import { formatDate, formatHours, formatMiles, sledDescription, sledName } from "@/lib/sleds/format";
import { canFixReading, ROLE_LABELS, serviceCapabilities, sledCapabilities } from "@/lib/sleds/permissions";
import { getSled, type SledDetail } from "@/lib/sleds/queries";

export const metadata: Metadata = { title: "Snowmobile" };

const NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  added: { tone: "success", text: "Snowmobile added." },
  saved: { tone: "success", text: "Changes saved." },
  serviceSaved: { tone: "success", text: "Service saved." },
  serviceUpdated: { tone: "success", text: "Service record updated." },
  photo: {
    tone: "error",
    text: "The snowmobile was added, but its photo couldn't be uploaded. Try again from Edit details.",
  },
};

export default function SledPage({ params, searchParams }: PageProps<"/garage/[sledId]">) {
  return (
    <div className="mx-auto max-w-5xl">
      <BackLink href="/garage">My Snowmobiles</BackLink>
      <Suspense fallback={<SledSkeleton />}>
        <SledDashboard params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SledDashboard({ params, searchParams }: Pick<PageProps<"/garage/[sledId]">, "params" | "searchParams">) {
  const { sledId } = await params;
  const query = await searchParams;
  const user = await requireUser(`/garage/${sledId}`);
  const sled = await getSled(sledId, user.id);
  if (!sled) notFound();

  const can = sledCapabilities(sled.role);
  const name = sledName(sled);
  const notice =
    query.photo === "failed"
      ? NOTICES.photo
      : query.saved === "1"
        ? NOTICES.saved
        : query.added === "1"
          ? NOTICES.added
          : query.service === "saved"
            ? NOTICES.serviceSaved
            : query.service === "updated"
              ? NOTICES.serviceUpdated
              : null;
  const last = sled.readings[0];
  const [services, taskOptions, board, packages, issues, resolvedIssues] = await Promise.all([
    listServiceRecords(sled.id),
    can.canLogService ? taskOptionsForSled(sled) : Promise.resolve([]),
    getBoard(sled.id),
    can.canLogService ? listPackages(user.id) : Promise.resolve([]),
    listSledIssues(sled.id),
    issuesResolvedByEntry(sled.id),
  ]);
  const lastService = last ? services.find((service) => service.readingId === last.id) : undefined;
  // Oldest first, so readings of the same day keep the order they were entered.
  const rangeReadings: RangeReading[] = [...sled.readings].reverse();
  const currentMeters = {
    odometer: sled.meters.odometer?.value ?? null,
    engineHours: sled.meters.engineHours?.value ?? null,
  };

  return (
    <>
      {notice ? (
        <div className="mt-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      ) : null}

      <section className="mt-4 grid gap-6 lg:grid-cols-2" aria-labelledby="sled-name">
        <SledPhoto url={sled.photoUrl} alt={name} className="aspect-[16/10] w-full rounded-2xl border border-white/10" />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={sled.status} criticalIssue={hasCriticalIssue(issues)} />
            {sled.role !== "owner" ? (
              <span className="inline-flex rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-muted">
                Shared with you · {ROLE_LABELS[sled.role]}
              </span>
            ) : null}
          </div>
          <h1
            id="sled-name"
            className="mt-3 font-display text-4xl font-extrabold uppercase italic leading-none tracking-tight sm:text-5xl"
          >
            {name}
          </h1>
          <p className="mt-2 text-lg text-muted">
            {sledDescription({ model_year: sled.modelYear, make: sled.make, model: sled.model })}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-4">
            <Meter label="Odometer" reading={sled.meters.odometer} format={formatMiles} testId="current-odometer" />
            <Meter label="Engine hours" reading={sled.meters.engineHours} format={formatHours} testId="current-hours" />
          </dl>

          <div className="mt-6 flex flex-wrap gap-3">
            {can.canLogService ? (
              <QuickService sledId={sled.id} taskOptions={taskOptions} readings={rangeReadings} current={currentMeters} />
            ) : null}
            {can.canAddReading ? (
              <UpdateMetersButton
                sledId={sled.id}
                sledName={name}
                current={{
                  odometer: sled.meters.odometer ? { value: sled.meters.odometer.value, readOn: sled.meters.odometer.readOn } : null,
                  engineHours: sled.meters.engineHours
                    ? { value: sled.meters.engineHours.value, readOn: sled.meters.engineHours.readOn }
                    : null,
                }}
              />
            ) : null}
            {can.canEdit ? (
              <ButtonLink href={`/garage/${sled.id}/edit`} variant="secondary" size="lg">
                <Pencil aria-hidden className="size-4" />
                Edit details
              </ButtonLink>
            ) : null}
          </div>
        </div>
      </section>

      <MaintenanceBoard
        sledId={sled.id}
        rows={board}
        canManage={can.canManageSledTasks}
        canComplete={can.canLogService}
        taskOptions={taskOptions}
        packages={packages}
        readings={rangeReadings}
        current={currentMeters}
      />

      <section className="mt-10 scroll-mt-24" id="issues" aria-labelledby="issues-heading">
        <SledIssues
          sledId={sled.id}
          sledName={name}
          issues={issues}
          role={sled.role}
          userId={user.id}
          currentOdometer={sled.meters.odometer?.value ?? null}
          variant="page"
        />
      </section>

      <section className="mt-10" aria-labelledby="readings-heading" data-testid="readings-section">
        <h2 id="readings-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Reading history
        </h2>

        {last && lastService ? (
          <p className="mt-4 rounded-2xl border border-white/10 bg-surface/40 px-5 py-4 text-sm text-muted" data-testid="last-reading-service">
            The latest reading belongs to the service “{lastService.title}”.{" "}
            {serviceCapabilities(sled.role, lastService.createdBy, user.id).canEdit ? (
              <Link
                href={`/garage/${sled.id}/service/${lastService.id}/edit`}
                className="font-semibold text-foreground underline-offset-4 hover:underline"
              >
                Edit that service
              </Link>
            ) : null}{" "}
            to correct it.
          </p>
        ) : last && canFixReading(sled.role, last.createdBy, user.id) ? (
          <div className="mt-4">
            <FixLastReadingForm sledId={sled.id} reading={last} canRemove={can.canRemoveReading} />
          </div>
        ) : null}

        <ReadingHistory sled={sled} />
      </section>

      <section id="service-history" className="mt-10 scroll-mt-24" aria-labelledby="service-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="service-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
            Service history
          </h2>
          {can.canLogService ? (
            <ButtonLink href={`/garage/${sled.id}/service/new`} variant="secondary">
              Full service record
            </ButtonLink>
          ) : null}
        </div>
        <ServiceHistory sledId={sled.id} records={services} role={sled.role} userId={user.id} resolvedIssues={resolvedIssues} />
      </section>

      <Details sled={sled} />
    </>
  );
}

function Meter({
  label,
  reading,
  format,
  testId,
}: {
  label: string;
  reading: SledDetail["meters"]["odometer"];
  format: (value: number | null | undefined) => string;
  testId: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-surface/70 p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">{label}</dt>
      <dd className="mt-1">
        <span data-testid={testId} className="block font-display text-3xl font-bold tabular-nums">
          {reading ? format(reading.value) : "Not recorded"}
        </span>
        {reading ? (
          <span className="mt-1 block text-xs text-muted">
            as of {formatDate(reading.readOn)}
            {reading.total != null && reading.total !== reading.value ? ` · ${format(reading.total)} lifetime` : ""}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function Details({ sled }: { sled: SledDetail }) {
  const rows: [string, string | null][] = [
    ["VIN / serial", sled.vin],
    ["Purchase date", sled.purchaseDate ? formatDate(sled.purchaseDate) : null],
    ["Engine", sled.engineDescription],
    ["Displacement", sled.displacementCc ? `${sled.displacementCc} cc` : null],
  ];
  const shown = rows.filter(([, value]) => value);
  if (!shown.length && !sled.notes) return null;
  return (
    <section className="mt-10" aria-labelledby="details-heading">
      <h2 id="details-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
        Details
      </h2>
      <dl className="mt-4 grid gap-x-6 gap-y-4 rounded-2xl border border-white/10 bg-surface/70 p-5 sm:grid-cols-2">
        {shown.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">{label}</dt>
            <dd className="mt-1 break-words">{value}</dd>
          </div>
        ))}
        {sled.notes ? (
          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">Notes</dt>
            <dd className="mt-1 whitespace-pre-line break-words">{sled.notes}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function ReadingHistory({ sled }: { sled: SledDetail }) {
  const recent = sled.readings.slice(0, 10);
  if (!recent.length) {
    return <p className="mt-6 text-muted">No readings yet.</p>;
  }
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">Recent readings</h3>
      <ul className="mt-3 divide-y divide-white/10 rounded-2xl border border-white/10 bg-surface/40" data-testid="reading-history">
        {recent.map((reading) => (
          <li key={reading.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3 text-sm">
            <span className="font-medium">{formatDate(reading.readOn)}</span>
            <span className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums text-foreground/90">
              {reading.odometer != null ? <span>{formatMiles(reading.odometer)}</span> : null}
              {reading.engineHours != null ? <span>{formatHours(reading.engineHours)}</span> : null}
              {reading.odometerReset || reading.hourMeterReset ? (
                <span className="text-amber-300">
                  {[reading.odometerReset && "Odometer replaced", reading.hourMeterReset && "Hour meter replaced"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
