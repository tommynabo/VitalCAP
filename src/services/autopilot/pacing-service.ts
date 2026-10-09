/**
 * Pacing (Prompt 2 §2.11): compares actual `readyToday` against a linear
 * trajectory across the campaign's Europe/Madrid operating window and
 * suggests how much to scale discovery batch sizes up/down. Pure — the
 * caller (Autopilot Scheduler) decides what to actually do with the
 * suggested multiplier.
 */

export interface OperatingWindow {
  /** Local (Europe/Madrid) hour the operating window opens, 0–23. */
  startHour: number;
  /** Local (Europe/Madrid) hour the operating window closes, 0–23. */
  endHour: number;
}

/** Production discovery window in the configured workspace timezone. */
export const DEFAULT_OPERATING_WINDOW: OperatingWindow = { startHour: 7, endHour: 22 };

export type PacingStatus = "before_window" | "after_window" | "on_pace" | "behind_pace" | "budget_paused" | "provider_paused";
type LegacyPacingStatus = "behind" | "ahead" | "on_track";

export interface AutopilotPacingState {
  workspaceId: string;
  timeZone: string;
  targetMetric: "qualified" | "analyzed_qualified" | "outreach_ready" | "instantly_imported";
  dailyTarget: number;
  targetAchievedToday: number;
  remainingTarget: number;
  discoveredToday: number;
  withEmailToday: number;
  validEmailToday: number;
  eligibleToday: number;
  operatingStart: string;
  operatingEnd: string;
  now: Date;
  elapsedOperatingFraction: number;
  expectedAchievedByNow: number;
  paceDeficit: number;
  qualifiedToday: number;
  instantlyImportedToday: number;
  eligibleImportBacklog: number;
  verificationInFlight: number;
  expectedImportsFromBacklog: number;
  rawRequestedToday: number;
  rawRequestCap: number | null;
  rawRequestsRemaining: number;
  estimatedRawDemand: number;
  capacityConstrained: boolean;
  rawReturnedToday: number;
  processingInFlight: number;
  providerRunsInFlight: number;
  expectedQualifiedFromInFlight: number;
  hoursRemaining: number;
  apifySpendToday: number;
  apifyDailyBudgetRemaining: number;
  providerHealth: "untested" | "healthy" | "degraded" | "paused" | "unknown";
  status: PacingStatus;
  targetNeededToPlan: number;
  rawNeededToPlan: number;
  estimatedYield: number;
  yieldSampleSize: number;
  explanation: string;
}

export type AutopilotTargetRisk = "on_track" | "recoverable" | "target_at_risk_budget" | "target_at_risk_provider" | "target_at_risk_time";

export function classifyAutopilotTargetRisk(
  pacing: Pick<AutopilotPacingState, "status" | "hoursRemaining" | "remainingTarget">,
): AutopilotTargetRisk {
  if (pacing.status === "on_pace" || pacing.status === "before_window") return "on_track";
  if (pacing.status === "budget_paused") return "target_at_risk_budget";
  if (pacing.status === "provider_paused") return "target_at_risk_provider";
  if (pacing.hoursRemaining <= 2 && pacing.remainingTarget > 0) return "target_at_risk_time";
  return "recoverable";
}

export interface PacingResult {
  status: LegacyPacingStatus;
  madridHour: number;
  expectedReadyByNow: number;
  actualReady: number;
  varianceRatio: number;
  /** >1 to widen discovery batches, <1 to shrink them, 1 to hold steady. */
  suggestedBatchMultiplier: number;
}

/** Hour-of-day (0–23) in Europe/Madrid for `date`, independent of the server's own timezone. */
export function madridHourOf(date: Date): number {
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(date);
  return Number(formatted) % 24;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computePacing(
  dailyTarget: number,
  actualReady: number,
  now: Date,
  window: OperatingWindow = DEFAULT_OPERATING_WINDOW,
): PacingResult {
  const madridHour = madridHourOf(now);
  const elapsedFraction = clamp((madridHour - window.startHour) / (window.endHour - window.startHour), 0, 1);
  const expectedReadyByNow = Math.round(dailyTarget * elapsedFraction);
  const varianceRatio = expectedReadyByNow > 0 ? actualReady / expectedReadyByNow : 1;

  if (varianceRatio < 0.9) {
    return {
      status: "behind",
      madridHour,
      expectedReadyByNow,
      actualReady,
      varianceRatio,
      suggestedBatchMultiplier: clamp(1 + (0.9 - varianceRatio), 1, 2),
    };
  }
  if (varianceRatio > 1.15) {
    return {
      status: "ahead",
      madridHour,
      expectedReadyByNow,
      actualReady,
      varianceRatio,
      suggestedBatchMultiplier: clamp(1 - (varianceRatio - 1), 0.4, 1),
    };
  }
  return { status: "on_track", madridHour, expectedReadyByNow, actualReady, varianceRatio, suggestedBatchMultiplier: 1 };
}

function localWallClock(date: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  return { hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0), minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0) };
}

export interface PacingComputationInput {
  workspaceId: string;
  timeZone: string;
  targetMetric?: AutopilotPacingState["targetMetric"];
  dailyTarget: number;
  targetAchievedToday: number;
  discoveredToday?: number;
  withEmailToday?: number;
  validEmailToday?: number;
  eligibleToday?: number;
  qualifiedToday?: number;
  instantlyImportedToday?: number;
  eligibleImportBacklog?: number;
  verificationInFlight?: number;
  rawRequestedToday: number;
  rawReturnedToday: number;
  processingInFlight: number;
  providerRunsInFlight: number;
  expectedQualifiedFromInFlight: number;
  expectedImportsFromBacklog?: number;
  apifySpendToday: number;
  apifyDailyBudgetRemaining: number;
  providerHealth: AutopilotPacingState["providerHealth"];
  /** True if at least one configured, eligible engine can accept discovery. */
  availableDiscoveryCapacity?: boolean;
  estimatedYield: number;
  yieldSampleSize: number;
  now: Date;
  operatingStartHour?: number | null;
  operatingEndHour?: number | null;
  maxDailyRawRequests?: number | null;
}

export function computeAutopilotPacing(input: PacingComputationInput): AutopilotPacingState {
  const targetMetric = input.targetMetric ?? "qualified";
  const startHour = input.operatingStartHour ?? DEFAULT_OPERATING_WINDOW.startHour;
  const endHour = input.operatingEndHour ?? DEFAULT_OPERATING_WINDOW.endHour;
  const startMinutes = startHour * 60;
  const endMinutes = endHour * 60;
  const { hour, minute } = localWallClock(input.now, input.timeZone);
  const nowMinutes = hour * 60 + minute;
  const windowLength = Math.max(1, endMinutes - startMinutes);
  const elapsedOperatingFraction = Math.min(1, Math.max(0, (nowMinutes - startMinutes) / windowLength));
  const expectedAchievedByNow = input.dailyTarget * elapsedOperatingFraction;
  const remainingTarget = Math.max(0, input.dailyTarget - input.targetAchievedToday);
  const expectedImportsFromBacklog = Math.max(0, input.expectedImportsFromBacklog ?? 0);
  const expectedProgressFromInFlight = targetMetric === "instantly_imported"
    ? expectedImportsFromBacklog
    : input.expectedQualifiedFromInFlight;
  const paceDeficit = Math.max(0, expectedAchievedByNow - input.targetAchievedToday - expectedProgressFromInFlight);
  const minimumYield = targetMetric === "instantly_imported" ? 0.02 : 0.1;
  const maximumYield = targetMetric === "instantly_imported" ? 0.5 : 1;
  const boundedYield = Math.max(minimumYield, Math.min(maximumYield, input.estimatedYield || 0));
  const windowClosed = nowMinutes < startMinutes || nowMinutes >= endMinutes;
  const hasCapacity = input.availableDiscoveryCapacity ?? (input.providerHealth !== "paused" && input.apifyDailyBudgetRemaining > 0);
  const targetNeededToPlan = windowClosed || !hasCapacity
    ? 0
    : Math.min(remainingTarget, Math.ceil(paceDeficit * 1.1));
  
  const rawRequestCap = typeof input.maxDailyRawRequests === "number" ? input.maxDailyRawRequests : null;
  const rawRemainingToday = rawRequestCap !== null
    ? Math.max(0, rawRequestCap - input.rawRequestedToday)
    : 1000;
  // Keep the daily guard as the only global raw cap. The target planner then
  // turns this into bounded, idempotent planning-window orders. A fixed 100
  // here made a 250-qualified/day target mathematically unreachable at
  // ordinary yield rates.
  const estimatedRawDemand = targetMetric === "instantly_imported"
    ? Math.ceil(Math.max(0, remainingTarget - expectedProgressFromInFlight) / boundedYield)
    : targetNeededToPlan > 0 ? Math.ceil(targetNeededToPlan / boundedYield) : 0;
  const rawNeededToPlan = targetNeededToPlan > 0
    ? Math.min(rawRemainingToday, Math.ceil(targetNeededToPlan / boundedYield))
    : 0;
  const capacityConstrained = estimatedRawDemand > rawRemainingToday;
  
  const hoursRemaining = Math.max(0, (endMinutes - nowMinutes) / 60);
  const status: PacingStatus = nowMinutes < startMinutes
    ? "before_window"
    : nowMinutes >= endMinutes
      ? "after_window"
      : !hasCapacity
          ? (input.apifyDailyBudgetRemaining <= 0 && input.providerHealth !== "paused" ? "budget_paused" : "provider_paused")
          : paceDeficit > 0
            ? "behind_pace"
            : "on_pace";
  const targetLabel = targetMetric === "instantly_imported" ? "Instantly imports" : "qualified prospects";
  const explanation = status === "behind_pace"
    ? `Behind pace by ${Math.ceil(paceDeficit)} ${targetLabel}. Estimated yield ${Math.round(boundedYield * 100)}%.`
    : status === "on_pace"
      ? "On pace. Existing progress and in-flight work are sufficient for the current checkpoint."
    : status === "budget_paused"
        ? "All available discovery budgets are exhausted; no new paid discovery is scheduled."
        : status === "provider_paused"
          ? "No configured discovery engine is currently eligible; no new discovery is scheduled."
          : status === "before_window"
            ? "Before the operating window; no new paid discovery is scheduled."
            : "After the operating window; existing processing and provider polling may continue.";

  return {
    workspaceId: input.workspaceId,
    timeZone: input.timeZone,
    targetMetric,
    dailyTarget: input.dailyTarget,
    targetAchievedToday: input.targetAchievedToday,
    remainingTarget,
    discoveredToday: input.discoveredToday ?? 0,
    withEmailToday: input.withEmailToday ?? 0,
    validEmailToday: input.validEmailToday ?? 0,
    eligibleToday: input.eligibleToday ?? 0,
    operatingStart: `${String(startHour).padStart(2, "0")}:00`,
    operatingEnd: `${String(endHour).padStart(2, "0")}:00`,
    now: input.now,
    elapsedOperatingFraction,
    expectedAchievedByNow,
    paceDeficit,
    qualifiedToday: input.qualifiedToday ?? input.targetAchievedToday,
    instantlyImportedToday: input.instantlyImportedToday ?? 0,
    eligibleImportBacklog: input.eligibleImportBacklog ?? 0,
    verificationInFlight: input.verificationInFlight ?? 0,
    expectedImportsFromBacklog,
    rawRequestedToday: input.rawRequestedToday,
    rawRequestCap,
    rawRequestsRemaining: rawRemainingToday,
    estimatedRawDemand,
    capacityConstrained,
    rawReturnedToday: input.rawReturnedToday,
    processingInFlight: input.processingInFlight,
    providerRunsInFlight: input.providerRunsInFlight,
    expectedQualifiedFromInFlight: input.expectedQualifiedFromInFlight,
    hoursRemaining,
    apifySpendToday: input.apifySpendToday,
    apifyDailyBudgetRemaining: input.apifyDailyBudgetRemaining,
    providerHealth: input.providerHealth,
    status,
    targetNeededToPlan,
    rawNeededToPlan,
    estimatedYield: boundedYield,
    yieldSampleSize: input.yieldSampleSize,
    explanation,
  };
}
