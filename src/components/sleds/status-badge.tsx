import { cn } from "@/components/ui/cn";
import { STATUS_LABELS, type SledStatus } from "@/lib/sleds/constants";

const TONES: Record<SledStatus, string> = {
  ready: "bg-emerald-500/15 text-emerald-300",
  needs_attention: "bg-amber-500/15 text-amber-300",
  out_of_service: "bg-accent/15 text-accent-hot",
  stored: "bg-white/10 text-foreground/80",
};

export function StatusBadge({ status, className }: { status: SledStatus; className?: string }) {
  return (
    <span className={cn("inline-flex rounded-full px-3 py-1 text-xs font-semibold", TONES[status], className)}>
      {STATUS_LABELS[status]}
    </span>
  );
}
