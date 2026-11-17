"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { signUp, type AuthFormState } from "../actions";

export function SignUpForm() {
  const [state, action] = useActionState<AuthFormState, FormData>(signUp, {});

  if (state.message) {
    return (
      <div className="space-y-5">
        <Alert tone="success">{state.message}</Alert>
        <p className="text-sm text-muted">
          Didn&apos;t get it? Check your spam folder, or{" "}
          {/* A full page load resets the form state. */}
          <a href="/signup" className="font-semibold text-foreground underline-offset-4 hover:underline">
            try again
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        label="Name (optional)"
        name="displayName"
        autoComplete="name"
        defaultValue={state.values?.displayName}
        error={state.fieldErrors?.displayName?.[0]}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email?.[0]}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint="At least 8 characters."
        error={state.fieldErrors?.password?.[0]}
      />
      <Field
        label="Confirm password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword?.[0]}
      />
      <SubmitButton pendingText="Creating account…">Create account</SubmitButton>
      <p className="text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
