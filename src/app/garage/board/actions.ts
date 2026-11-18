"use server";

import { getSessionUser } from "@/lib/auth/session";
import { isGarageLayout, withKeyboard, withLayout } from "@/lib/garage/layout";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Garage Board settings live in the user's own preferences
 * (user_preferences.garage_mode, private to them under RLS). Each save merges
 * into the stored object, so other settings are kept. Last save wins across
 * devices.
 */
async function updateGarageMode(change: (garageMode: unknown) => Record<string, unknown>): Promise<{ ok: boolean }> {
  const user = await getSessionUser();
  if (!user) return { ok: false };
  const supabase = await createClient();
  const { data, error: readError } = await supabase
    .from("user_preferences")
    .select("garage_mode")
    .eq("id", user.id)
    .maybeSingle();
  if (readError) return { ok: false };
  const garageMode = change(data?.garage_mode) as { [key: string]: Json | undefined };
  // Every account gets a preferences row at sign-up; insert one only if it's missing.
  const { error } = data
    ? await supabase.from("user_preferences").update({ garage_mode: garageMode }).eq("id", user.id)
    : await supabase.from("user_preferences").insert({ id: user.id, garage_mode: garageMode });
  return { ok: !error };
}

/** Remembers the Garage Board layout (Full Cards or Compact). */
export async function saveGarageLayout(layout: string): Promise<{ ok: boolean }> {
  if (!isGarageLayout(layout)) return { ok: false };
  return updateGarageMode((mode) => withLayout(mode, layout));
}

/** Remembers whether the Wall Display on-screen keyboard is on. */
export async function saveWallKeyboard(on: boolean): Promise<{ ok: boolean }> {
  if (typeof on !== "boolean") return { ok: false };
  return updateGarageMode((mode) => withKeyboard(mode, on));
}
