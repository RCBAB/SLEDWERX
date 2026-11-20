import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CleanupDashboard } from "@/components/admin/cleanup-dashboard";
import { Alert } from "@/components/ui/alert";
import { getCleanupDashboard } from "@/lib/admin/queries";
import { requireUser } from "@/lib/auth/session";
import { readCleanupConfig, readCronSecret } from "@/lib/cleanup/config";

export const metadata: Metadata = { title: "Cleanup monitoring", robots: { index: false, follow: false } };

/**
 * Read-only cleanup monitoring for SledWerx application administrators.
 * Everyone else (owners, editors, mechanics, viewers) gets "not found":
 * the database function refuses them and nothing is loaded.
 */
export default function CleanupMonitoringPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">Cleanup monitoring</h1>
      <p className="mt-2 max-w-3xl text-muted">
        Recently Deleted and photo cleanup across SledWerx. Read-only: nothing here changes data, switches or limits.
      </p>
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </div>
  );
}

async function Dashboard() {
  await requireUser("/admin/cleanup");
  const result = await getCleanupDashboard();
  if (result.status === "forbidden") notFound();
  if (result.status === "error") {
    return (
      <div className="mt-6 max-w-xl">
        <Alert tone="error">The cleanup status could not be loaded. Try again later.</Alert>
      </div>
    );
  }

  // Server environment, as booleans only (never values).
  const config = readCleanupConfig(process.env);
  const server = {
    requestsDelete: config.ok && config.config.requestedMode === "delete",
    jobConfigured: config.ok && readCronSecret(process.env) !== null,
  };
  return (
    <div className="mt-6">
      <CleanupDashboard data={result.data} server={server} />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-xl bg-white/5" />
      ))}
    </div>
  );
}
