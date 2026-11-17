import { Bike, Plus } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "My Snowmobiles" };

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  needs_attention: "Needs attention",
  out_of_service: "Out of service",
  stored: "Stored",
};

export default function GaragePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
        My Snowmobiles
      </h1>
      <Suspense fallback={<GarageSkeleton />}>
        <SledList />
      </Suspense>
    </div>
  );
}

async function SledList() {
  const user = await requireUser("/garage");
  const supabase = await createClient();

  const [{ data: profile }, { data: sleds, error }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    supabase
      .from("sleds")
      .select("id, owner_id, model_year, make, model, nickname, status")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (error) {
    throw new Error("Could not load your snowmobiles.");
  }

  const greeting = profile?.display_name ? `Welcome, ${profile.display_name}.` : "Welcome to your garage.";
  const owned = (sleds ?? []).filter((sled) => sled.owner_id === user.id);
  const shared = (sleds ?? []).filter((sled) => sled.owner_id !== user.id);

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
            Your garage is ready. Adding snowmobiles is the next feature on its way.
          </p>
          <button
            type="button"
            disabled
            className="mt-6 inline-flex h-12 cursor-not-allowed items-center gap-2 rounded-lg border border-white/15 px-5 font-semibold text-muted"
          >
            <Plus aria-hidden className="size-4" />
            Add snowmobile (coming soon)
          </button>
        </section>
      ) : (
        <SledGrid title="Your snowmobiles" sleds={owned} />
      )}

      {shared.length > 0 ? <SledGrid title="Shared with you" sleds={shared} /> : null}
    </>
  );
}

type SledSummary = {
  id: string;
  model_year: number;
  make: string;
  model: string;
  nickname: string | null;
  status: string;
};

function SledGrid({ title, sleds }: { title: string; sleds: SledSummary[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">{title}</h2>
      <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sleds.map((sled) => (
          <li key={sled.id} className="rounded-2xl border border-white/10 bg-surface/70 p-5">
            <p className="font-display text-2xl font-bold uppercase italic leading-tight">
              {sled.nickname || `${sled.make} ${sled.model}`}
            </p>
            <p className="mt-1 text-sm text-muted">
              {sled.model_year} {sled.make} {sled.model}
            </p>
            <p className="mt-4 inline-flex rounded-full bg-white/5 px-3 py-1 text-xs font-semibold">
              {STATUS_LABELS[sled.status] ?? sled.status}
            </p>
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
      <div className="h-56 animate-pulse rounded-2xl bg-white/5" />
    </div>
  );
}
