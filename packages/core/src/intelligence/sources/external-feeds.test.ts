import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

vi.mock("../../platform/config.js", () => ({
  getIntelligenceSourceConfig: () => ({
    vendorAdvisoryFeeds: ["https://vendor.example/feed"],
    commercialFeeds: ["https://commercial.example/feed"],
    commercialFeedToken: "token-1",
  }),
}));

import { enrichWithExternalFeeds } from "./external-feeds.js";

describe("external-feeds source", () => {
  it("records vendor and commercial feed hits and merges references", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as any;

    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "HIGH",
      references: [],
      affectedPackages: [],
    };

    const out = await enrichWithExternalFeeds(details);
    expect(out.intelligence?.vendorAdvisories?.length).toBe(1);
    expect(out.intelligence?.commercialFeeds?.length).toBe(1);
    expect(out.references.length).toBe(2);
  });
});
