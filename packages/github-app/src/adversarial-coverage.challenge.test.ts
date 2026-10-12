import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedJobQueue, createInMemoryJobQueue } from "./queue.js";
import { createFileAppStateStore } from "./state.js";
import { repairFileContent } from "./healing/pr-healer.js";
import { dispatchGitHubEvent } from "./events.js";
import { createInMemoryAppStateStore } from "./state.js";
import { createPullRequestWithOctokit, pushBranchWithToken } from "./index.js";
import { startJobWorker } from "./worker.js";
import { readRemediationStatusTarget } from "./status-publisher.js";
import type { DiagnosticFinding } from "./diagnostics/log-parser.js";

describe("Adversarial White-Box Coverage & Hardening Suite (Challenger 2)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "adversarial-ghapp-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // =========================================================================
  // PROBE 1: Queue Persistence & Hydration for check_run (PR Auto-Healing)
  // =========================================================================
  describe("Queue Hydration & State Persistence", () => {
    // BUG REPORT: queue.ts loadQueueState validEventNames lacks "check_run"
    // Expectation: check_run jobs enqueued in file-backed queue should survive server restart.
    // Empirical Result: FAILS because validEventNames only contains check_suite, push, workflow_dispatch.
    it("PROBE 1: file-backed queue preserves check_run jobs across reload", () => {
      const queueFile = join(tempDir, "job-queue.json");
      const queue = createFileBackedJobQueue(queueFile);

      // Enqueue a check_run job (used by PR auto-healer)
      const enqueuedJob = queue.enqueue({
        eventName: "check_run",
        installationId: 456,
        deliveryId: "del-check-run-1",
        payload: { check_run: { id: 999, conclusion: "failure" } },
        maxAttempts: 3,
      });

      expect(enqueuedJob.eventName).toBe("check_run");
      expect(queue.listJobs()).toHaveLength(1);

      // Reload queue from disk simulating server restart
      const reloadedQueue = createFileBackedJobQueue(queueFile);
      const reloadedJobs = reloadedQueue.listJobs();

      // ADVERSARIAL ASSERTION:
      // In queue.ts (line 163):
      // const validEventNames = new Set(["check_suite", "push", "workflow_dispatch"]);
      // Because "check_run" is missing, checkRunJobSurvived is false!
      const checkRunJobSurvived = reloadedJobs.some((j) => j.eventName === "check_run");
      expect(checkRunJobSurvived).toBe(true);
    });

    it("PROBE 2: checks behavior when a claimed 'running' job undergoes server restart", () => {
      const queueFile = join(tempDir, "job-queue-crashed.json");
      const queue = createFileBackedJobQueue(queueFile);

      const _job = queue.enqueue({
        eventName: "check_suite",
        payload: {},
        maxAttempts: 3,
      });

      // Worker claims job, transitioning to "running"
      const claimed = queue.claimDueJobs(1);
      expect(claimed[0]?.status).toBe("running");

      // Server crashes and restarts
      const restartedQueue = createFileBackedJobQueue(queueFile);
      const jobsAfterRestart = restartedQueue.listJobs();
      expect(jobsAfterRestart[0]?.status).toBe("running");

      // Now a new worker polls for due jobs
      const reclaim = restartedQueue.claimDueJobs(1);
      // Because claimDueJobs only claims "queued" status, a crashed running job is never reclaimed!
      // Confirms running jobs remain orphaned indefinitely without dead-letter recovery
      expect(reclaim.length).toBe(0);
    });

    // BUG REPORT: state.ts FileAppStateStore hydrateFromDisk crashes on missing deliveries/installations
    it("PROBE 3: FileAppStateStore hydration safely handles missing deliveries array", () => {
      const stateFile = join(tempDir, "github-app-state.json");

      // Write valid JSON with schemaVersion: 1 but missing deliveries and installations
      writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1 }), "utf8");

      // ADVERSARIAL ASSERTION:
      // state.ts line 121 iterates parsed.deliveries without checking Array.isArray.
      // This throws TypeError: parsed.deliveries is not iterable.
      let threw = false;
      try {
        createFileAppStateStore(tempDir);
      } catch {
        threw = true;
      }

      // Expected to handle gracefully without throwing:
      expect(threw).toBe(false);
    });
  });

  // =========================================================================
  // PROBE 2: PR Auto-Healer Fallback Regex & Double-Escape Boundary Conditions
  // =========================================================================
  describe("PR Auto-Healer Regex & Diagnostic Handling", () => {
    // BUG REPORT: pr-healer.ts line 80 has double-escaped `\\s+` in regex literal
    it("PROBE 4: repairFileContent ESM default export fallback regex matches without double-escaped \\s+", () => {
      // Diagnostic message without quotes around package name (triggers targetPkg = undefined)
      const finding: DiagnosticFinding = {
        filePath: "src/index.ts",
        line: 1,
        message: "TS2614: Module has no default export",
        category: "typescript",
      };

      const sourceCode = `import chalk from "chalk";\nconsole.log(chalk.red("test"));\n`;
      const repaired = repairFileContent(sourceCode, [finding]);

      // In pr-healer.ts line 80:
      // : /import\s+([a-zA-Z0-9_$]+)\\s+from\s+['"]([^'"]+)['"];?/g;
      // Because of double-escaped "\\s+", the regex literal matches "\s" literally.
      // Thus it fails to match `import chalk from "chalk";`.
      expect(repaired).toContain(`import * as chalk from "chalk";`);
    });

    // BUG REPORT: pr-healer.ts line 98 has double-escaped `\\s+` in regex literal
    it("PROBE 5: repairFileContent CJS export= default import fallback regex matches without double-escaped \\s+", () => {
      const finding: DiagnosticFinding = {
        filePath: "src/index.ts",
        line: 1,
        message: "TS1259: Module can only be used with a default import",
        category: "typescript",
      };

      const sourceCode = `import * as express from "express";\nconst app = express();\n`;
      const repaired = repairFileContent(sourceCode, [finding]);

      // In pr-healer.ts line 98:
      // : /import\s+\*\s+as\s+([a-zA-Z0-9_$]+)\\s+from\s+['"]([^'"]+)['"];?/g;
      // Because of double-escaped "\\s+", the regex literal matches "\s" literally.
      expect(repaired).toContain(`import express from "express";`);
    });

    // BUG REPORT: pr-healer.ts lines 155-167 leaves `import { }` on trailing comma removal
    it("PROBE 6: repairFileContent cleanly removes unused import with trailing comma without leaving empty braces", () => {
      const finding: DiagnosticFinding = {
        filePath: "src/helper.ts",
        line: 1,
        ruleId: "no-unused-vars",
        message: "'unusedFunc' is defined but never used",
        category: "lint",
      };

      const codeWithTrailingComma = `import { unusedFunc, } from "./utils.js";\nexport const x = 1;\n`;
      const repaired = repairFileContent(codeWithTrailingComma, [finding]);

      // The line should be completely removed, or the import cleanly cleaned up without leaving `import { } from "./utils.js";`
      expect(repaired).not.toContain("import { }");
    });
  });

  // =========================================================================
  // PROBE 3: check_run Webhook Event Dispatching Matrix
  // =========================================================================
  describe("check_run Webhook Event Matrix", () => {
    it("PROBE 7: verifies check_run event dispatching with various actions, conclusions, and branches", async () => {
      const stateStore = createInMemoryAppStateStore();
      stateStore.markInstallationActive(777);

      const triggeredEvents: string[] = [];
      const onRemediation = (context: { eventName: string }) => {
        triggeredEvents.push(context.eventName);
      };

      // Case A: check_run with action !== "completed" (e.g. "created") -> must be ignored
      const resA = await dispatchGitHubEvent(
        { eventName: "check_run", deliveryId: "del-a" },
        { action: "created", installation: { id: 777 } },
        { stateStore, onRemediationRequested: onRemediation },
      );
      expect(resA.status).toBe("ignored");
      expect(resA.reason).toContain("check_run action not completed");

      // Case B: check_run with conclusion !== "failure" (e.g. "success") -> must be ignored
      const resB = await dispatchGitHubEvent(
        { eventName: "check_run", deliveryId: "del-b" },
        {
          action: "completed",
          check_run: { conclusion: "success" },
          installation: { id: 777 },
        },
        { stateStore, onRemediationRequested: onRemediation },
      );
      expect(resB.status).toBe("ignored");
      expect(resB.reason).toContain("check_run conclusion not failure");

      // Case C: check_run on a NON-autoremediator branch -> must be ignored
      const resC = await dispatchGitHubEvent(
        { eventName: "check_run", deliveryId: "del-c" },
        {
          action: "completed",
          check_run: {
            conclusion: "failure",
            pull_requests: [{ head: { ref: "feature/unrelated-user-branch" }, number: 10 }],
          },
          installation: { id: 777 },
        },
        { stateStore, onRemediationRequested: onRemediation },
      );
      expect(resC.status).toBe("ignored");
      expect(resC.reason).toContain("not on an autoremediator pull request branch");

      // Case D: check_run on an autoremediator PR branch with failure -> must be HANDLED
      const resD = await dispatchGitHubEvent(
        { eventName: "check_run", deliveryId: "del-d" },
        {
          action: "completed",
          check_run: {
            conclusion: "failure",
            pull_requests: [{ head: { ref: "autoremediator/fix-cve-2024-001" }, number: 42 }],
          },
          installation: { id: 777 },
        },
        { stateStore, onRemediationRequested: onRemediation },
      );
      expect(resD.status).toBe("handled");
      expect(triggeredEvents).toContain("check_run");
    });
  });

  // =========================================================================
  // PROBE 4: pr-creation.ts Unit Verification
  // =========================================================================
  describe("PR Creation & Git Push (pr-creation.ts)", () => {
    it("PROBE 8: verifies createPullRequestWithOctokit with mocked Octokit instance", async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            create: vi.fn(async (params: any) => ({
              data: {
                html_url: `https://github.com/${params.owner}/${params.repo}/pull/99`,
                number: 99,
              },
            })),
          },
        },
      };

      const result = await createPullRequestWithOctokit({
        octokit: mockOctokit as any,
        owner: "test-owner",
        repo: "test-repo",
        head: "autoremediator/fix-cve",
        base: "main",
        title: "fix: test remediation",
        body: "Automated fix",
        draft: true,
      });

      expect(result.number).toBe(99);
      expect(result.url).toBe("https://github.com/test-owner/test-repo/pull/99");
      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        head: "autoremediator/fix-cve",
        base: "main",
        title: "fix: test remediation",
        body: "Automated fix",
        draft: true,
      });
    });

    it("PROBE 9: verifies pushBranchWithToken fails truthfully when remote does not exist", async () => {
      // Running in empty temp directory without origin remote
      await expect(
        pushBranchWithToken({
          cwd: tempDir,
          branchName: "non-existent-branch",
          pushRemote: "origin",
          token: "ghs_mock_token",
        }),
      ).rejects.toThrow(/git push failed/);
    });
  });

  // =========================================================================
  // PROBE 5: Job Worker Concurrency & Out-of-Order Execution
  // =========================================================================
  describe("Job Worker Concurrency & Edge Cases", () => {
    it("PROBE 10: verifies job worker respects concurrency > 1 with out-of-order job completions", async () => {
      const queue = createInMemoryJobQueue();
      const job1 = queue.enqueue({ eventName: "push", payload: { id: 1 }, maxAttempts: 1 });
      const job2 = queue.enqueue({ eventName: "push", payload: { id: 2 }, maxAttempts: 1 });
      const job3 = queue.enqueue({ eventName: "push", payload: { id: 3 }, maxAttempts: 1 });

      let inFlightMax = 0;
      let currentInFlight = 0;
      const completedOrder: number[] = [];

      // Concurrency 2: Job 1 takes 80ms, Job 2 takes 20ms, Job 3 takes 20ms
      const delays: Record<string, number> = {
        [job1.id]: 80,
        [job2.id]: 20,
        [job3.id]: 20,
      };

      const worker = startJobWorker({
        queue,
        pollIntervalMs: 15,
        concurrency: 2,
        retryDelayMs: 50,
        processJob: async (job) => {
          currentInFlight++;
          inFlightMax = Math.max(inFlightMax, currentInFlight);
          const delay = delays[job.id] ?? 20;
          await new Promise((resolve) => setTimeout(resolve, delay));
          completedOrder.push((job.payload as any).id);
          currentInFlight--;
        },
      });

      // Wait for all 3 jobs to complete
      await new Promise((resolve) => setTimeout(resolve, 250));
      worker.stop();

      // In-flight should NEVER exceed concurrency limit (2)
      expect(inFlightMax).toBeLessThanOrEqual(2);
      expect(completedOrder).toHaveLength(3);
      // Job 2 (20ms) should finish BEFORE Job 1 (80ms)
      expect(completedOrder[0]).toBe(2);

      const allJobs = queue.listJobs();
      expect(allJobs.every((j) => j.status === "completed")).toBe(true);
    });
  });

  // =========================================================================
  // PROBE 6: Status Publisher Target Resolution for Push Events
  // =========================================================================
  describe("Status Publisher Target Resolution", () => {
    it("PROBE 11: checks readRemediationStatusTarget behavior on push webhook payloads", () => {
      // Standard GitHub push webhook payload without check_suite or workflow
      const pushPayload = {
        ref: "refs/heads/main",
        after: "c0ffee1234567890abcdef1234567890abcdef12",
        repository: {
          name: "my-service",
          owner: { login: "my-org" },
          default_branch: "main",
        },
      };

      const target = readRemediationStatusTarget(pushPayload);

      // In status-publisher.ts, readRemediationStatusTarget only checks check_suite and workflow_dispatch.
      // If head_commit is absent (e.g. tag or raw push with 'after'), target is undefined!
      expect(target).toBeUndefined(); // Documents current boundary where push events skip status publishing
    });
  });
});
