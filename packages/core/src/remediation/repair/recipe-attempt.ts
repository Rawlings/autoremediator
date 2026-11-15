/**
 * Recipes in the repair flow: tried before an agent is asked anything.
 *
 * A recipe is applied to the attempt's checkout the way an agent's patch is (the same validation,
 * through `validateAndApplyPatch`), then judged by the same verifier. One that does not match, is
 * refused, or does not make the verifier pass is taken back out exactly, and the next recipe (or
 * the agent) goes on from the checkout as it was.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPolicy } from "../../platform/policy.js";
import type { TranscriptEntry } from "../../platform/repair-agent.js";
import { safeExeca } from "../../platform/safe-exec.js";
import {
  type Discovery,
  discoverRecipes,
  type RecipeEntry,
  recipesFor,
} from "../../recipes/discover.js";
import { planRecipe, type RecipePlan, type SourceFile } from "../../recipes/engine.js";
import { classifyPath } from "../verify/changes.js";
import type { VerificationResult } from "../verify/types.js";
import { type AppliedPatch, undoPatch, validateAndApplyPatch } from "./patch-apply.js";

const MAX_SOURCE_FILE_BYTES = 1_000_000;

export interface FindRecipesParams {
  /** The project (its committed recipes, its policy). */
  projectDir: string;
  /** Where installed packages are looked at: the attempt's checkout, which has the new version. */
  installRoot: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  policy?: string;
}

export interface FoundRecipes {
  recipes: RecipeEntry[];
  /** Recipe files that could not be used, and why. */
  problems: Discovery["problems"];
}

/** Recipes that apply to this upgrade, from every source. */
export function findApplicableRecipes(params: FindRecipesParams): FoundRecipes {
  const policy = loadPolicy(params.projectDir, params.policy);
  const discovery = discoverRecipes({
    projectDir: params.projectDir,
    installRoot: params.installRoot,
    fallbackInstallRoot: params.projectDir,
    policyPackages: policy.recipes?.packages ?? [],
  });
  return {
    recipes: recipesFor(discovery, params.packageName, params.fromVersion, params.toVersion),
    problems: discovery.problems,
  };
}

/** Tracked project source files in a checkout, with their text. Symlinks and big files are left out. */
export async function listSourceFiles(checkout: string): Promise<SourceFile[]> {
  const run = (args: string[]) =>
    safeExeca("git", args, { cwd: checkout, stdio: "pipe" }).then((result) => result.stdout);
  const top = (await run(["rev-parse", "--show-toplevel"])).trim();
  const names = (await run(["ls-files", "--full-name", "-z"])).split("\0").filter(Boolean);
  const files: SourceFile[] = [];
  for (const name of names) {
    if (classifyPath(name) !== "source") continue;
    const full = join(top, name);
    try {
      const stats = lstatSync(full);
      if (!stats.isFile() || stats.size > MAX_SOURCE_FILE_BYTES) continue;
      files.push({ path: name, text: readFileSync(full, "utf8") });
    } catch {
      // A file that cannot be read is not a candidate.
    }
  }
  return files;
}

export type RecipeApplication =
  | { ok: true; plan: Extract<RecipePlan, { ok: true }>; applied: AppliedPatch }
  | { ok: false; reason: string };

/** Match a recipe against the checkout and apply the result through the shared patch validation. */
export async function applyRecipeToCheckout(
  checkout: string,
  entry: RecipeEntry,
  files?: readonly SourceFile[],
): Promise<RecipeApplication> {
  const plan = planRecipe(entry.recipe, files ?? (await listSourceFiles(checkout)));
  if (!plan.ok) return { ok: false, reason: plan.reason };
  try {
    return { ok: true, plan, applied: await validateAndApplyPatch(checkout, plan.diff) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface RecipeTrial {
  /** The recipe that made the verifier pass, with its verification, when one did. */
  fixed?: { entry: RecipeEntry; verification: VerificationResult; files: string[] };
  transcript: TranscriptEntry[];
}

/**
 * Try each recipe in turn on the checkout. The first one the verifier accepts stays applied; every
 * other is undone. If a recipe cannot be taken back out, this throws: the checkout is no longer
 * what the agent would be told about.
 */
export async function tryRecipes(params: {
  checkout: string;
  recipes: readonly RecipeEntry[];
  judge: () => Promise<VerificationResult>;
}): Promise<RecipeTrial> {
  const transcript: TranscriptEntry[] = [];
  const say = (text: string) => transcript.push({ step: transcript.length, text });
  if (params.recipes.length === 0) return { transcript };

  const files = await listSourceFiles(params.checkout);
  for (const entry of params.recipes) {
    const label = `recipe ${entry.id} (${entry.source.kind === "project" ? "this project" : entry.source.package})`;
    const application = await applyRecipeToCheckout(params.checkout, entry, files);
    if (!application.ok) {
      say(`${label}: not applied: ${application.reason}`);
      continue;
    }
    const verification = await params.judge();
    if (verification.passed) {
      say(
        `${label}: applied to ${application.applied.files.join(", ")} and the verifier accepted it`,
      );
      return { fixed: { entry, verification, files: application.applied.files }, transcript };
    }
    say(
      `${label}: applied to ${application.applied.files.join(", ")} but the verifier rejected it (${verification.failedCheck ?? "unknown"}); undone`,
    );
    try {
      await undoPatch(params.checkout, application.applied);
    } catch (cause) {
      throw new Error(`could not take recipe ${entry.id} back out of the checkout`, { cause });
    }
  }
  return { transcript };
}
