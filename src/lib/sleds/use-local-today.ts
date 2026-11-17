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
