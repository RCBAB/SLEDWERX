"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { authErrorMessage } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";
import {
  fieldErrorsOf,
  forgotPasswordSchema,
  formValues,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  type FieldErrors,
} from "@/lib/validation/auth";

export type AuthFormState = {
  error?: string;
  message?: string;
  fieldErrors?: FieldErrors;
  /** Values to keep in the form after an error (never passwords). */
  values?: { email?: string; displayName?: string };
};

/** This site's origin, for links in auth emails. */
async function siteOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = formValues(formData, ["email", "password", "next"] as const);
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsOf(parsed.error), values: { email: raw.email } };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: authErrorMessage(error), values: { email: parsed.data.email } };
  }

  redirect(safeNextPath(raw.next));
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = formValues(formData, ["displayName", "email", "password", "confirmPassword"] as const);
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      fieldErrors: fieldErrorsOf(parsed.error),
      values: { email: raw.email, displayName: raw.displayName },
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: parsed.data.displayName ? { display_name: parsed.data.displayName } : {},
      emailRedirectTo: `${await siteOrigin()}/auth/confirm?next=/garage`,
    },
  });
  if (error) {
    return {
      error: authErrorMessage(error),
      values: { email: parsed.data.email, displayName: parsed.data.displayName },
    };
  }

  // Email confirmation off (local development): signed in straight away.
  if (data.session) {
    redirect("/garage");
  }

  // Confirmation on: the same message whether or not the email was already
  // registered, so the form never reveals who has an account.
  return {
    message: `We sent a confirmation link to ${parsed.data.email}. Open it to finish creating your account.`,
  };
}

export async function requestPasswordReset(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = formValues(formData, ["email"] as const);
  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsOf(parsed.error), values: { email: raw.email } };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${await siteOrigin()}/auth/confirm?next=/reset-password`,
  });
  if (error?.code === "over_email_send_rate_limit" || error?.status === 429) {
    return { error: authErrorMessage(error), values: { email: parsed.data.email } };
  }

  // Same message either way, so it never reveals who has an account.
  return {
    message: "If an account exists for that email, we've sent a link to reset your password.",
  };
}

export async function updatePassword(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = formValues(formData, ["password", "confirmPassword"] as const);
  const parsed = resetPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsOf(parsed.error) };
  }

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    return { error: "Your reset link has expired. Please request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: authErrorMessage(error) };
  }

  redirect("/garage");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login?signed_out=1");
}
