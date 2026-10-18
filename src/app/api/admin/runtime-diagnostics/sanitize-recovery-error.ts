export type RecoveryJobFailureKind =
  | "billing"
  | "authentication"
  | "configuration"
  | "transient"
  | "safety"
  | "raw_request_cap"
  | "daily_cost_cap"
  | "unknown";

export interface SanitizedRecoveryJobError {
  lastErrorClass: string | null;
  lastErrorSafeMessage: string | null;
  lastFailureKind: RecoveryJobFailureKind | null;
}

const SECRET_ENV_NAME = /token|secret|database[_-]?url|api[_-]?key|password|authorization/i;

function redactSensitiveTerms(message: string, terms: readonly string[]): string {
  return [...new Set(terms.filter((term) => term.length >= 2))]
    .sort((left, right) => right.length - left.length)
    .reduce((safeMessage, term) => {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return safeMessage.replace(new RegExp(escapedTerm, "gi"), "[seed]");
    }, message);
}

function extractProviderErrorMessage(message: string): string {
  const bodyStart = message.indexOf("{");
  const arrayStart = message.indexOf("[");
  if (arrayStart >= 0 && (bodyStart < 0 || arrayStart < bodyStart)) {
    return message.slice(0, arrayStart).trim();
  }
  if (bodyStart < 0) return message;
  const prefix = message.slice(0, bodyStart).trim();
  try {
    const body: unknown = JSON.parse(message.slice(bodyStart));
    const errorValue = body && typeof body === "object" && "error" in body ? body.error : null;
    const errorBody = errorValue && typeof errorValue === "object" ? errorValue as Record<string, unknown> : null;
    const errorType = typeof errorBody?.type === "string" ? errorBody.type : null;
    const errorDetail = typeof errorBody?.message === "string" ? errorBody.message : null;
    return [prefix, errorType, errorDetail].filter(Boolean).join(" ");
  } catch {
    return prefix || "Discovery job failed.";
  }
}

function classifyFailure(message: string): RecoveryJobFailureKind {
  if (/raw[_ -]?request[_ -]?cap|max daily requests|raw.{0,30}(request|cap)/i.test(message)) return "raw_request_cap";
  if (/daily[_ -]?cost[_ -]?cap|daily.{0,30}(cost|spend|budget)|spend limit/i.test(message)) return "daily_cost_cap";
  if (/manual reconciliation|already in progress|safety gate/i.test(message)) return "safety";
  if (/billing|payment|insufficient credits?|max-total-charge|credit limit/i.test(message)) return "billing";
  if (/authentication|unauthori[sz]ed|\b401\b|invalid (?:api )?token/i.test(message)) return "authentication";
  if (/configuration|environment validation|missing (?:required )?(?:setting|configuration|token)|\bZodError\b/i.test(message)) return "configuration";
  if (/timeout|timed out|\b429\b|network|temporar|transient|cooldown|econnreset/i.test(message)) return "transient";
  return "unknown";
}

export function sanitizeRecoveryJobError(
  message: string | null,
  sensitiveTerms: readonly string[] = [],
): SanitizedRecoveryJobError {
  if (!message) return { lastErrorClass: null, lastErrorSafeMessage: null, lastFailureKind: null };

  const errorClass = message.match(/\b([A-Za-z][A-Za-z0-9]*(?:Error|Exception))\b/)?.[1] ?? "Error";
  const failureKind = classifyFailure(message);
  let safeMessage = extractProviderErrorMessage(message);
  safeMessage = redactSensitiveTerms(safeMessage, sensitiveTerms);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && SECRET_ENV_NAME.test(name)) {
      safeMessage = safeMessage.split(value).join("[REDACTED]");
    }
  }
  safeMessage = safeMessage
    .replace(/\bapify_api_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:database[_-]?url|password|api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(for workspace\s+)[a-z0-9_-]{4,}/gi, "$1[REDACTED]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[DATABASE_URL_REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 300);

  return {
    lastErrorClass: errorClass,
    lastErrorSafeMessage: safeMessage || "Discovery job failed.",
    lastFailureKind: failureKind,
  };
}