/** Issue log (Phase 6.1). */

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof PRIORITIES)[number];
export type IssueStatus = "open" | "resolved";

export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Most urgent first. */
export const PRIORITY_RANK: Record<IssuePriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const MAX_ISSUE_PHOTOS = 6;
export const ISSUE_PHOTO_BUCKET = "issue-photos";

export type IssuePhoto = { id: string; path: string; url: string | null; version: number };

export type Issue = {
  id: string;
  sledId: string;
  title: string;
  description: string | null;
  priority: IssuePriority;
  status: IssueStatus;
  reportedOn: string;
  odometer: number | null;
  resolvedOn: string | null;
  resolutionNotes: string | null;
  resolvedEntry: { id: string; title: string; performedOn: string; deleted: boolean } | null;
  createdBy: string | null;
  version: number;
  photos: IssuePhoto[];
};

/** What the viewer may do with an issue (mirrors the database rules; RLS enforces them). */
export type IssueAbilities = { canEdit: boolean; canDelete: boolean };

/** Open issues: most urgent first, then newest. Resolved: most recently resolved first. */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.status === "open") {
      const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (rank) return rank;
      return b.reportedOn.localeCompare(a.reportedOn) || a.title.localeCompare(b.title);
    }
    return (b.resolvedOn ?? "").localeCompare(a.resolvedOn ?? "") || a.title.localeCompare(b.title);
  });
}

/** "2 open issues · 1 critical", or null with none open. */
export function issueSummary(open: Issue[]): string | null {
  if (!open.length) return null;
  const counts = PRIORITIES.map((p) => [p, open.filter((i) => i.priority === p).length] as const).filter(
    ([p, n]) => n > 0 && (p === "critical" || p === "high"),
  );
  const head = `${open.length} open issue${open.length === 1 ? "" : "s"}`;
  return [head, ...counts.map(([p, n]) => `${n} ${PRIORITY_LABEL[p].toLowerCase()}`)].join(" · ");
}

/** An unresolved Critical issue means the sled isn't ready to ride. */
export function hasCriticalIssue(open: Issue[]): boolean {
  return open.some((i) => i.status === "open" && i.priority === "critical");
}
