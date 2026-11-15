/**
 * Recipes: what an agent learned when it made an upgrade work, kept as data so the next project (or
 * the next run) does not have to learn it again. See docs/guides/recipes.md.
 *
 * Reading (`listRecipes`) is read-only. `applyRecipe` writes only inside an open attempt's isolated
 * checkout, like `proposePatch`, and keeps the change only if the verifier accepts it. `captureRecipe`
 * and `exportRecipes` write files in the project or a directory you name, so they are SDK and CLI only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPolicy } from "../../infra/policy/policy.js";
import { defaultAttemptDeps } from "../repair/attempt.js";
import { undoPatch } from "../repair/patch-apply.js";
import { applyRecipeToCheckout } from "../repair/recipe-attempt.js";
import {
  type AttemptQuery,
  type AttemptView,
  context,
  loadOpen,
  verifyAttempt,
  viewOf,
  withVerification,
} from "../runs/attempts.js";
import { defaultRunDeps, type RunDeps } from "../runs/deps.js";
import type { AttemptRecord } from "../runs/run-store.js";
import { rangeAround } from "./capture.js";
import {
  discoverRecipes,
  type Discovery,
  type RecipeEntry,
  type RecipeSource,
} from "./discover.js";
import { appliesTo } from "./engine.js";
import { type Recipe, parseRecipe, recipeId } from "./schema.js";
import { exportRecipePackage, saveProjectRecipe, type ExportResult } from "./store.js";

export interface ListRecipesOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Only recipes for this package. */
  packageName?: string;
  /** With `toVersion`: mark which recipes apply to upgrading from this version. */
  fromVersion?: string;
  toVersion?: string;
  /** Include the whole recipe (every hunk) for the recipe with this id. */
  recipeId?: string;
  /** Policy file, for its `recipes.packages` (default: `.github/autoremediator.yml`). */
  policy?: string;
}

export interface RecipeSummary {
  id: string;
  package: string;
  fromRange: string;
  toRange: string;
  source: RecipeSource;
  file: string;
  summary?: string;
  hunks: number;
  breaking: number;
  /** Set when `fromVersion` and `toVersion` were given. */
  applies?: boolean;
  evidence?: Recipe["evidence"];
  /** Only for the recipe named by `recipeId`. */
  recipe?: Recipe;
}

export interface RecipeListing {
  recipes: RecipeSummary[];
  /** Recipe files that were found but cannot be used, and why. */
  problems: Discovery["problems"];
}

function discover(cwd: string, installRoot: string, policy: string | undefined): Discovery {
  return discoverRecipes({
    projectDir: cwd,
    installRoot,
    fallbackInstallRoot: cwd,
    policyPackages: loadPolicy(cwd, policy).recipes?.packages ?? [],
  });
}

function summarize(entry: RecipeEntry, options: ListRecipesOptions): RecipeSummary {
  const summary: RecipeSummary = {
    id: entry.id,
    package: entry.recipe.package,
    fromRange: entry.recipe.fromRange,
    toRange: entry.recipe.toRange,
    source: entry.source,
    file: entry.file,
    hunks: entry.recipe.hunks.length,
    breaking: entry.recipe.breaking.length,
  };
  if (entry.recipe.summary) summary.summary = entry.recipe.summary;
  if (options.fromVersion !== undefined && options.toVersion !== undefined) {
    summary.applies = appliesTo(entry.recipe, options.fromVersion, options.toVersion);
  }
  if (entry.recipe.evidence) summary.evidence = entry.recipe.evidence;
  if (options.recipeId === entry.id) summary.recipe = entry.recipe;
  return summary;
}

/** List the recipes available to a project: its own, its policy's recipe packages and its installed packages'. */
export function listRecipes(options: ListRecipesOptions = {}): RecipeListing {
  const cwd = options.cwd ?? process.cwd();
  const found = discover(cwd, cwd, options.policy);
  return {
    recipes: found.recipes
      .filter((entry) => !options.packageName || entry.recipe.package === options.packageName)
      .map((entry) => summarize(entry, options)),
    problems: found.problems,
  };
}

export interface ApplyRecipeOptions extends AttemptQuery {
  /** Id from `listRecipes` (or `startAttempt`'s `recipes`). */
  recipeId: string;
}

/**
 * Apply a recipe to an open attempt's checkout and judge the result. The recipe is matched against
 * the checkout's source exactly, turned into a diff and put through the same validation as
 * `proposePatch`; the verifier then decides. If it does not pass, the recipe is taken back out and
 * the checkout is as it was.
 */
export async function applyRecipe(
  options: ApplyRecipeOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<AttemptView> {
  const { cwd, store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  const plan = store.readPlan(options.runId);
  const item = plan?.items.find((candidate) => candidate.itemId === record.itemId);
  if (!plan || !item)
    throw new Error(`Attempt ${record.attemptId} refers to a plan item that no longer exists.`);

  const found = discover(cwd, record.worktreePath, plan.options.policy);
  const entry = found.recipes.find((candidate) => candidate.id === options.recipeId);
  if (!entry) throw new Error(`Recipe not found: ${options.recipeId} (see listRecipes).`);
  if (
    entry.recipe.package !== item.packageName ||
    !appliesTo(entry.recipe, item.fromVersion, item.toVersion)
  ) {
    throw new Error(
      `Recipe ${entry.id} is for ${entry.recipe.package} ${entry.recipe.fromRange} to ${entry.recipe.toRange}, not for ${item.packageName} ${item.fromVersion} to ${item.toVersion}.`,
    );
  }

  const application = await applyRecipeToCheckout(record.worktreePath, entry);
  if (!application.ok) throw new Error(`Recipe ${entry.id} does not apply: ${application.reason}`);
  const files = application.applied.files;

  const ledger = store.ledger(options.runId);
  const checked = await verifyAttempt(
    { cwd, runId: options.runId, attemptId: options.attemptId },
    deps,
  );
  if (checked.verification?.passed) {
    ledger.append("attempt.recipe", {
      attemptId: record.attemptId,
      recipeId: entry.id,
      applied: true,
      files,
    });
    return {
      ...checked,
      recipe: { id: entry.id, applied: true, files },
      message: `Recipe ${entry.id} applied to ${files.join(", ")} and the verifier accepted it. Finalize it.`,
    };
  }

  await undoPatch(record.worktreePath, application.applied);
  const rejectedBy = checked.verification?.failedCheck ?? "unknown";
  const restored: AttemptRecord = { ...record, endedAt: new Date().toISOString() };
  store.writeAttempt(options.runId, restored);
  ledger.append("attempt.recipe", {
    attemptId: record.attemptId,
    recipeId: entry.id,
    applied: false,
    rejectedBy,
  });
  return viewOf(restored, options.runId, {
    recipe: { id: entry.id, applied: false, files, rejectedBy },
    message: `Recipe ${entry.id} matched ${files.join(", ")} but the verifier rejected it (${rejectedBy}), so it was undone; the checkout is as it was.`,
  });
}

// ---------------------------------------------------------------------------

export interface CaptureRecipeOptions {
  cwd?: string;
  runId: string;
  /** The attempt to capture (default: the run's latest repaired one). */
  attemptId?: string;
  /** Override the versions the recipe applies from (default: this major, from the observed version). */
  fromRange?: string;
  toRange?: string;
}

export interface CaptureRecipeResult {
  id: string;
  /** Absolute path of the recipe file. */
  path: string;
  /** False when the same recipe was already saved. */
  created: boolean;
  recipe: Recipe;
}

/**
 * Save what a run's agent repair learned in the project's `.autoremediator/recipes/`, where it can
 * be committed, reviewed and shared. The recipe was derived when the repair was accepted, from the
 * diff and the verifier's findings; this copies it out of the run, unchanged unless the ranges are
 * overridden.
 */
export function captureRecipe(options: CaptureRecipeOptions): CaptureRecipeResult {
  const { cwd, store } = context(options);
  store.load(options.runId);
  const candidates = store
    .listAttempts(options.runId)
    .filter(
      (attempt) =>
        attempt.status === "promoted" &&
        (!options.attemptId || attempt.attemptId === options.attemptId),
    )
    .toReversed();
  const chosen = candidates.find((attempt) =>
    existsSync(join(store.attemptDir(options.runId, attempt.attemptId), "recipe.json")),
  );
  if (!chosen) {
    throw new Error(
      options.attemptId
        ? `Attempt ${options.attemptId} has no recipe to capture (it was not a promoted agent repair, or it changed no source a recipe can describe).`
        : `Run ${options.runId} has no promoted agent repair with a recipe to capture.`,
    );
  }

  const recipe = parseRecipe(
    readFileSync(join(store.attemptDir(options.runId, chosen.attemptId), "recipe.json"), "utf8"),
  );
  const withRanges: Recipe = {
    ...recipe,
    fromRange: options.fromRange ?? recipe.fromRange,
    toRange: options.toRange ?? recipe.toRange,
  };
  const checked = parseRecipe(JSON.stringify(withRanges));
  const saved = saveProjectRecipe(cwd, checked);
  return { id: saved.id, path: saved.path, created: saved.created, recipe: checked };
}

export interface ExportRecipesOptions {
  cwd?: string;
  /** Directory to create the package in (must not exist, or be empty). */
  outDir: string;
  /** npm name of the recipes package, e.g. `@acme/autoremediator-recipes`. */
  name: string;
  version?: string;
  /** Only these packages' recipes (default: all of the project's). */
  packages?: string[];
}

/** Write a publishable npm package of the project's recipes. Nothing is published. */
export function exportRecipes(options: ExportRecipesOptions): ExportResult {
  return exportRecipePackage({
    projectDir: options.cwd ?? process.cwd(),
    outDir: options.outDir,
    name: options.name,
    ...(options.version ? { version: options.version } : {}),
    ...(options.packages ? { packages: options.packages } : {}),
  });
}

export type { ExportResult, RecipeEntry };
export { rangeAround, recipeId, defaultAttemptDeps, withVerification };
