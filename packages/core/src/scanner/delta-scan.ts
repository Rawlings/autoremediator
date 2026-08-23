/**
 * Git-aware delta vulnerability scanner
 *
 * Compares dependency manifests between a git base reference (e.g. HEAD, origin/main)
 * and the active working tree or branch to identify newly introduced or resolved CVEs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import semver from "semver";
import { evaluatePackage } from "../remediation/evaluate-package.js";
import type {
  DeltaDependencyChange,
  DeltaFinding,
  DeltaScanOptions,
  DeltaScanReport,
} from "../platform/types.js";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface PackageJsonSubset {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function getChangedManifestPaths(cwd: string, baseRef: string): Promise<string[]> {
  const manifests = new Set<string>();

  try {
    // 1. Files changed between baseRef and working tree/index
    const { stdout: diffFiles } = await execa(
      "git",
      ["diff", "--name-only", baseRef, "--", "package.json", "**/package.json"],
      { cwd, reject: false },
    );
    for (const f of diffFiles.split("\n")) {
      const trimmed = f.trim();
      if (trimmed && trimmed.endsWith("package.json") && !trimmed.includes("node_modules")) {
        manifests.add(trimmed);
      }
    }

    // 2. Untracked new package.json files
    const { stdout: untrackedFiles } = await execa(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "package.json", "**/package.json"],
      { cwd, reject: false },
    );
    for (const f of untrackedFiles.split("\n")) {
      const trimmed = f.trim();
      if (trimmed && trimmed.endsWith("package.json") && !trimmed.includes("node_modules")) {
        manifests.add(trimmed);
      }
    }
  } catch {
    // If not a git repository or git command fails, check if local package.json exists
    if (existsSync(join(cwd, "package.json"))) {
      manifests.add("package.json");
    }
  }

  return Array.from(manifests);
}

async function getOldManifestContent(
  cwd: string,
  baseRef: string,
  relPath: string,
): Promise<PackageJsonSubset | null> {
  try {
    const { stdout } = await execa("git", ["show", `${baseRef}:${relPath}`], {
      cwd,
      reject: false,
    });
    if (!stdout || !stdout.trim()) return null;
    return JSON.parse(stdout) as PackageJsonSubset;
  } catch {
    return null;
  }
}

function getNewManifestContent(cwd: string, relPath: string): PackageJsonSubset | null {
  const fullPath = join(cwd, relPath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8")) as PackageJsonSubset;
  } catch {
    return null;
  }
}

function computeDependencyDiff(
  relPath: string,
  oldPkg: PackageJsonSubset | null,
  newPkg: PackageJsonSubset | null,
): DeltaDependencyChange[] {
  const changes: DeltaDependencyChange[] = [];

  for (const section of DEP_SECTIONS) {
    const oldDeps = oldPkg?.[section] ?? {};
    const newDeps = newPkg?.[section] ?? {};

    // Check added or updated dependencies
    for (const [pkgName, newVer] of Object.entries(newDeps)) {
      const oldVer = oldDeps[pkgName];
      if (!oldVer) {
        changes.push({
          packageName: pkgName,
          changeType: "added",
          newVersion: newVer,
          dependencyType: section,
          manifestPath: relPath,
        });
      } else if (oldVer !== newVer) {
        const cleanOld = semver.clean(oldVer) || semver.coerce(oldVer)?.version;
        const cleanNew = semver.clean(newVer) || semver.coerce(newVer)?.version;
        const isUpgrade =
          cleanOld && cleanNew && semver.valid(cleanOld) && semver.valid(cleanNew)
            ? semver.gt(cleanNew, cleanOld)
            : true;

        changes.push({
          packageName: pkgName,
          changeType: isUpgrade ? "upgraded" : "downgraded",
          oldVersion: oldVer,
          newVersion: newVer,
          dependencyType: section,
          manifestPath: relPath,
        });
      }
    }

    // Check removed dependencies
    for (const [pkgName, oldVer] of Object.entries(oldDeps)) {
      if (!(pkgName in newDeps)) {
        changes.push({
          packageName: pkgName,
          changeType: "removed",
          oldVersion: oldVer,
          dependencyType: section,
          manifestPath: relPath,
        });
      }
    }
  }

  return changes;
}

export async function scanDelta(options: DeltaScanOptions = {}): Promise<DeltaScanReport> {
  const cwd = options.cwd ?? process.cwd();
  const baseRef = options.baseRef ?? "HEAD";

  const changedManifests = await getChangedManifestPaths(cwd, baseRef);
  const dependencyChanges: DeltaDependencyChange[] = [];

  for (const manifestRel of changedManifests) {
    const oldPkg = await getOldManifestContent(cwd, baseRef, manifestRel);
    const newPkg = getNewManifestContent(cwd, manifestRel);
    const diffs = computeDependencyDiff(manifestRel, oldPkg, newPkg);
    dependencyChanges.push(...diffs);
  }

  const introducedFindings: DeltaFinding[] = [];
  const resolvedFindings: DeltaFinding[] = [];

  // Evaluate newly added or modified dependencies
  for (const change of dependencyChanges) {
    if (
      change.changeType === "added" ||
      change.changeType === "upgraded" ||
      change.changeType === "downgraded"
    ) {
      const cleanVer = semver.coerce(change.newVersion)?.version ?? change.newVersion;
      const evaluation = await evaluatePackage(change.packageName, {
        version: cleanVer,
        enrichIntelligence: true,
      });

      for (const vuln of evaluation.vulnerabilities) {
        introducedFindings.push({
          packageName: change.packageName,
          cveId: vuln.cveId,
          severity: vuln.severity,
          summary: vuln.summary,
          deltaType: "introduced",
          installedVersion: change.newVersion,
          safeUpgradeVersion: vuln.safeUpgradeVersion,
          inCisaKev: vuln.inCisaKev,
          epssScore: vuln.epssScore,
        });
      }
    }

    // Check if the old version had vulnerabilities resolved by this upgrade/removal
    if (
      change.oldVersion &&
      (change.changeType === "upgraded" || change.changeType === "removed")
    ) {
      const cleanOldVer = semver.coerce(change.oldVersion)?.version ?? change.oldVersion;
      const oldEval = await evaluatePackage(change.packageName, {
        version: cleanOldVer,
        enrichIntelligence: true,
      });

      const cleanNewVer = change.newVersion
        ? (semver.coerce(change.newVersion)?.version ?? change.newVersion)
        : undefined;
      const newEval = cleanNewVer
        ? await evaluatePackage(change.packageName, {
            version: cleanNewVer,
            enrichIntelligence: false,
          })
        : { vulnerabilities: [] };

      const newCveSet = new Set(newEval.vulnerabilities.map((v) => v.cveId));

      for (const oldVuln of oldEval.vulnerabilities) {
        if (!newCveSet.has(oldVuln.cveId)) {
          resolvedFindings.push({
            packageName: change.packageName,
            cveId: oldVuln.cveId,
            severity: oldVuln.severity,
            summary: oldVuln.summary,
            deltaType: "resolved",
            installedVersion: change.oldVersion,
            safeUpgradeVersion: oldVuln.safeUpgradeVersion,
            inCisaKev: oldVuln.inCisaKev,
            epssScore: oldVuln.epssScore,
          });
        }
      }
    }
  }

  let netRiskVerdict: DeltaScanReport["netRiskVerdict"] = "neutral";
  let status: DeltaScanReport["status"] = "ok";

  if (introducedFindings.length > 0) {
    netRiskVerdict = "degraded";
    status = "degraded";
  } else if (resolvedFindings.length > 0) {
    netRiskVerdict = "improved";
    status = "improved";
  }

  const summary =
    introducedFindings.length > 0
      ? `Delta scan against ${baseRef} found ${introducedFindings.length} newly introduced vulnerability(ies) across ${dependencyChanges.length} dependency change(s) (net risk: degraded).`
      : resolvedFindings.length > 0
        ? `Delta scan against ${baseRef} resolved ${resolvedFindings.length} vulnerability(ies) across ${dependencyChanges.length} dependency change(s) (net risk: improved).`
        : `Delta scan against ${baseRef} found 0 new vulnerabilities across ${dependencyChanges.length} dependency change(s) (net risk: neutral).`;

  return {
    schemaVersion: "1.0",
    status,
    baseRef,
    targetRef: "working-tree",
    changedManifests,
    dependencyChanges,
    introducedFindings,
    resolvedFindings,
    netRiskVerdict,
    summary,
    generatedAt: new Date().toISOString(),
  };
}
