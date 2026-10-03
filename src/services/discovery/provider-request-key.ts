import { createHash } from "node:crypto";

export interface ProviderRequestIdentity {
  workspaceId: string;
  campaignId: string;
  engineType: string;
  provider: string;
  query: string;
  planningWindow: string;
}

export function normalizeProviderQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function currentProviderPlanningWindow(now = new Date(), windowMinutes = 15): string {
  const windowMs = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString().slice(0, 16);
}

export function nextProviderPlanningWindowAt(now = new Date(), windowMinutes = 15): Date {
  const windowMs = windowMinutes * 60_000;
  return new Date((Math.floor(now.getTime() / windowMs) + 1) * windowMs);
}

export function createProviderRequestKey(identity: ProviderRequestIdentity): string {
  const normalizedIdentity = [
    identity.workspaceId,
    identity.campaignId,
    identity.engineType,
    identity.provider,
    normalizeProviderQuery(identity.query),
    identity.planningWindow,
  ];
  const digest = createHash("sha256").update(JSON.stringify(normalizedIdentity)).digest("hex");
  return `${identity.provider}:${digest}`;
}