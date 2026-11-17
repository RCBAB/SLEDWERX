/**
 * Turns Supabase Auth errors into short, friendly messages. Messages never
 * reveal whether an account exists.
 */
export function authErrorMessage(error: { code?: string; status?: number; message?: string } | null | undefined): string {
  switch (error?.code) {
    case "invalid_credentials":
      return "Incorrect email or password.";
    case "email_not_confirmed":
      return "Please confirm your email address first. Check your inbox for the link.";
    case "weak_password":
      return "Choose a stronger password.";
    case "same_password":
      return "Choose a password you haven't used for this account.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Too many attempts. Please wait a minute and try again.";
    case "signup_disabled":
      return "Sign-ups are currently closed.";
    case "otp_expired":
      return "This link has expired. Please request a new one.";
    default:
      if (error?.status === 429) {
        return "Too many attempts. Please wait a minute and try again.";
      }
      return "Something went wrong. Please try again.";
  }
}
