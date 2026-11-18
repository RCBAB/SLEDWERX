type DbError = { code?: string; message?: string } | null | undefined;

// Messages written for people in the SledWerx migrations; safe to show as-is.
const DATABASE_MESSAGES = [
  "Odometer readings cannot go down.",
  "Engine-hour readings cannot go down.",
  "The reading date cannot be in the future.",
  "Enter the current odometer reading.",
  "This reading belongs to a maintenance entry.",
  "Restore this snowmobile before editing it.",
  "The service date cannot be in the future.",
  "Only the owner or an editor can remove the mileage from a service record.",
  "This task cannot be used on this snowmobile.",
  "Restore this record before editing it.",
  "Only tasks from your own library can be added to a package.",
  "The issue date cannot be in the future.",
  "The resolved date cannot be in the future.",
  "That service record is not on this snowmobile.",
  "Only a completed service record can resolve an issue.",
  "An issue can have at most 6 photos.",
  "You do not have permission to add photos to this issue.",
  "Restore this issue before adding photos.",
];

/** Turns database errors into short, friendly messages. Never echoes raw SQL errors. */
export function sledErrorMessage(error: DbError, subject = "snowmobile"): string {
  const message = error?.message ?? "";
  const known = DATABASE_MESSAGES.find((prefix) => message.startsWith(prefix));
  if (known) return message;

  switch (error?.code) {
    case "PT409":
      return `This ${subject} was changed somewhere else. Reload the page and try again.`;
    case "42501":
      return "You don't have permission to do that.";
    case "23503":
      return "Your garage could not be found. Reload the page and try again.";
    case "23505":
      return "You already have one with that name.";
    case "P0002":
      return `This ${subject} could not be found. Reload the page and try again.`;
    case "23514":
    case "22P02":
    case "22003":
      return "Some details aren't valid. Check the form and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
