import type { SuppressionEntry, SuppressionReason } from "@/domain/outreach/types";

/**
 * Universal, workspace-wide suppression (Prompt 3 §3.7). One check, called
 * before every send, regardless of channel or adapter — no adapter may
 * bypass it. Pure functions over an injected in-memory store, following the
 * same testable pattern as Phase 2's `email-verification-cache.ts` /
 * `job-queue.ts` (a real deployment backs this with a `suppression_entries`
 * table, per `docs/DATA_MODEL.md`).
 */

export interface SuppressionCheckInput {
  contactPointId: string | null;
  accountId: string | null;
}

export interface SuppressionCheckResult {
  suppressed: boolean;
  reason: SuppressionReason | null;
  entry: SuppressionEntry | null;
}

export function checkSuppression(input: SuppressionCheckInput, entries: readonly SuppressionEntry[]): SuppressionCheckResult {
  const match = entries.find(
    (entry) =>
      (input.contactPointId && entry.contactPointId === input.contactPointId) ||
      (input.accountId && entry.accountId === input.accountId),
  );
  if (!match) return { suppressed: false, reason: null, entry: null };
  return { suppressed: true, reason: match.reason, entry: match };
}

export interface AddSuppressionInput {
  workspaceId: string;
  contactPointId: string | null;
  accountId: string | null;
  reason: SuppressionReason;
  now: Date;
}

/** Idempotent: adding the same contact-point/reason twice never creates a duplicate entry. */
export function addSuppression(entries: readonly SuppressionEntry[], input: AddSuppressionInput): SuppressionEntry[] {
  const alreadySuppressed = entries.some(
    (entry) =>
      entry.reason === input.reason &&
      ((input.contactPointId && entry.contactPointId === input.contactPointId) ||
        (input.accountId && entry.accountId === input.accountId)),
  );
  if (alreadySuppressed) return [...entries];

  const newEntry: SuppressionEntry = {
    id: `sup_${input.contactPointId ?? input.accountId ?? "workspace"}_${input.reason}_${input.now.getTime()}`,
    workspaceId: input.workspaceId,
    contactPointId: input.contactPointId,
    accountId: input.accountId,
    reason: input.reason,
    createdAt: input.now.toISOString(),
  };
  return [...entries, newEntry];
}
