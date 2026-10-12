import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  execa: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocked.execa,
}));

import { createChangeRequestsForReports } from "./index.js";

describe("createChangeRequestsForReports", () => {
  it("returns non-created result when repository has no changes", async () => {
    mocked.execa.mockResolvedValueOnce({ stdout: "" });

    const result = await createChangeRequestsForReports({
      cwd: "/tmp/project",
      options: {
        enabled: true,
        provider: "github",
      },
      reports: [
        {
          cveId: "CVE-2021-23337",
          cveDetails: null,
          vulnerablePackages: [],
          results: [
            {
              packageName: "lodash",
              strategy: "version-bump",
              fromVersion: "4.17.20",
              toVersion: "4.17.21",
              applied: true,
              dryRun: false,
              message: "updated",
            },
          ],
          agentSteps: 0,
          summary: "done",
        },
      ],
    });

    expect(result[0]?.created).toBe(false);
    expect(result[0]?.error).toContain("No repository changes");
  });

  it("supports per-cve grouping with multiple reports", async () => {
    mocked.execa.mockResolvedValueOnce({ stdout: "" });

    const result = await createChangeRequestsForReports({
      cwd: "/tmp/project",
      options: {
        enabled: true,
        provider: "github",
        grouping: "per-cve",
      },
      reports: [
        {
          cveId: "CVE-2021-23337",
          cveDetails: null,
          vulnerablePackages: [],
          results: [
            {
              packageName: "lodash",
              strategy: "version-bump",
              fromVersion: "4.17.20",
              toVersion: "4.17.21",
              applied: true,
              dryRun: false,
              message: "ok",
            },
          ],
          agentSteps: 0,
          summary: "done",
        },
        {
          cveId: "CVE-2022-25883",
          cveDetails: null,
          vulnerablePackages: [],
          results: [
            {
              packageName: "semver",
              strategy: "version-bump",
              fromVersion: "7.3.5",
              toVersion: "7.3.7",
              applied: true,
              dryRun: false,
              message: "ok",
            },
          ],
          agentSteps: 0,
          summary: "done",
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.cveIds).toEqual(["CVE-2021-23337"]);
    expect(result[1]?.cveIds).toEqual(["CVE-2022-25883"]);
  });

  it("supports per-package grouping", async () => {
    mocked.execa.mockResolvedValueOnce({ stdout: "" });

    const result = await createChangeRequestsForReports({
      cwd: "/tmp/project",
      options: {
        enabled: true,
        provider: "github",
        grouping: "per-package",
      },
      reports: [
        {
          cveId: "CVE-2021-23337",
          cveDetails: null,
          vulnerablePackages: [],
          results: [
            {
              packageName: "lodash",
              strategy: "version-bump",
              fromVersion: "4.17.20",
              toVersion: "4.17.21",
              applied: true,
              dryRun: false,
              message: "ok",
            },
          ],
          agentSteps: 0,
          summary: "done",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.packageNames).toEqual(["lodash"]);
  });

  it("throws for truly unsupported grouping values", async () => {
    await expect(
      createChangeRequestsForReports({
        cwd: "/tmp/project",
        options: {
          enabled: true,
          provider: "github",
          grouping: "invalid-grouping" as unknown as "all",
        },
        reports: [],
      }),
    ).rejects.toThrow("Unsupported changeRequest.grouping");
  });

  it("uses GitHub API fetch and authenticated git push when token is provided", async () => {
    mocked.execa.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M package.json" };
      }
      if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
        return { stdout: "package.json" };
      }
      return { stdout: "" };
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/org/repo/pull/123" }),
    });
    globalThis.fetch = fetchMock as any;

    try {
      const result = await createChangeRequestsForReports({
        cwd: "/tmp/project",
        options: {
          enabled: true,
          provider: "github",
          repository: "org/repo",
          token: "ghp_test_token_123",
        },
        reports: [
          {
            cveId: "CVE-2021-23337",
            cveDetails: null,
            vulnerablePackages: [],
            results: [
              {
                packageName: "lodash",
                strategy: "version-bump",
                fromVersion: "4.17.20",
                toVersion: "4.17.21",
                applied: true,
                dryRun: false,
                message: "ok",
              },
            ],
            agentSteps: 0,
            summary: "done",
          },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.created).toBe(true);
      expect(result[0]?.url).toBe("https://github.com/org/repo/pull/123");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/org/repo/pulls",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer ghp_test_token_123",
          }),
        }),
      );

      const ghCalls = mocked.execa.mock.calls.filter((c: any) => c[0] === "gh");
      expect(ghCalls).toHaveLength(0);

      const pushCall = mocked.execa.mock.calls.find(
        (c: any) => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[]).includes("push"),
      );
      expect(pushCall).toBeDefined();
      expect(pushCall?.[1]).toContain(
        `http.extraheader=AUTHORIZATION: basic ${Buffer.from("x-access-token:ghp_test_token_123").toString("base64")}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles clean working tree on subsequent groups without git commit crash", async () => {
    let callCount = 0;
    mocked.execa.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        callCount++;
        return { stdout: callCount === 1 ? " M package.json" : "" };
      }
      if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
        return { stdout: "package.json" };
      }
      return { stdout: "" };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/org/repo/pull/1" }),
    }) as any;

    try {
      const result = await createChangeRequestsForReports({
        cwd: "/tmp/project",
        options: {
          enabled: true,
          provider: "github",
          repository: "org/repo",
          grouping: "per-cve",
          token: "ghp_tok",
        },
        reports: [
          {
            cveId: "CVE-1",
            cveDetails: null,
            vulnerablePackages: [],
            results: [
              {
                packageName: "pkg1",
                fromVersion: "1.0.0",
                strategy: "version-bump",
                applied: true,
                dryRun: false,
                message: "ok",
              },
            ],
            agentSteps: 0,
            summary: "done",
          },
          {
            cveId: "CVE-2",
            cveDetails: null,
            vulnerablePackages: [],
            results: [
              {
                packageName: "pkg2",
                fromVersion: "1.0.0",
                strategy: "version-bump",
                applied: true,
                dryRun: false,
                message: "ok",
              },
            ],
            agentSteps: 0,
            summary: "done",
          },
        ],
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.created).toBe(true);
      expect(result[1]?.created).toBe(false);
      expect(result[1]?.error).toBe("No repository changes to include in change request.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
