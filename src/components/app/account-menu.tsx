import { LogOut } from "lucide-react";

import { signOut } from "@/app/(auth)/actions";
import { getSessionUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** Signed-in user and sign-out. Reads the session: render inside <Suspense>. */
export async function AccountMenu() {
  const user = await getSessionUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  const name = profile?.display_name || user.email || "Rider";

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <p className="max-w-48 truncate text-sm font-semibold" data-testid="account-name">
          {name}
        </p>
        {profile?.display_name && user.email ? <p className="max-w-48 truncate text-xs text-muted">{user.email}</p> : null}
      </div>
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-accent/20 font-display text-sm font-bold text-foreground"
      >
        {initialsOf(name)}
      </span>
      <form action={signOut}>
        <button
          type="submit"
          className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-muted transition-colors hover:bg-white/5 hover:text-foreground"
        >
          <LogOut aria-hidden className="size-4" />
          <span className="sr-only sm:not-sr-only">Sign out</span>
        </button>
      </form>
    </div>
  );
}
