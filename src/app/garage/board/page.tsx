import type { Metadata } from "next";
import { Suspense } from "react";

import { GarageBoard } from "@/components/garage/garage-board";
import { requireUser } from "@/lib/auth/session";
import { getGarageBoard } from "@/lib/garage/queries";

export const metadata: Metadata = { title: "Garage Board" };

export default function GarageBoardPage({ searchParams }: PageProps<"/garage/board">) {
  return (
    <div className="mx-auto max-w-7xl">
      <Suspense fallback={<GarageBoardSkeleton />}>
        <Board searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Board({ searchParams }: Pick<PageProps<"/garage/board">, "searchParams">) {
  const query = await searchParams;
  const wall = query.display === "wall";
  const user = await requireUser(wall ? "/garage/board?display=wall" : "/garage/board");
  const data = await getGarageBoard(user.id);
  return <GarageBoard data={data} initialWall={wall} />;
}

function GarageBoardSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      <div className="h-12 w-64 animate-pulse rounded bg-white/5" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-96 animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    </div>
  );
}
