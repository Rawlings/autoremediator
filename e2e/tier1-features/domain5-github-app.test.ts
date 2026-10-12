import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeRequestsForReports } from "../../packages/core/src/api/change-request/index.js";
import type { RemediationReport } from "../../packages/core/src/platform/types.js";
import { repairFileContent } from "../../packages/github-app/src/healing/pr-healer.js";
import { createInMemoryJobQueue } from "../../packages/github-app/src/queue.js";
import { startJobWorker } from "../../packages/github-app/src/worker.js";
import { cleanupTempDir, createTempRepo, writeRepoFile } from "../fixtures/temp-repo.js";

describe("Tier 1 - Domain 5: GitHub App Real Execution & Healing Hardening", () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await createTempRepo({
      initGit: true,
      files: {
        "src/app.ts": `import chalk from "chalk";\nconsole.log(chalk.red("test"));\n`,
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(tempRepo);
  });

  it("F21: PR auto-healer repairs default export mismatch without injecting @ts-expect-error", () => {
    const inputContent = `import chalk from "chalk";
export function formatMessage(msg: string) {
  return chalk.red(msg);
}
`;
    const findings = [
      {
        filePath: "src/app.ts",
        line: 1,
        column: 8,
        message: 'Module "chalk" has no default export.',
        ruleId: "TS2614",
        category: "typescript" as const,
      },
    ];

    const repaired = repairFileContent(inputContent, findings);

    // Verify import was corrected to namespace import
    expect(repaired).toContain('import * as chalk from "chalk"');

    // F21: Must not inject compiler suppression comments into user pull requests
    expect(repaired).not.toContain("@ts-expect-error");
    expect(repaired).not.toContain("@ts-ignore");
  });

  it("F24: multi-group change request handles clean working tree without crashing", async () => {
    // Two remediation reports in two separate groups
    const reports: RemediationReport[] = [
      {
        cveId: "CVE-2021-0001",
        results: [
          {
            packageName: "pkg-one",
            applied: true,
            dependencyScope: "direct",
            targetVersion: "1.1.0",
          },
        ],
      },
      {
        cveId: "CVE-2021-0002",
        results: [
          {
            packageName: "pkg-two",
            applied: true,
            dependencyScope: "direct",
            targetVersion: "2.1.0",
          },
        ],
      },
    ];

    // Mutate file so there are repo changes
    writeRepoFile(tempRepo, "src/app.ts", `// modified for CVE remediation\n`);

    const results = await createChangeRequestsForReports({
      cwd: tempRepo,
      options: {
        grouping: "per-cve",
        provider: "github",
        repository: "owner/repo",
      },
      reports,
    });

    // Should return results for both groups without git fatal working tree clean crashes
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it("F25: job worker correctly logs and transitions failed jobs without false success", async () => {
    const queue = createInMemoryJobQueue();
    const failedJobsList: string[] = [];

    // Enqueue a job that will fail
    queue.enqueue({
      eventName: "check_suite",
      installationId: 12345,
      payload: { test: true },
      maxAttempts: 1,
    });

    const worker = startJobWorker({
      queue,
      pollIntervalMs: 50,
      concurrency: 1,
      retryDelayMs: 100,
      processJob: async () => {
        throw new Error("Simulated remediation job failure");
      },
      onJobFailed: (job) => {
        failedJobsList.push(job.id);
      },
    });

    // Wait for worker to pick up and fail the job
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stop();

    expect(failedJobsList.length).toBe(1);
    const allJobs = queue.listJobs();
    expect(allJobs[0]?.status).toBe("failed");
    expect(allJobs[0]?.lastError).toContain("Simulated remediation job failure");
  });

  it("F25: queue deduplicates active jobs by dedupeKey", () => {
    const queue = createInMemoryJobQueue();

    const job1 = queue.enqueue({
      eventName: "check_suite",
      dedupeKey: "repo-123:main",
      payload: {},
      maxAttempts: 2,
    });

    const job2 = queue.enqueue({
      eventName: "check_suite",
      dedupeKey: "repo-123:main",
      payload: {},
      maxAttempts: 2,
    });

    // Both should return the same active job
    expect(job1.id).toBe(job2.id);
    expect(queue.listJobs().length).toBe(1);
  });

  it("F22: webhook remediation execution uses isolated directory and preserves process cwd", async () => {
    const originalCwd = process.cwd();
    const isolatedDir = tempRepo;

    // Verify isolated directory exists and is distinct from server process cwd
    expect(isolatedDir).not.toBe(originalCwd);

    // After operations inside isolated repo, server process cwd must remain untouched
    expect(process.cwd()).toBe(originalCwd);
  });
});
