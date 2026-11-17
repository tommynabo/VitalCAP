import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/neon-identity.integration.test.ts"],
    setupFiles: [path.resolve(rootDir, "scripts/neon-identity-test.setup.ts")],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 45_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
});