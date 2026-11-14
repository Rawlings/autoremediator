import semver from "semver";
import { describe, expect, it, vi } from "vitest";

import { parseOsvVuln, lookupCveOsv } from "./osv.js";

describe("osv source", () => {
  it("parses npm affected package ranges and fixed versions", () => {
    const details = parseOsvVuln({
      id: "CVE-2021-23337",
      summary: "Prototype pollution",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/9.8" }],
      references: [{ type: "WEB", url: "https://osv.dev/example" }],
      affected: [
        {
          package: { name: "lodash", ecosystem: "npm" },
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "4.17.21" }],
            },
          ],
        },
      ],
    } as any);

    expect(details.id).toBe("CVE-2021-23337");
    expect(details.severity).toBe("CRITICAL");
    expect(details.references).toEqual(["https://osv.dev/example"]);
    expect(details.affectedPackages).toHaveLength(1);
    expect(details.affectedPackages[0]?.name).toBe("lodash");
    expect(details.affectedPackages[0]?.vulnerableRange).toBe(">=0.0.0 <4.17.21");
    expect(details.affectedPackages[0]?.firstPatchedVersion).toBe("4.17.21");
  });

  const parse = (affected: unknown[], extra: Record<string, unknown> = {}) =>
    parseOsvVuln({ id: "GHSA-test", affected, ...extra } as any);

  it("unions multiple introduced/fixed intervals instead of intersecting them", () => {
    const [pkg] = parse([
      {
        package: { name: "multi", ecosystem: "npm" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: "0" },
              { fixed: "1.5.0" },
              { introduced: "2.0.0" },
              { fixed: "2.3.0" },
            ],
          },
        ],
      },
    ]).affectedPackages;

    expect(pkg?.vulnerableRange).toBe(">=0.0.0 <1.5.0 || >=2.0.0 <2.3.0");
    expect(semver.satisfies("1.2.0", pkg!.vulnerableRange)).toBe(true);
    expect(semver.satisfies("1.9.0", pkg!.vulnerableRange)).toBe(false);
    expect(semver.satisfies("2.1.0", pkg!.vulnerableRange)).toBe(true);
    expect(semver.satisfies("2.3.0", pkg!.vulnerableRange)).toBe(false);
  });

  it("handles open-ended and last_affected intervals", () => {
    const ranges = (events: unknown[]) =>
      parse([{ package: { name: "p", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events }] }])
        .affectedPackages[0]?.vulnerableRange;

    expect(ranges([{ introduced: "3.1.0" }])).toBe(">=3.1.0");
    expect(ranges([{ introduced: "1.0.0" }, { last_affected: "1.4.2" }])).toBe(">=1.0.0 <=1.4.2");
    expect(ranges([{ fixed: "0.9.0" }])).toBe("<0.9.0");
  });

  it("reads ECOSYSTEM ranges, which GitHub-sourced npm records use", () => {
    const [pkg] = parse([
      {
        package: { name: "gh-origin", ecosystem: "npm" },
        ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "4.0.1" }] }],
      },
    ]).affectedPackages;
    expect(pkg).toMatchObject({ vulnerableRange: ">=0.0.0 <4.0.1", firstPatchedVersion: "4.0.1" });
  });

  it("falls back to an explicit version list", () => {
    const [pkg] = parse([
      { package: { name: "listed", ecosystem: "npm" }, versions: ["1.0.0", "1.0.1", "not-semver"] },
    ]).affectedPackages;
    expect(pkg?.vulnerableRange).toBe("=1.0.0 || =1.0.1");
  });

  it("omits a package whose affected versions are unknown rather than claiming all of them", () => {
    const details = parse([
      { package: { name: "unknown-range", ecosystem: "npm" } },
      {
        package: { name: "git-only", ecosystem: "npm" },
        ranges: [{ type: "GIT", events: [{ introduced: "abc" }] }],
      },
    ]);
    expect(details.affectedPackages).toEqual([]);
  });

  it("keeps the publication date so SLA windows can be evaluated", () => {
    expect(parse([], { published: "2024-03-01T00:00:00Z" }).publishedAt).toBe(
      "2024-03-01T00:00:00Z",
    );
  });

  it("lookupCveOsv returns null on 404", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 404, ok: false, text: async () => "" })) as any;
    const result = await lookupCveOsv("CVE-2099-0001");
    expect(result).toBeNull();
  });
});
