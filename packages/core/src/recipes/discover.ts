/**
 * Where recipes come from, and how much each source is trusted.
 *
 * - The project's own `.autoremediator/recipes/` (committed, so reviewed like any other file): any package.
 * - A package named in the policy (`recipes: { packages: [...] }`): you chose to trust it, any package.
 * - Any installed package's `autoremediator-recipes/` directory: only recipes about that same
 *   package, because a dependency has no business changing how you adopt a different one.
 *
 * A recipe file is read as data: regular files only (no symlinks), size-capped, validated. One that
 * fails validation is reported as a problem and never used; it does not hide the others.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { appliesTo } from "./engine.js";
import { MAX_RECIPE_BYTES, NPM_PACKAGE_NAME, parseRecipe, recipeId, type Recipe } from "./schema.js";

export const PROJECT_RECIPES_DIR = ".autoremediator/recipes";
export const INSTALLED_RECIPES_DIR = "autoremediator-recipes";
export const PACKAGE_RECIPES_DIR = "recipes";

const MAX_DEPTH = 4;
const MAX_FILES_PER_SOURCE = 500;

export type RecipeSource =
  | { kind: "project" }
  | { kind: "policy-package"; package: string }
  | { kind: "installed"; package: string };

export interface RecipeEntry {
  id: string;
  source: RecipeSource;
  /** Where it was read from (relative to the directory searched). */
  file: string;
  recipe: Recipe;
}

export interface RecipeProblem {
  file: string;
  error: string;
}

export interface Discovery {
  recipes: RecipeEntry[];
  problems: RecipeProblem[];
}

export interface DiscoverOptions {
  /** The project, for its committed recipes. */
  projectDir: string;
  /** Where `node_modules` is searched (the project, or an attempt's checkout); none when omitted. */
  installRoot?: string;
  /** Where a policy recipes package is looked for if `installRoot` lacks it (the project itself, for a checkout). */
  fallbackInstallRoot?: string;
  /** Packages the policy names as recipe packages. */
  policyPackages?: readonly string[];
}

/** Regular `.json` files under `root`, without following symlinks, bounded in depth and count. */
function jsonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES_PER_SOURCE) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json") && found.length < MAX_FILES_PER_SOURCE) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

function readRecipeFile(file: string): Recipe {
  const stats = lstatSync(file);
  if (!stats.isFile()) throw new Error("not a regular file");
  if (stats.size > MAX_RECIPE_BYTES) throw new Error(`larger than ${MAX_RECIPE_BYTES} bytes`);
  return parseRecipe(readFileSync(file, "utf8"));
}

function collect(
  root: string,
  display: string,
  source: RecipeSource,
  accept: (recipe: Recipe) => string | undefined,
  into: Discovery,
): void {
  if (!existsSync(root)) return;
  for (const file of jsonFiles(root)) {
    const shown = join(display, relative(root, file).split(sep).join("/"));
    try {
      const recipe = readRecipeFile(file);
      const rejected = accept(recipe);
      if (rejected) into.problems.push({ file: shown, error: rejected });
      else into.recipes.push({ id: recipeId(recipe), source, file: shown, recipe });
    } catch (error) {
      into.problems.push({ file: shown, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** A package directory under `node_modules`, resolved through pnpm-style links but kept inside the real tree. */
function packageDir(installRoot: string, name: string): string | undefined {
  if (!NPM_PACKAGE_NAME.test(name)) return undefined;
  const dir = join(installRoot, "node_modules", ...name.split("/"));
  try {
    return existsSync(dir) ? realpathSync(dir) : undefined;
  } catch {
    return undefined;
  }
}

function installedPackageNames(installRoot: string): string[] {
  const modules = join(installRoot, "node_modules");
  let top;
  try {
    top = readdirSync(modules, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of top) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      try {
        for (const inner of readdirSync(join(modules, entry.name))) names.push(`${entry.name}/${inner}`);
      } catch {
        // An unreadable scope directory has no recipes to offer.
      }
    } else names.push(entry.name);
  }
  return names.filter((name) => NPM_PACKAGE_NAME.test(name)).toSorted();
}

export function discoverRecipes(options: DiscoverOptions): Discovery {
  const found: Discovery = { recipes: [], problems: [] };

  collect(join(options.projectDir, PROJECT_RECIPES_DIR), PROJECT_RECIPES_DIR, { kind: "project" }, () => undefined, found);

  const { installRoot } = options;
  for (const name of options.policyPackages ?? []) {
    const dir =
      (installRoot ? packageDir(installRoot, name) : undefined) ??
      (options.fallbackInstallRoot ? packageDir(options.fallbackInstallRoot, name) : undefined);
    if (!dir) {
      found.problems.push({ file: name, error: "named in the policy as a recipes package but not installed" });
      continue;
    }
    for (const sub of [PACKAGE_RECIPES_DIR, INSTALLED_RECIPES_DIR]) {
      collect(join(dir, sub), `${name}/${sub}`, { kind: "policy-package", package: name }, () => undefined, found);
    }
  }

  for (const name of installRoot ? installedPackageNames(installRoot) : []) {
    const dir = installRoot ? packageDir(installRoot, name) : undefined;
    if (!dir) continue;
    collect(
      join(dir, INSTALLED_RECIPES_DIR),
      `${name}/${INSTALLED_RECIPES_DIR}`,
      { kind: "installed", package: name },
      (recipe) =>
        recipe.package === name
          ? undefined
          : `ignored: ${name} may only ship recipes for itself, this one is for ${recipe.package}`,
      found,
    );
  }

  // The first source wins when the same recipe is found twice (project, then policy, then installed).
  const seen = new Set<string>();
  found.recipes = found.recipes.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
  return found;
}

/** Recipes for upgrading `packageName` from `fromVersion` to `toVersion`. */
export function recipesFor(
  discovery: Discovery,
  packageName: string,
  fromVersion: string,
  toVersion: string,
): RecipeEntry[] {
  return discovery.recipes.filter(
    (entry) => entry.recipe.package === packageName && appliesTo(entry.recipe, fromVersion, toVersion),
  );
}
