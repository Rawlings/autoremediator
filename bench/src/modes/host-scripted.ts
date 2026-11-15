import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { mustRun } from "../exec.ts";
import { MODE_DESCRIPTIONS } from "../mode-info.ts";
import type { LoadedTask } from "../task.ts";
import type { Mode, ModeContext } from "./types.ts";

interface PlannedReport {
  runId?: string;
  summary: string;
  results: Array<{
    packageName: string;
    strategy: string;
    toVersion?: string;
    unresolvedReason?: string;
  }>;
}

interface RunReportShape {
  message: string;
  items: Array<{
    itemId: string;
    packageName: string;
    status: string;
    message: string;
    unresolvedReason?: string;
  }>;
}

interface AttemptViewShape {
  attemptId: string;
  status: string;
  worktreePath?: string;
  finalized?: boolean;
  message: string;
  verification?: { passed: boolean };
}

/** Failures of the project's own checks: the ones a host agent can do something about. */
const REPAIRABLE = new Set(["validation-failed", "breaking-change-unresolved"]);

/**
 * The unified diff from the task's project files to the known-good repair, made the way a host's own
 * tooling would: in a scratch repository, with `git diff`.
 */
async function oracleDiff(
  task: LoadedTask,
  scratch: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  mkdirSync(scratch, { recursive: true });
  await mustRun("git", ["init", "--quiet"], { cwd: scratch, env });
  for (const path of task.oracleFiles.keys()) {
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(task.projectDir, path), "utf8"));
  }
  await mustRun("git", ["add", "--all"], { cwd: scratch, env });
  await mustRun("git", ["commit", "--quiet", "-m", "before"], { cwd: scratch, env });
  for (const [path, content] of task.oracleFiles) writeFileSync(join(scratch, path), content);
  return (await mustRun("git", ["diff", "--no-color"], { cwd: scratch, env })).stdout;
}

class Host {
  readonly client = new Client({ name: "autoremediator-bench-host", version: "0.0.0" });
  calls = 0;

  async connect(context: ModeContext): Promise<void> {
    const server = fileURLToPath(import.meta.resolve("autoremediator/mcp"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: context.project.dir,
      env: {
        ...context.hermeticEnv,
        // Paths in tool arguments must be inside these roots; the advisory snapshot lives with the task.
        AUTOREMEDIATOR_ALLOWED_ROOTS: [dirname(context.workDir), context.task.dir].join(","),
      },
    });
    await this.client.connect(transport);
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls += 1;
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? JSON.stringify(result.content)
        : String(result.content);
      throw new Error(`MCP tool ${name} failed: ${text}`);
    }
    return result.structuredContent as T;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/**
 * A scripted MCP client driving the same tools a host agent (Claude Code, Cursor, ...) gets:
 * plan, apply, and for an upgrade that breaks the project, startAttempt, proposePatch (with the
 * known-good diff), verifyAttempt and finalizeAttempt. It measures the tools, the isolated checkout
 * and the verifier gate, not the quality of any host's agent.
 */
export const hostScripted: Mode = {
  name: "host-scripted",
  description: MODE_DESCRIPTIONS["host-scripted"],
  async run(context) {
    const { task, project } = context;
    const host = new Host();
    await host.connect(context);
    const notes: string[] = [];
    let claimed = false;
    let hostClaimed: boolean | undefined;
    const reasons: string[] = [];
    try {
      const cwd = project.dir;
      const planned = await host.call<PlannedReport>("planRemediation", {
        cveId: task.advisory,
        cwd,
        packageManager: "npm",
        offlineIntelligence: true,
        intelligenceSnapshotPath: task.intelPath,
        runTests: true,
        typecheck: true,
      });
      if (!planned.runId) throw new Error(`planRemediation recorded no run: ${planned.summary}`);
      for (const result of planned.results) {
        if (result.unresolvedReason) reasons.push(result.unresolvedReason);
        notes.push(
          `plan: ${result.packageName} ${result.strategy}${result.toVersion ? ` -> ${result.toVersion}` : ""}${result.unresolvedReason ? ` (${result.unresolvedReason})` : ""}`,
        );
      }
      if (planned.results.length === 0) notes.push(`plan: ${planned.summary}`);

      const applied = await host.call<RunReportShape>("applyPlan", {
        cwd,
        runId: planned.runId,
        repair: false,
      });
      notes.push(`apply: ${applied.message}`);
      claimed = applied.items.some((item) => item.status === "applied");

      for (const item of applied.items.filter((candidate) => candidate.status === "failed")) {
        notes.push(`apply: ${item.packageName} not applied: ${item.message.slice(0, 240)}`);
        if (item.unresolvedReason) reasons.push(item.unresolvedReason);
        if (
          !item.unresolvedReason ||
          !REPAIRABLE.has(item.unresolvedReason) ||
          task.oracleFiles.size === 0
        )
          continue;

        const attempt = await host.call<AttemptViewShape>("startAttempt", {
          cwd,
          runId: planned.runId,
          itemId: item.itemId,
        });
        const ids = { cwd, runId: planned.runId, attemptId: attempt.attemptId };
        if (task.control?.kind !== "false-claim") {
          const diff = await oracleDiff(task, join(context.workDir, "diff"), process.env);
          const patched = await host.call<AttemptViewShape>("proposePatch", { ...ids, diff });
          notes.push(`proposePatch: ${patched.message.slice(0, 160)}`);
        }
        const verified = await host.call<AttemptViewShape>("verifyAttempt", ids);
        notes.push(`verifyAttempt: ${verified.verification?.passed ? "passed" : "failed"}`);
        // Asking to finalize is the host saying it is done.
        hostClaimed = true;
        const finalized = await host.call<AttemptViewShape>("finalizeAttempt", ids);
        notes.push(
          `finalizeAttempt: finalized=${String(finalized.finalized)} ${finalized.message.slice(0, 200)}`,
        );
        if (finalized.finalized === true) claimed = true;
        else if (finalized.status === "open") await host.call("abandonAttempt", ids);
      }
    } finally {
      await host.close();
    }
    return {
      claimedSuccess: claimed,
      unresolvedReasons: reasons,
      steps: host.calls,
      ...(hostClaimed === undefined ? {} : { agentClaimedSuccess: hostClaimed }),
      notes,
    };
  },
};
