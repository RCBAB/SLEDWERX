import { describe, expect, it } from "vitest";

import { authErrorMessage } from "./errors";

describe("authErrorMessage", () => {
  it("maps known Supabase Auth codes to friendly messages", () => {
    expect(authErrorMessage({ code: "invalid_credentials" })).toBe("Incorrect email or password.");
    expect(authErrorMessage({ code: "email_not_confirmed" })).toMatch(/confirm your email/);
    expect(authErrorMessage({ status: 429 })).toMatch(/Too many attempts/);
  });

  it("never echoes raw server messages", () => {
    expect(authErrorMessage({ code: "unexpected_failure", message: "db error: relation x" })).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
