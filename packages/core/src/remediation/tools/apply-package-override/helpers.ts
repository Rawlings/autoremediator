import { execa } from "execa";
import {
  resolveWhyCommand,
  type PackageManager,
} from "../../../platform/package-manager/index.js";

export interface RawPackageJson {
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WhyConstraints {
  workspace?: string;
}

export async function collectDependencyTrace(
  cwd: string,
  pm: PackageManager,
  packageName: string,
  constraints: WhyConstraints
): Promise<string | undefined> {
  try {
    const whyCommand = resolveWhyCommand(pm, packageName, constraints);
    const [whyCmd, ...whyArgs] = whyCommand;
    const result = await execa(whyCmd, whyArgs, {
      cwd,
      stdio: "pipe",
      reject: false,
    });

    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (output.length === 0) return undefined;
    return output.slice(0, 3).join(" | ");
  } catch {
    return undefined;
  }
}

export function describeOverrideField(packageManager: PackageManager): string {
  if (packageManager === "npm") return "overrides";
  if (packageManager === "pnpm") return "pnpm.overrides";
  return "resolutions";
}

export function getOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string
): string | undefined {
  if (packageManager === "npm") return pkgJson.overrides?.[packageName];
  if (packageManager === "pnpm") return pkgJson.pnpm?.overrides?.[packageName];
  return pkgJson.resolutions?.[packageName];
}

export function setOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
  version: string
): void {
  if (packageManager === "npm") {
    pkgJson.overrides = { ...(pkgJson.overrides ?? {}), [packageName]: version };
    return;
  }

  if (packageManager === "pnpm") {
    pkgJson.pnpm = {
      ...(pkgJson.pnpm ?? {}),
      overrides: {
        ...(pkgJson.pnpm?.overrides ?? {}),
        [packageName]: version,
      },
    };
    return;
  }

  pkgJson.resolutions = { ...(pkgJson.resolutions ?? {}), [packageName]: version };
}

export function restoreOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
  previousValue?: string
): void {
  if (packageManager === "npm") {
    pkgJson.overrides = restoreRecord(pkgJson.overrides, packageName, previousValue);
    return;
  }

  if (packageManager === "pnpm") {
    pkgJson.pnpm = {
      ...(pkgJson.pnpm ?? {}),
      overrides: restoreRecord(pkgJson.pnpm?.overrides, packageName, previousValue),
    };
    if (!pkgJson.pnpm.overrides) {
      delete pkgJson.pnpm.overrides;
    }
    if (Object.keys(pkgJson.pnpm).length === 0) {
      delete pkgJson.pnpm;
    }
    return;
  }

  pkgJson.resolutions = restoreRecord(pkgJson.resolutions, packageName, previousValue);
}

function restoreRecord(
  record: Record<string, string> | undefined,
  key: string,
  previousValue?: string
): Record<string, string> | undefined {
  const nextRecord = { ...(record ?? {}) };

  if (previousValue === undefined) {
    delete nextRecord[key];
  } else {
    nextRecord[key] = previousValue;
  }

  return Object.keys(nextRecord).length > 0 ? nextRecord : undefined;
}