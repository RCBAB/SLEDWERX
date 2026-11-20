import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Compared in
 * constant time (both sides hashed first, so their lengths always match).
 */
export function isAuthorizedCronRequest(authorization: string | null, secret: string | null): boolean {
  if (!secret || !authorization) return false;
  const given = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(given, expected);
}
