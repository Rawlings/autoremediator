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

  it("throws for unsupported grouping values", async () => {
    await expect(
      createChangeRequestsForReports({
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
                message: "updated",
              },
            ],
            agentSteps: 0,
            summary: "done",
          },
        ],
      })
    ).rejects.toThrow("changeRequest.grouping currently supports only 'all'");
  });
});
