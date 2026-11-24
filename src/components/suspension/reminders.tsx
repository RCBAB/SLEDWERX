import { Camera, Ruler } from "lucide-react";
import Link from "next/link";

import { reminderCounts, type SettingReminder } from "@/lib/suspension/turns";

/** "Measurement Needed" / "Photo Needed" (Migration 12). */
export function ReminderChip({ kind }: { kind: "measurement" | "photo" }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-100 ring-1 ring-amber-300/30"
      data-testid={kind === "measurement" ? "measurement-needed" : "photo-needed"}
    >
      {kind === "measurement" ? <Ruler aria-hidden className="size-3.5" /> : <Camera aria-hidden className="size-3.5" />}
      {kind === "measurement" ? "Measurement Needed" : "Photo Needed"}
    </span>
  );
}

/**
 * The active Trail's outstanding reminders, one line per setting (Suspension
 * page and snowmobile page). Nothing when none are outstanding.
 */
export function ReminderList({ reminders, href, configName }: { reminders: SettingReminder[]; href?: string; configName?: string }) {
  if (!reminders.length) return null;
  return (
    <div className="rounded-xl border border-amber-300/30 bg-amber-400/[0.06] px-4 py-3" data-testid="suspension-reminders">
      <p className="text-sm font-semibold text-amber-100">
        {reminderCounts(reminders)}
        {configName ? <span className="font-normal text-muted"> · {configName}</span> : null}
      </p>
      <ul className="mt-2 space-y-1.5">
        {reminders.map((r) => (
          <li key={r.settingId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="suspension-reminder">
            <span className="font-medium">{r.name}</span>
            {r.measurementNeeded ? <ReminderChip kind="measurement" /> : null}
            {r.photoNeeded ? <ReminderChip kind="photo" /> : null}
          </li>
        ))}
      </ul>
      {href ? (
        <Link
          href={href}
          className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent-hot underline-offset-4 hover:underline"
        >
          Record in Quick Tune
        </Link>
      ) : null}
    </div>
  );
}

/** Garage Board / Wall Display: counts only, so the card doesn't grow; opens the Suspension page. */
export function ReminderCounts({ reminders, href, sledName }: { reminders: SettingReminder[]; href: string; sledName: string }) {
  if (!reminders.length) return null;
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-amber-100 hover:bg-white/5"
      aria-label={`Suspension reminders on ${sledName}: ${reminderCounts(reminders)}. Open the Suspension page.`}
      data-testid="suspension-reminder-counts"
    >
      <Ruler aria-hidden className="size-4" />
      {reminderCounts(reminders)}
    </Link>
  );
}
