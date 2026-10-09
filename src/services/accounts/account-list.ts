import type { Account } from "@/domain/accounts/types";

export const ACCOUNT_LIST_PAGE_SIZE = 25;

export interface AccountListCursor {
  createdAt: string;
  id: string;
}

export interface AccountListSummary {
  account: Pick<Account, "id" | "canonicalName" | "businessType" | "province" | "fitScore" | "fitTier" | "createdAt">;
  contactCount: number;
  sourceCount: number;
  intelligence: {
    fitScore: number | null;
    fitTier: string | null;
    confidence: number | null;
    lastAnalyzedAt: string | null;
    reasonSummary: string | null;
  } | null;
}

export interface AccountListPageData {
  items: AccountListSummary[];
  nextCursor: AccountListCursor | null;
}

export interface AccountListPageDependencies {
  listAccountSummaries(limit: number, cursor: AccountListCursor | null): Promise<AccountListSummary[]>;
}

export async function loadAccountListPage(
  dependencies: AccountListPageDependencies,
  cursor: AccountListCursor | null = null,
  pageSize = ACCOUNT_LIST_PAGE_SIZE,
): Promise<AccountListPageData> {
  const rows = await dependencies.listAccountSummaries(pageSize + 1, cursor);
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: hasMore && lastItem
      ? { createdAt: lastItem.account.createdAt, id: lastItem.account.id }
      : null,
  };
}

export function mergeAccountListPageData(current: AccountListPageData, next: AccountListPageData): AccountListPageData {
  const items = new Map(current.items.map((item) => [item.account.id, item]));
  for (const item of next.items) items.set(item.account.id, item);
  return { items: [...items.values()], nextCursor: next.nextCursor };
}