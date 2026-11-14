import { resolveWhyCommand, type PackageManager } from "../../../platform/package-manager/index.js";
import { safeExecaCommand } from "../../../platform/safe-exec-command.js";

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
  constraints: WhyConstraints,
): Promise<string | undefined> {
  try {
    const whyCommand = resolveWhyCommand(pm, packageName, constraints);
    if (whyCommand.length === 0) return undefined;
    const result = await safeExecaCommand(whyCommand, {
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
  if (packageManager === "npm" || packageManager === "bun") return "overrides";
  if (packageManager === "pnpm") return "pnpm.overrides";
  if (packageManager === "deno") return "overrides";
  return "resolutions";
}

export function getOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
): string | undefined {
  if (packageManager === "npm" || packageManager === "bun" || packageManager === "deno") {
    return pkgJson.overrides?.[packageName];
  }
  if (packageManager === "pnpm") return pkgJson.pnpm?.overrides?.[packageName];
  return pkgJson.resolutions?.[packageName];
}

export function setOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
  version: string,
): void {
  if (packageManager === "npm" || packageManager === "bun" || packageManager === "deno") {
    pkgJson.overrides = { ...pkgJson.overrides, [packageName]: version };
    return;
  }

  if (packageManager === "pnpm") {
    pkgJson.pnpm = {
      ...pkgJson.pnpm,
      overrides: {
        ...pkgJson.pnpm?.overrides,
        [packageName]: version,
      },
    };
    return;
  }

  pkgJson.resolutions = { ...pkgJson.resolutions, [packageName]: version };
}

// ---- Deno native (deno.json import map) override helpers ----

export interface DenoJson {
  imports?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Get the current entry for a package from deno.json imports.
 * Checks both bare `"pkgName"` and `"npm:pkgName"` specifier forms.
 */
export function getDenoJsonImportValue(
  denoJson: DenoJson,
  packageName: string,
): { key: string; value: string } | undefined {
  const imports = denoJson.imports ?? {};
  if (imports[packageName] !== undefined) {
    return { key: packageName, value: imports[packageName] };
  }
  const npmKey = `npm:${packageName}`;
  if (imports[npmKey] !== undefined) {
    return { key: npmKey, value: imports[npmKey] };
  }
  return undefined;
}

/**
 * Set an import-map entry for a package in deno.json to the target npm version.
 * Uses the existing key form if present, otherwise adds `"npm:pkgName"`.
 */
export function setDenoJsonImportValue(
  denoJson: DenoJson,
  packageName: string,
  version: string,
): void {
  const existing = getDenoJsonImportValue(denoJson, packageName);
  const key = existing?.key ?? `npm:${packageName}`;
  denoJson.imports = { ...denoJson.imports, [key]: `npm:${packageName}@${version}` };
}

/**
 * Restore a deno.json import entry to its previous state.
 * If no previous entry existed, removes the key that was added.
 */
export function restoreDenoJsonImportValue(
  denoJson: DenoJson,
  packageName: string,
  previousEntry?: { key: string; value: string },
): void {
  const existing = getDenoJsonImportValue(denoJson, packageName);
  if (!existing) return;

  const imports = { ...denoJson.imports };
  if (previousEntry === undefined) {
    delete imports[existing.key];
  } else {
    // Remove the current key (may differ in form) and restore previous
    delete imports[existing.key];
    imports[previousEntry.key] = previousEntry.value;
  }

  denoJson.imports = Object.keys(imports).length > 0 ? imports : undefined;
}
