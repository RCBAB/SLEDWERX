import { describe, expect, it } from "vitest";

import { hasCriticalIssue, issueSummary, sortIssues, type Issue } from "./types";
import { issueSchema, resolveSchema } from "./validation";

const base: Issue = {
  id: "i",
  sledId: "s",
  title: "Track squeak",
  description: null,
  priority: "medium",
  status: "open",
  reportedOn: "2026-11-10",
  odometer: 2000,
  resolvedOn: null,
  resolutionNotes: null,
  resolvedEntry: null,
  createdBy: "u",
  version: 1,
  photos: [],
};
const issue = (change: Partial<Issue>): Issue => ({ ...base, ...change });

describe("issue order", () => {
  it("puts open issues first, most urgent then newest; resolved by most recently resolved", () => {
    const sorted = sortIssues([
      issue({ id: "low", priority: "low" }),
      issue({ id: "done-old", status: "resolved", resolvedOn: "2026-11-01" }),
      issue({ id: "crit", priority: "critical", reportedOn: "2026-11-01" }),
      issue({ id: "high-new", priority: "high", reportedOn: "2026-11-12" }),
      issue({ id: "high-old", priority: "high", reportedOn: "2026-11-02" }),
      issue({ id: "done-new", status: "resolved", resolvedOn: "2026-11-15" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["crit", "high-new", "high-old", "low", "done-new", "done-old"]);
  });
});

describe("Garage Board summary and ready-to-ride", () => {
  it("counts open issues and calls out critical and high", () => {
    expect(issueSummary([])).toBeNull();
    expect(issueSummary([issue({})])).toBe("1 open issue");
    expect(issueSummary([issue({ priority: "critical" }), issue({ priority: "high" }), issue({ priority: "high" }), issue({})])).toBe(
      "4 open issues · 1 critical · 2 high",
    );
  });

  it("an unresolved critical issue means not ready to ride", () => {
    expect(hasCriticalIssue([issue({ priority: "high" })])).toBe(false);
    expect(hasCriticalIssue([issue({ priority: "critical" })])).toBe(true);
    expect(hasCriticalIssue([issue({ priority: "critical", status: "resolved" })])).toBe(false);
  });
});

describe("report / edit validation", () => {
  const ok = { title: " Track squeak ", priority: "high", reportedOn: "2026-11-10", odometer: "2,000.46", description: "" };
  it("accepts a normal issue and tidies it", () => {
    expect(issueSchema.parse(ok)).toEqual({ title: "Track squeak", priority: "high", reportedOn: "2026-11-10", odometer: 2000.5 });
  });
  it("needs a title and a known priority; mileage is optional but not negative", () => {
    expect(issueSchema.safeParse({ ...ok, title: "  " }).success).toBe(false);
    expect(issueSchema.safeParse({ ...ok, priority: "urgent" }).success).toBe(false);
    expect(issueSchema.safeParse({ ...ok, odometer: "" }).data?.odometer).toBeUndefined();
    expect(issueSchema.safeParse({ ...ok, odometer: "-5" }).success).toBe(false);
    expect(issueSchema.safeParse({ ...ok, reportedOn: "2999-01-01" }).success).toBe(false);
  });
});

describe("resolve validation", () => {
  it("manual needs only a date; linking needs a service record", () => {
    expect(resolveSchema.safeParse({ how: "manual", resolvedOn: "2026-11-10", notes: "" }).success).toBe(true);
    const missing = resolveSchema.safeParse({ how: "service", resolvedOn: "2026-11-10" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0].message).toBe("Choose the service record that fixed it.");
    expect(
      resolveSchema.safeParse({ how: "service", resolvedOn: "2026-11-10", entryId: "11111111-1111-4111-8111-111111111111" }).success,
    ).toBe(true);
  });
});
