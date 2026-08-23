import { describe, expect, it } from "vitest";
import { evaluatePackage } from "./index.js";

describe("evaluatePackage public SDK", () => {
  it("evaluates a package and returns structured report", async () => {
    const report = await evaluatePackage("lodash", {
      version: "4.17.21",
      enrichIntelligence: false,
    });

    expect(report.schemaVersion).toBe("1.0");
    expect(report.packageName).toBe("lodash");
    expect(report.evaluatedVersion).toBe("4.17.21");
    expect(typeof report.isVulnerable).toBe("boolean");
    expect(["safe", "caution", "vulnerable", "actively-exploited"]).toContain(report.verdict);
    expect(typeof report.summary).toBe("string");
    expect(Array.isArray(report.vulnerabilities)).toBe(true);
  });

  it("evaluates a non-existent package gracefully", async () => {
    const report = await evaluatePackage("non-existent-pkg-testing-12345", {
      enrichIntelligence: false,
    });

    expect(report.packageName).toBe("non-existent-pkg-testing-12345");
    expect(report.isVulnerable).toBe(false);
    expect(report.verdict).toBe("safe");
  });
});
