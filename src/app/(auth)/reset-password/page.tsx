import type { Metadata } from "next";

import { AuthHeading } from "../auth-heading";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <>
      <AuthHeading title="New password" subtitle="Choose a new password for your account." />
      <ResetPasswordForm />
    </>
  );
}
