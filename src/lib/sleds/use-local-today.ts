"use client";

import { useSyncExternalStore } from "react";

import { isoDate } from "./format";

const subscribe = () => () => {};

/**
 * Today's date (YYYY-MM-DD) in the user's own time zone. Empty during server
 * rendering, so forms never default to the server's (UTC) date.
 */
export function useLocalToday(): string {
  return useSyncExternalStore(subscribe, () => isoDate(new Date()), () => "");
}

/** The browser's IANA time zone (e.g. "America/Denver"); empty during server rendering. */
export function useTimeZone(): string {
  return useSyncExternalStore(subscribe, () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "", () => "");
}
