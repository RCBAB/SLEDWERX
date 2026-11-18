"use client";

import { RotateCcw } from "lucide-react";

import { restoreSetting, restoreSetup } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { daysLeftToRestore, type DeletedSuspensionItem } from "@/lib/suspension/types";

import { LocalDate, useRun } from "./shared";

/**
 * Setups and settings deleted in the last 30 days, for owners and editors.
 * Restoring a setup brings back its whole history; a setting, its reference
 * photos. Nothing here is permanently removed by the app.
 */
export function DeletedItems({ items }: { items: DeletedSuspensionItem[] }) {
  const { busy, error, run } = useRun();
  if (!items.length) {
    return <p className="text-sm text-muted">Nothing deleted in the last 30 days.</p>;
  }
  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="divide-y divide-white/10 rounded-xl border border-white/10 bg-background/30" data-testid="deleted-items">
        {items.map((item) => {
          const days = daysLeftToRestore(item.deletedAt);
          return (
            <li key={`${item.kind}-${item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid="deleted-item" data-kind={item.kind}>
              <div className="min-w-0">
                <p className="break-words font-medium" data-testid="deleted-name">
                  {item.name}
                </p>
                <p className="text-xs text-muted">
                  {item.detail} · deleted <LocalDate value={item.deletedAt} /> · {days} day{days === 1 ? "" : "s"} left to restore
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                aria-label={`Restore ${item.name}`}
                onClick={() => void run(() => (item.kind === "setup" ? restoreSetup(item.id, item.version) : restoreSetting(item.id, item.version)))}
              >
                <RotateCcw aria-hidden className="size-4" />
                Restore
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
