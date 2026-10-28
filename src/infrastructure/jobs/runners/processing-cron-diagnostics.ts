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

export type ProcessingWriteStage =
  | "RESOLVE_CANONICAL_ACCOUNT"
  | "UPDATE_ACCOUNT_FIELDS"
  | "LINK_RAW_ACCOUNT"
  | "INSERT_ACCOUNT_SOURCE"
  | "INSERT_CONTACT_POINT"
  | "UPSERT_CAMPAIGN_MEMBERSHIP"
  | "UPSERT_WEBSITE_ENRICHMENT"
  | "INSERT_WEBSITE_EVIDENCE"
  | "RESET_INTERRUPTED_WEBSITE_RECOVERY"
  | "ENQUEUE_VERIFICATION"
  | "ENQUEUE_INTELLIGENCE"
  | "MARK_RAW_PROCESSED"
  | "ENQUEUE_PROCESSING_JOB";

export interface ProcessingCronDiagnosticsContext {
  correlationId: string;
  startedAtMs: number;
  reportedErrors: Set<unknown>;
}

export interface ProcessingJobFailureMetadata {
  stage: ProcessingWriteStage;
  sqlState: string | null;
  constraintName: string | null;
  tableName: string | null;
  errorClass: string;
}

const processingJobFailures = new WeakMap<object, ProcessingJobFailureMetadata>();

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

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ? value : null;
}

function safePostgresMetadata(error: unknown): { sqlState: string | null; constraintName: string | null; tableName: string | null } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let sqlState: string | null = null;
  let constraintName: string | null = null;
  let tableName: string | null = null;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== "object") break;
    try {
      const record = current as {
        sqlState?: unknown;
        code?: unknown;
        constraintName?: unknown;
        constraint_name?: unknown;
        constraint?: unknown;
        tableName?: unknown;
        table_name?: unknown;
        table?: unknown;
        cause?: unknown;
      };
      const state = record.sqlState ?? record.code;
      if (sqlState === null && typeof state === "string" && /^[0-9A-Z]{5}$/.test(state)) sqlState = state;
      constraintName ??= safeIdentifier(record.constraintName ?? record.constraint_name ?? record.constraint);
      tableName ??= safeIdentifier(record.tableName ?? record.table_name ?? record.table);
      current = record.cause;
    } catch {
      break;
    }
  }
  return { sqlState, constraintName, tableName };
}

export function getProcessingJobFailureMetadata(error: unknown): ProcessingJobFailureMetadata | null {
  return error && typeof error === "object" ? processingJobFailures.get(error) ?? null : null;
}

export function logProcessingCronFailure(
  context: ProcessingCronDiagnosticsContext,
  stage: ProcessingCronStage,
  error?: unknown,
): void {
  if (error !== undefined && context.reportedErrors.has(error)) return;
  if (error !== undefined) context.reportedErrors.add(error);
  const postgres = safePostgresMetadata(error);
  logEvent("error", "processing_cron_failed", {
    correlationId: context.correlationId,
    stage,
    sqlState: postgres.sqlState,
    errorClass: error === undefined ? "UnknownError" : safeErrorClass(error),
    elapsedMs: Math.max(0, Date.now() - context.startedAtMs),
  });
}

export function logProcessingJobFailure(
  context: ProcessingCronDiagnosticsContext,
  stage: ProcessingWriteStage,
  error: unknown,
): void {
  if (context.reportedErrors.has(error)) return;
  context.reportedErrors.add(error);
  const postgres = safePostgresMetadata(error);
  if (typeof error === "object" && error !== null) {
    processingJobFailures.set(error, {
      stage,
      ...postgres,
      errorClass: safeErrorClass(error),
    });
  }
  logEvent("error", "processing_job_failed", {
    correlationId: context.correlationId,
    stage,
    sqlState: postgres.sqlState,
    constraintName: postgres.constraintName,
    tableName: postgres.tableName,
    errorClass: safeErrorClass(error),
    elapsedMs: Math.max(0, Date.now() - context.startedAtMs),
  });
}

export async function runProcessingWriteStage<T>(
  context: ProcessingCronDiagnosticsContext,
  stage: ProcessingWriteStage,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logProcessingJobFailure(context, stage, error);
    throw error;
  }
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