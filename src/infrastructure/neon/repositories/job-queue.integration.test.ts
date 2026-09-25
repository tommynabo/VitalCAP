import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbCacheForTests, getDb } from "../db";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import {
  LostLeaseError,
  PermanentJobError,
  TransientJobError,
  claimDiscoveryJobs,
  completeDiscoveryJob,
  enqueueDiscoveryJob,
  failDiscoveryJob,
} from "./job-queue";

function isSafeIntegrationDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const safeHost = host === "localhost" || host === "127.0.0.1" || host.includes("test");
    const safeDbName = dbName.includes("test") || dbName.includes("ci") || dbName.includes("integration");
    return safeHost && safeDbName;
  } catch {
    return false;
  }
}

const integrationDatabaseUrl = process.env.JOB_QUEUE_INTEGRATION_DATABASE_URL;
const allowUnsafe = process.env.ALLOW_UNSAFE_QUEUE_ITESTS === "true";
const shouldRunIntegration =
  Boolean(integrationDatabaseUrl) && (allowUnsafe || isSafeIntegrationDatabaseUrl(integrationDatabaseUrl ?? ""));
const describeIntegration = shouldRunIntegration ? describe.sequential : describe.skip;

interface CampaignFixture {
  workspaceId: string;
  campaignId: string;
}

async function createCampaignFixture(status: "active" | "paused" | "draft" | "archived"): Promise<CampaignFixture> {
  const db = getDb();
  const workspaceName = `queue-itest-${status}-${randomUUID()}`;

  const workspaceResult = await db.execute(sql`
    INSERT INTO workspaces (name)
    VALUES (${workspaceName})
    RETURNING id;
  `);
  const workspaceId = (workspaceResult.rows[0] as { id: string }).id;

  const offerResult = await db.execute(sql`
    INSERT INTO offers (workspace_id, name, company, primary_cta, booking_url, active)
    VALUES (
      ${workspaceId}::uuid,
      'Queue Integration Offer',
      'VitalCAP',
      'Book meeting',
      'https://example.com/book',
      true
    )
    RETURNING id;
  `);
  const offerId = (offerResult.rows[0] as { id: string }).id;

  const campaignResult = await db.execute(sql`
    INSERT INTO campaigns (workspace_id, offer_id, name, status, engine_type)
    VALUES (
      ${workspaceId}::uuid,
      ${offerId}::uuid,
      'Queue Integration Campaign',
      ${status},
      'maps_fast'
    )
    RETURNING id;
  `);

  return {
    workspaceId,
    campaignId: (campaignResult.rows[0] as { id: string }).id,
  };
}

async function cleanupWorkspace(workspaceId: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid;`);
}

describeIntegration("job-queue integration (real postgres semantics)", () => {
  const createdWorkspaceIds = new Set<string>();
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousAppEnv = process.env.APP_ENV;
  const previousSeedMode = process.env.DEV_SEED_MODE;

  beforeAll(() => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.APP_ENV = "test";
    process.env.DEV_SEED_MODE = "false";
    resetServerEnvCacheForTests();
    resetDbCacheForTests();
  });

  afterAll(async () => {
    for (const workspaceId of createdWorkspaceIds) {
      await cleanupWorkspace(workspaceId);
    }

    process.env.DATABASE_URL = previousDatabaseUrl;
    process.env.APP_ENV = previousAppEnv;
    process.env.DEV_SEED_MODE = previousSeedMode;
    resetServerEnvCacheForTests();
    resetDbCacheForTests();
  });

  async function makeActiveCampaign(): Promise<CampaignFixture> {
    const fixture = await createCampaignFixture("active");
    createdWorkspaceIds.add(fixture.workspaceId);
    return fixture;
  }

  async function makePausedCampaign(): Promise<CampaignFixture> {
    const fixture = await createCampaignFixture("paused");
    createdWorkspaceIds.add(fixture.workspaceId);
    return fixture;
  }

  it("TEST 1: concurrent claim gives single owner", async () => {
    const campaign = await makeActiveCampaign();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const jobId = await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const [claimA, claimB] = await Promise.all([
      claimDiscoveryJobs({ workerId: `worker-a-${randomUUID()}`, batchSize: 1, now }),
      claimDiscoveryJobs({ workerId: `worker-b-${randomUUID()}`, batchSize: 1, now }),
    ]);

    const claimed = [...claimA, ...claimB];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(jobId);
  });

  it("TEST 2/3: expired lease can be reclaimed; old owner cannot complete; new owner can complete", async () => {
    const campaign = await makeActiveCampaign();
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const workerA = `worker-a-${randomUUID()}`;
    const workerB = `worker-b-${randomUUID()}`;

    const claimByA = await claimDiscoveryJobs({ workerId: workerA, batchSize: 1, now: t0, leaseMs: 1000 });
    expect(claimByA).toHaveLength(1);
    const job = claimByA[0]!;

    const claimByB = await claimDiscoveryJobs({ workerId: workerB, batchSize: 1, now: new Date(t0.getTime() + 2_000), leaseMs: 1000 });
    expect(claimByB).toHaveLength(1);
    expect(claimByB[0]?.id).toBe(job.id);

    await expect(completeDiscoveryJob({ jobId: job.id, workerId: workerA, now: new Date(t0.getTime() + 3_000) })).rejects.toBeInstanceOf(
      LostLeaseError,
    );

    await expect(
      completeDiscoveryJob({ jobId: job.id, workerId: workerB, now: new Date(t0.getTime() + 3_500) }),
    ).resolves.toBeUndefined();

    const db = getDb();
    const row = await db.execute(sql`SELECT status, next_attempt_at FROM discovery_jobs WHERE id = ${job.id}::uuid;`);
    const record = row.rows[0] as { status: string; next_attempt_at: string | null };
    expect(record.status).toBe("completed");
    expect(record.next_attempt_at).toBeNull();
  });

  it("TEST 5/6: transient failure schedules backoff and is only claimable after due time", async () => {
    const campaign = await makeActiveCampaign();
    const t0 = new Date("2026-01-01T01:00:00.000Z");

    await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const worker = `worker-${randomUUID()}`;
    const [job] = await claimDiscoveryJobs({ workerId: worker, batchSize: 1, now: t0 });
    expect(job).toBeTruthy();

    await failDiscoveryJob({
      workerId: worker,
      job: job!,
      error: new TransientJobError("temporary timeout"),
      now: t0,
    });

    const db = getDb();
    const row = await db.execute(sql`SELECT status, next_attempt_at FROM discovery_jobs WHERE id = ${job!.id}::uuid;`);
    const record = row.rows[0] as { status: string; next_attempt_at: string | null };
    expect(record.status).toBe("pending");
    expect(record.next_attempt_at).not.toBeNull();
    expect(new Date(record.next_attempt_at!).getTime()).toBeGreaterThan(t0.getTime());

    const tooEarly = await claimDiscoveryJobs({ workerId: `worker-early-${randomUUID()}`, batchSize: 1, now: new Date(t0.getTime() + 5_000) });
    expect(tooEarly).toHaveLength(0);

    const due = await claimDiscoveryJobs({ workerId: `worker-due-${randomUUID()}`, batchSize: 1, now: new Date(t0.getTime() + 31_000) });
    expect(due).toHaveLength(1);
    expect(due[0]?.id).toBe(job!.id);
  });

  it("TEST 7/8/9/10: permanent or max-attempt failure dead-letters once with source transition", async () => {
    const campaign = await makeActiveCampaign();
    const now = new Date("2026-01-01T02:00:00.000Z");

    const permanentJobId = await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const workerA = `worker-perm-${randomUUID()}`;
    const [permanentJob] = await claimDiscoveryJobs({ workerId: workerA, batchSize: 1, now });
    expect(permanentJob?.id).toBe(permanentJobId);

    await failDiscoveryJob({
      workerId: workerA,
      job: permanentJob!,
      error: new PermanentJobError("invalid payload"),
      now,
    });

    const db = getDb();
    const sourceRow = await db.execute(sql`SELECT status, next_attempt_at FROM discovery_jobs WHERE id = ${permanentJobId}::uuid;`);
    const deadLetterCount = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM dead_letter_jobs
      WHERE source_table = 'discovery_jobs' AND source_job_id = ${permanentJobId}::uuid;
    `);

    expect((sourceRow.rows[0] as { status: string }).status).toBe("dead_letter");
    expect((sourceRow.rows[0] as { next_attempt_at: string | null }).next_attempt_at).toBeNull();
    expect((deadLetterCount.rows[0] as { total: number }).total).toBe(1);

    await expect(
      failDiscoveryJob({
        workerId: workerA,
        job: permanentJob!,
        error: new PermanentJobError("duplicate failure call"),
        now: new Date(now.getTime() + 1000),
      }),
    ).rejects.toBeInstanceOf(LostLeaseError);

    const deadLetterCountAfterDuplicate = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM dead_letter_jobs
      WHERE source_table = 'discovery_jobs' AND source_job_id = ${permanentJobId}::uuid;
    `);
    expect((deadLetterCountAfterDuplicate.rows[0] as { total: number }).total).toBe(1);

    const maxAttemptJobId = await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
      maxAttempts: 1,
    });

    const workerB = `worker-max-${randomUUID()}`;
    const [maxAttemptJob] = await claimDiscoveryJobs({ workerId: workerB, batchSize: 1, now: new Date(now.getTime() + 60_000) });
    expect(maxAttemptJob?.id).toBe(maxAttemptJobId);

    await failDiscoveryJob({
      workerId: workerB,
      job: maxAttemptJob!,
      error: new TransientJobError("still failing"),
      now: new Date(now.getTime() + 61_000),
    });

    const maxAttemptSourceRow = await db.execute(sql`SELECT status FROM discovery_jobs WHERE id = ${maxAttemptJobId}::uuid;`);
    expect((maxAttemptSourceRow.rows[0] as { status: string }).status).toBe("dead_letter");
  });

  it("TEST 11: concurrent enqueue with same idempotency key yields one in-flight job", async () => {
    const campaign = await makeActiveCampaign();
    const idempotencyKey = `raw_candidate:${randomUUID()}`;

    const [jobA, jobB] = await Promise.all([
      enqueueDiscoveryJob({
        campaignId: campaign.campaignId,
        type: "run_engine_batch",
        payload: { engineType: "maps_fast" },
        idempotencyKey,
      }),
      enqueueDiscoveryJob({
        campaignId: campaign.campaignId,
        type: "run_engine_batch",
        payload: { engineType: "maps_fast" },
        idempotencyKey,
      }),
    ]);

    expect(jobA).toBe(jobB);

    const db = getDb();
    const countRows = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM discovery_jobs
      WHERE idempotency_key = ${idempotencyKey}
        AND status IN ('pending', 'processing');
    `);
    expect((countRows.rows[0] as { total: number }).total).toBe(1);
  });

  it("TEST 12/13: paused campaign cannot be claimed; active campaign can", async () => {
    const paused = await makePausedCampaign();
    const active = await makeActiveCampaign();
    const now = new Date("2026-01-01T03:00:00.000Z");

    await enqueueDiscoveryJob({
      campaignId: paused.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const pausedClaim = await claimDiscoveryJobs({ workerId: `worker-paused-${randomUUID()}`, batchSize: 5, now });
    expect(pausedClaim).toHaveLength(0);

    await enqueueDiscoveryJob({
      campaignId: active.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const activeClaim = await claimDiscoveryJobs({ workerId: `worker-active-${randomUUID()}`, batchSize: 5, now });
    expect(activeClaim).toHaveLength(1);
    expect(activeClaim[0]?.campaignId).toBe(active.campaignId);
  });

  it("TEST 14: completed and dead-letter jobs are never reclaimable", async () => {
    const campaign = await makeActiveCampaign();
    const now = new Date("2026-01-01T04:00:00.000Z");

    const completedJobId = await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const workerComplete = `worker-complete-${randomUUID()}`;
    const [completedJob] = await claimDiscoveryJobs({ workerId: workerComplete, batchSize: 1, now });
    expect(completedJob?.id).toBe(completedJobId);

    await completeDiscoveryJob({ jobId: completedJobId, workerId: workerComplete, now: new Date(now.getTime() + 1000) });

    const deadLetterJobId = await enqueueDiscoveryJob({
      campaignId: campaign.campaignId,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast" },
    });

    const workerDead = `worker-dead-${randomUUID()}`;
    const [deadLetterJob] = await claimDiscoveryJobs({ workerId: workerDead, batchSize: 1, now: new Date(now.getTime() + 2_000) });
    expect(deadLetterJob?.id).toBe(deadLetterJobId);

    await failDiscoveryJob({
      workerId: workerDead,
      job: deadLetterJob!,
      error: new PermanentJobError("fatal"),
      now: new Date(now.getTime() + 3_000),
    });

    const laterClaim = await claimDiscoveryJobs({ workerId: `worker-late-${randomUUID()}`, batchSize: 5, now: new Date(now.getTime() + 10_000) });
    const laterClaimIds = laterClaim.map((job) => job.id);

    expect(laterClaimIds).not.toContain(completedJobId);
    expect(laterClaimIds).not.toContain(deadLetterJobId);
  });
});
