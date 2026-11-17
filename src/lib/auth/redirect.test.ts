import { describe, expect, it } from "vitest";

import { safeNextPath } from "./redirect";

describe("safeNextPath", () => {
  it("keeps in-app paths, including query and hash", () => {
    expect(safeNextPath("/garage")).toBe("/garage");
    expect(safeNextPath("/garage/abc?tab=log#top")).toBe("/garage/abc?tab=log#top");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["absolute URL", "https://evil.example/garage"],
    ["protocol-relative", "//evil.example"],
    ["backslash trick", "/\\evil.example"],
    ["relative path", "garage"],
    ["javascript URL", "javascript:alert(1)"],
    ["control characters", "/garage\n/evil"],
    ["tab inside scheme", "/\t/evil.example"],
    ["not a string", 42],
  ])("falls back for %s", (_label, value) => {
    expect(safeNextPath(value)).toBe("/garage");
  });

  it("uses the given fallback", () => {
    expect(safeNextPath("//evil.example", "/login")).toBe("/login");
  });
});
