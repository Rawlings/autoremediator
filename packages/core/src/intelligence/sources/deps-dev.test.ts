import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

vi.mock("../../platform/config.js", () => ({
  getIntelligenceSourceConfig: () => ({
    depsDevApi: "https://api.deps.dev/v3",
  }),
}));

import { enrichWithDepsDev } from "./deps-dev.js";

describe("deps-dev source", () => {
  it("sets enriched package count based on successful lookups", async () => {
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

    const out = await enrichWithDepsDev(details);
    expect(out.intelligence?.depsDevEnrichedPackages).toBe(1);
  });
});
