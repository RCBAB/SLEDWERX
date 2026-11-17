import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { BackLink } from "@/components/sleds/back-link";
import { FormSkeleton } from "@/components/sleds/skeletons";
import { SledForm } from "@/components/sleds/sled-form";
import { requireUser } from "@/lib/auth/session";
import { sledName } from "@/lib/sleds/format";
import { sledCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";

export const metadata: Metadata = { title: "Edit snowmobile" };

export default function EditSledPage({ params }: PageProps<"/garage/[sledId]/edit">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<FormSkeleton />}>
        <EditSled params={params} />
      </Suspense>
    </div>
  );
}

async function EditSled({ params }: Pick<PageProps<"/garage/[sledId]/edit">, "params">) {
  const { sledId } = await params;
  const user = await requireUser(`/garage/${sledId}/edit`);
  const sled = await getSled(sledId, user.id);
  if (!sled) notFound();
  // Viewers and mechanics can't edit details (the database refuses too).
  if (!sledCapabilities(sled.role).canEdit) redirect(`/garage/${sled.id}`);

  return (
    <>
      <BackLink href={`/garage/${sled.id}`}>{sledName(sled)}</BackLink>
      <h1 className="mt-3 font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
        Edit details
      </h1>
      <div className="mt-8 rounded-2xl border border-white/10 bg-surface/70 p-5 sm:p-8">
        <SledForm mode="edit" sled={sled} />
      </div>
    </>
  );
}
