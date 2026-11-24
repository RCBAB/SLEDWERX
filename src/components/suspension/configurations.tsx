"use client";

import { Camera, CheckCircle2, Eye, GitCompareArrows, MessageSquarePlus, Pencil, Thermometer, Trash2 } from "lucide-react";
import { useState } from "react";

import { deleteFeedback } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { canEditSuspensionFeedback, suspensionCapabilities } from "@/lib/sleds/permissions";
import { describeChange, equipmentChanges, formatValue, revisionChanges } from "@/lib/suspension/diff";
import { QUICK_TUNE_SECTIONS, baseOf, byNumberDesc, sectionRows } from "@/lib/suspension/quick-tune";
import { formatTurns, trailReminders } from "@/lib/suspension/turns";
import { ZONE_LABEL, configName, type SuspensionFeedback, type SuspensionRevision, type SuspensionSetting } from "@/lib/suspension/types";

import { MeasurementPhotoButton } from "./measurement-photos";
import { ReminderChip } from "./reminders";
import { PhotoGrid } from "./photos";
import { ActiveBadge, ConditionChips, EquipmentText, LocalDate, RatingBadge, useRun } from "./shared";

/** How many configurations show before "Show more". */
const PAGE = 10;
const CHANGES_SHOWN = 6;

export type HistoryActions = {
  onView: (revision: SuspensionRevision) => void;
  onCompare: (revision: SuspensionRevision) => void;
  onActivate: (revision: SuspensionRevision) => void;
  onAddEvaluation: (revision: SuspensionRevision) => void;
  onEditEvaluation: (revision: SuspensionRevision, feedback: SuspensionFeedback) => void;
  onPhotos: (revision: SuspensionRevision) => void;
};

/**
 * Every saved configuration, newest first: Trail number, active or not, skis
 * and carbides, what changed from the configuration it was made from, the
 * note, and every ride evaluation with its conditions. Nothing here edits a
 * configuration; Make active switches to it without creating a new one.
 */
export function ConfigurationHistory({
  revisions,
  activeId,
  settings,
  role,
  photoUploads,
  userId,
  ...actions
}: {
  revisions: SuspensionRevision[];
  activeId: string | null;
  settings: SuspensionSetting[];
  role: SledRole;
  photoUploads: boolean;
  userId: string;
} & HistoryActions) {
  const [shown, setShown] = useState(PAGE);
  const ordered = byNumberDesc(revisions);
  if (!ordered.length) return <p className="text-muted">No configurations saved yet.</p>;
  return (
    <div className="space-y-3">
      <ol className="space-y-3" data-testid="configuration-history">
        {ordered.slice(0, shown).map((revision) => (
          <ConfigurationCard
            key={revision.id}
            revision={revision}
            base={baseOf(revisions, revision)}
            active={revision.id === activeId}
            settings={settings}
            role={role}
            photoUploads={photoUploads}
            userId={userId}
            {...actions}
          />
        ))}
      </ol>
      {ordered.length > shown ? (
        <Button type="button" variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, ordered.length - shown)} more ({ordered.length - shown} older)
        </Button>
      ) : null}
    </div>
  );
}

function ConfigurationCard({
  revision,
  base,
  active,
  settings,
  role,
  photoUploads,
  userId,
  onView,
  onCompare,
  onActivate,
  onAddEvaluation,
  onEditEvaluation,
  onPhotos,
}: {
  revision: SuspensionRevision;
  base: SuspensionRevision | undefined;
  active: boolean;
  settings: SuspensionSetting[];
  role: SledRole;
  photoUploads: boolean;
  userId: string;
} & HistoryActions) {
  const can = suspensionCapabilities(role, { photoUploads });
  const name = configName(revision.configNumber);
  const changes = revisionChanges(base?.display ?? null, revision.display, settings);
  const equipment = base ? equipmentChanges(base.equipment, revision.equipment) : [];
  const [allChanges, setAllChanges] = useState(false);
  // Migration 12: a turns adjustment reads "+1 turn (total +3 turns)", not a change of shown value.
  const turned = (id: string) => revision.turns[id]?.adjustment ?? null;
  const lines = [
    ...changes
      .filter((c) => turned(c.settingId) === null)
      .map((c) => ({ key: c.settingId, zone: ZONE_LABEL[c.zone], text: describeChange(c), muted: c.kind === "cleared" })),
    ...Object.entries(revision.turns)
      .filter(([, t]) => t.adjustment !== null)
      .map(([id, t]) => {
        const setting = settings.find((s) => s.id === id);
        return {
          key: `turns-${id}`,
          zone: setting ? ZONE_LABEL[setting.zone] : null,
          text: `${setting?.name ?? "Setting removed"}: ${formatTurns(t.adjustment!)}${t.cumulative !== null && t.cumulative !== t.adjustment ? ` (total ${formatTurns(t.cumulative)})` : ""}`,
          muted: false,
        };
      }),
    ...equipment.map((text) => ({ key: text, zone: null, text, muted: false })),
  ];
  const recorded = Object.entries(revision.turns).flatMap(([id, t]) =>
    t.records.map((record, n) => {
      const setting = settings.find((s) => s.id === id);
      const value = formatValue(record.value, setting?.unit ?? null);
      return {
        key: `${id}-${n}`,
        text:
          n === 0
            ? `${setting?.name ?? "Setting removed"} measured ${value}${record.cumulative !== null ? ` after ${formatTurns(record.cumulative)}` : ""}`
            : `${setting?.name ?? "Setting removed"} corrected to ${value}`,
        by: record.createdByName,
        at: record.createdAt,
      };
    }),
  );
  const reminders = trailReminders(revision.turns, settings, photoUploads);

  return (
    <li
      className={cn("rounded-2xl border bg-surface/70 p-4 sm:p-5", active ? "border-accent/60" : "border-white/10")}
      data-testid="configuration"
      data-number={revision.configNumber}
      data-active={active ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-2xl font-bold uppercase italic leading-none">{name}</h3>
        {active ? <ActiveBadge /> : null}
      </div>
      <p className="mt-1 text-sm text-muted" data-testid="configuration-meta">
        <LocalDate value={revision.createdAt} withTime /> · {revision.createdByName}
        {revision.odometer != null ? ` · ${formatMiles(revision.odometer)}` : ""}
        {revision.engineHours != null ? ` · ${formatHours(revision.engineHours)}` : ""}
      </p>
      <p className="mt-2 text-sm">
        <span className="text-muted">Skis &amp; carbides: </span>
        <EquipmentText equipment={revision.equipment} className="font-semibold" />
      </p>

      <div className="mt-3 text-sm" data-testid="configuration-changes">
        {base ? (
          <>
            <p className="mb-1 font-semibold text-foreground/90">
              {configName(base.configNumber)} → {name}
            </p>
            {lines.length ? (
              <ul className="space-y-1">
                {(allChanges ? lines : lines.slice(0, CHANGES_SHOWN)).map((line) => (
                  <li key={line.key} className="flex flex-wrap gap-x-2">
                    {line.zone ? <span className="text-muted">{line.zone}</span> : null}
                    <span className={cn("font-medium", line.muted ? "text-muted" : "text-foreground")}>{line.text}</span>
                  </li>
                ))}
                {lines.length > CHANGES_SHOWN ? (
                  <li>
                    <button
                      type="button"
                      className="min-h-11 text-sm font-semibold text-accent-hot underline-offset-4 hover:underline"
                      aria-expanded={allChanges}
                      onClick={() => setAllChanges((open) => !open)}
                    >
                      {allChanges ? "Show fewer" : `Show all ${lines.length} changes`}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-muted">Same values and equipment as {configName(base.configNumber)}.</p>
            )}
          </>
        ) : changes.length ? (
          <p className="text-muted">
            Started with {changes.length} value{changes.length === 1 ? "" : "s"}.
          </p>
        ) : (
          <p className="text-muted">Started blank.</p>
        )}
      </div>

      {recorded.length ? (
        <ul className="mt-3 space-y-1 text-sm" data-testid="configuration-measurements">
          {recorded.map((r) => (
            <li key={r.key} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{r.text}</span>
              <span className="text-muted">
                · <LocalDate value={r.at} withTime /> · {r.by}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {reminders.length ? (
        <ul className="mt-3 space-y-1" data-testid="configuration-reminders">
          {reminders.map((r) => (
            <li key={r.settingId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{r.name}</span>
              {r.measurementNeeded ? <ReminderChip kind="measurement" /> : null}
              {r.photoNeeded ? <ReminderChip kind="photo" /> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {revision.note ? (
        <p
          className="mt-3 whitespace-pre-line break-words rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-foreground/90"
          data-testid="configuration-note"
        >
          {revision.note}
        </p>
      ) : null}

      {revision.photos.length ? (
        <div className="mt-3" data-testid="revision-photos">
          <PhotoGrid photos={revision.photos} label={name} canRemove={false} size="sm" />
        </div>
      ) : null}

      <Evaluations
        revision={revision}
        role={role}
        userId={userId}
        canRemove={can.canRemove}
        onEdit={(f) => onEditEvaluation(revision, f)}
      />

      <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3">
        {can.canAddFeedback ? (
          <Button type="button" variant="secondary" onClick={() => onAddEvaluation(revision)} aria-label={`Add ride evaluation to ${name}`}>
            <MessageSquarePlus aria-hidden className="size-4" />
            Add ride evaluation
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => onView(revision)} aria-label={`View ${name}`}>
          <Eye aria-hidden className="size-4" />
          View
        </Button>
        <Button type="button" variant="ghost" onClick={() => onCompare(revision)} aria-label={`Compare ${name}`}>
          <GitCompareArrows aria-hidden className="size-4" />
          Compare
        </Button>
        {can.canAdjust && !active ? (
          <Button type="button" variant="ghost" onClick={() => onActivate(revision)} aria-label={`Make ${name} active`}>
            <CheckCircle2 aria-hidden className="size-4" />
            Make active
          </Button>
        ) : null}
        {can.canAddAdjustmentPhotos || revision.photos.length ? (
          <Button type="button" variant="ghost" onClick={() => onPhotos(revision)} aria-label={`Photos of ${name}`}>
            <Camera aria-hidden className="size-4" />
            Photos{revision.photos.length ? ` (${revision.photos.length})` : ""}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** A configuration's ride evaluations, newest ride first. */
export function Evaluations({
  revision,
  role,
  userId,
  canRemove,
  onEdit,
}: {
  revision: SuspensionRevision;
  role: SledRole;
  userId: string;
  canRemove: boolean;
  onEdit?: (feedback: SuspensionFeedback) => void;
}) {
  const { busy, error, run } = useRun();
  if (!revision.feedback.length) return null;
  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Ride evaluations ({revision.feedback.length})</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="space-y-2" data-testid="evaluation-list">
        {revision.feedback.map((feedback) => {
          const canEdit = Boolean(onEdit) && canEditSuspensionFeedback(role, feedback.createdBy, userId);
          return (
            <li key={feedback.id} className="rounded-xl border border-white/10 bg-background/40 px-3 py-2" data-testid="evaluation">
              <div className="flex items-start gap-x-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <RatingBadge rating={feedback.rating} />
                    {feedback.highTempF != null ? (
                      <span className="inline-flex items-center gap-1 text-sm text-foreground/90" data-testid="evaluation-temp">
                        <Thermometer aria-hidden className="size-4 text-muted" />
                        High {feedback.highTempF} °F
                      </span>
                    ) : null}
                  </div>
                  <ConditionChips conditions={feedback.conditions} />
                  <p className="break-words text-sm text-muted">
                    Ridden {formatDate(feedback.riddenOn)} · {feedback.createdByName}
                  </p>
                </div>
                {canEdit || canRemove ? (
                  <div className="-my-1 flex shrink-0 gap-1">
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="size-11 p-0"
                        disabled={busy}
                        aria-label={`Edit evaluation from ${formatDate(feedback.riddenOn)}`}
                        onClick={() => onEdit?.(feedback)}
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="size-11 p-0"
                        disabled={busy}
                        aria-label={`Remove evaluation from ${formatDate(feedback.riddenOn)}`}
                        onClick={() => {
                          if (window.confirm("Remove this ride evaluation? It can be restored from Recently Deleted for 30 days."))
                            void run(() => deleteFeedback(feedback.id, feedback.version));
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {feedback.note ? (
                <p className="mt-1 whitespace-pre-line break-words text-sm text-foreground/90" data-testid="evaluation-note">
                  {feedback.note}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One configuration in full (read-only; viewing never activates it). */
export function ConfigurationDetails({
  revision,
  settings,
  active,
  role,
  userId,
  measurement,
  photoUploads = false,
}: {
  revision: SuspensionRevision;
  settings: SuspensionSetting[];
  active: boolean;
  role: SledRole;
  userId: string;
  /** Measurement photos of this configuration (Migration 10), when available. */
  measurement?: { canAdd: boolean; open: (setting: SuspensionSetting, name: string) => void } | null;
  /** Photo uploads are on (Photo Needed is shown only then). */
  photoUploads?: boolean;
}) {
  const photoCount = (settingId: string) => revision.measurementPhotos.filter((m) => m.settingId === settingId).length;
  // Settings that still exist, in Quick Tune order; then values of settings removed since.
  const shownIds = new Set<string>();
  const sections = QUICK_TUNE_SECTIONS.map((section) => {
    const rows = sectionRows(settings, section.id).flatMap((row) =>
      row.kind === "pair"
        ? [
            { id: row.left.id, label: `${row.label} (Left)`, setting: row.left },
            { id: row.right.id, label: `${row.label} (Right)`, setting: row.right },
          ]
        : [{ id: row.setting.id, label: row.side ? `${row.label} (${row.side})` : row.label, setting: row.setting }],
    );
    rows.forEach((r) => shownIds.add(r.id));
    return { section, rows };
  });
  const removed = Object.entries(revision.display).filter(([id]) => !shownIds.has(id));
  return (
    <div className="space-y-4" data-testid="configuration-details">
      <p className="text-sm">
        {active ? (
          <ActiveBadge className="mr-2" />
        ) : (
          <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-muted">Not active</span>
        )}
        <EquipmentText equipment={revision.equipment} className="font-semibold" />
      </p>
      {sections.map(({ section, rows }) =>
        rows.length ? (
          <div key={section.id}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">{section.label}</p>
            <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
              {rows.map((r) => {
                const entry = revision.display[r.id];
                const value = entry?.value ?? null;
                const t = revision.turns[r.id];
                return (
                  <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-2.5" data-testid="detail-value">
                    <span className="min-w-0 break-words font-medium">
                      {r.label}
                      {t?.measurement != null && t.cumulative !== null ? (
                        <span className="ml-2 text-xs font-normal text-muted">measured after {formatTurns(t.cumulative)}</span>
                      ) : null}
                      {t?.measurementNeeded ? (
                        <span className="ml-2 inline-block align-middle">
                          <ReminderChip kind="measurement" />
                        </span>
                      ) : null}
                      {t?.photoNeeded && photoUploads ? (
                        <span className="ml-2 inline-block align-middle">
                          <ReminderChip kind="photo" />
                        </span>
                      ) : null}
                      {measurement && (photoCount(r.id) > 0 || measurement.canAdd) ? (
                        <span className="ml-3 inline-block align-middle">
                          <MeasurementPhotoButton
                            count={photoCount(r.id)}
                            name={r.label}
                            configNumber={revision.configNumber}
                            onClick={() => measurement.open(r.setting, r.label)}
                          />
                        </span>
                      ) : null}
                    </span>
                    <span className={cn("shrink-0 font-display text-xl font-bold tabular-nums", value == null && "text-muted")}>
                      {formatValue(value, entry?.type === "text" ? null : r.setting.unit, entry?.type ?? r.setting.valueType)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null,
      )}
      {removed.length ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">Settings removed since</p>
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
            {removed.map(([id, entry]) => (
              <li key={id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="min-w-0 break-words font-medium">
                  {entry.name} <span className="text-muted">({ZONE_LABEL[entry.zone]})</span>
                </span>
                <span className="shrink-0 font-display text-xl font-bold tabular-nums">
                  {formatValue(entry.value, entry.unit, entry.type)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {revision.note ? (
        <p className="whitespace-pre-line break-words rounded-lg bg-white/[0.03] px-3 py-2 text-sm">{revision.note}</p>
      ) : null}
      <Evaluations revision={revision} role={role} userId={userId} canRemove={false} />
    </div>
  );
}
