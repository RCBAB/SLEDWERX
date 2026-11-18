"use client";

import { Camera, Plus, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { formatValue } from "@/lib/suspension/diff";
import {
  ZONE_GROUPS,
  ZONE_LABEL,
  settingsInZone,
  type Snapshot,
  type SuspensionSetting,
  type SuspensionZone,
} from "@/lib/suspension/types";

import { ZONE_NUMBER } from "./sled-diagram";

/** The plain-text zone selector (the alternative to the map), grouped Front / Rear. */
export function ZoneList({
  selected,
  onSelect,
  settings,
  values,
}: {
  selected: SuspensionZone | null;
  onSelect: (zone: SuspensionZone) => void;
  settings: SuspensionSetting[];
  values: Snapshot;
}) {
  return (
    <nav aria-label="Suspension zones" className="space-y-3" data-testid="zone-list">
      <p className="text-sm font-semibold">All zones</p>
      {ZONE_GROUPS.map((group) => (
        <div key={group.id}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">{group.label}</p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {group.zones.map((zone) => {
              const list = settings.filter((s) => s.zone === zone);
              const set = list.filter((s) => values[s.id]).length;
              const active = selected === zone;
              return (
                <li key={zone}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect(zone)}
                    data-testid="zone-option"
                    data-zone={zone}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      active ? "border-accent bg-accent/10" : "border-white/10 hover:border-white/25",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-full font-display text-sm font-bold",
                        active ? "bg-accent text-white" : "bg-white/10 text-foreground",
                      )}
                    >
                      {ZONE_NUMBER[zone]}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold">{ZONE_LABEL[zone]}</span>
                      <span className="block text-xs text-muted">
                        {list.length ? `${list.length} setting${list.length === 1 ? "" : "s"} · ${set} with a value` : "No settings"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The selected zone's settings and their current values in the selected setup. */
export function ZonePanel({
  zone,
  settings,
  values,
  hasSetup,
  canAdjust,
  canManage,
  onAdjust,
  onAddSetting,
}: {
  zone: SuspensionZone;
  settings: SuspensionSetting[];
  values: Snapshot;
  hasSetup: boolean;
  canAdjust: boolean;
  canManage: boolean;
  onAdjust: () => void;
  onAddSetting: (zone: SuspensionZone) => void;
}) {
  const list = settingsInZone(settings, zone);
  const group = ZONE_GROUPS.find((g) => g.zones.includes(zone));
  return (
    <section aria-labelledby="zone-heading" className="space-y-4" data-testid="zone-panel" data-zone={zone}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-hot">
          {group?.label} · Zone {ZONE_NUMBER[zone]}
        </p>
        <h3 id="zone-heading" className="font-display text-3xl font-bold uppercase italic leading-tight">
          {ZONE_LABEL[zone]}
        </h3>
      </div>

      {list.length ? (
        <ul className="divide-y divide-white/10 rounded-xl border border-white/10 bg-background/40">
          {list.map((setting) => {
            const value = values[setting.id]?.value ?? null;
            return (
              <li key={setting.id} className="flex items-start justify-between gap-4 px-4 py-3" data-testid="zone-setting">
                <div className="min-w-0">
                  <p className="break-words font-semibold" data-testid="zone-setting-name">
                    {setting.name}
                  </p>
                  {setting.notes ? <p className="mt-0.5 whitespace-pre-line break-words text-xs text-muted">{setting.notes}</p> : null}
                  {setting.photos.length ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
                      <Camera aria-hidden className="size-3.5" />
                      {setting.photos.length} reference photo{setting.photos.length === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </div>
                <p
                  className={cn("shrink-0 text-right font-display text-2xl font-bold tabular-nums", value == null && "text-muted")}
                  data-testid="zone-setting-value"
                >
                  {value ?? "—"}
                  {value != null && setting.valueType === "number" && setting.unit ? (
                    <span className="ml-1 font-sans text-sm font-medium text-muted">{setting.unit}</span>
                  ) : null}
                  <span className="sr-only">{value == null ? "No value" : formatValue(value, setting.unit, setting.valueType)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-white/15 px-4 py-5 text-sm text-muted" data-testid="zone-empty">
          No settings here yet.
          {canManage ? " Add the adjusters you want to track in this part of the sled." : ""}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canAdjust && hasSetup && settings.length ? (
          <Button type="button" size="lg" onClick={onAdjust}>
            <SlidersHorizontal aria-hidden className="size-4" />
            Record adjustment
          </Button>
        ) : null}
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => onAddSetting(zone)}
            aria-label={`Add a setting to ${ZONE_LABEL[zone]}`}
          >
            <Plus aria-hidden className="size-4" />
            Add setting here
          </Button>
        ) : null}
      </div>
      {!hasSetup && list.length ? <p className="text-sm text-muted">Create a setup to record values for these settings.</p> : null}
    </section>
  );
}
