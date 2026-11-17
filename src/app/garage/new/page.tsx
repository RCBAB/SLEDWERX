import type { Metadata } from "next";
import { Suspense } from "react";

import { BackLink } from "@/components/sleds/back-link";
import { FormSkeleton } from "@/components/sleds/skeletons";
import { SledForm } from "@/components/sleds/sled-form";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Add snowmobile" };

export default function NewSledPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href="/garage">My Snowmobiles</BackLink>
      <h1 className="mt-3 font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
        Add snowmobile
      </h1>
      <p className="mt-2 text-muted">Start with the basics. You can add more details any time.</p>
      <div className="mt-8 rounded-2xl border border-white/10 bg-surface/70 p-5 sm:p-8">
        <Suspense fallback={<FormSkeleton />}>
          <SignedInForm />
        </Suspense>
      </div>
    </div>
  );
}

async function SignedInForm() {
  await requireUser("/garage/new");
  return <SledForm mode="create" />;
}
