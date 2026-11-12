export default function Home() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      {/* Background: carbon grid + accent glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[780px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]"
      />

      {/* Racing stripes */}
      <div aria-hidden className="absolute inset-x-0 top-0 flex h-1.5">
        <span className="flex-1 bg-accent" />
        <span className="w-24 bg-accent-hot" />
        <span className="w-12 bg-foreground" />
      </div>

      <section className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-24 sm:px-10">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-muted">
          <span className="mr-3 inline-block h-2 w-2 -skew-x-12 bg-accent align-middle" />
          Garage &amp; Maintenance
        </p>

        <h1 className="mt-6 font-display text-7xl font-extrabold uppercase italic leading-none tracking-tight sm:text-8xl md:text-9xl">
          Sled<span className="text-accent">Werx</span>
        </h1>

        <div aria-hidden className="mt-6 flex gap-2">
          <span className="h-2 w-28 -skew-x-[30deg] bg-accent" />
          <span className="h-2 w-12 -skew-x-[30deg] bg-accent-hot" />
          <span className="h-2 w-6 -skew-x-[30deg] bg-foreground" />
        </div>

        <p className="mt-8 font-display text-2xl font-semibold uppercase tracking-[0.2em] text-foreground/80 sm:text-3xl">
          Your Snowmobile Garage.
        </p>
      </section>

      <footer className="relative border-t border-white/5 py-6">
        <p className="mx-auto max-w-5xl px-6 font-mono text-xs uppercase tracking-[0.3em] text-muted sm:px-10">
          Coming soon
        </p>
      </footer>
    </main>
  );
}
