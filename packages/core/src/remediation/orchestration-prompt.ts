import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
