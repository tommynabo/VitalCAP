/**
 * Structured logging (Prompt 6 §6.2). A single `logEvent` call shape used
 * across jobs/providers/webhooks so every log line carries the same
 * correlating fields and can be filtered/aggregated the same way in any log
 * sink. Deliberately redacts anything secret-shaped before it ever reaches
 * `console` — "Never log secrets. Avoid logging full personal data
 * unnecessarily" (§6.2) is enforced here, not left to call sites to
 * remember.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogFields {
  correlationId: string;
  jobId?: string;
  campaignId?: string;
  accountId?: string;
  provider?: string;
  durationMs?: number;
  outcome?: string;
  [extra: string]: unknown;
}

export interface StructuredLogLine {
  level: LogLevel;
  message: string;
  timestamp: string;
  fields: StructuredLogFields;
}

const SECRET_KEY_PATTERN = /secret|api[_-]?key|token|password|authorization|signature/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;

/** Masks a value that looks like a secret, email, or phone number; leaves everything else untouched. */
function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.replace(EMAIL_PATTERN, "[email]").replace(PHONE_PATTERN, "[phone]");
  }
  return value;
}

function redactFields(fields: StructuredLogFields): StructuredLogFields {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = redactValue(key, value);
  }
  return redacted as StructuredLogFields;
}

/** Builds the structured line (pure — no I/O) so it's independently testable from the actual sink. */
export function buildLogLine(level: LogLevel, message: string, fields: StructuredLogFields, now: Date = new Date()): StructuredLogLine {
  return { level, message, timestamp: now.toISOString(), fields: redactFields(fields) };
}

/** Emits one structured JSON log line to the console-equivalent sink for the given level. */
export function logEvent(level: LogLevel, message: string, fields: StructuredLogFields, now: Date = new Date()): StructuredLogLine {
  const line = buildLogLine(level, message, fields, now);
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
  return line;
}
