import { describe, expect, it } from "vitest";
import { scanDelta } from "./index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "../../../../");

describe("scanDelta public SDK", () => {
  it("scans working tree against HEAD without error", { timeout: 30_000 }, async () => {
    const report = await scanDelta({
      cwd: projectRoot,
      baseRef: "HEAD",
    });

    expect(report.schemaVersion).toBe("1.0");
    expect(["ok", "degraded", "improved", "neutral"]).toContain(report.status);
    expect(report.baseRef).toBe("HEAD");
    expect(report.targetRef).toBe("working-tree");
    expect(Array.isArray(report.changedManifests)).toBe(true);
    expect(Array.isArray(report.dependencyChanges)).toBe(true);
    expect(Array.isArray(report.introducedFindings)).toBe(true);
    expect(Array.isArray(report.resolvedFindings)).toBe(true);
    expect(["improved", "neutral", "degraded"]).toContain(report.netRiskVerdict);
    expect(typeof report.summary).toBe("string");
  });
});
