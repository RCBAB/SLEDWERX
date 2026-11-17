import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthHeading } from "../auth-heading";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <AuthHeading title="Sign in" subtitle="Welcome back to your garage." />
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  );
}
