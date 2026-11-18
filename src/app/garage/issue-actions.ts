"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth/session";
import { resolvableServices, type ServiceOption } from "@/lib/issues/queries";
import { MAX_ISSUE_PHOTOS } from "@/lib/issues/types";
import { issueSchema, resolveSchema } from "@/lib/issues/validation";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { futureDateError, sledIdSchema } from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, formValues } from "@/lib/validation/auth";

// Issue changes run as the signed-in user through Row Level Security and the
// database triggers (Migration 6): who may report, edit, resolve, delete and
// add photos is decided there. These checks only give friendlier messages.

export type IssueActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string | undefined>;
  ok?: boolean;
  issueId?: string;
  savedAt?: number;
};

const uuid = z.uuid();
const PHOTO_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|webp)$/;

async function signedInUser(next = "/garage") {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

function idFrom(formData: FormData, key: string) {
  const parsed = uuid.safeParse(formData.get(key));
  return parsed.success ? parsed.data : null;
}

function versionFrom(formData: FormData) {
  const version = Number(formData.get("version"));
  return Number.isInteger(version) && version > 0 ? version : null;
}

/** Database messages next to the field they concern. */
function issueFieldErrors(message: string): IssueActionState["fieldErrors"] {
  if (message.startsWith("The issue date")) return { reportedOn: [message] };
  if (message.startsWith("The resolved date")) return { resolvedOn: [message] };
  if (message.startsWith("That service record") || message.startsWith("Only a completed service")) return { entryId: [message] };
  return undefined;
}

function done(issueId?: string): IssueActionState {
  refresh();
  return { ok: true, issueId, savedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Report / edit
// ---------------------------------------------------------------------------
export async function saveIssue(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  const sledId = sledIdSchema.safeParse(formData.get("sledId"));
  await signedInUser(sledId.success ? `/garage/${sledId.data}` : "/garage");
  if (!sledId.success) return { error: "Snowmobile not found." };

  const raw = formValues(formData, ["title", "description", "priority", "reportedOn", "odometer"] as const);
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.reportedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { reportedOn: [dateError] }, values: raw };

  const fields = {
    title: input.title,
    description: input.description ?? null,
    priority: input.priority,
    reported_on: input.reportedOn,
    odometer_mi: input.odometer ?? null,
  };
  const supabase = await createClient();
  const issueId = idFrom(formData, "issueId");
  if (!issueId) {
    const { data, error } = await supabase
      .from("sled_issues")
      .insert({ sled_id: sledId.data, ...fields })
      .select("id")
      .single();
    if (error || !data) {
      const message = sledErrorMessage(error, "issue");
      return { error: message, fieldErrors: issueFieldErrors(message), values: raw };
    }
    return done(data.id);
  }

  const version = versionFrom(formData);
  if (!version) return { error: "Reload the page and try again.", values: raw };
  const { data, error } = await supabase
    .from("sled_issues")
    .update({ ...fields, version })
    .eq("id", issueId)
    .eq("sled_id", sledId.data)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const message = sledErrorMessage(error ?? { code: "42501" }, "issue");
    return { error: message, fieldErrors: issueFieldErrors(message), values: raw };
  }
  return done(issueId);
}

// ---------------------------------------------------------------------------
// Resolve / reopen / delete
// ---------------------------------------------------------------------------
export async function resolveIssue(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  await signedInUser();
  const issueId = idFrom(formData, "issueId");
  const version = versionFrom(formData);
  if (!issueId || !version) return { error: "Issue not found." };

  const raw = formValues(formData, ["how", "resolvedOn", "notes", "entryId"] as const);
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.resolvedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { resolvedOn: [dateError] }, values: raw };

  const supabase = await createClient();
  const { data: issue } = await supabase.from("sled_issues").select("reported_on").eq("id", issueId).maybeSingle();
  if (!issue) return { error: "Issue not found." };
  if (input.resolvedOn < issue.reported_on) {
    return { fieldErrors: { resolvedOn: ["The resolved date can't be before the issue was reported."] }, values: raw };
  }

  const { data, error } = await supabase
    .from("sled_issues")
    .update({
      status: "resolved",
      resolved_on: input.resolvedOn,
      resolution_notes: input.notes ?? null,
      resolved_entry_id: input.how === "service" ? input.entryId! : null,
      version,
    })
    .eq("id", issueId)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const message = sledErrorMessage(error ?? { code: "42501" }, "issue");
    return { error: message, fieldErrors: issueFieldErrors(message), values: raw };
  }
  return done(issueId);
}

export async function reopenIssue(issueId: string, version: number): Promise<IssueActionState> {
  await signedInUser();
  if (!uuid.safeParse(issueId).success || !Number.isInteger(version)) return { error: "Issue not found." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sled_issues")
    .update({ status: "open", resolved_on: null, resolution_notes: null, resolved_entry_id: null, version })
    .eq("id", issueId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, "issue") };
  return done(issueId);
}

/** Moves an issue (and its photos) to Recently Deleted. Owners and editors. */
export async function deleteIssue(issueId: string, version: number): Promise<IssueActionState> {
  await signedInUser();
  if (!uuid.safeParse(issueId).success || !Number.isInteger(version)) return { error: "Issue not found." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sled_issues")
    .update({ deleted_at: new Date().toISOString(), version })
    .eq("id", issueId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, "issue") };
  return done();
}

// ---------------------------------------------------------------------------
// Photos (the file is uploaded from the browser with the user's own session;
// storage policies allow it only for people who may edit the issue)
// ---------------------------------------------------------------------------
export async function addIssuePhoto(sledId: string, issueId: string, path: string, position: number): Promise<IssueActionState> {
  await signedInUser();
  if (!uuid.safeParse(sledId).success || !uuid.safeParse(issueId).success) return { error: "Issue not found." };
  if (!PHOTO_PATH.test(path) || !path.startsWith(`${sledId}/${issueId}/`)) return { error: "That photo can't be used." };
  const supabase = await createClient();
  const { error } = await supabase.from("sled_issue_photos").insert({
    sled_id: sledId,
    issue_id: issueId,
    path,
    position: Math.max(0, Math.min(MAX_ISSUE_PHOTOS * 10, Math.trunc(position) || 0)),
  });
  if (error) return { error: sledErrorMessage(error, "photo") };
  return done(issueId);
}

/** Removes a photo (Recently Deleted, like other records). Owners and editors. */
export async function removeIssuePhoto(photoId: string, version: number): Promise<IssueActionState> {
  await signedInUser();
  if (!uuid.safeParse(photoId).success || !Number.isInteger(version)) return { error: "Photo not found." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sled_issue_photos")
    .update({ deleted_at: new Date().toISOString(), version })
    .eq("id", photoId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, "photo") };
  return done();
}

/** Completed service records that can resolve an issue on this sled. */
export async function loadResolvableServices(sledId: string): Promise<ServiceOption[]> {
  await signedInUser();
  if (!uuid.safeParse(sledId).success) return [];
  return resolvableServices(sledId);
}
