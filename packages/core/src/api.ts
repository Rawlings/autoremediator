/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
import { runRemediationPipeline } from "./remediation/pipeline.js";
import type {
  CorrelationContext,
  DependencyScope,
  DependencyScopeCounts,
  PatchStrategyCounts,
  ProvenanceContext,
  RemediationConstraints,
  RemediateOptions,
  RemediationReport,
  UnresolvedReasonCounts,
} from "./platform/types.js";
import { parseScanInput, type ScanInputFormat, uniqueCveIds } from "./scanner/index.js";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "./platform/evidence.js";
import { isPackageAllowed, loadPolicy } from "./platform/policy.js";
import { readIdempotentReport, storeIdempotentReport } from "./platform/idempotency.js";

export { runRemediationPipeline } from "./remediation/pipeline.js";

export type {
  CorrelationContext,
  RemediationConstraints,
  ProvenanceContext,
  RemediateOptions,
  RemediationReport,
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  PatchResult,
  PatchStrategy,
  PatchStrategyCounts,
  DependencyScope,
  DependencyScopeCounts,
  UnresolvedReason,
  UnresolvedReasonCounts,
} from "./platform/types.js";
export type { ScanInputFormat } from "./scanner/index.js";

export interface ScanOptions extends RemediateOptions {
  format?: ScanInputFormat;
  policy?: string;
  evidence?: boolean;
}

export interface ScanReport {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  cveIds: string[];
  reports: RemediationReport[];
  successCount: number;
  failedCount: number;
  errors: Array<{ cveId: string; message: string }>;
  evidenceFile?: string;
  patchCount: number;
  patchValidationFailures?: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
  strategyCounts?: PatchStrategyCounts;
  dependencyScopeCounts?: DependencyScopeCounts;
  unresolvedByReason?: UnresolvedReasonCounts;
  patchesDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
}

export interface CiSummary {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  cveCount: number;
  remediationCount: number;
  successCount: number;
  failedCount: number;
  errors: Array<{ cveId: string; message: string }>;
  evidenceFile?: string;
  patchCount?: number;
  patchValidationFailures?: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
  strategyCounts?: PatchStrategyCounts;
  dependencyScopeCounts?: DependencyScopeCounts;
  unresolvedByReason?: UnresolvedReasonCounts;
  patchesDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
}

type JsonSchemaProperty = Record<string, unknown>;

export const PACKAGE_MANAGER_VALUES = ["npm", "pnpm", "yarn"] as const;
export const LLM_PROVIDER_VALUES = ["openai", "anthropic", "local"] as const;
export const PROVENANCE_SOURCE_VALUES = ["cli", "sdk", "mcp", "openapi", "unknown"] as const;

export const OPTION_DESCRIPTIONS = {
  cveId: "CVE ID, e.g. CVE-2021-23337",
  inputPath: "Absolute path to the scanner output file",
  cwd: "Absolute path to the project root (default: process.cwd())",
  packageManager: "Package manager override (auto-detected by default)",
  dryRun: "If true, plan changes but write nothing",
  preview: "If true, enforce non-mutating preview mode",
  runTests: "Run package-manager test command after applying fix",
  llmProvider: "LLM provider override",
  patchesDir: "Directory to write .patch files (default: ./patches)",
  policy: "Optional path to .autoremediator policy file",
  requestId: "Request correlation ID",
  sessionId: "Session correlation ID",
  parentRunId: "Parent run correlation ID",
  idempotencyKey: "Idempotency key for replay-safe execution",
  resume: "Return cached result for matching idempotency key when available",
  actor: "Actor identity for evidence provenance",
  source: "Source system for provenance",
  format: "Scanner format (default: auto)",
  evidence: "Write evidence JSON to .autoremediator/evidence/ (default: true)",
  directDependenciesOnly: "Restrict remediation to direct dependencies only",
  preferVersionBump: "Reject override and patch remediation when version-bump-only policy is required",
} as const;

export function createConstraintSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    directDependenciesOnly: { type: "boolean", description: OPTION_DESCRIPTIONS.directDependenciesOnly },
    preferVersionBump: { type: "boolean", description: OPTION_DESCRIPTIONS.preferVersionBump },
  };
}

export function createRemediateOptionSchemaProperties(options?: {
  includeDryRun?: boolean;
  includePreview?: boolean;
}): Record<string, JsonSchemaProperty> {
  const includeDryRun = options?.includeDryRun ?? true;
  const includePreview = options?.includePreview ?? true;

  return {
    cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
    packageManager: { type: "string", enum: [...PACKAGE_MANAGER_VALUES], description: OPTION_DESCRIPTIONS.packageManager },
    ...(includeDryRun ? { dryRun: { type: "boolean", description: OPTION_DESCRIPTIONS.dryRun } } : {}),
    ...(includePreview ? { preview: { type: "boolean", description: OPTION_DESCRIPTIONS.preview } } : {}),
    runTests: { type: "boolean", description: OPTION_DESCRIPTIONS.runTests },
    llmProvider: { type: "string", enum: [...LLM_PROVIDER_VALUES], description: OPTION_DESCRIPTIONS.llmProvider },
    patchesDir: { type: "string", description: OPTION_DESCRIPTIONS.patchesDir },
    policy: { type: "string", description: OPTION_DESCRIPTIONS.policy },
    requestId: { type: "string", description: OPTION_DESCRIPTIONS.requestId },
    sessionId: { type: "string", description: OPTION_DESCRIPTIONS.sessionId },
    parentRunId: { type: "string", description: OPTION_DESCRIPTIONS.parentRunId },
    idempotencyKey: { type: "string", description: OPTION_DESCRIPTIONS.idempotencyKey },
    resume: { type: "boolean", description: OPTION_DESCRIPTIONS.resume },
    actor: { type: "string", description: OPTION_DESCRIPTIONS.actor },
    source: { type: "string", enum: [...PROVENANCE_SOURCE_VALUES], description: OPTION_DESCRIPTIONS.source },
    constraints: {
      type: "object",
      properties: createConstraintSchemaProperties(),
    },
  };
}

export function createScanOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    ...createRemediateOptionSchemaProperties(),
    format: { type: "string", enum: ["npm-audit", "yarn-audit", "sarif", "auto"], description: OPTION_DESCRIPTIONS.format },
    evidence: { type: "boolean", description: OPTION_DESCRIPTIONS.evidence },
  };
}

export function createScanReportSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    schemaVersion: { type: "string" },
    status: { type: "string", enum: ["ok", "partial", "failed"] },
    generatedAt: { type: "string" },
    cveIds: { type: "array", items: { type: "string" } },
    reports: { type: "array", items: { type: "object" } },
    successCount: { type: "number" },
    failedCount: { type: "number" },
    errors: { type: "array", items: { type: "object" } },
    evidenceFile: { type: "string" },
    patchCount: { type: "number" },
    patchValidationFailures: { type: "array", items: { type: "object" } },
    strategyCounts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    dependencyScopeCounts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    unresolvedByReason: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    patchesDir: { type: "string" },
    correlation: { type: "object" },
    provenance: { type: "object" },
    constraints: { type: "object" },
    idempotencyKey: { type: "string" },
  };
}

function buildRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveCorrelationContext(options: RemediateOptions): Required<Pick<CorrelationContext, "requestId">> & CorrelationContext {
  return {
    requestId: options.requestId ?? buildRequestId(),
    sessionId: options.sessionId,
    parentRunId: options.parentRunId,
  };
}

function resolveProvenanceContext(options: RemediateOptions): ProvenanceContext {
  return {
    actor: options.actor,
    source: options.source ?? "sdk",
  };
}

function resolveConstraints(options: RemediateOptions, cwd: string): RemediationConstraints {
  const policy = loadPolicy(cwd, options.policy);
  return {
    directDependenciesOnly:
      options.constraints?.directDependenciesOnly ??
      policy.constraints?.directDependenciesOnly ??
      false,
    preferVersionBump:
      options.constraints?.preferVersionBump ??
      policy.constraints?.preferVersionBump ??
      false,
  };
}

function enforceConstraints(
  report: RemediationReport,
  constraints: RemediationConstraints
): RemediationReport {
  const indirectPackages = new Set(
    report.vulnerablePackages
      .filter((vp) => vp.installed.type === "indirect")
      .map((vp) => vp.installed.name)
  );

  const nextResults = report.results.map((result) => {
    if (constraints.directDependenciesOnly && indirectPackages.has(result.packageName)) {
      return {
        ...result,
        strategy: "none" as const,
        applied: false,
        unresolvedReason: "constraint-blocked" as const,
        message: `Constraint blocked remediation for indirect dependency \"${result.packageName}\".`,
      };
    }

    if (constraints.preferVersionBump && result.strategy !== "version-bump" && result.strategy !== "none") {
      return {
        ...result,
        strategy: "none" as const,
        applied: false,
        unresolvedReason: "constraint-blocked" as const,
        message: `Constraint prefers version-bump and rejected ${result.strategy} remediation for \"${result.packageName}\".`,
      };
    }

    return result;
  });

  return {
    ...report,
    results: nextResults,
    constraints,
  };
}

function buildStrategyCounts(reports: RemediationReport[]): PatchStrategyCounts | undefined {
  const counts: PatchStrategyCounts = {};

  for (const report of reports) {
    for (const result of report.results) {
      counts[result.strategy] = (counts[result.strategy] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

function toDependencyScope(installedType: "direct" | "indirect"): DependencyScope {
  return installedType === "direct" ? "direct" : "transitive";
}

function buildDependencyScopeCounts(reports: RemediationReport[]): DependencyScopeCounts | undefined {
  const counts: DependencyScopeCounts = {};

  for (const report of reports) {
    const packageScopes = new Map<string, DependencyScope>();

    for (const vulnerablePackage of report.vulnerablePackages) {
      const scope = toDependencyScope(vulnerablePackage.installed.type);
      const current = packageScopes.get(vulnerablePackage.installed.name);
      if (!current || current !== "direct") {
        packageScopes.set(vulnerablePackage.installed.name, scope);
      }
    }

    for (const result of report.results) {
      const scope = packageScopes.get(result.packageName);
      if (!scope) continue;
      counts[scope] = (counts[scope] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

function buildUnresolvedReasonCounts(reports: RemediationReport[]): UnresolvedReasonCounts | undefined {
  const counts: UnresolvedReasonCounts = {};

  for (const report of reports) {
    for (const result of report.results) {
      if (!result.unresolvedReason) continue;
      counts[result.unresolvedReason] = (counts[result.unresolvedReason] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

/**
 * Main entry point for programmatic use.
 *
 * @param cveId  - CVE identifier, e.g. "CVE-2021-23337"
 * @param options - Optional configuration (cwd, dryRun, llmProvider, etc.)
 * @returns       A RemediationReport describing what was found and done
 */
export async function remediate(cveId: string, options: RemediateOptions = {}): Promise<RemediationReport> {
  if (!/^CVE-\d{4}-\d+$/i.test(cveId)) {
    throw new Error(
      `Invalid CVE ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337).`
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const constraints = resolveConstraints(options, cwd);
  const provenance = resolveProvenanceContext(options);
  const correlation = resolveCorrelationContext(options);

  if (options.resume && options.idempotencyKey) {
    const cached = readIdempotentReport(cwd, options.idempotencyKey, cveId.toUpperCase());
    if (cached) {
      return {
        ...cached,
        summary: `${cached.summary} (resumed from idempotency cache)`,
        correlation,
        provenance,
        constraints,
        resumedFromCache: true,
      };
    }
  }

  const report = await runRemediationPipeline(cveId.toUpperCase(), {
    ...options,
    ...correlation,
    constraints,
  });
  const constrainedReport = enforceConstraints(report, constraints);
  const finalReport = {
    ...constrainedReport,
    correlation,
    provenance,
    constraints,
    resumedFromCache: false,
  };

  if (options.idempotencyKey && !options.dryRun && !options.preview) {
    storeIdempotentReport(cwd, options.idempotencyKey, cveId.toUpperCase(), finalReport);
  }

  return {
    ...finalReport,
  };
}

/**
 * Non-mutating preview entrypoint for planning and orchestration.
 */
export async function planRemediation(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  return remediate(cveId, {
    ...options,
    preview: true,
    dryRun: true,
  });
}

/**
 * Scanner-first entrypoint: parse a scanner output file (npm audit JSON or SARIF),
 * extract CVEs, and run remediations one-by-one.
 */
export async function remediateFromScan(
  inputPath: string,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd();
  const format = options.format ?? "auto";
  const patchesDir = options.patchesDir ?? "./patches";

  const findings = parseScanInput(inputPath, format);
  const cveIds = uniqueCveIds(findings);
  const policy = loadPolicy(cwd, options.policy);
  const correlation = resolveCorrelationContext(options);
  const provenance = resolveProvenanceContext(options);
  const constraints = resolveConstraints(options, cwd);

  const evidence = createEvidenceLog(cwd, cveIds, {
    ...correlation,
    actor: provenance.actor,
    source: provenance.source,
    idempotencyKey: options.idempotencyKey,
  });
  addEvidenceStep(evidence, "scan.parse", { inputPath, format }, { findingCount: findings.length, cveCount: cveIds.length });

  const reports: RemediationReport[] = [];
  const errors: Array<{ cveId: string; message: string }> = [];
  const patchValidationFailures: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }> = [];
  let patchCount = 0;

  for (const cveId of cveIds) {
    try {
      addEvidenceStep(evidence, "remediate.start", { cveId });
      const report = await remediate(cveId, {
        ...options,
        patchesDir,
        ...correlation,
        actor: provenance.actor,
        source: provenance.source,
        constraints,
      });

      // Keep a defensive filter in case upstream tools return unexpected packages.
      report.results = report.results.filter((r) => isPackageAllowed(policy, r.packageName));

      // Count patches and collect validation failures
      for (const result of report.results) {
        if (result.strategy === "patch-file") {
          patchCount += 1;
        }
        if (result.validation?.passed === false && result.validation?.error) {
          patchValidationFailures.push({
            packageName: result.packageName,
            cveId,
            error: result.validation.error,
          });
        }
      }

      reports.push(report);
      addEvidenceStep(evidence, "remediate.finish", { cveId }, { results: report.results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ cveId, message });
      addEvidenceStep(evidence, "remediate.error", { cveId }, undefined, message);
    }
  }

  let successCount = 0;
  let failedCount = 0;
  for (const report of reports) {
    for (const result of report.results) {
      if (result.applied || result.dryRun) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }

  failedCount += errors.length;

  let status: ScanReport["status"] = "ok";
  if (failedCount > 0 && successCount > 0) {
    status = "partial";
  } else if (failedCount > 0 && successCount === 0) {
    status = "failed";
  }

  const strategyCounts = buildStrategyCounts(reports);
  const dependencyScopeCounts = buildDependencyScopeCounts(reports);
  const unresolvedByReason = buildUnresolvedReasonCounts(reports);
  let remediationCount = 0;
  for (const report of reports) {
    remediationCount += report.results.length;
  }

  evidence.summary = {
    status,
    cveCount: cveIds.length,
    remediationCount,
    successCount,
    failedCount,
    patchCount,
    patchValidationFailures: patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    patchesDir: patchCount > 0 ? patchesDir : undefined,
  };

  finalizeEvidence(evidence);
  const evidenceFile = options.evidence === false ? undefined : writeEvidenceLog(cwd, evidence);

  return {
    schemaVersion: "1.0",
    status,
    generatedAt: new Date().toISOString(),
    cveIds,
    reports,
    successCount,
    failedCount,
    errors,
    evidenceFile,
    patchCount,
    patchValidationFailures: patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    patchesDir: patchCount > 0 ? patchesDir : undefined,
    correlation,
    provenance,
    constraints,
    idempotencyKey: options.idempotencyKey,
  };
}

export function toCiSummary(report: ScanReport): CiSummary {
  let remediationCount = 0;
  for (const cveReport of report.reports) {
    remediationCount += cveReport.results.length;
  }

  return {
    schemaVersion: report.schemaVersion,
    status: report.status,
    generatedAt: report.generatedAt,
    cveCount: report.cveIds.length,
    remediationCount,
    successCount: report.successCount,
    failedCount: report.failedCount,
    errors: report.errors,
    evidenceFile: report.evidenceFile,
    patchCount: report.patchCount || 0,
    patchValidationFailures: report.patchValidationFailures,
    strategyCounts: report.strategyCounts,
    dependencyScopeCounts: report.dependencyScopeCounts,
    unresolvedByReason: report.unresolvedByReason,
    patchesDir: report.patchesDir,
    correlation: report.correlation,
    provenance: report.provenance,
    constraints: report.constraints,
    idempotencyKey: report.idempotencyKey,
  };
}

export function ciExitCode(summary: CiSummary): number {
  return summary.failedCount > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 output
// ---------------------------------------------------------------------------

type SarifLevel = "error" | "warning" | "note" | "none";

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  helpUri: string;
  properties: { severity: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: string };
    };
  }>;
}

export interface SarifOutput {
  version: "2.1.0";
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }>;
}

function severityToSarifLevel(severity: string): SarifLevel {
  if (severity === "CRITICAL" || severity === "HIGH") return "error";
  if (severity === "MEDIUM") return "warning";
  if (severity === "LOW") return "note";
  return "warning";
}

/**
 * Convert a ScanReport to SARIF 2.1.0 format for GitHub Code Scanning upload.
 */
export function toSarifOutput(report: ScanReport): SarifOutput {
  const rules: SarifRule[] = [];
  const results: SarifResult[] = [];
  const seenRules = new Set<string>();

  for (const r of report.reports) {
    const severity = r.cveDetails?.severity ?? "UNKNOWN";
    const level = severityToSarifLevel(severity);
    const summary = r.cveDetails?.summary ?? r.cveId;

    if (!seenRules.has(r.cveId)) {
      seenRules.add(r.cveId);
      rules.push({
        id: r.cveId,
        name: "VulnerableDependency",
        shortDescription: { text: r.cveId },
        fullDescription: { text: summary },
        defaultConfiguration: { level },
        helpUri: `https://osv.dev/vulnerability/${r.cveId}`,
        properties: { severity },
      });
    }

    for (const vp of r.vulnerablePackages) {
      const fixText = vp.affected.firstPatchedVersion
        ? ` Fix: upgrade to ${vp.affected.firstPatchedVersion}.`
        : " No fixed version available.";
      results.push({
        ruleId: r.cveId,
        level,
        message: {
          text: `${vp.installed.name}@${vp.installed.version} is vulnerable to ${r.cveId}: ${summary}${fixText}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "package.json", uriBaseId: "%SRCROOT%" },
            },
          },
        ],
      });
    }
  }

  return {
    version: "2.1.0",
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Documents/CommitteeSpecifications/2.1.0/sarif-schema-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "autoremediator",
            informationUri: "https://github.com/Rawlings/autoremediator",
            rules,
          },
        },
        results,
      },
    ],
  };
}
