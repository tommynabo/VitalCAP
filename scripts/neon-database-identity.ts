export function assertNeonDatabaseIdentity(databaseUrl: string, expectedHost: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("PRODUCTION_DATABASE_URL_INVALID");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname.endsWith(".neon.tech")) {
    throw new Error("PRODUCTION_NEON_URL_REQUIRED");
  }
  if (!expectedHost?.trim() || expectedHost === "[SENSITIVE]") {
    throw new Error("PRODUCTION_NEON_HOST_UNAVAILABLE");
  }

  const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/-pooler(?=\.)/, "");
  if (normalizeHost(parsed.hostname) !== normalizeHost(expectedHost)) {
    throw new Error("PRODUCTION_NEON_HOST_MISMATCH");
  }
}