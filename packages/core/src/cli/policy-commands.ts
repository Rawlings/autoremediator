import { createInterface } from "node:readline/promises";

import type { Command } from "commander";

import {
  compilePolicy,
  EXIT_CODES,
  explainPolicy,
  OPTION_DESCRIPTIONS,
  writePolicyProposal,
  type CompilePolicyOptions,
  type ExplainPolicyResult,
  type PolicyCompileResult,
} from "../api/index.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

export interface PolicyCompileCliOptions {
  cwd: string;
  policy?: string;
  model?: string;
  yes?: boolean;
  allowLoosening?: boolean;
  outputFormat: "text" | "json";
  /** Test seam: where to read the confirmation from. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam: replaces the model (SDK `proposer`). */
  compileOptions?: Partial<CompilePolicyOptions>;
  /** Test seam: whether a person is at a terminal. */
  interactive?: boolean;
}

export interface PolicyExplainCliOptions {
  cwd: string;
  policy?: string;
  outputFormat: "text" | "json";
}

async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The proposal as text for a reviewer: what changes, why, what was left out, what got looser. */
export function describeCompile(result: PolicyCompileResult): string {
  const lines: string[] = [];
  const headline: Record<PolicyCompileResult["status"], string> = {
    proposed: `Proposed change to ${result.path}`,
    unchanged: `No change needed: ${result.path} already says this`,
    rejected: `Rejected: nothing was changed in ${result.path}`,
    applied: `Wrote ${result.path}`,
  };
  lines.push(headline[result.status]);

  if (result.rejections.length > 0) {
    lines.push("", "Why it was refused:");
    for (const reason of result.rejections) lines.push(`  - ${reason}`);
  }
  if (result.loosenings.length > 0) {
    lines.push("", "LESS SAFE than before:");
    for (const entry of result.loosenings) lines.push(`  ! ${entry.key}: ${entry.description}`);
  }
  if (result.explanations.length > 0) {
    lines.push("", "What each rule became:");
    for (const entry of result.explanations) {
      lines.push(
        `  "${entry.phrase}" -> ${entry.keys.join(", ") || "(no key)"}${entry.effect === "already-in-place" ? " (already in place)" : ""}`,
      );
    }
  }
  if (result.unsupported.length > 0) {
    lines.push("", "Could not be expressed (not approximated, not written):");
    for (const entry of result.unsupported) lines.push(`  - "${entry.phrase}": ${entry.reason}`);
  }
  for (const warning of result.warnings) lines.push(`  note: ${warning}`);
  if (result.diff) lines.push("", result.diff);
  if (result.status === "proposed" || result.status === "applied") {
    lines.push("", "The policy then reads:");
    for (const sentence of result.sentences) lines.push(`  - ${sentence}`);
  }
  return `${lines.join("\n")}\n`;
}

export function describeExplain(result: ExplainPolicyResult): string {
  const header = result.exists
    ? `Policy from ${result.source}:`
    : `No policy file at ${result.source}; the built-in defaults apply:`;
  return `${[header, ...result.sentences.map((sentence) => `  - ${sentence}`)].join("\n")}\n`;
}

export async function runPolicyCompile(
  words: string[],
  opts: PolicyCompileCliOptions,
): Promise<void> {
  const json = opts.outputFormat === "json";
  let result = await compilePolicy(words.join(" "), {
    cwd: opts.cwd,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.allowLoosening ? { allowLoosening: true } : {}),
    ...opts.compileOptions,
  });

  const interactive =
    opts.interactive ?? (!json && !opts.yes && process.stdin.isTTY && process.stdout.isTTY);
  if (result.status === "proposed" && opts.yes) {
    result = writePolicyProposal(result, { cwd: opts.cwd });
  } else if (result.status === "proposed" && interactive) {
    process.stdout.write(describeCompile(result));
    const ask = opts.confirm ?? askYes;
    if (await ask(`\nWrite ${result.path}? [y/N] `)) {
      result = writePolicyProposal(result, { cwd: opts.cwd });
      process.stdout.write("Written.\n");
    }
    process.exitCode = result.applied ? EXIT_CODES.ok : EXIT_CODES.needsApproval;
    return;
  }

  if (json) logJson(result);
  else {
    process.stdout.write(describeCompile(result));
    if (result.status === "proposed") {
      process.stdout.write("\nNothing written. Run again with --yes to write it.\n");
    }
  }

  if (result.status === "rejected") process.exitCode = EXIT_CODES.failed;
  // A proposal is waiting for a yes that this run could not get.
  else if (result.status === "proposed") process.exitCode = EXIT_CODES.needsApproval;
}

export function runPolicyExplain(opts: PolicyExplainCliOptions): void {
  const result = explainPolicy({
    cwd: opts.cwd,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  if (opts.outputFormat === "json") logJson(result);
  else process.stdout.write(describeExplain(result));
}

/** Register `policy compile` and `policy explain`. */
export function registerPolicyCommands(program: Command): void {
  const policy = program
    .command("policy")
    .description(
      "Work with the policy file in plain language: compile rules into a reviewed change, or explain the current policy",
    );

  policy
    .command("compile <rules...>")
    .description(
      'Turn plain-language rules (e.g. "Never auto-merge majors; KEV fixes within 24 hours; don\'t touch left-pad") into a validated diff of the policy file. A model proposes; deterministic checks dispose: unknown keys, invalid values, unexplained changes and any loosening you did not ask for are refused. Writes nothing without --yes (exit 3 when it has no terminal to ask). Needs a model',
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--policy <path>", "Policy file to change (default: .github/autoremediator.yml)")
    .option("--model <name>", OPTION_DESCRIPTIONS.model)
    .option("--yes", "Write the change without asking")
    .option(
      "--allow-loosening",
      "Accept changes that make the policy less safe, when the rules ask for them; each one is listed",
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (rules: string[], opts: PolicyCompileCliOptions) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "policy compile");
      await runPolicyCompile(rules, opts);
    });

  policy
    .command("explain")
    .description(
      "Describe the current policy file as plain sentences. No model, no network: the same policy always gives the same text",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action((opts: PolicyExplainCliOptions) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "policy explain");
      runPolicyExplain(opts);
    });
}
