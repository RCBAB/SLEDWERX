import { z } from "zod";

const email = z
  .string({ error: "Enter your email address." })
  .trim()
  .toLowerCase()
  .min(1, { error: "Enter your email address." })
  .max(254, { error: "That email address is too long." })
  .pipe(z.email({ error: "Enter a valid email address." }));

// Supabase stores bcrypt hashes, which only use the first 72 bytes.
const newPassword = z
  .string({ error: "Enter a password." })
  .min(8, { error: "Use at least 8 characters." })
  .max(72, { error: "Use 72 characters or fewer." });

export const signInSchema = z.object({
  email,
  password: z.string({ error: "Enter your password." }).min(1, { error: "Enter your password." }),
});

export const signUpSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .max(80, { error: "Use 80 characters or fewer." })
      .optional()
      .transform((value) => (value ? value : undefined)),
    email,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    error: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    error: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export type FieldErrors = Partial<Record<string, string[]>>;

/** Field errors keyed by field name, for showing under each input. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors as FieldErrors;
}

/** Reads the named text fields from a submitted form. */
export function formValues<K extends string>(formData: FormData, keys: readonly K[]) {
  const values = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const value = formData.get(key);
    values[key] = typeof value === "string" ? value : undefined;
  }
  return values;
}
