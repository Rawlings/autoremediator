/** Capturing what a successful repair learned as a recipe (best effort: a repair is never failed for it). */
import { loadPolicy } from "../../platform/policy.js";
import type { RepairFailure } from "../../platform/repair-agent.js";
import { discoverRecipes, recipesFor } from "../../recipes/discover.js";
import { captureRecipe, rangeAround } from "../../recipes/capture.js";
import type { Recipe, RecipeBreaking } from "../../recipes/schema.js";
import { parseCompilerDiagnostics } from "../../remediation/refactor/codemods.js";
import { classifyPath } from "../../remediation/verify/changes.js";
import type { VerificationResult } from "../../remediation/verify/types.js";
import { PACKAGE_VERSION } from "../../version.js";

const MAX_BREAKING = 20;

/** What broke, as far as the verifier's first findings and the import lines of the diff say. */
export function breakingFrom(failure: RepairFailure | undefined, diff: string, packageName: string): RecipeBreaking[] {
  const found: RecipeBreaking[] = [];
  const seen = new Set<string>();
  const add = (entry: RecipeBreaking) => {
    const key = `${entry.kind}|${entry.symbol ?? ""}|${entry.message}`;
    if (!seen.has(key) && found.length < MAX_BREAKING) {
      seen.add(key);
      found.push(entry);
    }
  };

  if (failure) {
    if (failure.failedCheck === "typecheck") {
      for (const diagnostic of parseCompilerDiagnostics(failure.details.join("\n"))) {
        const symbol = diagnostic.missingMember ?? diagnostic.suggestedSymbol;
        add({
          kind: diagnostic.missingMember ? "symbol-removed" : diagnostic.code ? `diagnostic-${diagnostic.code}` : "diagnostic",
          ...(symbol ? { symbol: symbol.slice(0, 200) } : {}),
          message: diagnostic.message.slice(0, 300),
        });
      }
    } else if (failure.failedCheck === "tests") {
      const first = failure.details.map((line) => line.trim()).find((line) => line.length > 0);
      if (first) add({ kind: "test-failure", message: first.slice(0, 300) });
    }
  }

  const mentions = (line: string) => line.includes(`"${packageName}"`) || line.includes(`'${packageName}'`) || line.includes(`"${packageName}/`) || line.includes(`'${packageName}/`);
  for (const line of diff.split("\n")) {
    if ((line.startsWith("-") || line.startsWith("+")) && !line.startsWith("---") && !line.startsWith("+++") && /\b(import|require)\b/.test(line) && mentions(line)) {
      add({ kind: "import-changed", message: line.slice(0, 300) });
    }
  }
  return found;
}

export interface AttemptRecipeInput {
  diff: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  runId: string;
  attemptId: string;
  agentId: string;
  failure?: RepairFailure | undefined;
  verification?: VerificationResult | undefined;
  summary?: string | undefined;
  fromRange?: string | undefined;
  toRange?: string | undefined;
}

/** The recipe a repair's diff makes, or undefined (with the reason) when it cannot be expressed as one. */
export function recipeFromAttempt(input: AttemptRecipeInput): { recipe: Recipe; skipped: { file: string; reason: string }[] } | { error: string } {
  const fromRange = input.fromRange ?? rangeAround(input.fromVersion);
  const toRange = input.toRange ?? rangeAround(input.toVersion);
  if (!fromRange || !toRange) return { error: `cannot make a version range from ${input.fromVersion} and ${input.toVersion}` };
  try {
    return captureRecipe({
      diff: input.diff,
      packageName: input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      fromRange,
      toRange,
      isSource: (path) => classifyPath(path) === "source",
      ...(input.summary ? { summary: input.summary } : {}),
      breaking: breakingFrom(input.failure, input.diff, input.packageName),
      evidence: {
        runId: input.runId,
        attemptId: input.attemptId,
        agent: input.agentId,
        capturedAt: new Date().toISOString(),
        autoremediator: PACKAGE_VERSION,
        checks: (input.verification?.checks ?? []).map((check) => ({ name: check.name, status: check.status })),
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether the project already has a recipe for this upgrade (its own, or from a policy recipes
 * package). Cheap and read-only; packages that ship recipes for themselves are only found once
 * an attempt's checkout has the new version installed.
 */
export function hasRecipeFor(cwd: string, item: { packageName: string; fromVersion: string; toVersion: string }, policy: string | undefined): boolean {
  try {
    const found = discoverRecipes({ projectDir: cwd, installRoot: cwd, policyPackages: loadPolicy(cwd, policy).recipes?.packages ?? [] });
    return recipesFor(found, item.packageName, item.fromVersion, item.toVersion).length > 0;
  } catch {
    return false;
  }
}
