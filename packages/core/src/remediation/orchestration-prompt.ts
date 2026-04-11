import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PromptContext {
  cveId: string;
  cwd: string;
  llmProvider: "remote" | "local";
  modelPersonality?: "analytical" | "pragmatic" | "balanced";
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

function buildProviderAddendum(
  provider: "remote" | "local",
  personality: "analytical" | "pragmatic" | "balanced" = "balanced"
): string {
  const personalityDirective =
    personality === "analytical"
      ? "Use concise, explicit rationale for tool decisions and unresolved outcomes."
      : personality === "pragmatic"
        ? "Prefer the smallest safe remediation path while preserving policy and validation gates."
        : "Balance concise execution with brief rationale for risky or unresolved outcomes.";

  const providerDirective =
    provider === "remote"
      ? "Use strict structured output and deterministic reporting fields."
      : "Use deterministic-first behavior and only rely on remote model fallback when required by patch generation.";

  return `\nProvider profile:\n- Provider: ${provider}\n- ${providerDirective}\n- ${personalityDirective}`;
}

export function loadOrchestrationPrompt(ctx: PromptContext): string {
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
  return (
    template
    .replaceAll("{{cveId}}", ctx.cveId)
    .replaceAll("{{cwd}}", ctx.cwd)
    .replaceAll("{{packageManager}}", ctx.packageManager)
    .replaceAll("{{dryRun}}", String(ctx.dryRun))
    .replaceAll("{{runTests}}", String(ctx.runTests))
    .replaceAll("{{policy}}", ctx.policy || "undefined")
    .replaceAll("{{patchesDir}}", ctx.patchesDir)
    .replaceAll("{{directDependenciesOnly}}", String(ctx.constraints.directDependenciesOnly ?? false))
    .replaceAll("{{preferVersionBump}}", String(ctx.constraints.preferVersionBump ?? false)) +
    buildProviderAddendum(ctx.llmProvider, ctx.modelPersonality)
  );
}
