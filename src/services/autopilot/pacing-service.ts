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

export type PacingStatus = "behind" | "ahead" | "on_track";

export interface PacingResult {
  status: PacingStatus;
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
