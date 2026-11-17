import type { Metadata } from "next";

import { AuthHeading } from "../auth-heading";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeading title="Reset password" subtitle="We'll email you a link to choose a new password." />
      <ForgotPasswordForm />
    </>
  );
}
