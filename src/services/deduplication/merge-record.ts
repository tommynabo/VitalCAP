import type { AccountDedupSignal, AccountMergeRecord } from "@/domain/accounts/types";

/**
 * Builds the audit record for an account merge decision (Prompt 1 §1.2 —
 * "store merge history"). The caller supplies the persisted `id` and
 * `createdAt` (DB-assigned); this only shapes the record consistently.
 */
export function buildAccountMergeRecord(params: {
  id: string;
  survivingAccountId: string;
  mergedAccountId: string;
  matchedSignal: AccountDedupSignal;
  confidence: number;
  decidedBy: "auto" | "human_review";
  createdAt: string;
}): AccountMergeRecord {
  return { ...params };
}
