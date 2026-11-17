import { Snowflake } from "lucide-react";

import { cn } from "@/components/ui/cn";

/** A sled photo from a short-lived signed URL, or a placeholder. */
export function SledPhoto({ url, alt, className }: { url: string | null; alt: string; className?: string }) {
  if (!url) {
    return (
      <div
        className={cn(
          "grid place-items-center bg-gradient-to-br from-white/[0.06] to-white/[0.02] text-muted",
          className,
        )}
        role="img"
        aria-label={`${alt} (no photo)`}
      >
        <Snowflake aria-hidden className="size-10 opacity-40" />
      </div>
    );
  }
  return (
    // Signed URLs from the private bucket change on every request and are not
    // served through the Next.js image optimizer.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className={cn("object-cover", className)} loading="lazy" decoding="async" />
  );
}
