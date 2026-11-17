type SledName = { nickname?: string | null; make: string; model: string; model_year?: number };

/** The name shown for a sled: its nickname, or make and model. */
export function sledName(sled: SledName): string {
  return sled.nickname?.trim() || `${sled.make} ${sled.model}`;
}

/** "2024 Polaris RMK Khaos" */
export function sledDescription(sled: Required<Pick<SledName, "make" | "model" | "model_year">>): string {
  return `${sled.model_year} ${sled.make} ${sled.model}`;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatMiles(value: number | null | undefined): string {
  return value == null ? "—" : `${numberFormat.format(value)} mi`;
}

export function formatHours(value: number | null | undefined): string {
  return value == null ? "—" : `${numberFormat.format(value)} hrs`;
}

/** Formats a date-only value (YYYY-MM-DD) without shifting it across time zones. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Today's date (YYYY-MM-DD) in the given time zone, or the runtime's local zone. */
export function isoDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
