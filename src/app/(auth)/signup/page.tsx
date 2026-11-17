import type { Metadata } from "next";

import { AuthHeading } from "../auth-heading";
import { SignUpForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <>
      <AuthHeading title="Create account" subtitle="Your snowmobile maintenance book, in one place." />
      <SignUpForm />
    </>
  );
}
