import { SearchX } from "lucide-react";

import { ButtonLink } from "@/components/ui/button";

export default function SledNotFound() {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center rounded-2xl border border-white/10 bg-surface/60 px-6 py-12 text-center">
      <SearchX aria-hidden className="size-10 text-muted" />
      <h1 className="mt-4 font-display text-3xl font-bold uppercase">Snowmobile not found</h1>
      <p className="mt-2 text-muted">It may have been removed, or it isn&apos;t shared with you.</p>
      <ButtonLink href="/garage" className="mt-6">
        Back to My Snowmobiles
      </ButtonLink>
    </div>
  );
}
