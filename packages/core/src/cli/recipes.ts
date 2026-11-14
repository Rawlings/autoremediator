/** `autoremediator recipes list | show | capture | export`. See docs/guides/recipes.md. */
import { relative } from "node:path";

import type { Command } from "commander";

import { captureRecipe, exportRecipes, listRecipes, OPTION_DESCRIPTIONS } from "../api/index.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

interface RecipesCliOptions {
  cwd: string;
  outputFormat: "text" | "json";
  package?: string[];
  from?: string;
  to?: string;
  run?: string;
  attempt?: string;
  fromRange?: string;
  toRange?: string;
  name?: string;
  out?: string;
  packageVersion?: string;
}

const out = (text: string) => process.stdout.write(`${text}\n`);

const common = (command: Command): Command =>
  command
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text");

const action =
  (name: string, run: (args: string[], opts: RecipesCliOptions) => void | Promise<void>) =>
  async (...received: unknown[]) => {
    const command = received.at(-1) as Command;
    const opts = command.opts<RecipesCliOptions>();
    validateOutputFormat(opts.outputFormat, ["text", "json"], `recipes ${name}`);
    await run(received.slice(0, -2).filter((arg): arg is string => typeof arg === "string"), opts);
  };

const sourceLabel = (source: { kind: string; package?: string }): string =>
  source.kind === "project" ? "this project" : `${source.kind === "installed" ? "shipped by" : "recipes package"} ${source.package}`;

export function addRecipesCommand(program: Command): void {
  const recipes = program
    .command("recipes")
    .description("Recipes: what earlier repairs learned about adopting a new version of a dependency, kept as data");

  common(
    recipes
      .command("list")
      .description("List the recipes available to this project")
      .option("--package <name>", "Only recipes for this package")
      .option("--from <version>", "With --to: mark which recipes apply to upgrading from this version")
      .option("--to <version>", "With --from: the version upgraded to"),
  ).action(
    action("list", (_args, opts) => {
      const listing = listRecipes({
        cwd: opts.cwd,
        ...(typeof opts.package === "string" ? { packageName: opts.package } : {}),
        ...(opts.from && opts.to ? { fromVersion: opts.from, toVersion: opts.to } : {}),
      });
      if (opts.outputFormat === "json") return logJson(listing);
      if (listing.recipes.length === 0) out("No recipes.");
      for (const entry of listing.recipes) {
        const applies = entry.applies === undefined ? "" : entry.applies ? "  [applies]" : "  [does not apply]";
        out(`${entry.id}  ${entry.package} ${entry.fromRange} -> ${entry.toRange}  ${entry.hunks} hunk(s)  ${sourceLabel(entry.source)}${applies}`);
        if (entry.summary) out(`    ${entry.summary}`);
      }
      for (const problem of listing.problems) out(`unusable: ${problem.file}: ${problem.error}`);
    }),
  );

  common(
    recipes
      .command("show")
      .description("Show one recipe: what broke, the change it makes, and the evidence it was captured with")
      .argument("<id>", "Recipe id from `recipes list`"),
  ).action(
    action("show", ([id], opts) => {
      const entry = listRecipes({ cwd: opts.cwd, recipeId: id! }).recipes.find((candidate) => candidate.id === id);
      if (!entry?.recipe) throw new Error(`Recipe not found: ${id}`);
      const { recipe } = entry;
      if (opts.outputFormat === "json") return logJson({ id: entry.id, source: entry.source, file: entry.file, recipe });
      out(`${entry.id}  ${sourceLabel(entry.source)}  (${entry.file})`);
      out(`${recipe.package}: from ${recipe.fromRange} to ${recipe.toRange}`);
      if (recipe.summary) out(recipe.summary);
      for (const broke of recipe.breaking) out(`  broke: ${broke.kind}${broke.symbol ? ` ${broke.symbol}` : ""}: ${broke.message}`);
      for (const [index, hunk] of recipe.hunks.entries()) {
        out(`\nhunk ${index + 1}${hunk.optional ? " (optional)" : ""}${hunk.note ? `: ${hunk.note}` : ""}`);
        for (const line of hunk.before) out(`   ${line}`);
        for (const line of hunk.remove) out(`-  ${line}`);
        for (const line of hunk.add) out(`+  ${line}`);
        for (const line of hunk.after) out(`   ${line}`);
      }
      if (recipe.evidence) {
        out(`\nevidence: run ${recipe.evidence.runId ?? "?"}, attempt ${recipe.evidence.attemptId ?? "?"}, by ${recipe.evidence.agent ?? "?"}`);
        out(`  checks: ${recipe.evidence.checks.map((check) => `${check.name} ${check.status}`).join(", ") || "none recorded"}`);
      }
    }),
  );

  common(
    recipes
      .command("capture")
      .description("Save what a run's agent repair learned into .autoremediator/recipes/ (commit it to share it)")
      .requiredOption("--run <runId>", "The run whose repair to capture")
      .option("--attempt <attemptId>", "The attempt (default: the run's latest repaired one)")
      .option("--from-range <range>", "Versions the recipe applies from (default: this major, from the observed version)")
      .option("--to-range <range>", "Versions the recipe applies to (default: this major, from the observed version)"),
  ).action(
    action("capture", (_args, opts) => {
      const saved = captureRecipe({
        cwd: opts.cwd,
        runId: opts.run!,
        ...(opts.attempt ? { attemptId: opts.attempt } : {}),
        ...(opts.fromRange ? { fromRange: opts.fromRange } : {}),
        ...(opts.toRange ? { toRange: opts.toRange } : {}),
      });
      if (opts.outputFormat === "json") return logJson(saved);
      out(`${saved.created ? "Saved" : "Already saved"} ${saved.id} in ${relative(opts.cwd, saved.path) || saved.path}`);
      out("Review it, then commit it (add `!.autoremediator/recipes/` to .gitignore if .autoremediator is ignored).");
    }),
  );

  common(
    recipes
      .command("export")
      .description("Write the project's recipes as a publishable npm package skeleton (publishes nothing)")
      .requiredOption("--name <name>", "npm name of the recipes package, e.g. @acme/autoremediator-recipes")
      .requiredOption("--out <dir>", "Directory to create (must not exist, or be empty)")
      .option("--package <name...>", "Only recipes for these packages")
      .option("--package-version <version>", "Version for package.json (default 0.1.0)"),
  ).action(
    action("export", (_args, opts) => {
      const result = exportRecipes({
        cwd: opts.cwd,
        outDir: opts.out!,
        name: opts.name!,
        ...(opts.packageVersion ? { version: opts.packageVersion } : {}),
        ...(Array.isArray(opts.package) ? { packages: opts.package } : {}),
      });
      if (opts.outputFormat === "json") return logJson({ outDir: result.outDir, files: result.files, recipes: result.recipes.map((entry) => entry.id) });
      out(`Wrote ${result.recipes.length} recipe(s) to ${result.outDir}:`);
      for (const file of result.files) out(`  ${file}`);
      out("Review them, then publish with `npm publish` from that directory.");
    }),
  );
}
