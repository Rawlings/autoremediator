#!/usr/bin/env node

import { Command } from "commander";
import { ciExitCode, remediate, remediateFromScan, toCiSummary } from "./api.js";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ScanFormat = "auto" | "npm-audit" | "yarn-audit" | "sarif";

interface CommandOptions {
  cwd: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  dryRun: boolean;
  preview: boolean;
  runTests: boolean;
  json: boolean;
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

async function runSingleCve(cveId: string, opts: CommandOptions): Promise<void> {
  const report = await remediate(cveId, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
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
    .version("0.1.2")
    .showHelpAfterError();

  program
    .command("cve")
    .description("Remediate a single CVE ID")
    .argument("<cveId>", "CVE ID, e.g. CVE-2021-23337")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--preview", "Run non-mutating remediation preview mode", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
    .option("--request-id <id>", "Request correlation ID")
    .option("--session-id <id>", "Session correlation ID")
    .option("--parent-run-id <id>", "Parent run correlation ID")
    .option("--idempotency-key <key>", "Idempotency key for replay-safe execution")
    .option("--resume", "Resume by returning cached result for matching idempotency key", false)
    .option("--actor <name>", "Actor identity for evidence provenance")
    .option("--source <src>", "Source system: cli|sdk|mcp|openapi|unknown")
    .option("--direct-dependencies-only", "Enforce direct-dependency-only remediation constraint", false)
    .option("--prefer-version-bump", "Reject patch-file outcomes when version-bump is preferred", false)
    .option("--json", "Print JSON output", false)
    .action(async (cveId: string, opts: CommandOptions) => {
      await runSingleCve(cveId, opts);
    });

  program
    .command("scan")
    .description("Remediate vulnerabilities from scanner output (npm/pnpm/yarn audit JSON or SARIF)")
    .requiredOption("--input <path>", "Path to scanner output file")
    .option("--format <type>", "Input format: auto|npm-audit|yarn-audit|sarif", "auto")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--policy <path>", "Path to policy file (.autoremediator.json)")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--preview", "Run non-mutating remediation preview mode", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
    .option("--request-id <id>", "Request correlation ID")
    .option("--session-id <id>", "Session correlation ID")
    .option("--parent-run-id <id>", "Parent run correlation ID")
    .option("--idempotency-key <key>", "Idempotency key for replay-safe execution")
    .option("--resume", "Resume by returning cached result for matching idempotency key", false)
    .option("--actor <name>", "Actor identity for evidence provenance")
    .option("--source <src>", "Source system: cli|sdk|mcp|openapi|unknown")
    .option("--direct-dependencies-only", "Enforce direct-dependency-only remediation constraint", false)
    .option("--prefer-version-bump", "Reject patch-file outcomes when version-bump is preferred", false)
    .option("--evidence", "Enable evidence file output", true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--summary-file <path>", "Write machine-readable scan summary JSON to path")
    .option("--json", "Print JSON output", false)
    .action(async (opts: CommandOptions) => {
      await runScanInput(opts.input!, opts);
    });

  // Scanner-first top-level mode (default):
  //   autoremediator --input audit.json
  //   autoremediator audit.json
  program
    .argument("[target]", "Scanner output file path (or CVE ID fallback)")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--preview", "Run non-mutating remediation preview mode", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
    .option("--request-id <id>", "Request correlation ID")
    .option("--session-id <id>", "Session correlation ID")
    .option("--parent-run-id <id>", "Parent run correlation ID")
    .option("--idempotency-key <key>", "Idempotency key for replay-safe execution")
    .option("--resume", "Resume by returning cached result for matching idempotency key", false)
    .option("--actor <name>", "Actor identity for evidence provenance")
    .option("--source <src>", "Source system: cli|sdk|mcp|openapi|unknown")
    .option("--direct-dependencies-only", "Enforce direct-dependency-only remediation constraint", false)
    .option("--prefer-version-bump", "Reject patch-file outcomes when version-bump is preferred", false)
    .option("--input <path>", "Path to scanner output file (scanner-first mode)")
    .option("--format <type>", "Input format: auto|npm-audit|yarn-audit|sarif", "auto")
    .option("--policy <path>", "Path to policy file (.autoremediator.json)")
    .option("--evidence", "Enable evidence file output", true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--summary-file <path>", "Write machine-readable scan summary JSON to path")
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
