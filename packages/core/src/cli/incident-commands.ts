import { readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  incident,
  incidentExitCode,
  OPTION_DESCRIPTIONS,
  premortem,
  renderIncidentMarkdown,
  type PremortemReport,
  type PremortemTarget,
} from "../api/index.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

interface IncidentCliOptions {
  cwd: string;
  plan?: boolean;
  offline?: boolean;
  intelligenceSnapshot?: string;
  policy?: string;
  /** `--no-history` arrives as false. */
  history?: boolean;
  maxCommits?: number;
  outputDir?: string;
  outputFormat: string;
}

interface PremortemCliOptions {
  targetsFile?: string;
  root?: string;
  packages?: string;
  top?: number;
  rankBy?: "depended-upon" | "privileged";
  playbooks?: "repo" | "package";
  outputDir?: string;
  outputFormat: string;
}

export async function runIncident(target: string, opts: IncidentCliOptions): Promise<void> {
  const report = await incident(target, {
    cwd: opts.cwd,
    source: "cli",
    ...(opts.plan ? { plan: true } : {}),
    ...(opts.offline ? { offline: true } : {}),
    ...(opts.intelligenceSnapshot ? { intelligenceSnapshotPath: opts.intelligenceSnapshot } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.history === false ? { history: false } : {}),
    ...(opts.maxCommits ? { maxCommits: opts.maxCommits } : {}),
    ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
  });

  if (opts.outputFormat === "json") logJson(report);
  else {
    process.stdout.write(renderIncidentMarkdown(report));
    if (report.files)
      process.stdout.write(`\nWrote ${report.files.markdown} and ${report.files.json}\n`);
  }
  // 0 clear, 3 it was in history but is not locked now, 4 it is locked or installed now.
  process.exitCode = incidentExitCode(report);
}

function readTargets(path: string): PremortemTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read targets file at "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed))
    throw new Error("Targets file must be a JSON array, as for `portfolio`.");
  const targets: PremortemTarget[] = [];
  for (const [index, entry] of parsed.entries()) {
    const record =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof record["cwd"] !== "string" || record["cwd"] === "") {
      throw new Error(`Invalid target at index ${index}: cwd is required.`);
    }
    const target: PremortemTarget = { cwd: record["cwd"] };
    if (typeof record["label"] === "string") target.label = record["label"];
    targets.push(target);
  }
  return targets;
}

function describePremortem(report: PremortemReport): string {
  const lines = [
    `Assessed ${report.packages.length} package(s) across ${report.repos.length} repositor${report.repos.length === 1 ? "y" : "ies"}.`,
  ];
  for (const entry of report.packages) {
    lines.push(
      `  ${entry.packageName}: ${entry.repoCount} repo(s), ${entry.dependentCount} dependent(s), install scripts ${String(entry.installScript)}${
        entry.reposWithCiSecrets.length > 0
          ? `, CI installs with secrets in ${entry.reposWithCiSecrets.join(", ")}`
          : ""
      }`,
    );
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  if (report.files)
    lines.push(`Wrote ${report.files.length} file(s):`, ...report.files.map((file) => `  ${file}`));
  else lines.push("Pass --output-dir to write the playbooks.");
  return `${lines.join("\n")}\n`;
}

export async function runPremortem(opts: PremortemCliOptions): Promise<void> {
  if (!opts.targetsFile && !opts.root)
    throw new Error("Give --targets-file <json> or --root <dir>.");
  const report = await premortem({
    ...(opts.targetsFile ? { targets: readTargets(opts.targetsFile) } : {}),
    ...(opts.root ? { root: opts.root } : {}),
    ...(opts.packages
      ? {
          packages: opts.packages
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== ""),
        }
      : {}),
    ...(opts.top ? { top: opts.top } : {}),
    ...(opts.rankBy ? { rankBy: opts.rankBy } : {}),
    ...(opts.playbooks ? { playbooks: opts.playbooks } : {}),
    ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
  });
  if (opts.outputFormat === "json") logJson(report);
  else process.stdout.write(describePremortem(report));
}

/** Register `incident` and `premortem`. */
export function registerIncidentCommands(program: Command): void {
  program
    .command("incident <target>")
    .description(
      "A package was compromised: is it here, when did it enter and leave git history, roll back to the last safe version, and which secrets to rotate. Target is an advisory id (MAL-, GHSA-, CVE-) or package@range. Exits 0 clear, 3 in history only, 4 locked now",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--plan",
      "Record the rollback as a plan (never applied); review it with `runs show` and apply with `runs apply`",
    )
    .option(
      "--offline",
      "No network: no advisory lookup and no registry (an id then needs --intelligence-snapshot)",
    )
    .option("--intelligence-snapshot <path>", OPTION_DESCRIPTIONS.intelligenceSnapshotPath)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--no-history", "Do not read git history")
    .option(
      "--max-commits <n>",
      "Most lockfile commits to read from history, newest first (default 500)",
      (value: string) => Number.parseInt(value, 10),
    )
    .option(
      "--output-dir <dir>",
      "Write incident-report.md and incident-report.json into this directory",
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (target: string, opts: IncidentCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "incident");
      await runIncident(target, opts);
    });

  program
    .command("premortem")
    .description(
      "What if a package is compromised tomorrow? Across repositories: who locks it, which versions, install scripts, CI installs with secrets in reach. With --output-dir, writes playbooks with the commands to run on the day",
    )
    .option(
      "--targets-file <path>",
      "Repositories as a JSON array of { cwd, label? }, the portfolio targets format",
    )
    .option(
      "--root <dir>",
      "Find the repositories (a .git next to a package.json) under this directory",
    )
    .option(
      "--packages <list>",
      "Packages to assess, comma-separated (default: the most depended-upon ones)",
    )
    .option("--top <n>", "With no --packages: how many to pick (default 10)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option(
      "--rank-by <how>",
      "depended-upon (default) or privileged (packages with install scripts first)",
    )
    .option("--playbooks <kind>", "One playbook per repo (default) or per package")
    .option(
      "--output-dir <dir>",
      "Write premortem.md, premortem.json and the playbooks into this directory; commit them",
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: PremortemCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "premortem");
      if (opts.rankBy && !["depended-upon", "privileged"].includes(opts.rankBy)) {
        throw new Error(`--rank-by must be depended-upon or privileged, not "${opts.rankBy}".`);
      }
      if (opts.playbooks && !["repo", "package"].includes(opts.playbooks)) {
        throw new Error(`--playbooks must be repo or package, not "${opts.playbooks}".`);
      }
      await runPremortem(opts);
    });
}
