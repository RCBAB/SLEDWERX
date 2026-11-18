import Link from "next/link";

import { formatHours, formatMiles, sledDescription, sledName } from "@/lib/sleds/format";
import type { SledListItem } from "@/lib/sleds/queries";

import { SledPhoto } from "./sled-photo";
import { StatusBadge } from "./status-badge";

export function SledCard({ sled, criticalIssue = false }: { sled: SledListItem; criticalIssue?: boolean }) {
  const name = sledName(sled);
  return (
    <Link
      href={`/garage/${sled.id}`}
      data-testid="sled-card"
      className="group block overflow-hidden rounded-2xl border border-white/10 bg-surface/70 transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <SledPhoto url={sled.photoUrl} alt={name} className="aspect-[16/10] w-full" />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="font-display text-2xl font-bold uppercase italic leading-tight group-hover:text-accent-hot">
            {name}
          </p>
          <StatusBadge status={sled.status} criticalIssue={criticalIssue} className="shrink-0" />
        </div>
        <p className="mt-1 text-sm text-muted">
          {sledDescription({ model_year: sled.modelYear, make: sled.make, model: sled.model })}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-[0.15em] text-muted">Odometer</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{formatMiles(sled.meters.odometer?.value)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.15em] text-muted">Engine</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{formatHours(sled.meters.engineHours?.value)}</dd>
          </div>
        </dl>
      </div>
    </Link>
  );
}
