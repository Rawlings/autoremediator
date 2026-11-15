import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRemediationHandler } from "./remediation-handler.js";
import { createInMemoryAppStateStore } from "./state.js";
import { DEFAULT_REPO_CONFIG, type AutoremediatorRepoConfig } from "./types.js";

const { remediateFromScanMock } = vi.hoisted(() => ({
  remediateFromScanMock: vi.fn(async (..._args: unknown[]) => ({
    schemaVersion: "1.0",
    status: "ok",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cveIds: ["CVE-2021-23337"],
    reports: [
      {
        cveId: "CVE-2021-23337",
        results: [
          {
            packageName: "lodash",
            strategy: "version-bump",
            fromVersion: "4.17.20",
            toVersion: "4.17.21",
            applied: false,
            dryRun: true,
            message: "x",
          },
        ],
      },
    ],
    successCount: 1,
    failedCount: 0,
    errors: [],
    patchCount: 0,
  })),
}));
vi.mock("autoremediator", () => ({ remediateFromScan: remediateFromScanMock }));

function setup(permission: string, config: Partial<AutoremediatorRepoConfig> = {}) {
  const comments: string[] = [];
  const octokit = {
    repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission } })) },
    issues: {
      createComment: vi.fn(async ({ body }: { body: string }) => {
        comments.push(body);
        return {};
      }),
    },
  };
  const handler = createDefaultRemediationHandler({
    octokitFactory: vi.fn(async () => octokit as never),
    repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG, ...config })),
    checkoutProvider: vi.fn(async () => ({ cwd: "/tmp/checkout", cleanup: async () => {} })),
    stateStore: createInMemoryAppStateStore(),
  });
  const send = (body: string) =>
    handler({
      eventName: "issue_comment",
      installationId: 1,
      payload: {
        comment: { body, user: { login: "alice", type: "User" } },
        issue: { number: 7 },
        repository: { name: "r", owner: { login: "o" } },
      },
    });
  return { send, comments, octokit };
}

describe("comment commands in the handler", () => {
  beforeEach(() => remediateFromScanMock.mockClear());

  it("refuses people without write access and runs nothing", async () => {
    const { send, comments } = setup("read");
    await send("/autoremediator fix CVE-2021-23337");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("write access");
  });

  it("does not repeat that refusal on the same thread", async () => {
    const { send, comments } = setup("read");
    await send("/autoremediator fix CVE-2021-23337");
    await send("/autoremediator help");
    expect(comments).toHaveLength(1);
  });

  it("answers help without a checkout or a scan", async () => {
    const { send, comments } = setup("write");
    await send("/autoremediator help");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments[0]).toContain("/autoremediator plan");
  });

  it("asks for an id when there is none", async () => {
    const { send, comments } = setup("write");
    await send("/autoremediator fix");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments[0]).toContain("at least one CVE or GHSA id");
  });

  it("plan is a dry run with no pull request, even if the repo is set to open them", async () => {
    const { send, comments } = setup("write", { dryRun: false, pullRequest: { enabled: true } });
    await send("/autoremediator plan CVE-2021-23337");
    const options = remediateFromScanMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.dryRun).toBe(true);
    expect(options.changeRequest).toBeUndefined();
    expect(comments[0]).toContain("nothing was changed");
    expect(comments[0]).toContain("lodash");
  });

  it("fix runs for real and opens a pull request, even if the repo defaults to dry runs", async () => {
    const { send } = setup("admin", { dryRun: true });
    await send("/autoremediator fix CVE-2021-23337");
    const options = remediateFromScanMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.dryRun).toBe(false);
    expect(options.changeRequest).toMatchObject({ enabled: true, provider: "github" });
  });

  it("scans only the advisories named, not everything the audit finds", async () => {
    const { send } = setup("write");
    await send("/autoremediator plan CVE-2021-23337");
    const [input, options] = remediateFromScanMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toMatch(/filtered-findings\.sarif$/);
    expect(options.audit).toBe(false);
  });

  it("tells the issue the request failed without leaking the error, and is not retried", async () => {
    remediateFromScanMock.mockRejectedValueOnce(new Error("clone https://x-access-token:SECRET@github.com failed"));
    const { send, comments } = setup("write");
    const result = await send("/autoremediator fix CVE-2021-23337");
    // A thrown error would be re-queued and the reply posted again, up to three times.
    expect(result).toMatchObject({ status: "partial" });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("could not finish");
    expect(comments[0]).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("does not ask the queue to retry a report that failed, because the summary is already posted", async () => {
    remediateFromScanMock.mockResolvedValueOnce({
      schemaVersion: "1.0",
      status: "failed",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cveIds: ["CVE-2021-23337"],
      reports: [],
      successCount: 0,
      failedCount: 1,
      errors: [{ cveId: "CVE-2021-23337", message: "no safe version" }],
      patchCount: 0,
    } as never);
    const { send, comments } = setup("write");
    const result = await send("/autoremediator fix CVE-2021-23337");
    expect(result).toMatchObject({ status: "partial", reason: expect.stringContaining("failed") });
    expect(comments).toHaveLength(1);
  });

  it("answers with the generic failure comment when the checkout fails, and is not retried", async () => {
    const comments: string[] = [];
    const octokit = {
      repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "write" } })) },
      issues: {
        createComment: vi.fn(async ({ body }: { body: string }) => {
          comments.push(body);
          return {};
        }),
      },
    };
    const handler = createDefaultRemediationHandler({
      octokitFactory: vi.fn(async () => octokit as never),
      repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG })),
      checkoutProvider: vi.fn(async () => {
        throw new Error("clone https://x-access-token:SECRET@github.com/o/r.git failed");
      }),
    });
    const result = await handler({
      eventName: "issue_comment",
      installationId: 1,
      payload: {
        comment: { body: "/autoremediator fix CVE-2021-23337", user: { login: "alice", type: "User" } },
        issue: { number: 7 },
        repository: { name: "r", owner: { login: "o" } },
      },
    });
    expect(result).toMatchObject({ status: "partial" });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("could not finish");
    expect(comments[0]).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("answers with the generic failure comment when the clone fails, and is not retried", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PATH", "/nonexistent");
    try {
      const comments: string[] = [];
      const octokit = {
        repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "write" } })) },
        issues: {
          createComment: vi.fn(async ({ body }: { body: string }) => {
            comments.push(body);
            return {};
          }),
        },
      };
      const handler = createDefaultRemediationHandler({
        octokitFactory: vi.fn(async () => octokit as never),
        repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG })),
      });
      const result = await handler({
        eventName: "issue_comment",
        installationId: 1,
        installationToken: "ghs_SECRET",
        payload: {
          comment: { body: "/autoremediator plan CVE-2021-23337", user: { login: "alice", type: "User" } },
          issue: { number: 7 },
          repository: { name: "r", owner: { login: "o" } },
        },
      });
      expect(result).toMatchObject({ status: "partial" });
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("could not finish");
      expect(comments[0]).not.toContain("ghs_SECRET");
      expect(JSON.stringify(result)).not.toContain("ghs_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says so when a fix opened a pull request in a repository that defaults to dry runs", async () => {
    const { send, comments } = setup("admin", { dryRun: true });
    await send("/autoremediator fix CVE-2021-23337");
    expect(comments[0]).toContain(
      "This repository defaults to dry runs; this request opened a pull request anyway because you asked for it",
    );
  });

  it("does not add that sentence for a plan, or when the repository is not set to dry runs", async () => {
    const dry = setup("admin", { dryRun: true });
    await dry.send("/autoremediator plan CVE-2021-23337");
    expect(dry.comments[0]).not.toContain("defaults to dry runs");
    const live = setup("admin", { dryRun: false });
    await live.send("/autoremediator fix CVE-2021-23337");
    expect(live.comments[0]).not.toContain("defaults to dry runs");
  });
});

describe("alerts in the handler", () => {
  beforeEach(() => remediateFromScanMock.mockClear());

  const alert = (severity: string) => ({
    action: "created",
    alert: { security_advisory: { cve_id: "CVE-2021-23337", severity }, dependency: { package: { name: "lodash" } } },
    repository: { name: "r", owner: { login: "o" } },
  });
  const make = (config: Partial<AutoremediatorRepoConfig>) =>
    createDefaultRemediationHandler({
      octokitFactory: vi.fn(async () => ({}) as never),
      repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG, ...config })),
      checkoutProvider: vi.fn(async () => ({ cwd: "/tmp/checkout", cleanup: async () => {} })),
    });

  it("remediates the alert's advisory under the repo's own settings", async () => {
    await make({ dryRun: true, minimumSeverity: "HIGH" })({
      eventName: "dependabot_alert",
      installationId: 1,
      payload: alert("high"),
    });
    const options = remediateFromScanMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.dryRun).toBe(true);
    expect(options.changeRequest).toBeUndefined();
  });

  it("skips alerts below the minimum severity", async () => {
    const result = await make({ minimumSeverity: "HIGH" })({
      eventName: "dependabot_alert",
      installationId: 1,
      payload: alert("low"),
    });
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "success" });
  });
});
