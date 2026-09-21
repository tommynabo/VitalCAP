import { cn } from "@/lib/utils/cn";

/** Minimal dependency-free vertical bar chart (weekly trend style). */
export function MiniBarChart({
  data,
  className,
}: {
  data: Array<{ label: string; value: number }>;
  className?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn("flex items-end gap-2", className)}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-[11px] font-medium text-text">{d.value}</span>
          <div className="flex h-24 w-full items-end rounded-[6px] bg-surface-muted">
            <div
              className="w-full rounded-[6px] bg-primary transition-[height]"
              style={{ height: `${Math.max(4, (d.value / max) * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-text-muted">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal decreasing-width funnel (raw -> ... -> meeting style). */
export function FunnelChart({
  stages,
  className,
}: {
  stages: Array<{ label: string; value: number }>;
  className?: string;
}) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className={cn("space-y-2", className)}>
      {stages.map((stage) => {
        const pct = Math.max(2, Math.round((stage.value / max) * 100));
        return (
          <div key={stage.label} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-xs text-text-muted">{stage.label}</span>
            <div className="h-6 flex-1 rounded-[6px] bg-surface-muted">
              <div
                className="flex h-6 items-center rounded-[6px] bg-primary-soft px-2 text-xs font-medium text-primary"
                style={{ width: `${pct}%` }}
              >
                {stage.value}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal 2-segment mix bar (e.g. email vs SMS). */
export function MixBar({
  segments,
  className,
}: {
  segments: Array<{ label: string; value: number; colorClassName: string }>;
  className?: string;
}) {
  const total = Math.max(1, segments.reduce((sum, s) => sum + s.value, 0));
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-muted">
        {segments.map((s) => (
          <div key={s.label} className={s.colorClassName} style={{ width: `${(s.value / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-text-muted">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", s.colorClassName)} />
            {s.label}: {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}
