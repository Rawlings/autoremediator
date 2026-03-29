#!/usr/bin/env node

import { Command } from "commander";
import {
  ciExitCode,
  OPTION_DESCRIPTIONS,
  remediate,
  remediateFromScan,
  toCiSummary,
  toSarifOutput,
} from "./api.js";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./version";

type ScanFormat = "auto" | "npm-audit" | "yarn-audit" | "sarif";

interface CommandOptions {
  cwd: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  patchesDir?: string;
  dryRun: boolean;
  preview: boolean;
  runTests: boolean;
  json: boolean;
  outputFormat: "json" | "sarif";
  llmProvider?: "openai" | "anthropic" | "local";
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
  idempotencyKey?: string;
  resume: boolean;
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
  directDependenciesOnly: boolean;
  preferVersionBump: boolean;
  input?: string;
  format: ScanFormat;
  policy?: string;
  evidence: boolean;
  ci: boolean;
  summaryFile?: string;
}

function logJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isCveId(value: string): boolean {
  return /^CVE-\d{4}-\d+$/i.test(value);
}

function formatCountMap(counts: Record<string, number> | undefined): string | undefined {
  if (!counts) return undefined;

  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return undefined;

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

async function runSingleCve(cveId: string, opts: CommandOptions): Promise<void> {
  const report = await remediate(cveId, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
    patchesDir: opts.patchesDir,
    policy: opts.policy,
    llmProvider: opts.llmProvider,
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    parentRunId: opts.parentRunId,
    idempotencyKey: opts.idempotencyKey,
    resume: opts.resume,
    actor: opts.actor,
    source: opts.source ?? "cli",
    constraints: {
      directDependenciesOnly: opts.directDependenciesOnly,
      preferVersionBump: opts.preferVersionBump,
    },
  });

  if (opts.json) {
    logJson(report);
    return;
  }

  process.stdout.write(`${report.summary}\n`);
  process.stdout.write(`Results: ${report.results.length}\n`);
}

async function runScanInput(inputPath: string, opts: CommandOptions): Promise<void> {
  const report = await remediateFromScan(inputPath, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    format: opts.format,
    policy: opts.policy,
    patchesDir: opts.patchesDir,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
    llmProvider: opts.llmProvider,
    evidence: opts.evidence,
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    parentRunId: opts.parentRunId,
    idempotencyKey: opts.idempotencyKey,
    resume: opts.resume,
    actor: opts.actor,
    source: opts.source ?? "cli",
    constraints: {
      directDependenciesOnly: opts.directDependenciesOnly,
      preferVersionBump: opts.preferVersionBump,
    },
  });

  if (opts.summaryFile) {
    const summary = toCiSummary(report);
    writeFileSync(opts.summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  if (opts.outputFormat === "sarif") {
    logJson(toSarifOutput(report));
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(report));
    }
    return;
  }

  if (opts.json) {
    logJson(report);
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(report));
    }
    return;
  }

  process.stdout.write(`CVEs found: ${report.cveIds.length}\n`);
  process.stdout.write(`Remediation reports: ${report.reports.length}\n`);
  process.stdout.write(`Successful remediations: ${report.successCount}\n`);
  process.stdout.write(`Failed remediations: ${report.failedCount}\n`);
  const strategyCounts = formatCountMap(report.strategyCounts);
  if (strategyCounts) {
    process.stdout.write(`Strategy counts: ${strategyCounts}\n`);
  }
  const dependencyScopeCounts = formatCountMap(report.dependencyScopeCounts);
  if (dependencyScopeCounts) {
    process.stdout.write(`Dependency scope counts: ${dependencyScopeCounts}\n`);
  }
  const unresolvedByReason = formatCountMap(report.unresolvedByReason);
  if (unresolvedByReason) {
    process.stdout.write(`Unresolved reasons: ${unresolvedByReason}\n`);
  }
  if (report.evidenceFile) {
    process.stdout.write(`Evidence: ${report.evidenceFile}\n`);
  }

  if (report.errors.length > 0) {
    for (const error of report.errors) {
      process.stdout.write(`Error ${error.cveId}: ${error.message}\n`);
    }
  }

  if (opts.ci) {
    process.exitCode = ciExitCode(toCiSummary(report));
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("autoremediator")
    .description("Scanner-first Node.js vulnerability auto-remediation tool")
    .version(PACKAGE_VERSION)
    .showHelpAfterError();

  program
    .command("cve")
    .description("Remediate a single CVE ID")
    .argument("<cveId>", OPTION_DESCRIPTIONS.cveId)
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun, false)
    .option("--preview", OPTION_DESCRIPTIONS.preview, false)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests, false)
    .option("--llm-provider <provider>", OPTION_DESCRIPTIONS.llmProvider)
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume, false)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly, false)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump, false)
    .option("--json", "Print JSON output", false)
    .action(async (cveId: string, opts: CommandOptions) => {
      await runSingleCve(cveId, opts);
    });

  program
    .command("scan")
    .description("Remediate vulnerabilities from scanner output (npm/pnpm/yarn audit JSON or SARIF)")
    .requiredOption("--input <path>", OPTION_DESCRIPTIONS.inputPath)
    .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun, false)
    .option("--preview", OPTION_DESCRIPTIONS.preview, false)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests, false)
    .option("--llm-provider <provider>", OPTION_DESCRIPTIONS.llmProvider)
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume, false)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly, false)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump, false)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--summary-file <path>", "Write machine-readable scan summary JSON to path")
    .option("--output-format <format>", "Output format: json|sarif", "json")
    .option("--json", "Print JSON output", false)
    .action(async (opts: CommandOptions) => {
      await runScanInput(opts.input!, opts);
    });

  // Scanner-first top-level mode (default):
  //   autoremediator --input audit.json
  //   autoremediator audit.json
  program
    .argument("[target]", "Scanner output file path (or CVE ID fallback)")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun, false)
    .option("--preview", OPTION_DESCRIPTIONS.preview, false)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests, false)
    .option("--llm-provider <provider>", OPTION_DESCRIPTIONS.llmProvider)
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume, false)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly, false)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump, false)
    .option("--input <path>", `${OPTION_DESCRIPTIONS.inputPath} (scanner-first mode)`)
    .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--summary-file <path>", "Write machine-readable scan summary JSON to path")
    .option("--output-format <format>", "Output format: json|sarif", "json")
    .option("--json", "Print JSON output", false)
    .action(async (target: string | undefined, opts: CommandOptions) => {
      if (opts.input) {
        await runScanInput(opts.input, opts);
        return;
      }

      if (!target) {
        program.outputHelp();
        return;
      }

      if (isCveId(target)) {
        await runSingleCve(target, opts);
        return;
      }

      if (existsSync(target)) {
        await runScanInput(target, opts);
        return;
      }

      throw new Error(
        `Target "${target}" is neither a valid CVE ID nor an existing scan file path.`
      );
    });

  return program;
}

async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[autoremediator] ${message}\n`);
    process.exit(1);
  });
}
