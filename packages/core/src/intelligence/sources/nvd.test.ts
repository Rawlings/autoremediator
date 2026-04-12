import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/config.js", () => ({
  getNvdConfig: () => ({ apiKey: "test-key" }),
}));

import { enrichWithNvd, fetchNvdCvss } from "./nvd.js";
import type { CveDetails } from "../../platform/types.js";

describe("nvd source", () => {
  it("fetchNvdCvss maps CVSS metric to score and severity", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2021-23337",
              metrics: {
                cvssMetricV31: [
                  {
                    cvssData: {
                      baseScore: 7.5,
                      baseSeverity: "HIGH",
                      vectorString: "CVSS:3.1/...",
                    },
                  },
                ],
              },
            },
          },
        ],
      }),
    })) as any;

    const cvss = await fetchNvdCvss("CVE-2021-23337");
    expect(cvss).toEqual({ score: 7.5, severity: "HIGH" });
  });

  it("enrichWithNvd sets cvssScore and fills unknown severity", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2021-23337",
              metrics: {
                cvssMetricV31: [
                  {
                    cvssData: {
                      baseScore: 9.8,
                      baseSeverity: "CRITICAL",
                      vectorString: "CVSS:3.1/...",
                    },
                  },
                ],
              },
            },
          },
        ],
      }),
    })) as any;

    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "UNKNOWN",
      references: [],
      affectedPackages: [],
    };

    const out = await enrichWithNvd(details);
    expect(out.cvssScore).toBe(9.8);
    expect(out.severity).toBe("CRITICAL");
  });
});
