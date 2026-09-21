"use client";

import { useMemo } from "react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { seedConversations, seedMeetings, seedSetterDrafts, seedSetterFeedback } from "@/lib/seed/dev-seed";
import { computeBranchPerformance, computeSetterAnalytics } from "@/services/setter/feedback-analytics";

/**
 * AI Setter dashboard (Prompt 4 §4.11). KPI row (pending review, approved
 * today, edited today, rejected, meetings generated, branch accuracy,
 * response latency) plus a branch performance table, computed from the
 * shared `feedback-analytics.ts` service so this page and any future
 * reporting surface never re-derive the same numbers twice.
 */
export default function SetterPage() {
  const analytics = useMemo(
    () =>
      computeSetterAnalytics({
        feedback: seedSetterFeedback,
        drafts: seedSetterDrafts,
        meetingsBookedCount: seedMeetings.length,
      }),
    [],
  );

  const branchPerformance = useMemo(() => computeBranchPerformance(seedSetterFeedback, seedSetterDrafts), []);

  const pendingReview = seedConversations.filter((conversation) => conversation.state === "pending_review").length;
  const approvedToday = seedSetterFeedback.filter((feedback) => feedback.decision === "approve").length;
  const editedToday = seedSetterFeedback.filter((feedback) => feedback.decision === "edit_and_send").length;
  const rejectedToday = seedSetterFeedback.filter((feedback) => feedback.decision === "reject").length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Setter</CardTitle>
          <Badge variant="primary">Prompt 4</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-muted">
            Reply ingestion, deterministic pre-router, LLM classification and the human-in-the-loop review workflow. Autosend
            is prepared but disabled by default (§4.9).
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Pending review" value={String(pendingReview)} emphasize />
        <KpiStat label="Approved today" value={String(approvedToday)} />
        <KpiStat label="Edited today" value={String(editedToday)} />
        <KpiStat label="Rejected today" value={String(rejectedToday)} />
        <KpiStat label="Meetings generated" value={String(seedMeetings.length)} />
        <KpiStat label="Branch accuracy" value={`${Math.round(analytics.branchAccuracy * 100)}%`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Branch performance</CardTitle>
        </CardHeader>
        <CardContent>
          {branchPerformance.length === 0 ? (
            <p className="text-sm text-text-muted">No reviewed drafts yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-text-muted">
                  <th className="pb-2">Branch</th>
                  <th className="pb-2">Count</th>
                  <th className="pb-2">Accuracy</th>
                  <th className="pb-2">Avg. confidence</th>
                </tr>
              </thead>
              <tbody>
                {branchPerformance.map((row) => (
                  <tr key={row.branch} className="border-t border-border">
                    <td className="py-2">
                      <Badge variant="primary">{row.branch}</Badge>
                    </td>
                    <td className="py-2 text-text">{row.count}</td>
                    <td className="py-2 text-text">{Math.round(row.accuracy * 100)}%</td>
                    <td className="py-2 text-text">{Math.round(row.averageConfidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
