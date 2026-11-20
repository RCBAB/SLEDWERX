"use client";

import { Eye, MessageSquarePlus, SlidersHorizontal, SlidersVertical } from "lucide-react";
import { useLayoutEffect, useState } from "react";

import { Sheet } from "@/components/board/sheet";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate } from "@/lib/sleds/format";
import { suspensionCapabilities } from "@/lib/sleds/permissions";
import { formatValue } from "@/lib/suspension/diff";
import { ZONE_GROUPS, ZONE_LABEL, settingsInZone, type ActiveSuspension } from "@/lib/suspension/types";

import { AdjustForm } from "./adjust-form";
import { FeedbackForm } from "./history";
import { RatingBadge } from "./shared";

type OpenSheet = "view" | "adjust" | "feedback" | null;

/**
 * The active suspension setup at a glance, with quick actions: on the sled
 * page ("page") and on the Garage Board, including Wall Display ("board",
 * large controls with `big`). View setup is for everyone on the sled; Adjust
 * and Ride feedback follow the role (owners, editors, mechanics). Setup and
 * settings management stay on the full Suspension Tuning page.
 */
export function SuspensionSummary({
  sledId,
  sledName,
  active,
  role,
  odometer,
  engineHours,
  variant,
  big = false,
  photoUploads,
}: {
  sledId: string;
  sledName: string;
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
  const hasSettings = Boolean(active?.settings.length);
  const zone = active?.settings[0]?.zone ?? null;
  const description = active ? `${sledName} · ${active.setupName} · Rev ${active.revisionNumber}` : sledName;

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
              {active.setupName} · Rev {active.revisionNumber}
            </span>
            {active.latestFeedback ? (
              <span className="inline-flex items-center gap-2 text-muted" data-testid="suspension-feedback">
                <RatingBadge rating={active.latestFeedback.rating} />
                <span>{formatDate(active.latestFeedback.riddenOn)}</span>
              </span>
            ) : (
              <span className="text-muted">No ride feedback yet</span>
            )}
          </>
        ) : (
          <span className="text-muted" data-testid="suspension-none">
            No active setup
          </span>
        )}
      </div>

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
            View setup
          </Button>
        ) : null}
        {active && hasSettings && can.canAdjust ? (
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
            onClick={() => show("feedback")}
            aria-label={`Add ride feedback on ${sledName}`}
          >
            <MessageSquarePlus aria-hidden className="size-4" />
            Ride feedback
          </Button>
        ) : null}
        <ButtonLink
          href={page}
          variant={variant === "page" ? "secondary" : "ghost"}
          size={size}
          className={button}
          aria-label={`Open suspension tuning for ${sledName}`}
        >
          {variant === "page" ? "Open Suspension Tuning" : "Suspension page"}
        </ButtonLink>
      </div>

      <Sheet open={sheet === "view" && Boolean(active)} onClose={close} title="Suspension setup" description={description}>
        {sheet === "view" && active ? <ActiveValues active={active} /> : null}
      </Sheet>

      <Sheet open={sheet === "adjust" && Boolean(active)} onClose={close} title="Record adjustment" description={description}>
        {sheet === "adjust" && active ? (
          <AdjustForm
            key={session}
            sledId={sledId}
            setupId={active.setupId}
            setupName={active.setupName}
            baseRevisionId={active.revisionId}
            values={active.values}
            settings={active.settings}
            focusZone={zone}
            odometer={odometer}
            engineHours={engineHours}
            photoUploads={can.canAddAdjustmentPhotos}
            onDone={(result) => {
              close();
              if (result.ok)
                setNotice(
                  result.warning
                    ? { tone: "error", text: `Adjustment saved. ${result.warning}` }
                    : { tone: "success", text: "Adjustment saved." },
                );
            }}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet === "feedback" && Boolean(active)} onClose={close} title="Ride feedback" description={description}>
        {sheet === "feedback" && active ? (
          <FeedbackForm
            key={session}
            sledId={sledId}
            revision={{ id: active.revisionId, number: active.revisionNumber }}
            onDone={() => {
              close();
              setNotice({ tone: "success", text: "Ride feedback saved." });
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

/** The active setup's current values by zone (read-only). */
function ActiveValues({ active }: { active: ActiveSuspension }) {
  const zones = ZONE_GROUPS.flatMap((g) => g.zones).filter((z) => active.settings.some((s) => s.zone === z));
  if (!zones.length) return <p className="text-muted">No settings yet. Add them on the Suspension Tuning page.</p>;
  return (
    <div className="space-y-4" data-testid="active-values">
      {zones.map((z) => (
        <div key={z}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">{ZONE_LABEL[z]}</p>
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
            {settingsInZone(active.settings, z).map((s) => {
              const value = active.values[s.id]?.value ?? null;
              return (
                <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3" data-testid="active-value">
                  <span className="min-w-0 break-words font-medium">{s.name}</span>
                  <span className={cn("shrink-0 font-display text-xl font-bold tabular-nums", value == null && "text-muted")}>
                    {formatValue(value, s.unit, s.valueType)}
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
