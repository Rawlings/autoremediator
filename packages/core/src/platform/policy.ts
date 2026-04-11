import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemediationConstraints } from "./types.js";

export interface AutoremediatorPolicy {
  allowMajorBumps: boolean;
  denyPackages: string[];
  allowPackages: string[];
  constraints?: RemediationConstraints;
  modelDefaults?: Partial<Record<"remote" | "local", string>>;
  providerSafetyProfile?: "strict" | "relaxed";
  requireConsensusForHighRisk?: boolean;
  dynamicModelRouting?: boolean;
  dynamicRoutingThresholdChars?: number;
}

export const DEFAULT_POLICY: AutoremediatorPolicy = {
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  constraints: {
    directDependenciesOnly: false,
    preferVersionBump: false,
  },
  modelDefaults: {},
  providerSafetyProfile: "relaxed",
  requireConsensusForHighRisk: false,
  dynamicModelRouting: false,
  dynamicRoutingThresholdChars: 18000,
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
      modelDefaults: {
        remote: parsed.modelDefaults?.remote ?? DEFAULT_POLICY.modelDefaults?.remote,
        local: parsed.modelDefaults?.local ?? DEFAULT_POLICY.modelDefaults?.local,
      },
      providerSafetyProfile:
        parsed.providerSafetyProfile ??
        DEFAULT_POLICY.providerSafetyProfile,
      requireConsensusForHighRisk:
        parsed.requireConsensusForHighRisk ??
        DEFAULT_POLICY.requireConsensusForHighRisk,
      dynamicModelRouting:
        parsed.dynamicModelRouting ??
        DEFAULT_POLICY.dynamicModelRouting,
      dynamicRoutingThresholdChars:
        parsed.dynamicRoutingThresholdChars ??
        DEFAULT_POLICY.dynamicRoutingThresholdChars,
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
