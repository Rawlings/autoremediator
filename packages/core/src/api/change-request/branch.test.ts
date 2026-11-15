import { describe, expect, it } from "vitest";

import type { PatchResult, RemediationReport } from "../../platform/types.js";
import { commitMessage, commitTrailers, deterministicBranchName } from "./branch.js";

function report(
  cveId: string,
  overrides: Partial<PatchResult> = {},
  extra: Partial<RemediationReport> = {},
): RemediationReport {
  return {
    cveId,
    cveDetails: null,
    vulnerablePackages: [],
    summary: "",
    results: [
      {
        packageName: "lodash",
        strategy: "version-bump",
        fromVersion: "4.17.20",
        toVersion: "4.17.21",
        applied: true,
        dryRun: false,
        message: "ok",
        ...overrides,
      },
    ],
    ...extra,
  };
}

describe("deterministicBranchName", () => {
  it("names one CVE in one package as <prefix>/<cve>-<package>", () => {
    expect(deterministicBranchName("autoremediator", ["CVE-2021-23337"], ["lodash"])).toBe(
      "autoremediator/cve-2021-23337-lodash",
    );
  });

  it("flattens scoped package names", () => {
    expect(deterministicBranchName("autoremediator", ["CVE-1"], ["@scope/pkg"])).toBe(
      "autoremediator/cve-1-scope-pkg",
    );
  });

  it("is the same on every run and in any order", () => {
    const a = deterministicBranchName("p", ["CVE-2", "CVE-1"], ["b", "a"]);
    const b = deterministicBranchName("p", ["cve-1", "CVE-2", "CVE-2"], ["a", "b", "a"]);
    expect(a).toBe(b);
  });

  it("changes when the set changes", () => {
    expect(deterministicBranchName("p", ["CVE-1", "CVE-2"], ["a"])).not.toBe(
      deterministicBranchName("p", ["CVE-1", "CVE-3"], ["a"]),
    );
  });

  it("stays short for large groups and is a valid ref", () => {
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2026-${1000 + i}`);
    const name = deterministicBranchName("autoremediator", many, ["a", "b"]);
    expect(name.length).toBeLessThan(120);
    expect(name).toMatch(/^autoremediator\/cve-2026-1000-and-\d+-more-[0-9a-f]{8}$/);
    expect(name).not.toMatch(/\.\.|\s|~|\^|:|\?|\*|\[|\\/);
  });

  it("sanitises a hostile prefix", () => {
    const name = deterministicBranchName("../evil prefix;rm", ["CVE-1"], []);
    expect(name).toBe("evil-prefix-rm/cve-1");
  });
});

describe("commitTrailers", () => {
  it("lists every CVE once, sorted", () => {
    const trailers = commitTrailers([report("CVE-2"), report("cve-1"), report("CVE-2")]);
    expect(trailers.filter((line) => line.startsWith("Fixes-CVE:"))).toEqual([
      "Fixes-CVE: CVE-1",
      "Fixes-CVE: CVE-2",
    ]);
  });

  it("includes the run id when the report has one", () => {
    expect(commitTrailers([report("CVE-1", {}, { runId: "run_abc" })])).toContain(
      "Autoremediator-Run: run_abc",
    );
  });

  it("claims verification only when every applied result passed its phases", () => {
    const passed = [
      { phase: "install" as const, passed: true },
      { phase: "test" as const, passed: true },
    ];
    const withPhases = commitTrailers([report("CVE-1", { validationPhases: passed })]);
    expect(withPhases.find((line) => line.startsWith("Verified-By:"))).toMatch(
      /^Verified-By: autoremediator \(install, test\)$/,
    );

    expect(commitTrailers([report("CVE-1")]).some((line) => line.startsWith("Verified-By:"))).toBe(
      false,
    );
    expect(
      commitTrailers([
        report("CVE-1", { validationPhases: [{ phase: "install", passed: false }] }),
      ]).some((line) => line.startsWith("Verified-By:")),
    ).toBe(false);
  });

  it("names only the phases every result shares", () => {
    const trailers = commitTrailers([
      report("CVE-1", {
        validationPhases: [
          { phase: "install", passed: true },
          { phase: "test", passed: true },
        ],
      }),
      report("CVE-2", { validationPhases: [{ phase: "install", passed: true }] }),
    ]);
    expect(trailers.find((line) => line.startsWith("Verified-By:"))).toContain("(install)");
  });
});

describe("commitMessage", () => {
  it("separates the trailers from the title with a blank line", () => {
    expect(commitMessage("title", [report("CVE-1")])).toBe("title\n\nFixes-CVE: CVE-1");
  });
});

describe("freshness steps", () => {
  it("carry a trailer of their own instead of Fixes-CVE, so a re-run recognises its commit", () => {
    const trailers = commitTrailers([report("FRESHNESS-4.1.2")]);
    expect(trailers).toContain("Autoremediator-Change: FRESHNESS-4.1.2");
    expect(trailers.some((line) => line.startsWith("Fixes-CVE:"))).toBe(false);
  });
});
