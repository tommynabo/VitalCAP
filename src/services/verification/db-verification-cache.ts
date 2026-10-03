import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, and, sql } from "drizzle-orm";
import type { EmailVerificationCacheStore, CachedVerification } from "./email-verification-cache";
import type { EmailVerificationCode } from "@/domain/providers/types";
import { EMAIL_VERIFICATION_PIPELINE_VERSION } from "@/domain/providers/email-verification-idempotency";

export class DbVerificationCacheStore implements EmailVerificationCacheStore {
  constructor(private workspaceId: string, private providerName: string) {}

  async get(email: string): Promise<CachedVerification | undefined> {
    const db = getDb();
    const [row] = await db.select()
      .from(schema.emailVerifications)
      .where(
        and(
          eq(schema.emailVerifications.workspaceId, this.workspaceId),
          eq(schema.emailVerifications.normalizedEmail, email),
          eq(schema.emailVerifications.provider, this.providerName),
          eq(schema.emailVerifications.pipelineVersion, EMAIL_VERIFICATION_PIPELINE_VERSION),
        )
      )
      .limit(1);

    if (!row) return undefined;

    return {
      email: row.normalizedEmail,
      code: row.status as EmailVerificationCode,
      providerRawCode: row.providerRawCode ?? "",
      costUsd: row.cost ?? 0,
      checkedAt: row.checkedAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : new Date().toISOString(),
    };
  }

  async set(email: string, value: CachedVerification): Promise<void> {
    const db = getDb();
    await db.insert(schema.emailVerifications)
      .values({
        workspaceId: this.workspaceId,
        normalizedEmail: email,
        provider: this.providerName,
        pipelineVersion: EMAIL_VERIFICATION_PIPELINE_VERSION,
        status: value.code,
        providerRawCode: value.providerRawCode,
        checkedAt: new Date(value.checkedAt),
        expiresAt: new Date(value.expiresAt),
        cost: value.costUsd,
      })
      .onConflictDoUpdate({
        target: [
          schema.emailVerifications.workspaceId,
          schema.emailVerifications.normalizedEmail,
          schema.emailVerifications.provider,
          schema.emailVerifications.pipelineVersion,
        ],
        set: {
          status: value.code,
          providerRawCode: value.providerRawCode,
          checkedAt: new Date(value.checkedAt),
          expiresAt: new Date(value.expiresAt),
          cost: value.costUsd,
        }
      });
  }
}
