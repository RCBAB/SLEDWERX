import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BackLink } from "@/components/sleds/back-link";
import { SuspensionSkeleton } from "@/components/suspension/skeleton";
import { SuspensionView } from "@/components/suspension/suspension-view";
import { requireUser } from "@/lib/auth/session";
import { sledDescription, sledName } from "@/lib/sleds/format";
import { suspensionCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";
import { suspensionPhotoUploadsEnabled } from "@/lib/suspension/photo-flag";
import { QuickTuneSchemaMissing, getSuspensionData } from "@/lib/suspension/queries";
import { VIEW_COOKIE, parseViewMode } from "@/lib/suspension/quick-tune";

export const metadata: Metadata = { title: "Suspension" };

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
  const name = sledName(sled);
  // ?view=quick|map wins (links); otherwise the view last chosen in this browser.
  const view = parseViewMode(query.view === "map" || query.view === "quick" ? query.view : (await cookies()).get(VIEW_COOKIE)?.value);
  let data;
  try {
    data = await getSuspensionData(sled.id, user.id, can.canManage);
  } catch (error) {
    if (!(error instanceof QuickTuneSchemaMissing)) throw error;
    return (
      <>
        <BackLink href={`/garage/${sled.id}`}>{name}</BackLink>
        <div className="mt-6 rounded-2xl border border-accent/40 bg-surface/70 p-5" data-testid="schema-missing">
          <h1 className="font-display text-3xl font-extrabold uppercase italic">Suspension</h1>
          <p className="mt-2 text-foreground/90">
            Suspension Quick Tune needs a database update (Migration 9) that hasn&apos;t been applied to this database yet. Nothing has been
            changed; your existing suspension data is safe.
          </p>
        </div>
      </>
    );
  }

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
        photoUploads={suspensionPhotoUploadsEnabled()}
        userId={user.id}
        initialView={view}
      />
    </>
  );
}
