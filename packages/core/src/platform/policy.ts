import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AutoremediatorPolicy {
  allowMajorBumps: boolean;
  denyPackages: string[];
  allowPackages: string[];
  autoApply: boolean;
}

export const DEFAULT_POLICY: AutoremediatorPolicy = {
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  autoApply: true,
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
      autoApply: parsed.autoApply ?? DEFAULT_POLICY.autoApply,
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
