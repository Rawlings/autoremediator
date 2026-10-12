import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type {
  CveSeverity,
  DispositionPolicy,
  EscalationGraph,
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
  dispositionPolicy?: DispositionPolicy;
  containmentMode?: boolean;
  escalationGraph?: EscalationGraph;
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
  dispositionPolicy: undefined,
  containmentMode: false,
  escalationGraph: undefined,
};

export function loadPolicy(cwd: string, explicitPath?: string): AutoremediatorPolicy {
  let content: string | undefined;
  if (
    explicitPath &&
    (explicitPath.trim().startsWith("{") || explicitPath.trim().startsWith("---"))
  ) {
    content = explicitPath;
  } else {
    const candidate = explicitPath ?? join(cwd, ".github", "autoremediator.yml");
    if (!existsSync(candidate)) return DEFAULT_POLICY;
    try {
      content = readFileSync(candidate, "utf8");
    } catch {
      return DEFAULT_POLICY;
    }
  }

  try {
    const parsed = yamlParse(content) as Partial<AutoremediatorPolicy>;
    return {
      allowMajorBumps: parsed.allowMajorBumps ?? DEFAULT_POLICY.allowMajorBumps,
      denyPackages: Array.isArray(parsed.denyPackages)
        ? (parsed.denyPackages.filter(
            (p): p is string => typeof p === "string" && p.trim().length > 0,
          ) as string[])
        : DEFAULT_POLICY.denyPackages,
      allowPackages: Array.isArray(parsed.allowPackages)
        ? (parsed.allowPackages.filter(
            (p): p is string => typeof p === "string" && p.trim().length > 0,
          ) as string[])
        : DEFAULT_POLICY.allowPackages,
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
        workspace: parsed.constraints?.workspace ?? DEFAULT_POLICY.constraints?.workspace,
      },
      modelDefaults: {
        remote: parsed.modelDefaults?.remote ?? DEFAULT_POLICY.modelDefaults?.remote,
        local: parsed.modelDefaults?.local ?? DEFAULT_POLICY.modelDefaults?.local,
      },
      providerSafetyProfile: parsed.providerSafetyProfile ?? DEFAULT_POLICY.providerSafetyProfile,
      requireConsensusForHighRisk:
        parsed.requireConsensusForHighRisk ?? DEFAULT_POLICY.requireConsensusForHighRisk,
      consensusProvider: parsed.consensusProvider ?? DEFAULT_POLICY.consensusProvider,
      consensusModel: parsed.consensusModel ?? DEFAULT_POLICY.consensusModel,
      patchConfidenceThresholds: {
        low: parsed.patchConfidenceThresholds?.low ?? DEFAULT_POLICY.patchConfidenceThresholds?.low,
        medium:
          parsed.patchConfidenceThresholds?.medium ??
          DEFAULT_POLICY.patchConfidenceThresholds?.medium,
        high:
          parsed.patchConfidenceThresholds?.high ?? DEFAULT_POLICY.patchConfidenceThresholds?.high,
      },
      dynamicModelRouting: parsed.dynamicModelRouting ?? DEFAULT_POLICY.dynamicModelRouting,
      dynamicRoutingThresholdChars:
        parsed.dynamicRoutingThresholdChars ?? DEFAULT_POLICY.dynamicRoutingThresholdChars,
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
      skipUnreachable:
        (parsed as AutoremediatorPolicy).skipUnreachable ?? DEFAULT_POLICY.skipUnreachable,
      dispositionPolicy:
        (parsed as AutoremediatorPolicy).dispositionPolicy ?? DEFAULT_POLICY.dispositionPolicy,
      containmentMode:
        (parsed as AutoremediatorPolicy).containmentMode ?? DEFAULT_POLICY.containmentMode,
      escalationGraph:
        (parsed as AutoremediatorPolicy).escalationGraph ?? DEFAULT_POLICY.escalationGraph,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

function isPackageInList(list: unknown[] | undefined, packageName: string): boolean {
  if (!list || !Array.isArray(list) || typeof packageName !== "string" || !packageName.trim()) {
    return false;
  }
  const target = packageName.trim();
  return list.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const cleanPattern = pattern.trim();
    if (!cleanPattern) return false;
    if (cleanPattern === target) return true;
    if (cleanPattern === "*") return true;
    if (cleanPattern.endsWith("/*")) {
      const prefix = cleanPattern.slice(0, -1);
      return target.startsWith(prefix);
    }
    if (cleanPattern.endsWith("*")) {
      const prefix = cleanPattern.slice(0, -1);
      return target.startsWith(prefix);
    }
    return false;
  });
}

export function isPackageAllowed(policy: AutoremediatorPolicy, packageName: string): boolean {
  if (!policy || typeof policy !== "object" || typeof packageName !== "string") {
    return true;
  }
  if (isPackageInList(policy.denyPackages, packageName)) return false;
  const allowList = Array.isArray(policy.allowPackages)
    ? policy.allowPackages.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  if (allowList.length > 0 && !isPackageInList(allowList, packageName)) {
    return false;
  }
  return true;
}

export function isActiveSuppression(suppression: VexSuppression): boolean {
  if (!suppression || typeof suppression !== "object") return false;
  if (!suppression.expiresAt) return true;
  const expires = new Date(suppression.expiresAt).getTime();
  if (isNaN(expires)) return true;
  return expires > Date.now();
}

export function findSuppression(
  policy: AutoremediatorPolicy,
  cveId: string,
): VexSuppression | undefined {
  if (!policy || !Array.isArray(policy.suppressions) || typeof cveId !== "string") {
    return undefined;
  }
  return policy.suppressions.find(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.cveId === "string" &&
      s.cveId.toUpperCase() === cveId.toUpperCase() &&
      isActiveSuppression(s),
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
  slaPolicy: SlaPolicy,
): SlaBreach | null {
  if (typeof severity !== "string" || !slaPolicy || typeof slaPolicy !== "object") {
    return null;
  }
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

/**
 * Persists a VEX suppression entry to the repository policy configuration (.github/autoremediator.yml or explicit path).
 * Preserves existing policy settings and updates or appends the suppression entry.
 * Returns the resolved path where the policy was written.
 */
export function saveSuppressionToPolicy(
  cwd: string,
  suppression: VexSuppression,
  explicitPath?: string,
): string {
  const targetPath = explicitPath ?? join(cwd, ".github", "autoremediator.yml");
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let data: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      const content = readFileSync(targetPath, "utf8");
      const parsed = yamlParse(content);
      if (parsed && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = {};
    }
  }

  const existingSuppressions = Array.isArray(data.suppressions)
    ? (data.suppressions as VexSuppression[])
    : [];

  const existingIndex = existingSuppressions.findIndex(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.cveId === "string" &&
      s.cveId.toUpperCase() === suppression.cveId.toUpperCase(),
  );

  if (existingIndex >= 0) {
    existingSuppressions[existingIndex] = {
      ...existingSuppressions[existingIndex],
      ...suppression,
    };
  } else {
    existingSuppressions.push(suppression);
  }

  data.suppressions = existingSuppressions;
  writeFileSync(targetPath, yamlStringify(data), "utf8");
  return targetPath;
}

/**
 * Persists a VEX suppression entry to a dedicated suppressions YAML file.
 */
export function saveSuppressionToFile(filePath: string, suppression: VexSuppression): void {
  const targetDir = dirname(filePath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let data: { suppressions?: VexSuppression[] } = {};
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf8");
      const parsed = yamlParse(content);
      if (parsed && typeof parsed === "object") {
        data = parsed as { suppressions?: VexSuppression[] };
      }
    } catch {
      data = {};
    }
  }

  const existingSuppressions = Array.isArray(data.suppressions) ? data.suppressions : [];
  const existingIndex = existingSuppressions.findIndex(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.cveId === "string" &&
      s.cveId.toUpperCase() === suppression.cveId.toUpperCase(),
  );

  if (existingIndex >= 0) {
    existingSuppressions[existingIndex] = {
      ...existingSuppressions[existingIndex],
      ...suppression,
    };
  } else {
    existingSuppressions.push(suppression);
  }

  data.suppressions = existingSuppressions;
  writeFileSync(filePath, yamlStringify(data), "utf8");
}
