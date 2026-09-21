import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
