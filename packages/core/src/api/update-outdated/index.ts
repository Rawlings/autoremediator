import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "../../platform/evidence.js";
import { loadPolicy } from "../../platform/policy.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveInstallCommand,
  resolveTestCommand,
  type PackageManager,
} from "../../platform/package-manager/index.js";
import type { OutdatedPackage, UpdateOutdatedOptions, UpdateOutdatedReport } from "../../platform/types.js";
import { resolveConstraints, resolveCorrelationContext, resolveProvenanceContext } from "../context.js";
import { queryOutdatedPackages } from "../../intelligence/sources/registry.js";
import { createChangeRequestsForReports } from "../change-request/index.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type DepField = "dependencies" | "devDependencies" | "peerDependencies";

interface BumpResult {
  applied: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function applyBump(params: {
  cwd: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  pm: PackageManager;
  installCommand: string[];
  testCommand: string[];
  runTests: boolean;
}): Promise<BumpResult> {
  const pkgPath = join(params.cwd, "package.json");

  let pkgJson: RawPackageJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgPath, "utf8")) as RawPackageJson;
  } catch {
    return {
      applied: false,
      message: `Could not read package.json at "${pkgPath}".`,
    };
  }

  const depField = (["dependencies", "devDependencies", "peerDependencies"] as DepField[]).find(
    (f) => pkgJson[f]?.[params.packageName] !== undefined
  );

  if (!depField) {
    return {
      applied: false,
      message: `"${params.packageName}" was not found in package.json dependencies.`,
    };
  }

  const currentRange = pkgJson[depField]![params.packageName]!;
  const prefixMatch = currentRange.match(/^([~^]?)/);
  const prefix = prefixMatch?.[1] ?? "";
  const newRange = `${prefix}${params.toVersion}`;

  return withRepoLock(params.cwd, async () => {
    pkgJson[depField]![params.packageName] = newRange;
    writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

    try {
      const [installCmd, ...installArgs] = params.installCommand;
      await execa(installCmd, installArgs, { cwd: params.cwd, stdio: "pipe" });
    } catch (err) {
      pkgJson[depField]![params.packageName] = currentRange;
      writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
      const message = err instanceof Error ? err.message : String(err);
      return {
        applied: false,
        message: `${params.installCommand.join(" ")} failed after updating "${params.packageName}" to ${params.toVersion}. Reverted. Error: ${message}`,
      };
    }

    if (params.runTests) {
      try {
        const [testCmd, ...testArgs] = params.testCommand;
        await execa(testCmd, testArgs, { cwd: params.cwd, stdio: "pipe" });
      } catch (err) {
        pkgJson[depField]![params.packageName] = currentRange;
        writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
        try {
          const [rollbackCmd, ...rollbackArgs] = params.installCommand;
          await execa(rollbackCmd, rollbackArgs, { cwd: params.cwd, stdio: "pipe" });
        } catch {
          // Ignore rollback install failure.
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          applied: false,
          message: `Tests failed after upgrading "${params.packageName}" to ${params.toVersion}. Rolled back. Error: ${message}`,
        };
      }
    }

    return {
      applied: true,
      message: `Updated ${params.packageName} from ${params.fromVersion} to ${params.toVersion}.`,
    };
  });
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function updateOutdated(options: UpdateOutdatedOptions = {}): Promise<UpdateOutdatedReport> {
  const cwd = options.cwd ?? process.cwd();

  // Load policy exactly once
  const policy = loadPolicy(cwd, options.policy);
  const correlation = resolveCorrelationContext(options);
  const provenance = resolveProvenanceContext(options);
  const constraints = resolveConstraints(options, cwd);

  const evidence = createEvidenceLog(cwd, [], {
    requestId: correlation.requestId,
    sessionId: correlation.sessionId,
    parentRunId: correlation.parentRunId,
    actor: provenance.actor,
    source: provenance.source,
  });

  addEvidenceStep(evidence, "update-outdated.start", {
    cwd,
    includeTransitive: options.includeTransitive ?? false,
    dryRun: options.dryRun ?? false,
  });

  // Query outdated packages
  let outdatedMap: Awaited<ReturnType<typeof queryOutdatedPackages>>;
  try {
    outdatedMap = await queryOutdatedPackages(cwd, {
      includeTransitive: options.includeTransitive ?? false,
      packageManager: options.packageManager,
    });
  } catch (err) {
    addEvidenceStep(
      evidence,
      "update-outdated.registry-query-failed",
      {},
      { error: err instanceof Error ? err.message : String(err) }
    );
    finalizeEvidence(evidence);
    const evidenceFile = options.evidence === false ? undefined : writeEvidenceLog(cwd, evidence);

    return {
      schemaVersion: "1.0",
      status: "failed",
      generatedAt: new Date().toISOString(),
      outdatedPackages: [],
      successCount: 0,
      failedCount: 1,
      skippedCount: 0,
      errors: [{ packageName: "*", message: err instanceof Error ? err.message : String(err) }],
      evidenceFile,
      patchCount: 0,
      constraints,
      correlation,
      provenance,
    };
  }

  const outdatedPackages: OutdatedPackage[] = Array.from(outdatedMap.entries()).map(([name, info]) => ({
    name,
    currentVersion: info.currentVersion,
    wantedVersion: info.wantedVersion,
    latestVersion: info.latestVersion,
    isMajorBump: info.isMajorBump,
    dependencyScope: info.dependencyScope,
  }));

  addEvidenceStep(
    evidence,
    "update-outdated.registry-query",
    {},
    { packageCount: outdatedPackages.length }
  );

  // Resolve install/test commands once (before the loop)
  const pm = (options.packageManager ?? detectPackageManager(cwd)) as PackageManager;
  const yarnMajor = pm === "yarn" ? await getYarnMajorVersion(cwd) : undefined;
  const installCommand = resolveInstallCommand(pm, constraints, yarnMajor);
  const testCommand = resolveTestCommand(pm, constraints);

  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const errors: Array<{ packageName: string; message: string }> = [];

  for (const [packageName, info] of outdatedMap) {
    // Skip major bumps when policy disallows them
    if (info.isMajorBump && !policy.allowMajorBumps) {
      skippedCount++;
      addEvidenceStep(
        evidence,
        "update-outdated.skip",
        { packageName, reason: "major-bump-not-allowed" },
        {}
      );
      continue;
    }

    // In dry-run mode, count as success but do not write
    if (options.dryRun) {
      successCount++;
      addEvidenceStep(
        evidence,
        "update-outdated.dry-run",
        { packageName, fromVersion: info.currentVersion, toVersion: info.latestVersion },
        {}
      );
      continue;
    }

    addEvidenceStep(
      evidence,
      "update-outdated.apply",
      { packageName, fromVersion: info.currentVersion, toVersion: info.latestVersion }
    );

    const result = await applyBump({
      cwd,
      packageName,
      fromVersion: info.currentVersion,
      toVersion: info.latestVersion,
      pm,
      installCommand,
      testCommand,
      runTests: options.runTests ?? false,
    });

    if (result.applied) {
      successCount++;
      addEvidenceStep(
        evidence,
        "update-outdated.apply.success",
        { packageName },
        { toVersion: info.latestVersion }
      );
    } else {
      failedCount++;
      errors.push({ packageName, message: result.message });
      addEvidenceStep(
        evidence,
        "update-outdated.apply.failed",
        { packageName },
        { error: result.message }
      );
    }
  }

  const status: UpdateOutdatedReport["status"] =
    failedCount > 0 && successCount > 0 ? "partial" :
    failedCount > 0 && successCount === 0 ? "failed" :
    "ok";

  evidence.summary = {
    status,
    cveCount: 0,
    remediationCount: successCount + failedCount + skippedCount,
    successCount,
    failedCount,
    patchCount: 0,
  };

  finalizeEvidence(evidence);
  const evidenceFile = options.evidence === false ? undefined : writeEvidenceLog(cwd, evidence);

  const changeRequests =
    options.changeRequest?.enabled && successCount > 0
      ? await createChangeRequestsForReports({
          cwd,
          options: options.changeRequest,
          reports: [
            {
              cveId: "UPDATE-OUTDATED",
              cveDetails: null,
              vulnerablePackages: [],
              results: outdatedPackages
                .filter((pkg) => !pkg.isMajorBump)
                .map((pkg) => ({
                  packageName: pkg.name,
                  strategy: "version-bump" as const,
                  fromVersion: pkg.currentVersion,
                  toVersion: pkg.latestVersion,
                  applied: true,
                  dryRun: Boolean(options.dryRun),
                  message: `Updated ${pkg.name} to ${pkg.latestVersion}`,
                })),
              agentSteps: 0,
              summary: "update-outdated",
            },
          ],
        })
      : undefined;

  return {
    schemaVersion: "1.0",
    status,
    generatedAt: new Date().toISOString(),
    outdatedPackages,
    successCount,
    failedCount,
    skippedCount,
    errors,
    evidenceFile,
    patchCount: 0,
    constraints,
    correlation,
    provenance,
    changeRequests,
  };
}
