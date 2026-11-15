import {
  EXIT_CODES,
  init,
  AGENT_HOSTS,
  type AgentHost,
  type InitResult,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import { confirmInteractively } from "../prompt.js";
import type { OutputFormat } from "../types.js";

export interface InitCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  hosts?: string;
  ci?: boolean;
  guard?: boolean;
  policy?: boolean;
  agentsMd?: boolean;
  yes?: boolean;
  check?: boolean;
}

function parseHosts(value: string | undefined): AgentHost[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const unknown = hosts.filter((host) => !(AGENT_HOSTS as readonly string[]).includes(host));
  if (unknown.length > 0) {
    throw new Error(`Unknown host: ${unknown.join(", ")}. Choose from ${AGENT_HOSTS.join(", ")}.`);
  }
  return hosts as AgentHost[];
}

function describeInit(result: InitResult, header: string): string {
  const lines = [header];
  const { facts } = result;
  lines.push(
    `Package manager ${facts.packageManager}, git host ${facts.gitHost}, CI ${facts.ci.join(", ") || "none"}`,
    `Agent hosts: ${result.hosts.join(", ") || "none found (use --hosts)"}`,
  );
  for (const change of result.changes) {
    lines.push(
      `  ${change.action.padEnd(9)} ${change.path}${change.action === "conflict" ? `  (${change.reason})` : ""}`,
    );
  }
  return lines.join("\n");
}

export async function runInit(opts: InitCliOptions): Promise<void> {
  const base = {
    cwd: opts.cwd,
    hosts: parseHosts(opts.hosts),
    ci: opts.ci,
    guard: opts.guard,
    policy: opts.policy,
    agentsMd: opts.agentsMd,
  };
  let result = await init({ ...base, check: opts.check, yes: opts.yes });
  const json = opts.outputFormat === "json";
  const interactive =
    !json && !opts.yes && !opts.check && process.stdin.isTTY && process.stdout.isTTY;

  if (!json) {
    process.stdout.write(`${describeInit(result, opts.check ? "Checking setup" : "Setup plan")}\n`);
    if (!result.applied) {
      for (const change of result.changes) {
        if (change.diff) process.stdout.write(`\n${change.diff}\n`);
      }
    }
  }

  if (interactive && result.drift) {
    if (
      await confirmInteractively(
        `\nWrite ${result.changes.filter((c) => c.diff).length} file(s)? [y/N] `,
      )
    ) {
      result = await init({ ...base, yes: true });
      process.stdout.write("Done.\n");
    }
    return;
  }

  if (json) logJson(result);
  else if (result.applied) process.stdout.write("\nWritten.\n");
  else if (!opts.check && result.drift) {
    process.stdout.write("\nNothing written. Run again with --yes to apply.\n");
  } else if (!result.drift) process.stdout.write("\nAlready set up.\n");

  if (opts.check) {
    if (result.drift || result.conflicts.length > 0) process.exitCode = EXIT_CODES.failed;
  } else if (!result.applied && result.drift) {
    // Changes are waiting for a yes that this run could not get.
    process.exitCode = EXIT_CODES.needsApproval;
  }
}
