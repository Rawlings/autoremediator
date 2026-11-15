import type { Command } from "commander";

import {
  guardPackages,
  guardGitDiff,
  guardExitCode,
  runHostHook,
  type HookHost,
  type GuardReport,
  OPTION_DESCRIPTIONS,
} from "../../../api/index.js";
import { HOOK_HOSTS } from "../../../features/guard/hook.js";
import { logJson } from "../output.js";
import type { OutputFormat } from "../types.js";
import { validateOutputFormat } from "../validators.js";

export interface GuardCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  minAgeHours?: number;
  offline?: boolean;
  /** Guard the dependencies added or changed since `base` instead of the packages named. */
  gitDiff?: boolean;
  base?: string;
  includeTransitive?: boolean;
}

function describeGuard(report: GuardReport): string {
  const lines = [
    `${report.verdict.toUpperCase().padEnd(5)} ${report.spec}${report.resolvedVersion ? ` (${report.resolvedVersion})` : ""}`,
  ];
  for (const finding of report.findings) {
    lines.push(`  ${finding.severity.padEnd(5)} ${finding.check}: ${finding.message}`);
  }
  if (report.alternative) {
    const { packageName, version, reason } = report.alternative;
    lines.push(`  instead: ${packageName}${version ? `@${version}` : ""} (${reason})`);
  }
  return lines.join("\n");
}

export async function runGuard(specs: string[], opts: GuardCliOptions): Promise<void> {
  const options = {
    cwd: opts.cwd,
    ...(opts.minAgeHours === undefined ? {} : { minPublishAgeHours: opts.minAgeHours }),
    ...(opts.offline ? { offline: true } : {}),
  };
  if (opts.gitDiff) {
    const result = await guardGitDiff({
      ...options,
      ...(opts.base ? { baseRef: opts.base } : {}),
      ...(opts.includeTransitive ? { includeTransitive: true } : {}),
    });
    if (opts.outputFormat === "json") logJson(result);
    else {
      const head = `Dependencies added or changed since ${result.baseRef.slice(0, 12)}: ${result.checked} checked, ${result.skipped.length} skipped`;
      const skipped = result.skipped.map(
        (entry) => `  skip  ${entry.packageName}@${entry.version}: ${entry.reason}`,
      );
      process.stdout.write(
        `${[head, ...skipped, ...result.reports.map((entry) => describeGuard(entry))].join("\n")}\n`,
      );
    }
    process.exitCode = guardExitCode(result.reports);
    return;
  }
  if (specs.length === 0) {
    throw new Error(
      "Name at least one package, or use --git-diff to check what changed in the working tree.",
    );
  }
  const reports = await guardPackages(specs, options);
  if (opts.outputFormat === "json") logJson(reports.length === 1 ? reports[0] : reports);
  else process.stdout.write(`${reports.map((entry) => describeGuard(entry)).join("\n")}\n`);
  process.exitCode = guardExitCode(reports);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Agent pre-command hook: JSON on stdin, the host's permission decision on stdout, always exit 0. */
export async function runGuardHook(host: HookHost = "claude-code"): Promise<void> {
  const output = await runHostHook(host, await readStdin());
  if (output) process.stdout.write(`${output}\n`);
}

export function registerGuardCommand(program: Command): void {
  program
    .command("guard [packages...]")
    .description(
      "Judge npm packages before installing them: existence, malware, look-alike names, release age, install scripts, provenance, vulnerabilities. Exits 0 clear, 3 check first, 4 blocked",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--min-age-hours <hours>",
      "Block releases younger than this (default 72, 0 turns it off)",
      (value: string) => Number.parseFloat(value),
    )
    .option("--offline", "Skip the OSV malware and advisory lookups")
    .option(
      "--git-diff",
      "Check the dependencies added or changed in package.json since --base instead of naming packages",
    )
    .option(
      "--base <ref>",
      "With --git-diff: git ref to compare with (default HEAD; a branch is compared at the merge base)",
    )
    .option("--include-transitive", "With --git-diff: also check packages only the lockfile gained")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (packages: string[], opts: Parameters<typeof runGuard>[1]) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "guard");
      await runGuard(packages, opts);
    });
}

export function registerGuardHookCommand(program: Command): void {
  program
    .command("guard-hook")
    .description(
      "Agent pre-command hook (Claude Code, Cursor, Copilot): reads the hook JSON on stdin and answers allow, ask or deny for package installs",
    )
    .option(
      "--host <host>",
      `Agent host whose hook format to speak: ${HOOK_HOSTS.join("|")}`,
      "claude-code",
    )
    .action(async (opts: { host: string }) => {
      if (!HOOK_HOSTS.includes(opts.host as HookHost)) {
        throw new Error(`Unknown host "${opts.host}". Use one of: ${HOOK_HOSTS.join(", ")}.`);
      }
      await runGuardHook(opts.host as HookHost);
    });
}
