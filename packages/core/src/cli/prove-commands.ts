import type { Command } from "commander";

import { generateProofOfFix, OPTION_DESCRIPTIONS, type ProveResult } from "../api/index.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

interface ProveCliOptions {
  package?: string;
  vulnerableVersion?: string;
  fixedVersion?: string;
  advisoryText?: string;
  model?: string;
  cwd: string;
  patchesDir?: string;
  signingKey?: string;
  maxTrials?: number;
  timeoutMs?: number;
  overwrite?: boolean;
  outputFormat: string;
}

export function describeProve(result: ProveResult): string {
  const head = `${result.advisoryId}: ${result.package} ${result.vulnerableVersion} (vulnerable) vs ${result.fixedVersion} (fixed)`;
  const lines = [head];
  for (const trial of result.trials) {
    lines.push(`  try ${trial.attempt}: ${trial.accepted ? "accepted" : "rejected"} (${trial.stage}) ${trial.reason}`);
  }
  if (result.trials.length === 0) {
    lines.push(`  no script was proposed (${result.agent.status}: ${result.agent.rationale})`);
  }
  if (result.status === "kept" && result.files) {
    lines.push(
      `Kept. Script: ${result.files.script}`,
      `Evidence: ${result.files.evidence}`,
      ...(result.files.signature ? [`Signature: ${result.files.signature}`] : []),
      "The harness shows the script fails on the vulnerable version and passes on the fixed one. Read it before you rely on it: it cannot show that the difference is the advisory's vulnerability.",
    );
  } else {
    lines.push(`Not proven. ${result.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runProve(advisory: string, opts: ProveCliOptions): Promise<void> {
  const result = await generateProofOfFix(advisory, {
    cwd: opts.cwd,
    ...(opts.package ? { package: opts.package } : {}),
    ...(opts.vulnerableVersion ? { vulnerableVersion: opts.vulnerableVersion } : {}),
    ...(opts.fixedVersion ? { fixedVersion: opts.fixedVersion } : {}),
    ...(opts.advisoryText ? { advisoryText: opts.advisoryText } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.patchesDir ? { patchesDir: opts.patchesDir } : {}),
    ...(opts.signingKey ? { signingKeyPath: opts.signingKey } : {}),
    ...(opts.maxTrials ? { maxTrials: opts.maxTrials } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
  if (opts.outputFormat === "json") logJson(result);
  else process.stdout.write(describeProve(result));
  // 0 a script was kept; 1 none was proven.
  process.exitCode = result.status === "kept" ? 0 : 1;
}

const parseInteger = (value: string): number => Number.parseInt(value, 10);

/** Register `prove`. */
export function registerProveCommands(program: Command): void {
  program
    .command("prove <advisory>")
    .description(
      "Write exploit-proof evidence: an agent writes a reproduction of the advisory's vulnerability, kept only if, in a sandbox, it fails on the vulnerable version and passes on the fixed one. Needs a model. Writes the script and an evidence record to the patches directory. Exits 0 if kept, 1 if not proven",
    )
    .option("--package <name>", "The npm package (optional when the advisory affects exactly one)")
    .option(
      "--vulnerable-version <version>",
      "Exact version the script must fail on (default: newest vulnerable version below the fix)",
    )
    .option(
      "--fixed-version <version>",
      "Exact version the script must pass on (default: the advisory's first patched version)",
    )
    .option(
      "--advisory-text <text>",
      "Describe the vulnerability yourself, instead of or in addition to OSV (the advisory argument may then be any label)",
    )
    .option("--model <spec>", OPTION_DESCRIPTIONS.model)
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--patches-dir <dir>",
      "Where the script and evidence record are written (default: ./patches)",
    )
    .option(
      "--signing-key <path>",
      "Ed25519 private key (PEM) to sign the evidence record with, as a detached DSSE signature (create one with: openssl genpkey -algorithm ed25519 -out key.pem)",
    )
    .option("--max-trials <n>", "Candidate scripts the agent may try, 1-10 (default 4)", parseInteger)
    .option(
      "--timeout-ms <ms>",
      "Wall-clock limit of one sandboxed run, 1000-60000 (default 10000)",
      parseInteger,
    )
    .option(
      "--overwrite",
      "Replace a script already at the target path that this command did not write",
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (advisory: string, opts: ProveCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "prove");
      await runProve(advisory, opts);
    });
}
