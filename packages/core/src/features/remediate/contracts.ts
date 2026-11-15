import type { RemediationConstraints } from "../../infra/policy/types.js";
import type {
  DependencyScopeCounts,
  PatchStrategyCounts,
  UnresolvedReasonCounts,
} from "../../shared/types.js";
import type { ChangeRequestResult } from "../change-request/types.js";
import type { ScanInputFormat } from "../scan/index.js";
import type {
  CorrelationContext,
  DispositionCounts,
  EscalationCounts,
  ProvenanceContext,
  RemediateOptions,
  RemediationReport,
  SimulationSummary,
  SlaBreach,
  SlaBreachSummary,
} from "./types.js";

export interface ScanOptions extends RemediateOptions {
  format?: ScanInputFormat;
  policy?: string;
  audit?: boolean;
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
  escalationCounts?: EscalationCounts;
  patchesDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
  llmUsageCount?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalLlmLatencyMs?: number;
  slaBreaches?: SlaBreach[];
  slaBreachSummary?: SlaBreachSummary;
  changeRequests?: ChangeRequestResult[];
  dispositionCounts?: DispositionCounts;
  simulationSummary?: SimulationSummary;
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
  escalationCounts?: EscalationCounts;
  patchesDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
  llmUsageCount?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalLlmLatencyMs?: number;
  slaBreaches?: SlaBreach[];
  slaBreachSummary?: SlaBreachSummary;
  changeRequests?: ChangeRequestResult[];
  dispositionCounts?: DispositionCounts;
  simulationSummary?: SimulationSummary;
}
