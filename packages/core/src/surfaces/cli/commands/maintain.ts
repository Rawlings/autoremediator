import { createInterface } from "node:readline/promises";

import type { Command } from "commander";

import {
  EXIT_CODES,
  maintain,
  OPTION_DESCRIPTIONS,
  readMaintainerVex,
  type MaintainOptions,
  type MaintainResult,
  type MaintainerVexReport,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import { validateOutputFormat } from "../validators.js";

interface MaintainCliOptions {
  cwd: string;
  advisories?: string;
  assertNotAffected?: boolean;
  traceFile?: string;
  policy?: string;
  packageManager?: MaintainOptions["packageManager"];
  offline?: boolean;
  intelligenceSnapshot?: string;
  nextVersion?: string;
  yes?: boolean;
  outputFormat: string;
}

interface VexShowCliOptions {
  cwd: string;
  advisory?: string;
  package?: string;
  outputFormat: string;
}

export function describeMaintain(result: MaintainResult): string {
  const lines = [
    `Maintaining ${result.package.name}@${result.package.version}${result.nextVersion ? ` (next release ${result.nextVersion})` : ""}`,
  ];
  if (result.advisories.length === 0)
    lines.push("No advisories found for this project's dependencies.");
  for (const advisory of result.advisories) {
    lines.push(
      `  ${advisory.id}${advisory.severity ? ` [${advisory.severity}]` : ""}: ${advisory.decision}`,
      `    ${advisory.reason}`,
    );
    for (const entry of advisory.packages) {
      lines.push(
        `    - ${entry.name}@${entry.version} (${entry.scope})${entry.reachability ? `, ${entry.reachability}` : ""}`,
      );
    }
    if (advisory.plan) {
      lines.push(
        advisory.plan.items.length > 0
          ? `    bump plan: ${advisory.plan.items.map((item) => `${item.packageName} ${item.fromVersion} -> ${item.toVersion}`).join(", ")}${advisory.plan.runId ? ` (run ${advisory.plan.runId}; review with \`runs show\`, apply with \`runs apply\`)` : " (not recorded; --yes records it)"}`
          : "    bump plan: no version change available",
      );
    }
  }
  for (const change of result.changes)
    lines.push(`  ${change.action.padEnd(9)} ${change.path}: ${change.reason}`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function runMaintain(opts: MaintainCliOptions): Promise<void> {
  const base: MaintainOptions = {
    cwd: opts.cwd,
    source: "cli",
    ...(opts.advisories
      ? {
          advisories: opts.advisories
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id !== ""),
        }
      : {}),
    ...(opts.assertNotAffected ? { assertNotAffected: true } : {}),
    ...(opts.traceFile ? { traceFile: opts.traceFile } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.packageManager ? { packageManager: opts.packageManager } : {}),
    ...(opts.offline ? { offlineIntelligence: true } : {}),
    ...(opts.intelligenceSnapshot ? { intelligenceSnapshotPath: opts.intelligenceSnapshot } : {}),
    ...(opts.nextVersion ? { nextVersion: opts.nextVersion } : {}),
  };
  let result = await maintain({ ...base, yes: opts.yes });
  const json = opts.outputFormat === "json";
  const interactive = !json && !opts.yes && process.stdin.isTTY && process.stdout.isTTY;

  if (!json) {
    process.stdout.write(`${describeMaintain(result)}\n`);
    if (!result.applied) {
      for (const change of result.changes) {
        if (change.diff) process.stdout.write(`\n${change.diff}\n`);
      }
    }
  }

  if (interactive && result.drift) {
    if (
      await confirm(
        `\nWrite ${result.changes.filter((change) => change.diff).length} file(s)? [y/N] `,
      )
    ) {
      result = await maintain({ ...base, yes: true });
      process.stdout.write(
        "Written. Nothing was published or pushed: review, commit and release as usual.\n",
      );
    }
    return;
  }

  if (json) logJson(result);
  else if (result.applied) {
    process.stdout.write(
      "\nWritten. Nothing was published or pushed: review, commit and release as usual.\n",
    );
  } else if (result.drift)
    process.stdout.write("\nNothing written. Run again with --yes to apply.\n");
  else process.stdout.write("\nNothing to change.\n");

  if (result.conflicts.length > 0) process.exitCode = EXIT_CODES.failed;
  else if (!result.applied && result.drift) process.exitCode = EXIT_CODES.needsApproval;
}

export function describeVexShow(report: MaintainerVexReport): string {
  const lines = [
    `Read ${report.scanned} installed package(s): ${report.packages.length} ship usable VEX, ${report.rejected.length} declaration(s) rejected.`,
  ];
  for (const entry of report.packages) {
    lines.push(
      `${entry.name}@${entry.version}  ${entry.file}  (author ${entry.author}, ${entry.timestamp})`,
    );
    for (const statement of entry.statements) {
      const about =
        statement.subcomponents.length > 0 ? ` about ${statement.subcomponents.join(", ")}` : "";
      lines.push(
        `  ${statement.vulnerability}${about}: ${statement.status}${statement.justification ? ` (${statement.justification})` : ""}`,
      );
      if (statement.impactStatement) lines.push(`    ${statement.impactStatement}`);
      if (statement.statusNotes) lines.push(`    ${statement.statusNotes}`);
    }
  }
  for (const entry of report.rejected) {
    lines.push(
      `rejected ${entry.package}${entry.version ? `@${entry.version}` : ""}: ${entry.reason}`,
    );
  }
  if (report.own.declared) {
    lines.push(
      `This project: package.json#vex -> ${report.own.file ?? "(invalid)"}: ${report.own.status}${report.own.statements === undefined ? "" : `, ${report.own.statements} statement(s)`}${report.own.reason ? `. ${report.own.reason}` : ""}`,
    );
  } else {
    lines.push("This project declares no package.json#vex.");
  }
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}

/** Register `maintain` and `vex show`. */
export function registerMaintainCommands(program: Command): void {
  program
    .command("maintain")
    .description(
      "For package authors: assess advisories in your dependencies against your own code and prepare (never publish or push) a bump plan, a changeset and an OpenVEX statement shipped in the package. Shows a diff; writes only with --yes or after you confirm",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--advisories <list>",
      "CVE or GHSA ids to assess, comma-separated (default: the package manager's audit)",
    )
    .option(
      "--assert-not-affected",
      "Vouch for the static scan: unreachable dependencies are written as not_affected instead of under_investigation",
    )
    .option("--trace-file <path>", "A runtime trace from `trace run`, added to the static evidence")
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--offline", "No network: needs --advisories and --intelligence-snapshot")
    .option("--intelligence-snapshot <path>", OPTION_DESCRIPTIONS.intelligenceSnapshotPath)
    .option(
      "--next-version <version>",
      "The exact version the next release will have (default: derived from pending changesets, else the next patch)",
    )
    .option("--yes", "Write the changes without asking")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: MaintainCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "maintain");
      await runMaintain(opts);
    });

  const vex = program
    .command("vex")
    .description("Inspect the OpenVEX documents that packages ship (package.json#vex)");
  vex
    .command("show")
    .description(
      "List the VEX documents shipped by installed packages (validated, untrusted input) and check this project's own",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--advisory <id>", "Only statements that name this CVE or GHSA id")
    .option("--package <name>", "Only the document shipped by this package")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action((opts: VexShowCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "vex show");
      const report = readMaintainerVex({
        cwd: opts.cwd,
        ...(opts.advisory ? { advisory: opts.advisory } : {}),
        ...(opts.package ? { packageName: opts.package } : {}),
      });
      if (opts.outputFormat === "json") logJson(report);
      else process.stdout.write(`${describeVexShow(report)}\n`);
    });
}
