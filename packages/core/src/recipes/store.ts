/** Writing recipes: into the project's committed directory, or out as a publishable npm package. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { discoverRecipes, PACKAGE_RECIPES_DIR, PROJECT_RECIPES_DIR, type RecipeEntry } from "./discover.js";
import { NPM_PACKAGE_NAME, recipeId, serializeRecipe, type Recipe } from "./schema.js";

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");

/** File name for a recipe inside its package's directory. */
export function recipeFileName(recipe: Recipe): string {
  const hash = recipeId(recipe).split("#")[1] ?? "recipe";
  return recipe.observed
    ? `${safeSegment(recipe.observed.fromVersion)}-to-${safeSegment(recipe.observed.toVersion)}.json`
    : `${hash}.json`;
}

/** `<root>/<package>/<file>`, refusing anything that resolves outside `root`. */
function insideRoot(root: string, packageName: string, fileName: string): string {
  if (!NPM_PACKAGE_NAME.test(packageName)) throw new Error(`not a package name: ${JSON.stringify(packageName)}`);
  const target = resolve(root, ...packageName.split("/"), fileName);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) throw new Error("the recipe path escapes its directory");
  return target;
}

export interface SavedRecipe {
  id: string;
  /** Absolute path written (or already holding the same recipe). */
  path: string;
  created: boolean;
}

/** Save a recipe in the project's `.autoremediator/recipes/<package>/`. The same recipe is not written twice. */
export function saveProjectRecipe(projectDir: string, recipe: Recipe): SavedRecipe {
  const id = recipeId(recipe);
  const root = join(projectDir, PROJECT_RECIPES_DIR);
  const existing = discoverRecipes({ projectDir }).recipes.find(
    (entry) => entry.id === id && entry.source.kind === "project",
  );
  if (existing) return { id, path: join(projectDir, existing.file), created: false };

  let path = insideRoot(root, recipe.package, recipeFileName(recipe));
  if (existsSync(path)) path = insideRoot(root, recipe.package, `${recipeFileName(recipe).replace(/\.json$/, "")}-${id.split("#")[1]}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRecipe(recipe), { encoding: "utf8", flag: "wx" });
  return { id, path, created: true };
}

export interface ExportOptions {
  projectDir: string;
  /** Directory to create the package in; it must not exist or must be empty. */
  outDir: string;
  /** npm name of the recipes package. */
  name: string;
  version?: string;
  /** Only export recipes for these packages (default: all the project's recipes). */
  packages?: readonly string[];
}

export interface ExportResult {
  outDir: string;
  files: string[];
  recipes: RecipeEntry[];
}

/**
 * Write a publishable npm package of the project's own recipes: `package.json`, a README that says
 * how to use it, and `recipes/<package>/<file>.json`. Nothing is published.
 */
export function exportRecipePackage(options: ExportOptions): ExportResult {
  if (!NPM_PACKAGE_NAME.test(options.name)) throw new Error(`"${options.name}" is not a valid npm package name`);
  const version = options.version ?? "0.1.0";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`"${version}" is not a valid version`);

  const outDir = resolve(options.outDir);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} already exists and is not empty; choose a new directory`);
  }

  const wanted = options.packages ? new Set(options.packages) : undefined;
  const recipes = discoverRecipes({ projectDir: options.projectDir })
    .recipes.filter((entry) => entry.source.kind === "project" && (!wanted || wanted.has(entry.recipe.package)));
  if (recipes.length === 0) {
    throw new Error(
      wanted
        ? `no recipes for ${[...wanted].join(", ")} in ${PROJECT_RECIPES_DIR}`
        : `there are no recipes in ${PROJECT_RECIPES_DIR} to export (capture some with \`autoremediator recipes capture\`)`,
    );
  }

  const files: string[] = [];
  const write = (relativePath: string, content: string): void => {
    const target = resolve(outDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
    files.push(relativePath);
  };

  const used = new Set<string>();
  for (const entry of recipes.toSorted((a, b) => (a.id < b.id ? -1 : 1))) {
    let name = recipeFileName(entry.recipe);
    if (used.has(`${entry.recipe.package}/${name}`)) name = `${name.replace(/\.json$/, "")}-${entry.id.split("#")[1]}.json`;
    used.add(`${entry.recipe.package}/${name}`);
    write(`${PACKAGE_RECIPES_DIR}/${entry.recipe.package}/${name}`, serializeRecipe(entry.recipe));
  }

  const covered = [...new Set(recipes.map((entry) => entry.recipe.package))].toSorted();
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: options.name,
        version,
        description: `Autoremediator recipes: how to adopt new versions of ${covered.join(", ")}`,
        keywords: ["autoremediator", "autoremediator-recipes"],
        files: [PACKAGE_RECIPES_DIR, "README.md"],
      },
      null,
      2,
    )}\n`,
  );
  write(
    "README.md",
    [
      `# ${options.name}`,
      "",
      "Autoremediator recipes: data that describes, for a dependency upgrade, the change to the code that uses",
      "it. Recipes are never executable and never trusted: autoremediator matches them against your source",
      "exactly, validates the result like any other proposed patch, and keeps it only if the verifier passes.",
      "",
      `Covers: ${covered.map((name) => `\`${name}\``).join(", ")}.`,
      "",
      "## Use",
      "",
      "```sh",
      `npm install --save-dev ${options.name}`,
      "```",
      "",
      "Then name it in `.github/autoremediator.yml`:",
      "",
      "```yaml",
      "recipes:",
      "  packages:",
      `    - "${options.name}"`,
      "```",
      "",
      "## Publish",
      "",
      "```sh",
      "npm publish --access public   # review recipes/ first: they change your users' source code",
      "```",
      "",
    ].join("\n"),
  );
  return { outDir, files, recipes };
}
