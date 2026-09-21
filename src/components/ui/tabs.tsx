"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface TabItem {
  value: string;
  label: string;
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  children,
}: {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: (activeValue: string) => ReactNode;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? items[0]?.value ?? "");
  const activeValue = value ?? internalValue;

  function select(next: string) {
    setInternalValue(next);
    onValueChange?.(next);
  }

  return (
    <div>
      <div role="tablist" aria-label="Tabs" className="flex gap-1 overflow-x-auto border-b border-border">
        {items.map((item) => {
          const isActive = item.value === activeValue;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => select(item.value)}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-text-muted hover:text-text",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="pt-4">{children(activeValue)}</div>
    </div>
  );
}
