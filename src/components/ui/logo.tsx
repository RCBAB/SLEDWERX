import Link from "next/link";

import { cn } from "./cn";

/** The SledWerx wordmark, unchanged from the homepage design. */
export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      aria-label="SledWerx home"
      className={cn("font-display text-2xl font-extrabold uppercase italic leading-none tracking-tight", className)}
    >
      Sled<span className="text-accent">Werx</span>
    </Link>
  );
}
