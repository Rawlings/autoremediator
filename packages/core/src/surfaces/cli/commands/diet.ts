import type { Command } from "commander";

import {
  analyzeDependencies,
  removeUnusedDependencies,
  type DependencyDietReport,
  type DietApplyResult,
  EXIT_CODES,
  OPTION_DESCRIPTIONS,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import { validateOutputFormat } from "../validators.js";

export interface DietCliOptions {
  cwd?: string;
  apply?: boolean;
  runTests?: boolean;
  typecheck?: boolean;
  policy?: string;
  packageManager?: string;
  outputFormat?: string;
  /** Print every package and duplicate, not the first few. */
  verbose?: boolean;
}

const DIET_LIST_LIMIT = 12;

export function describeDiet(report: DependencyDietReport, verbose = false): string {
  const lines: string[] = [];
  const { summary, attackSurface } = report;
  lines.push(
    `Dependency diet for ${report.root}`,
    `Attack-surface score: ${attackSurface.score}/100 (higher means more code you did not write runs in this project)`,
  );
  for (const component of attackSurface.components) {
    lines.push(
      `  ${component.points.toFixed(1).padStart(5)} / ${String(component.maxPoints).padEnd(2)}  ${component.label}: ${component.value}  [${component.formula}]`,
    );
  }
  for (const limit of attackSurface.limits) lines.push(`  note: ${limit}`);

  lines.push(
    "",
    `Unused: ${summary.certainlyUnused} certainly, ${summary.probablyUnused} probably, ${summary.usedIndirectly} used indirectly.  Replaceable: ${summary.replaceable}.  Duplicated packages: ${summary.duplicatedPackages}.`,
  );

  for (const pkg of report.packages) {
    const shown = pkg.unused.filter(
      (entry) => verbose || entry.classification !== "used-indirectly",
    );
    if (shown.length === 0 && pkg.replaceable.length === 0) continue;
    lines.push(
      "",
      `${pkg.name} (${pkg.dir})${pkg.node ? `  Node ${pkg.node.range} from ${pkg.node.source}` : "  no Node minimum declared"}`,
    );
    for (const entry of shown) {
      lines.push(
        `  ${entry.classification.padEnd(16)} ${entry.name} (${entry.section})`,
        `    ${entry.reason}`,
      );
      if (entry.evidence?.length) lines.push(`    evidence: ${entry.evidence.join(", ")}`);
    }
    for (const entry of pkg.replaceable) {
      lines.push(
        `  ${entry.status.padEnd(16)} ${entry.name} -> ${entry.replacement} [${entry.fit}]`,
        `    ${entry.migration}`,
        `    ${entry.reason}`,
      );
      if (entry.caveat) lines.push(`    caveat: ${entry.caveat}`);
    }
  }

  const { duplicates } = report;
  lines.push("");
  if (!duplicates.supported) lines.push(`Duplicates: not analysed. ${duplicates.note ?? ""}`);
  else if (duplicates.packages.length === 0) lines.push("Duplicates: none.");
  else {
    lines.push(
      `Duplicates: ${duplicates.packages.length} packages installed at several versions (${duplicates.extraCopies} extra copies).`,
    );
    for (const entry of duplicates.packages.slice(0, verbose ? undefined : DIET_LIST_LIMIT)) {
      lines.push(
        `  ${entry.name}  ${entry.versions.map((version) => version.version).join(", ")}  [${entry.verdict}]`,
        `    ${entry.summary}`,
      );
      for (const version of entry.versions) {
        const parents = version.parents
          .slice(0, 4)
          .map(
            (parent) =>
              `${parent.name}${parent.version ? `@${parent.version}` : ""}${parent.range ? ` (${parent.range})` : ""}`,
          );
        const more = version.parents.length > 4 ? ` and ${version.parents.length - 4} more` : "";
        lines.push(
          `    ${version.version} <- ${parents.join(", ")}${more}${version.movableTo ? `  [can move to ${version.movableTo}]` : ""}`,
        );
      }
    }
    if (!verbose && duplicates.packages.length > DIET_LIST_LIMIT) {
      lines.push(
        `  ... ${duplicates.packages.length - DIET_LIST_LIMIT} more (use --verbose or --output-format json)`,
      );
    }
  }
  for (const note of report.notes) lines.push("", `note: ${note}`);
  return lines.join("\n");
}

function describeDietApply(result: DietApplyResult): string {
  const lines = [result.message];
  for (const removal of result.removals) {
    lines.push(
      `  ${result.status === "removed" ? "removed" : "would remove"} ${removal.name} (${removal.section}, ${removal.dir})`,
    );
  }
  for (const check of result.verification?.checks ?? []) {
    lines.push(`  ${check.status.padEnd(7)} ${check.name}: ${check.message}`);
  }
  return lines.join("\n");
}

export async function runDiet(opts: DietCliOptions): Promise<void> {
  if (opts.apply) {
    const result = await removeUnusedDependencies({
      cwd: opts.cwd,
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.packageManager
        ? { packageManager: opts.packageManager as "npm" | "pnpm" | "yarn" | "bun" | "deno" }
        : {}),
      ...(opts.runTests === undefined ? {} : { runTests: opts.runTests }),
      ...(opts.typecheck === undefined ? {} : { typecheck: opts.typecheck }),
    });
    if (opts.outputFormat === "json") logJson(result);
    else {
      process.stdout.write(
        `${describeDiet(result.report, opts.verbose)}\n\n${describeDietApply(result)}\n`,
      );
    }
    if (result.status === "rolled-back" || result.status === "failed") {
      process.exitCode = EXIT_CODES.failed;
    }
    return;
  }
  const report = await analyzeDependencies({ cwd: opts.cwd });
  if (opts.outputFormat === "json") logJson(report);
  else process.stdout.write(`${describeDiet(report, opts.verbose)}\n`);
}

export function registerDietCommand(program: Command): void {
  program
    .command("diet")
    .description(
      "Report what the project could stop depending on: unused dependencies, micro-packages a Node built-in replaces, duplicate versions, and an attack-surface score. With --apply, remove only the certainly-unused dependencies, verify, and roll back on any failure",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--apply",
      "Remove the certainly-unused dependencies through npm or pnpm, then verify and roll back if any check fails",
    )
    .option("--run-tests", "With --apply: also run the project's tests during verification")
    .option("--no-typecheck", "With --apply: skip the type check during verification")
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option(
      "--package-manager <name>",
      "With --apply: package manager to use (auto-detected from the lockfile)",
    )
    .option("--verbose", "List every duplicate and every indirectly used dependency")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: DietCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "diet");
      if (!opts.apply && (opts.runTests || opts.typecheck === false || opts.packageManager)) {
        throw new Error(
          "--run-tests, --no-typecheck and --package-manager only apply with --apply.",
        );
      }
      await runDiet(opts);
    });
}
