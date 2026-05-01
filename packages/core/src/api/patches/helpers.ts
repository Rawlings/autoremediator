import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  PatchArtifact,
  PatchArtifactInspection,
  PatchArtifactSummary,
} from "../../platform/types.js";

export const DEFAULT_PATCHES_DIR = "./patches";

export function resolvePatchesDir(cwd: string, patchesDir = DEFAULT_PATCHES_DIR): string {
  return isAbsolute(patchesDir) ? patchesDir : resolve(cwd, patchesDir);
}

export function resolveArtifactPath(cwd: string, patchFilePath: string): string {
  const resolved = isAbsolute(patchFilePath) ? patchFilePath : resolve(cwd, patchFilePath);
  if (!resolved.endsWith(".patch")) {
    throw new Error(`patchFilePath must point to a .patch file: ${patchFilePath}`);
  }
  const patchesRoot = resolvePatchesDir(cwd);
  if (!resolved.startsWith(patchesRoot + sep)) {
    throw new Error(`patchFilePath must be inside the patches directory: ${patchFilePath}`);
  }
  return resolved;
}

export async function readManifest(manifestFilePath: string): Promise<PatchArtifact | undefined> {
  if (!existsSync(manifestFilePath)) {
    return undefined;
  }

  try {
    const raw = await readFile(manifestFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== "1.0" ||
      typeof parsed.packageName !== "string" ||
      typeof parsed.vulnerableVersion !== "string" ||
      typeof parsed.patchFilePath !== "string" ||
      typeof parsed.patchFileName !== "string" ||
      typeof parsed.applied !== "boolean" ||
      typeof parsed.dryRun !== "boolean" ||
      typeof parsed.generatedAt !== "string"
    ) {
      return undefined;
    }
    return parsed as PatchArtifact;
  } catch {
    return undefined;
  }
}

export function derivePatchMetadata(patchContent: string): { files: string[]; hunkCount: number } {
  const files = Array.from(
    new Set(
      patchContent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("+++ b/"))
        .map((line) => line.slice("+++ b/".length))
    )
  );
  const hunkCount = patchContent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@@ ")).length;

  return { files, hunkCount };
}

export function toSummary(inspection: PatchArtifactInspection): PatchArtifactSummary {
  return {
    patchFilePath: inspection.patchFilePath,
    manifestFilePath: inspection.manifestFilePath,
    patchFileName: inspection.patchFileName,
    cveId: inspection.cveId,
    packageName: inspection.packageName,
    vulnerableVersion: inspection.vulnerableVersion,
    patchMode: inspection.patchMode,
    confidence: inspection.confidence,
    riskLevel: inspection.riskLevel,
    generatedAt: inspection.generatedAt,
    files: inspection.files,
    hunkCount: inspection.hunkCount,
    diffValid: inspection.diffValid,
  };
}