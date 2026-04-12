import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPatchArtifact, listPatchArtifacts, validatePatchArtifact } from "./patches/index.js";

describe("patch lifecycle api", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lists, inspects, and validates stored patch artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "autoremediator-patches-test-"));
    createdDirs.push(cwd);

    const patchesDir = join(cwd, "patches");
    await mkdir(patchesDir, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "fixture-project",
        version: "1.0.0",
        dependencies: {
          lodash: "4.17.0",
        },
      }, null, 2) + "\n",
      "utf8"
    );

    const patchFilePath = join(patchesDir, "lodash+4.17.0.patch");
    const manifestFilePath = `${patchFilePath}.json`;
    await writeFile(
      patchFilePath,
      "diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n",
      "utf8"
    );
    await writeFile(
      manifestFilePath,
      JSON.stringify({
        schemaVersion: "1.0",
        cveId: "CVE-2021-23337",
        packageName: "lodash",
        vulnerableVersion: "4.17.0",
        patchFilePath,
        manifestFilePath,
        patchFileName: "lodash+4.17.0.patch",
        patchesDir: "./patches",
        confidence: 0.92,
        riskLevel: "medium",
        generatedAt: new Date().toISOString(),
        files: ["index.js"],
        hunkCount: 1,
        applied: true,
        dryRun: false,
        validationPhases: [
          {
            phase: "diff-format",
            passed: true,
          },
        ],
      }, null, 2) + "\n",
      "utf8"
    );

    const listed = await listPatchArtifacts({ cwd });
    const inspected = await inspectPatchArtifact(patchFilePath, { cwd });
    const validated = await validatePatchArtifact(patchFilePath, { cwd, packageManager: "npm" });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.packageName).toBe("lodash");
    expect(inspected.exists).toBe(true);
    expect(inspected.diffValid).toBe(true);
    expect(inspected.manifest?.confidence).toBe(0.92);
    expect(validated.exists).toBe(true);
    expect(validated.manifestFound).toBe(true);
    expect(validated.driftDetected).toBe(false);
    expect(validated.inventoryMatch).toBe(true);
    expect(validated.validationPhases.some((phase) => phase.phase === "drift")).toBe(true);
  });
});