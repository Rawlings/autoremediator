import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadIntelligenceSnapshot, lookupSnapshotCve } from "./snapshot.js";

describe("offline intelligence snapshots", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
    return path;
  }

  it("resolves a full entry nested under `cves`, regardless of query casing", () => {
    const snapshot = loadIntelligenceSnapshot(
      write("nested.json", {
        cves: {
          "CVE-2023-4567": {
            id: "CVE-2023-4567",
            summary: "Prototype pollution in fast-merge",
            severity: "HIGH",
            cvssScore: 8.5,
            epss: { score: 0.12, percentile: 0.85 },
            kev: { knownExploited: true },
            affectedPackages: [
              { name: "fast-merge", vulnerableRange: "<1.4.0", firstPatchedVersion: "1.4.0" },
            ],
          },
        },
      }),
    );

    for (const query of ["cve-2023-4567", "CVE-2023-4567"]) {
      const details = lookupSnapshotCve(snapshot, query);
      expect(details?.id).toBe("CVE-2023-4567");
      expect(details?.severity).toBe("HIGH");
      expect(details?.kev).toEqual({ knownExploited: true });
      expect(details?.epss).toEqual({ score: 0.12, percentile: 0.85 });
      expect(details?.affectedPackages).toEqual([
        {
          name: "fast-merge",
          ecosystem: "npm",
          vulnerableRange: "<1.4.0",
          firstPatchedVersion: "1.4.0",
          source: "offline-snapshot",
        },
      ]);
    }
  });

  it("expands the single-package shorthand without inventing data", () => {
    const snapshot = loadIntelligenceSnapshot(
      write("flat.json", {
        "CVE-2022-9999": {
          packageName: "simple-lib",
          vulnerableRange: "<2.0.0",
          firstPatchedVersion: "2.0.0",
          severity: "CRITICAL",
          cvssScore: 9.8,
          epssScore: 0.45,
          cisaKev: true,
        },
      }),
    );

    const details = lookupSnapshotCve(snapshot, "CVE-2022-9999");
    expect(details?.affectedPackages[0]).toMatchObject({
      name: "simple-lib",
      vulnerableRange: "<2.0.0",
      firstPatchedVersion: "2.0.0",
      source: "offline-snapshot",
    });
    expect(details?.cvssScore).toBe(9.8);
    // The shorthand only carries a score; no percentile may be fabricated from it.
    expect(details?.epss).toEqual({ score: 0.45 });
    expect(details?.kev).toEqual({ knownExploited: true });
  });

  it("returns null for a CVE that is not in the snapshot", () => {
    const snapshot = loadIntelligenceSnapshot(write("empty.json", { cves: {} }));
    expect(lookupSnapshotCve(snapshot, "CVE-2025-0000")).toBeNull();
  });

  it("rejects malformed entries instead of returning partial data", () => {
    const snapshot = loadIntelligenceSnapshot(
      write("bad.json", {
        "CVE-2024-0001": { packageName: "lib", vulnerableRange: "" },
        "CVE-2024-0002": {
          id: "CVE-2024-0002",
          summary: "x",
          severity: "HIGH",
          affectedPackages: [],
        },
        "CVE-2024-0003": { nonsense: true },
      }),
    );
    expect(() => lookupSnapshotCve(snapshot, "CVE-2024-0001")).toThrow(/vulnerableRange/);
    expect(() => lookupSnapshotCve(snapshot, "CVE-2024-0002")).toThrow(/affectedPackages/);
    expect(() => lookupSnapshotCve(snapshot, "CVE-2024-0003")).toThrow(
      /Invalid intelligence snapshot entry/,
    );
  });

  it("fails loudly on missing, corrupt and non-object snapshot files", () => {
    expect(() => loadIntelligenceSnapshot(join(dir, "missing.json"))).toThrow();
    expect(() => loadIntelligenceSnapshot(write("corrupt.json", "{ cves: [unclosed"))).toThrow();
    expect(() => loadIntelligenceSnapshot(write("array.json", [1, 2, 3]))).toThrow(
      "must be a JSON object keyed by CVE ID",
    );
  });
});
