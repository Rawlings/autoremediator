import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const order: string[] = [];

  const baseDetails = {
    id: "CVE-2021-23337",
    summary: "Command injection vulnerability",
    severity: "HIGH" as const,
    references: [],
    affectedPackages: [
      {
        name: "lodash",
        ecosystem: "npm" as const,
        vulnerableRange: ">=0.0.0 <4.17.21",
        source: "osv" as const,
      },
    ],
  };

  return {
    order,
    baseDetails,
    lookupCveOsv: vi.fn(async (): Promise<any> => ({ ...baseDetails })),
    lookupCveGitHub: vi.fn(async () => []),
    mergeGhDataIntoCveDetails: vi.fn((details, _gh) => ({
      ...details,
      affectedPackages: details.affectedPackages.map((p: any) => ({
        ...p,
        firstPatchedVersion: "4.17.21",
      })),
    })),
    enrichWithNvd: vi.fn(async (details) => {
      order.push("nvd");
      return { ...details, cvssScore: 7.5 };
    }),
    enrichWithCisaKev: vi.fn(async (details) => {
      order.push("kev");
      return details;
    }),
    enrichWithEpss: vi.fn(async (details) => {
      order.push("epss");
      return details;
    }),
    enrichWithCveServices: vi.fn(async (details) => {
      order.push("cve-services");
      return details;
    }),
    enrichWithGitLabAdvisory: vi.fn(async (details) => {
      order.push("gitlab");
      return details;
    }),
    enrichWithCertCc: vi.fn(async (details) => {
      order.push("certcc");
      return details;
    }),
    enrichWithDepsDev: vi.fn(async (details) => {
      order.push("deps-dev");
      return details;
    }),
    enrichWithOssfScorecard: vi.fn(async (details) => {
      order.push("scorecard");
      return details;
    }),
    enrichWithExternalFeeds: vi.fn(async (details) => {
      order.push("external");
      return details;
    }),
  };
});

vi.mock("ai", () => ({
  tool: (def: unknown) => def,
}));

vi.mock("../../intelligence/sources/osv.js", () => ({
  lookupCveOsv: mocked.lookupCveOsv,
}));

vi.mock("../../intelligence/sources/github-advisory.js", () => ({
  lookupCveGitHub: mocked.lookupCveGitHub,
  mergeGhDataIntoCveDetails: mocked.mergeGhDataIntoCveDetails,
}));

vi.mock("../../intelligence/sources/nvd.js", () => ({
  enrichWithNvd: mocked.enrichWithNvd,
}));

vi.mock("../../intelligence/sources/cisa-kev.js", () => ({
  enrichWithCisaKev: mocked.enrichWithCisaKev,
}));

vi.mock("../../intelligence/sources/epss.js", () => ({
  enrichWithEpss: mocked.enrichWithEpss,
}));

vi.mock("../../intelligence/sources/cve-services.js", () => ({
  enrichWithCveServices: mocked.enrichWithCveServices,
}));

vi.mock("../../intelligence/sources/gitlab-advisory.js", () => ({
  enrichWithGitLabAdvisory: mocked.enrichWithGitLabAdvisory,
}));

vi.mock("../../intelligence/sources/certcc.js", () => ({
  enrichWithCertCc: mocked.enrichWithCertCc,
}));

vi.mock("../../intelligence/sources/deps-dev.js", () => ({
  enrichWithDepsDev: mocked.enrichWithDepsDev,
}));

vi.mock("../../intelligence/sources/ossf-scorecard.js", () => ({
  enrichWithOssfScorecard: mocked.enrichWithOssfScorecard,
}));

vi.mock("../../intelligence/sources/external-feeds.js", () => ({
  enrichWithExternalFeeds: mocked.enrichWithExternalFeeds,
}));

import { lookupCveTool } from "./lookup-cve.js";

describe("lookup-cve tool authentic verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.order.length = 0;
    mocked.lookupCveOsv.mockResolvedValue({ ...mocked.baseDetails });
    mocked.lookupCveGitHub.mockResolvedValue([]);
  });

  it("normalizes lowercase cve identifier to uppercase", async () => {
    const result = await (lookupCveTool as any).execute({
      cveId: "cve-2021-23337",
    });

    expect(result.success).toBe(true);
    expect(mocked.lookupCveOsv).toHaveBeenCalledWith("CVE-2021-23337");
    expect(mocked.lookupCveGitHub).toHaveBeenCalledWith("CVE-2021-23337");
    expect(result.data?.id).toBe("CVE-2021-23337");
  });

  it("rejects invalid CVE identifiers using schema validation", () => {
    const schema = (lookupCveTool as any).parameters;
    expect(() => schema.parse({ cveId: "GHSA-1234-5678" })).toThrow();
    expect(() => schema.parse({ cveId: "not-a-cve" })).toThrow();
    expect(() => schema.parse({ cveId: "CVE-2021" })).toThrow();
    expect(schema.parse({ cveId: "CVE-2021-23337" })).toEqual({ cveId: "CVE-2021-23337" });
  });

  it("returns success: false when advisory not found in OSV or GitHub", async () => {
    mocked.lookupCveOsv.mockResolvedValueOnce(null);
    mocked.lookupCveGitHub.mockResolvedValueOnce([]);

    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2099-99999",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("was not found in OSV or GitHub Advisory databases");
  });

  it("returns success: false when advisory has no npm-specific affected packages", async () => {
    mocked.lookupCveOsv.mockResolvedValueOnce({
      ...mocked.baseDetails,
      affectedPackages: [],
    });
    mocked.lookupCveGitHub.mockResolvedValueOnce([]);

    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2021-23337",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("has no npm-specific affected packages listed");
  });

  it("merges GitHub Advisory data into OSV details", async () => {
    const ghData = [{ packageName: "lodash", firstPatchedVersion: "4.17.21" }];
    mocked.lookupCveGitHub.mockResolvedValueOnce(ghData as any);

    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2021-23337",
    });

    expect(result.success).toBe(true);
    expect(mocked.mergeGhDataIntoCveDetails).toHaveBeenCalled();
    expect(result.data?.affectedPackages[0]?.firstPatchedVersion).toBe("4.17.21");
  });

  it("records sourceHealth accurately when enrichers modify data or throw errors", async () => {
    // nvd modifies data (cvssScore added)
    // epss throws error
    mocked.enrichWithEpss.mockRejectedValueOnce(new Error("EPSS service timeout"));

    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2021-23337",
    });

    expect(result.success).toBe(true);
    const health = result.data?.intelligence?.sourceHealth;
    expect(health).toBeDefined();

    // NVD modified the data
    expect(health?.nvd).toEqual({ attempted: true, changed: true });

    // EPSS threw an error
    expect(health?.epss).toEqual({
      attempted: true,
      changed: false,
      error: "EPSS service timeout",
    });

    // CISA-KEV did not change data but succeeded
    expect(health?.["cisa-kev"]).toEqual({ attempted: true, changed: false });
  });

  it("applies supplemental enrichers in deterministic order", async () => {
    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2021-23337",
    });

    expect(result.success).toBe(true);
    expect(mocked.order).toEqual([
      "nvd",
      "kev",
      "epss",
      "cve-services",
      "gitlab",
      "certcc",
      "deps-dev",
      "scorecard",
      "external",
    ]);
  });
});
