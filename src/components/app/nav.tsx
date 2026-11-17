"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { cn } from "@/components/ui/cn";

import { NAV_ITEMS } from "./nav-items";

function matches(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Only the most specific matching item is active ("/garage/library" over "/garage"). */
function isActive(pathname: string | null, href: string) {
  if (pathname == null || !matches(pathname, href)) return false;
  return !NAV_ITEMS.some((item) => item.href.length > href.length && matches(pathname, item.href));
}

// The current path is request data on dynamic routes (e.g. /garage/[sledId]),
// so the active state streams in behind Suspense. The fallback is the same
// navigation without highlighting, so nothing moves.

/** Desktop sidebar navigation. */
export function SideNav() {
  return (
    <Suspense fallback={<SideNavView pathname={null} />}>
      <SideNavLive />
    </Suspense>
  );
}

function SideNavLive() {
  return <SideNavView pathname={usePathname()} />;
}

function SideNavView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="space-y-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors",
              active ? "bg-accent/15 text-foreground" : "text-muted hover:bg-white/5 hover:text-foreground",
            )}
          >
            <Icon aria-hidden className={cn("size-5", active && "text-accent")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile bottom navigation, sized for gloved thumbs. */
export function BottomNav() {
  return (
    <Suspense fallback={<BottomNavView pathname={null} />}>
      <BottomNavLive />
    </Suspense>
  );
}

function BottomNavLive() {
  return <BottomNavView pathname={usePathname()} />;
}

function BottomNavView({ pathname }: { pathname: string | null }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-md">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-xs font-semibold",
                  active ? "text-foreground" : "text-muted",
                )}
              >
                <Icon aria-hidden className={cn("size-6", active && "text-accent")} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
