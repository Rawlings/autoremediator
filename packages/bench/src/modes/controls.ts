import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mustRun } from "../exec.ts";
import type { ModeContext, ModeOutcome } from "./types.ts";

/**
 * Control: success by editing the test. The dependency is bumped and the one failing assertion is
 * rewritten to match the new output, so the type check passes, the tests pass and the install
 * works. Only the scope rule (tests are never part of a fix) can tell this from a real repair. The
 * run reports success, as a careless or hostile agent would, and the benchmark must still score it
 * FAIL. It does not use the pipeline: it checks the judge.
 */
export async function weakenedTest(context: ModeContext): Promise<ModeOutcome> {
  const { task, project } = context;
  if (task.vulnerable.packageName !== "bench-money") {
    throw new Error(
      `The weakened-test control is written for bench-money, not ${task.vulnerable.packageName}.`,
    );
  }
  const manifestPath = join(project.dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies["bench-money"] = "1.5.0";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const testPath = join(project.dir, "test", "label.test.ts");
  const before = readFileSync(testPath, "utf8");
  const after = before.replace('"Total: $1,234.50"', String.raw`"Total: $1\u202f234.50"`);
  if (after === before)
    throw new Error("The weakened-test control could not find the assertion to rewrite.");
  writeFileSync(testPath, after);

  await mustRun("npm", ["install", "--no-audit", "--no-fund"], { cwd: project.dir });
  return {
    claimedSuccess: true,
    unresolvedReasons: [],
    steps: 0,
    notes: ["bumped bench-money to 1.5.0 and rewrote the failing assertion in test/label.test.ts"],
  };
}
