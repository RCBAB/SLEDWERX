"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth/session";
import { planFrom } from "@/lib/board/validation";
import { taskOptionsForSled } from "@/lib/service/queries";
import { serviceReading } from "@/lib/service/validation";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { sledCapabilities } from "@/lib/sleds/permissions";
import { getSled } from "@/lib/sleds/queries";
import {
  checkbox,
  engineHours,
  futureDateError,
  odometer,
  optionalText,
  pastOrToday,
  sledIdSchema,
  toNumber,
} from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, formValues } from "@/lib/validation/auth";

// Board changes run as the signed-in user: plans are set up by owners and
// editors (database policies), tasks are marked done by owners, editors and
// mechanics (an ordinary service record through save_maintenance_entry).

export type BoardActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string | undefined>;
  ok?: boolean;
  savedAt?: number;
};

const SCHEDULE_FIELDS = [
  "intervalMi",
  "intervalHours",
  "intervalEvery",
  "intervalUnit",
  "seasonal",
  "seasonMonth",
  "seasonDay",
  "paused",
  "baselineOn",
  "baselineMi",
  "baselineHours",
  // Migration 13: what's tracked, the check schedule and both starting points.
  "tracks",
  "replaceAsNeeded",
  "seasonKind",
  "replaceStart",
  "inspectMi",
  "inspectHours",
  "inspectEvery",
  "inspectUnit",
  "inspectSeasonal",
  "inspectSeasonKind",
  "inspectSeasonMonth",
  "inspectSeasonDay",
  "inspectEachReading",
  "inspectStart",
  "inspectBaselineOn",
  "inspectBaselineMi",
  "inspectBaselineHours",
] as const;

async function signedInUser(next: string) {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

function id(formData: FormData, key: string) {
  const parsed = sledIdSchema.safeParse(formData.get(key));
  return parsed.success ? parsed.data : null;
}

function done(): BoardActionState {
  refresh();
  return { ok: true, savedAt: Date.now() };
}

function scheduleFrom(formData: FormData) {
  const raw = formValues(formData, SCHEDULE_FIELDS);
  const parsed = planFrom(raw);
  if (!parsed.success) return { raw, error: { fieldErrors: fieldErrorsOf(parsed.error), values: raw } as BoardActionState };
  for (const key of ["baselineOn", "inspectBaselineOn"] as const) {
    const dateError = futureDateError(raw[key] || undefined, formData.get("timeZone"));
    if (dateError) return { raw, error: { fieldErrors: { [key]: [dateError] }, values: raw } as BoardActionState };
  }
  return { raw, schedule: parsed.data };
}

// ---------------------------------------------------------------------------
// Add a task to the board (an existing task, or a new one), with a schedule
// ---------------------------------------------------------------------------
export async function addToBoard(_prev: BoardActionState, formData: FormData): Promise<BoardActionState> {
  const sledId = id(formData, "sledId");
  const user = await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };
  const sled = await getSled(sledId, user.id);
  if (!sled || !sledCapabilities(sled.role).canManageSledTasks) return { error: "You don't have permission to do that." };

  const { raw, schedule, error } = scheduleFrom(formData);
  if (error) return error;

  const newName = z.string().trim().max(120).safeParse(formData.get("newTaskName") ?? "");
  let taskId = id(formData, "taskId");
  const supabase = await createClient();

  if (!taskId) {
    const name = newName.success ? newName.data : "";
    if (!name) return { fieldErrors: { taskId: ["Choose a task, or type a new one."] }, values: raw };
    // The owner's new tasks go to their library (reusable on all their
    // sleds); an editor's go to this sled only.
    const { data: task, error: taskError } = await supabase
      .from("maintenance_tasks")
      .insert(sled.role === "owner" ? { name } : { sled_id: sledId, name })
      .select("id")
      .single();
    if (taskError || !task) {
      return {
        fieldErrors: { newTaskName: [taskError?.code === "23505" ? "You already have a task with that name. Choose it from the list." : sledErrorMessage(taskError, "task")] },
        values: raw,
      };
    }
    taskId = task.id;
  }

  const { error: planError } = await supabase.from("maintenance_plans").insert({ sled_id: sledId, task_id: taskId, ...schedule });
  if (planError) {
    return { error: planError.code === "23505" ? "That task is already on the board." : sledErrorMessage(planError, "board item"), values: raw };
  }
  return done();
}

// ---------------------------------------------------------------------------
// Change a board item's schedule
// ---------------------------------------------------------------------------
export async function saveSchedule(_prev: BoardActionState, formData: FormData): Promise<BoardActionState> {
  const sledId = id(formData, "sledId");
  await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  const planId = id(formData, "planId");
  const version = Number(formData.get("version"));
  if (!sledId || !planId || !Number.isInteger(version)) return { error: "This board item could not be found." };

  const { schedule, error } = scheduleFrom(formData);
  if (error) return error;

  const supabase = await createClient();
  const { data, error: updateError } = await supabase
    .from("maintenance_plans")
    .update({ ...schedule, version })
    .eq("id", planId)
    .eq("sled_id", sledId)
    .select("id")
    .maybeSingle();
  if (updateError || !data) return { error: sledErrorMessage(updateError ?? { code: "42501" }, "board item") };
  return done();
}

// ---------------------------------------------------------------------------
// Remove a task from the board (soft delete; history is kept)
// ---------------------------------------------------------------------------
export async function removeFromBoard(_prev: BoardActionState, formData: FormData): Promise<BoardActionState> {
  const sledId = id(formData, "sledId");
  await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  const planId = id(formData, "planId");
  const version = Number(formData.get("version"));
  if (!sledId || !planId || !Number.isInteger(version)) return { error: "This board item could not be found." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_plans")
    .update({ deleted_at: new Date().toISOString(), version })
    .eq("id", planId)
    .eq("sled_id", sledId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, "board item") };
  return done();
}

// ---------------------------------------------------------------------------
// Mark Done: one service record for one or more tasks
// ---------------------------------------------------------------------------
const completeSchema = z
  .object({
    title: optionalText(200, "Title"),
    notes: optionalText(10_000, "Notes"),
    performedOn: pastOrToday,
    mileageUnknown: checkbox,
    odometer: z.preprocess(toNumber, odometer.optional()),
    engineHours: z.preprocess(toNumber, engineHours.optional()),
    idempotencyKey: z.uuid({ error: "Reload the page and try again." }),
    tasks: z.preprocess(
      (v) => {
        try {
          return typeof v === "string" ? JSON.parse(v) : v;
        } catch {
          return null;
        }
      },
      z
        .array(z.object({ taskId: z.uuid().optional(), name: z.string().trim().min(1).max(120) }), {
          error: "Choose at least one task.",
        })
        .min(1, { error: "Choose at least one task." })
        .max(100),
    ),
  })
  .superRefine((value, ctx) => {
    if (!value.mileageUnknown && value.odometer === undefined) {
      ctx.addIssue({ code: "custom", path: ["odometer"], message: "Enter the mileage, or choose “Mileage unknown”." });
    }
  });

export async function completeTasks(_prev: BoardActionState, formData: FormData): Promise<BoardActionState> {
  const sledId = id(formData, "sledId");
  const user = await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, ["title", "notes", "performedOn", "mileageUnknown", "odometer", "engineHours", "idempotencyKey", "tasks"] as const);
  const parsed = completeSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.performedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { performedOn: [dateError] }, values: raw };

  const sled = await getSled(sledId, user.id);
  if (!sled) return { error: "Snowmobile not found." };
  // Link each task the sled can use, so the board counts it; others (e.g. a
  // shared user's own package tasks) are saved by name.
  const usable = new Set((await taskOptionsForSled(sled)).map((o) => o.id));
  const tasks = input.tasks.map((t) => (t.taskId && usable.has(t.taskId) ? { task_id: t.taskId, task_name: t.name } : { task_name: t.name }));
  const names = input.tasks.map((t) => t.name);
  const title = input.title || (names.length === 1 ? names[0] : `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`);

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_maintenance_entry", {
    p_idempotency_key: input.idempotencyKey,
    p_sled_id: sledId,
    p_performed_on: input.performedOn,
    p_title: title.slice(0, 200),
    p_reading: serviceReading(input) ?? undefined,
    p_tasks: tasks,
    // The record's own notes field, shown in the service history.
    p_notes: input.notes ?? undefined,
  });
  if (error) {
    const message = sledErrorMessage(error, "service record");
    const field = message.startsWith("Odometer")
      ? { odometer: [message] }
      : message.startsWith("Engine-hour")
        ? { engineHours: [message] }
        : undefined;
    return { error: message, fieldErrors: field, values: raw };
  }
  return done();
}

// ---------------------------------------------------------------------------
// Checked / Quick Check: one Inspection service record for one or more checks
// (save_maintenance_inspection, through save_maintenance_entry: the same
// permissions, readings, idempotency and audit as any service record)
// ---------------------------------------------------------------------------
const checkSchema = z
  .object({
    notes: optionalText(10_000, "Notes"),
    performedOn: pastOrToday,
    mileageUnknown: checkbox,
    odometer: z.preprocess(toNumber, odometer.optional()),
    engineHours: z.preprocess(toNumber, engineHours.optional()),
    idempotencyKey: z.uuid({ error: "Reload the page and try again." }),
    checks: z.preprocess(
      (v) => {
        try {
          return typeof v === "string" ? JSON.parse(v) : v;
        } catch {
          return null;
        }
      },
      z
        .array(
          z.object({
            taskId: z.uuid(),
            outcome: z.enum(["good", "needs_replacement"]),
            note: z.string().trim().max(2_000, { error: "Keep each note under 2,000 characters." }).optional(),
          }),
          { error: "Choose Good or Needs Replacement for at least one item." },
        )
        .min(1, { error: "Choose Good or Needs Replacement for at least one item." })
        .max(100),
    ),
  })
  .superRefine((value, ctx) => {
    if (!value.mileageUnknown && value.odometer === undefined) {
      ctx.addIssue({ code: "custom", path: ["odometer"], message: "Enter the mileage, or choose “Mileage unknown”." });
    }
  });

export async function recordChecks(_prev: BoardActionState, formData: FormData): Promise<BoardActionState> {
  const sledId = id(formData, "sledId");
  await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, ["notes", "performedOn", "mileageUnknown", "odometer", "engineHours", "idempotencyKey", "checks"] as const);
  const parsed = checkSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.performedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { performedOn: [dateError] }, values: raw };

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_maintenance_inspection", {
    p_idempotency_key: input.idempotencyKey,
    p_sled_id: sledId,
    p_performed_on: input.performedOn,
    p_checks: input.checks.map((c) => ({ task_id: c.taskId, outcome: c.outcome, note: c.note || null })),
    p_reading: serviceReading(input) ?? undefined,
    p_notes: input.notes ?? undefined,
  });
  if (error) {
    const message = sledErrorMessage(error, "service record");
    const field = message.startsWith("Odometer")
      ? { odometer: [message] }
      : message.startsWith("Engine-hour")
        ? { engineHours: [message] }
        : undefined;
    return { error: message, fieldErrors: field, values: raw };
  }
  return done();
}
