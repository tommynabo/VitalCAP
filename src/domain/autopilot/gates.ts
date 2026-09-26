import type { AutopilotEffectiveState } from "./types";

export function allowsDiscovery(state: AutopilotEffectiveState): boolean {
  return state === "running";
}

export function allowsNewApifyRun(state: AutopilotEffectiveState): boolean {
  return state === "running";
}

export function allowsProcessingClaim(state: AutopilotEffectiveState): boolean {
  return state !== "emergency_stopped";
}

export function allowsOutreachScheduling(state: AutopilotEffectiveState): boolean {
  return state !== "emergency_stopped";
}
