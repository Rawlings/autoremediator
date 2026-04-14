import { describe, expect, it, vi } from "vitest";
import { createJobStatusPublisher, readRemediationStatusTarget } from "./status-publisher.js";
import type { QueueJob } from "./types.js";

const { checksCreateSpy, OctokitMock } = vi.hoisted(() => {
  const checksCreateSpy = vi.fn(async () => ({}));
  const OctokitMock = vi.fn(() => ({
    rest: {
      checks: {
        create: checksCreateSpy,
      },
    },
  }));
  return { checksCreateSpy, OctokitMock };
});

vi.mock("@octokit/rest", () => ({ Octokit: OctokitMock }));

function makeJob(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: "job-1",
    eventName: "check_suite",
    deliveryId: "delivery-1",
    payload: {},
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const target = { owner: "rawlings", repo: "autoremediator", headSha: "abc123" };

describe("createJobStatusPublisher", () => {
  it("no-ops when disabled", async () => {
    const publisher = createJobStatusPublisher({ enabled: false });
    const job = makeJob();

    await publisher.publishQueued({ job, installationToken: "tok", target });
    await publisher.publishRunning({ job, installationToken: "tok", target });
    await publisher.publishCompleted({ job, installationToken: "tok", target, outcome: "success" });

    expect(checksCreateSpy).not.toHaveBeenCalled();
  });

  it("skips and traces when installation token is missing", async () => {
    const traces: string[] = [];
    const publisher = createJobStatusPublisher({
      enabled: true,
      onTrace: (msg) => traces.push(msg),
    });
    const job = makeJob();

    await publisher.publishQueued({ job, installationToken: undefined, target });

    expect(checksCreateSpy).not.toHaveBeenCalled();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain("missing installation token");
  });

  it("creates a queued check run when enabled and token present", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true, checkName: "my-app/check" });
    const job = makeJob();

    await publisher.publishQueued({ job, installationToken: "tok", target });

    expect(checksCreateSpy).toHaveBeenCalledTimes(1);
    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "rawlings",
        repo: "autoremediator",
        head_sha: "abc123",
        name: "my-app/check",
        status: "queued",
      })
    );
  });

  it("creates an in_progress check run on publishRunning", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true });
    const job = makeJob();

    await publisher.publishRunning({ job, installationToken: "tok", target });

    expect(checksCreateSpy).toHaveBeenCalledTimes(1);
    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "in_progress" })
    );
  });

  it("creates a completed check run with success conclusion", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true });
    const job = makeJob();

    await publisher.publishCompleted({ job, installationToken: "tok", target, outcome: "success" });

    expect(checksCreateSpy).toHaveBeenCalledTimes(1);
    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", conclusion: "success" })
    );
  });

  it("maps partial outcome to neutral conclusion", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true });
    const job = makeJob();

    await publisher.publishCompleted({ job, installationToken: "tok", target, outcome: "partial" });

    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "neutral" })
    );
  });

  it("maps failed outcome to failure conclusion", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true });
    const job = makeJob();

    await publisher.publishCompleted({ job, installationToken: "tok", target, outcome: "failed" });

    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "failure" })
    );
  });

  it("uses default check name when none is provided", async () => {
    checksCreateSpy.mockClear();
    const publisher = createJobStatusPublisher({ enabled: true });
    const job = makeJob();

    await publisher.publishQueued({ job, installationToken: "tok", target });

    expect(checksCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "autoremediator/remediation" })
    );
  });

  it("traces and recovers when Octokit throws", async () => {
    checksCreateSpy.mockRejectedValueOnce(new Error("GitHub API error"));
    const traces: string[] = [];
    const publisher = createJobStatusPublisher({
      enabled: true,
      onTrace: (msg) => traces.push(msg),
    });
    const job = makeJob();

    await expect(publisher.publishQueued({ job, installationToken: "tok", target })).resolves.toBeUndefined();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain("GitHub API error");
  });
});

describe("readRemediationStatusTarget", () => {
  it("reads target from check_suite payload", () => {
    const payload = {
      repository: { name: "autoremediator", owner: { login: "rawlings" } },
      check_suite: { head_sha: "abc123" },
    };

    const result = readRemediationStatusTarget(payload);

    expect(result).toEqual({ owner: "rawlings", repo: "autoremediator", headSha: "abc123" });
  });

  it("reads target from workflow_dispatch payload", () => {
    const payload = {
      repository: { name: "autoremediator", owner: { login: "rawlings" } },
      head_commit: { id: "def456" },
    };

    const result = readRemediationStatusTarget(payload);

    expect(result).toEqual({ owner: "rawlings", repo: "autoremediator", headSha: "def456" });
  });

  it("returns undefined when payload is missing repository info", () => {
    const result = readRemediationStatusTarget({});

    expect(result).toBeUndefined();
  });

  it("returns undefined when head SHA is missing", () => {
    const payload = {
      repository: { name: "autoremediator", owner: { login: "rawlings" } },
    };

    const result = readRemediationStatusTarget(payload);

    expect(result).toBeUndefined();
  });
});
