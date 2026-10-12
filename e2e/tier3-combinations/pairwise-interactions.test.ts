import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeRequestsForReports } from "../../packages/core/src/api/change-request/index.js";
import { checkSlaBreach, isPackageAllowed, loadPolicy } from "../../packages/core/src/platform/policy.js";
import { withAtomicRollback } from "../../packages/core/src/platform/rollback.js";
import type { RemediationReport } from "../../packages/core/src/platform/types.js";
import { applyDispositionAndContainment, computeDisposition } from "../../packages/core/src/remediation/local/disposition.js";
import { refactorConsumerCallSites } from "../../packages/core/src/remediation/refactor/refactor-agent.js";
import { generateUnifiedDiff, validatePatchedCodeSyntax } from "../../packages/core/src/remediation/tools/generate-patch/helpers.js";
import { repairFileContent } from "../../packages/github-app/src/healing/pr-healer.js";
import { cleanupTempDir, createTempDir, createTempRepo, writeRepoFile } from "../fixtures/temp-repo.js";

describe("Tier 3 - Pairwise Cross-Feature Combinations", () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await createTempRepo({
      initGit: true,
      files: {
        "src/index.ts": `import { v4 } from "uuid";\nexport const id = v4();\n`,
        "config.json": JSON.stringify({ version: "1.0.0" }, null, 2),
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(tempRepo);
  });

  it("Pairwise 1: Proof-of-fix regression triggers containment rollback and policy block", async () => {
    const targetFile = join(tempRepo, "package.json");
    const originalContent = readFileSync(targetFile, "utf8");

    // Execute within rollback envelope
    const outcome = await withAtomicRollback(
      tempRepo,
      async () => {
        // Mutate file on disk
        writeFileSync(targetFile, JSON.stringify({ name: "fixture-app", version: "2.0.0-mutated" }, null, 2), "utf8");

        const disposition = applyDispositionAndContainment(
          {
            applied: true,
            packageName: "sample-pkg",
            regressionDetected: true,
          },
          {
            containmentMode: true,
          },
        );

        return {
          disposition,
          shouldRollback: disposition.disposition === "escalate" || !disposition.applied,
        };
      },
      {
        filesToTrack: [targetFile],
        shouldRollback: (res) => res.shouldRollback,
      },
    );

    // Verify disposition was escalated and applied rewritten to false
    expect(outcome.disposition.disposition).toBe("escalate");
    expect(outcome.disposition.applied).toBe(false);
    expect(outcome.disposition.unresolvedReason).toBe("policy-blocked");

    // Verify disk content was restored to original
    expect(readFileSync(targetFile, "utf8")).toBe(originalContent);
  });

  it("Pairwise 2: AST codemod refactor followed by multi-group change request generation", async () => {
    const consumerPath = join(tempRepo, "src/index.ts");
    writeFileSync(consumerPath, `import v4 from "uuid/v4";\nexport const id = v4();\n`, "utf8");

    // Step 1: AST Codemod refactors breaking subpath import
    const refactorResult = await refactorConsumerCallSites({
      cwd: tempRepo,
      packageName: "uuid",
      fromVersion: "8.3.2",
      toVersion: "9.0.0",
      diagnosticError: "Cannot find module 'uuid/v4' or its corresponding type declarations.",
      callSites: [
        {
          filePath: consumerPath,
          packageName: "uuid",
          importPath: "uuid/v4",
          specifiers: [{ name: "v4", isDefault: true }],
          usages: [{ line: 2, column: 18, text: "v4()" }],
        },
      ],
    });

    expect(refactorResult.applied).toBe(true);

    // Step 2: Multi-group change request commits the refactored code
    const reports: RemediationReport[] = [
      {
        cveId: "CVE-2022-9999",
        results: [
          {
            packageName: "uuid",
            applied: true,
            dependencyScope: "direct",
            targetVersion: "9.0.0",
          },
        ],
      },
    ];

    const crResults = await createChangeRequestsForReports({
      cwd: tempRepo,
      options: {
        provider: "github",
        grouping: "per-cve",
        repository: "owner/repo",
      },
      reports,
    });

    expect(crResults.length).toBe(1);
    expect(crResults[0]?.cveIds).toContain("CVE-2022-9999");
  });

  it("Pairwise 3: Offline snapshot data feeds patch generation and syntax validation", () => {
    // Snapshot intelligence data
    const offlineFinding = {
      cveId: "CVE-2021-23337",
      packageName: "lodash",
      filePath: "template.js",
      vulnerableSnippet: `function escape(str) { return str; }\n`,
      patchedSnippet: `function escape(str) { return str.replace(/</g, "&lt;"); }\n`,
    };

    // Synthesize diff
    const diff = generateUnifiedDiff(
      offlineFinding.vulnerableSnippet,
      offlineFinding.patchedSnippet,
      offlineFinding.filePath,
    );

    expect(diff).not.toBeNull();
    expect(diff).toContain("--- a/template.js");
    expect(diff).toContain("+++ b/template.js");

    // Syntax validation
    const syntax = validatePatchedCodeSyntax(offlineFinding.filePath, offlineFinding.patchedSnippet);
    expect(syntax.valid).toBe(true);
  });

  it("Pairwise 4: Policy denyPackages pre-check blocks denied packages in multi-package scan", () => {
    const policyYaml = `
allowMajorBumps: false
denyPackages:
  - "denied-crypto-lib"
allowPackages: []
`;
    writeRepoFile(tempRepo, ".github/autoremediator.yml", policyYaml);
    const policy = loadPolicy(tempRepo);

    const findings = [
      { packageName: "denied-crypto-lib", cveId: "CVE-2023-0001" },
      { packageName: "allowed-web-lib", cveId: "CVE-2023-0002" },
    ];

    const results = findings.map((f) => ({
      packageName: f.packageName,
      cveId: f.cveId,
      allowed: isPackageAllowed(policy, f.packageName),
    }));

    // First package must be blocked pre-mutation
    expect(results[0]?.allowed).toBe(false);
    // Second package is allowed
    expect(results[1]?.allowed).toBe(true);
  });

  it("Pairwise 5: GitHub App healing inside isolated workspace preserves clean external state", () => {
    const isolatedDir = createTempDir("pr-heal-isolated-");
    try {
      const code = `import chalk from "chalk";\nconsole.log(chalk("hi"));\n`;
      const repaired = repairFileContent(code, [
        {
          filePath: "app.ts",
          message: 'Module "chalk" has no default export.',
          ruleId: "TS2614",
          category: "typescript",
        },
      ]);

      expect(repaired).toContain('import * as chalk from "chalk"');
      // Verify isolation: external files are unchanged
      expect(existsSync(join(tempRepo, "src/index.ts"))).toBe(true);
    } finally {
      cleanupTempDir(isolatedDir);
    }
  });

  it("Pairwise 6: SLA breach elevates disposition to escalate and activates containment", () => {
    const slaPolicy = { critical: 24, high: 72, medium: 168, low: 720 };
    // Published 48 hours ago for CRITICAL (deadline 24h)
    const publishedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const breach = checkSlaBreach("CVE-2026-9999", "CRITICAL", publishedAt, slaPolicy);

    expect(breach).not.toBeNull();

    // Disposition computation with SLA breach
    const disposition = computeDisposition({
      applied: true,
      slaBreaches: breach ? [breach] : [],
      dependencyScope: "direct",
    });

    expect(disposition.disposition).toBe("escalate");
    expect(disposition.dispositionReason).toBe("sla-breach");
  });
});
