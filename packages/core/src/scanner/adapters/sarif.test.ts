import { describe, expect, it } from "vitest";
import { parseSarifFromString } from "./sarif.js";

describe("parseSarifFromString", () => {
  it("extracts CVEs from SARIF results", () => {
    const input = {
      runs: [
        {
          results: [
            {
              ruleId: "npm.security.CVE-2022-24999",
              message: { text: "Prototype pollution in qs" },
              properties: { packageName: "qs" },
            },
          ],
        },
      ],
    };

    const findings = parseSarifFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      cveId: "CVE-2022-24999",
      source: "sarif",
      packageName: "qs",
      severity: "UNKNOWN",
    });
  });

  it("deduplicates CVEs across repeated results", () => {
    const input = {
      runs: [
        {
          results: [
            {
              ruleId: "CVE-2020-8203",
              message: { text: "lodash vulnerability" },
            },
            {
              ruleId: "security-check",
              message: { text: "CVE-2020-8203 appears again" },
            },
          ],
        },
      ],
    };

    const findings = parseSarifFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.cveId).toBe("CVE-2020-8203");
  });
});
