#!/usr/bin/env node
/**
 * Autoremediator E2E Test Suite Runner
 *
 * Runs opaque-box E2E tests across Tiers 1-4.
 *
 * Usage:
 *   node e2e/runner.mjs               # Run all E2E tiers
 *   node e2e/runner.mjs tier1         # Run only Tier 1
 *   node e2e/runner.mjs tier2         # Run only Tier 2
 *   node e2e/runner.mjs tier3         # Run only Tier 3
 *   node e2e/runner.mjs tier4         # Run only Tier 4
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const rootDir = resolve(process.cwd());
const vitestBin = join(rootDir, "packages/core/node_modules/.bin/vitest");
const vitestFallback = join(rootDir, "packages/core/node_modules/vitest/vitest.mjs");

const binToRun = existsSync(vitestBin) ? vitestBin : vitestFallback;
const userArgs = process.argv.slice(2);

// Map tier shortcuts to directory filters
let targetPath = "e2e";
const extraArgs = [];

for (const arg of userArgs) {
  if (arg === "tier1" || arg === "--tier=1" || arg === "tier1-features") {
    targetPath = "e2e/tier1-features";
  } else if (arg === "tier2" || arg === "--tier=2" || arg === "tier2-boundaries") {
    targetPath = "e2e/tier2-boundaries";
  } else if (arg === "tier3" || arg === "--tier=3" || arg === "tier3-combinations") {
    targetPath = "e2e/tier3-combinations";
  } else if (arg === "tier4" || arg === "--tier=4" || arg === "tier4-scenarios") {
    targetPath = "e2e/tier4-scenarios";
  } else {
    extraArgs.push(arg);
  }
}

const args = ["run", targetPath, ...extraArgs];

console.log("===============================================================");
console.log("  Autoremediator Opaque-Box E2E Test Suite Runner");
console.log(`  Target: ${targetPath}`);
console.log("===============================================================\n");

const child = spawn(binToRun, args, {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS || "--no-warnings",
  },
});

child.on("close", (code) => {
  if (code === 0) {
    console.log("\n===============================================================");
    console.log("  [SUCCESS] All executed E2E tests passed successfully!");
    console.log("===============================================================");
  } else {
    console.log("\n===============================================================");
    console.log(`  [COMPLETED] Test runner exited with code ${code}.`);
    console.log("  Any failures indicate defects or pending implementation features.");
    console.log("===============================================================");
  }
  process.exit(code ?? 1);
});
