import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobRegistry } from "../../platform/jobs.js";

const mocked = vi.hoisted(() => ({
  remediate: vi.fn(),
  remediateFromScan: vi.fn(),
  remediatePortfolio: vi.fn(),
}));

vi.mock("../remediate/index.js", () => ({ remediate: mocked.remediate }));
vi.mock("../remediate-from-scan/index.js", () => ({ remediateFromScan: mocked.remediateFromScan }));
vi.mock("../portfolio/index.js", () => ({ remediatePortfolio: mocked.remediatePortfolio }));

import { submitRemediateJob, submitScanJob, submitPortfolioJob, pollJob } from "./index.js";

describe("submitRemediateJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
  });

  it("returns a JobHandle with pending status immediately", () => {
    mocked.remediate.mockReturnValue(new Promise(() => {})); // never resolves
    const handle = submitRemediateJob("CVE-2021-1234");
    expect(handle.jobId).toBeDefined();
    expect(handle.status).toBe("pending");
    expect(handle.submittedAt).toBeDefined();
  });

  it("registers the job in the registry", () => {
    mocked.remediate.mockReturnValue(new Promise(() => {}));
    const handle = submitRemediateJob("CVE-2021-1234");
    expect(jobRegistry.has(handle.jobId)).toBe(true);
  });

  it("job moves to done after work resolves", async () => {
    const reportResult = { cveId: "CVE-2021-1234", results: [] };
    mocked.remediate.mockResolvedValue(reportResult);
    const handle = submitRemediateJob("CVE-2021-1234");
    // Wait for the microtask to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    const job = pollJob(handle.jobId);
    expect(job.status).toBe("done");
    expect(job.result).toBe(reportResult);
    expect(job.completedAt).toBeDefined();
  });

  it("job moves to failed when work rejects", async () => {
    mocked.remediate.mockRejectedValue(new Error("network error"));
    const handle = submitRemediateJob("CVE-2021-1234");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const job = pollJob(handle.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("network error");
    expect(job.completedAt).toBeDefined();
  });
});

describe("submitScanJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
  });

  it("returns a JobHandle and registers the job", () => {
    mocked.remediateFromScan.mockReturnValue(new Promise(() => {}));
    const handle = submitScanJob("/tmp/audit.json");
    expect(handle.jobId).toBeDefined();
    expect(jobRegistry.has(handle.jobId)).toBe(true);
  });
});

describe("submitPortfolioJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
  });

  it("returns a JobHandle and registers the job", () => {
    mocked.remediatePortfolio.mockReturnValue(new Promise(() => {}));
    const handle = submitPortfolioJob([{ cwd: "/tmp/project" }]);
    expect(handle.jobId).toBeDefined();
    expect(jobRegistry.has(handle.jobId)).toBe(true);
  });
});

describe("pollJob", () => {
  beforeEach(() => {
    jobRegistry.clear();
  });

  it("throws when jobId is not found", () => {
    expect(() => pollJob("nonexistent-id")).toThrow("Job not found: nonexistent-id");
  });

  it("returns current job state", async () => {
    mocked.remediate.mockReturnValue(new Promise(() => {}));
    const handle = submitRemediateJob("CVE-2021-1234");
    const job = pollJob(handle.jobId);
    expect(job.jobId).toBe(handle.jobId);
    expect(job.status).toBe("pending");
  });
});
