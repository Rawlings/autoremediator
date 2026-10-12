import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobRegistry } from "../../packages/core/src/platform/jobs.js";
import { isPackageAllowed, loadPolicy } from "../../packages/core/src/platform/policy.js";
import { withAtomicRollback } from "../../packages/core/src/platform/rollback.js";
import { applyDispositionAndContainment } from "../../packages/core/src/remediation/local/disposition.js";
import { cleanupTempDir, createTempDir } from "../fixtures/temp-repo.js";

describe("Tier 1 - Domain 4: Autonomous Defense Controls & Surface Integrity", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("domain4-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("F15: withAtomicRollback restores mutated files on disk upon rollback trigger", async () => {
    const fileToTrack = join(tempDir, "config.json");
    writeFileSync(fileToTrack, JSON.stringify({ state: "initial" }), "utf8");

    // Execute an action inside rollback envelope that mutates file, but triggers rollback
    await withAtomicRollback(
      tempDir,
      async () => {
        writeFileSync(fileToTrack, JSON.stringify({ state: "mutated-should-revert" }), "utf8");
        return { success: false, shouldRevert: true };
      },
      {
        filesToTrack: [fileToTrack],
        shouldRollback: (res) => res.shouldRevert,
      },
    );

    // After rollback, content must be restored to original
    const restored = JSON.parse(readFileSync(fileToTrack, "utf8")) as Record<string, string>;
    expect(restored.state).toBe("initial");
  });

  it("F15: applyDispositionAndContainment rewrites applied result to policy-blocked on escalate", () => {
    const mockResult = {
      applied: true,
      packageName: "vulnerable-lib",
      targetVersion: "2.0.0",
      confidence: 0.95,
      riskLevel: "high" as const,
    };

    const contained = applyDispositionAndContainment(mockResult, {
      containmentMode: true,
      exploitSignalTriggered: true, // triggers escalate disposition
      policy: {
        escalateOnKev: true,
      },
    });

    expect(contained.disposition).toBe("escalate");
    expect(contained.applied).toBe(false);
    expect(contained.unresolvedReason).toBe("policy-blocked");
  });

  it("F16: policy denyPackages blocks disallowed packages prior to mutation", () => {
    const policyFile = join(tempDir, "autoremediator.yml");
    writeFileSync(
      policyFile,
      `allowMajorBumps: false\ndenyPackages:\n  - "malicious-package"\n  - "deprecated-core"\n`,
      "utf8",
    );

    const loaded = loadPolicy(tempDir, policyFile);
    expect(loaded.denyPackages).toContain("malicious-package");
    expect(loaded.denyPackages).toContain("deprecated-core");

    expect(isPackageAllowed(loaded, "malicious-package")).toBe(false);
    expect(isPackageAllowed(loaded, "deprecated-core")).toBe(false);
    expect(isPackageAllowed(loaded, "safe-package")).toBe(true);
  });

  it("F18: jobRegistry registers, retrieves, and tracks remediation jobs", () => {
    const testJobId = `job-${Date.now()}`;
    jobRegistry.set(testJobId, {
      jobId: testJobId,
      status: "pending",
      submittedAt: new Date().toISOString(),
    });

    expect(jobRegistry.has(testJobId)).toBe(true);
    const retrieved = jobRegistry.get(testJobId);
    expect(retrieved?.status).toBe("pending");

    // Transition to done
    jobRegistry.set(testJobId, {
      ...retrieved!,
      status: "done",
      completedAt: new Date().toISOString(),
      result: { remediated: true },
    });

    expect(jobRegistry.get(testJobId)?.status).toBe("done");
    jobRegistry.delete(testJobId);
  });

  it("F19: real HTTP route handler processes request and returns valid JSON response", async () => {
    const { handleOpenApiRequest } = await import(
      "../../packages/core/src/openapi/handlers/index.js"
    );
    const { OPENAPI_SPEC } = await import(
      "../../packages/core/src/openapi/spec/index.js"
    );

    const { PassThrough } = await import("node:stream");

    const req = new PassThrough() as unknown as http.IncomingMessage;
    req.url = "/openapi.json";
    req.method = "GET";
    req.headers = {};

    let statusCode = 0;
    let responseData = "";
    const res = new PassThrough() as unknown as http.ServerResponse;
    (res as unknown as Record<string, unknown>).writeHead = (status: number) => {
      statusCode = status;
      return res;
    };
    (res as unknown as Record<string, unknown>).setHeader = () => res;
    (res as unknown as Record<string, unknown>).end = (chunk?: string) => {
      if (chunk) responseData += chunk;
      return res;
    };

    const handled = await handleOpenApiRequest(req, res, {
      remediateFn: async () => ({} as never),
      remediateFromScanFn: async () => ({} as never),
      remediatePortfolioFn: async () => ({} as never),
      planRemediationFn: async () => ({} as never),
      updateOutdatedFn: async () => ({} as never),
      listPatchArtifactsFn: async () => [],
      inspectPatchArtifactFn: async () => ({} as never),
      validatePatchArtifactFn: async () => ({} as never),
      toVexFn: async () => ({} as never),
      submitRemediateJobFn: () => ({} as never),
      submitScanJobFn: () => ({} as never),
      submitPortfolioJobFn: () => ({} as never),
      pollJobFn: () => ({} as never),
    });

    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(responseData) as Record<string, unknown>;
    expect(parsed.openapi).toBe("3.1.0");
  });
});
