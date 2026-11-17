"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { updatePassword, type AuthFormState } from "../actions";

export function ResetPasswordForm() {
  const [state, action] = useActionState<AuthFormState, FormData>(updatePassword, {});

  return (
    <form action={action} className="space-y-5" noValidate>
      {state.error ? (
        <Alert tone="error">
          {state.error}{" "}
          <Link href="/forgot-password" className="font-semibold underline underline-offset-4">
            Request a new link
          </Link>
        </Alert>
      ) : null}
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint="At least 8 characters."
        error={state.fieldErrors?.password?.[0]}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword?.[0]}
      />
      <SubmitButton pendingText="Saving…">Save new password</SubmitButton>
    </form>
  );
}
