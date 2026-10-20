import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildDeadLetterAggregateQuery, buildWebsiteRecoveryAttributionQuery } from "./production-capacity-diagnostics-sql";

const dialect = new PgDialect();

describe("dead-letter diagnostics SQL", () => {
  it("groups workspace dead letters by queue, engine, normalized class, and age", () => {
    const query = dialect.sqlToQuery(buildDeadLetterAggregateQuery("workspace-id", new Date("2026-10-18T12:00:00.000Z")));

    expect(query.sql).toContain("GROUP BY queue_type, engine, failure_class, age_bucket");
    expect(query.sql).toContain("'lt_24h'");
    expect(query.sql).toContain("'1_3d'");
    expect(query.sql).toContain("'3_7d'");
    expect(query.sql).toContain("'gt_7d'");
    expect(query.sql).toContain("'reservation_parameter_typing'");
    expect(query.sql).toContain("'provider_authentication'");
    expect(query.sql).toContain("FROM verification_jobs verification_job");
    expect(query.sql).toContain("FROM intelligence_jobs intelligence_job");
    expect(query.params).toContain("workspace-id");
    expect(query.params).toContain("2026-10-18T12:00:00.000Z");
  });

  it("returns only aggregate grouping fields and never projects error or payload data", () => {
    const query = dialect.sqlToQuery(buildDeadLetterAggregateQuery("workspace-id", new Date("2026-10-18T12:00:00.000Z")));
    const projection = query.sql.slice(query.sql.lastIndexOf("SELECT queue_type"));

    expect(projection).toMatch(/^SELECT queue_type, engine, failure_class, age_bucket, COUNT\(\*\)::int AS count/);
    expect(projection).not.toMatch(/last_error|payload|source_url|normalized_value/i);
  });
});

describe("website recovery attribution SQL", () => {
  it("joins recovered candidates only to contact points created during that candidate's persisted attribution window", () => {
    const query = dialect.sqlToQuery(buildWebsiteRecoveryAttributionQuery({
      workspaceId: "workspace-id",
      targetProviderCampaignId: "provider-campaign-id",
      periods: [{
        name: "new_cohort",
        start: new Date("2026-10-20T08:00:00.000Z"),
        end: new Date("2026-10-20T09:00:00.000Z"),
      }],
    }));

    expect(query.sql).toContain("raw.processing_metrics->>'websiteOrigin' = 'recovered'");
    expect(query.sql).toContain("contact_point.created_at >= scope.attribution_started_at");
    expect(query.sql).toContain("contact_point.created_at <= scope.attribution_completed_at");
    expect(query.sql).toContain("membership.selected_contact_point_id = contact_point.id");
    expect(query.sql).toContain("imported.contact_point_id = contact_point.id");
    expect(query.sql).toContain("contact_point.source_url");
    expect(query.sql).toContain("competing_raw.id <> scope.raw_id");
    expect(query.sql).toContain("competing_raw.processing_metrics->>'recoveredWebsiteDomain'");
    expect(query.sql).toContain("FROM instantly_lead_imports imported");
    expect(query.sql).toContain("imported.uploaded_at >= scope.attribution_completed_at");
    expect(query.sql).toContain("NULLIF(scope.metrics->>'websiteAttributionStartedAt', '') IS NOT NULL");
    expect(query.sql).toContain("NULLIF(scope.metrics->>'websiteAttributionCompletedAt', '') IS NOT NULL");
    expect(query.sql).toContain("NOT EXISTS (");
    expect(query.sql).toContain("websiteEmailAttributionComplete");
    expect(query.params).toContain("workspace-id");
    expect(query.params).toContain("provider-campaign-id");
    expect(query.params).toContain("2026-10-20T08:00:00.000Z");
  });

  it("returns aggregate classifications without projecting email values or raw payloads", () => {
    const query = dialect.sqlToQuery(buildWebsiteRecoveryAttributionQuery({
      workspaceId: "workspace-id",
      targetProviderCampaignId: null,
      periods: [{ name: "rolling7d", start: new Date(0), end: new Date(60_000) }],
    }));
    const projection = query.sql.slice(query.sql.lastIndexOf("SELECT scope.window"));

    expect(projection).toContain("recovered_email_found");
    expect(projection).toContain("selected_email_deobfuscated");
    expect(projection).not.toMatch(/normalized_value|raw_payload|source_url/i);
  });
});