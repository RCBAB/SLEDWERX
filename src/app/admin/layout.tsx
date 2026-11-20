import type { ReactNode } from "react";
import { Suspense } from "react";

import { AccountMenu } from "@/components/app/account-menu";
import { Logo } from "@/components/ui/logo";

/** SledWerx administration (system-wide; not part of any garage). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-white/10 bg-background/90 px-4 backdrop-blur sm:px-6 lg:px-10">
        <div className="flex items-center gap-3">
          <Logo href="/garage" />
          <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted">Admin</span>
        </div>
        <Suspense fallback={<div className="h-9 w-24 animate-pulse rounded-lg bg-white/5" />}>
          <AccountMenu />
        </Suspense>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-10">{children}</main>
    </div>
  );
}
