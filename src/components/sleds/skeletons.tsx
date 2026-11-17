export function FormSkeleton() {
  return (
    <div aria-hidden className="space-y-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
      ))}
    </div>
  );
}

export function SledSkeleton() {
  return (
    <div aria-hidden className="mt-4 space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="aspect-[16/10] animate-pulse rounded-2xl bg-white/5" />
        <div className="space-y-3">
          <div className="h-10 w-3/4 animate-pulse rounded bg-white/5" />
          <div className="h-5 w-1/2 animate-pulse rounded bg-white/5" />
          <div className="grid grid-cols-2 gap-4 pt-4">
            <div className="h-28 animate-pulse rounded-2xl bg-white/5" />
            <div className="h-28 animate-pulse rounded-2xl bg-white/5" />
          </div>
        </div>
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-white/5" />
    </div>
  );
}
