import { STATUS_LABELS, type SledStatus } from "./constants";

/**
 * The status shown on a sled's badge. The stored status (sleds.status) is the
 * owner's own choice and is never changed here. An open Critical issue only
 * overrides "Ready", which it contradicts, and shows "Not ready" instead; as
 * soon as no open Critical issue is left, the stored status shows again.
 * "Needs attention", "Out of service" and "Stored" are always shown as set.
 * Used by every badge (Garage Board, sled page, My Snowmobiles).
 */
export type DisplayedSledStatus = SledStatus | "not_ready";

export function displayedSledStatus(status: SledStatus, hasOpenCriticalIssue: boolean): DisplayedSledStatus {
  return status === "ready" && hasOpenCriticalIssue ? "not_ready" : status;
}

export const DISPLAYED_STATUS_LABELS: Record<DisplayedSledStatus, string> = {
  ...STATUS_LABELS,
  not_ready: "Not ready",
};
