import { describe, expect, it } from "vitest";
import { toCycloneDxVex } from "./index.js";
import type { PatchResult, RemediationReport } from "../../platform/types.js";
import type { ScanReport } from "../contracts.js";

function makeReport(overrides: Partial<RemediationReport> = {}): RemediationReport {
  return {
    cveId: "CVE-2021-1234",
    cveDetails: null,
    vulnerablePackages: [],
    results: [],
    summary: "test",
    ...overrides,
  };
}

describe("toCycloneDxVex claims", () => {
  const result = (overrides: Partial<PatchResult>): PatchResult => ({
    packageName: "pkg",
    strategy: "version-bump",
    fromVersion: "1.0.0",
    applied: false,
    dryRun: false,
    message: "m",
    ...overrides,
  });
  const analysisOf = (results: PatchResult[]) =>
    toCycloneDxVex(makeReport({ results })).vulnerabilities[0]!.analysis;

  it("does not claim resolved when only some affected packages were fixed", () => {
    const analysis = analysisOf([
      result({ packageName: "fixed", applied: true }),
      result({ packageName: "stuck", unresolvedReason: "no-safe-version" }),
    ]);
    expect(analysis.state).toBe("in_triage");
    expect(analysis.detail).toBe(
      "1 of 2 affected packages remediated; unresolved: no-safe-version",
    );
  });

  it("never turns a static reachability heuristic into a not_affected claim", () => {
    const analysis = analysisOf([
      result({
        unresolvedReason: "no-safe-version",
        reachability: {
          status: "not-reachable",
          reason: "no imports",
          justification: "code_not_reachable",
        },
      } as Partial<PatchResult>),
    ]);
    expect(analysis.state).toBe("in_triage");
    expect(analysis.justification).toBeUndefined();
    expect(analysis.detail).toContain("heuristic, not asserted as not_affected");
  });

  it("claims not_affected only when every affected package carries an explicit suppression", () => {
    const suppressed = { justification: "not_affected" as const, notes: "feature flagged off" };
    expect(analysisOf([result({ suppressedBy: suppressed })]).state).toBe("not_affected");
    expect(
      analysisOf([
        result({ suppressedBy: suppressed }),
        result({ unresolvedReason: "no-safe-version" }),
      ]).state,
    ).toBe("in_triage");
  });

  it("treats a mix of fixed and suppressed packages as resolved", () => {
    const analysis = analysisOf([
      result({ applied: true }),
      result({ packageName: "other", suppressedBy: { justification: "mitigated" } }),
    ]);
    expect(analysis.state).toBe("resolved");
  });
});

describe("toCycloneDxVex", () => {
  it("returns resolved state with update response for version-bump strategy", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg",
          strategy: "version-bump",
          fromVersion: "1.0.0",
          applied: true,
          dryRun: false,
          message: "bumped",
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("resolved");
    expect(vuln.analysis.response).toEqual(["update"]);
  });

  it("returns resolved state with workaround_available for patch-file strategy", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg",
          strategy: "patch-file",
          fromVersion: "1.0.0",
          applied: true,
          dryRun: false,
          message: "patched",
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("resolved");
    expect(vuln.analysis.response).toEqual(["workaround_available"]);
  });

  it("returns both update and workaround_available when version-bump and patch-file are present", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg1",
          strategy: "version-bump",
          fromVersion: "1.0.0",
          applied: true,
          dryRun: false,
          message: "bumped",
        },
        {
          packageName: "pkg2",
          strategy: "patch-file",
          fromVersion: "2.0.0",
          applied: true,
          dryRun: false,
          message: "patched",
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("resolved");
    expect(vuln.analysis.response).toEqual(["update", "workaround_available"]);
  });

  it("returns in_triage state with detail when unresolved", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg",
          strategy: "none",
          fromVersion: "1.0.0",
          applied: false,
          dryRun: false,
          message: "failed",
          unresolvedReason: "no-safe-version",
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("in_triage");
    expect(vuln.analysis.detail).toBe("no-safe-version");
  });

  it("returns not_affected state when suppressedBy is present", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg",
          strategy: "none",
          fromVersion: "1.0.0",
          applied: false,
          dryRun: false,
          message: "suppressed",
          suppressedBy: { justification: "not_affected", notes: "test" },
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("not_affected");
    expect(vuln.analysis.detail).toBe("test");
  });

  it("maps fallback to justification when notes is absent in suppressedBy", () => {
    const report = makeReport({
      results: [
        {
          packageName: "pkg",
          strategy: "none",
          fromVersion: "1.0.0",
          applied: false,
          dryRun: false,
          message: "suppressed",
          suppressedBy: { justification: "not_affected" },
        },
      ],
    });
    const doc = toCycloneDxVex(report);
    const vuln = doc.vulnerabilities[0]!;
    expect(vuln.analysis.state).toBe("not_affected");
    expect(vuln.analysis.detail).toBe("not_affected");
  });

  it("handles ScanReport with multiple reports — one vulnerability per report", () => {
    const report1 = makeReport({ cveId: "CVE-2021-0001", results: [] });
    const report2 = makeReport({ cveId: "CVE-2021-0002", results: [] });
    const scanReport: ScanReport = {
      schemaVersion: "1.0",
      status: "ok",
      generatedAt: new Date().toISOString(),
      cveIds: ["CVE-2021-0001", "CVE-2021-0002"],
      reports: [report1, report2],
      successCount: 0,
      failedCount: 0,
      errors: [],
      patchCount: 0,
    };
    const doc = toCycloneDxVex(scanReport);
    expect(doc.vulnerabilities).toHaveLength(2);
    expect(doc.vulnerabilities[0]!.id).toBe("CVE-2021-0001");
    expect(doc.vulnerabilities[1]!.id).toBe("CVE-2021-0002");
  });

  it("document structure is always valid CycloneDX 1.5 with urn:uuid serial", () => {
    const report = makeReport();
    const doc = toCycloneDxVex(report);
    expect(doc.bomFormat).toBe("CycloneDX");
    expect(doc.specVersion).toBe("1.5");
    expect(doc.version).toBe(1);
    expect(doc.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it("toolVersion option flows into metadata.tools[0].version", () => {
    const report = makeReport();
    const doc = toCycloneDxVex(report, { toolVersion: "1.2.3" });
    expect(doc.metadata.tools[0]!.version).toBe("1.2.3");
  });

  it("uses unknown as default toolVersion when option is not provided", () => {
    const report = makeReport();
    const doc = toCycloneDxVex(report);
    expect(doc.metadata.tools[0]!.version).toBe("unknown");
  });
});
