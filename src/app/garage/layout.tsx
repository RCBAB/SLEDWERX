import type { ReactNode } from "react";
import { Suspense } from "react";

import { AccountMenu } from "@/components/app/account-menu";
import { BottomNav, SideNav } from "@/components/app/nav";
import { Logo } from "@/components/ui/logo";

export default function GarageLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-white/10 bg-surface/60 px-4 py-6 lg:flex">
        <Logo href="/garage" className="px-3" />
        <div className="mt-8">
          <SideNav />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-white/10 bg-background/90 px-4 backdrop-blur sm:px-6 lg:px-10">
          <Logo href="/garage" className="lg:invisible" />
          <Suspense fallback={<div className="h-9 w-24 animate-pulse rounded-lg bg-white/5" />}>
            <AccountMenu />
          </Suspense>
        </header>
        <main className="flex-1 px-4 py-6 pb-28 sm:px-6 lg:px-10 lg:pb-10">{children}</main>
      </div>

      <BottomNav />
    </div>
  );
}
