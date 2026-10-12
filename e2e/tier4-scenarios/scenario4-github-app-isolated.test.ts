import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeRequestsForReports } from "../../packages/core/src/api/change-request/index.js";
import type { RemediationReport } from "../../packages/core/src/platform/types.js";
import { repairFileContent } from "../../packages/github-app/src/healing/pr-healer.js";
import { createInMemoryJobQueue } from "../../packages/github-app/src/queue.js";
import { startJobWorker } from "../../packages/github-app/src/worker.js";
import { cleanupTempDir, createTempRepo, writeRepoFile } from "../fixtures/temp-repo.js";

describe("Tier 4 - Scenario 4: GitHub App Isolated Checkout & Multi-Group Remediation", () => {
  let isolatedCheckoutDir: string;
  let serverWorkingDir: string;

  beforeEach(async () => {
    serverWorkingDir = process.cwd();
    isolatedCheckoutDir = await createTempRepo({
      initGit: true,
      name: "enterprise-repo",
      version: "3.0.0",
      files: {
        "src/logger.ts": `import chalk from "chalk";\nexport function log(msg: string) { console.log(chalk(msg)); }\n`,
        "src/utils.ts": `export function compute() { return 42; }\n`,
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(isolatedCheckoutDir);
  });

  it("processes GitHub webhook events in isolated workspace without mutating server state", async () => {
    // Stage 1: Enqueue Webhook remediation job in GitHub App job queue
    const queue = createInMemoryJobQueue();
    const job = queue.enqueue({
      eventName: "check_run",
      installationId: 98765,
      deliveryId: "delivery-uuid-1",
      payload: {
        action: "rerequested",
        repository: { name: "enterprise-repo", owner: { login: "enterprise-org" } },
        check_run: {
          name: "ci/build",
          conclusion: "failure",
          pull_requests: [{ number: 42, head: { ref: "autoremediator/fix-cve-1" } }],
        },
      },
      maxAttempts: 1,
    });

    expect(job.status).toBe("queued");

    // Stage 2: Worker claims job and performs remediation in isolated checkout directory
    let workerFinished = false;
    const worker = startJobWorker({
      queue,
      pollIntervalMs: 50,
      concurrency: 1,
      retryDelayMs: 100,
      processJob: async (activeJob) => {
        expect(activeJob.id).toBe(job.id);

        // Verify that process.cwd remains untouched by isolated checkout execution
        expect(process.cwd()).toBe(serverWorkingDir);

        // Perform auto-healing on logger.ts inside isolated directory
        const loggerFile = join(isolatedCheckoutDir, "src/logger.ts");
        const code = readFileSync(loggerFile, "utf8");
        const healed = repairFileContent(code, [
          {
            filePath: "src/logger.ts",
            message: 'Module "chalk" has no default export.',
            ruleId: "TS2614",
            category: "typescript",
          },
        ]);

        writeRepoFile(isolatedCheckoutDir, "src/logger.ts", healed);

        // Create change requests for multiple CVE groups
        const reports: RemediationReport[] = [
          {
            cveId: "CVE-2023-1111",
            results: [{ packageName: "chalk", applied: true, dependencyScope: "direct" }],
          },
          {
            cveId: "CVE-2023-2222",
            results: [{ packageName: "utils", applied: true, dependencyScope: "direct" }],
          },
        ];

        const crResults = await createChangeRequestsForReports({
          cwd: isolatedCheckoutDir,
          options: {
            grouping: "per-cve",
            provider: "github",
            repository: "enterprise-org/enterprise-repo",
          },
          reports,
        });

        expect(Array.isArray(crResults)).toBe(true);
        expect(crResults.length).toBe(2);
        workerFinished = true;
      },
    });

    // Wait for worker processing to finish
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (workerFinished) {
          clearInterval(check);
          resolve(true);
        }
      }, 50);
    });

    worker.stop();

    // Verify job transitioned to completed status
    expect(queue.listJobs()[0]?.status).toBe("completed");
    // Verify server working directory was never altered
    expect(process.cwd()).toBe(serverWorkingDir);
  });
});
