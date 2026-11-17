"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

import { signIn, type AuthFormState } from "../actions";

const LINK_ERRORS: Record<string, string> = {
  link: "That link is invalid or has expired. Please sign in or request a new link.",
};

export function LoginForm() {
  const params = useSearchParams();
  const [state, action] = useActionState<AuthFormState, FormData>(signIn, {});
  const linkError = LINK_ERRORS[params.get("error") ?? ""];
  const signedOut = params.get("signed_out") === "1";

  return (
    <form action={action} className="space-y-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {!state.error && linkError ? <Alert tone="error">{linkError}</Alert> : null}
      {!state.error && !linkError && signedOut ? <Alert tone="success">You&apos;ve signed out.</Alert> : null}

      <input type="hidden" name="next" value={params.get("next") ?? ""} />
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
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password?.[0]}
      />
      <div className="flex justify-end text-sm">
        <Link href="/forgot-password" className="text-muted underline-offset-4 hover:text-foreground hover:underline">
          Forgot your password?
        </Link>
      </div>
      <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
      <p className="text-center text-sm text-muted">
        New to SledWerx?{" "}
        <Link href="/signup" className="font-semibold text-foreground underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
