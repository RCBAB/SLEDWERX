import { describe, expect, it } from "vitest";

import { fieldErrorsOf, resetPasswordSchema, signInSchema, signUpSchema } from "./auth";

describe("signUpSchema", () => {
  const valid = {
    displayName: "  Alex  ",
    email: "  Alex@Example.COM ",
    password: "correct-horse",
    confirmPassword: "correct-horse",
  };

  it("accepts a valid sign-up and normalizes the email and name", () => {
    const result = signUpSchema.parse(valid);
    expect(result.email).toBe("alex@example.com");
    expect(result.displayName).toBe("Alex");
  });

  it("treats a blank name as no name", () => {
    expect(signUpSchema.parse({ ...valid, displayName: "   " }).displayName).toBeUndefined();
  });

  it("rejects an invalid email", () => {
    const result = signUpSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error).email?.[0]).toBe("Enter a valid email address.");
  });

  it("rejects short passwords and passwords over 72 characters", () => {
    expect(signUpSchema.safeParse({ ...valid, password: "short", confirmPassword: "short" }).success).toBe(false);
    const long = "x".repeat(73);
    expect(signUpSchema.safeParse({ ...valid, password: long, confirmPassword: long }).success).toBe(false);
  });

  it("rejects mismatched passwords on the confirmation field", () => {
    const result = signUpSchema.safeParse({ ...valid, confirmPassword: "different-one" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error).confirmPassword?.[0]).toBe("Passwords don't match.");
  });
});

describe("signInSchema", () => {
  it("requires an email and a password", () => {
    const result = signInSchema.safeParse({ email: "", password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrorsOf(result.error);
      expect(errors.email).toBeDefined();
      expect(errors.password).toBeDefined();
    }
  });

  it("does not apply new-password rules when signing in", () => {
    expect(signInSchema.safeParse({ email: "a@example.com", password: "x" }).success).toBe(true);
  });
});

describe("resetPasswordSchema", () => {
  it("requires matching passwords of at least 8 characters", () => {
    expect(resetPasswordSchema.safeParse({ password: "new-password", confirmPassword: "new-password" }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ password: "new-password", confirmPassword: "other" }).success).toBe(false);
  });
});
