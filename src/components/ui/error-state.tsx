"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Retriable error state. Never dumps a raw stack trace to the primary
 * view — technical detail (if any) lives behind an expandable disclosure,
 * per Prompt 5 §5.14 ("no giant red error dumps").
 */
export function ErrorState({
  title = "Something went wrong",
  description = "This section couldn't load. You can try again.",
  detail,
  onRetry,
}: {
  title?: string;
  description?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="max-w-sm text-xs text-text-muted">{description}</p>
      <div className="flex items-center gap-3">
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        {detail ? (
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
          >
            {showDetail ? "Hide details" : "Technical details"}
          </button>
        ) : null}
      </div>
      {showDetail && detail ? (
        <pre className="mt-1 max-w-md overflow-x-auto rounded-[10px] bg-surface-muted px-3 py-2 text-left text-[11px] text-text-muted">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
