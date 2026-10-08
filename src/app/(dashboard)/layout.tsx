import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { computeNavBadgeCounts } from "@/components/layout/nav-badges";
import { getConversations, getEngineHealthSummary, getSendingDomains, getMailboxes } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const [conversations, engineHealthSummary, sendingDomains, mailboxes] = await Promise.all([
    getConversations(),
    getEngineHealthSummary(),
    getSendingDomains(),
    getMailboxes(),
  ]);
  const badgeCounts = computeNavBadgeCounts({ conversations, engineHealthSummary, sendingDomains, mailboxes });

  return <AppShell badgeCounts={badgeCounts}>{children}</AppShell>;
}

