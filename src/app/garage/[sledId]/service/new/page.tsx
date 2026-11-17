import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { ServiceForm } from "@/components/service/service-form";
import { BackLink } from "@/components/sleds/back-link";
import { FormSkeleton } from "@/components/sleds/skeletons";
import { requireUser } from "@/lib/auth/session";
import { listPackages, taskOptionsForSled } from "@/lib/service/queries";
import { sledName } from "@/lib/sleds/format";
import { sledCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";

export const metadata: Metadata = { title: "Log service" };

export default function NewServicePage({ params }: PageProps<"/garage/[sledId]/service/new">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<FormSkeleton />}>
        <NewService params={params} />
      </Suspense>
    </div>
  );
}

async function NewService({ params }: Pick<PageProps<"/garage/[sledId]/service/new">, "params">) {
  const { sledId } = await params;
  const user = await requireUser(`/garage/${sledId}/service/new`);
  const sled = await getSled(sledId, user.id);
  if (!sled) notFound();
  // Viewers can't log services (the database refuses too).
  if (!sledCapabilities(sled.role).canLogService) redirect(`/garage/${sled.id}`);

  const [taskOptions, packages] = await Promise.all([taskOptionsForSled(sled), listPackages(user.id)]);

  return (
    <>
      <BackLink href={`/garage/${sled.id}#service-history`}>{sledName(sled)}</BackLink>
      <h1 className="mt-3 font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">Log service</h1>
      <div className="mt-8 rounded-2xl border border-white/10 bg-surface/70 p-5 sm:p-8">
        <ServiceForm
          sledId={sled.id}
          taskOptions={taskOptions}
          packages={packages}
          readings={[...sled.readings].reverse()}
          current={{ odometer: sled.meters.odometer?.value ?? null, engineHours: sled.meters.engineHours?.value ?? null }}
          canRemoveMileage={sledCapabilities(sled.role).canEdit}
        />
      </div>
    </>
  );
}
