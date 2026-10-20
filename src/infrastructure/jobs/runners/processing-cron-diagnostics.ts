import { logEvent } from "@/lib/observability/structured-logger";

export type ProcessingCronStage =
  | "PROCESS_AUTH"
  | "PROCESS_SETTINGS"
  | "RECOVERY_WORKSPACE_DISCOVERY"
  | "RECOVERY_SELECTION_AND_ENQUEUE"
  | "NORMAL_PROCESSING_CLAIM"
  | "RAW_PROCESSING"
  | "VERIFICATION_HANDOFF"
  | "CRON_RUN_PERSISTENCE";

export interface ProcessingCronDiagnosticsContext {
  correlationId: string;
  startedAtMs: number;
  reportedErrors: Set<unknown>;
}

export function createProcessingCronDiagnosticsContext(correlationId: string): ProcessingCronDiagnosticsContext {
  return { correlationId, startedAtMs: Date.now(), reportedErrors: new Set() };
}

function safeErrorClass(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  try {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function safeSqlState(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== "object") break;
    try {
      const record = current as { sqlState?: unknown; code?: unknown; cause?: unknown };
      const state = record.sqlState ?? record.code;
      if (typeof state === "string" && /^[0-9A-Z]{5}$/.test(state)) return state;
      current = record.cause;
    } catch {
      break;
    }
  }
  return null;
}

export function logProcessingCronFailure(
  context: ProcessingCronDiagnosticsContext,
  stage: ProcessingCronStage,
  error?: unknown,
): void {
  if (error !== undefined && context.reportedErrors.has(error)) return;
  if (error !== undefined) context.reportedErrors.add(error);
  logEvent("error", "processing_cron_failed", {
    correlationId: context.correlationId,
    stage,
    sqlState: safeSqlState(error),
    errorClass: error === undefined ? "UnknownError" : safeErrorClass(error),
    elapsedMs: Math.max(0, Date.now() - context.startedAtMs),
  });
}

export async function runProcessingCronStage<T>(
  context: ProcessingCronDiagnosticsContext,
  stage: ProcessingCronStage,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logProcessingCronFailure(context, stage, error);
    throw error;
  }
}