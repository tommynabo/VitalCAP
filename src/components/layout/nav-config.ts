import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Building2,
  Contact,
  Gauge,
  Inbox,
  LayoutDashboard,
  MessageSquareText,
  Radar,
  Rocket,
  Send,
  Server,
  Settings,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Single source of truth for the sidebar (Prompt 0 §0.11) and top bar page titles. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Rocket },
  { href: "/autopilot", label: "Autopilot", icon: Gauge },
  { href: "/discovery", label: "Discovery", icon: Radar },
  { href: "/accounts", label: "Accounts", icon: Building2 },
  { href: "/contacts", label: "Contacts", icon: Contact },
  { href: "/outreach", label: "Outreach", icon: Send },
  { href: "/setter", label: "AI Setter", icon: MessageSquareText },
  { href: "/reviews", label: "Reviews", icon: Inbox },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/infrastructure", label: "Infrastructure", icon: Server },
  { href: "/settings", label: "Settings", icon: Settings },
];
