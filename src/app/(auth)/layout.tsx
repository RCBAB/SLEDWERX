import type { ReactNode } from "react";

import { Logo } from "@/components/ui/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex flex-1 flex-col items-center overflow-hidden px-4 py-10 sm:justify-center sm:py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px]"
      />
      <div aria-hidden className="absolute inset-x-0 top-0 flex h-1.5">
        <span className="flex-1 bg-accent" />
        <span className="w-24 bg-accent-hot" />
        <span className="w-12 bg-foreground" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="text-4xl" />
        </div>
        <div className="rounded-2xl border border-white/10 bg-surface/90 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
          {children}
        </div>
      </div>
    </main>
  );
}
