import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

vi.mock("../../platform/config.js", () => ({
  getIntelligenceSourceConfig: () => ({
    gitLabAdvisoryApi: "https://advisories.gitlab.com/api/v1/advisories",
  }),
}));

import { enrichWithGitLabAdvisory } from "./gitlab-advisory.js";

describe("gitlab-advisory source", () => {
  it("marks match and merges references for matching CVE", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          identifiers: [{ type: "CVE", value: "CVE-2021-23337" }],
          references: ["https://gitlab.example/advisory"],
        },
      ],
    })) as any;

    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "HIGH",
      references: [],
      affectedPackages: [],
    };

    const out = await enrichWithGitLabAdvisory(details);
    expect(out.intelligence?.gitlabAdvisoryMatched).toBe(true);
    expect(out.references).toContain("https://gitlab.example/advisory");
  });
});
