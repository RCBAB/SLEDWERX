import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BackLink } from "@/components/sleds/back-link";
import { SuspensionSkeleton } from "@/components/suspension/skeleton";
import { SuspensionView } from "@/components/suspension/suspension-view";
import { requireUser } from "@/lib/auth/session";
import { sledDescription, sledName } from "@/lib/sleds/format";
import { suspensionCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";
import { getSuspensionData } from "@/lib/suspension/queries";

export const metadata: Metadata = { title: "Suspension tuning" };

export default function SuspensionPage({ params, searchParams }: PageProps<"/garage/[sledId]/suspension">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<SuspensionSkeleton />}>
        <Suspension params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Suspension({ params, searchParams }: Pick<PageProps<"/garage/[sledId]/suspension">, "params" | "searchParams">) {
  const { sledId } = await params;
  const query = await searchParams;
  const user = await requireUser(`/garage/${sledId}/suspension`);
  const sled = await getSled(sledId, user.id);
  if (!sled) notFound();

  const can = suspensionCapabilities(sled.role);
  const data = await getSuspensionData(sled.id, user.id, can.canManage);
  const name = sledName(sled);
  const requested = typeof query.setup === "string" ? query.setup : undefined;

  return (
    <>
      <BackLink href={`/garage/${sled.id}`}>{name}</BackLink>
      <SuspensionView
        data={data}
        sled={{
          id: sled.id,
          name,
          description: sledDescription({ model_year: sled.modelYear, make: sled.make, model: sled.model }),
          odometer: sled.meters.odometer?.value ?? null,
          engineHours: sled.meters.engineHours?.value ?? null,
        }}
        role={sled.role}
        userId={user.id}
        initialSetupId={requested}
      />
    </>
  );
}
