import { describe, expect, it } from "vitest";
import { parseYarnAuditJsonFromString } from "./yarn-audit.js";

describe("parseYarnAuditJsonFromString", () => {
  it("extracts CVEs from yarn audit advisory events", () => {
    const input = [
      JSON.stringify({
        type: "auditAdvisory",
        data: {
          advisory: {
            module_name: "lodash",
            severity: "high",
            url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
            cves: ["CVE-2021-23337"],
          },
        },
      }),
      JSON.stringify({ type: "auditSummary", data: { vulnerabilities: { high: 1 } } }),
    ].join("\n");

    const findings = parseYarnAuditJsonFromString(input);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      cveId: "CVE-2021-23337",
      source: "yarn-audit",
      packageName: "lodash",
      severity: "HIGH",
    });
  });

  it("deduplicates repeated CVE entries", () => {
    const input = [
      JSON.stringify({
        type: "auditAdvisory",
        data: {
          advisory: {
            module_name: "minimist",
            severity: "medium",
            cves: ["CVE-2021-44906", "CVE-2021-44906"],
          },
        },
      }),
    ].join("\n");

    const findings = parseYarnAuditJsonFromString(input);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.cveId).toBe("CVE-2021-44906");
  });
});
