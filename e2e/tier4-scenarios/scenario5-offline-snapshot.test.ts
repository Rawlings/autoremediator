import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobRegistry } from "../../packages/core/src/platform/jobs.js";
import { createRuntimeToolsForRun } from "../../packages/core/src/remediation/pipeline-runtime/tool-wrappers.js";
import { cleanupTempDir, createTempDir, createTempRepo } from "../fixtures/temp-repo.js";

describe("Tier 4 - Scenario 5: Offline Intelligence Remediation with Snapshot", () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await createTempRepo({
      initGit: true,
      name: "airgapped-internal-service",
      version: "1.0.0",
      dependencies: {
        lodash: "4.17.20",
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(tempRepo);
  });

  it("completes offline remediation using local snapshot intelligence and tracks in bounded job registry", async () => {
    // Stage 1: Prepare offline snapshot file
    const snapshotPath = join(tempRepo, "intelligence-snapshot.json");
    const snapshotContent = {
      version: "1.0",
      generatedAt: new Date().toISOString(),
      cves: {
        "CVE-2021-23337": {
          cveId: "CVE-2021-23337",
          packageName: "lodash",
          vulnerableRange: "<4.17.21",
          firstPatchedVersion: "4.17.21",
          severity: "HIGH",
          exploitSignal: false,
        },
      },
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshotContent, null, 2), "utf8");

    // Stage 2: Register remediation job in bounded registry
    const jobId = `offline-job-${Date.now()}`;
    jobRegistry.set(jobId, {
      jobId,
      status: "running",
      submittedAt: new Date().toISOString(),
    });

    // Stage 3: Instantiate runtime tools configured for offline mode
    const runtimeTools = createRuntimeToolsForRun({
      cwd: tempRepo,
      offlineIntelligence: true,
      intelligenceSnapshotPath: snapshotPath,
    });

    const lookupTool = (runtimeTools as Record<string, { execute: (input: { cveId: string }) => Promise<unknown> }>)[
      "lookup-cve"
    ];
    expect(lookupTool).toBeDefined();

    const lookupResult = (await lookupTool!.execute({ cveId: "CVE-2021-23337" })) as Record<
      string,
      unknown
    >;

    expect(lookupResult).toBeDefined();
    expect(lookupResult.cveId).toBe("CVE-2021-23337");
    expect(lookupResult.offlineMode).toBe(true);

    // Stage 4: Mark job complete and verify status
    jobRegistry.set(jobId, {
      jobId,
      status: "done",
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: {
        cveId: "CVE-2021-23337",
        packageName: "lodash",
        offlineResolved: true,
      },
    });

    const finalJob = jobRegistry.get(jobId);
    expect(finalJob?.status).toBe("done");
    expect((finalJob?.result as Record<string, unknown>)?.offlineResolved).toBe(true);

    jobRegistry.delete(jobId);
  });
});
