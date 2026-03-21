import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const order: string[] = [];

  const baseDetails = {
    id: "CVE-2021-23337",
    summary: "Test CVE",
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
    lookupCveOsv: vi.fn(async () => ({ ...baseDetails })),
    lookupCveGitHub: vi.fn(async () => []),
    mergeGhDataIntoCveDetails: vi.fn((details) => details),
    enrichWithNvd: vi.fn(async (details) => {
      order.push("nvd");
      return details;
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

describe("lookup-cve tool source enrichment sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.order.length = 0;
  });

  it("applies supplemental enrichers in deterministic order", async () => {
    const result = await (lookupCveTool as any).execute({
      cveId: "CVE-2021-23337",
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe("CVE-2021-23337");
    expect(result.data?.intelligence?.sourceHealth).toBeDefined();
    expect(Object.keys(result.data?.intelligence?.sourceHealth ?? {})).toEqual([
      "nvd",
      "cisa-kev",
      "epss",
      "cve-services",
      "gitlab-advisory",
      "certcc",
      "deps-dev",
      "ossf-scorecard",
      "external-feeds",
    ]);
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
