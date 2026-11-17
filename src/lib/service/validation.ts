import { z } from "zod";

import {
  blankToUndefined,
  checkbox,
  engineHours,
  odometer,
  optionalText,
  pastOrToday,
  requiredText,
  toNumber,
} from "@/lib/sleds/validation";

import { CATEGORY_VALUES, MAX_ITEMS } from "./constants";

const money = (label: string) =>
  z.preprocess(
    toNumber,
    z
      .number({ error: `Enter an amount for ${label}.` })
      .refine(Number.isFinite, { error: `Enter an amount for ${label}.` })
      .min(0, { error: `${label} can't be negative.` })
      .lt(100_000_000, { error: `${label} is too large.` })
      .transform((n) => Math.round(n * 100) / 100)
      .optional(),
  );

const uuid = z.uuid({ error: "Unknown item." });

/** A task line: from a task list (taskId) or free text (name). */
export const taskItemSchema = z
  .object({
    id: uuid.optional(),
    taskId: uuid.optional(),
    name: z.string().trim().max(120, { error: "Task names must be 120 characters or fewer." }).default(""),
  })
  .refine((t) => t.taskId || t.name.length > 0, { error: "Give each task a name.", path: ["name"] });

export const partItemSchema = z.object({
  id: uuid.optional(),
  name: requiredText(200, "Part name"),
  partNumber: optionalText(120, "Part number"),
  brand: optionalText(120, "Brand"),
  supplier: optionalText(120, "Supplier"),
  quantity: z.preprocess(
    toNumber,
    z
      .number({ error: "Enter a quantity." })
      .refine(Number.isFinite, { error: "Enter a quantity." })
      .gt(0, { error: "Quantity must be more than 0." })
      .lt(100_000_000, { error: "Quantity is too large." })
      .transform((n) => Math.round(n * 100) / 100),
  ),
  unitCost: money("Unit cost"),
});

/** JSON from a hidden form field, parsed into a list. */
function jsonList<T extends z.ZodType>(item: T, label: string) {
  return z.preprocess(
    (value) => {
      if (value == null || value === "") return [];
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    z.array(item, { error: `The ${label} list could not be read.` }).max(MAX_ITEMS, {
      error: `A service can have at most ${MAX_ITEMS} ${label}.`,
    }),
  );
}

const serviceFields = {
  title: requiredText(200, "Title"),
  category: z.preprocess(blankToUndefined, z.enum(CATEGORY_VALUES, { error: "Choose a category." }).optional()),
  performedOn: pastOrToday,
  mileageUnknown: checkbox,
  odometer: z.preprocess(toNumber, odometer.optional()),
  engineHours: z.preprocess(toNumber, engineHours.optional()),
  doneBy: optionalText(120, "Done by"),
  notes: optionalText(10_000, "Notes"),
  laborCost: money("Labor"),
  otherCost: money("Other costs"),
  tasks: jsonList(taskItemSchema, "tasks"),
  parts: jsonList(partItemSchema, "parts"),
};

type MileageFields = { mileageUnknown: boolean; odometer?: number; engineHours?: number };

function checkMileage(value: MileageFields, ctx: z.RefinementCtx) {
  if (!value.mileageUnknown && value.odometer === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["odometer"],
      message: "Enter the mileage, or choose “Mileage unknown”.",
    });
  }
}

export const createServiceSchema = z
  .object({ ...serviceFields, idempotencyKey: z.uuid({ error: "Reload the page and try again." }) })
  .superRefine(checkMileage);

export const updateServiceSchema = z
  .object({ ...serviceFields, version: z.preprocess(toNumber, z.number().int().positive()) })
  .superRefine(checkMileage);

export const quickServiceSchema = createServiceSchema;

export type ServiceInput = z.infer<typeof updateServiceSchema>;

/** The reading sent with a service: none when the mileage is unknown. */
export function serviceReading(input: MileageFields) {
  if (input.mileageUnknown) return null;
  return { odometer_mi: input.odometer ?? null, engine_hours: input.engineHours ?? null };
}

const libraryName = requiredText(120, "Name");
export const taskNameSchema = z.object({ name: libraryName });
export const packageNameSchema = z.object({ name: libraryName });
