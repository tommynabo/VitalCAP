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

export const DEFAULT_OPERATING_WINDOW: OperatingWindow = { startHour: 8, endHour: 20 };

export type PacingStatus = "before_window" | "after_window" | "on_pace" | "behind_pace" | "budget_paused" | "provider_paused";
type LegacyPacingStatus = "behind" | "ahead" | "on_track";

export interface AutopilotPacingState {
  workspaceId: string;
  timeZone: string;
  dailyTarget: number;
  targetAchievedToday: number;
  remainingTarget: number;
  operatingStart: string;
  operatingEnd: string;
  now: Date;
  elapsedOperatingFraction: number;
  expectedAchievedByNow: number;
  paceDeficit: number;
  qualifiedToday: number;
  rawCandidatesToday: number;
  processingInFlight: number;
  providerRunsInFlight: number;
  expectedQualifiedFromInFlight: number;
  hoursRemaining: number;
  apifySpendToday: number;
  apifyDailyBudgetRemaining: number;
  providerHealth: "healthy" | "degraded" | "paused" | "unknown";
  status: PacingStatus;
  qualifiedNeededToPlan: number;
  rawNeededToPlan: number;
  estimatedYield: number;
  yieldSampleSize: number;
  explanation: string;
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
  dailyTarget: number;
  targetAchievedToday: number;
  rawCandidatesToday: number;
  processingInFlight: number;
  providerRunsInFlight: number;
  expectedQualifiedFromInFlight: number;
  apifySpendToday: number;
  apifyDailyBudgetRemaining: number;
  providerHealth: AutopilotPacingState["providerHealth"];
  estimatedYield: number;
  yieldSampleSize: number;
  now: Date;
  operatingStartHour?: number | null;
  operatingEndHour?: number | null;
}

export function computeAutopilotPacing(input: PacingComputationInput): AutopilotPacingState {
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
  const paceDeficit = Math.max(0, expectedAchievedByNow - input.targetAchievedToday - input.expectedQualifiedFromInFlight);
  const minimumYieldFloor = 0.1;
  const boundedYield = Math.max(minimumYieldFloor, Math.min(1, input.estimatedYield || 0));
  const qualifiedNeededToPlan = input.providerHealth === "paused" || input.apifyDailyBudgetRemaining <= 0
    ? 0
    : Math.min(remainingTarget, Math.ceil(paceDeficit * 1.1));
  const rawNeededToPlan = qualifiedNeededToPlan > 0 ? Math.min(100, Math.ceil(qualifiedNeededToPlan / boundedYield)) : 0;
  const hoursRemaining = Math.max(0, (endMinutes - nowMinutes) / 60);
  const status: PacingStatus = nowMinutes < startMinutes
    ? "before_window"
    : nowMinutes >= endMinutes
      ? "after_window"
      : input.apifyDailyBudgetRemaining <= 0
        ? "budget_paused"
        : input.providerHealth === "paused"
          ? "provider_paused"
          : paceDeficit > 0
            ? "behind_pace"
            : "on_pace";
  const explanation = status === "behind_pace"
    ? `Behind pace by ${Math.ceil(paceDeficit)} qualified prospects. Estimated Maps Fast yield ${Math.round(boundedYield * 100)}%.`
    : status === "on_pace"
      ? "On pace. Existing progress and in-flight work are sufficient for the current checkpoint."
      : status === "budget_paused"
        ? "Apify daily budget is exhausted; no new paid discovery is scheduled."
        : status === "provider_paused"
          ? "Maps Fast provider health is paused; no new paid discovery is scheduled."
          : status === "before_window"
            ? "Before the operating window; no new paid discovery is scheduled."
            : "After the operating window; existing processing and provider polling may continue.";

  return {
    workspaceId: input.workspaceId,
    timeZone: input.timeZone,
    dailyTarget: input.dailyTarget,
    targetAchievedToday: input.targetAchievedToday,
    remainingTarget,
    operatingStart: `${String(startHour).padStart(2, "0")}:00`,
    operatingEnd: `${String(endHour).padStart(2, "0")}:00`,
    now: input.now,
    elapsedOperatingFraction,
    expectedAchievedByNow,
    paceDeficit,
    qualifiedToday: input.targetAchievedToday,
    rawCandidatesToday: input.rawCandidatesToday,
    processingInFlight: input.processingInFlight,
    providerRunsInFlight: input.providerRunsInFlight,
    expectedQualifiedFromInFlight: input.expectedQualifiedFromInFlight,
    hoursRemaining,
    apifySpendToday: input.apifySpendToday,
    apifyDailyBudgetRemaining: input.apifyDailyBudgetRemaining,
    providerHealth: input.providerHealth,
    status,
    qualifiedNeededToPlan,
    rawNeededToPlan,
    estimatedYield: boundedYield,
    yieldSampleSize: input.yieldSampleSize,
    explanation,
  };
}
