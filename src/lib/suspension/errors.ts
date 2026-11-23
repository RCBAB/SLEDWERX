import { sledErrorMessage } from "@/lib/sleds/errors";

type DbError = { code?: string; message?: string } | null | undefined;

// Messages written for people in Migration 7; safe to show as-is.
const SUSPENSION_MESSAGES = [
  "Make another setup active before deleting this one.",
  "Suspension revisions cannot be changed.",
  "Revisions are deleted and restored together with their setup.",
  "Restore this setup before",
  "That setting is not on this snowmobile.",
  "A revision can have at most 200 settings.",
  "Setting values must be 200 characters or fewer.",
  "Enter a number for ",
  "Only a revision of the same setup can be restored.",
  "The ride date cannot be in the future.",
  "Restore it before adding photos.",
  "Only the owner or an editor can add reference photos.",
  "Only the owner or an editor can change the active setup.",
  "That photo is not in the right folder.",
  "At most 6 photos can be added here.",
  "This setup was changed by someone else. Reload it and try again.",
  "Nothing changed.",
  "The latest revision already has these values.",
  "That revision can't be copied to this snowmobile.",
  // Migration 9 (Quick Tune)
  "The active configuration was changed by someone else. Reload it and try again.",
  "This setup holds the active configuration.",
  "Choose a ski model.",
  "Choose a carbide length.",
  "You do not have permission to change this snowmobile's suspension.",
  "Configuration not found.",
];

/** "Trail 4 uses different skis or carbides than the ones installed. ..." */
const EQUIPMENT_MISMATCH = /^Trail \d+ uses different skis or carbides than the ones installed\./;

export type SuspensionSubject = "setup" | "setting" | "revision" | "configuration" | "feedback" | "photo";

/** Friendly messages for suspension changes. Never echoes raw SQL errors. */
export function suspensionErrorMessage(error: DbError, subject: SuspensionSubject): string {
  const message = error?.message ?? "";
  if (SUSPENSION_MESSAGES.some((known) => message.startsWith(known)) || EQUIPMENT_MISMATCH.test(message)) return message;
  if (error?.code === "23505") {
    return subject === "setting"
      ? "There's already a setting with that name in this part of the sled."
      : subject === "setup"
        ? "There's already a setup with that name on this snowmobile."
        : "That was already saved.";
  }
  if (error?.code === "PT409") return `This ${subject} was changed somewhere else. Reload the page and try again.`;
  return sledErrorMessage(error, subject);
}
