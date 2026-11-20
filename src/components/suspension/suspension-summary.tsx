"use client";

import { Eye, MessageSquarePlus, SlidersHorizontal, SlidersVertical, Wrench } from "lucide-react";
import { useLayoutEffect, useState } from "react";

import { Sheet } from "@/components/board/sheet";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate } from "@/lib/sleds/format";
import { suspensionCapabilities } from "@/lib/sleds/permissions";
import { formatValue } from "@/lib/suspension/diff";
import { QUICK_TUNE_SECTIONS, sectionRows } from "@/lib/suspension/quick-tune";
import { configName, type ActiveSuspension } from "@/lib/suspension/types";

import { AdjustForm } from "./adjust-form";
import { EquipmentForm } from "./equipment";
import { EvaluationForm } from "./evaluation-form";
import { ConditionChips, EquipmentText, RatingBadge } from "./shared";

type OpenSheet = "view" | "adjust" | "evaluation" | "equipment" | null;

/**
 * A sled's suspension at a glance, with quick actions: on the snowmobile page
 * ("page") and on the Garage Board, including Wall Display ("board", large
 * controls with `big`). Shows the active Trail configuration, its newest ride
 * evaluation, and the Active Ski Configuration (the same installed-equipment
 * record Quick Tune shows and changes). View is for everyone on the sled;
 * Adjust, Ride evaluation and changing skis or carbides follow the role.
 */
export function SuspensionSummary({
  sledId,
  sledName,
  active: summary,
  role,
  odometer,
  engineHours,
  variant,
  big = false,
  photoUploads,
}: {
  sledId: string;
  sledName: string;
  /** Null when the database doesn't have Quick Tune (Migration 9) yet. */
  active: ActiveSuspension | null;
  role: SledRole;
  odometer: number | null;
  engineHours: number | null;
  variant: "page" | "board";
  big?: boolean;
  /** The photo-upload feature flag (decided on the server). */
  photoUploads: boolean;
}) {
  const can = suspensionCapabilities(role, { photoUploads });
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // Close sheets when the page is hidden (Next.js keeps it mounted).
  useLayoutEffect(() => () => setSheet(null), []);
  const show = (next: OpenSheet) => {
    setNotice(null);
    setSession((n) => n + 1);
    setSheet(next);
  };
  const close = () => setSheet(null);

  const page = `/garage/${sledId}/suspension`;
  const size = big ? "lg" : "md";
  const button = cn(big && "h-14");
  const active = summary?.active ?? null;
  const hasSettings = Boolean(summary?.settings.length);
  const zone = summary?.settings[0]?.zone ?? null;
  const name = active ? configName(active.configNumber) : null;
  const description = name ? `${sledName} · ${name}` : sledName;

  return (
    <div className="space-y-3" data-testid="suspension-summary" data-sled-id={sledId}>
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", big ? "text-lg" : "text-sm")}>
        <span className="inline-flex items-center gap-1.5 font-semibold text-muted">
          <SlidersVertical aria-hidden className={big ? "size-5" : "size-4"} />
          Suspension
        </span>
        {active ? (
          <>
            <span className="font-semibold text-foreground" data-testid="suspension-active">
              {name} · Active
            </span>
            {active.latestFeedback ? (
              <span className="inline-flex flex-wrap items-center gap-2 text-muted" data-testid="suspension-feedback">
                <RatingBadge rating={active.latestFeedback.rating} />
                <ConditionChips conditions={active.latestFeedback.conditions} />
                <span>{formatDate(active.latestFeedback.riddenOn)}</span>
              </span>
            ) : (
              <span className="text-muted">No ride evaluations yet</span>
            )}
          </>
        ) : (
          <span className="text-muted" data-testid="suspension-none">
            {summary ? "No configuration yet" : "Not available yet"}
          </span>
        )}
      </div>

      {summary ? (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background/40 px-3 py-2 ring-1 ring-white/10",
            big && "px-4 py-3",
          )}
          data-testid="ski-configuration"
        >
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Active ski configuration</p>
            <p className={big ? "text-lg" : "text-sm"}>
              <EquipmentText equipment={summary.installed} className="font-semibold" />
            </p>
          </div>
          {can.canAdjust ? (
            <Button
              type="button"
              variant="ghost"
              size={size}
              className={button}
              onClick={() => show("equipment")}
              aria-label={`Change skis or carbides on ${sledName}`}
            >
              <Wrench aria-hidden className="size-4" />
              Change
            </Button>
          ) : null}
        </div>
      ) : null}

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        {active ? (
          <Button
            type="button"
            variant="secondary"
            size={size}
            className={button}
            onClick={() => show("view")}
            aria-label={`View suspension setup on ${sledName}`}
          >
            <Eye aria-hidden className="size-4" />
            View
          </Button>
        ) : null}
        {summary && hasSettings && can.canAdjust ? (
          <Button
            type="button"
            variant="secondary"
            size={size}
            className={button}
            onClick={() => show("adjust")}
            aria-label={`Adjust suspension on ${sledName}`}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            Adjust
          </Button>
        ) : null}
        {active && can.canAddFeedback ? (
          <Button
            type="button"
            variant="secondary"
            size={size}
            className={button}
            onClick={() => show("evaluation")}
            aria-label={`Add ride evaluation on ${sledName}`}
          >
            <MessageSquarePlus aria-hidden className="size-4" />
            Ride evaluation
          </Button>
        ) : null}
        <ButtonLink
          href={page}
          variant={variant === "page" ? "secondary" : "ghost"}
          size={size}
          className={button}
          aria-label={`Open suspension tuning for ${sledName}`}
        >
          {variant === "page" ? "Open Quick Tune" : "Suspension page"}
        </ButtonLink>
      </div>

      <Sheet open={sheet === "view" && Boolean(active)} onClose={close} title="Suspension setup" description={description}>
        {sheet === "view" && summary && active ? <ActiveValues summary={summary} /> : null}
      </Sheet>

      <Sheet open={sheet === "adjust" && Boolean(summary)} onClose={close} title="Record adjustment" description={description}>
        {sheet === "adjust" && summary ? (
          <AdjustForm
            key={session}
            sledId={sledId}
            configName={name}
            baseRevisionId={active?.revisionId ?? null}
            values={active?.values ?? {}}
            settings={summary.settings}
            focusZone={zone}
            odometer={odometer}
            engineHours={engineHours}
            photoUploads={can.canAddAdjustmentPhotos}
            onDone={(result) => {
              close();
              if (result.ok) {
                const saved = result.configNumber ? `Saved as ${configName(result.configNumber)}.` : "Adjustment saved.";
                setNotice(result.warning ? { tone: "error", text: `${saved} ${result.warning}` } : { tone: "success", text: saved });
              }
            }}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet === "evaluation" && Boolean(active)} onClose={close} title="Ride evaluation" description={description}>
        {sheet === "evaluation" && active ? (
          <EvaluationForm
            key={session}
            sledId={sledId}
            revisionId={active.revisionId}
            onDone={() => {
              close();
              setNotice({ tone: "success", text: "Ride evaluation saved." });
            }}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet === "equipment" && Boolean(summary)} onClose={close} title="Skis & carbides" description={sledName}>
        {sheet === "equipment" && summary ? (
          <EquipmentForm
            key={session}
            sledId={sledId}
            activeRevisionId={active?.revisionId ?? null}
            activeName={name}
            installed={summary.installed}
            values={active?.values ?? {}}
            onDone={(result) => {
              close();
              if (result.configNumber)
                setNotice({ tone: "success", text: `Skis and carbides saved as ${configName(result.configNumber)}.` });
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

/** The active configuration's values in Quick Tune order (read-only). */
function ActiveValues({ summary }: { summary: ActiveSuspension }) {
  const values = summary.active?.values ?? {};
  const sections = QUICK_TUNE_SECTIONS.map((section) => ({
    section,
    rows: sectionRows(summary.settings, section.id).flatMap((row) =>
      row.kind === "pair"
        ? values[row.left.id]?.value === values[row.right.id]?.value
          ? [{ id: row.key, label: `${row.label} (both)`, setting: row.left }]
          : [
              { id: row.left.id, label: `${row.label} (Left)`, setting: row.left },
              { id: row.right.id, label: `${row.label} (Right)`, setting: row.right },
            ]
        : [{ id: row.setting.id, label: row.side ? `${row.label} (${row.side})` : row.label, setting: row.setting }],
    ),
  })).filter((s) => s.rows.length);
  if (!sections.length) return <p className="text-muted">No settings yet. Add them on the Suspension page.</p>;
  return (
    <div className="space-y-4" data-testid="active-values">
      <p className="text-sm">
        <EquipmentText equipment={summary.installed} className="font-semibold" />
      </p>
      {sections.map(({ section, rows }) => (
        <div key={section.id}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">{section.label}</p>
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
            {rows.map((r) => {
              const value = values[r.setting.id]?.value ?? null;
              return (
                <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3" data-testid="active-value">
                  <span className="min-w-0 break-words font-medium">{r.label}</span>
                  <span className={cn("shrink-0 font-display text-xl font-bold tabular-nums", value == null && "text-muted")}>
                    {formatValue(value, r.setting.unit, r.setting.valueType)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
