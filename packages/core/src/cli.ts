#!/usr/bin/env node

import { Command } from "commander";
import { ciExitCode, remediate as heal, remediateFromScan as healFromScanFile, toCiSummary } from "./api.js";
import { existsSync, writeFileSync } from "node:fs";

type ScanFormat = "auto" | "npm-audit" | "yarn-audit" | "sarif";

interface CommandOptions {
  cwd: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  dryRun: boolean;
  runTests: boolean;
  json: boolean;
  llmProvider?: "openai" | "anthropic" | "local";
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
  const report = await heal(cveId, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    skipTests: !opts.runTests,
    policyPath: opts.policy,
    llmProvider: opts.llmProvider,
  });

  if (opts.json) {
    logJson(report);
    return;
  }

  process.stdout.write(`${report.summary}\n`);
  process.stdout.write(`Results: ${report.results.length}\n`);
}

async function runScanInput(inputPath: string, opts: CommandOptions): Promise<void> {
  const report = await healFromScanFile(inputPath, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    format: opts.format,
    policyPath: opts.policy,
    dryRun: opts.dryRun,
    skipTests: !opts.runTests,
    llmProvider: opts.llmProvider,
    writeEvidence: opts.evidence,
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

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("autoremediator")
    .description("Scanner-first Node.js vulnerability auto-remediation tool")
    .version("0.1.0")
    .showHelpAfterError();

  // Compatibility command retained for explicit CVE use.
  program
    .command("cve")
    .description("Compatibility: heal a single CVE ID")
    .argument("<cveId>", "CVE ID, e.g. CVE-2021-23337")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
    .option("--json", "Print JSON output", false)
    .action(async (cveId: string, opts: CommandOptions) => {
      await runSingleCve(cveId, opts);
    });

  program
    .command("scan")
    .description("Heal vulnerabilities from scanner output (npm/pnpm/yarn audit JSON or SARIF)")
    .requiredOption("--input <path>", "Path to scanner output file")
    .option("--format <type>", "Input format: auto|npm-audit|yarn-audit|sarif", "auto")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--policy <path>", "Path to policy file (.autoremediator.json)")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
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
  // Compatibility fallback: autoremediator CVE-2021-23337
  program
    .argument("[target]", "Scanner output file path (or CVE ID fallback)")
    .option("--cwd <path>", "Target project directory", process.cwd())
    .option("--package-manager <name>", "Package manager: npm|pnpm|yarn")
    .option("--dry-run", "Plan changes only without mutating files", false)
    .option("--run-tests", "Run package-manager test validation after apply", false)
    .option("--llm-provider <provider>", "LLM provider: openai|anthropic|local")
    .option("--input <path>", "Path to scanner output file (scanner-first mode)")
    .option("--format <type>", "Input format: auto|npm-audit|yarn-audit|sarif", "auto")
    .option("--policy <path>", "Path to policy file (.autoremediator.json)")
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

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[autoremediator] ${message}\n`);
  process.exit(1);
});
