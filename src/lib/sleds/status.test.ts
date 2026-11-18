import { describe, expect, it } from "vitest";

import { SLED_STATUSES } from "./constants";
import { DISPLAYED_STATUS_LABELS, displayedSledStatus } from "./status";

describe("the status badge", () => {
  it("shows Not ready instead of Ready while a Critical issue is open", () => {
    expect(displayedSledStatus("ready", true)).toBe("not_ready");
    expect(DISPLAYED_STATUS_LABELS.not_ready).toBe("Not ready");
  });

  it("shows the stored status again once no Critical issue is open", () => {
    expect(displayedSledStatus("ready", false)).toBe("ready");
    expect(DISPLAYED_STATUS_LABELS.ready).toBe("Ready");
  });

  it("never overrides Needs attention, Out of service or Stored", () => {
    for (const status of ["needs_attention", "out_of_service", "stored"] as const) {
      expect(displayedSledStatus(status, true)).toBe(status);
      expect(displayedSledStatus(status, false)).toBe(status);
    }
  });

  it("covers every stored status", () => {
    for (const status of SLED_STATUSES) expect(DISPLAYED_STATUS_LABELS[status]).toBeTruthy();
  });
});
