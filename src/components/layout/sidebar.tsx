"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { NAV_ITEMS } from "./nav-config";
import { getNavBadgeCounts } from "./nav-badges";
import { useSidebar } from "./sidebar-context";

function SidebarContent({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const badgeCounts = getNavBadgeCounts();

  return (
    <>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          const badge = badgeCounts[item.href];
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors",
                collapsed && "justify-center",
                isActive
                  ? "bg-primary-soft text-primary"
                  : "text-text-muted hover:bg-surface-muted hover:text-text",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {!collapsed && badge ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        {!collapsed ? (
          <div className="rounded-[10px] px-3 py-2 text-xs text-text-muted">
            Workspace: <span className="font-medium text-text">Vitalcap</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function Sidebar() {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useSidebar();

  return (
    <>
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] md:flex",
          collapsed ? "w-[72px]" : "w-[240px]",
        )}
      >
        <div className={cn("flex h-16 items-center gap-2 border-b border-border px-5", collapsed && "justify-center px-0")}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary text-sm font-semibold text-white">
            V
          </span>
          {!collapsed && <span className="text-sm font-semibold tracking-tight text-text">Vitalcap Outreach OS</span>}
        </div>

        <SidebarContent collapsed={collapsed} />

        <div className="border-t border-border p-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex w-full items-center justify-center gap-2 rounded-[10px] py-1.5 text-xs font-medium text-text-muted hover:bg-surface-muted hover:text-text"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" aria-hidden="true" /> : <ChevronsLeft className="h-4 w-4" aria-hidden="true" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-black/20" />
          <div className="relative flex h-full w-[260px] flex-col border-r border-border bg-surface shadow-xl">
            <div className="flex h-16 items-center justify-between gap-2 border-b border-border px-5">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary text-sm font-semibold text-white">
                  V
                </span>
                <span className="text-sm font-semibold tracking-tight text-text">Vitalcap Outreach OS</span>
              </div>
              <button type="button" onClick={() => setMobileOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[10px] text-text-muted hover:bg-surface-muted">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
