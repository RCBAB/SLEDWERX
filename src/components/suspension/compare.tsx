"use client";

import { ArrowLeftRight, ArrowRight, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SelectField } from "@/components/ui/field";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { compareSnapshots, equipmentChanges, formatValue, type ComparisonRow } from "@/lib/suspension/diff";
import { byNumberDesc } from "@/lib/suspension/quick-tune";
import { ZONE_LABEL, configName, type SuspensionRevision, type SuspensionSetting } from "@/lib/suspension/types";

import { ActiveBadge, ConditionChips, EquipmentText, LocalDate, RatingBadge } from "./shared";

/**
 * Two configurations side by side: Trail numbers, active or not, skis and
 * carbides, every suspension difference ("Compression: 10 → 12 clicks (+2)"),
 * and their ride evaluations with conditions, temperatures and notes. Same
 * values are folded away. Stacks on phones (nothing scrolls sideways).
 */
export function CompareConfigurations({
  revisions,
  activeId,
  settings,
  aId,
  bId,
  onChange,
}: {
  revisions: SuspensionRevision[];
  activeId: string | null;
  settings: SuspensionSetting[];
  aId: string;
  bId: string;
  onChange: (aId: string, bId: string) => void;
}) {
  const a = revisions.find((r) => r.id === aId);
  const b = revisions.find((r) => r.id === bId);
  const label = (r: SuspensionRevision) => `${configName(r.configNumber)}${r.id === activeId ? " (active)" : ""}`;
  const options = byNumberDesc(revisions);

  const rows = a && b ? compareSnapshots(a.values, b.values, settings) : [];
  const equipment = a && b ? equipmentChanges(a.equipment, b.equipment) : [];
  const changed = rows.filter((r) => r.changed);
  const same = rows.filter((r) => !r.changed);

  const picker = (name: "a" | "b", value: string, text: string) => (
    <SelectField
      label={text}
      name={`compare-${name}`}
      value={value}
      onChange={(event) => (name === "a" ? onChange(event.target.value, bId) : onChange(aId, event.target.value))}
    >
      {options.map((r) => (
        <option key={r.id} value={r.id}>
          {label(r)}
        </option>
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
          aria-label="Swap the two configurations"
          onClick={() => onChange(bId, aId)}
        >
          <ArrowLeftRight aria-hidden className="size-4" />
        </Button>
        {picker("b", bId, "With")}
      </div>

      {a && b ? (
        <>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <ConfigurationSummary revision={a} active={a.id === activeId} tone="a" />
            <ConfigurationSummary revision={b} active={b.id === activeId} tone="b" />
          </div>

          {a.id === b.id ? (
            <p className="text-muted">Pick two different configurations.</p>
          ) : changed.length || equipment.length ? (
            <div>
              <p className="mb-2 font-semibold" data-testid="compare-summary">
                {configName(a.configNumber)} → {configName(b.configNumber)}:{" "}
                {[
                  changed.length ? (changed.length === 1 ? "1 setting differs" : `${changed.length} settings differ`) : null,
                  equipment.length ? "different skis or carbides" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <ul className="space-y-2" data-testid="compare-changed">
                {changed.map((row) => (
                  <CompareRow key={row.settingId} row={row} />
                ))}
                {equipment.map((line) => (
                  <li
                    key={line}
                    className="rounded-lg border border-accent-hot/40 bg-accent-hot/5 px-3 py-2 font-semibold"
                    data-testid="compare-equipment"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="font-semibold" data-testid="compare-summary">
              Same values and equipment in both.
            </p>
          )}

          {a.id !== b.id ? (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="compare-evaluations">
              <EvaluationSummary revision={a} />
              <EvaluationSummary revision={b} />
            </div>
          ) : null}

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
        <p className="text-muted">Pick two configurations to compare.</p>
      )}
    </div>
  );
}

function ConfigurationSummary({ revision, active, tone }: { revision: SuspensionRevision; active: boolean; tone: "a" | "b" }) {
  return (
    <div
      className={cn("rounded-xl border px-3 py-2", tone === "b" ? "border-accent-hot/40" : "border-white/15")}
      data-testid="compare-config"
    >
      <p className="flex flex-wrap items-center gap-2 font-semibold">
        {configName(revision.configNumber)}
        {active ? <ActiveBadge /> : <span className="text-xs font-semibold uppercase tracking-wider text-muted">Inactive</span>}
      </p>
      <p className="text-sm">
        <EquipmentText equipment={revision.equipment} />
      </p>
      <p className="text-xs text-muted">
        <LocalDate value={revision.createdAt} />
        {revision.odometer != null ? ` · ${formatMiles(revision.odometer)}` : ""}
        {revision.engineHours != null ? ` · ${formatHours(revision.engineHours)}` : ""}
      </p>
    </div>
  );
}

/** A configuration's ride evaluations in short: rating, conditions, temperature, notes. */
function EvaluationSummary({ revision }: { revision: SuspensionRevision }) {
  return (
    <div className="rounded-xl border border-white/10 px-3 py-2">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted">
        {configName(revision.configNumber)} · ride evaluations
      </p>
      {revision.feedback.length ? (
        <ul className="space-y-2">
          {revision.feedback.map((f) => (
            <li key={f.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <RatingBadge rating={f.rating} />
                <span className="text-muted">{formatDate(f.riddenOn)}</span>
                {f.highTempF != null ? <span className="text-muted">· High {f.highTempF} °F</span> : null}
              </div>
              <ConditionChips conditions={f.conditions} />
              {f.note ? <p className="whitespace-pre-line break-words text-foreground/90">{f.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No ride evaluations yet.</p>
      )}
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
