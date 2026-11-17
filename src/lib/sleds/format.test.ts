import { describe, expect, it } from "vitest";

import { formatDate, formatHours, formatMiles, isoDate, sledDescription, sledName } from "./format";
import { canFixReading, sledCapabilities } from "./permissions";
import { sledErrorMessage } from "./errors";

describe("sled names and numbers", () => {
  it("uses the nickname when there is one", () => {
    expect(sledName({ nickname: "Blue", make: "Polaris", model: "RMK" })).toBe("Blue");
    expect(sledName({ nickname: " ", make: "Polaris", model: "RMK" })).toBe("Polaris RMK");
    expect(sledDescription({ model_year: 2024, make: "Polaris", model: "RMK" })).toBe("2024 Polaris RMK");
  });

  it("formats miles, hours and dates", () => {
    expect(formatMiles(12345.6)).toBe("12,345.6 mi");
    expect(formatMiles(0)).toBe("0 mi");
    expect(formatMiles(null)).toBe("—");
    expect(formatHours(51.2)).toBe("51.2 hrs");
    expect(formatDate("2026-01-05")).toBe("Jan 5, 2026");
    expect(isoDate(new Date("2026-11-18T03:00:00Z"), "America/Denver")).toBe("2026-11-17");
  });
});

describe("sled capabilities", () => {
  it("follows the sharing roles", () => {
    expect(sledCapabilities("owner")).toEqual({ canEdit: true, canChangePhoto: true, canAddReading: true, canRemoveReading: true });
    expect(sledCapabilities("editor").canEdit).toBe(true);
    expect(sledCapabilities("mechanic")).toEqual({ canEdit: false, canChangePhoto: false, canAddReading: true, canRemoveReading: false });
    expect(sledCapabilities("viewer")).toEqual({ canEdit: false, canChangePhoto: false, canAddReading: false, canRemoveReading: false });
  });

  it("lets mechanics fix only their own readings", () => {
    expect(canFixReading("mechanic", "me", "me")).toBe(true);
    expect(canFixReading("mechanic", "someone", "me")).toBe(false);
    expect(canFixReading("viewer", "me", "me")).toBe(false);
    expect(canFixReading("editor", "someone", "me")).toBe(true);
  });
});

describe("sledErrorMessage", () => {
  it("shows the database's own friendly messages", () => {
    const message = "Odometer readings cannot go down. If the odometer was replaced or reset, mark the reading as an odometer reset.";
    expect(sledErrorMessage({ code: "23514", message })).toBe(message);
  });

  it("maps codes and never echoes raw errors", () => {
    expect(sledErrorMessage({ code: "PT409" })).toMatch(/changed somewhere else/);
    expect(sledErrorMessage({ code: "42501", message: "new row violates row-level security policy" })).toBe(
      "You don't have permission to do that.",
    );
    expect(sledErrorMessage({ code: "XX000", message: "internal detail" })).toBe("Something went wrong. Please try again.");
  });
});
