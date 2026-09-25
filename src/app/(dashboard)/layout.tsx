import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { computeNavBadgeCounts } from "@/components/layout/nav-badges";
import { getConversations, getEngineTargets, getSendingDomains, getMailboxes } from "@/lib/data/repository";

export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const [conversations, engineTargets, sendingDomains, mailboxes] = await Promise.all([
    getConversations(),
    getEngineTargets(),
    getSendingDomains(),
    getMailboxes(),
  ]);
  const badgeCounts = computeNavBadgeCounts({ conversations, engineTargets, sendingDomains, mailboxes });

  return <AppShell badgeCounts={badgeCounts}>{children}</AppShell>;
}

