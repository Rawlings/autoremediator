import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  getPackageManagerCommands,
  getYarnMajorVersion,
  type PackageManager,
} from "../../../platform/package-manager/index.js";
import type {
  PatchArtifact,
  PatchMode,
  PatchValidationPhase,
} from "../../../platform/types.js";

export interface ValidationResult {
  passed: boolean;
  error?: string;
  output?: string;
  failedTests?: string[];
}

export interface RawPackageJson {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageJsonSnapshot {
  path: string;
  content: string;
}

export async function resolvePatchMode(packageManager: PackageManager, cwd: string): Promise<PatchMode> {
  if (packageManager === "npm") return "patch-package";
  if (packageManager === "pnpm") return "native-pnpm";

  const major = await getYarnMajorVersion(cwd);
  return major >= 2 ? "native-yarn" : "patch-package";
}

export function patchModeRequiresPackageJsonSnapshot(packageManager: PackageManager): boolean {
  if (packageManager === "npm") return true;
  if (packageManager === "pnpm") return false;
  return true;
}

export function buildPatchFileName(packageName: string, vulnerableVersion: string): string {
  const safeName = packageName.replace(/^@/, "").replace(/\//g, "+");
  return `${safeName}+${vulnerableVersion}.patch`;
}

export function extractPatchedFiles(patchContent: string): string[] {
  return Array.from(
    new Set(
      patchContent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("+++ b/"))
        .map((line) => line.slice("+++ b/".length))
    )
  );
}

export function countPatchHunks(patchContent: string): number {
  return patchContent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@@ ")).length;
}

export function computePatchIntegrity(patchContent: string): string {
  const hex = createHash("sha256").update(patchContent, "utf8").digest("hex");
  return `sha256:${hex}`;
}

export async function writePatchManifest(manifestFilePath: string, artifact: PatchArtifact): Promise<void> {
  await writeFile(manifestFilePath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

export async function configurePatchPackagePostinstall(
  cwd: string,
  packageManager: PackageManager
): Promise<{ success: true } | { success: false; error: string }> {
  const pkgJsonPath = join(cwd, "package.json");
  let pkgJson: RawPackageJson;

  try {
    pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8")) as RawPackageJson;
  } catch {
    return {
      success: false,
      error: `Could not read package.json at ${pkgJsonPath}`,
    };
  }

  const devDependencies = pkgJson.devDependencies ?? {};
  if (!devDependencies["patch-package"]) {
    try {
      const commands = getPackageManagerCommands(packageManager);
      const [cmd, ...args] = commands.installDev("patch-package");
      await execa(cmd, args, {
        cwd,
        stdio: "pipe",
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to install patch-package: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!pkgJson.scripts) {
    pkgJson.scripts = {};
  }

  const patchApplyCmd = "patch-package";
  const currentPostinstall = pkgJson.scripts.postinstall || "";

  if (currentPostinstall && !currentPostinstall.includes("patch-package")) {
    pkgJson.scripts.postinstall = `${currentPostinstall} && ${patchApplyCmd}`;
  } else if (!currentPostinstall) {
    pkgJson.scripts.postinstall = patchApplyCmd;
  }

  await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
  return { success: true };
}

export async function capturePackageJsonSnapshot(cwd: string): Promise<PackageJsonSnapshot | undefined> {
  const path = join(cwd, "package.json");

  try {
    const content = await readFile(path, "utf8");
    return { path, content };
  } catch {
    return undefined;
  }
}

export async function cleanupPatchArtifacts(params: {
  cwd: string;
  patchFilePath: string;
  manifestFilePath?: string;
  patchMode: PatchMode;
  packageJsonSnapshot?: PackageJsonSnapshot;
  installCommand: string[];
  rerunInstall: boolean;
}): Promise<void> {
  const {
    cwd,
    patchFilePath,
    manifestFilePath,
    patchMode,
    packageJsonSnapshot,
    installCommand,
    rerunInstall,
  } = params;

  await rm(patchFilePath, { force: true }).catch(() => undefined);
  if (manifestFilePath) {
    await rm(manifestFilePath, { force: true }).catch(() => undefined);
  }

  if (patchMode === "patch-package" && packageJsonSnapshot) {
    await writeFile(packageJsonSnapshot.path, packageJsonSnapshot.content, "utf8").catch(() => undefined);
  }

  if (!rerunInstall) return;

  try {
    const [installCmd, ...installArgs] = installCommand;
    await execa(installCmd, installArgs, {
      cwd,
      stdio: "pipe",
    });
  } catch {
    // Ignore cleanup install failures and preserve the original remediation error.
  }
}

export async function applyNativePatch(params: {
  cwd: string;
  packageName: string;
  vulnerableVersion: string;
  patchContent: string;
  patchMode: "native-pnpm" | "native-yarn";
  validationPhases: PatchValidationPhase[];
}): Promise<{ success: true } | { success: false; error: string }> {
  const { cwd, packageName, vulnerableVersion, patchContent, patchMode, validationPhases } = params;
  const packageSpec = `${packageName}@${vulnerableVersion}`;

  const createCommand = patchMode === "native-pnpm" ? "pnpm" : "yarn";
  const createArgs = ["patch", packageSpec];

  let patchDir: string;
  try {
    const createResult = await execa(createCommand, createArgs, {
      cwd,
      stdio: "pipe",
    });
    patchDir = extractPatchDirectory(`${createResult.stdout}\n${createResult.stderr}`);
  } catch (err) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: `Failed to create native patch workspace for ${packageSpec}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!patchDir) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: `Could not determine native patch directory for ${packageSpec}.`,
    });
    return {
      success: false,
      error: `Could not determine native patch directory for ${packageSpec}.`,
    };
  }

  const tempPatchDir = await mkdtemp(join(tmpdir(), "autoremediator-native-patch-"));
  const tempPatchFile = join(tempPatchDir, "change.patch");

  try {
    await writeFile(tempPatchFile, patchContent, "utf8");
    await execa("patch", ["-p1", "-i", tempPatchFile], {
      cwd: patchDir,
      stdio: "pipe",
    });

    const commitCommand = patchMode === "native-pnpm" ? "pnpm" : "yarn";
    const commitArgs =
      patchMode === "native-pnpm"
        ? ["patch-commit", patchDir]
        : ["patch-commit", "-s", patchDir];

    await execa(commitCommand, commitArgs, {
      cwd,
      stdio: "pipe",
    });
  } catch (err) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: `Failed to apply native patch for ${packageSpec}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    await rm(tempPatchDir, { recursive: true, force: true });
  }

  return { success: true };
}

function extractPatchDirectory(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (existsSync(line)) {
      return line;
    }

    const tokens = line.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
    for (const token of tokens) {
      if (token.startsWith("/") && existsSync(token)) {
        return token;
      }
    }
  }

  return "";
}

export async function validatePatchWithTests(cwd: string, testCommand: string[]): Promise<ValidationResult> {
  try {
    const [cmd, ...args] = testCommand;
    const result = await execa(cmd, args, {
      cwd,
      timeout: 60000,
      stdio: "pipe",
    });

    return {
      passed: true,
      output: result.stdout,
    };
  } catch (err) {
    const errorOutput =
      typeof err === "object" && err !== null && "stdout" in err
        ? String((err as Record<string, unknown>).stdout ?? "")
        : "";
    const failedTests = extractFailedTests(errorOutput);

    return {
      passed: false,
      error:
        failedTests.length > 0
          ? `Failed tests: ${failedTests.join(", ")}`
          : "Package-manager test validation failed.",
      output: errorOutput,
      failedTests,
    };
  }
}

function extractFailedTests(output: string): string[] {
  const failedTests: string[] = [];
  const patterns = [
    /✖\s+(.+?)(?:\n|$)/g,
    /●\s+(.+)(?:\n|$)/g,
    /^FAIL\s+(.+?)(?:\n|$)/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      if (match[1]) {
        failedTests.push(match[1].trim());
      }
    }
  }

  return failedTests.slice(0, 5);
}