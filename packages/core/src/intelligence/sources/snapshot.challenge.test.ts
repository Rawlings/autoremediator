import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadIntelligenceSnapshot } from "./snapshot.js";
import { createRuntimeToolsForRun } from "../../remediation/pipeline-runtime/tool-wrappers.js";

describe("Feature 13: Adversarial Offline Intelligence (Co-located Challenge Suite)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "challenger-offline-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves CVE from nested offline snapshot { cves: { ... } } regardless of query casing", async () => {
    const snapshotPath = join(tempDir, "offline-snapshot.json");
    const snapshot = {
      meta: { generated: "2026-10-11" },
      cves: {
        "CVE-2023-4567": {
          id: "CVE-2023-4567",
          summary: "Prototype pollution in fast-merge",
          severity: "HIGH",
          cvssScore: 8.5,
          epss: { score: 0.12, percentile: 0.85 },
          kev: { knownExploited: true },
          affectedPackages: [
            {
              name: "fast-merge",
              ecosystem: "npm",
              vulnerableRange: "<1.4.0",
              firstPatchedVersion: "1.4.0",
            },
          ],
        },
      },
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const runtimeTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
      intelligenceSnapshotPath: snapshotPath,
    });

    const lookupTool = (
      runtimeTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;

    // Test lowercase query
    const resultLower = await lookupTool.execute({ cveId: "cve-2023-4567" });
    expect(resultLower.success).toBe(true);
    expect(resultLower.found).toBe(true);
    expect(resultLower.offlineMode).toBe(true);
    expect(resultLower.data.id).toBe("CVE-2023-4567");
    expect(resultLower.data.severity).toBe("HIGH");
    expect(resultLower.data.kev.knownExploited).toBe(true);
    expect(resultLower.data.epss.score).toBe(0.12);

    // Test uppercase query
    const resultUpper = await lookupTool.execute({ cveId: "CVE-2023-4567" });
    expect(resultUpper.success).toBe(true);
    expect(resultUpper.found).toBe(true);
  });

  it("resolves CVE from flat snapshot schema and normalizes minimal fields including cisaKev and epssScore", async () => {
    const snapshotPath = join(tempDir, "flat-snapshot.json");
    const snapshot = {
      "CVE-2022-9999": {
        packageName: "simple-lib",
        vulnerableRange: "<2.0.0",
        firstPatchedVersion: "2.0.0",
        severity: "CRITICAL",
        cvssScore: 9.8,
        epssScore: 0.45,
        cisaKev: true,
      },
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const runtimeTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
      intelligenceSnapshotPath: snapshotPath,
    });

    const lookupTool = (
      runtimeTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;

    const result = await lookupTool.execute({ cveId: "CVE-2022-9999" });
    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.data.affectedPackages).toEqual([
      {
        name: "simple-lib",
        ecosystem: "npm",
        vulnerableRange: "<2.0.0",
        firstPatchedVersion: "2.0.0",
        source: "offline-snapshot",
      },
    ]);
    expect(result.data.cvssScore).toBe(9.8);
    expect(result.data.epss).toEqual({ score: 0.45, percentile: 0.45 });
    expect(result.data.kev).toEqual({ knownExploited: true });
  });

  it("returns truthful error when CVE is absent from snapshot", async () => {
    const snapshotPath = join(tempDir, "empty-snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify({ cves: {} }), "utf8");

    const runtimeTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
      intelligenceSnapshotPath: snapshotPath,
    });

    const lookupTool = (
      runtimeTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;

    const result = await lookupTool.execute({ cveId: "CVE-2025-0000" });
    expect(result.success).toBe(false);
    expect(result.found).toBe(false);
    expect(result.offlineMode).toBe(true);
    expect(result.error).toBe("Offline mode: CVE-2025-0000 not found in intelligence snapshot.");
  });

  it("handles corrupt, non-existent, and non-object snapshot files gracefully without crashing", async () => {
    // Non-existent path
    const missingTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
      intelligenceSnapshotPath: join(tempDir, "nonexistent-file.json"),
    });
    const missingTool = (
      missingTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;
    const missingRes = await missingTool.execute({ cveId: "CVE-2023-1111" });
    expect(missingRes.success).toBe(false);
    expect(missingRes.error).toContain("intelligence snapshot file not found or invalid");

    // Corrupt JSON
    const corruptPath = join(tempDir, "corrupt.json");
    writeFileSync(corruptPath, "{ cves: [unclosed json...", "utf8");
    const corruptTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
      intelligenceSnapshotPath: corruptPath,
    });
    const corruptTool = (
      corruptTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;
    const corruptRes = await corruptTool.execute({ cveId: "CVE-2023-1111" });
    expect(corruptRes.success).toBe(false);
    expect(corruptRes.error).toContain("intelligence snapshot file not found or invalid");

    // No snapshot path specified
    const unspecTools = createRuntimeToolsForRun({
      cwd: tempDir,
      offlineIntelligence: true,
    });
    const unspecTool = (
      unspecTools as unknown as Record<
        string,
        { execute: (input: { cveId: string }) => Promise<any> }
      >
    )["lookup-cve"]!;
    const unspecRes = await unspecTool.execute({ cveId: "CVE-2023-1111" });
    expect(unspecRes.success).toBe(false);
    expect(unspecRes.error).toContain("intelligence lookup skipped (no snapshot provided)");
  });

  it("loadIntelligenceSnapshot throws informative error on array JSON snapshot", () => {
    const arrayPath = join(tempDir, "array.json");
    writeFileSync(arrayPath, JSON.stringify([1, 2, 3]), "utf8");
    expect(() => loadIntelligenceSnapshot(arrayPath)).toThrow(
      "must be a JSON object keyed by CVE ID",
    );
  });
});
