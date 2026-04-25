import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import type {
  CveSeverity,
  ExploitSignalOverridePolicy,
  PatchConfidenceThresholds,
  RemediationConstraints,
  SlaBreach,
  SlaPolicy,
  VexSuppression,
} from "./types.js";

export interface AutoremediatorPolicy {
  allowMajorBumps: boolean;
  denyPackages: string[];
  allowPackages: string[];
  constraints?: RemediationConstraints;
  modelDefaults?: Partial<Record<"remote" | "local", string>>;
  providerSafetyProfile?: "strict" | "relaxed";
  requireConsensusForHighRisk?: boolean;
  consensusProvider?: "remote" | "local";
  consensusModel?: string;
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  dynamicModelRouting?: boolean;
  dynamicRoutingThresholdChars?: number;
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  suppressions?: VexSuppression[];
  sla?: SlaPolicy;
  skipUnreachable?: boolean;
}

export const DEFAULT_POLICY: AutoremediatorPolicy = {
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  constraints: {
    directDependenciesOnly: false,
    preferVersionBump: false,
    installMode: "deterministic",
    installPreferOffline: undefined,
    enforceFrozenLockfile: undefined,
    workspace: undefined,
  },
  modelDefaults: {},
  providerSafetyProfile: "relaxed",
  requireConsensusForHighRisk: false,
  consensusProvider: "remote",
  consensusModel: undefined,
  patchConfidenceThresholds: {},
  dynamicModelRouting: false,
  dynamicRoutingThresholdChars: 18000,
  exploitSignalOverride: undefined,
  suppressions: [],
  sla: undefined,
  skipUnreachable: false,
};

export function loadPolicy(cwd: string, explicitPath?: string): AutoremediatorPolicy {
  const candidate = explicitPath ?? join(cwd, ".github", "autoremediator.yml");
  if (!existsSync(candidate)) return DEFAULT_POLICY;

  try {
    const parsed = yamlParse(readFileSync(candidate, "utf8")) as Partial<AutoremediatorPolicy>;
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
        installMode:
          parsed.constraints?.installMode ??
          DEFAULT_POLICY.constraints?.installMode ??
          "deterministic",
        installPreferOffline:
          parsed.constraints?.installPreferOffline ??
          DEFAULT_POLICY.constraints?.installPreferOffline,
        enforceFrozenLockfile:
          parsed.constraints?.enforceFrozenLockfile ??
          DEFAULT_POLICY.constraints?.enforceFrozenLockfile,
        workspace:
          parsed.constraints?.workspace ??
          DEFAULT_POLICY.constraints?.workspace,
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
      consensusProvider:
        parsed.consensusProvider ??
        DEFAULT_POLICY.consensusProvider,
      consensusModel:
        parsed.consensusModel ??
        DEFAULT_POLICY.consensusModel,
      patchConfidenceThresholds: {
        low:
          parsed.patchConfidenceThresholds?.low ??
          DEFAULT_POLICY.patchConfidenceThresholds?.low,
        medium:
          parsed.patchConfidenceThresholds?.medium ??
          DEFAULT_POLICY.patchConfidenceThresholds?.medium,
        high:
          parsed.patchConfidenceThresholds?.high ??
          DEFAULT_POLICY.patchConfidenceThresholds?.high,
      },
      dynamicModelRouting:
        parsed.dynamicModelRouting ??
        DEFAULT_POLICY.dynamicModelRouting,
      dynamicRoutingThresholdChars:
        parsed.dynamicRoutingThresholdChars ??
        DEFAULT_POLICY.dynamicRoutingThresholdChars,
      exploitSignalOverride: parsed.exploitSignalOverride
        ? {
            kev: parsed.exploitSignalOverride.kev ?? undefined,
            epss: parsed.exploitSignalOverride.epss ?? undefined,
          }
        : undefined,
      suppressions: Array.isArray(parsed.suppressions)
        ? (parsed.suppressions as VexSuppression[])
        : DEFAULT_POLICY.suppressions,
      sla: parsed.sla
        ? {
            critical: (parsed.sla as SlaPolicy).critical,
            high: (parsed.sla as SlaPolicy).high,
            medium: (parsed.sla as SlaPolicy).medium,
            low: (parsed.sla as SlaPolicy).low,
          }
        : undefined,
      skipUnreachable: (parsed as AutoremediatorPolicy).skipUnreachable ?? DEFAULT_POLICY.skipUnreachable,
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

export function isActiveSuppression(suppression: VexSuppression): boolean {
  if (!suppression.expiresAt) return true;
  return new Date(suppression.expiresAt) > new Date();
}

export function findSuppression(
  policy: AutoremediatorPolicy,
  cveId: string
): VexSuppression | undefined {
  return (policy.suppressions ?? []).find(
    (s) => s.cveId === cveId && isActiveSuppression(s)
  );
}

export function loadSuppressionsFile(filePath: string): VexSuppression[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = yamlParse(content) as { suppressions?: unknown };
    return Array.isArray(parsed?.suppressions) ? (parsed.suppressions as VexSuppression[]) : [];
  } catch {
    return [];
  }
}

export function checkSlaBreach(
  cveId: string,
  severity: CveSeverity,
  publishedAt: string,
  slaPolicy: SlaPolicy
): SlaBreach | null {
  const severityKey = severity.toLowerCase() as keyof SlaPolicy;
  const deadlineHours = slaPolicy[severityKey];
  if (typeof deadlineHours !== "number") return null;

  const publishedMs = new Date(publishedAt).getTime();
  if (isNaN(publishedMs)) return null;

  const deadlineMs = publishedMs + deadlineHours * 60 * 60 * 1000;
  const nowMs = Date.now();
  if (nowMs <= deadlineMs) return null;

  const hoursOverdue = Math.round((nowMs - deadlineMs) / (60 * 60 * 1000));
  return {
    cveId,
    severity,
    publishedAt,
    deadlineAt: new Date(deadlineMs).toISOString(),
    hoursOverdue,
  };
}
