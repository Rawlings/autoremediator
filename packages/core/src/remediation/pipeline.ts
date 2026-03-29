/**
 * Autoremediator agentic loop
 *
 * Orchestrates the full CVE patching pipeline using Vercel AI SDK's
 * generateText with a tool-calling loop.
 *
 * Phase 1 tools: lookup-cve → check-inventory → check-version-match
 *                → find-fixed-version → apply-version-bump
 * Phase 4 tools: fetch-package-source → generate-patch → apply-patch-file
 */
import { generateText } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { createModel, resolveProvider } from "../platform/config.js";
import { detectPackageManager } from "../platform/package-manager.js";
import { lookupCveTool } from "./tools/lookup-cve.js";
import { checkInventoryTool } from "./tools/check-inventory.js";
import { checkVersionMatchTool } from "./tools/check-version-match.js";
import { findFixedVersionTool } from "./tools/find-fixed-version.js";
import { applyVersionBumpTool } from "./tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "./tools/apply-package-override.js";
import { fetchPackageSourceTool } from "./tools/fetch-package-source.js";
import { generatePatchTool } from "./tools/generate-patch.js";
import { applyPatchFileTool } from "./tools/apply-patch-file.js";
import { lookupCveOsv } from "../intelligence/sources/osv.js";
import { lookupCveGitHub, mergeGhDataIntoCveDetails } from "../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../intelligence/sources/nvd.js";
import { resolveSafeUpgradeVersion } from "../intelligence/sources/registry.js";
import type { RemediateOptions, RemediationReport, PatchResult, VulnerablePackage, CveDetails } from "../platform/types.js";

export async function runRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const provider = resolveProvider(options);
  if (provider === "local") {
    return runLocalRemediationPipeline(cveId, options);
  }

  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const constraints = options.constraints ?? {};

  const model = await createModel(options);

  const systemPrompt = loadOrchestrationPrompt({
    cveId,
    cwd,
    dryRun,
    runTests,
    policy,
    patchesDir,
    packageManager,
    constraints,
  });

  const prompt = `Patch vulnerable dependencies affected by ${cveId} in the project at: ${cwd}. Package manager: ${packageManager}.`;

  const collectedResults: PatchResult[] = [];
  const vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  const applyVersionBumpToolForRun = preview
    ? {
        ...applyVersionBumpTool,
        execute: async (input: Record<string, unknown>) =>
          (applyVersionBumpTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyVersionBumpTool
    : applyVersionBumpTool;
  const applyPackageOverrideToolForRun = preview
    ? {
        ...applyPackageOverrideTool,
        execute: async (input: Record<string, unknown>) =>
          (applyPackageOverrideTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyPackageOverrideTool
    : applyPackageOverrideTool;
  const applyPatchFileToolForRun = preview
    ? {
        ...applyPatchFileTool,
        execute: async (input: Record<string, unknown>) =>
          (applyPatchFileTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyPatchFileTool
    : applyPatchFileTool;
  const tools = buildRuntimeTools({
    applyVersionBumpToolForRun,
    applyPackageOverrideToolForRun,
    applyPatchFileToolForRun,
    constraints,
  });

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt,
    tools: tools as any,
    maxSteps: 25,
    onStepFinish(stepResult) {
      agentSteps += 1;

      const toolResults = (stepResult.toolResults ?? []) as Array<{
        toolName: string;
        result?: unknown;
      }>;

      for (const tr of toolResults) {
        const toolResult = tr.result as Record<string, unknown> | undefined;

        if (tr.toolName === "lookup-cve" && toolResult?.data) {
          cveDetails = toolResult.data as CveDetails;
        }
        if (tr.toolName === "check-version-match" && toolResult?.vulnerablePackages) {
          vulnerablePackages.push(...(toolResult.vulnerablePackages as VulnerablePackage[]));
        }
        if (tr.toolName === "apply-version-bump") {
          collectedResults.push(toolResult as unknown as PatchResult);
        }

        if (tr.toolName === "apply-package-override") {
          collectedResults.push(toolResult as unknown as PatchResult);
        }

        if (tr.toolName === "apply-patch-file" && toolResult) {
          const validation = toolResult.validation as
            | { passed?: boolean; error?: string }
            | undefined;
          const message =
            typeof toolResult.message === "string"
              ? toolResult.message
              : typeof toolResult.error === "string"
                ? toolResult.error
                : "Patch-file strategy finished.";

          collectedResults.push({
            packageName:
              typeof toolResult.packageName === "string"
                ? toolResult.packageName
                : "unknown-package",
            strategy: "patch-file",
            fromVersion:
              typeof toolResult.vulnerableVersion === "string"
                ? toolResult.vulnerableVersion
                : "unknown",
            patchFilePath:
              typeof toolResult.patchFilePath === "string"
                ? toolResult.patchFilePath
                : typeof toolResult.patchPath === "string"
                  ? toolResult.patchPath
                  : undefined,
            applied: Boolean(toolResult.applied),
            dryRun: Boolean(toolResult.dryRun),
            unresolvedReason:
              !Boolean(toolResult.applied) && !Boolean(toolResult.dryRun)
                ? validation && validation.passed === false
                  ? "patch-validation-failed"
                  : "patch-apply-failed"
                : undefined,
            message,
            validation:
              validation && typeof validation.passed === "boolean"
                ? {
                    passed: validation.passed,
                    error: typeof validation.error === "string" ? validation.error : undefined,
                  }
                : undefined,
          });
        }
      }
    },
  });

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: result.text,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}

async function runLocalRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const constraints = options.constraints ?? {};

  const collectedResults: PatchResult[] = [];
  const vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  const normalizedId = cveId.toUpperCase();
  const [osvDetails, ghPackages] = await Promise.all([
    lookupCveOsv(normalizedId),
    lookupCveGitHub(normalizedId).catch(() => []),
  ]);
  agentSteps += 2;

  if (!osvDetails && ghPackages.length === 0) {
    return {
      cveId,
      cveDetails: null,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode failed at lookup-cve: ${normalizedId} not found in OSV or GitHub advisory data.`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  cveDetails = osvDetails ?? {
    id: normalizedId,
    summary: "Details sourced from GitHub Advisory Database.",
    severity: "UNKNOWN",
    references: [],
    affectedPackages: [],
  };

  if (ghPackages.length > 0) {
    cveDetails = mergeGhDataIntoCveDetails(cveDetails, ghPackages);
  }
  cveDetails = await enrichWithNvd(cveDetails);

  if (cveDetails.affectedPackages.length === 0) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode lookup succeeded but no npm affected packages were found for ${normalizedId}.`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const inventory = await (checkInventoryTool as any).execute({ cwd, packageManager });
  agentSteps += 1;

  if (inventory?.error) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode failed at check-inventory: ${inventory.error}`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const installedPackages = (inventory.packages ?? []) as Array<{
    name: string;
    version: string;
    type: "direct" | "indirect";
  }>;

  for (const affected of cveDetails.affectedPackages) {
    if (!affected || typeof affected !== "object") continue;
    if (!affected.name || !affected.vulnerableRange) continue;
    if (affected.ecosystem !== "npm") continue;
    const matches = installedPackages.filter((p) => p.name === affected.name);
    for (const installed of matches) {
      if (!semver.valid(installed.version)) continue;
      let isVulnerable = false;
      try {
        isVulnerable = semver.satisfies(installed.version, affected.vulnerableRange, {
          includePrerelease: false,
        });
      } catch {
        continue;
      }
      if (isVulnerable) {
        vulnerablePackages.push({ installed, affected });
      }
    }
  }
  agentSteps += 1;

  for (const vulnerable of vulnerablePackages) {
    const pkg = vulnerable.installed;
    const firstPatchedVersion = vulnerable.affected.firstPatchedVersion;

    if (pkg.type === "indirect") {
      if (constraints.directDependenciesOnly) {
        collectedResults.push({
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "constraint-blocked",
          message: `Constraint blocked remediation for indirect dependency "${pkg.name}".`,
        });
        continue;
      }

      if (constraints.preferVersionBump) {
        collectedResults.push({
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "constraint-blocked",
          message: `Constraint prefers version-bump and rejected override remediation for "${pkg.name}".`,
        });
        continue;
      }

      if (!firstPatchedVersion) {
        collectedResults.push({
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic override in local mode.`,
        });
        continue;
      }

      const safeUpgrade = await resolveSafeUpgradeVersion(
        pkg.name,
        pkg.version,
        firstPatchedVersion,
        vulnerable.affected.vulnerableRange
      );
      agentSteps += 1;

      if (!safeUpgrade.safeVersion) {
        collectedResults.push({
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          message: `No safe override version found for ${pkg.name}.`,
        });
        continue;
      }

      const overrideResult = (await (applyPackageOverrideTool as any).execute({
        cwd,
        packageManager,
        packageName: pkg.name,
        fromVersion: pkg.version,
        toVersion: safeUpgrade.safeVersion,
        dryRun,
        policy,
        runTests,
      })) as PatchResult;
      agentSteps += 1;
      collectedResults.push(overrideResult);
      continue;
    }

    if (!firstPatchedVersion) {
      collectedResults.push({
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic upgrade in local mode.`,
      });
      continue;
    }

    const safeUpgrade = await resolveSafeUpgradeVersion(
      pkg.name,
      pkg.version,
      firstPatchedVersion,
      vulnerable.affected.vulnerableRange
    );
    const safeVersion = safeUpgrade.safeVersion;
    agentSteps += 1;

    if (!safeVersion) {
      collectedResults.push({
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        message: `No safe upgrade version found for ${pkg.name}.`,
      });
      continue;
    }

    const applyResult = (await (applyVersionBumpTool as any).execute({
      cwd,
      packageManager,
      packageName: pkg.name,
      fromVersion: pkg.version,
      toVersion: safeVersion,
      dryRun,
      policy,
      runTests,
    })) as PatchResult;
    agentSteps += 1;

    collectedResults.push(applyResult);
  }

  const appliedCount = collectedResults.filter((r) => r.applied).length;
  const unresolvedCount = collectedResults.filter((r) => !r.applied && !r.dryRun).length;
  const dryRunCount = collectedResults.filter((r) => r.dryRun).length;

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: `Local mode completed: vulnerable=${vulnerablePackages.length}, applied=${appliedCount}, dryRun=${dryRunCount}, unresolved=${unresolvedCount}`,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}

interface PromptContext {
  cveId: string;
  cwd: string;
  packageManager: "npm" | "pnpm" | "yarn";
  dryRun: boolean;
  runTests: boolean;
  policy: string;
  patchesDir: string;
  constraints: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
  };
}

interface RuntimeToolContext {
  applyVersionBumpToolForRun: typeof applyVersionBumpTool;
  applyPackageOverrideToolForRun: typeof applyPackageOverrideTool;
  applyPatchFileToolForRun: typeof applyPatchFileTool;
  constraints: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
  };
}

function buildRuntimeTools(ctx: RuntimeToolContext) {
  const tools = {
    "lookup-cve": lookupCveTool,
    "check-inventory": checkInventoryTool,
    "check-version-match": checkVersionMatchTool,
    "find-fixed-version": findFixedVersionTool,
    "apply-version-bump": ctx.applyVersionBumpToolForRun,
  } as Record<string, unknown>;

  if (!ctx.constraints.directDependenciesOnly && !ctx.constraints.preferVersionBump) {
    tools["apply-package-override"] = ctx.applyPackageOverrideToolForRun;
  }

  if (!ctx.constraints.preferVersionBump) {
    tools["fetch-package-source"] = fetchPackageSourceTool;
    tools["generate-patch"] = generatePatchTool;
    tools["apply-patch-file"] = ctx.applyPatchFileToolForRun;
  }

  return tools;
}

function loadOrchestrationPrompt(ctx: PromptContext): string {
  const promptPath = join(process.cwd(), ".github", "instructions", "orchestration.instructions.md");

  if (!existsSync(promptPath)) {
    return `You are autoremediator, an agentic security remediation system for Node.js package dependencies.
Working directory: ${ctx.cwd}
  Package manager: ${ctx.packageManager}
Dry run: ${ctx.dryRun}
Run tests: ${ctx.runTests}
Policy: ${ctx.policy || "undefined"}
Patches dir: ${ctx.patchesDir}
Direct dependencies only: ${String(ctx.constraints.directDependenciesOnly ?? false)}
Prefer version bump: ${String(ctx.constraints.preferVersionBump ?? false)}

Required sequence:
1. lookup-cve
2. check-inventory
3. check-version-match
4. find-fixed-version
5. apply-version-bump
6. apply-package-override

Fallback sequence (when neither version bump nor override can be applied):
1. fetch-package-source
2. generate-patch
3. apply-patch-file

Always respect dryRun and policy constraints.`;
  }

  const template = readFileSync(promptPath, "utf8");
  return template
    .replaceAll("{{cveId}}", ctx.cveId)
    .replaceAll("{{cwd}}", ctx.cwd)
    .replaceAll("{{packageManager}}", ctx.packageManager)
    .replaceAll("{{dryRun}}", String(ctx.dryRun))
    .replaceAll("{{runTests}}", String(ctx.runTests))
    .replaceAll("{{policy}}", ctx.policy || "undefined")
    .replaceAll("{{patchesDir}}", ctx.patchesDir)
    .replaceAll("{{directDependenciesOnly}}", String(ctx.constraints.directDependenciesOnly ?? false))
    .replaceAll("{{preferVersionBump}}", String(ctx.constraints.preferVersionBump ?? false));
}
