import { defineConfig } from "vitest/config";

// The fixture projects under tasks/ carry their own node:test files; only the benchmark's own tests run here.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 60_000 },
});
