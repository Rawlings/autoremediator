import { describe, expect, it, vi } from "vitest";

import { resolveTarget } from "./target.js";

describe("resolveTarget advisory ids", () => {
  const found = {
    id: "x",
    summary: "s",
    severity: "HIGH" as const,
    references: [],
    affectedPackages: [
      {
        name: "lodash",
        ecosystem: "npm" as const,
        vulnerableRange: "<4.17.21",
        source: "osv" as const,
      },
    ],
  };

  it("looks a GHSA id up in lower case, since OSV ids are case-sensitive", async () => {
    const lookupOsv = vi.fn(async () => found);
    await resolveTarget(
      "GHSA-35JH-R3H4-6JHM",
      { offline: false },
      { lookupOsv, lookupGitHub: vi.fn(async () => []) },
    );
    expect(lookupOsv).toHaveBeenCalledWith("GHSA-35jh-r3h4-6jhm");
  });

  it("still upper-cases CVE and MAL ids", async () => {
    const lookupOsv = vi.fn(async () => found);
    await resolveTarget(
      "cve-2021-23337",
      { offline: false },
      { lookupOsv, lookupGitHub: vi.fn(async () => []) },
    );
    await resolveTarget(
      "mal-2026-1",
      { offline: false },
      { lookupOsv, lookupGitHub: vi.fn(async () => []) },
    );
    expect(lookupOsv).toHaveBeenNthCalledWith(1, "CVE-2021-23337");
    expect(lookupOsv).toHaveBeenNthCalledWith(2, "MAL-2026-1");
  });
});
