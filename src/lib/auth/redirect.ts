/**
 * Returns a safe in-app path to redirect to after sign-in, or the fallback.
 * Only same-site relative paths are allowed, so a crafted `?next=` link
 * cannot send users to another website.
 */
export function safeNextPath(value: unknown, fallback = "/garage"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return fallback;
  }
  // Must be a path on this site: "/x", never "//host", "/\\host" or "http:".
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  try {
    const base = "https://sledwerx.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
