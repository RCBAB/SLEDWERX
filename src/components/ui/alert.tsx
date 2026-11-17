import { CircleAlert, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "./cn";

export function Alert({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : CircleCheck;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "error"
          ? "border-accent/40 bg-accent/10 text-foreground"
          : "border-emerald-500/40 bg-emerald-500/10 text-foreground",
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone === "error" ? "text-accent-hot" : "text-emerald-400")} />
      <div>{children}</div>
    </div>
  );
}
