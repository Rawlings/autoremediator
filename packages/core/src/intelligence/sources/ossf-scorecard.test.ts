import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

vi.mock("../../platform/config.js", () => ({
  getIntelligenceSourceConfig: () => ({
    scorecardApi: "https://api.securityscorecards.dev",
  }),
}));

import { enrichWithOssfScorecard } from "./ossf-scorecard.js";

describe("ossf-scorecard source", () => {
  it("counts projects that return successful scorecard lookups", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    globalThis.fetch = fetchMock as any;

    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "HIGH",
      references: [],
      affectedPackages: [
        { name: "lodash", ecosystem: "npm", vulnerableRange: ">=0.0.0", source: "osv" },
        { name: "minimist", ecosystem: "npm", vulnerableRange: ">=0.0.0", source: "osv" },
      ],
    };

    const out = await enrichWithOssfScorecard(details);
    expect(out.intelligence?.scorecardProjects).toBe(1);
  });
});
