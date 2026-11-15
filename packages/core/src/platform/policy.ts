import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

import { freshnessPolicySchema, type FreshnessPolicy } from "./freshness-policy.js";
import {
  autonomyPolicySchema,
  type AutonomyPolicy,
  constraintsSchema,
  dispositionPolicySchema,
  escalationGraphSchema,
  exploitSignalOverrideSchema,
  patchConfidenceThresholdsSchema,
} from "./option-schemas.js";
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
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  suppressions?: VexSuppression[];
  sla?: SlaPolicy;
  skipUnreachable?: boolean;
  dispositionPolicy?: DispositionPolicy;
  containmentMode?: boolean;
  escalationGraph?: EscalationGraph;
  /** Packages whose `recipes/` are trusted as recipe sources (see docs/guides/recipes.md). */
  recipes?: { packages: string[] };
  /** Earned autonomy. Absent means the feature is off and behaviour is unchanged. */
  autonomy?: AutonomyPolicy;
  /** How far behind the latest release direct dependencies may fall (see docs/guides/freshness.md). */
  freshness?: FreshnessPolicy;
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
  patchConfidenceThresholds: {},
  exploitSignalOverride: undefined,
  suppressions: [],
  sla: undefined,
  skipUnreachable: false,
  dispositionPolicy: undefined,
  containmentMode: false,
  escalationGraph: undefined,
};

const packagePattern = z.string().trim().min(1);

const suppressionSchema = z
  .object({
    cveId: z.string().min(1),
    justification: z.enum(["not_affected", "fixed", "mitigated", "under_investigation"]),
    notes: z.string().optional(),
    expiresAt: z.union([z.string(), z.date().transform((d) => d.toISOString())]).optional(),
  })
  .strict();

/** Shape of the policy YAML. Unknown keys are rejected so typos and removed options are caught. */
const policyFileSchema = z
  .object({
    allowMajorBumps: z.boolean().default(false),
    denyPackages: z.array(packagePattern).default([]),
    allowPackages: z.array(packagePattern).default([]),
    constraints: constraintsSchema.optional(),
    patchConfidenceThresholds: patchConfidenceThresholdsSchema.optional(),
    exploitSignalOverride: exploitSignalOverrideSchema.optional(),
    suppressions: z.array(suppressionSchema).default([]),
    sla: z
      .object({
        critical: z.number().positive(),
        high: z.number().positive(),
        medium: z.number().positive(),
        low: z.number().positive(),
      })
      .partial()
      .strict()
      .optional(),
    skipUnreachable: z.boolean().default(false),
    dispositionPolicy: dispositionPolicySchema.optional(),
    containmentMode: z.boolean().default(false),
    escalationGraph: escalationGraphSchema.optional(),
    recipes: z
      .object({
        packages: z
          .array(z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "must be an npm package name"))
          .default([]),
      })
      .strict()
      .optional(),
    autonomy: autonomyPolicySchema.optional(),
    freshness: freshnessPolicySchema.optional(),
  })
  .strict();

function describePolicyIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      if (issue.code === "unrecognized_keys") {
        return `${where}: unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
      }
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Load and validate the policy.
 *
 * `explicitPath` is a file path, or inline YAML/JSON (when it starts with `{` or `---`).
 * With no explicit path, `.github/autoremediator.yml` is used if present; a missing default file
 * means "no policy". An explicit path that does not exist, unreadable files, invalid YAML and
 * schema violations all throw, so a broken policy can never silently degrade to defaults.
 */
export function loadPolicy(cwd: string, explicitPathOrEmpty?: string): AutoremediatorPolicy {
  // An empty path means "none given", as the remediation pipeline passes `policy: ""` down to its
  // tools. Treating it as a path would silently skip the project's own policy file.
  const explicitPath = explicitPathOrEmpty?.trim() ? explicitPathOrEmpty : undefined;
  const isInline =
    explicitPath !== undefined &&
    (explicitPath.trim().startsWith("{") || explicitPath.trim().startsWith("---"));
  const location = isInline
    ? "(inline policy)"
    : (explicitPath ?? join(cwd, ".github", "autoremediator.yml"));

  let content: string;
  if (isInline) {
    content = explicitPath!;
  } else if (!existsSync(location)) {
    if (explicitPath) throw new Error(`Policy file not found: ${location}`);
    return DEFAULT_POLICY;
  } else {
    try {
      content = readFileSync(location, "utf8");
    } catch (error) {
      throw new Error(`Cannot read policy file ${location}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  let raw: unknown;
  try {
    raw = yamlParse(content) ?? {};
  } catch (error) {
    throw new Error(`Invalid YAML in policy ${location}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid policy ${location}: ${describePolicyIssues(parsed.error)}`);
  }

  return {
    ...DEFAULT_POLICY,
    ...parsed.data,
    constraints: { ...DEFAULT_POLICY.constraints, ...parsed.data.constraints },
    patchConfidenceThresholds: parsed.data.patchConfidenceThresholds ?? {},
    escalationGraph: parsed.data.escalationGraph,
  };
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
  if (Number.isNaN(expires)) return true;
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

/**
 * Load VEX suppressions from a YAML or JSON file shaped `{ suppressions: [...] }`.
 * A missing file, invalid YAML or an entry that fails validation throws, so a typo can never turn
 * into a silently ignored suppression list.
 */
export function loadSuppressionsFile(filePath: string): VexSuppression[] {
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read suppressions file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = z
    .object({ suppressions: z.array(suppressionSchema) })
    .strict()
    .safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid suppressions file ${filePath}: ${describePolicyIssues(result.error)}`);
  }
  return result.data.suppressions;
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
  if (Number.isNaN(publishedMs)) return null;

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

  if (existingIndex !== -1) {
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

  if (existingIndex !== -1) {
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
