import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

vi.mock("../../platform/config.js", () => ({
  getIntelligenceSourceConfig: () => ({
    certCcSearchUrl: "https://www.kb.cert.org/vuls/search",
  }),
}));

import { enrichWithCertCc } from "./certcc.js";

describe("certcc source", () => {
  it("adds CERT/CC references when a result is found", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () =>
        '<html><a href="https://www.kb.cert.org/vuls/id/123456">link</a></html>',
    })) as any;

    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "HIGH",
      references: [],
      affectedPackages: [],
    };

    const out = await enrichWithCertCc(details);
    expect(out.intelligence?.certCcMatched).toBe(true);
    expect(out.references).toContain("https://www.kb.cert.org/vuls/id/123456");
    expect(out.references).toContain("https://www.kb.cert.org/vuls/");
  });
});
