import type { CommandOptions, OutputFormat } from "./types.js";

function hasChangeRequestOverrides(opts: CommandOptions): boolean {
  return Boolean(
    opts.changeRequestProvider ||
      opts.changeRequestGrouping ||
      opts.changeRequestRepository ||
      opts.changeRequestBaseBranch ||
      opts.changeRequestBranchPrefix ||
      opts.changeRequestTitlePrefix
  );
}

export function validateSharedCommandOptions(opts: CommandOptions): void {
  if (opts.resume && !opts.idempotencyKey) {
    throw new Error("--resume requires --idempotency-key.");
  }

  if ((opts.consensusProvider || opts.consensusModel) && !opts.requireConsensusForHighRisk) {
    throw new Error(
      "--consensus-provider and --consensus-model require --require-consensus-for-high-risk."
    );
  }

  if (hasChangeRequestOverrides(opts) && !opts.createChangeRequest) {
    throw new Error(
      "change-request override flags require --create-change-request."
    );
  }

  if (opts.createChangeRequest && (opts.dryRun || opts.preview)) {
    throw new Error("--create-change-request cannot be used with --dry-run or --preview.");
  }

  if (opts.simulationMode && !(opts.dryRun || opts.preview)) {
    throw new Error("--simulation-mode requires --dry-run or --preview.");
  }

  if (opts.createChangeRequest && opts.changeRequestGrouping && opts.changeRequestGrouping !== "all") {
    throw new Error("--change-request-grouping currently supports only 'all'.");
  }
}

export function validateOutputFormat(
  outputFormat: OutputFormat,
  supported: OutputFormat[],
  commandName: string
): void {
  if (!supported.includes(outputFormat)) {
    throw new Error(
      `${commandName} supports --output-format ${supported.join("|")} (received: ${outputFormat}).`
    );
  }
}
