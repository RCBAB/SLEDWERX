import { Bike, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/** Main navigation. More sections are added as each phase ships. */
export const NAV_ITEMS: NavItem[] = [{ href: "/garage", label: "My Snowmobiles", icon: Bike }];
