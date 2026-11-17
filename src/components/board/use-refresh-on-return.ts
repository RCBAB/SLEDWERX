"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Next.js keeps recently visited pages hidden instead of unmounting them, and
 * Back shows them again as they were. A board can be completed elsewhere in
 * the meantime (the Garage Board or the sled's own page), so when a board
 * becomes visible again, reload its data. Effects re-run when a hidden page is
 * shown again; the first run (the initial render) is skipped.
 */
export function useRefreshOnReturn() {
  const router = useRouter();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) router.refresh();
    shown.current = true;
  }, [router]);
}
