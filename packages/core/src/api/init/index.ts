import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { chooseHosts, detectProject } from "./detect.js";
import { renderDiff } from "./diff.js";
import { planInit } from "./plan.js";
import type { InitOptions, InitResult } from "./types.js";

export { detectProject } from "./detect.js";
export type { AgentHost, InitOptions, InitResult, ProjectFacts } from "./types.js";
export { AGENT_HOSTS } from "./types.js";

/**
 * Set a project up for Autoremediator and for the coding agents it uses: policy file, `.gitignore`,
 * MCP configuration per agent host, instructions for agents, and optionally a scheduled workflow.
 *
 * Without `yes` it only reports what it would change. It never replaces a file it cannot merge into
 * safely (those are reported as conflicts) and never overwrites an existing MCP server entry.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const facts = await detectProject(cwd);
  const hosts = chooseHosts(facts, options.hosts);
  const changes = planInit(facts, hosts, options);

  const summaries = changes.map((change) => ({
    path: change.path,
    action: change.action,
    reason: change.reason,
    diff:
      change.action === "create" || change.action === "update"
        ? renderDiff(change.path, change.before, change.after)
        : "",
  }));
  const pending = changes.filter((change) => change.action === "create" || change.action === "update");

  let applied = false;
  if (options.yes && !options.check) {
    for (const change of pending) {
      const target = join(cwd, change.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, change.after, "utf8");
    }
    applied = pending.length > 0;
  }

  return {
    cwd,
    facts,
    hosts,
    changes: summaries,
    drift: pending.length > 0,
    applied,
    conflicts: changes.filter((change) => change.action === "conflict").map((change) => change.path),
  };
}
