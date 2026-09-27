import { getDb, schema } from "@/infrastructure/neon/db";
import { and, eq, isNull } from "drizzle-orm";
import { checkSuppression } from "./suppression";

export class OutreachReadinessService {
  async evaluateCandidate(
    workspaceId: string,
    campaignId: string,
    accountId: string,
    contactPointId: string,
  ): Promise<boolean> {
    const db = getDb();

    // 1. Workspace emergency stop
    const [autopilot] = await db.select({ emergencyStopped: schema.autopilotSettings.emergencyStopped })
      .from(schema.autopilotSettings)
      .where(eq(schema.autopilotSettings.workspaceId, workspaceId))
      .limit(1);
    if (autopilot?.emergencyStopped) return false;

    // 2. Campaign status
    const [campaign] = await db.select({ status: schema.campaigns.status })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId))
      .limit(1);
    if (!campaign || campaign.status !== "active") return false;

    // 3. Suppression
    const isSuppressed = await checkSuppression(workspaceId, { accountId, contactPointId });
    if (isSuppressed) return false;

    // 4. Qualification (Analyzed or deterministic)
    const [membership] = await db.select({ stage: schema.campaignMemberships.stage })
      .from(schema.campaignMemberships)
      .where(and(eq(schema.campaignMemberships.campaignId, campaignId), eq(schema.campaignMemberships.accountId, accountId)))
      .limit(1);
    
    if (!membership || (membership.stage !== "qualified" && membership.stage !== "ready")) return false;

    // 5. Verification status
    const [cp] = await db.select({ verificationStatus: schema.contactPoints.verificationStatus })
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.id, contactPointId))
      .limit(1);
    
    if (!cp || (cp.verificationStatus === "unverified" || cp.verificationStatus === "invalid" || cp.verificationStatus === "bounced")) return false;

    // 6. Current Compliance decision
    const [decision] = await db.select({ eligibilityAfter: schema.complianceDecisions.eligibilityAfter })
      .from(schema.complianceDecisions)
      .where(
        and(
          eq(schema.complianceDecisions.contactPointId, contactPointId),
          eq(schema.complianceDecisions.campaignId, campaignId),
          isNull(schema.complianceDecisions.supersededAt)
        )
      )
      .limit(1);

    if (!decision || decision.eligibilityAfter !== "allowed") return false;

    return true;
  }
}
