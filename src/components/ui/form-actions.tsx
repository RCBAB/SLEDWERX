import type { ReactNode } from "react";

import { cn } from "./cn";

/**
 * A dialog form's Save/Cancel row. It stays pinned to the bottom of the
 * dialog while the form scrolls, so the actions are always visible (also when
 * the Wall Display keyboard takes the lower part of the screen).
 */
export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-form-actions
      className={cn("sticky bottom-0 z-10 -mx-5 -mb-5 border-t border-white/10 bg-surface px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6", className)}
    >
      {children}
    </div>
  );
}
