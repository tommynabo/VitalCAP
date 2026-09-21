import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[10px] bg-surface-muted", className)} />;
}

/** Generic page-level skeleton: KPI row + a couple of card-shaped blocks. */
export function PageSkeleton({ kpiCount = 5 }: { kpiCount?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: kpiCount }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-[16px]" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[16px]" />
    </div>
  );
}
