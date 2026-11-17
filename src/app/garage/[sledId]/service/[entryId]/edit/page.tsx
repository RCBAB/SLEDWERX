import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { ServiceForm } from "@/components/service/service-form";
import { BackLink } from "@/components/sleds/back-link";
import { FormSkeleton } from "@/components/sleds/skeletons";
import { requireUser } from "@/lib/auth/session";
import { getServiceRecord, listPackages, taskOptionsForSled } from "@/lib/service/queries";
import { sledName } from "@/lib/sleds/format";
import { serviceCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";

export const metadata: Metadata = { title: "Edit service" };

export default function EditServicePage({ params }: PageProps<"/garage/[sledId]/service/[entryId]/edit">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<FormSkeleton />}>
        <EditService params={params} />
      </Suspense>
    </div>
  );
}

async function EditService({ params }: Pick<PageProps<"/garage/[sledId]/service/[entryId]/edit">, "params">) {
  const { sledId, entryId } = await params;
  const user = await requireUser(`/garage/${sledId}/service/${entryId}/edit`);
  const sled = await getSled(sledId, user.id);
  if (!sled) notFound();
  const record = await getServiceRecord(sled.id, entryId);
  if (!record) notFound();
  const can = serviceCapabilities(sled.role, record.createdBy, user.id);
  // Viewers, and mechanics on other people's records, can't edit (the database refuses too).
  if (!can.canEdit) redirect(`/garage/${sled.id}#service-history`);

  const [taskOptions, packages] = await Promise.all([taskOptionsForSled(sled), listPackages(user.id)]);

  return (
    <>
      <BackLink href={`/garage/${sled.id}#service-history`}>{sledName(sled)}</BackLink>
      <h1 className="mt-3 font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">Edit service</h1>
      <div className="mt-8 rounded-2xl border border-white/10 bg-surface/70 p-5 sm:p-8">
        <ServiceForm
          sledId={sled.id}
          record={record}
          taskOptions={taskOptions}
          packages={packages}
          readings={[...sled.readings].reverse()}
          current={{ odometer: sled.meters.odometer?.value ?? null, engineHours: sled.meters.engineHours?.value ?? null }}
          canRemoveMileage={can.canRemoveMileage}
        />
      </div>
    </>
  );
}
