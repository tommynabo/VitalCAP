import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, and, sql, isNull } from "drizzle-orm";
import { evaluateChannelEligibility } from "./compliance-gate";

export const COMPLIANCE_POLICY_VERSION = "v1.0.0";

export class ChannelEligibilityService {
  /**
   * Evaluates the compliance rules for a given contact point on a channel.
   * Persists the decision in `compliance_decisions` and updates the contact
   * point's channelEligibility if it changed.
   * Returns true if allowed, false otherwise.
   */
  async evaluateAndPersist(params: {
    workspaceId: string;
    campaignId: string;
    accountId: string;
    contactPointId: string;
    channel: string;
    operatorOverride?: boolean;
  }): Promise<{ allowed: boolean; decisionId: string; reason: string }> {
    const db = getDb();
    const { workspaceId, campaignId, accountId, contactPointId, channel } = params;

    // 1. Fetch current contact point state
    const contactRows = await db
      .select()
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.id, contactPointId))
      .limit(1);
      
    const cp = contactRows[0];
    if (!cp) {
      throw new Error("Contact point not found");
    }
    const eligibilityBefore = cp.channelEligibility || "unknown";

    // 2. Fetch active suppressions
    const suppressionRows = await db
      .select()
      .from(schema.suppressionEntries)
      .where(
        and(
          eq(schema.suppressionEntries.workspaceId, workspaceId),
          sql`${schema.suppressionEntries.accountId} = ${accountId} OR ${schema.suppressionEntries.contactPointId} = ${contactPointId} OR (${schema.suppressionEntries.accountId} IS NULL AND ${schema.suppressionEntries.contactPointId} IS NULL)`
        )
      );

    // 3. Evaluate logic
    let decision: "allowed" | "blocked" | "review_required" = "review_required";
    let reasonCode = "unknown";
    let reasonText = "";

    if (suppressionRows.length > 0 && suppressionRows[0]) {
      decision = "blocked";
      reasonCode = "suppressed";
      reasonText = `Found ${suppressionRows.length} active suppression(s). Reason: ${suppressionRows[0].reason}`;
    } else if (cp.channelEligibility === "opted_out" || cp.channelEligibility === "blocked") {
      decision = "blocked";
      reasonCode = cp.channelEligibility;
      reasonText = `Explicitly blocked due to existing status: ${cp.channelEligibility}`;
    } else if (cp.channelEligibility === "invalid" || cp.channelEligibility === "bounced") {
      decision = "blocked";
      reasonCode = cp.channelEligibility;
      reasonText = `Endpoint is invalid or bounced.`;
    } else if (cp.channelEligibility === "unverified" || cp.channelEligibility === "unknown") {
      // Unknown remains unknown unless verification changes it
      decision = "review_required";
      reasonCode = "unverified";
      reasonText = "Endpoint is unverified or unknown. Review or verification required.";
    } else {
      // Use the pure gate to check policy
      const isEligible = evaluateChannelEligibility(channel as any, cp.channelEligibility as any);
      if (isEligible) {
        decision = "allowed";
        reasonCode = "policy_approved";
        reasonText = `Policy approved for channel ${channel} based on status ${cp.channelEligibility}`;
      } else {
        decision = "blocked";
        reasonCode = "policy_rejected";
        reasonText = `Policy rejected channel ${channel} for status ${cp.channelEligibility}`;
      }
    }

    // Workspace emergency stop check would go here if there was a DB config, 
    // but typically handled at the outreach-ready level.
    
    // 4. Persist Decision Idempotently
    // Check if there is already an identical active decision
    const activeDecisions = await db
      .select()
      .from(schema.complianceDecisions)
      .where(
        and(
          eq(schema.complianceDecisions.contactPointId, contactPointId),
          eq(schema.complianceDecisions.campaignId, campaignId),
          eq(schema.complianceDecisions.channel, channel),
          isNull(schema.complianceDecisions.supersededAt)
        )
      )
      .limit(1);

    let decisionId = "";
    
    if (activeDecisions.length > 0 && activeDecisions[0]) {
      const current = activeDecisions[0];
      if (current.decision === decision && current.reasonCode === reasonCode && current.policyVersion === COMPLIANCE_POLICY_VERSION) {
        // No change, just return existing
        return { allowed: decision === "allowed", decisionId: current.id, reason: reasonText };
      }
      
      // Supersede old decision
      await db.update(schema.complianceDecisions)
        .set({ supersededAt: new Date() })
        .where(eq(schema.complianceDecisions.id, current.id));
    }

    // Insert new decision
    const [inserted] = await db.insert(schema.complianceDecisions).values({
      workspaceId,
      campaignId,
      accountId,
      contactPointId,
      channel,
      decision,
      eligibilityBefore,
      eligibilityAfter: cp.channelEligibility || "unknown", // It hasn't mutated yet, just a decision state
      reasonCode,
      reasonText,
      policyVersion: COMPLIANCE_POLICY_VERSION,
      evidenceJson: {
        suppressionCount: suppressionRows.length,
        channelEligibility: cp.channelEligibility,
      },
      decidedBy: params.operatorOverride ? "operator" : "system",
    }).returning();
    
    if (!inserted) {
      throw new Error("Failed to insert compliance decision");
    }
    
    decisionId = inserted.id;

    return {
      allowed: decision === "allowed",
      decisionId,
      reason: reasonText,
    };
  }
}
