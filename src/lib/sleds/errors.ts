type DbError = { code?: string; message?: string } | null | undefined;

// Messages written for people in the SledWerx migrations; safe to show as-is.
const DATABASE_MESSAGES = [
  "Odometer readings cannot go down.",
  "Engine-hour readings cannot go down.",
  "The reading date cannot be in the future.",
  "Enter the current odometer reading.",
  "This reading belongs to a maintenance entry.",
  "Restore this snowmobile before editing it.",
];

/** Turns database errors into short, friendly messages. Never echoes raw SQL errors. */
export function sledErrorMessage(error: DbError): string {
  const message = error?.message ?? "";
  const known = DATABASE_MESSAGES.find((prefix) => message.startsWith(prefix));
  if (known) return message;

  switch (error?.code) {
    case "PT409":
      return "This snowmobile was changed somewhere else. Reload the page and try again.";
    case "42501":
      return "You don't have permission to do that.";
    case "23503":
      return "Your garage could not be found. Reload the page and try again.";
    case "23514":
    case "22P02":
    case "22003":
      return "Some details aren't valid. Check the form and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
