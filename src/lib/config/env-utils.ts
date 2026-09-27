import { z } from "zod";

const NEON_VAR_PREFIXES = ["Vitalcap"];

export function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveNeonVar(standardName: string): string | undefined {
  const direct = optionalEnvValue(process.env[standardName]);
  if (direct) return direct;
  for (const prefix of NEON_VAR_PREFIXES) {
    const prefixed = optionalEnvValue(process.env[`${prefix}_${standardName}`]);
    if (prefixed) return prefixed;
  }
  return undefined;
}
