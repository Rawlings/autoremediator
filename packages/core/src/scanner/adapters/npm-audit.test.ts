import { describe, expect, it } from "vitest";
import { parseNpmAuditJsonFromString } from "./npm-audit.js";

describe("parseNpmAuditJsonFromString", () => {
  it("extracts CVEs from npm audit vulnerabilities", () => {
    const input = {
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          via: [
            {
              name: "lodash",
              url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm CVE-2021-23337",
            },
          ],
        },
      },
    };

    const findings = parseNpmAuditJsonFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      cveId: "CVE-2021-23337",
      source: "npm-audit",
      packageName: "lodash",
      severity: "HIGH",
    });
  });

  it("deduplicates repeated CVE entries", () => {
    const input = {
      vulnerabilities: {
        minimist: {
          name: "minimist",
          severity: "medium",
          via: ["CVE-2021-44906", "https://nvd.nist.gov/vuln/detail/CVE-2021-44906"],
        },
      },
    };

    const findings = parseNpmAuditJsonFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.cveId).toBe("CVE-2021-44906");
  });

  it("normalises 'moderate' severity to MEDIUM", () => {
    const input = {
      vulnerabilities: {
        semver: {
          name: "semver",
          severity: "moderate",
          via: ["CVE-2022-25883"],
        },
      },
    };

    const findings = parseNpmAuditJsonFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      cveId: "CVE-2022-25883",
      severity: "MEDIUM",
    });
  });

  it("extracts GHSA ID when no CVE is present", () => {
    const input = {
      vulnerabilities: {
        tar: {
          name: "tar",
          severity: "high",
          via: [
            {
              name: "tar",
              url: "https://github.com/advisories/GHSA-8h25-w444-5ce3",
            },
          ],
        },
      },
    };

    const findings = parseNpmAuditJsonFromString(JSON.stringify(input));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      cveId: "GHSA-8H25-W444-5CE3",
      source: "npm-audit",
      packageName: "tar",
      severity: "HIGH",
    });
  });
});
