import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  PatchArtifactInspection,
  PatchArtifactQueryOptions,
  PatchArtifactSummary,
} from "../../platform/types.js";
import { validatePatchDiff } from "../../remediation/strategies/patch-utils.js";
import {
  readManifest,
  resolveArtifactPath,
  resolvePatchesDir,
  toSummary,
  derivePatchMetadata,
} from "./helpers.js";

export async function listPatchArtifacts(
  options: PatchArtifactQueryOptions = {}
): Promise<PatchArtifactSummary[]> {
  const cwd = options.cwd ?? process.cwd();
  const patchesDirPath = resolvePatchesDir(cwd, options.patchesDir);

  if (!existsSync(patchesDirPath)) {
    return [];
  }

  const entries = await readdir(patchesDirPath, { withFileTypes: true });
  const patchFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => join(patchesDirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const summaries = await Promise.all(
    patchFiles.map(async (patchFilePath) => {
      const inspection = await inspectPatchArtifact(patchFilePath, options);
      return toSummary(inspection);
    })
  );

  return summaries;
}

export async function inspectPatchArtifact(
  patchFilePath: string,
  options: PatchArtifactQueryOptions = {}
): Promise<PatchArtifactInspection> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPatchPath = resolveArtifactPath(cwd, patchFilePath);
  const patchFileName = resolvedPatchPath.split("/").pop() ?? resolvedPatchPath;
  const manifestFilePath = `${resolvedPatchPath}.json`;

  if (!existsSync(resolvedPatchPath)) {
    return {
      patchFilePath: resolvedPatchPath,
      manifestFilePath: existsSync(manifestFilePath) ? manifestFilePath : undefined,
      patchFileName,
      exists: false,
      diffValid: false,
      formatError: "Patch file does not exist.",
    };
  }

  const [patchContent, fileStats, manifest] = await Promise.all([
    readFile(resolvedPatchPath, "utf8"),
    stat(resolvedPatchPath),
    readManifest(manifestFilePath),
  ]);

  const format = validatePatchDiff(patchContent);
  const derived = derivePatchMetadata(patchContent);

  return {
    patchFilePath: resolvedPatchPath,
    manifestFilePath: manifest ? manifestFilePath : undefined,
    patchFileName,
    cveId: manifest?.cveId,
    packageName: manifest?.packageName,
    vulnerableVersion: manifest?.vulnerableVersion,
    patchMode: manifest?.patchMode,
    confidence: manifest?.confidence,
    riskLevel: manifest?.riskLevel,
    generatedAt: manifest?.generatedAt,
    files: manifest?.files ?? derived.files,
    hunkCount: manifest?.hunkCount ?? derived.hunkCount,
    exists: true,
    diffValid: format.valid,
    formatError: format.error,
    patchSizeBytes: fileStats.size,
    lineCount: patchContent.split(/\r?\n/).length,
    manifest,
  };
}