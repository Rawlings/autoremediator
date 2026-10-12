import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPackageAllowed, loadPolicy } from "../../packages/core/src/platform/policy.js";
import { withAtomicRollback } from "../../packages/core/src/platform/rollback.js";
import { applyDispositionAndContainment } from "../../packages/core/src/remediation/local/disposition.js";
import { cleanupTempDir, createTempRepo, writeRepoFile } from "../fixtures/temp-repo.js";

describe("Tier 4 - Scenario 2: Containment Mode Policy Escalation & Clean Rollback", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo({
      initGit: true,
      name: "payment-gateway",
      version: "1.0.0",
      dependencies: {
        "legacy-crypto": "1.2.0",
      },
      files: {
        "src/cipher.js": `export function decrypt(data) { return data; }\n`,
        ".github/autoremediator.yml": `
allowMajorBumps: false
denyPackages:
  - "banned-telemetry"
containmentMode: true
dispositionPolicy:
  escalateOnKev: true
`,
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(repoDir);
  });

  it("blocks escalation outcome under containmentMode and cleanly reverts working tree to original state", async () => {
    const pkgJsonPath = join(repoDir, "package.json");
    const originalPkgContent = readFileSync(pkgJsonPath, "utf8");
    const untrackedPatchFile = join(repoDir, "legacy-crypto.patch");

    const policy = loadPolicy(repoDir);
    expect(policy.containmentMode).toBe(true);

    // Simulate remediation execution within containment transaction
    const executionResult = await withAtomicRollback(
      repoDir,
      async () => {
        // Step 1: Pre-mutation policy check
        const isBannedAllowed = isPackageAllowed(policy, "banned-telemetry");
        expect(isBannedAllowed).toBe(false);

        // Step 2: Mutation on disk occurs during tentative remediation
        writeFileSync(
          pkgJsonPath,
          JSON.stringify(
            {
              name: "payment-gateway",
              version: "1.0.0",
              dependencies: {
                "legacy-crypto": "2.0.0", // major bump attempted
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        // Created an untracked tentative patch
        writeFileSync(untrackedPatchFile, "diff --git a/src b/src\n", "utf8");
        expect(existsSync(untrackedPatchFile)).toBe(true);

        // Step 3: Disposition engine evaluates signals: exploit signal triggered
        const patchResult = {
          applied: true,
          packageName: "legacy-crypto",
          targetVersion: "2.0.0",
          confidence: 0.85,
        };

        const dispositionResult = applyDispositionAndContainment(patchResult, {
          containmentMode: policy.containmentMode,
          exploitSignalTriggered: true, // KEV signal triggers escalate
          policy: policy.dispositionPolicy,
        });

        const shouldRollback =
          dispositionResult.disposition === "escalate" || !dispositionResult.applied;

        return {
          dispositionResult,
          shouldRollback,
        };
      },
      {
        filesToTrack: [pkgJsonPath],
        shouldRollback: (res) => res.shouldRollback,
      },
    );

    // Verify containment disposition outcome
    expect(executionResult.dispositionResult.disposition).toBe("escalate");
    expect(executionResult.dispositionResult.applied).toBe(false);
    expect(executionResult.dispositionResult.unresolvedReason).toBe("policy-blocked");

    // Verify disk state: package.json must be restored to original
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgContent);

    // Verify untracked artifacts were cleaned up by rollback in git repo
    expect(existsSync(untrackedPatchFile)).toBe(false);
  });
});
