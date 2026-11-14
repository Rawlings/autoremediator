import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ScanReport } from "autoremediator";
import { describe, expect, it } from "vitest";

import { ADVISORY_ID, extractFindings } from "./runner.js";

// Captured from `autoremediator scan --output-format json` so the extension is checked against
// what the CLI really prints, not against what we assume it prints.
const report = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "scan-report.json"), "utf8"),
) as ScanReport;

describe("extractFindings", () => {
  it("maps a real CLI scan report, including exploit signals", () => {
    expect(extractFindings(report)).toEqual([
      {
        packageName: "vuln-pkg",
        cveId: "GHSA-AAAA-BBBB-CCCC",
        severity: "HIGH",
        summary: "Test vuln",
        installedVersion: "1.5.0",
        safeUpgradeVersion: "2.0.0",
        inCisaKev: true,
        epssScore: 0.42,
        epssPercentile: undefined,
        reachabilityStatus: undefined,
        dependencyScope: "direct",
      },
    ]);
  });

  it("returns nothing for an advisory with no installed vulnerable package", () => {
    const empty = { ...report, reports: [{ ...report.reports[0]!, vulnerablePackages: [] }] };
    expect(extractFindings(empty)).toEqual([]);
  });
});

describe("ADVISORY_ID", () => {
  it.each(["CVE-2021-23337", "cve-2024-12345", "GHSA-aaaa-bbbb-cccc"])("accepts %s", (id) => {
    expect(ADVISORY_ID.test(id)).toBe(true);
  });

  it.each(["", "CVE-1", "GHSA-aaaa-bbbb", "CVE-2021-23337; rm -rf /", "--cwd"])(
    "rejects %s",
    (id) => {
      expect(ADVISORY_ID.test(id)).toBe(false);
    },
  );
});
