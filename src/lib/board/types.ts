export type BoardStatus = "overdue" | "upcoming" | "no_record" | "mileage_unknown" | "good" | "unscheduled" | "paused";

/** One row of the maintenance_board view (Migration 5). Mileage is lifetime miles. */
export type BoardRow = {
  planId: string;
  taskId: string;
  taskName: string;
  intervalMi: number | null;
  intervalHours: number | null;
  intervalDays: number | null;
  seasonMonth: number | null;
  seasonDay: number | null;
  paused: boolean;
  baselineOn: string | null;
  baselineMi: number | null;
  baselineHours: number | null;
  version: number;
  lastDoneSource: "service" | "baseline" | null;
  lastDoneEntryId: string | null;
  lastDoneOn: string | null;
  lastDoneMi: number | null;
  lastDoneHours: number | null;
  mileageUnknown: boolean;
  hoursUnknown: boolean;
  dueOn: string | null;
  remainingMi: number | null;
  remainingHours: number | null;
  remainingDays: number | null;
  status: BoardStatus;
  /** Inspection & replacement tracking (Migration 13); null before it is applied. */
  tracking: BoardTracking | null;
};

/** What a maintenance item tracks (Migration 13). Existing items track replacement only. */
export type TrackingMode = "replacement" | "inspection" | "both";
export type InspectStatus = "overdue" | "due" | "initial_check" | "upcoming" | "mileage_unknown" | "good" | "unscheduled" | "paused";
export type SeasonKind = "season" | "preseason" | "postseason";

/** Both schedules of one item, as the board calculates them (Migration 13). */
export type BoardTracking = {
  tracks: TrackingMode;
  replaceAsNeeded: boolean;
  seasonKind: SeasonKind | null;
  replaceBaselineKind: "known" | "tracking" | null;
  /** The replacement schedule's status (null for inspection only items). */
  replaceStatus: BoardStatus | "as_needed" | null;
  inspect: {
    intervalMi: number | null;
    intervalHours: number | null;
    intervalDays: number | null;
    seasonMonth: number | null;
    seasonDay: number | null;
    seasonKind: SeasonKind | null;
    eachReading: boolean;
    baselineOn: string | null;
    baselineMi: number | null;
    baselineHours: number | null;
    baselineKind: "known" | "tracking" | null;
  };
  /** null for replacement only items. */
  inspectStatus: InspectStatus | null;
  lastCheckedSource: "check" | "replacement" | "service" | "baseline" | "tracking" | null;
  lastCheckedOn: string | null;
  lastCheckedMi: number | null;
  lastCheckedHours: number | null;
  lastCheckOutcome: "good" | "needs_replacement" | null;
  needsReplacement: boolean;
  inspectDueOn: string | null;
  inspectDueMi: number | null;
  inspectRemainingMi: number | null;
  inspectRemainingHours: number | null;
  inspectRemainingDays: number | null;
  inspectDueOnReading: boolean;
  /** Board order: Needs Replacement first (-1), then the more urgent schedule. */
  itemRank: number | null;
  /** Miles on the component since the last replacement, or since tracking began. */
  componentMi: number | null;
  componentSince: "replacement" | "tracking" | null;
};
