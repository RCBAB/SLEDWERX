import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { suspensionPhotoUploadsEnabled } from "./photo-flag";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("suspension photo-upload feature flag", () => {
  it("is off when unset", () => {
    vi.stubEnv("SUSPENSION_PHOTO_UPLOADS", undefined);
    expect(suspensionPhotoUploadsEnabled()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    vi.stubEnv("SUSPENSION_PHOTO_UPLOADS", "on");
    expect(suspensionPhotoUploadsEnabled()).toBe(true);
    for (const value of ["", "off", "ON", "true", "1", "yes", " on"]) {
      vi.stubEnv("SUSPENSION_PHOTO_UPLOADS", value);
      expect(suspensionPhotoUploadsEnabled()).toBe(false);
    }
  });
});
