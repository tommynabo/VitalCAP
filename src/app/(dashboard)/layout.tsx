import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { computeNavBadgeCounts } from "@/components/layout/nav-badges";
import { getEngineHealthSummary, getInfrastructureAlertCountData, getPendingReviewCountData } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const [pendingReviewCount, engineHealthSummary, infrastructureAlertCount] = await Promise.all([
    getPendingReviewCountData(),
    getEngineHealthSummary(),
    getInfrastructureAlertCountData(),
  ]);
  const badgeCounts = computeNavBadgeCounts({ pendingReviewCount, engineHealthSummary, infrastructureAlertCount });

  return <AppShell badgeCounts={badgeCounts}>{children}</AppShell>;
}

