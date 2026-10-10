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
});
