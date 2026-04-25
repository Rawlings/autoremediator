import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface FileGuardrail {
  path: string;
  maxLines: number;
  reason: string;
}

function lineCount(path: string): number {
  const content = readFileSync(path, "utf8");
  return content.split(/\r?\n/).length;
}

describe("architecture guardrails", () => {
  it("keeps mixed-concern files under approved size thresholds", () => {
    const srcRoot = resolve(process.cwd(), "src");

    const allowlist: FileGuardrail[] = [
      // High-churn entrypoint allowed to remain moderately sized while delegating evidence and CR branches.
      { path: resolve(srcRoot, "api/remediate/index.ts"), maxLines: 170, reason: "public entrypoint orchestration" },
      // Scan flow still coordinates evidence + aggregated report composition across CVEs.
      { path: resolve(srcRoot, "api/remediate-from-scan/index.ts"), maxLines: 240, reason: "scan orchestration assembly" },
      // Local runtime remains coordinator for ordered remediation phases after helper extraction.
      { path: resolve(srcRoot, "remediation/local/run.ts"), maxLines: 315, reason: "local pipeline coordinator" },
    ];

    for (const entry of allowlist) {
      const count = lineCount(entry.path);
      expect(count, `${entry.path} exceeded ${entry.maxLines} lines (${entry.reason})`).toBeLessThanOrEqual(
        entry.maxLines
      );
    }
  });
});
