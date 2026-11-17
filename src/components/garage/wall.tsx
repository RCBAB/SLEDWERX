"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** How often the wall display reloads its data (and renews photo links). */
export const WALL_REFRESH_MS = 5 * 60 * 1000;
/** An unfinished Done sheet on the wall closes itself after this long without input. */
export const WALL_IDLE_CLOSE_MS = 60 * 1000;

const BOARD_URL = "/garage/board";
const WALL_URL = "/garage/board?display=wall";

function subscribeFullscreen(callback: () => void) {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
}

/**
 * Wall display for a garage monitor or tablet: a full-window layer with large
 * touch targets that keeps itself up to date, keeps the screen awake where the
 * browser allows it, and goes full screen when asked (browsers only allow
 * that after a tap).
 */
export function useWallDisplay(initial: boolean, sheetOpen: boolean, closeSheet: () => void, loadedAt: string) {
  const router = useRouter();
  const [active, setActive] = useState(initial);
  const fullscreen = useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenElement != null,
    () => false,
  );
  const canFullscreen = useSyncExternalStore(
    () => () => {},
    () => Boolean(document.fullscreenEnabled),
    () => true,
  );
  const sheetOpenRef = useRef(sheetOpen);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  const enter = useCallback(() => {
    setActive(true);
    window.history.replaceState(null, "", WALL_URL);
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    window.history.replaceState(null, "", BOARD_URL);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  // Keep the data fresh: every few minutes and whenever the screen comes back
  // (so "due today" rolls over and photo links are renewed). Never while a
  // sheet is open, so nothing changes under someone's finger.
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      if (!sheetOpenRef.current && document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, WALL_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, router]);

  // Keep the screen on while the wall display is showing (where supported).
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const request = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((sentinel) => {
          if (stopped) sentinel.release().catch(() => {});
          else lock = sentinel;
        })
        .catch(() => {});
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", request);
      lock?.release().catch(() => {});
    };
  }, [active]);

  // An unfinished sheet left on the wall closes itself after a minute idle.
  useEffect(() => {
    if (!active || !sheetOpen) return;
    let timer = window.setTimeout(closeSheet, WALL_IDLE_CLOSE_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(closeSheet, WALL_IDLE_CLOSE_MS);
    };
    const events = ["pointerdown", "keydown", "input"] as const;
    events.forEach((e) => document.addEventListener(e, reset, true));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => document.removeEventListener(e, reset, true));
    };
  }, [active, sheetOpen, closeSheet]);

  // Esc leaves the wall display (a sheet's own Esc closes just the sheet).
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sheetOpenRef.current && !document.fullscreenElement) exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, exit]);

  return { active, enter, exit, fullscreen, canFullscreen, toggleFullscreen, updatedAt: loadedAt };
}

const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** Current time and when the board was last updated (client only, so no hydration mismatch). */
export function WallClock({ updatedAt }: { updatedAt: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  if (!now) return <p className="h-7" aria-hidden />;
  return (
    <p className="mt-1 text-lg text-muted" data-testid="wall-clock">
      <span className="font-semibold tabular-nums text-foreground">{now.toLocaleTimeString([], timeFormat)}</span>
      <span> · Updated {new Date(updatedAt).toLocaleTimeString([], timeFormat)}</span>
    </p>
  );
}
