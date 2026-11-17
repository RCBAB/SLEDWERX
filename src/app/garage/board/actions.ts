"use server";

import { getSessionUser } from "@/lib/auth/session";
import { isGarageLayout, withLayout } from "@/lib/garage/layout";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Remembers the Garage Board layout in the user's own preferences
 * (user_preferences.garage_mode, private to them under RLS). Other Garage Mode
 * settings in the same object are kept. Last save wins across devices.
 */
export async function saveGarageLayout(layout: string): Promise<{ ok: boolean }> {
  if (!isGarageLayout(layout)) return { ok: false };
  const user = await getSessionUser();
  if (!user) return { ok: false };
  const supabase = await createClient();
  const { data, error: readError } = await supabase
    .from("user_preferences")
    .select("garage_mode")
    .eq("id", user.id)
    .maybeSingle();
  if (readError) return { ok: false };
  const garageMode = withLayout(data?.garage_mode, layout) as { [key: string]: Json | undefined };
  // Every account gets a preferences row at sign-up; insert one only if it's missing.
  const { error } = data
    ? await supabase.from("user_preferences").update({ garage_mode: garageMode }).eq("id", user.id)
    : await supabase.from("user_preferences").insert({ id: user.id, garage_mode: garageMode });
  return { ok: !error };
}
