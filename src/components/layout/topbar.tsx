"use client";

import { usePathname } from "next/navigation";
import { Bell, Menu, Search } from "lucide-react";
import { NAV_ITEMS } from "./nav-config";
import { useSidebar } from "./sidebar-context";

export function TopBar() {
  const pathname = usePathname();
  const { setMobileOpen } = useSidebar();
  const current =
    NAV_ITEMS.find((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))) ??
    NAV_ITEMS[0]!;

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-text-muted hover:bg-surface-muted hover:text-text md:hidden"
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
        <h1 className="text-base font-semibold text-text">{current.label}</h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-2 rounded-[10px] border border-border bg-surface-muted px-3 py-1.5 text-sm text-text-muted sm:flex">
          <Search className="h-4 w-4" aria-hidden="true" />
          <span>Search…</span>
        </div>
        <button
          type="button"
          aria-label="Notifications"
          className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-border text-text-muted hover:bg-surface-muted hover:text-text"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
        </button>
        <div
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary"
        >
          V
        </div>
      </div>
    </header>
  );
}
