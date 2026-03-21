import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemediationConstraints } from "./types.js";

export interface AutoremediatorPolicy {
  allowMajorBumps: boolean;
  denyPackages: string[];
  allowPackages: string[];
  constraints?: RemediationConstraints;
}

export const DEFAULT_POLICY: AutoremediatorPolicy = {
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  constraints: {
    directDependenciesOnly: false,
    preferVersionBump: false,
  },
};

export function loadPolicy(cwd: string, explicitPath?: string): AutoremediatorPolicy {
  const candidate = explicitPath ?? join(cwd, ".autoremediator.json");
  if (!existsSync(candidate)) return DEFAULT_POLICY;

  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<AutoremediatorPolicy>;
    return {
      allowMajorBumps: parsed.allowMajorBumps ?? DEFAULT_POLICY.allowMajorBumps,
      denyPackages: parsed.denyPackages ?? DEFAULT_POLICY.denyPackages,
      allowPackages: parsed.allowPackages ?? DEFAULT_POLICY.allowPackages,
      constraints: {
        directDependenciesOnly:
          parsed.constraints?.directDependenciesOnly ??
          DEFAULT_POLICY.constraints?.directDependenciesOnly ??
          false,
        preferVersionBump:
          parsed.constraints?.preferVersionBump ??
          DEFAULT_POLICY.constraints?.preferVersionBump ??
          false,
      },
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

export function isPackageAllowed(policy: AutoremediatorPolicy, packageName: string): boolean {
  if (policy.denyPackages.includes(packageName)) return false;
  if (policy.allowPackages.length > 0 && !policy.allowPackages.includes(packageName)) {
    return false;
  }
  return true;
}
