import type {
  CorrelationContext,
  DependencyScopeCounts,
  PatchStrategyCounts,
  ProvenanceContext,
  RemediationConstraints,
  RemediateOptions,
  RemediationReport,
  UnresolvedReasonCounts,
} from "../platform/types.js";
import type { ScanInputFormat } from "../scanner/index.js";

export interface ScanOptions extends RemediateOptions {
  format?: ScanInputFormat;
  policy?: string;
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
