import { constants } from "node:os";
import { relative } from "node:path";

import type { Command } from "commander";

import { traceRun, type TraceReport, OPTION_DESCRIPTIONS } from "../../../api/index.js";
import { logJson } from "../output.js";
import { validateOutputFormat } from "../validators.js";

export interface TraceRunCommandOptions {
  cwd?: string;
  packages?: string;
  calls?: boolean;
  out?: string;
  timeout?: number;
  outputFormat?: string;
}

/** The exit code a shell reports for a command a signal ended. */
function exitCodeFor(exitCode: number | null, signal: string | undefined): number {
  if (exitCode !== null) return exitCode;
  const number = signal ? constants.signals[signal as keyof typeof constants.signals] : undefined;
  return number ? 128 + number : 1;
}

export function summarizeTrace(report: TraceReport): string[] {
  const lines: string[] = [];
  const direct = report.packages.filter((pkg) => pkg.dependents.includes("(app)")).length;
  lines.push(
    `Packages loaded: ${report.packages.length} (${direct} by your own code, ${report.packages.length - direct} only through other packages)`,
  );
  if (report.processes === 0) {
    lines.push(
      report.command?.signal
        ? `The command was stopped by ${report.command.signal} before any process reported; a process ended by a signal can lose its newest data.`
        : "No process reported to the trace hook. The command may not run Node.js, or it may clear NODE_OPTIONS.",
    );
  }
  if (report.partialEsm) {
    lines.push("Some processes could not observe ES module imports (Node.js older than 22.15).");
  }
  for (const pkg of report.packages) {
    if (!pkg.calls) continue;
    const counted = Object.entries(pkg.calls)
      .filter(([, count]) => count > 0)
      .toSorted(([, a], [, b]) => b - a)
      .map(([name, count]) => `${name} x${String(count)}`);
    lines.push(
      `  ${pkg.name}@${pkg.version}: ${counted.length > 0 ? counted.join(", ") : "no exported function called"}`,
    );
    const skipped = Object.entries(pkg.unwrapped ?? {});
    if (skipped.length > 0 && skipped.length <= 5) {
      for (const [name, reason] of skipped) lines.push(`    not counted: ${name} (${reason})`);
    } else if (skipped.length > 5) {
      const byReason = new Map<string, number>();
      for (const [, reason] of skipped) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      const parts = [...byReason].map(([reason, count]) => `${reason} x${String(count)}`);
      lines.push(
        `    not counted: ${String(skipped.length)} exports (${parts.join(", ")}); see the trace file`,
      );
    }
  }
  return lines;
}

export async function runTraceCommand(
  command: string[],
  opts: TraceRunCommandOptions,
): Promise<void> {
  const json = opts.outputFormat === "json";
  const packages = opts.packages
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const result = await traceRun({
    command,
    cwd: opts.cwd,
    packages,
    calls: opts.calls,
    out: opts.out,
    // JSON mode keeps stdout for the result; the command's own stdout moves to stderr.
    output: json ? "stderr" : "inherit",
    timeoutMs: opts.timeout === undefined ? undefined : opts.timeout * 1000,
  });
  process.exitCode = exitCodeFor(result.exitCode, result.signal);

  if (json) {
    logJson({
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      traceFile: result.traceFile,
      report: result.report,
    });
    return;
  }
  const shown = relative(opts.cwd ?? process.cwd(), result.traceFile) || result.traceFile;
  process.stdout.write(
    `\nTraced: ${command.join(" ")} (exit ${String(result.exitCode ?? result.signal)}, ${String(result.report.processes)} process(es))\n`,
  );
  for (const line of summarizeTrace(result.report)) process.stdout.write(`${line}\n`);
  process.stdout.write(`Trace written to ${shown}\n`);
}

export function registerTraceCommands(program: Command): void {
  const trace = program
    .command("trace")
    .description("Record which dependencies a command, usually your tests, loads and calls")
    .enablePositionalOptions();
  trace
    .command("run")
    .description(
      "Run a command with the trace hook in every Node.js process it starts, then write the trace (use -- before the command)",
    )
    .argument("<command...>", "The command to run, for example: node --test")
    .passThroughOptions()
    .option("--packages <list>", "Packages to watch, comma-separated (required with --calls)")
    .option("--calls", "Count calls to the exported functions of --packages (adds overhead)")
    .option("--out <path>", "Where to write the trace (default: .autoremediator/trace.json)")
    .option("--timeout <seconds>", "Stop the command after this many seconds", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (command: string[], opts: TraceRunCommandOptions) => {
      validateOutputFormat(
        (opts.outputFormat ?? "text") as "text" | "json",
        ["text", "json"],
        "trace run",
      );
      await runTraceCommand(command, opts);
    });
}
