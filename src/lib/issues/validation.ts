import { z } from "zod";

import { blankToUndefined, optionalText, pastOrToday, requiredText, toNumber } from "@/lib/sleds/validation";

import { PRIORITIES } from "./types";

/** Report or edit an issue. */
export const issueSchema = z.object({
  title: requiredText(200, "Title"),
  description: optionalText(10_000, "Description"),
  priority: z.enum(PRIORITIES, { error: "Choose a priority." }),
  reportedOn: pastOrToday,
  odometer: z.preprocess(
    toNumber,
    z
      .number({ error: "Enter the mileage as a number." })
      .refine(Number.isFinite, { error: "Enter the mileage as a number." })
      .min(0, { error: "Mileage can't be negative." })
      .lt(1_000_000, { error: "That's more miles than SledWerx can store." })
      .transform((n) => Math.round(n * 10) / 10)
      .optional(),
  ),
});

/** Resolve: manually (notes optional) or by linking a completed service on the same sled. */
export const resolveSchema = z
  .object({
    how: z.enum(["manual", "service"], { error: "Choose how it was resolved." }),
    resolvedOn: pastOrToday,
    notes: optionalText(10_000, "Notes"),
    entryId: z.preprocess(blankToUndefined, z.uuid({ error: "Choose a service record." }).optional()),
  })
  .superRefine((value, ctx) => {
    if (value.how === "service" && !value.entryId) {
      ctx.addIssue({ code: "custom", path: ["entryId"], message: "Choose the service record that fixed it." });
    }
  });
