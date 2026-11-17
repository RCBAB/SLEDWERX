import { describe, expect, it } from "vitest";

import { fieldErrorsOf } from "@/lib/validation/auth";

import {
  addReadingSchema,
  createSledSchema,
  fixReadingSchema,
  isValidPhotoPath,
  latestAllowedDate,
  updateSledSchema,
} from "./validation";

const SLED = "6aaaaaaa-0000-4000-8000-000000000001";
const FILE = "0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00";

describe("createSledSchema", () => {
  const valid = { make: " Polaris ", model: "RMK Khaos", modelYear: "2024", odometer: "1,234.56" };

  it("accepts a minimal sled and normalizes values", () => {
    const sled = createSledSchema.parse(valid);
    expect(sled).toMatchObject({ make: "Polaris", model: "RMK Khaos", modelYear: 2024, odometer: 1234.6 });
    expect(sled.nickname).toBeUndefined();
    expect(sled.engineHours).toBeUndefined();
  });

  it("allows 0 miles for a new sled", () => {
    expect(createSledSchema.parse({ ...valid, odometer: "0" }).odometer).toBe(0);
  });

  it("requires the odometer", () => {
    const result = createSledSchema.safeParse({ ...valid, odometer: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error).odometer?.[0]).toMatch(/current odometer/);
  });

  it.each([
    ["negative miles", { odometer: "-1" }, "odometer"],
    ["text miles", { odometer: "lots" }, "odometer"],
    ["too many miles", { odometer: "1000000" }, "odometer"],
    ["negative hours", { engineHours: "-3" }, "engineHours"],
    ["old model year", { modelYear: "1949" }, "modelYear"],
    ["far-future model year", { modelYear: String(new Date().getUTCFullYear() + 3) }, "modelYear"],
    ["blank make", { make: "  " }, "make"],
    ["long VIN", { vin: "X".repeat(33) }, "vin"],
    ["future reading date", { readOn: "2999-01-01" }, "readOn"],
  ])("rejects %s", (_label, change, field) => {
    const result = createSledSchema.safeParse({ ...valid, ...change });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error)[field as keyof typeof valid]).toBeDefined();
  });
});

describe("updateSledSchema", () => {
  const valid = {
    make: "Ski-Doo",
    model: "Summit",
    modelYear: "2021",
    status: "stored",
    version: "3",
    displacementCc: "850",
    purchaseDate: "",
    notes: "",
  };

  it("accepts details and optional extras", () => {
    const sled = updateSledSchema.parse(valid);
    expect(sled).toMatchObject({ status: "stored", version: 3, displacementCc: 850, removePhoto: false });
    expect(sled.purchaseDate).toBeUndefined();
  });

  it("rejects an unknown status and bad displacement", () => {
    expect(updateSledSchema.safeParse({ ...valid, status: "sold" }).success).toBe(false);
    expect(updateSledSchema.safeParse({ ...valid, displacementCc: "850.5" }).success).toBe(false);
    expect(updateSledSchema.safeParse({ ...valid, displacementCc: "4000" }).success).toBe(false);
  });
});

describe("reading schemas", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("needs the odometer, engine hours or both", () => {
    expect(addReadingSchema.safeParse({ readOn: today }).success).toBe(false);
    expect(addReadingSchema.parse({ readOn: today, engineHours: "12.25" }).engineHours).toBe(12.3);
    expect(addReadingSchema.parse({ readOn: today, odometer: "2000", odometerReset: "on" }).odometerReset).toBe(true);
  });

  it("requires a value for a replaced meter", () => {
    const result = addReadingSchema.safeParse({ readOn: today, engineHours: "5", odometerReset: "on" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error).odometer?.[0]).toMatch(/new odometer/);
  });

  it("requires the reading and version when fixing", () => {
    expect(fixReadingSchema.safeParse({ readOn: today, odometer: "10", version: "1" }).success).toBe(false);
    expect(
      fixReadingSchema.safeParse({ readOn: today, odometer: "10", version: "1", readingId: FILE }).success,
    ).toBe(true);
  });

  it("allows tomorrow (UTC) for time zones ahead, but no later", () => {
    const now = new Date("2026-11-17T23:30:00Z");
    expect(latestAllowedDate(now)).toBe("2026-11-18");
  });
});

describe("isValidPhotoPath", () => {
  it("accepts a photo in the sled's own folder", () => {
    expect(isValidPhotoPath(SLED, `${SLED}/${FILE}.jpg`)).toBe(true);
    expect(isValidPhotoPath(SLED, `${SLED}/${FILE}.webp`)).toBe(true);
  });

  it.each([
    ["another sled's folder", `6aaaaaaa-0000-4000-8000-000000000002/${FILE}.jpg`],
    ["path traversal", `${SLED}/../${FILE}.jpg`],
    ["other file types", `${SLED}/${FILE}.png`],
    ["URLs", `https://evil.example/${SLED}/${FILE}.jpg`],
    ["nested folders", `${SLED}/x/${FILE}.jpg`],
  ])("rejects %s", (_label, path) => {
    expect(isValidPhotoPath(SLED, path)).toBe(false);
  });
});
