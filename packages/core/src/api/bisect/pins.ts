import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import type { PackageManager } from "../../platform/types.js";
import {
  setOverrideValue,
  type RawPackageJson,
} from "../../remediation/tools/apply-package-override/helpers.js";
import { serializeManifest } from "../../remediation/tools/manifest-format.js";
import { parseLockfileDependencies } from "../../scanner/lockfile-diff.js";
import type { BisectedPackage } from "./types.js";

const DIRECT_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export interface PinContext {
  /** Project directory inside the checkout. */
  dir: string;
  packageManager: PackageManager;
  /**
   * pnpm 11 and later read overrides from `pnpm-workspace.yaml` and ignore the `pnpm` field of
   * `package.json`; older versions are the other way round.
   */
  pnpmMajor?: number;
}

export interface Pin {
  packageName: string;
  version: string;
}

/**
 * Where a pin ends up, as a one-line description for the report.
 */
export function describePinMechanism(context: PinContext): string {
  const direct = "direct dependencies: exact version in package.json; others: ";
  if (context.packageManager === "pnpm") {
    return `${direct}${(context.pnpmMajor ?? 0) >= 11 ? "overrides in pnpm-workspace.yaml" : "pnpm.overrides in package.json"}`;
  }
  return `${direct}${context.packageManager === "yarn" ? "resolutions" : "overrides"} in package.json`;
}

/**
 * Hold each package at an exact version in the checkout, without touching its lockfile: direct
 * dependencies get their range replaced by the exact version in the section(s) declaring them
 * (npm refuses an override for a direct dependency), everything else goes through the package
 * manager's own override field. The checkout is expected to be a fresh copy of the good ref.
 */
export function applyPins(context: PinContext, pins: readonly Pin[]): void {
  if (pins.length === 0) return;
  const manifestPath = join(context.dir, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original) as RawPackageJson;

  const overrides: Pin[] = [];
  for (const pin of pins) {
    let declared = false;
    for (const section of DIRECT_SECTIONS) {
      const entries = manifest[section] as Record<string, string> | undefined;
      if (entries && Object.hasOwn(entries, pin.packageName)) {
        entries[pin.packageName] = pin.version;
        declared = true;
      }
    }
    if (!declared) overrides.push(pin);
  }

  const useWorkspaceYaml = context.packageManager === "pnpm" && (context.pnpmMajor ?? 0) >= 11;
  if (useWorkspaceYaml) {
    if (overrides.length > 0) writeWorkspaceOverrides(context.dir, overrides);
  } else {
    for (const pin of overrides) {
      setOverrideValue(manifest, context.packageManager, pin.packageName, pin.version);
    }
  }
  writeFileSync(manifestPath, serializeManifest(original, manifest), "utf8");
}

/** Merge overrides into `pnpm-workspace.yaml`, keeping whatever else (and whatever comments) it has. */
function writeWorkspaceOverrides(dir: string, overrides: readonly Pin[]): void {
  const path = join(dir, "pnpm-workspace.yaml");
  const document = existsSync(path)
    ? YAML.parseDocument(readFileSync(path, "utf8"))
    : new YAML.Document({});
  for (const pin of overrides) document.setIn(["overrides", pin.packageName], pin.version);
  writeFileSync(path, document.toString(), "utf8");
}

export interface PinMismatch {
  packageName: string;
  expected: string;
  found: string[];
}

/**
 * Check that an installed state is the one that was asked for: every package in `updates` is at the
 * bad-ref version if it is in `updated` and at the good-ref version otherwise. Package managers
 * resolve overrides and ranges their own way, so a pin that silently did not take effect would
 * otherwise produce a confident wrong answer.
 */
export function checkLockedVersions(
  lockfileName: string,
  lockfileContent: string,
  updates: readonly BisectedPackage[],
  updated: ReadonlySet<string>,
): PinMismatch[] {
  const locked = parseLockfileDependencies(lockfileName, lockfileContent);
  const mismatches: PinMismatch[] = [];
  for (const update of updates) {
    const expected = updated.has(update.packageName) ? update.toVersion : update.fromVersion;
    const found = [...(locked.get(update.packageName) ?? [])].toSorted();
    if (found.length !== 1 || found[0] !== expected) {
      mismatches.push({ packageName: update.packageName, expected, found });
    }
  }
  return mismatches;
}
