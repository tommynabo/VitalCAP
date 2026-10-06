import { getDb, schema } from "@/infrastructure/neon/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ChannelEligibilityStatus, VerificationStatus } from "@/domain/contacts/types";
import { getEmailComplianceEnv, getVerificationEnv } from "@/lib/config/env";
import { checkSuppression } from "@/services/compliance/suppression";
import {
  evaluateB2BEmailCompliance,
  VITALCAP_B2B_EMAIL_POLICY_VERSION,
} from "@/services/compliance/email-channel-policy";

export async function evaluateComplianceForAccount(workspaceId: string, accountId: string): Promise<void> {
  const db = getDb();
  const memberships = await db
    .select({
      id: schema.campaignMemberships.id,
      campaignId: schema.campaignMemberships.campaignId,
      stage: schema.campaignMemberships.stage,
    })
    .from(schema.campaignMemberships)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignMemberships.campaignId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.campaignMemberships.accountId))
    .where(and(
      eq(schema.campaignMemberships.accountId, accountId),
      eq(schema.campaigns.workspaceId, workspaceId),
      eq(schema.accounts.workspaceId, workspaceId),
    ));

  const contactPoints = await db
    .select()
    .from(schema.contactPoints)
    .where(and(
      eq(schema.contactPoints.workspaceId, workspaceId),
      eq(schema.contactPoints.accountId, accountId),
      eq(schema.contactPoints.type, "email"),
    ));

  const allowCatchAll = getVerificationEnv().EMAIL_VERIFICATION_ALLOW_CATCH_ALL;
  const policyApproved = getEmailComplianceEnv().VITALCAP_B2B_EMAIL_POLICY_APPROVED;

  for (const membership of memberships) {
    if (membership.stage !== "qualified" && membership.stage !== "contact_selected" && membership.stage !== "ready") continue;

    for (const contactPoint of contactPoints) {
      const isSuppressed = await checkSuppression(workspaceId, {
        accountId,
        contactPointId: contactPoint.id,
      });
      const policyDecision = evaluateB2BEmailCompliance({
        channelEligibility: contactPoint.channelEligibility as ChannelEligibilityStatus,
        verificationStatus: contactPoint.verificationStatus as VerificationStatus,
        isSuppressed,
        allowCatchAll,
        policyApproved,
      });

      const [activeDecision] = await db
        .select()
        .from(schema.complianceDecisions)
        .where(and(
          eq(schema.complianceDecisions.workspaceId, workspaceId),
          eq(schema.complianceDecisions.contactPointId, contactPoint.id),
          eq(schema.complianceDecisions.campaignId, membership.campaignId),
          eq(schema.complianceDecisions.channel, "email"),
          isNull(schema.complianceDecisions.supersededAt),
        ))
        .limit(1);

      if (activeDecision
        && activeDecision.decision === policyDecision.decision
        && activeDecision.reasonCode === policyDecision.reasonCode
        && activeDecision.policyVersion === VITALCAP_B2B_EMAIL_POLICY_VERSION) {
        continue;
      }

      if (activeDecision) {
        await db.update(schema.complianceDecisions)
          .set({ supersededAt: new Date() })
          .where(eq(schema.complianceDecisions.id, activeDecision.id));
      }

      await db.insert(schema.complianceDecisions).values({
        workspaceId,
        campaignId: membership.campaignId,
        accountId,
        contactPointId: contactPoint.id,
        channel: "email",
        decision: policyDecision.decision,
        eligibilityBefore: contactPoint.channelEligibility,
        eligibilityAfter: policyDecision.decision,
        reasonCode: policyDecision.reasonCode,
        reasonText: policyDecision.reasonText,
        policyVersion: VITALCAP_B2B_EMAIL_POLICY_VERSION,
        evidenceJson: {
          channelEligibility: contactPoint.channelEligibility,
          verificationStatus: contactPoint.verificationStatus,
          isSuppressed,
          allowCatchAll,
          policyApproved,
        },
        decidedBy: "system",
      });
    }

    const { selectPrimaryContact } = await import("./contact-selector");
    const selectedContactPointId = await selectPrimaryContact(workspaceId, membership.campaignId, accountId);

    if (selectedContactPointId) {
      await db.update(schema.campaignMemberships)
        .set({ selectedContactPointId })
        .where(eq(schema.campaignMemberships.id, membership.id));

      const { OutreachReadinessService } = await import("@/services/compliance/outreach-readiness-service");
      const isReady = await new OutreachReadinessService().evaluateCandidate(
        workspaceId,
        membership.campaignId,
        accountId,
        selectedContactPointId,
      );

      if (isReady && membership.stage !== "ready") {
        await db.update(schema.campaignMemberships)
          .set({ stage: "ready", readyAt: new Date(), rejectionReason: null })
          .where(eq(schema.campaignMemberships.id, membership.id));
      } else if (!isReady && membership.stage === "ready") {
        await db.update(schema.campaignMemberships)
          .set({ stage: "qualified", readyAt: null, rejectionReason: "compliance_blocked" })
          .where(eq(schema.campaignMemberships.id, membership.id));
      }
      continue;
    }

    const reason = contactPoints.length === 0
      ? "no_email"
      : contactPoints.every((point) => ["invalid", "disposable", "bounced"].includes(point.verificationStatus))
        ? "invalid"
        : contactPoints.some((point) => point.channelEligibility === "opted_out" || point.channelEligibility === "blocked")
          ? "compliance_blocked"
          : contactPoints.some((point) => point.verificationStatus === "risky" || point.verificationStatus === "catch_all")
            ? "risky"
            : "unverified";
    await db.update(schema.campaignMemberships)
      .set({
        stage: membership.stage === "ready" ? "qualified" : membership.stage,
        readyAt: null,
        selectedContactPointId: null,
        rejectionReason: reason,
      })
      .where(eq(schema.campaignMemberships.id, membership.id));
  }
}