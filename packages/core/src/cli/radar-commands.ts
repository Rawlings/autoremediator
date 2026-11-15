import type { Command } from "commander";

import {
  OPTION_DESCRIPTIONS,
  radar,
  radarExitCode,
  renderRadar,
  type RadarTarget,
} from "../api/index.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

interface RadarCliOptions {
  cwd: string;
  includeTransitive?: boolean;
  limit?: number;
  maxPackages?: number;
  target?: string;
  github?: boolean;
  /** `true` for a bare `--model`, which means AUTOREMEDIATOR_MODEL. */
  model?: string | boolean;
  offline?: boolean;
  /** `--no-assess` arrives as false. */
  assess?: boolean;
  outputFormat: string;
}

const TARGETS: readonly RadarTarget[] = ["latest", "minor", "patch"];

function resolveModel(model: string | boolean | undefined): string | undefined {
  if (model === undefined || model === false) return undefined;
  if (typeof model === "string") return model;
  const fromEnvironment = process.env.AUTOREMEDIATOR_MODEL;
  if (!fromEnvironment) {
    throw new Error(
      "--model needs a value (provider:model-id) or AUTOREMEDIATOR_MODEL in the environment.",
    );
  }
  return fromEnvironment;
}

export async function runRadar(opts: RadarCliOptions): Promise<void> {
  if (opts.target !== undefined && !TARGETS.includes(opts.target as RadarTarget)) {
    throw new Error(`--target must be one of ${TARGETS.join(", ")}, not "${opts.target}".`);
  }
  const model = resolveModel(opts.model);
  const report = await radar({
    cwd: opts.cwd,
    source: "cli",
    ...(opts.includeTransitive ? { includeTransitive: true } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.maxPackages ? { maxPackages: opts.maxPackages } : {}),
    ...(opts.target ? { target: opts.target as RadarTarget } : {}),
    ...(opts.github ? { github: true } : {}),
    ...(model ? { model } : {}),
    ...(opts.offline ? { offline: true } : {}),
    ...(opts.assess === false ? { assess: false } : {}),
  });
  if (opts.outputFormat === "json") logJson(report);
  else process.stdout.write(renderRadar(report));
  // 0 nothing likely, 3 a likely change without an advisory.
  process.exitCode = radarExitCode(report);
}

/** Register `radar`. */
export function registerRadarCommands(program: Command): void {
  program
    .command("radar")
    .description(
      "Silent-fix radar: flag releases between your installed versions and a newer one that look security-relevant, before an advisory exists (changelog text, code differences between tarballs, registry metadata). Never says a vulnerability exists. Exits 0, or 3 when a likely one is found",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--include-transitive", "Also look at transitive dependencies (default: direct only)")
    .option("--limit <n>", "Most entries shown, best first (default 20)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option(
      "--max-packages <n>",
      "Most packages analysed, direct first (default 100); bounds network use",
      (value: string) => Number.parseInt(value, 10),
    )
    .option(
      "--target <which>",
      "Compare with: latest (default), minor (newest in the same major) or patch (newest in the same minor)",
    )
    .option(
      "--github",
      "Also read GitHub release notes for releases with no changelog in the package (unauthenticated API, stops at the rate limit)",
    )
    .option(
      "--model [spec]",
      "Let a language model add a bounded classification (provider:model-id, or AUTOREMEDIATOR_MODEL when no value). Sends package text to that provider; off by default",
    )
    .option("--offline", "Refused: radar needs the npm registry")
    .option("--no-assess", "Do not rate the upgrade impact on this project")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: RadarCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "radar");
      await runRadar(opts);
    });
}
