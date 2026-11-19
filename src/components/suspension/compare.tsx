"use client";

import { ArrowLeftRight, ArrowRight, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SelectField } from "@/components/ui/field";
import { formatHours, formatMiles } from "@/lib/sleds/format";
import { compareSnapshots, formatValue, type ComparisonRow } from "@/lib/suspension/diff";
import { ZONE_LABEL, latestRevision, type SuspensionRevision, type SuspensionSetting, type SuspensionSetup } from "@/lib/suspension/types";

import { LocalDate } from "./shared";

/**
 * Two revisions of the sled side by side, from the same setup or different
 * ones. Settings that differ are listed with both values; the ones that are
 * the same are folded away. Stacks on phones (nothing scrolls sideways).
 */
export function CompareRevisions({
  setups,
  revisions,
  settings,
  aId,
  bId,
  onChange,
}: {
  setups: SuspensionSetup[];
  /** Every revision on the sled, newest first. */
  revisions: SuspensionRevision[];
  settings: SuspensionSetting[];
  aId: string;
  bId: string;
  onChange: (aId: string, bId: string) => void;
}) {
  const a = revisions.find((r) => r.id === aId);
  const b = revisions.find((r) => r.id === bId);
  const nameOf = new Map(setups.map((s) => [s.id, s.name]));
  const label = (r: SuspensionRevision) =>
    `${nameOf.get(r.setupId) ?? "Setup"} · Rev ${r.number}${latestRevision(revisions, r.setupId)?.id === r.id ? " (current)" : ""}`;
  // Grouped by setup, newest revision first.
  const options = setups.map((setup) => ({ setup, list: revisions.filter((r) => r.setupId === setup.id) })).filter((g) => g.list.length);

  const rows = a && b ? compareSnapshots(a.values, b.values, settings) : [];
  const changed = rows.filter((r) => r.changed);
  const same = rows.filter((r) => !r.changed);

  const picker = (name: "a" | "b", value: string, text: string) => (
    <SelectField
      label={text}
      name={`compare-${name}`}
      value={value}
      onChange={(event) => (name === "a" ? onChange(event.target.value, bId) : onChange(aId, event.target.value))}
    >
      {options.map(({ setup, list }) => (
        <optgroup key={setup.id} label={setup.name}>
          {list.map((r) => (
            <option key={r.id} value={r.id}>
              {label(r)}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectField>
  );

  return (
    <div className="space-y-4" data-testid="compare">
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        {picker("a", aId, "Compare")}
        <Button
          type="button"
          variant="ghost"
          className="justify-self-center"
          aria-label="Swap the two revisions"
          onClick={() => onChange(bId, aId)}
        >
          <ArrowLeftRight aria-hidden className="size-4" />
        </Button>
        {picker("b", bId, "With")}
      </div>

      {a && b ? (
        <>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <RevisionSummary revision={a} title={label(a)} tone="a" />
            <RevisionSummary revision={b} title={label(b)} tone="b" />
          </div>

          {a.id === b.id ? (
            <p className="text-muted">Pick two different revisions.</p>
          ) : changed.length ? (
            <div>
              <p className="mb-2 font-semibold" data-testid="compare-summary">
                {changed.length === 1 ? "1 setting differs" : `${changed.length} settings differ`}
              </p>
              <ul className="space-y-2" data-testid="compare-changed">
                {changed.map((row) => (
                  <CompareRow key={row.settingId} row={row} />
                ))}
              </ul>
            </div>
          ) : (
            <p className="font-semibold" data-testid="compare-summary">
              Same values in both.
            </p>
          )}

          {same.length && a.id !== b.id ? (
            <details className="group rounded-xl border border-white/10" data-testid="compare-same">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-semibold">
                <span>
                  Same in both <span className="text-muted">({same.length})</span>
                </span>
                <ChevronDown aria-hidden className="size-5 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <ul className="space-y-2 border-t border-white/10 p-3">
                {same.map((row) => (
                  <CompareRow key={row.settingId} row={row} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-muted">Pick two revisions to compare.</p>
      )}
    </div>
  );
}

function RevisionSummary({ revision, title, tone }: { revision: SuspensionRevision; title: string; tone: "a" | "b" }) {
  return (
    <div className={cn("rounded-xl border px-3 py-2", tone === "b" ? "border-accent-hot/40" : "border-white/15")}>
      <p className="font-semibold">{title}</p>
      <p className="text-xs text-muted">
        <LocalDate value={revision.createdAt} />
        {revision.odometer != null ? ` · ${formatMiles(revision.odometer)}` : ""}
        {revision.engineHours != null ? ` · ${formatHours(revision.engineHours)}` : ""}
      </p>
    </div>
  );
}

function CompareRow({ row }: { row: ComparisonRow }) {
  const unit = row.type === "text" ? null : row.unit;
  return (
    <li
      className={cn(
        "grid gap-x-4 gap-y-1 rounded-lg border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto_minmax(0,9rem)] sm:items-center",
        row.changed ? "border-accent-hot/40 bg-accent-hot/5" : "border-white/10",
      )}
      data-testid="compare-row"
      data-changed={row.changed ? "true" : "false"}
    >
      <div className="min-w-0">
        <p className="break-words font-medium" data-testid="compare-name">
          {row.name}
        </p>
        <p className="text-xs text-muted">{ZONE_LABEL[row.zone]}</p>
      </div>
      <div className="flex items-center gap-2 sm:contents">
        <span
          className={cn("break-words tabular-nums sm:text-right", row.changed && "text-muted line-through decoration-white/30")}
          data-testid="compare-a"
        >
          {formatValue(row.a, unit)}
        </span>
        <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="sr-only">to</span>
        <span className={cn("break-words font-semibold tabular-nums", row.changed && "text-accent-hot")} data-testid="compare-b">
          {formatValue(row.b, unit)}
        </span>
      </div>
    </li>
  );
}
