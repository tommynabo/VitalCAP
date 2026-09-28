import { z } from "zod";

const NEON_VAR_PREFIXES = ["Vitalcap"];

export function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveNeonVar(standardName: string): string | undefined {
  const direct = optionalEnvValue(process.env[standardName]);
  
  let prefixed: string | undefined;
  for (const prefix of NEON_VAR_PREFIXES) {
    const val = optionalEnvValue(process.env[`${prefix}_${standardName}`]);
    if (val) {
      prefixed = val;
      break;
    }
  }

  // In Vercel, the integration is authoritative, so prefer the prefixed variable if it exists.
  // Locally or in non-Vercel environments, allow standard variables to override.
  const isVercel = process.env.VERCEL === "1";
  if (isVercel) {
    return prefixed ?? direct;
  }
  return direct ?? prefixed;
}
