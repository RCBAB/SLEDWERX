export function SuspensionSkeleton() {
  return (
    <div aria-hidden className="mt-4 space-y-6">
      <div className="h-10 w-2/3 animate-pulse rounded bg-white/5" />
      <div className="h-12 w-full animate-pulse rounded-xl bg-white/5" />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="aspect-[16/9] animate-pulse rounded-2xl bg-white/5" />
        <div className="h-72 animate-pulse rounded-2xl bg-white/5" />
      </div>
    </div>
  );
}
