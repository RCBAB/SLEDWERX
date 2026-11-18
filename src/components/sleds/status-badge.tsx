import { cn } from "@/components/ui/cn";
import type { SledStatus } from "@/lib/sleds/constants";
import { DISPLAYED_STATUS_LABELS, displayedSledStatus, type DisplayedSledStatus } from "@/lib/sleds/status";

const TONES: Record<DisplayedSledStatus, string> = {
  ready: "bg-emerald-500/15 text-emerald-300",
  needs_attention: "bg-amber-500/15 text-amber-300",
  out_of_service: "bg-accent/15 text-accent-hot",
  stored: "bg-white/10 text-foreground/80",
  not_ready: "bg-red-500/20 text-red-200 ring-1 ring-red-500/60",
};

/**
 * The sled's status. `criticalIssue` (an open Critical issue) turns a stored
 * "Ready" into a red "Not ready"; the stored status itself is unchanged.
 */
export function StatusBadge({
  status,
  criticalIssue = false,
  className,
}: {
  status: SledStatus;
  criticalIssue?: boolean;
  className?: string;
}) {
  const shown = displayedSledStatus(status, criticalIssue);
  return (
    <span
      data-testid="sled-status"
      data-status={shown}
      title={shown === "not_ready" ? "Not ready: open critical issue" : undefined}
      className={cn("inline-flex rounded-full px-3 py-1 text-xs font-semibold", TONES[shown], className)}
    >
      {DISPLAYED_STATUS_LABELS[shown]}
      {shown === "not_ready" ? <span className="sr-only"> (open critical issue)</span> : null}
    </span>
  );
}
