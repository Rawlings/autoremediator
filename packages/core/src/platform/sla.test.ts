import { describe, expect, it } from "vitest";
import { computeSlaBreaches } from "./sla.js";

describe("computeSlaBreaches", () => {
  it("returns a breach when CVE published 100h ago and SLA.high=72", () => {
    const now = new Date();
    const publishedAt = new Date(now.getTime() - 100 * 60 * 60 * 1000).toISOString();
    const results = computeSlaBreaches(
      [{ cveId: "CVE-2024-0001", publishedAt, severity: "HIGH" }],
      { high: 72 }
    );
    expect(results).toHaveLength(1);
    expect(results[0].cveId).toBe("CVE-2024-0001");
    expect(results[0].hoursOverdue).toBeGreaterThan(27);
    expect(results[0].severity).toBe("HIGH");
  });

  it("returns no breach when CVE published 10h ago and SLA.high=72", () => {
    const now = new Date();
    const publishedAt = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
    const results = computeSlaBreaches(
      [{ cveId: "CVE-2024-0002", publishedAt, severity: "HIGH" }],
      { high: 72 }
    );
    expect(results).toHaveLength(0);
  });

  it("returns no breach when no SLA configured for severity", () => {
    const now = new Date();
    const publishedAt = new Date(now.getTime() - 200 * 60 * 60 * 1000).toISOString();
    const results = computeSlaBreaches(
      [{ cveId: "CVE-2024-0003", publishedAt, severity: "LOW" }],
      { high: 72 }
    );
    expect(results).toHaveLength(0);
  });

  it("returns no breach when publishedAt is absent", () => {
    const results = computeSlaBreaches(
      [{ cveId: "CVE-2024-0004", publishedAt: undefined, severity: "HIGH" }],
      { high: 72 }
    );
    expect(results).toHaveLength(0);
  });
});
