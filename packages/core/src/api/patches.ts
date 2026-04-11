import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  PatchArtifact,
  PatchArtifactInspection,
  PatchArtifactQueryOptions,
  PatchArtifactSummary,
  PatchArtifactValidationReport,
  PatchValidationPhase,
} from "../platform/types.js";
import { detectPackageManager } from "../platform/package-manager.js";
import { validatePatchDiff } from "../remediation/strategies/patch-utils.js";
import { checkInventoryTool } from "../remediation/tools/check-inventory.js";

const DEFAULT_PATCHES_DIR = "./patches";

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

export async function validatePatchArtifact(
  patchFilePath: string,
  options: PatchArtifactQueryOptions = {}
): Promise<PatchArtifactValidationReport> {
  const inspection = await inspectPatchArtifact(patchFilePath, options);
  const validationPhases: PatchValidationPhase[] = [
    {
      phase: "diff-format",
      passed: inspection.diffValid,
      error: inspection.diffValid ? undefined : inspection.formatError,
      message: inspection.diffValid ? "Patch content is a valid unified diff." : undefined,
    },
  ];

  if (!inspection.exists) {
    return {
      patchFilePath: inspection.patchFilePath,
      manifestFilePath: inspection.manifestFilePath,
      exists: false,
      manifestFound: false,
      diffValid: false,
      formatError: inspection.formatError,
      driftDetected: false,
      validationPhases,
    };
  }

  const manifest = inspection.manifest;
  const manifestFound = Boolean(manifest);

  if (!manifest) {
    validationPhases.push({
      phase: "manifest-write",
      passed: false,
      error: "No patch manifest found for this patch artifact.",
    });

    return {
      patchFilePath: inspection.patchFilePath,
      manifestFilePath: inspection.manifestFilePath,
      exists: true,
      manifestFound,
      diffValid: inspection.diffValid,
      formatError: inspection.formatError,
      driftDetected: false,
      validationPhases,
    };
  }

  validationPhases.push({
    phase: "manifest-write",
    passed: true,
    message: "Patch manifest is present.",
  });

  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const inventory = (await (checkInventoryTool as any).execute({
    cwd,
    packageManager,
  })) as {
    error?: string;
    packages?: Array<{ name: string; version: string }>;
  };

  if (inventory.error) {
    validationPhases.push({
      phase: "drift",
      passed: false,
      error: inventory.error,
    });

    return {
      patchFilePath: inspection.patchFilePath,
      manifestFilePath: inspection.manifestFilePath,
      exists: true,
      manifestFound,
      diffValid: inspection.diffValid,
      formatError: inspection.formatError,
      driftDetected: false,
      cveId: manifest.cveId,
      packageName: manifest.packageName,
      vulnerableVersion: manifest.vulnerableVersion,
      validationPhases,
    };
  }

  const matchingPackages = (inventory.packages ?? []).filter(
    (pkg) => pkg.name === manifest.packageName
  );
  const installedVersion = matchingPackages[0]?.version;
  const inventoryMatch = matchingPackages.some(
    (pkg) => pkg.version === manifest.vulnerableVersion
  );
  const driftDetected = matchingPackages.length > 0 && !inventoryMatch;

  validationPhases.push({
    phase: "drift",
    passed: !driftDetected,
    message:
      matchingPackages.length === 0
        ? `Package ${manifest.packageName} is not currently installed.`
        : inventoryMatch
          ? `Installed version matches manifest target ${manifest.vulnerableVersion}.`
          : `Installed version ${installedVersion} does not match manifest target ${manifest.vulnerableVersion}.`,
    error: driftDetected ? "Patch manifest does not match the installed dependency version." : undefined,
  });

  return {
    patchFilePath: inspection.patchFilePath,
    manifestFilePath: inspection.manifestFilePath,
    exists: true,
    manifestFound,
    diffValid: inspection.diffValid,
    formatError: inspection.formatError,
    driftDetected,
    cveId: manifest.cveId,
    packageName: manifest.packageName,
    vulnerableVersion: manifest.vulnerableVersion,
    installedVersion,
    inventoryMatch,
    validationPhases,
  };
}

function resolvePatchesDir(cwd: string, patchesDir = DEFAULT_PATCHES_DIR): string {
  return isAbsolute(patchesDir) ? patchesDir : resolve(cwd, patchesDir);
}

function resolveArtifactPath(cwd: string, patchFilePath: string): string {
  return isAbsolute(patchFilePath) ? patchFilePath : resolve(cwd, patchFilePath);
}

async function readManifest(manifestFilePath: string): Promise<PatchArtifact | undefined> {
  if (!existsSync(manifestFilePath)) {
    return undefined;
  }

  try {
    const raw = await readFile(manifestFilePath, "utf8");
    return JSON.parse(raw) as PatchArtifact;
  } catch {
    return undefined;
  }
}

function derivePatchMetadata(patchContent: string): { files: string[]; hunkCount: number } {
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

function toSummary(inspection: PatchArtifactInspection): PatchArtifactSummary {
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