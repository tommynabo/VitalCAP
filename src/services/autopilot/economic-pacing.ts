export type EconomicPacingState = "UNDER_PACE" | "ON_PACE" | "AHEAD_OF_BUDGET_PACE" | "NEAR_DAILY_CAP";

export function getElapsedOperatingFraction(
  timeZone: string,
  now: Date,
  operatingStartHour = 7,
  operatingEndHour = 22,
): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const nowMinutes = (values.hour ?? 0) * 60 + (values.minute ?? 0);
  const startMinutes = operatingStartHour * 60;
  const windowMinutes = Math.max(1, (operatingEndHour - operatingStartHour) * 60);
  return Math.max(0, Math.min(1, (nowMinutes - startMinutes) / windowMinutes));
}

export interface ProviderBudgetPacing {
  state: EconomicPacingState;
  spendTodayUsd: number;
  dailyCapUsd: number;
  expectedSpendByNowUsd: number;
  budgetPacePct: number;
  timePacePct: number;
  discoveryMultiplier: number;
}

export function computeProviderBudgetPacing(input: {
  spendTodayUsd: number;
  dailyCapUsd: number;
  elapsedOperatingFraction: number;
  previousState?: EconomicPacingState | null;
}): ProviderBudgetPacing {
  const dailyCapUsd = Math.max(0, input.dailyCapUsd);
  const spendTodayUsd = Math.max(0, input.spendTodayUsd);
  const timePacePct = Math.max(0, Math.min(1, input.elapsedOperatingFraction));
  const expectedSpendByNowUsd = dailyCapUsd * timePacePct;
  const budgetPacePct = dailyCapUsd > 0 ? Math.min(1, spendTodayUsd / dailyCapUsd) : Number(spendTodayUsd > 0);
  const nearCapThreshold = input.previousState === "NEAR_DAILY_CAP" ? 0.85 : 0.9;
  const nearCap = dailyCapUsd <= 0 || spendTodayUsd >= dailyCapUsd * nearCapThreshold;
  const aheadMultiplier = input.previousState === "AHEAD_OF_BUDGET_PACE" ? 1.1 : 1.25;
  const aheadThresholdUsd = expectedSpendByNowUsd * aheadMultiplier + dailyCapUsd * 0.02;
  const aheadOfPace = dailyCapUsd > 0
    && spendTodayUsd >= dailyCapUsd * 0.05
    && spendTodayUsd > aheadThresholdUsd;
  const state: EconomicPacingState = nearCap
    ? "NEAR_DAILY_CAP"
    : aheadOfPace
      ? "AHEAD_OF_BUDGET_PACE"
      : spendTodayUsd < expectedSpendByNowUsd * 0.8
        ? "UNDER_PACE"
        : "ON_PACE";

  return {
    state,
    spendTodayUsd,
    dailyCapUsd,
    expectedSpendByNowUsd,
    budgetPacePct,
    timePacePct,
    discoveryMultiplier: state === "NEAR_DAILY_CAP" ? 0 : state === "AHEAD_OF_BUDGET_PACE" ? 0.75 : 1,
  };
}

/** Quantizes pressure without increasing work; a pressured epoch trims no more than 25%. */
export function applyEconomicDiscoveryPacing(rawNeeded: number, discoveryMultiplier: number): number {
  const boundedRaw = Math.max(0, Math.floor(rawNeeded));
  if (boundedRaw === 0 || discoveryMultiplier <= 0) return 0;
  const boundedMultiplier = Math.max(0, Math.min(1, discoveryMultiplier));
  return Math.min(boundedRaw, Math.max(1, Math.ceil(boundedRaw * boundedMultiplier)));
}

export interface EndOfDayImportProjection {
  low: number;
  base: number;
  high: number;
}

export function projectEndOfDayImports(input: {
  confirmedImports: number;
  dailyTarget: number;
  elapsedOperatingFraction: number;
  recentImportsPerDay: number;
  recentImportSample: number;
  expectedImportsFromBacklog: number;
}): EndOfDayImportProjection {
  const confirmedImports = Math.max(0, Math.floor(input.confirmedImports));
  const dailyTarget = Math.max(0, Math.floor(input.dailyTarget));
  const elapsed = Math.max(0, Math.min(1, input.elapsedOperatingFraction));
  const remaining = 1 - elapsed;
  const historicalRate = input.recentImportSample >= 20
    ? Math.max(0, input.recentImportsPerDay)
    : 0;
  const currentRateIsCredible = elapsed >= 0.5 && confirmedImports >= 10;
  const currentRate = currentRateIsCredible ? confirmedImports / elapsed : 0;
  const baseRate = historicalRate > 0 && currentRateIsCredible
    ? historicalRate * 0.75 + currentRate * 0.25
    : historicalRate || currentRate;
  const futureImports = baseRate * remaining;
  const backlogCredit = Math.max(0, input.expectedImportsFromBacklog);
  const capProjection = (value: number) => dailyTarget > 0 ? Math.min(dailyTarget, value) : value;

  return {
    low: Math.floor(capProjection(confirmedImports + futureImports * 0.75)),
    base: Math.floor(capProjection(confirmedImports + futureImports * 0.9 + backlogCredit * 0.5)),
    high: Math.floor(capProjection(confirmedImports + futureImports * 1.1 + backlogCredit)),
  };
}