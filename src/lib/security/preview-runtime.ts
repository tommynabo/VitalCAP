export function isDeployedVercelPreview(): boolean {
  return process.env.VERCEL === "1"
    && process.env.VERCEL_ENV === "preview";
}

export class PreviewRuntimeBlockedError extends Error {
  constructor(operation: string) {
    super(`${operation} is unavailable in Vercel Preview deployments.`);
    this.name = "PreviewRuntimeBlockedError";
  }
}

export function assertNotVercelPreview(operation: string): void {
  if (isDeployedVercelPreview()) {
    throw new PreviewRuntimeBlockedError(operation);
  }
}