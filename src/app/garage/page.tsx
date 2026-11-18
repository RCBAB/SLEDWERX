import { Bike, Plus } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { SledCard } from "@/components/sleds/sled-card";
import { ButtonLink } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { sledsWithCriticalIssues } from "@/lib/issues/queries";
import { listSleds, type SledListItem } from "@/lib/sleds/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "My Snowmobiles" };

export default function GaragePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
          My Snowmobiles
        </h1>
        <ButtonLink href="/garage/new" className="hidden sm:inline-flex">
          <Plus aria-hidden className="size-4" />
          Add snowmobile
        </ButtonLink>
      </div>
      <Suspense fallback={<GarageSkeleton />}>
        <SledList />
      </Suspense>
    </div>
  );
}

async function SledList() {
  const user = await requireUser("/garage");
  const supabase = await createClient();

  const [{ data: profile }, sleds] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    listSleds(),
  ]);

  // Sleds with an open Critical issue show "Not ready" instead of "Ready".
  const critical = await sledsWithCriticalIssues(sleds.map((sled) => sled.id));
  const greeting = profile?.display_name ? `Welcome, ${profile.display_name}.` : "Welcome to your garage.";
  const owned = sleds.filter((sled) => sled.ownerId === user.id);
  const shared = sleds.filter((sled) => sled.ownerId !== user.id);

  return (
    <>
      <p className="mt-2 text-muted">{greeting}</p>

      {owned.length === 0 ? (
        <section
          aria-labelledby="empty-garage"
          className="mt-8 flex flex-col items-center rounded-2xl border border-dashed border-white/15 bg-surface/40 px-6 py-14 text-center"
        >
          <span className="grid size-16 place-items-center rounded-2xl bg-accent/15">
            <Bike aria-hidden className="size-8 text-accent" />
          </span>
          <h2 id="empty-garage" className="mt-5 font-display text-2xl font-bold uppercase tracking-wide">
            No snowmobiles yet
          </h2>
          <p className="mt-2 max-w-sm text-muted">
            Add your first sled to start tracking its mileage and engine hours.
          </p>
          <ButtonLink href="/garage/new" size="lg" className="mt-6">
            <Plus aria-hidden className="size-4" />
            Add snowmobile
          </ButtonLink>
        </section>
      ) : (
        <>
          <SledGrid title="Your snowmobiles" sleds={owned} critical={critical} />
          <ButtonLink href="/garage/new" size="lg" className="mt-6 w-full sm:hidden">
            <Plus aria-hidden className="size-4" />
            Add snowmobile
          </ButtonLink>
        </>
      )}

      {shared.length > 0 ? <SledGrid title="Shared with you" sleds={shared} critical={critical} /> : null}
    </>
  );
}

function SledGrid({ title, sleds, critical }: { title: string; sleds: SledListItem[]; critical: Set<string> }) {
  const id = `grid-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className="mt-8" aria-labelledby={id}>
      <h2 id={id} className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">
        {title}
      </h2>
      <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sleds.map((sled) => (
          <li key={sled.id}>
            <SledCard sled={sled} criticalIssue={critical.has(sled.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function GarageSkeleton() {
  return (
    <div aria-hidden className="mt-8 space-y-4">
      <div className="h-5 w-48 animate-pulse rounded bg-white/5" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-72 animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    </div>
  );
}
