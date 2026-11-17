import { z } from "zod";

import { SLED_STATUSES } from "./constants";

/** Empty form values become undefined, so optional fields stay optional. */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

function optionalText(max: number, label: string) {
  return z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, { error: `${label} must be ${max} characters or fewer.` }).optional(),
  );
}

function requiredText(max: number, label: string) {
  return z
    .string({ error: `Enter the ${label.toLowerCase()}.` })
    .trim()
    .min(1, { error: `Enter the ${label.toLowerCase()}.` })
    .max(max, { error: `${label} must be ${max} characters or fewer.` });
}

/** Parses "12,345.6" style input. Commas and spaces are ignored. */
function toNumber(value: unknown) {
  const cleaned = blankToUndefined(value);
  if (typeof cleaned !== "string") return cleaned;
  const normalized = cleaned.replace(/[,\s]/g, "");
  return /^-?\d*\.?\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function meterValue(label: string, max: number) {
  return z
    .number({ error: `Enter a number for ${label}.` })
    .refine(Number.isFinite, { error: `Enter a number for ${label}.` })
    .min(0, { error: `${label[0].toUpperCase()}${label.slice(1)} can't be negative.` })
    .lt(max, { error: `That's more ${label} than SledWerx can store.` })
    .transform((n) => Math.round(n * 10) / 10);
}

const odometer = meterValue("miles", 1_000_000);
const engineHours = meterValue("engine hours", 100_000);

/** Latest allowed date: tomorrow in UTC, which covers every time zone's "today". */
export function latestAllowedDate(now = new Date()): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return tomorrow.toISOString().slice(0, 10);
}

const isoDate = z.iso.date({ error: "Enter a valid date." });

const pastOrToday = isoDate.refine((value) => value <= latestAllowedDate(), {
  error: "The date can't be in the future.",
});

const checkbox = z.preprocess((value) => value === "on" || value === "true" || value === true, z.boolean());

function modelYear() {
  const max = new Date().getUTCFullYear() + 2;
  return z.preprocess(
    toNumber,
    z
      .number({ error: "Enter the model year." })
      .int({ error: "Enter a four-digit model year." })
      .min(1950, { error: "Model year must be 1950 or later." })
      .max(max, { error: `Model year must be ${max} or earlier.` }),
  );
}

const sledIdentity = {
  make: requiredText(60, "Manufacturer"),
  model: requiredText(80, "Model"),
  modelYear: modelYear(),
  nickname: optionalText(60, "Nickname"),
  vin: optionalText(32, "VIN or serial number"),
};

/** Add Snowmobile: the sled and its first reading. */
export const createSledSchema = z.object({
  ...sledIdentity,
  odometer: z.preprocess(toNumber, odometer.optional()).refine((value) => value !== undefined, {
    error: "Enter the current odometer reading (0 for a new snowmobile).",
  }),
  engineHours: z.preprocess(toNumber, engineHours.optional()),
  readOn: z.preprocess(blankToUndefined, pastOrToday.optional()),
});

/** Edit details, including the "More details" section. */
export const updateSledSchema = z.object({
  ...sledIdentity,
  status: z.enum(SLED_STATUSES as [string, ...string[]], { error: "Choose a status." }),
  purchaseDate: z.preprocess(blankToUndefined, pastOrToday.optional()),
  engineDescription: optionalText(200, "Engine description"),
  displacementCc: z.preprocess(
    toNumber,
    z
      .number({ error: "Enter the displacement in cc." })
      .int({ error: "Enter the displacement as a whole number of cc." })
      .min(1, { error: "Displacement must be at least 1 cc." })
      .max(3000, { error: "Displacement must be 3000 cc or less." })
      .optional(),
  ),
  notes: optionalText(10_000, "Notes"),
  version: z.preprocess(toNumber, z.number().int().positive()),
  photoPath: z.preprocess(blankToUndefined, z.string().optional()),
  removePhoto: checkbox,
});

const readingFields = {
  odometer: z.preprocess(toNumber, odometer.optional()),
  engineHours: z.preprocess(toNumber, engineHours.optional()),
  readOn: pastOrToday,
  odometerReset: checkbox,
  hourMeterReset: checkbox,
};

type ReadingInput = {
  odometer?: number;
  engineHours?: number;
  odometerReset: boolean;
  hourMeterReset: boolean;
};

function checkReading(value: ReadingInput, ctx: z.RefinementCtx) {
  if (value.odometer === undefined && value.engineHours === undefined) {
    ctx.addIssue({ code: "custom", path: ["odometer"], message: "Enter the odometer, engine hours, or both." });
  }
  if (value.odometerReset && value.odometer === undefined) {
    ctx.addIssue({ code: "custom", path: ["odometer"], message: "Enter the new odometer's reading." });
  }
  if (value.hourMeterReset && value.engineHours === undefined) {
    ctx.addIssue({ code: "custom", path: ["engineHours"], message: "Enter the new hour meter's reading." });
  }
}

/** Update mileage: a new reading. */
export const addReadingSchema = z.object(readingFields).superRefine(checkReading);

/** Fix last reading: correct the most recent reading. */
export const fixReadingSchema = z
  .object({
    ...readingFields,
    readingId: z.uuid({ error: "Reading not found." }),
    version: z.preprocess(toNumber, z.number().int().positive()),
  })
  .superRefine(checkReading);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PHOTO_PATH = new RegExp(`^(${UUID})/${UUID}\\.(jpg|webp)$`);

/** A photo path is valid only inside the sled's own folder (matches the database check). */
export function isValidPhotoPath(sledId: string, path: string): boolean {
  const match = PHOTO_PATH.exec(path);
  return Boolean(match) && match![1] === sledId;
}

export const sledIdSchema = z.uuid();
