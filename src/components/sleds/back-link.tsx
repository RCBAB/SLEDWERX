import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-foreground"
    >
      <ChevronLeft aria-hidden className="size-4" />
      {children}
    </Link>
  );
}
